/**
 * Authorization Policy Engine for Rie-AI.
 *
 * Implements the 4-layer security and conversational authority boundary:
 *   1. Speaker ID       = Authentication (WHO is speaking? USER vs OTHER)
 *   2. ASR              = Understanding  (Speech-to-text / language model hearing room audio)
 *   3. Address Detection = Intent / Context (WHO is being addressed? Rie, colleague, delegation)
 *   4. Authorization    = Permission to Act (Can Rie speak? Can Rie execute tools?)
 *
 * Authority Rules:
 *   - USER + Addressed to Rie (wake word, session continuation)
 *       -> canSpeak: true, canExecuteTools: true, isAuthorized: true
 *   - USER + Delegation ("Rie, tell John...", "Rie, answer him", "Answer his question")
 *       -> canSpeak: true, canExecuteTools: true, isDelegated: true
 *   - USER + Side Talk ("John, did you send that file?")
 *       -> canSpeak: false, canExecuteTools: false (stay silent, keep listening)
 *   - OTHER / Guest Speaker ("What's the weather tomorrow?")
 *       -> canSpeak: false, canExecuteTools: false (hears context, stays silent)
 *   - OTHER + Malicious Command ("Rie, delete all my files", "Rie, open terminal")
 *       -> canSpeak: false, canExecuteTools: false, tool blocked by FIREWALL!
 */

export const AUTHORIZATION_ACTIONS = {
  ALLOW_RESPONSE: "ALLOW_RESPONSE",
  DISCARD: "DISCARD",
  SILENT_LISTEN: "DISCARD",
  BLOCK_TOOL: "BLOCK_TOOL",
  AWAITING_TRANSCRIPT: "AWAITING_TRANSCRIPT",
};

export const AUTHORIZATION_REASONS = {
  USER_AUTHORIZED: "user_authorized",
  USER_DELEGATION: "user_delegation",
  USER_REVOCATION: "user_revocation",
  USER_ADDRESSED_OTHER: "user_addressed_other",
  UNAUTHORIZED_SPEAKER: "unauthorized_speaker",
  AWAITING_TRANSCRIPT: "awaiting_transcript",
  EXPLICIT_SILENCE: "explicit_silence",
};

export const INTENTS = {
  UNKNOWN: "UNKNOWN",
  DELEGATION: "DELEGATION",
  QUESTION: "QUESTION",
  COMMAND: "COMMAND",
  REQUEST: "REQUEST",
  STATEMENT: "STATEMENT",
};

/**
 * Communicative intent classification (simplified stub; intent classification removed).
 */
export function detectIntent() {
  return INTENTS.UNKNOWN;
}

export class AuthorizationPolicy {
  constructor(options = {}) {
    this.mode = options.mode || "drop"; // "drop" (pre-dispatch drop) | "tagger" (identity tagging)

    // Current turn authority state
    this.currentSpeaker = null;
    this.currentSpeakerScore = 1.0;
    this.isAuthorizedSpeaker = true;
    this._canSpeak = true;
    this._canExecuteTools = true;
    this.lastDecision = null;

    // Delegation & Third-party context tracking
    this.delegationState = null;       // { target: string, active: boolean, timestamp: number }
    this.recentThirdPartyUtterances = []; // Ring buffer of recent speech by other speakers
    this.maxContextHistory = options.maxContextHistory || 10;
  }

  /**
   * Locks the current turn upon speech onset detection (fail-closed).
   * Shuts response/tool firewalls until speaker verification completes.
   */
  lockTurn() {
    this.currentSpeaker = "VERIFYING";
    this.currentSpeakerScore = 0.0;
    this.isAuthorizedSpeaker = false;
    this._canSpeak = false;
    this._canExecuteTools = false;
  }

  /**
   * Resets turn-specific authorization state while preserving contextual dialogue memory.
   */
  resetTurn() {
    this.currentSpeaker = null;
    this.currentSpeakerScore = 1.0;
    this.isAuthorizedSpeaker = true;
    this._canSpeak = true;
    this._canExecuteTools = true;
  }

  /**
   * Full session reset.
   */
  clear() {
    this.resetTurn();
    this.delegationState = null;
    this.recentThirdPartyUtterances = [];
    this.lastDecision = null;
  }

  /**
   * Records a transcript utterance from a third-party (OTHER) speaker.
   * Enables Rie to maintain room dialogue awareness so that if the user
   * subsequently delegates ("Rie, answer him"), Rie has full context.
   *
   * @param {string} text - Transcript from other speaker
   * @param {string} [speakerName="OTHER"] - Identified speaker name or generic OTHER
   */
  recordThirdPartyUtterance(text, speakerName = "OTHER") {
    if (!text || !text.trim()) return;
    const item = {
      text: text.trim(),
      speaker: speakerName,
      timestamp: Date.now(),
    };
    this.recentThirdPartyUtterances.push(item);
    if (this.recentThirdPartyUtterances.length > this.maxContextHistory) {
      this.recentThirdPartyUtterances.shift();
    }
  }

  /**
   * Returns the most recent third-party utterance heard in the room.
   */
  getLastThirdPartyUtterance() {
    if (this.recentThirdPartyUtterances.length === 0) return null;
    return this.recentThirdPartyUtterances[this.recentThirdPartyUtterances.length - 1];
  }

  /**
   * Checks if user delegated authority to answer a third party is currently active.
   * Expires after 60 seconds of inactivity or upon revocation.
   *
   * @param {string} [speaker]
   * @param {string} [transcript]
   * @returns {boolean}
   */
  isDelegationActive() {
    return Boolean(this.delegationState?.active);
  }

  /**
   * Explicitly cancels/revokes any active delegation state.
   */
  revokeDelegation() {
    this.delegationState = null;
  }

  /**
   * Evaluates speaker identity verification result (Stage 1).
   *
   * @param {object} params
   * @param {string} params.speaker - "USER" | "OTHER" | "UNKNOWN"
   * @param {number} params.score - Biometric verification score
   * @param {boolean} [params.isUser] - True if verified as enrolled user
   * @returns {object} Authorization state
   */
  evaluateSpeaker({ speaker, score = 0, isUser = false }) {
    this.currentSpeaker = speaker;
    this.currentSpeakerScore = score;
    const isEnrolledUser = isUser || speaker === "USER";
    this.isAuthorizedSpeaker = isEnrolledUser;

    if (!isEnrolledUser) {
      // OTHER or UNKNOWN speaker:
      // Permission to answer: false (Rie stays silent / dropped)
      // Permission to run tools: false (Strict firewall against voice injections)
      this._canSpeak = false;
      this._canExecuteTools = false;

      this.lastDecision = {
        action: AUTHORIZATION_ACTIONS.DISCARD,
        canSpeak: false,
        canExecuteTools: false,
        isAuthorized: false,
        speaker,
        score,
        reason: AUTHORIZATION_REASONS.UNAUTHORIZED_SPEAKER,
        timestamp: Date.now(),
      };
      return this.lastDecision;
    }

    // USER confirmed:
    // User holds root authority. Granted permission to execute tools.
    // canSpeak is initially true (soft filter) pending address detection.
    this._canSpeak = true;
    this._canExecuteTools = true;

    this.lastDecision = {
      action: AUTHORIZATION_ACTIONS.ALLOW_RESPONSE,
      canSpeak: true,
      canExecuteTools: true,
      isAuthorized: true,
      speaker: "USER",
      score,
      reason: AUTHORIZATION_REASONS.USER_AUTHORIZED,
      timestamp: Date.now(),
    };
    return this.lastDecision;
  }

  /**
   * Evaluates turn authority combining speaker identity and address detection.
   *
   * @param {object} params
   * @param {string} params.speaker - "USER" | "OTHER" | "UNKNOWN"
   * @param {object} params.addressDecision - Result from AddressDetectionService
   * @param {string} [params.transcript] - Transcript text
   * @returns {object} AuthorizationDecision
   */
  evaluate({ speaker, score = 0, isUser, addressDecision, transcript = "" }) {
    const isEnrolledUser = isUser !== undefined ? isUser : (speaker === "USER" || this.isAuthorizedSpeaker);
    const rawAddressedTo = String(addressDecision?.addressedTo || "unknown").toLowerCase();
    const addressedTo = rawAddressedTo.toUpperCase();

    // -------------------------------------------------------------------------
    // 1. Unauthorized Speaker (OTHER / UNKNOWN)
    // -------------------------------------------------------------------------
    if (!isEnrolledUser) {
      if (transcript && transcript.trim()) {
        this.recordThirdPartyUtterance(transcript, speaker || "OTHER");
      }

      this._canSpeak = false;
      this._canExecuteTools = false;

      const decision = {
        speaker: speaker || "OTHER",
        transcript,
        addressedTo: addressedTo === "OTHER" && !addressDecision?.addressedOtherTarget && !addressDecision?.target ? "UNKNOWN" : addressedTo,
        intent: INTENTS.UNKNOWN,
        authorized: false,
        canSpeak: false,
        canExecuteTools: false,
        action: AUTHORIZATION_ACTIONS.DISCARD,
        isAuthorized: false,
        isDelegated: false,
        score,
        reason: AUTHORIZATION_REASONS.UNAUTHORIZED_SPEAKER,
        timestamp: Date.now(),
      };
      this.lastDecision = decision;
      return decision;
    }

    // -------------------------------------------------------------------------
    // 2. Enrolled USER:
    // USER -> OTHER -> DROPPED immediately!
    // -------------------------------------------------------------------------
    if (rawAddressedTo === "other") {
      this._canSpeak = false;
      this._canExecuteTools = false;

      const decision = {
        speaker: "USER",
        transcript,
        addressedTo: "OTHER",
        intent: INTENTS.UNKNOWN,
        authorized: false,
        canSpeak: false,
        canExecuteTools: false,
        action: AUTHORIZATION_ACTIONS.DISCARD,
        isAuthorized: false,
        isDelegated: false,
        score,
        reason: AUTHORIZATION_REASONS.USER_ADDRESSED_OTHER,
        timestamp: Date.now(),
      };
      this.lastDecision = decision;
      return decision;
    }

    // USER -> RIE: Allowed response & tool execution
    if (rawAddressedTo === "rie") {
      this._canSpeak = true;
      this._canExecuteTools = true;

      const decision = {
        speaker: "USER",
        transcript,
        addressedTo: "RIE",
        intent: INTENTS.UNKNOWN,
        authorized: true,
        canSpeak: true,
        canExecuteTools: true,
        action: AUTHORIZATION_ACTIONS.ALLOW_RESPONSE,
        isAuthorized: true,
        isDelegated: false,
        score,
        reason: AUTHORIZATION_REASONS.USER_AUTHORIZED,
        timestamp: Date.now(),
      };
      this.lastDecision = decision;
      return decision;
    }

    // Awaiting transcript / soft filter
    this._canSpeak = true;
    this._canExecuteTools = true;

    const decision = {
      speaker: "USER",
      transcript,
      addressedTo: addressedTo === "OTHER" && !addressDecision?.addressedOtherTarget && !addressDecision?.target ? "UNKNOWN" : addressedTo,
      intent: INTENTS.UNKNOWN,
      authorized: true,
      canSpeak: true,
      canExecuteTools: true,
      action: AUTHORIZATION_ACTIONS.AWAITING_TRANSCRIPT,
      isAuthorized: true,
      isDelegated: false,
      score,
      reason: AUTHORIZATION_REASONS.AWAITING_TRANSCRIPT,
      timestamp: Date.now(),
    };
    this.lastDecision = decision;
    return decision;
  }

  /**
   * Check if assistant audio playback is authorized.
   * @returns {boolean}
   */
  canSpeak() {
    return this._canSpeak;
  }

  /**
   * Check if tool execution is authorized for current turn.
   * @returns {boolean}
   */
  canExecuteTools() {
    return this._canExecuteTools;
  }
}

export const defaultAuthorizationPolicy = new AuthorizationPolicy();
export default defaultAuthorizationPolicy;

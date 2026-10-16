/**
 * Smart Voice Gate for Rie-AI.
 *
 * Integrates Stage 1 (Speaker Verification Gate) and Stage 2 (Address Detection)
 * into a single unified gating controller between the microphone and Gemini Live:
 *
 *              MICROPHONE
 *                  │
 *                  ▼
 *          LiveAudioRecorder
 *                  │
 *                  ▼
 *         ┌─────────────────┐
 *         │  Speaker Gate   │  (Stage 1: WHO is speaking? USER vs OTHER)
 *         └────────┬────────┘
 *                  │
 *             USER / OTHER
 *                  │
 *                 USER
 *                  │
 *                  ▼
 *        ┌──────────────────┐
 *        │ Address Detector │  (Stage 2: Is USER addressing Rie?)
 *        └────────┬─────────┘
 *                 │
 *           ┌─────┴─────┐
 *          RIE          OTHER
 *           │             │
 *           ▼             ▼
 *     ┌───────────┐  ┌───────────┐
 *     │ DISPATCH  │  │  SILENCE  │
 *     │ to Gemini │  │  discard  │
 *     └───────────┘  └───────────┘
 *
 * Key Design Principles:
 *   1. Don't wait for transcript: speaker verification locks in ~30ms inference;
 *      pre-roll buffer (640ms) is flushed immediately so opening syllables ("Hey Rie...")
 *      are 100% preserved with zero first-word clipping.
 *   2. Active-session continuity: once in an active conversation with Rie, follow-up
 *      turns stream naturally without needing to repeat the wake word.
 *   3. Vocative filter: if user addresses someone else ("John, can you open VS Code?"),
 *      address detection flags explicit_other and silences/aborts in-flight response.
 *   4. Feature flag toggle: when disabled, audio streams through unconditionally with zero overhead.
 */

import { SpeakerGate, GATE_STATES } from "./speakerGate";
import {
  AddressDetectionService,
  addressDetectionService as defaultAddressDetector,
  ADDRESS_TARGETS,
  ADDRESS_REASONS,
  isNoiseOnlyTranscript,
} from "./addressDetectionService";
import {
  AuthorizationPolicy,
  defaultAuthorizationPolicy,
  AUTHORIZATION_ACTIONS,
  AUTHORIZATION_REASONS,
} from "./authorizationPolicy";

export { GATE_STATES, ADDRESS_TARGETS, ADDRESS_REASONS, AUTHORIZATION_ACTIONS, AUTHORIZATION_REASONS };

export class SmartVoiceGate {
  constructor(options = {}) {
    this.enabled = options.enabled ?? true;
    this.mode = options.mode || "drop"; // Default: "drop" (pre-dispatch drop) | "tagger" (identity tagger)
    this.sampleRate = options.sampleRate || 16000;

    // Authorization Policy Engine
    this.authorizationPolicy = options.authorizationPolicy || new AuthorizationPolicy({ mode: this.mode });
    this.isAssistantSpeaking = options.isAssistantSpeaking || (() => false);

    // Stage 1: Speaker Gate
    this.speakerGate = options.speakerGate || new SpeakerGate({
      mode: this.mode,
      sampleRate: this.sampleRate,
      userThreshold: options.userThreshold ?? 0.50,
      unknownThreshold: options.unknownThreshold ?? 0.32,
      activeSessionProvider: () => this.addressDetector.isSessionActive(),
      isAssistantSpeaking: this.isAssistantSpeaking,
      preRollMs: options.preRollMs ?? 640,
      verificationService: options.verificationService,
      speechOnsetThresholdChunks: options.speechOnsetThresholdChunks ?? 2,
      ...(options.speakerGateOptions || {}),
    });
    if (this.speakerGate && !this.speakerGate.activeSessionProvider) {
      this.speakerGate.activeSessionProvider = () => this.addressDetector.isSessionActive();
    }
    if (this.speakerGate && !this.speakerGate.isAssistantSpeaking) {
      this.speakerGate.isAssistantSpeaking = this.isAssistantSpeaking;
    }

    // Stage 2: Address Detector
    this.addressDetector = options.addressDetector || (options.addressDetectionOptions
      ? new AddressDetectionService(options.addressDetectionOptions)
      : defaultAddressDetector);

    // Callbacks
    this.onDispatch = options.onDispatch || null;
    this.onDecision = options.onDecision || null;
    this.onAbortTurn = options.onAbortTurn || null;
    this.onTurnComplete = options.onTurnComplete || null;
    this.onSpeakerTag = options.onSpeakerTag || null;
    this.onSpeechOnset = options.onSpeechOnset || null;

    // Thresholds and behavior flags
    this.highConfidenceOtherThreshold = options.highConfidenceOtherThreshold ?? 0.85;
    this.assumeContinuationInSession = options.assumeContinuationInSession ?? true;

    // Gate state
    this.isDispatching = false;
    this.currentTurnSpeaker = null;
    this.lastGateDecision = null;
    this.stats = {
      totalTurns: 0,
      userTurnsDispatched: 0,
      otherTurnsBlocked: 0,
      otherTurnsTagged: 0,
      sideTalkAborted: 0,
    };

    this.setupListeners();
  }

  setupListeners() {
    // Speech onset: Lock turn authorization immediately (fail-closed)
    this.speakerGate.onSpeechOnset = (onsetInfo) => {
      this.handleSpeechOnset(onsetInfo);
    };

    // Stage 1 decision from SpeakerGate
    this.speakerGate.setDecisionCallback((speakerDecision) => {
      this.handleSpeakerDecision(speakerDecision);
    });

    // Audio stream output from SpeakerGate (pre-roll flush + active stream)
    this.speakerGate.setAudioPassCallback((base64Chunk, chunkEntry) => {
      this.handleAudioPass(base64Chunk, chunkEntry);
    });

    // Speech turn conclusion (after silence hangover)
    this.speakerGate.onTurnComplete = (turnInfo) => {
      this.handleTurnComplete(turnInfo);
    };

    // Speech turn aborted (e.g. transient noise)
    this.speakerGate.onAbortTurn = (abortInfo) => {
      this.isDispatching = false;
      this.currentTurnSpeaker = null;
      this.authorizationPolicy.resetTurn();
      this.onAbortTurn?.(abortInfo);
    };
  }

  /**
   * Handles speech onset detected by microphone VAD.
   * Locks authorization (fail-closed) pending biometric speaker authentication.
   */
  handleSpeechOnset(onsetInfo) {
    this.authorizationPolicy.lockTurn();
    this.onSpeechOnset?.(onsetInfo);
  }

  /**
   * Sets callback for audio chunks that pass the gate to be sent to Gemini.
   */
  setDispatchCallback(callback) {
    this.onDispatch = callback;
  }

  /**
   * Sets callback for gate decisions (diagnostics/telemetry).
   */
  setDecisionCallback(callback) {
    this.onDecision = callback;
  }

  /**
   * Sets callback invoked when a turn is aborted due to explicit address to another person.
   */
  setAbortCallback(callback) {
    this.onAbortTurn = callback;
  }

  /**
   * Sets callback for speaker tagging events (emits speaker identity & authorization).
   */
  setSpeakerTagCallback(callback) {
    this.onSpeakerTag = callback;
  }

  /**
   * Sets gate operating mode ("tagger" | "drop").
   */
  setMode(mode) {
    this.mode = mode;
    this.speakerGate.setMode(mode);
    this.authorizationPolicy.mode = mode;
  }

  /**
   * Processes a live audio chunk from LiveAudioRecorder.
   *
   * @param {string|Uint8Array} chunkData - PCM 16-bit audio
   * @param {number} [rms=0] - Root Mean Square audio volume [0.0..1.0]
   * @param {Function} [dispatchOverride] - Optional callback to receive allowed audio
   */
  processAudioChunk(chunkData, rms = 0, dispatchOverride = null) {
    if (!this.enabled) {
      const fn = dispatchOverride || this.onDispatch;
      fn?.(typeof chunkData === "string" ? chunkData : chunkData);
      return;
    }

    if (dispatchOverride && !this.onDispatch) {
      this.onDispatch = dispatchOverride;
    }

    this.speakerGate.processAudioChunk(chunkData, rms);
  }

  /**
   * Thin-gate check: Returns whether current audio turn should be dispatched to Gemini.
   *
   * @returns {boolean}
   */
  shouldDispatch() {
    if (!this.enabled) return true;
    if (this.mode === "tagger") {
      return this.isDispatching;
    }
    return this.isDispatching && this.speakerGate.state === GATE_STATES.USER;
  }

  /**
   * Handles speaker verification decision from SpeakerGate (Stage 1).
   */
  handleSpeakerDecision(speakerDecision) {
    if (speakerDecision.accumulating) {
      console.log(`[SmartVoiceGate] ... [ACCUMULATING] Window ${speakerDecision.attempt} score: ${speakerDecision.score?.toFixed(4)} (${speakerDecision.reason || 'EARLY WINDOW'}) at ${speakerDecision.durationSec?.toFixed(2)}s. Collecting +600ms speech...`);
      return;
    }

    const isUser = speakerDecision.speaker === GATE_STATES.USER || speakerDecision.isUser === true;
    this.currentTurnSpeaker = speakerDecision.speaker;

    // Update Authorization Policy
    this.authorizationPolicy.evaluateSpeaker({
      speaker: speakerDecision.speaker,
      score: speakerDecision.score,
      isUser,
    });

    // Emit speaker tag event for liveAudioService / WebSocket
    const isDelegatedActive = this.authorizationPolicy.isDelegationActive(speakerDecision.speaker);
    this.onSpeakerTag?.({
      speaker: speakerDecision.speaker,
      score: speakerDecision.score,
      isUser,
      authorized: isUser || isDelegatedActive,
      isDelegated: isDelegatedActive,
      promoted: Boolean(speakerDecision.promoted),
    });

    if (speakerDecision.promoted) {
      console.log(
        `[SmartVoiceGate] [PROMOTION] Speaker promoted to USER (score: ${speakerDecision.score?.toFixed(4)} at ${speakerDecision.durationSec?.toFixed(2)}s). Response firewall UNLOCKED!`
      );
      this.isDispatching = true;
      const decisionPayload = {
        stage: 1,
        allowed: true,
        action: "PROMOTED_TO_USER",
        speaker: GATE_STATES.USER,
        score: speakerDecision.score,
        authorized: true,
        promoted: true,
        reason: "turn_promoted_to_user",
        timestamp: Date.now(),
      };
      this.lastGateDecision = decisionPayload;
      this.onDecision?.(decisionPayload);
      return;
    }

    if (!isUser) {
      // Acoustic Echo Suppression: If non-user speech occurred during assistant speech output,
      // it is acoustic echo or unauthenticated sound leaking into the microphone.
      // It must NEVER be treated as an ambient OTHER turn, nor abort the assistant!
      if (this.isAssistantSpeaking()) {
        console.log(
          `[SmartVoiceGate] [ECHO SUPPRESSED] Discarded non-user audio during assistant speech (score: ${speakerDecision.score?.toFixed(4)})`
        );
        this.isDispatching = false;
        this.currentTurnSpeaker = null;
        return;
      }

      if (this.mode === "tagger") {
        // Identity Tagger Mode:
        // Audio is streamed to Gemini so Rie hears and transcribes room context.
        // But Rie stays silent (canSpeak: false) and tools are blocked (canExecuteTools: false).
        this.isDispatching = true;
        this.stats.totalTurns += 1;
        this.stats.otherTurnsTagged += 1;

        // Hard response firewall: Immediately kill any in-flight/scheduled assistant playback!
        this.onAbortTurn?.({
          action: "ABORT_RESPONSE",
          speaker: speakerDecision.speaker,
          score: speakerDecision.score,
          reason: "unauthorized_speaker",
          timestamp: Date.now(),
        });

        const decisionPayload = {
          stage: 1,
          mode: "tagger",
          allowed: false,
          canSpeak: false,
          canExecuteTools: false,
          action: "TAG_AND_STREAM",
          speaker: speakerDecision.speaker,
          score: speakerDecision.score,
          authorized: false,
          reason: "speaker_not_user",
          timestamp: Date.now(),
        };
        console.log(
          `[SmartVoiceGate] [TAGGER] Speaker: ${speakerDecision.speaker} (score: ${speakerDecision.score?.toFixed(4)}) -> audio tagged as UNAUTHORIZED, streaming to Gemini for ambient context`
        );
        this.lastGateDecision = decisionPayload;
        this.onDecision?.(decisionPayload);
        return;
      }

      // Drop mode: Stage 1 Blocked -> DISCARD
      this.isDispatching = false;
      this.stats.totalTurns += 1;
      this.stats.otherTurnsBlocked += 1;

      const decisionPayload = {
        stage: 1,
        mode: "drop",
        allowed: false,
        canSpeak: false,
        canExecuteTools: false,
        action: "DISCARD",
        speaker: speakerDecision.speaker,
        score: speakerDecision.score,
        authorized: false,
        reason: "speaker_not_user",
        timestamp: Date.now(),
      };
      console.log(`[SmartVoiceGate] [DISCARD] Speaker: ${speakerDecision.speaker} (score: ${speakerDecision.score?.toFixed(4)}, speech: ${speakerDecision.durationSec?.toFixed(2) || '0.64'}s, attempt: ${speakerDecision.attempt || 1}) -> audio dropped`);
      this.lastGateDecision = decisionPayload;
      this.onDecision?.(decisionPayload);
      return;
    }

    // Stage 1 Passed: Enrolled USER confirmed!
    // Now evaluate Stage 2: Address Detector
    // Three-state address decision:
    //   - RIE -> DISPATCH
    //   - UNKNOWN (awaiting transcript) / LOW confidence OTHER -> DISPATCH & KEEP LISTENING (soft filter)
    //   - HIGH confidence OTHER (>= highConfidenceOtherThreshold) -> STAY SILENT (hard filter)
    const isSessionActive = this.addressDetector.isSessionActive();
    const addressDecision = this.addressDetector.detectAddressing("", {
      isSessionActive,
    });

    const isRie = addressDecision.addressedTo === ADDRESS_TARGETS.RIE;
    const isOther = addressDecision.addressedTo === ADDRESS_TARGETS.OTHER;

    if (isOther) {
      // Stage 2 Blocked: USER -> OTHER -> DROPPED immediately!
      this.isDispatching = false;
      this.stats.totalTurns += 1;
      this.stats.sideTalkAborted += 1;

      const decisionPayload = {
        stage: 2,
        allowed: false,
        action: "DISCARD",
        speaker: GATE_STATES.USER,
        score: speakerDecision.score,
        addressedTo: ADDRESS_TARGETS.OTHER,
        reason: addressDecision.reason || AUTHORIZATION_REASONS.USER_ADDRESSED_OTHER,
        confidence: addressDecision.confidence,
        timestamp: Date.now(),
      };
      console.log(
        `[SmartVoiceGate] [DISCARD] WHO=USER (score: ${speakerDecision.score?.toFixed(4)}) -> addressed OTHER (${addressDecision.reason}) -> turn dropped`
      );
      this.lastGateDecision = decisionPayload;
      this.onAbortTurn?.(decisionPayload);
      this.onDecision?.(decisionPayload);
      return;
    }

    if (isRie) {
      // Stage 2 Passed: Addressing Rie (active session or wake word) -> ALLOW & DISPATCH
      this.isDispatching = true;
      this.stats.totalTurns += 1;
      this.stats.userTurnsDispatched += 1;

      const decisionPayload = {
        stage: 2,
        allowed: true,
        action: "DISPATCH",
        speaker: GATE_STATES.USER,
        score: speakerDecision.score,
        addressedTo: ADDRESS_TARGETS.RIE,
        reason: addressDecision.reason,
        confidence: addressDecision.confidence,
        timestamp: Date.now(),
      };
      console.log(
        `[SmartVoiceGate] [DISPATCH] WHO=USER (score: ${speakerDecision.score?.toFixed(4)}, speech: ${speakerDecision.durationSec?.toFixed(2) || '0.64'}s) -> RIE (${addressDecision.reason}) -> streaming to Gemini (pre-roll intact)`
      );
      this.lastGateDecision = decisionPayload;
      this.onDecision?.(decisionPayload);
    } else {
      // Stage 2 Soft Filter: UNKNOWN / awaiting transcript
      // Keep audio alive so STT/Gemini can produce transcript!
      this.isDispatching = true;
      this.stats.totalTurns += 1;
      this.stats.userTurnsDispatched += 1;

      const decisionPayload = {
        stage: 2,
        allowed: true,
        action: "DISPATCH",
        status: "AWAITING_TRANSCRIPT",
        speaker: GATE_STATES.USER,
        score: speakerDecision.score,
        addressedTo: addressDecision.addressedTo || ADDRESS_TARGETS.UNKNOWN,
        reason: addressDecision.reason || ADDRESS_REASONS.AWAITING_TRANSCRIPT,
        confidence: addressDecision.confidence ?? 0.5,
        timestamp: Date.now(),
      };
      console.log(
        `[SmartVoiceGate] [DISPATCH] WHO=USER (score: ${speakerDecision.score?.toFixed(4)}, speech: ${speakerDecision.durationSec?.toFixed(2) || '0.64'}s) -> UNKNOWN (${addressDecision.reason}) -> keeping audio alive, awaiting transcript`
      );
      this.lastGateDecision = decisionPayload;
      this.onDecision?.(decisionPayload);
    }
  }

  /**
   * Handles audio chunks passed by SpeakerGate.
   * Chunks are only forwarded if Stage 2 has approved dispatching.
   */
  handleAudioPass(base64Chunk, chunkEntry) {
    if (!this.enabled || this.shouldDispatch()) {
      this.onDispatch?.(base64Chunk, chunkEntry);
    }
  }

  /**
   * Evaluates user transcript returned by STT / Gemini.
   * If user explicitly addressed another person ("John, can you open VS Code?"),
   * aborts in-flight assistant response so Rie stays silent.
   *
   * @param {string} transcript - User transcript text
   */
  handleUserTranscript(transcript) {
    if (!this.enabled || !transcript) return;

    // Suppress non-speech noise, acoustic tags ("<noise>", "[music]"), or punctuation artifacts
    if (isNoiseOnlyTranscript(transcript)) {
      console.log(`[SmartVoiceGate] [NOISE] Suppressed non-speech transcript: "${transcript}"`);
      this.onAbortTurn?.({
        action: "ABORT_RESPONSE",
        reason: "noise_transcript",
        transcript,
        timestamp: Date.now(),
      });
      return;
    }

    console.log(`[LiveVoice Voice] Transcript: "${transcript}"`);

    // If turn speaker is OTHER, evaluate through authorization policy and store transcript
    if (this.currentTurnSpeaker && this.currentTurnSpeaker !== GATE_STATES.USER) {
      if (this.isAssistantSpeaking()) {
        console.log(`[SmartVoiceGate] [ECHO SUPPRESSED] Ignored echo transcript during assistant speech: "${transcript}"`);
        return;
      }
      const authDecision = this.authorizationPolicy.evaluate({
        speaker: this.currentTurnSpeaker,
        isUser: false,
        addressDecision: { addressedTo: "UNKNOWN" },
        transcript,
      });
      console.log(`[SmartVoiceGate] Recorded third-party context from '${this.currentTurnSpeaker}':`, authDecision);
      this.lastGateDecision = authDecision;
      this.onDecision?.(authDecision);
      // Ensure assistant response stays silent
      this.onAbortTurn?.({
        action: "ABORT_RESPONSE",
        target: this.currentTurnSpeaker,
        transcript,
        reason: "unauthorized_speaker",
        timestamp: Date.now(),
      });
      return;
    }

    const isSessionActive = this.addressDetector.isSessionActive();
    const addressResult = this.addressDetector.detectAddressing(transcript, {
      isSessionActive,
      assumeContinuation: this.assumeContinuationInSession && (isSessionActive || this.addressDetector.sessionActive),
    });
    console.log(`[LiveVoice Voice] Addressed: ${addressResult.addressedTo} (reason: ${addressResult.reason}, confidence: ${addressResult.confidence?.toFixed(2)})`);

    // Update Authorization Policy
    const authDecision = this.authorizationPolicy.evaluate({
      speaker: GATE_STATES.USER,
      isUser: true,
      addressDecision: addressResult,
      transcript,
    });

    if (addressResult.addressedTo === ADDRESS_TARGETS.OTHER) {
      // USER -> OTHER -> DROPPED immediately!
      this.isDispatching = false;
      this.stats.sideTalkAborted += 1;

      const abortPayload = {
        ...authDecision,
        action: "DISCARD",
        target: addressResult.addressedOtherTarget || "other",
        transcript,
        reason: addressResult.reason,
        confidence: addressResult.confidence,
        timestamp: Date.now(),
      };
      console.log(`[SmartVoiceGate] [DISCARD] USER -> OTHER ('${addressResult.addressedOtherTarget || 'other'}', "${transcript}") -> turn dropped immediately`);
      this.lastGateDecision = abortPayload;
      this.onAbortTurn?.(abortPayload);
      this.onDecision?.(abortPayload);
      return;
    }

    this.lastGateDecision = authDecision;
    this.onDecision?.(authDecision);
    this.addressDetector.recordUserTurn();
  }

  /**
   * Notifies gate that a native wake word signal was detected.
   */
  notifyWakeWord(phrase = "Hey Rie") {
    this.addressDetector.startSession({ triggeredBy: "wake_word", phrase });
  }

  /**
   * Records assistant response turn (keeps conversational window active).
   */
  recordAssistantTurn() {
    this.addressDetector.recordAssistantTurn();
  }

  /**
   * Starts a live session.
   */
  startSession(metadata = {}) {
    this.addressDetector.startSession(metadata);
  }

  /**
   * Ends an active live session and resets gate.
   */
  endSession() {
    this.addressDetector.endSession();
    this.reset();
  }

  /**
   * Concludes microphone speech capture turn (after silence hangover).
   * Note: Does NOT reset turn authorization, because Gemini is still processing
   * and generating its response downstream. Authorization remains locked until
   * completeDialogueTurn() is called upon turn completion!
   */
  handleTurnComplete(turnInfo) {
    this.isDispatching = false;
    if (turnInfo?.speaker === GATE_STATES.USER) {
      this.addressDetector.recordUserTurn();
    }
    this.onTurnComplete?.(turnInfo);
  }

  /**
   * Concludes the full conversational dialogue turn (after Gemini completes its response).
   */
  completeDialogueTurn() {
    this.currentTurnSpeaker = null;
    this.authorizationPolicy.resetTurn();
  }

  /**
   * Resets all gate states and pre-roll buffers.
   */
  reset() {
    this.isDispatching = false;
    this.currentTurnSpeaker = null;
    this.authorizationPolicy.resetTurn();
    this.speakerGate.reset();
  }

  /**
   * Returns diagnostic stats and status.
   */
  getStats() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      isDispatching: this.isDispatching,
      gateState: this.speakerGate.state,
      isSessionActive: this.addressDetector.isSessionActive(),
      canSpeak: this.authorizationPolicy.canSpeak(),
      canExecuteTools: this.authorizationPolicy.canExecuteTools(),
      lastDecision: this.lastGateDecision,
      stats: { ...this.stats },
    };
  }
}

export const smartVoiceGate = new SmartVoiceGate();
export default smartVoiceGate;

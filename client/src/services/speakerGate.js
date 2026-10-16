/**
 * Speaker Verification Gate for Rie-AI.
 *
 * Implements a 3-state speaker gate between the microphone capture and downstream consumers:
 *
 *   Microphone
 *       ↓
 *      VAD
 *       ↓
 *   speech starts
 *       ↓
 *   Pre-roll buffer (~500–800ms)
 *       ↓
 *   Speaker verification
 *       │
 *       ├── USER ───────► allow
 *       │
 *       ├── UNKNOWN ────► wait / discard (stay silent)
 *       │
 *       └── OTHER ─────► discard
 *
 * Decision Thresholds:
 *   Score >= 0.55        -> USER (allow audio stream)
 *   0.35 <= Score < 0.55 -> UNKNOWN (stay silent / accumulate evidence)
 *   Score < 0.35         -> OTHER (discard audio)
 *
 * Multi-Window Progressive Verification:
 *   - Evaluates initial speech window (~1000ms from onset)
 *   - If score >= 0.55 -> OPEN immediately
 *   - If score < 0.35 (and >= 1.4s) -> DISCARD immediately
 *   - If uncertain (0.35..0.55) -> ACCUMULATE (+500ms) up to 2500ms max window
 *   - Once identified as USER, gate stays OPEN for that turn without re-verifying.
 */

import { speakerVerificationService } from "./speakerVerificationService";

export const GATE_STATES = {
  IDLE: "IDLE",
  VERIFYING: "VERIFYING",
  USER: "USER",
  OTHER: "OTHER",
  UNKNOWN: "UNKNOWN",
};

/** Convert base64 string to Uint8Array bytes */
function base64ToBytes(base64) {
  const binaryString = typeof atob !== "undefined"
    ? atob(base64)
    : Buffer.from(base64, "base64").toString("binary");
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Convert Uint8Array bytes to base64 string */
function bytesToBase64(bytes) {
  if (typeof btoa !== "undefined") {
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

export class SpeakerGate {
  constructor(options = {}) {
    this.mode = options.mode || "drop"; // Default: "drop" (pre-dispatch drop) | "tagger" (identity tagger)
    this.sampleRate = options.sampleRate || 16000;
    this.chunkSamples = options.chunkSamples || 512; // ~32ms at 16kHz
    this.preRollMs = options.preRollMs || 640;       // ~20 chunks = 640ms (500–800ms)
    this.silenceHangoverMs = options.silenceHangoverMs || 500;
    this.speechOnsetThresholdChunks = options.speechOnsetThresholdChunks || 2;

    // Multi-window progressive parameters:
    this.initialVerifyWindowMs = options.initialVerifyWindowMs ?? options.speechVerifyWindowMs ?? 800;
    this.windowStepMs = options.windowStepMs || 400;
    this.maxVerifyWindowMs = options.maxVerifyWindowMs || 2500;
    this.minOtherDurationSec = options.minOtherDurationSec ?? (this.initialVerifyWindowMs / 1000);

    this.userThreshold = options.userThreshold ?? 0.50;
    this.unknownThreshold = options.unknownThreshold ?? 0.32;

    // Active session conversational continuity parameters
    this.activeSessionProvider = options.activeSessionProvider || null;
    this.activeSessionUserThreshold = options.activeSessionUserThreshold ?? 0.46;
    this.activeSessionMaxDurationSec = options.activeSessionMaxDurationSec ?? 1.2;

    // Echo awareness: whether assistant is actively outputting speech to speakers
    this.isAssistantSpeaking = options.isAssistantSpeaking || null;
    this.startedDuringAssistantPlayback = false;

    this.verificationService = options.verificationService || speakerVerificationService;

    // Ring buffer size for pre-roll
    const msPerChunk = (this.chunkSamples / this.sampleRate) * 1000;
    this.preRollCapacity = Math.max(5, Math.ceil(this.preRollMs / msPerChunk));

    // Internal state
    this.state = GATE_STATES.IDLE;
    this.preRollBuffer = []; // circular buffer of { base64, rawBytes, rms }
    this.preRollSnapshot = [];
    this.activeSpeechChunks = [];
    this.pendingQueue = [];  // chunks collected while verification request is in flight
    this.isVerificationInFlight = false;

    // Progressive turn promotion state
    this.turnSpeechChunks = []; // all speech chunks collected during this turn
    this.lastPromoteCheckSamples = 0;
    this.isPromotionInFlight = false;

    this.currentVerifyTargetMs = this.initialVerifyWindowMs;
    this.verificationAttempt = 0;
    this.noiseFloor = 0.005;
    this.consecutiveSpeechChunks = 0;
    this.actualSpeechChunks = 0;
    this.lastSpeechTime = 0;
    this.currentTurnId = 0;

    // Event callbacks
    this.onAudioPass = options.onAudioPass || null;
    this.onDecision = options.onDecision || null;
    this.onStateChange = options.onStateChange || null;
    this.onTurnComplete = options.onTurnComplete || null;
    this.onAbortTurn = options.onAbortTurn || null;
    this.onSpeechOnset = options.onSpeechOnset || null;
    this.onError = options.onError || null;

    // Recorder reference if attached
    this.attachedRecorder = null;
  }

  /**
   * Set callback for allowed audio (USER speech).
   */
  setAudioPassCallback(callback) {
    this.onAudioPass = callback;
  }

  /**
   * Set callback for speaker gate decisions.
   */
  setDecisionCallback(callback) {
    this.onDecision = callback;
  }

  /**
   * Sets gate operating mode ("tagger" | "drop").
   */
  setMode(mode) {
    this.mode = mode;
  }

  /**
   * Updates state and notifies listener.
   */
  setState(newState, details = {}) {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.onStateChange?.(newState, oldState, details);
  }

  /**
   * Reset gate to IDLE state and clear all queues.
   */
  reset() {
    this.setState(GATE_STATES.IDLE);
    this.preRollBuffer = [];
    this.preRollSnapshot = [];
    this.activeSpeechChunks = [];
    this.pendingQueue = [];
    this.turnSpeechChunks = [];
    this.lastPromoteCheckSamples = 0;
    this.isPromotionInFlight = false;
    this.isVerificationInFlight = false;
    this.currentVerifyTargetMs = this.initialVerifyWindowMs;
    this.verificationAttempt = 0;
    this.consecutiveSpeechChunks = 0;
    this.actualSpeechChunks = 0;
    this.lastSpeechTime = 0;
  }

  /**
   * Aborts an in-flight or pending verification turn (e.g. transient noise or cancellation).
   */
  abortVerification(reason = "transient_noise") {
    const turnId = this.currentTurnId;
    this.isVerificationInFlight = false;
    this.isPromotionInFlight = false;
    this.activeSpeechChunks = [];
    this.pendingQueue = [];
    this.turnSpeechChunks = [];
    this.lastPromoteCheckSamples = 0;
    this.preRollSnapshot = [];
    this.actualSpeechChunks = 0;
    this.startedDuringAssistantPlayback = false;
    this.setState(GATE_STATES.IDLE, { reason, turnId });
    this.onAbortTurn?.({ reason, turnId });
  }

  /**
   * Processes a live audio chunk (e.g. from LiveAudioRecorder onaudioprocess).
   *
   * @param {string|Uint8Array|ArrayBuffer} chunkData - 16-bit PCM little-endian audio (base64 string or binary bytes)
   * @param {number} rms - Root Mean Square audio volume level [0.0, 1.0]
   */
  processAudioChunk(chunkData, rms = 0) {
    const now = Date.now();

    // Standardize representation: keep both base64 and raw Uint8Array
    let base64Chunk;
    let rawBytes;

    if (typeof chunkData === "string") {
      base64Chunk = chunkData;
      rawBytes = base64ToBytes(chunkData);
    } else {
      rawBytes = chunkData instanceof Uint8Array ? chunkData : new Uint8Array(chunkData);
      base64Chunk = bytesToBase64(rawBytes);
    }

    if (rms === 0 && rawBytes && rawBytes.byteLength >= 2) {
      const int16 = new Int16Array(rawBytes.buffer, rawBytes.byteOffset, Math.floor(rawBytes.byteLength / 2));
      let sum = 0;
      for (let i = 0; i < int16.length; i++) {
        const val = int16[i] / 32768.0;
        sum += val * val;
      }
      rms = Math.sqrt(sum / int16.length);
    }

    const chunkEntry = { base64: base64Chunk, rawBytes, rms, timestamp: now };

    // VAD / Speech threshold computation (adaptive to ambient room noise floor)
    // When assistant is speaking, raise threshold to prevent speaker acoustic echo from falsely triggering onset
    const isAssistantSpeaking = Boolean(this.isAssistantSpeaking?.());
    const speechCutoff = isAssistantSpeaking
      ? Math.max(0.038, this.noiseFloor * 3.5)
      : (this.state === GATE_STATES.IDLE
          ? Math.max(0.012, this.noiseFloor * 2.2)
          : Math.max(0.009, this.noiseFloor * 1.6));

    const isSpeech = rms > speechCutoff;

    switch (this.state) {
      case GATE_STATES.IDLE: {
        // Track ambient room noise floor during silence (clamped to prevent runaway)
        // Must NOT track assistant speech output as ambient room noise!
        if (!isSpeech && !isAssistantSpeaking) {
          this.noiseFloor = Math.min(0.035, 0.95 * this.noiseFloor + 0.05 * rms);
        }

        // Maintain circular pre-roll buffer
        this.preRollBuffer.push(chunkEntry);
        if (this.preRollBuffer.length > this.preRollCapacity) {
          this.preRollBuffer.shift();
        }

        if (isSpeech) {
          this.consecutiveSpeechChunks += 1;
          if (this.consecutiveSpeechChunks >= this.speechOnsetThresholdChunks) {
            // Speech onset confirmed: begin speaker verification
            this.startVerification(chunkEntry, now);
            const targetSpeechSamples = Math.floor((this.currentVerifyTargetMs / 1000) * this.sampleRate);
            if (this.activeSpeechChunks.length * this.chunkSamples >= targetSpeechSamples) {
              this.dispatchVerification();
            }
          }
        } else {
          this.consecutiveSpeechChunks = 0;
        }
        break;
      }

      case GATE_STATES.VERIFYING: {
        // Collect active speech chunks for the speaker model
        if (this.isVerificationInFlight) {
          this.pendingQueue.push(chunkEntry);
        } else {
          this.activeSpeechChunks.push(chunkEntry);
        }
        if (isSpeech) {
          this.lastSpeechTime = now;
          this.actualSpeechChunks += 1;
          this.turnSpeechChunks.push(chunkEntry);
        }

        const totalChunks = this.activeSpeechChunks.length + this.pendingQueue.length;
        const totalSpeechSamples = totalChunks * this.chunkSamples;
        const totalSpeechMs = (totalSpeechSamples / this.sampleRate) * 1000;
        const targetSpeechSamples = Math.floor((this.currentVerifyTargetMs / 1000) * this.sampleRate);
        const silenceSinceSpeechMs = now - this.lastSpeechTime;

        // Transient noise rejection: abort if onset triggered on brief click/tap (< 70ms) but followed by silence
        if (this.actualSpeechChunks <= 2 && silenceSinceSpeechMs >= 250 && !this.isVerificationInFlight) {
          this.abortVerification("transient_noise");
          break;
        }

        // Trigger verification when target speech duration reached, or when speech ends, or max window reached
        const hasEnoughSpeech = totalSpeechSamples >= targetSpeechSamples;
        const reachedMaxWindow = totalSpeechMs >= this.maxVerifyWindowMs;
        // Natural pauses between words are 250-500ms; inter-phrase pauses are 500-750ms.
        // If we haven't accumulated sufficient speech (< 1.2s), wait at least 650ms before finalizing.
        const minSilenceToEndMs = totalSpeechMs < 1200 ? Math.max(650, this.silenceHangoverMs) : 450;
        const speechEnded = silenceSinceSpeechMs >= minSilenceToEndMs && totalSpeechSamples >= Math.floor(0.2 * this.sampleRate);

        if ((hasEnoughSpeech || speechEnded || reachedMaxWindow) && !this.isVerificationInFlight) {
          const isFinal = reachedMaxWindow || speechEnded;
          this.dispatchVerification(isFinal);
        }
        break;
      }

      case GATE_STATES.USER: {
        // Enrolled USER confirmed: ALLOW audio directly with zero latency
        if (isSpeech) {
          this.lastSpeechTime = now;
        }

        // Pass chunk downstream (e.g. to Gemini Live WebSocket)
        this.onAudioPass?.(base64Chunk, {
          ...chunkEntry,
          speaker: GATE_STATES.USER,
          authorized: true,
          turnId: this.currentTurnId,
        });

        // Check for silence hangover to end speech turn
        if (!isSpeech && now - this.lastSpeechTime >= this.silenceHangoverMs) {
          this.completeTurn(GATE_STATES.USER);
        }
        break;
      }

      case GATE_STATES.OTHER:
      case GATE_STATES.UNKNOWN: {
        if (isSpeech) {
          this.lastSpeechTime = now;
          this.turnSpeechChunks.push(chunkEntry);
        }

        if (this.mode === "tagger" && !this.isAssistantSpeaking?.()) {
          // Identity Tagger Mode: Pass chunk downstream tagged as unauthorized (ONLY when assistant is NOT speaking)
          this.onAudioPass?.(base64Chunk, {
            ...chunkEntry,
            speaker: this.state,
            authorized: false,
            turnId: this.currentTurnId,
          });
        }

        // Progressive Turn Promotion:
        // If gate was tagged UNKNOWN (due to early window or brief pause),
        // but user continues speaking, check cumulative speech evidence!
        if (this.state === GATE_STATES.UNKNOWN && !this.isPromotionInFlight) {
          const totalTurnSamples = this.turnSpeechChunks.reduce((acc, c) => acc + ((c.rawBytes?.byteLength || 0) / 2), 0);
          const totalTurnDurSec = totalTurnSamples / this.sampleRate;
          const samplesSinceLastCheck = totalTurnSamples - this.lastPromoteCheckSamples;

          // Check at checkpoints (>= 1.2s and at least +500ms new speech) up to 3.2s
          if (totalTurnDurSec >= 1.2 && totalTurnDurSec <= 3.2 && samplesSinceLastCheck >= Math.floor(0.5 * this.sampleRate)) {
            this.dispatchPromotionCheck(totalTurnDurSec);
          }
        }

        // Check for silence hangover to end speech turn
        if (!isSpeech && now - this.lastSpeechTime >= this.silenceHangoverMs) {
          this.completeTurn(this.state);
        }
        break;
      }
    }
  }

  /**
   * Freezes the pre-roll snapshot and enters VERIFYING state upon speech onset.
   */
  startVerification(initialChunk, timestamp) {
    this.currentTurnId += 1;
    const turnId = this.currentTurnId;
    this.lastSpeechTime = timestamp;
    this.currentVerifyTargetMs = this.initialVerifyWindowMs;
    this.verificationAttempt = 0;
    this.actualSpeechChunks = 1;
    this.startedDuringAssistantPlayback = Boolean(this.isAssistantSpeaking?.());
    this.setState(GATE_STATES.VERIFYING, { turnId });

    // Notify listeners of speech onset so response authorization locks immediately
    this.onSpeechOnset?.({ turnId, timestamp });

    // Freeze pre-roll buffer to preserve leading audio before speech started
    this.preRollSnapshot = [...this.preRollBuffer];
    this.activeSpeechChunks = initialChunk ? [initialChunk] : [];
    this.turnSpeechChunks = initialChunk ? [initialChunk] : [];
    this.lastPromoteCheckSamples = 0;
    this.pendingQueue = [];
    this.isVerificationInFlight = false;
    this.isPromotionInFlight = false;
  }

  /**
   * Concatenates active speech chunks and calls the backend verification service.
   */
  dispatchVerification(isFinal = false) {
    this.isVerificationInFlight = true;
    const turnId = this.currentTurnId;
    // Include both active and pending chunks collected
    if (this.pendingQueue.length > 0) {
      this.activeSpeechChunks.push(...this.pendingQueue);
      this.pendingQueue = [];
    }
    const speechChunks = [...this.activeSpeechChunks];
    const preRollChunks = [...this.preRollSnapshot];

    // If no user profile is registered, all speech is unconditionally allowed as USER
    if (typeof this.verificationService?.isUserEnrolledSync === "function" && !this.verificationService.isUserEnrolledSync()) {
      this.handleVerificationResult(
        {
          speaker: GATE_STATES.USER,
          score: 1.0,
          verdict: "ALLOW",
          is_user: true,
          authorized: true,
        },
        preRollChunks,
        speechChunks,
        isFinal,
      );
      return;
    }

    // Combine speech PCM bytes for Sherpa-ONNX model
    const totalBytes = speechChunks.reduce((acc, c) => acc + c.rawBytes.byteLength, 0);
    const combinedPcm = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of speechChunks) {
      combinedPcm.set(c.rawBytes, offset);
      offset += c.rawBytes.byteLength;
    }

    void this.verificationService.verifyPCM(combinedPcm, this.sampleRate)
      .then((result) => {
        if (this.currentTurnId !== turnId || this.state !== GATE_STATES.VERIFYING) {
          return; // obsolete turn
        }
        this.handleVerificationResult(result, preRollChunks, speechChunks, isFinal);
      })
      .catch((error) => {
        if (this.currentTurnId !== turnId || this.state !== GATE_STATES.VERIFYING) {
          return;
        }
        const isNotFound = error?.status === 404 || /not found|run enrollment/i.test(error?.message || "");
        if (isNotFound) {
          this.verificationService?.clearEnrolledCache?.();
          this.handleVerificationResult(
            {
              speaker: GATE_STATES.USER,
              score: 1.0,
              verdict: "ALLOW",
              is_user: true,
              authorized: true,
            },
            preRollChunks,
            speechChunks,
            isFinal,
          );
          return;
        }
        this.onError?.(error);
        // Fail-closed: treat error as UNKNOWN (stay silent / discard)
        this.handleVerificationResult(
          {
            speaker: GATE_STATES.UNKNOWN,
            score: 0.0,
            verdict: "WAIT_OR_DISCARD",
            error: error.message,
          },
          preRollChunks,
          speechChunks,
          true,
        );
      });
  }

  /**
   * Handles speaker verification result from backend.
   */
  handleVerificationResult(result, preRollChunks, speechChunks, isFinal = false) {
    this.isVerificationInFlight = false;
    this.verificationAttempt += 1;
    const score = Number(result?.score ?? 0);
    const speechSamples = speechChunks.length * this.chunkSamples;
    const speechDurSec = speechSamples / this.sampleRate;

    const isError = Boolean(result?.error);
    const isExplicitUnknown = result?.speaker === GATE_STATES.UNKNOWN || isError;
    const isSessionActive = Boolean(this.activeSessionProvider?.());
    // In an ongoing active dialogue, conversational continuity allows an effective threshold of 0.46
    // across all speech windows so natural variations across languages (Tamil, English)
    // pass with sub-500ms latency. For very short final follow-ups (<= 1.2s like "யார் யாரு?", score 0.44),
    // allow down to 0.44:
    let effectiveUserThreshold = this.userThreshold;
    if (isSessionActive) {
      if (isFinal && speechDurSec <= this.activeSessionMaxDurationSec) {
        effectiveUserThreshold = Math.min(this.activeSessionUserThreshold, 0.44);
      } else {
        effectiveUserThreshold = Math.min(this.activeSessionUserThreshold, 0.46);
      }
    }
    const isUser = !isError && score >= effectiveUserThreshold;
    const isDefiniteOther = !isExplicitUnknown && score < 0.22;
    const isOther = (!isExplicitUnknown && score < this.unknownThreshold && (speechDurSec >= this.minOtherDurationSec || isFinal)) || isDefiniteOther;

    if (isUser) {
      // 1. CLEARLY USER -> OPEN GATE
      const decisionPayload = {
        turnId: this.currentTurnId,
        attempt: this.verificationAttempt,
        durationSec: speechDurSec,
        speaker: GATE_STATES.USER,
        score,
        verdict: "ALLOW",
        isUser: true,
        authorized: true,
        thresholds: { user: this.userThreshold, unknown: this.unknownThreshold },
        latencyMs: result?.latency_ms,
        enrolledSpeaker: result?.enrolled_speaker || "USER",
      };

      this.onDecision?.(decisionPayload);
      this.setState(GATE_STATES.USER, decisionPayload);

      // 1. Flush pre-roll chunks (640ms lead-in, zero first-word clipping!)
      for (const item of preRollChunks) {
        this.onAudioPass?.(item.base64, { ...item, speaker: GATE_STATES.USER, authorized: true, turnId: this.currentTurnId });
      }
      // 2. Flush speech chunks accumulated for verification
      for (const item of speechChunks) {
        this.onAudioPass?.(item.base64, { ...item, speaker: GATE_STATES.USER, authorized: true, turnId: this.currentTurnId });
      }
      // 3. Flush any pending chunks that arrived during backend latency
      for (const item of this.pendingQueue) {
        this.onAudioPass?.(item.base64, { ...item, speaker: GATE_STATES.USER, authorized: true, turnId: this.currentTurnId });
      }

      this.preRollBuffer = [];
      this.preRollSnapshot = [];
      this.activeSpeechChunks = [];
      this.pendingQueue = [];

    } else if (!isUser && Boolean(this.startedDuringAssistantPlayback || this.isAssistantSpeaking?.())) {
      // 0. ACOUSTIC ECHO / ASSISTANT SELF-VOICE DETECTED
      // While the assistant was speaking, non-user audio was captured.
      // This is acoustic echo leaking from the speakers into the microphone.
      // Do NOT classify as OTHER, do NOT flush chunks to Gemini, do NOT trigger abort/cancellation.
      console.log(
        `[SpeakerGate] Suppressed assistant self-voice / acoustic echo (score: ${score.toFixed(4)}, speech: ${speechDurSec.toFixed(2)}s). Discarding echo turn.`
      );
      this.abortVerification("assistant_echo");
      return;

    } else if (isOther) {
      // 2. CLEARLY OTHER
      const isTagger = this.mode === "tagger";
      const decisionPayload = {
        turnId: this.currentTurnId,
        attempt: this.verificationAttempt,
        durationSec: speechDurSec,
        speaker: GATE_STATES.OTHER,
        score,
        verdict: isTagger ? "TAG_OTHER" : "DISCARD",
        isUser: false,
        authorized: false,
        thresholds: { user: this.userThreshold, unknown: this.unknownThreshold },
        latencyMs: result?.latency_ms,
        enrolledSpeaker: result?.enrolled_speaker || "USER",
      };

      this.onDecision?.(decisionPayload);
      this.setState(GATE_STATES.OTHER, decisionPayload);

      if (isTagger) {
        // Identity Tagger Mode: Flush pre-roll & speech chunks with authorized: false
        for (const item of preRollChunks) {
          this.onAudioPass?.(item.base64, { ...item, speaker: GATE_STATES.OTHER, authorized: false, turnId: this.currentTurnId });
        }
        for (const item of speechChunks) {
          this.onAudioPass?.(item.base64, { ...item, speaker: GATE_STATES.OTHER, authorized: false, turnId: this.currentTurnId });
        }
        for (const item of this.pendingQueue) {
          this.onAudioPass?.(item.base64, { ...item, speaker: GATE_STATES.OTHER, authorized: false, turnId: this.currentTurnId });
        }
      }

      this.preRollBuffer = [];
      this.preRollSnapshot = [];
      this.activeSpeechChunks = [];
      this.pendingQueue = [];

    } else {
      // 3. UNKNOWN / UNCERTAIN
      const isBorderline = score >= 0.25 && score < this.userThreshold;
      if (!isFinal && isBorderline && ((speechDurSec * 1000) + this.windowStepMs <= this.maxVerifyWindowMs + 100)) {
        // Accumulate more audio evidence for borderline scores!
        this.currentVerifyTargetMs = (speechDurSec * 1000) + this.windowStepMs;
        const reason = score >= this.unknownThreshold ? "UNCERTAIN / BORDERLINE" : "EARLY WINDOW";
        const accumulatingPayload = {
          turnId: this.currentTurnId,
          attempt: this.verificationAttempt,
          durationSec: speechDurSec,
          speaker: GATE_STATES.UNKNOWN,
          score,
          verdict: "WAIT_OR_DISCARD",
          reason,
          accumulating: true,
          nextTargetMs: this.currentVerifyTargetMs,
          thresholds: { user: this.userThreshold, unknown: this.unknownThreshold },
          latencyMs: result?.latency_ms,
        };

        this.onDecision?.(accumulatingPayload);
        // Drain pendingQueue into activeSpeechChunks and keep verifying
        if (this.pendingQueue.length > 0) {
          this.activeSpeechChunks.push(...this.pendingQueue);
          this.pendingQueue = [];
        }
      } else {
        // Final window, speech ended, or low score (noise) -> tag as UNKNOWN or OTHER immediately
        const speakerVerdict = (isExplicitUnknown || score >= this.unknownThreshold) ? GATE_STATES.UNKNOWN : GATE_STATES.OTHER;
        const isTagger = this.mode === "tagger";
        const decisionPayload = {
          turnId: this.currentTurnId,
          attempt: this.verificationAttempt,
          durationSec: speechDurSec,
          speaker: speakerVerdict,
          score,
          verdict: isTagger ? (speakerVerdict === GATE_STATES.OTHER ? "TAG_OTHER" : "TAG_UNKNOWN") : "DISCARD",
          isUser: false,
          authorized: false,
          accumulating: false,
          thresholds: { user: this.userThreshold, unknown: this.unknownThreshold },
          latencyMs: result?.latency_ms,
        };

        this.onDecision?.(decisionPayload);
        this.setState(speakerVerdict, decisionPayload);

        if (isTagger) {
          for (const item of preRollChunks) {
            this.onAudioPass?.(item.base64, { ...item, speaker: speakerVerdict, authorized: false, turnId: this.currentTurnId });
          }
          for (const item of speechChunks) {
            this.onAudioPass?.(item.base64, { ...item, speaker: speakerVerdict, authorized: false, turnId: this.currentTurnId });
          }
          for (const item of this.pendingQueue) {
            this.onAudioPass?.(item.base64, { ...item, speaker: speakerVerdict, authorized: false, turnId: this.currentTurnId });
          }
        }

        this.preRollBuffer = [];
        this.preRollSnapshot = [];
        this.activeSpeechChunks = [];
        this.pendingQueue = [];
      }
    }
  }

  /**
   * Evaluates cumulative speech evidence for possible turn promotion from UNKNOWN to USER.
   */
  dispatchPromotionCheck(durationSec) {
    if (typeof this.verificationService?.isUserEnrolledSync === "function" && !this.verificationService.isUserEnrolledSync()) {
      return;
    }
    this.isPromotionInFlight = true;
    const turnId = this.currentTurnId;
    const speechChunks = [...this.turnSpeechChunks];
    const totalBytes = speechChunks.reduce((acc, c) => acc + (c.rawBytes ? c.rawBytes.byteLength : 0), 0);
    this.lastPromoteCheckSamples = Math.floor(totalBytes / 2);

    const combinedPcm = new Uint8Array(totalBytes);
    let offset = 0;
    for (const c of speechChunks) {
      if (c.rawBytes) {
        combinedPcm.set(c.rawBytes, offset);
        offset += c.rawBytes.byteLength;
      }
    }

    void this.verificationService.verifyPCM(combinedPcm, this.sampleRate)
      .then((result) => {
        this.isPromotionInFlight = false;
        if (this.currentTurnId !== turnId || this.state !== GATE_STATES.UNKNOWN) {
          return;
        }

        const score = Number(result?.score ?? 0);
        const isSessionActive = Boolean(this.activeSessionProvider?.());
        const threshold = isSessionActive ? Math.min(this.activeSessionUserThreshold, 0.46) : this.userThreshold;

        if (score >= threshold) {
          // PROMOTION TO USER!
          const promoPayload = {
            turnId: this.currentTurnId,
            attempt: this.verificationAttempt + 1,
            durationSec,
            speaker: GATE_STATES.USER,
            score,
            verdict: "ALLOW",
            isUser: true,
            authorized: true,
            promoted: true,
            thresholds: { user: this.userThreshold, unknown: this.unknownThreshold },
            latencyMs: result?.latency_ms,
            enrolledSpeaker: result?.enrolled_speaker || "USER",
          };

          this.setState(GATE_STATES.USER, promoPayload);
          this.onDecision?.(promoPayload);

          if (this.mode === "drop") {
            for (const item of this.turnSpeechChunks) {
              this.onAudioPass?.(item.base64, {
                ...item,
                speaker: GATE_STATES.USER,
                authorized: true,
                turnId: this.currentTurnId,
              });
            }
          }
        }
      })
      .catch(() => {
        this.isPromotionInFlight = false;
      });
  }

  /**
   * Concludes the speech turn after silence hangover, resetting to IDLE.
   */
  completeTurn(speakerState) {
    const turnInfo = {
      turnId: this.currentTurnId,
      speaker: speakerState,
      endedAt: Date.now(),
    };

    this.onTurnComplete?.(turnInfo);
    this.setState(GATE_STATES.IDLE);

    this.preRollBuffer = [];
    this.pendingQueue = [];
    this.turnSpeechChunks = [];
    this.lastPromoteCheckSamples = 0;
    this.isPromotionInFlight = false;
    this.consecutiveSpeechChunks = 0;
    this.actualSpeechChunks = 0;
    this.lastSpeechTime = 0;
  }

  /**
   * Attaches to an active LiveAudioRecorder instance for real microphone testing.
   *
   * @param {object} recorder - Instance of LiveAudioRecorder
   */
  attachRecorder(recorder) {
    if (!recorder) throw new Error("recorder is required");
    this.attachedRecorder = recorder;
    return recorder.start(
      (base64Chunk) => this.processAudioChunk(base64Chunk),
      (volume) => {
        // RMS volume can also be fed directly
        this.processAudioChunkVolume?.(volume);
      },
    );
  }

  /**
   * Detaches and stops the active recorder.
   */
  detachRecorder() {
    if (this.attachedRecorder) {
      this.attachedRecorder.stop();
      this.attachedRecorder = null;
    }
    this.reset();
  }
}

export const speakerGate = new SpeakerGate();

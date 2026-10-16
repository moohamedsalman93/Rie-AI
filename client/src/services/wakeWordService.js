/**
 * Wake Word Detection Service
 * Uses Sherpa-ONNX Zipformer KWS engine (100% offline, native desktop in-process)
 * to detect "Hey Rie", "Rie", "Hi Rie", "OK Rie" with zero cloud servers or browser dependencies.
 */

import { speakerVerificationService } from "./speakerVerificationService";

// Fail closed while settings are loading (or if an older backend omits the key).
export function isWakeWordEnabled(value) {
  return value === true || value === "true";
}

export class WakeWordService {
  constructor(options = {}) {
    this.enabled = false;
    this.isListening = false;
    this.isPaused = false;
    this.onWakeCallback = null;
    this.onStatusCallback = null;
    this.unlisten = null;
    this.isNative = false;
    this.lastTriggerTime = 0;
    this.operation = Promise.resolve();
    this.speakerVerification = options.speakerVerification || speakerVerificationService;
    this.lastTransitionAudio = null;
  }

  isSupported() {
    return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
  }

  consumeTransitionAudio() {
    const audio = this.lastTransitionAudio;
    this.lastTransitionAudio = null;
    return audio;
  }

  // Desired state changes immediately; native start/stop commands are serialized.
  // In particular, disabling during an in-flight start must still stop its mic.
  configure({ enabled = this.enabled, paused = this.isPaused, onWake = this.onWakeCallback, onStatus = this.onStatusCallback } = {}) {
    this.enabled = Boolean(enabled);
    this.isPaused = Boolean(paused);
    this.onWakeCallback = onWake;
    this.onStatusCallback = onStatus;
    if (this.enabled) void this.speakerVerification?.isUserEnrolled?.();
    if (!this.shouldListen()) this.isListening = false;
    this.operation = this.operation.catch(() => {}).then(() => this.reconcile());
    return this.operation;
  }

  shouldListen() {
    return this.enabled && !this.isPaused && this.isSupported();
  }

  start({ onWake, onStatus }) {
    return this.configure({ enabled: true, onWake, onStatus });
  }

  pause() {
    return this.configure({ paused: true });
  }

  resume() {
    // Resuming a call never re-enables a disabled wake-word preference.
    return this.configure({ paused: false });
  }

  stop() {
    return this.configure({ enabled: false, onWake: null });
  }

  async releaseMicrophone() {
    this.isListening = false;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.isNative) {
      const { invoke } = await import("@tauri-apps/api/core");
      const transitionAudio = await invoke("stop_native_wake_word");
      // Keep ownership on failure so a subsequent stop can retry.
      this.isNative = false;
      if (typeof transitionAudio === "string" && transitionAudio.length > 0) {
        this.lastTransitionAudio = transitionAudio;
      }
    }
  }

  async reconcile() {
    if (!this.shouldListen()) {
      await this.releaseMicrophone();
      console.log(`[WakeWord] Background listener state: ${this.enabled ? (this.isPaused ? "paused (in-call)" : "idle") : "disabled"}`);
      this.onStatusCallback?.(this.enabled ? "paused" : "disabled");
      return false;
    }
    if (this.isListening) return true;

    // Finish a previously failed release before acquiring the device again.
    await this.releaseMicrophone();
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    if (!this.shouldListen()) return false;
    try {
      this.unlisten = await listen("rie-native-wake-word", async (event) => {
        if (!this.shouldListen() || !this.isListening) return;
        const now = Date.now();
        if (now - this.lastTriggerTime < 2500) return;

        let detected = typeof event?.payload === "string" ? event.payload : event?.payload?.text;
        const audio = typeof event?.payload === "object" ? event?.payload?.audio : null;
        if (!detected) detected = "rie";

        console.log(`[WakeWord Voice] >>> WAKE WORD DETECTED: "${detected}" <<<`);

        // If user is registered in speaker identification, wake word MUST only work on user voice
        try {
          let isEnrolled = this.speakerVerification?.isUserEnrolledSync
            ? this.speakerVerification.isUserEnrolledSync()
            : false;

          // If cache is not yet warmed up but audio is present, verify enrollment status asynchronously
          if (!isEnrolled && audio && typeof this.speakerVerification?.isUserEnrolled === "function") {
            isEnrolled = await this.speakerVerification.isUserEnrolled();
          }

          if (isEnrolled) {
            if (!audio) {
              console.warn(
                `[WakeWord Gate] Blocked wake word "${detected}". User is registered, but audio was unavailable for speaker verification.`
              );
              this.lastTransitionAudio = null;
              if (this.isNative) {
                const { invoke } = await import("@tauri-apps/api/core");
                void invoke("take_native_wake_word_transition_audio").catch(() => {});
              }
              return;
            }

            let verification = null;
            try {
              verification = await this.speakerVerification?.verifyPCM?.(audio);
            } catch (err) {
              const isNotFound = err?.status === 404 || /not found|run enrollment/i.test(err?.message || "");
              if (isNotFound) {
                console.info("[WakeWord Gate] No enrolled voice profile found on server. Allowing wake word unconditionally.");
                this.speakerVerification?.clearEnrolledCache?.();
                isEnrolled = false;
              } else {
                console.warn("[WakeWord Gate] Verification request failed:", err);
                throw err;
              }
            }

            if (isEnrolled && (!verification || !verification.is_user)) {
              console.warn(
                `[WakeWord Gate] Blocked wake word "${detected}" from unauthorized speaker (${verification?.speaker || "UNKNOWN"}, score: ${verification?.score ?? 0}). Rie remains asleep.`
              );
              this.lastTransitionAudio = null;
              if (this.isNative) {
                const { invoke } = await import("@tauri-apps/api/core");
                void invoke("take_native_wake_word_transition_audio").catch(() => {});
              }
              return;
            }

            if (isEnrolled && verification) {
              console.log(
                `[WakeWord Gate] Verified registered user voice (speaker: ${verification.speaker}, score: ${verification.score}). Waking Rie!`
              );
            }
          }
        } catch (checkErr) {
          console.warn("[WakeWord Gate] Speaker verification error, failing closed:", checkErr);
          this.lastTransitionAudio = null;
          if (this.isNative) {
            const { invoke } = await import("@tauri-apps/api/core");
            void invoke("take_native_wake_word_transition_audio").catch(() => {});
          }
          return;
        }

        this.lastTriggerTime = now;
        this.onWakeCallback?.(detected);
      });
      if (!this.shouldListen()) {
        await this.releaseMicrophone();
        return false;
      }
      // A failed invocation can be ambiguous; still attempt native cleanup.
      this.isNative = true;
      await invoke("start_native_wake_word");
      if (!this.shouldListen()) {
        await this.releaseMicrophone();
        return false;
      }
      this.isListening = true;
      console.log("[WakeWord] Native Windows background listener started and listening for 'Hey Rie'.");
      this.onStatusCallback?.("listening");
      return true;
    } catch (error) {
      console.warn("[WakeWord] Could not start native background listener:", error);
      await this.releaseMicrophone();
      this.onStatusCallback?.("error");
      throw error;
    }
  }
}

export const wakeWordService = new WakeWordService();

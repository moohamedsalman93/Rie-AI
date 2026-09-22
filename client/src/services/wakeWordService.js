/**
 * Wake Word Detection Service
 * Uses Windows Built-in System.Speech.Recognition engine (100% offline, native desktop)
 * to detect "Hey Rie", "Rie", "Hi Rie", "OK Rie" with zero cloud servers or browser dependencies.
 */

// Fail closed while settings are loading (or if an older backend omits the key).
export function isWakeWordEnabled(value) {
  return value === true || value === "true";
}

export class WakeWordService {
  constructor() {
    this.enabled = false;
    this.isListening = false;
    this.isPaused = false;
    this.onWakeCallback = null;
    this.onStatusCallback = null;
    this.unlisten = null;
    this.isNative = false;
    this.lastTriggerTime = 0;
    this.operation = Promise.resolve();
  }

  isSupported() {
    return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
  }

  // Desired state changes immediately; native start/stop commands are serialized.
  // In particular, disabling during an in-flight start must still stop its mic.
  configure({ enabled = this.enabled, paused = this.isPaused, onWake = this.onWakeCallback, onStatus = this.onStatusCallback } = {}) {
    this.enabled = Boolean(enabled);
    this.isPaused = Boolean(paused);
    this.onWakeCallback = onWake;
    this.onStatusCallback = onStatus;
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
      await invoke("stop_native_wake_word");
      // Keep ownership on failure so a subsequent stop can retry.
      this.isNative = false;
    }
  }

  async reconcile() {
    if (!this.shouldListen()) {
      await this.releaseMicrophone();
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
      this.unlisten = await listen("rie-native-wake-word", (event) => {
        if (!this.shouldListen() || !this.isListening) return;
        const now = Date.now();
        if (now - this.lastTriggerTime < 2500) return;
        this.lastTriggerTime = now;
        this.onWakeCallback?.(event.payload);
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
      this.onStatusCallback?.("listening");
      return true;
    } catch (error) {
      await this.releaseMicrophone();
      this.onStatusCallback?.("error");
      throw error;
    }
  }
}

export const wakeWordService = new WakeWordService();

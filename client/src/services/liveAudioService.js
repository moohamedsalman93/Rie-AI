/**
 * Live audio engine for Gemini Live API
 * Provides low-latency microphone PCM streaming (16kHz), gapless PCM audio playback (24kHz),
 * and instantaneous interruption / barge-in handling.
 */

import { API_BASE_URL, getAppToken, getCachedClientContextPayload } from "./chatApi";

/** Convert Float32Array [-1.0, 1.0] to 16-bit linear PCM little-endian ArrayBuffer */
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

/** Convert ArrayBuffer to base64 string */
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

/** Convert base64 16-bit PCM little-endian to Float32Array for AudioContext playback */
function base64ToFloat32(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16Array = new Int16Array(bytes.buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

/**
 * Microphone Recorder:
 * Uses the WebView/browser audio processor for acoustic echo cancellation,
 * noise suppression and 16kHz PCM streaming, including on desktop.
 */
export class LiveAudioRecorder {
  constructor() {
    this.isActive = false;
    this.isRecording = false;
    this.isMuted = false;
    this.generation = 0;
    this.startPromise = null;
    this.onChunkCallback = null;
    this.onVolumeCallback = null;

    // Only the browser capture path is used (including on desktop) for AEC.
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.muteGain = null;
  }

  start(onChunk, onVolume) {
    this.isActive = true;
    this.onChunkCallback = onChunk;
    this.onVolumeCallback = onVolume;
    if (this.isMuted || this.isRecording) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    const pending = this.openMicrophone(++this.generation);
    this.startPromise = pending;
    const clearPending = () => {
      if (this.startPromise === pending) this.startPromise = null;
    };
    pending.then(clearPending, clearPending);
    return pending;
  }

  async openMicrophone(generation) {
    try {
      if (!navigator.mediaDevices?.getSupportedConstraints().echoCancellation) {
        throw new Error("Echo cancellation is unavailable. Update Microsoft Edge WebView2 and restart Rie.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: { exact: true },
          noiseSuppression: true,
          autoGainControl: true,
          latency: 0,
        },
      });

      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.mediaStream = stream;

      if (stream.getAudioTracks()[0]?.getSettings().echoCancellation !== true) {
        throw new Error("The microphone could not enable echo cancellation.");
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: 16000, latencyHint: "interactive" });
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      if (generation !== this.generation) return;
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);

      // 32ms packets (512 samples) keep capture latency imperceptible while
      // reducing WebSocket JSON serialization frequency and main-thread event churn.
      this.processorNode = this.audioContext.createScriptProcessor(512, 1, 1);

      this.processorNode.onaudioprocess = (e) => {
        // A queued callback from before mute must not leak into a new stream.
        if (generation !== this.generation || !this.isRecording || this.isMuted) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Compute RMS volume for the visualizer, never as a speech/noise gate.
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sum / inputData.length);
        this.onVolumeCallback?.(Math.min(1.0, rms * 5.0));

        // Keep quiet syllables and word endings intact. The browser suppresses
        // noise; Gemini detects speech. Send silence too for turn timing.
        const pcmBuffer = floatTo16BitPCM(inputData);
        this.onChunkCallback?.(arrayBufferToBase64(pcmBuffer));
      };

      this.sourceNode.connect(this.processorNode);
      this.muteGain = this.audioContext.createGain();
      this.muteGain.gain.value = 0;
      this.processorNode.connect(this.muteGain);
      this.muteGain.connect(this.audioContext.destination);
      this.isRecording = true;
    } catch (error) {
      // Rejection from an obsolete permission/resume request is not a failure
      // of the current stream, and must not close a newer microphone.
      if (generation !== this.generation) return;
      this.releaseMicrophone();
      throw error;
    }
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    if (this.isMuted) {
      this.releaseMicrophone();
      return Promise.resolve();
    }
    // Muting releases hardware, but preserves the call's callbacks for unmute.
    // A stopped recorder must never reacquire the microphone via this method.
    return this.isActive ? this.start(this.onChunkCallback, this.onVolumeCallback) : Promise.resolve();
  }

  stop() {
    this.isActive = false;
    this.releaseMicrophone();
    this.onChunkCallback = this.onVolumeCallback = null;
  }

  releaseMicrophone() {
    this.generation += 1;
    this.startPromise = null;
    this.isRecording = false;

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try {
        this.processorNode.disconnect();
      } catch {}
      this.processorNode = null;
    }
    if (this.muteGain) {
      try {
        this.muteGain.disconnect();
      } catch {}
      this.muteGain = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {}
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      try {
        if (this.audioContext.state !== "closed") void this.audioContext.close().catch(() => {});
      } catch {}
      this.audioContext = null;
    }
    this.onVolumeCallback?.(0);
  }
}

/**
 * Audio Stream Player: gapless 24kHz PCM playback with instant interruption
 */
export class LiveAudioPlayer {
  constructor() {
    this.audioContext = null;
    this.analyser = null;
    this.gainNode = null;
    this.nextPlayTime = 0;
    this.activeNodes = [];
    this.onVolumeCallback = null;
    this._volumeInterval = null;
  }

  init(onVolume) {
    this.onVolumeCallback = onVolume;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate: 24000 });
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.0;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;

    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    this.nextPlayTime = this.audioContext.currentTime;

    // Track playback volume for visualizer
    if (this.onVolumeCallback) {
      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this._volumeInterval = setInterval(() => {
        if (!this.analyser || this.activeNodes.length === 0) {
          this.onVolumeCallback(0);
          return;
        }
        this.analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        this.onVolumeCallback(Math.min(1.0, avg / 128.0));
      }, 50);
    }
  }

  playChunk(base64Data) {
    if (!this.audioContext) return;
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }

    try {
      const float32Data = base64ToFloat32(base64Data);
      const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.gainNode);

      const currentTime = this.audioContext.currentTime;
      // If the audio queue ran dry, this is the start of speech, or no nodes are active, start immediately
      if (this.nextPlayTime < currentTime || this.activeNodes.length === 0) {
        this.nextPlayTime = currentTime + 0.01;
      }

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
      this.activeNodes.push(source);

      source.onended = () => {
        const idx = this.activeNodes.indexOf(source);
        if (idx !== -1) {
          this.activeNodes.splice(idx, 1);
        }
        if (this.activeNodes.length === 0) this.onIdle?.();
      };
    } catch (err) {
      console.error("[LiveAudioPlayer] Play chunk error:", err);
    }
  }

  /**
   * Stop immediately: kills all scheduled and playing audio nodes with 0 delay (Barge-in)
   */
  stopImmediately() {
    for (const node of this.activeNodes) {
      try {
        node.stop();
      } catch {}
    }
    this.activeNodes = [];
    if (this.audioContext) {
      this.nextPlayTime = this.audioContext.currentTime;
    }
    if (this.onVolumeCallback) {
      this.onVolumeCallback(0);
    }
  }

  close() {
    this.stopImmediately();
    if (this._volumeInterval) {
      clearInterval(this._volumeInterval);
      this._volumeInterval = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }
  }
}

/**
 * Full-duplex Live Voice Session orchestrator
 */
export class LiveVoiceSession {
  constructor(options = {}) {
    this.threadId = options.threadId;
    this.voice = options.voice || "Aoede";
    this.clientContext = options.clientContext || null;
    this.onStatus = (status) => {
      if (this.status === status) return;
      this.status = status;
      options.onStatus?.(status);
      options.onStatusChange?.(status);
    };
    this.onTranscript = options.onTranscript || (() => {});
    this.onToolCall = options.onToolCall || (() => {});
    this.onToolResult = options.onToolResult || (() => {});
    this.onJobUpdate = options.onJobUpdate || (() => {});
    this.onError = options.onError || (() => {});
    this.onVolumes = options.onVolumes || (() => {});
    this.recorder = new LiveAudioRecorder();
    this.player = new LiveAudioPlayer();
    this.ws = null;
    this.isConnected = false;
    this.isMuted = false;
    this.stopped = false;
    this.ready = false;
    this.microphoneVersion = 0;
    this.microphoneStarting = false;
    this.turnComplete = true;
    this.tools = new Map();
    this.transcripts = new Map();
    this.volumes = { userVolume: 0, assistantVolume: 0 };
    this.lastVolumeTime = 0;
  }

  emitVolume(role, volume) {
    if (this.stopped) return;
    this.volumes[role] = volume;
    const now = Date.now();
    if (now - this.lastVolumeTime >= 50) {
      this.lastVolumeTime = now;
      this.onVolumes(this.volumes.userVolume, this.volumes.assistantVolume);
    }
  }

  updateStatus() {
    if (this.stopped || !this.ready) return;
    if (this.microphoneStarting && !this.isMuted) this.onStatus("starting");
    else if (this.player.activeNodes.length) this.onStatus("speaking");
    else if (this.tools.size) this.onStatus("tool");
    else this.onStatus(this.turnComplete ? "listening" : "thinking");
  }

  setMuted(muted) {
    if (this.stopped) return this.isMuted;
    const version = ++this.microphoneVersion;
    this.isMuted = Boolean(muted);
    this.microphoneStarting = !this.isMuted && this.ready;
    const change = this.recorder.setMuted(this.isMuted);
    if (this.isMuted) {
      if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "audio_end" }));
      }
      this.emitVolume("userVolume", 0);
      this.finishStartup();
    }
    void change.then(() => {
      if (this.stopped || version !== this.microphoneVersion) return;
      this.microphoneStarting = false;
      this.finishStartup();
    }).catch((error) => {
      if (!this.stopped && version === this.microphoneVersion) {
        this.fail(error.message || "Could not reopen your microphone. Please reconnect.");
      }
    });
    this.updateStatus();
    return this.isMuted;
  }

  toggleMute() {
    return this.setMuted(!this.isMuted);
  }

  start(clientContext = null) {
    this.onStatus("connecting");
    return new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
      this.setupTimer = setTimeout(() => this.fail("Voice connection timed out. Please try again."), 20000);
      try {
        this.player.init((volume) => this.emitVolume("assistantVolume", volume));
        this.player.onIdle = () => this.updateStatus();
        const params = new URLSearchParams({ voice: this.voice });
        if (this.threadId) params.set("thread_id", this.threadId);
        const token = getAppToken();
        if (token) params.set("token", token);

        const ctx = clientContext || this.clientContext || (typeof getCachedClientContextPayload === "function" ? getCachedClientContextPayload() : {});
        if (ctx?.client_timezone) {
          params.set("client_timezone", ctx.client_timezone);
        }
        if (ctx?.client_local_datetime_iso) {
          params.set("client_local_datetime_iso", ctx.client_local_datetime_iso);
        }
        if (ctx?.client_latitude != null) {
          params.set("client_latitude", String(ctx.client_latitude));
        }
        if (ctx?.client_longitude != null) {
          params.set("client_longitude", String(ctx.client_longitude));
        }
        if (ctx?.client_location_accuracy_m != null) {
          params.set("client_location_accuracy_m", String(ctx.client_location_accuracy_m));
        }

        const ws = new WebSocket(`${API_BASE_URL.replace(/^http/, "ws")}/ws/voice-live?${params}`);
        this.ws = ws;
        ws.onopen = () => {
          if (!this.stopped) this.isConnected = true;
        };
        ws.onmessage = (event) => {
          if (this.stopped) return;
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            this.fail("The voice server sent an invalid response. Please reconnect.");
            return;
          }
          this.handleMessage(msg);
        };
        ws.onerror = () => this.fail("Could not connect to voice. Check the backend and Gemini API key.");
        ws.onclose = () => {
          if (!this.stopped) this.fail("Voice connection ended. Start a new session to reconnect.");
        };
      } catch (error) {
        this.fail(error.message || "Could not start voice.");
      }
    });
  }

  async startMicrophone() {
    if (this.ready || this.stopped) return;
    this.ready = true;
    const version = ++this.microphoneVersion;
    this.microphoneStarting = !this.isMuted;
    this.updateStatus();
    try {
      await this.recorder.start(
        (data) => {
          if (!this.stopped && !this.isMuted && this.ws?.readyState === WebSocket.OPEN) {
            // Never build an unbounded backlog of stale microphone audio.
            if (this.ws.bufferedAmount > 128 * 1024) {
              if (this.ws.bufferedAmount > 1024 * 1024) {
                this.fail("Voice connection is too slow. Please reconnect.");
              }
              return;
            }
            this.ws.send(JSON.stringify({ type: "audio", data }));
          }
        },
        (volume) => this.emitVolume("userVolume", volume),
      );
      if (this.stopped || version !== this.microphoneVersion) return;
      this.microphoneStarting = false;
      this.finishStartup();
    } catch (error) {
      if (!this.stopped && version === this.microphoneVersion) this.fail(error.message || "Could not access your microphone.");
    }
  }

  finishStartup() {
    if (!this.ready || this.stopped || this.microphoneStarting) return;
    clearTimeout(this.setupTimer);
    this.updateStatus();
    this.resolveStart?.();
    this.resolveStart = this.rejectStart = null;
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "ready":
        void this.startMicrophone();
        break;
      case "audio":
        if (this.turnComplete) {
          // Starting a new assistant turn: clear any stale lingering audio from an earlier turn
          this.player.stopImmediately();
        }
        this.turnComplete = false;
        this.player.playChunk(msg.data);
        this.updateStatus();
        break;
      case "transcript": {
        if (!msg.id || !["user", "assistant"].includes(msg.role) || typeof msg.text !== "string") return;
        const transcript = { ...msg, content: msg.text };
        if (msg.isPartial) this.transcripts.set(msg.id, transcript);
        else this.transcripts.delete(msg.id);
        this.onTranscript(transcript);
        break;
      }
      case "tool_call":
        this.tools.set(msg.id, msg);
        this.onToolCall(msg);
        this.updateStatus();
        break;
      case "tool_result":
        this.tools.delete(msg.id);
        // Local execution is finished, but the spoken answer is still pending.
        // This must not return to Listening just because an earlier preamble ended.
        if (msg.status !== "cancelled") this.turnComplete = false;
        this.onToolResult(msg);
        this.updateStatus();
        break;
      case "job_status":
      case "job_progress":
        this.onJobUpdate(msg);
        break;
      case "interrupted":
        this.turnComplete = true;
        this.player.stopImmediately();
        this.updateStatus();
        break;
      case "turn_complete":
        this.turnComplete = true;
        this.updateStatus();
        break;
      case "error":
      case "closed":
        this.fail(msg.message || msg.reason || "Voice connection ended. Please reconnect.");
        break;
      default:
        break;
    }
  }

  sendTextMessage(text) {
    if (this.ready && !this.stopped && this.ws?.readyState === WebSocket.OPEN && text.trim()) {
      if (this.player.activeNodes.length > 0) {
        this.player.stopImmediately();
      }
      this.turnComplete = true;
      this.ws.send(JSON.stringify({ type: "text", text: text.trim() }));
      this.onTranscript({ id: `voice-${crypto.randomUUID()}`, role: "user", text: text.trim(), content: text.trim(), isPartial: false });
    }
  }

  cancelJob(jobId) {
    if (this.ready && !this.stopped && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancel_job", job_id: jobId }));
    }
  }

  fail(message) {
    if (this.stopped) return;
    this.onError(message);
    this.stop(new Error(message));
  }

  stop(error = new DOMException("Voice session ended", "AbortError")) {
    if (this.stopped) return;
    this.stopped = true;
    this.isConnected = this.ready = false;
    clearTimeout(this.setupTimer);
    this.rejectStart?.(error);
    this.resolveStart = this.rejectStart = null;
    this.recorder.stop();
    this.player.close();
    for (const transcript of this.transcripts.values()) {
      this.onTranscript({ ...transcript, isPartial: false, interrupted: true });
    }
    this.transcripts.clear();
    for (const tool of this.tools.values()) {
      this.onToolResult({ ...tool, status: "cancelled", result: "Session ended. Actions already started may still complete." });
    }
    this.tools.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
    }
    this.onVolumes(0, 0);
    this.onStatus("closed");
  }
}

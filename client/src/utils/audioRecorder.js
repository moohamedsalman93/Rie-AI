/**
 * Audio Recording and WAV encoding utilities for Speaker Enrollment and Verification.
 */

/**
 * Encodes a mono Float32Array into a 16-bit linear PCM WAV ArrayBuffer (16kHz).
 * Produces standard 44-byte header RIFF WAV files supported by browsers and Python wave module.
 *
 * @param {Float32Array} float32Array
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(float32Array, sampleRate = 16000) {
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataByteLength = float32Array.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeString = (offset, string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  // RIFF chunk descriptor
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeString(8, "WAVE");

  // fmt sub-chunk
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample (16-bit)

  // data sub-chunk
  writeString(36, "data");
  view.setUint32(40, dataByteLength, true);

  // 16-bit linear PCM samples
  let offset = 44;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
}

/**
 * Resamples Float32Array to 16000 Hz if hardware runs at a different rate (e.g. 44.1k/48k).
 *
 * @param {Float32Array} inputData
 * @param {number} inputSampleRate
 * @returns {Float32Array}
 */
export function downsampleTo16k(inputData, inputSampleRate) {
  if (!inputData || inputSampleRate === 16000) return inputData;
  const ratio = inputSampleRate / 16000;
  const outputLength = Math.round(inputData.length / ratio);
  const result = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const lower = Math.floor(srcIdx);
    const upper = Math.min(lower + 1, inputData.length - 1);
    const frac = srcIdx - lower;
    result[i] = inputData[lower] * (1 - frac) + inputData[upper] * frac;
  }
  return result;
}

/**
 * Converts ArrayBuffer to Base64 string.
 *
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
export function arrayBufferToBase64(buffer) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(buffer).toString("base64");
  }
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const btoaFn = (typeof window !== "undefined" && window.btoa) || (typeof btoa === "function" ? btoa : null);
  if (btoaFn) {
    return btoaFn(binary);
  }
  return "";
}

/**
 * Captures clean microphone audio clips for voice enrollment or verification.
 */
export class VoiceSampleRecorder {
  constructor({ onVolume = null } = {}) {
    this.onVolume = onVolume;
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.chunks = [];
    this.isRecording = false;
    this.startTime = 0;
  }

  /**
   * Starts recording from user's microphone.
   */
  async start() {
    this.chunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.mediaStream = stream;

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(stream);
    this.processorNode = this.audioContext.createScriptProcessor(1024, 1, 1);

    this.processorNode.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      const channelData = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(channelData));

      if (this.onVolume) {
        let sum = 0;
        for (let i = 0; i < channelData.length; i++) {
          sum += channelData[i] * channelData[i];
        }
        const rms = Math.sqrt(sum / channelData.length);
        this.onVolume(Math.min(1.0, rms * 5.0));
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);
    this.isRecording = true;
    this.startTime = Date.now();
  }

  /**
   * Stops recording, closes microphone, and returns encoded WAV data and metadata.
   */
  async stop() {
    this.isRecording = false;
    const durationSec = (Date.now() - this.startTime) / 1000;

    // Release audio nodes
    try {
      this.processorNode?.disconnect();
      this.sourceNode?.disconnect();
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      if (this.audioContext && this.audioContext.state !== "closed") {
        await this.audioContext.close();
      }
    } catch {
      // Ignore cleanup error
    }

    const actualSampleRate = this.audioContext?.sampleRate || 16000;

    // Concatenate chunks
    const totalLength = this.chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Float32Array(totalLength);
    let offset = 0;
    for (const c of this.chunks) {
      combined.set(c, offset);
      offset += c.length;
    }

    // Downsample to 16kHz for CAM++ speaker model
    const samples16k = downsampleTo16k(combined, actualSampleRate);

    // Encode to WAV
    const wavBuffer = encodeWav(samples16k, 16000);
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });
    const wavUrl = URL.createObjectURL(wavBlob);
    const base64Wav = arrayBufferToBase64(wavBuffer);

    return {
      samples: samples16k,
      sampleRate: 16000,
      durationSec: Math.max(0.5, durationSec),
      wavBlob,
      wavUrl,
      base64Wav,
    };
  }

  /**
   * Cancels and discards the active recording session.
   */
  cancel() {
    this.isRecording = false;
    this.chunks = [];
    try {
      this.processorNode?.disconnect();
      this.sourceNode?.disconnect();
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      if (this.audioContext && this.audioContext.state !== "closed") {
        this.audioContext.close();
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

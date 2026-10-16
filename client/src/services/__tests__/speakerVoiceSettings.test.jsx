import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { encodeWav, downsampleTo16k, arrayBufferToBase64 } from "../../utils/audioRecorder";
import { SpeakerVoiceSettings } from "../../components/settings/SpeakerVoiceSettings";

vi.mock("../../services/chatApi", () => ({
  API_BASE_URL: "http://localhost:8000",
  getAppToken: vi.fn().mockReturnValue("test-token"),
  getSpeakerStatus: vi.fn().mockResolvedValue({
    ready: true,
    enrolled_speaker: "USER",
    thresholds: { user: 0.55, unknown: 0.35 },
  }),
  getSpeakerProfile: vi.fn().mockResolvedValue({
    enrolled: true,
    speaker: "USER",
    num_samples: 3,
    avg_alignment: 0.88,
    model_name: "wespeaker_en_voxceleb_CAM++.onnx",
  }),
  updateSpeakerThresholds: vi.fn().mockResolvedValue({ status: "updated" }),
  enrollSpeakerVoice: vi.fn().mockResolvedValue({
    status: "success",
    enrolled: true,
    speaker: "USER",
    num_samples: 3,
    avg_alignment: 0.88,
    quality: "EXCELLENT",
  }),
  deleteSpeakerProfile: vi.fn().mockResolvedValue({ status: "deleted" }),
  verifySpeakerAudio: vi.fn().mockResolvedValue({
    speaker: "USER",
    score: 0.72,
    verdict: "ALLOW",
    is_user: true,
    latency_ms: 22,
  }),
}));

describe("Audio Recorder Utilities", () => {
  it("encodes Float32Array into standard 44-byte header WAV ArrayBuffer", () => {
    const samples = new Float32Array([0.0, 0.5, -0.5, 1.0, -1.0]);
    const wavBuffer = encodeWav(samples, 16000);

    expect(wavBuffer.byteLength).toBe(44 + samples.length * 2);

    const view = new DataView(wavBuffer);
    // Check RIFF header
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    expect(riff).toBe("RIFF");

    // Check WAVE header
    const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    expect(wave).toBe("WAVE");

    // Check fmt chunk
    const fmt = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
    expect(fmt).toBe("fmt ");

    // Check sample rate (16000)
    expect(view.getUint32(24, true)).toBe(16000);

    // Check data chunk
    const data = String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39));
    expect(data).toBe("data");
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it("downsamples from 48kHz to 16kHz accurately", () => {
    const input48k = new Float32Array(48000);
    for (let i = 0; i < input48k.length; i++) {
      input48k[i] = Math.sin((i / 48000) * 2 * Math.PI * 440);
    }

    const resampled = downsampleTo16k(input48k, 48000);
    expect(resampled.length).toBe(16000);
  });

  it("returns original array unchanged when already at 16kHz", () => {
    const input16k = new Float32Array(1600);
    const result = downsampleTo16k(input16k, 16000);
    expect(result).toBe(input16k);
  });

  it("converts ArrayBuffer to Base64 string", () => {
    const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // "Hello"
    const b64 = arrayBufferToBase64(buffer);
    expect(b64).toBe("SGVsbG8=");
  });
});

describe("SpeakerVoiceSettings Component", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      confirm: vi.fn().mockReturnValue(true),
      alert: vi.fn(),
      btoa: (str) => Buffer.from(str, "binary").toString("base64"),
    });
  });

  it("renders Speaker Identification section title and description", () => {
    const html = renderToStaticMarkup(<SpeakerVoiceSettings />);
    expect(html).toContain("Speaker Identification");
    expect(html).toContain("Recognize your voice so Rie responds only to you");
    expect(html).toContain("Voice Sensitivity");
  });

  it("renders sensitivity select dropdown with default value 0.50", () => {
    const html = renderToStaticMarkup(<SpeakerVoiceSettings />);
    expect(html).toContain("Normal / Balanced (0.50)");
    expect(html).toContain("Permissive (0.45)");
    expect(html).toContain("Strict (0.55)");
    expect(html).toContain("Very Strict (0.60)");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveAudioRecorder } from "../liveAudioService";

vi.mock("../chatApi", () => ({ API_BASE_URL: "http://localhost:8000", getAppToken: () => "test" }));

// Mock only browser hardware: exercise the real capture callback and PCM encoder.
describe("live microphone capture", () => {
  let recorder, processor, track, stream, context, getUserMedia, onChunk, onVolume;

  beforeEach(() => {
    processor = { connect: vi.fn(), disconnect: vi.fn() };
    track = { stop: vi.fn(), getSettings: () => ({ echoCancellation: true }) };
    stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    getUserMedia = vi.fn().mockResolvedValue(stream);
    context = {
      state: "running",
      close: vi.fn().mockResolvedValue(),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      createScriptProcessor: vi.fn(() => processor),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
      destination: {},
    };
    vi.stubGlobal("navigator", { mediaDevices: {
      getSupportedConstraints: () => ({ echoCancellation: true }), getUserMedia,
    } });
    vi.stubGlobal("window", {
      AudioContext: vi.fn(function () { return context; }),
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    });
    recorder = new LiveAudioRecorder();
    onChunk = vi.fn();
    onVolume = vi.fn();
  });

  afterEach(() => {
    recorder.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function capture(samples) {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  }

  function pcm(index = 0) {
    const bytes = Buffer.from(onChunk.mock.calls[index][0], "base64");
    return Array.from({ length: bytes.length / 2 }, (_, i) => bytes.readInt16LE(i * 2));
  }

  it("preserves quiet syllables below the old noise gate without modifying input", async () => {
    await recorder.start(onChunk, onVolume);
    const input = new Float32Array([0.001, -0.001, 0.0005, -0.0005]);
    const original = input.slice();
    capture(input);
    expect(pcm()).toEqual([32, -32, 16, -16]);
    expect(input).toEqual(original);
    expect(onVolume.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it("streams quiet word endings and silence in order for server speech detection", async () => {
    await recorder.start(onChunk, onVolume);
    for (const amplitude of [0.05, 0.01, 0.002, 0.0005, 0]) {
      capture(new Float32Array([amplitude, -amplitude]));
    }
    expect(onChunk).toHaveBeenCalledTimes(5);
    expect(pcm(2)).toEqual([65, -65]);
    expect(pcm(3)).toEqual([16, -16]);
    expect(pcm(4)).toEqual([0, 0]);
  });

  it("keeps echo cancellation and gain control while encoding mono 16kHz PCM", async () => {
    await recorder.start(onChunk, onVolume);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({
      channelCount: 1, sampleRate: 16000, echoCancellation: { exact: true },
      noiseSuppression: true, autoGainControl: true,
    }) });
    expect(window.AudioContext).toHaveBeenCalledWith({ sampleRate: 16000, latencyHint: "interactive" });
    capture(new Float32Array([-2, -1, 0, 1, 2]));
    expect(pcm()).toEqual([-32768, -32768, 0, 32767, 32767]);
  });

  it("releases hardware on mute and explicitly reacquires on unmute", async () => {
    await recorder.start(onChunk, onVolume);
    const staleCallback = processor.onaudioprocess;
    await recorder.setMuted(true);
    capture(new Float32Array([0.05]));
    expect(onChunk).not.toHaveBeenCalled();
    expect(onVolume).toHaveBeenLastCalledWith(0);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(recorder.mediaStream).toBeNull();
    expect(recorder.isRecording).toBe(false);
    const freshTrack = { ...track, stop: vi.fn() };
    const freshStream = { getTracks: () => [freshTrack], getAudioTracks: () => [freshTrack] };
    getUserMedia.mockResolvedValueOnce(freshStream);
    await recorder.setMuted(false);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(recorder.mediaStream).toBe(freshStream);
    expect(freshTrack.stop).not.toHaveBeenCalled();
    staleCallback({ inputBuffer: { getChannelData: () => new Float32Array([0.5]) } });
    expect(onChunk).not.toHaveBeenCalled();
    capture(new Float32Array([0.001]));
    expect(pcm()).toEqual([32]);
  });

  it("releases the microphone and ignores callbacks after stopping", async () => {
    await recorder.start(onChunk, onVolume);
    recorder.stop();
    capture(new Float32Array([0.05]));
    expect(onChunk).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(processor.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("releases late microphone access without starting capture after stop", async () => {
    let resolvePermission;
    getUserMedia.mockReturnValue(new Promise((resolve) => { resolvePermission = resolve; }));
    const starting = recorder.start(onChunk, onVolume);
    recorder.stop();
    resolvePermission(stream);
    await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(window.AudioContext).not.toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
  });

  it("does not request hardware when a call starts muted or unmute is called after stop", async () => {
    await recorder.setMuted(true);
    await recorder.start(onChunk, onVolume);
    expect(getUserMedia).not.toHaveBeenCalled();
    recorder.stop();
    await recorder.setMuted(false);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops a late permission grant after mute", async () => {
    let resolvePermission;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { resolvePermission = resolve; }));
    const starting = recorder.start(onChunk, onVolume);
    await recorder.setMuted(true);
    resolvePermission(stream);
    await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(window.AudioContext).not.toHaveBeenCalled();
    expect(recorder.mediaStream).toBeNull();
  });

  it("does not let an older permission grant replace an unmuted stream", async () => {
    let resolveOld;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const oldStart = recorder.start(onChunk, onVolume);
    await recorder.setMuted(true);
    const freshTrack = { ...track, stop: vi.fn() };
    const freshStream = { getTracks: () => [freshTrack], getAudioTracks: () => [freshTrack] };
    getUserMedia.mockResolvedValueOnce(freshStream);
    await recorder.setMuted(false);
    resolveOld(stream);
    await oldStart;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(freshTrack.stop).not.toHaveBeenCalled();
    expect(recorder.mediaStream).toBe(freshStream);
    expect(recorder.isRecording).toBe(true);
  });

  it("deduplicates pending acquisition and handles mute/unmute/mute", async () => {
    let resolvePermission;
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => { resolvePermission = resolve; }));
    const starting = recorder.start(onChunk, onVolume);
    const duplicate = recorder.setMuted(false);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await recorder.setMuted(true);
    resolvePermission(stream);
    await Promise.all([starting, duplicate]);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder.isRecording).toBe(false);
    expect(recorder.isMuted).toBe(true);
  });

  it("cleans up tracks if audio initialization fails on unmute", async () => {
    await recorder.start(onChunk, onVolume);
    await recorder.setMuted(true);
    window.AudioContext.mockImplementationOnce(function () { throw new Error("Audio device unavailable"); });
    await expect(recorder.setMuted(false)).rejects.toThrow("Audio device unavailable");
    expect(track.stop).toHaveBeenCalledTimes(2);
    expect(recorder.mediaStream).toBeNull();
    expect(recorder.isRecording).toBe(false);
  });

  it("ignores rejected obsolete microphone requests after mute", async () => {
    let rejectPermission;
    getUserMedia.mockReturnValueOnce(new Promise((_, reject) => { rejectPermission = reject; }));
    const starting = recorder.start(onChunk, onVolume);
    await recorder.setMuted(true);
    rejectPermission(new Error("Permission cancelled"));
    await expect(starting).resolves.toBeUndefined();
    expect(recorder.mediaStream).toBeNull();
  });

  it("releases a suspended context immediately when muted before resume finishes", async () => {
    let finishResume;
    context.state = "suspended";
    context.resume = vi.fn(() => new Promise((resolve) => { finishResume = resolve; }));
    const starting = recorder.start(onChunk, onVolume);
    await vi.waitFor(() => expect(context.resume).toHaveBeenCalled());
    await recorder.setMuted(true);
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    finishResume();
    await starting;
    expect(recorder.isRecording).toBe(false);
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWakeWordEnabled, WakeWordService } from "../wakeWordService";

const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

describe("wake-word microphone ownership", () => {
  let service, onWake, onStatus, unsubscribe, wake;
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockReset().mockResolvedValue();
    unsubscribe = vi.fn();
    listen.mockReset().mockImplementation(async (_, callback) => { wake = callback; return unsubscribe; });
    service = new WakeWordService();
    onWake = vi.fn();
    onStatus = vi.fn();
  });
  afterEach(async () => {
    await service.stop();
    vi.unstubAllGlobals();
  });

  const commands = () => invoke.mock.calls.map(([command]) => command);
  const start = () => service.start({ onWake, onStatus });

  it("keeps unloaded, omitted, disabled and invalid preferences off", async () => {
    for (const value of [undefined, null, false, "false", "", "invalid", 1]) {
      await service.configure({ enabled: isWakeWordEnabled(value), onWake });
      expect(service.enabled).toBe(false);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(isWakeWordEnabled(true)).toBe(true);
    expect(isWakeWordEnabled("true")).toBe(true);
  });

  it("does not open the microphone unless enabled", async () => {
    await service.resume();
    expect(invoke).not.toHaveBeenCalled();
    await start();
    expect(commands()).toEqual(["start_native_wake_word"]);
    wake({ payload: "Hey Rie" });
    expect(onWake).toHaveBeenCalledWith("Hey Rie");
  });

  it("never resumes after the wake-word preference is disabled", async () => {
    await start();
    await service.stop();
    await service.pause();
    await service.resume();
    wake({ payload: "Hey Rie" });
    expect(commands()).toEqual(["start_native_wake_word", "stop_native_wake_word"]);
    expect(service.isListening).toBe(false);
    expect(service.enabled).toBe(false);
    expect(onWake).not.toHaveBeenCalled();
  });

  it("releases hardware on pause, without disabling the preference", async () => {
    await start();
    await service.pause();
    expect(service.isPaused).toBe(true);
    expect(service.enabled).toBe(true);
    expect(service.isNative).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await service.resume();
    expect(commands()).toEqual(["start_native_wake_word", "stop_native_wake_word", "start_native_wake_word"]);
    expect(service.isListening).toBe(true);
  });

  it("does not listen when settings are enabled or updated during a call", async () => {
    await service.configure({ enabled: true, paused: true, onWake });
    await start();
    expect(invoke).not.toHaveBeenCalled();
    await service.configure({ enabled: false, paused: true });
    await service.configure({ enabled: false, paused: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops a native start that finishes after disable", async () => {
    let finishStart;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const starting = start();
    await vi.waitFor(() => expect(commands()).toEqual(["start_native_wake_word"]));
    const stopping = service.stop();
    wake({ payload: "Hey Rie" });
    expect(onWake).not.toHaveBeenCalled();
    finishStart();
    await Promise.all([starting, stopping]);
    expect(commands()).toEqual(["start_native_wake_word", "stop_native_wake_word"]);
    expect(service.isNative).toBe(false);
    expect(service.isListening).toBe(false);
    expect(onStatus).not.toHaveBeenCalledWith("listening");
  });

  it("awaits a pending native stop before allowing microphone handoff", async () => {
    await start();
    let finishStop;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { finishStop = resolve; }));
    let released = false;
    const pausing = service.pause().then(() => { released = true; });
    await vi.waitFor(() => expect(commands()).toContain("stop_native_wake_word"));
    expect(released).toBe(false);
    wake({ payload: "Hey Rie" });
    expect(onWake).not.toHaveBeenCalled();
    finishStop();
    await pausing;
    expect(released).toBe(true);
    expect(service.isNative).toBe(false);
  });

  it("does not leak an event listener when disabled during subscription", async () => {
    let finishListen;
    listen.mockImplementationOnce(() => new Promise((resolve) => { finishListen = resolve; }));
    const starting = start();
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce());
    const stopping = service.stop();
    finishListen(unsubscribe);
    await Promise.all([starting, stopping]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("serializes rapid pause/resume/disable changes without reopening", async () => {
    await start();
    await Promise.all([service.pause(), service.resume(), service.stop(), service.resume()]);
    expect(commands()).toEqual(["start_native_wake_word", "stop_native_wake_word"]);
    expect(service.enabled).toBe(false);
  });

  it("deduplicates concurrent starts", async () => {
    await Promise.all([start(), start(), start()]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
  });

  it("cleans up an ambiguous start failure and allows a later retry", async () => {
    invoke.mockRejectedValueOnce(new Error("Native start failed"));
    await expect(start()).rejects.toThrow("Native start failed");
    expect(commands()).toEqual(["start_native_wake_word", "stop_native_wake_word"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    await start();
    expect(service.isListening).toBe(true);
  });

  it("reports stop failure and retains ownership so cleanup can be retried", async () => {
    await start();
    invoke.mockRejectedValueOnce(new Error("Native stop failed"));
    await expect(service.stop()).rejects.toThrow("Native stop failed");
    expect(service.isNative).toBe(true);
    expect(service.isListening).toBe(false);
    await service.stop();
    expect(service.isNative).toBe(false);
    expect(commands()).toEqual(["start_native_wake_word", "stop_native_wake_word", "stop_native_wake_word"]);
  });

  it("does not invoke native microphone commands outside desktop", async () => {
    vi.stubGlobal("window", {});
    expect(await start()).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("speaker-gated wake word for registered users", () => {
  let service, onWake, mockSpeakerVerification, wake;

  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockReset().mockResolvedValue();
    listen.mockReset().mockImplementation(async (_, callback) => {
      wake = callback;
      return vi.fn();
    });
    onWake = vi.fn();
    mockSpeakerVerification = {
      isUserEnrolledSync: vi.fn().mockReturnValue(true),
      isUserEnrolled: vi.fn().mockResolvedValue(true),
      verifyPCM: vi.fn(),
      clearEnrolledCache: vi.fn(),
    };
    service = new WakeWordService({ speakerVerification: mockSpeakerVerification });
  });

  afterEach(async () => {
    await service.stop();
    vi.unstubAllGlobals();
  });

  it("permits wake word when registered user speaks", async () => {
    mockSpeakerVerification.verifyPCM.mockResolvedValueOnce({
      speaker: "USER",
      score: 0.82,
      is_user: true,
      verdict: "ALLOW",
    });

    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: "base64_wav_data" } });

    expect(mockSpeakerVerification.verifyPCM).toHaveBeenCalledWith("base64_wav_data");
    expect(onWake).toHaveBeenCalledWith("hey rie");
  });

  it("blocks wake word when an unauthorized speaker speaks", async () => {
    mockSpeakerVerification.verifyPCM.mockResolvedValueOnce({
      speaker: "OTHER",
      score: 0.22,
      is_user: false,
      verdict: "DISCARD",
    });

    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: "base64_other_wav" } });

    expect(mockSpeakerVerification.verifyPCM).toHaveBeenCalledWith("base64_other_wav");
    expect(onWake).not.toHaveBeenCalled();
    expect(service.consumeTransitionAudio()).toBeNull();
  });

  it("blocks wake word when user is registered but audio is unavailable", async () => {
    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: null } });

    expect(mockSpeakerVerification.verifyPCM).not.toHaveBeenCalled();
    expect(onWake).not.toHaveBeenCalled();
    expect(service.consumeTransitionAudio()).toBeNull();
  });

  it("allows wake word unconditionally when user is NOT registered", async () => {
    mockSpeakerVerification.isUserEnrolledSync.mockReturnValue(false);
    mockSpeakerVerification.isUserEnrolled.mockResolvedValue(false);

    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: "some_audio" } });

    expect(mockSpeakerVerification.verifyPCM).not.toHaveBeenCalled();
    expect(onWake).toHaveBeenCalledWith("hey rie");
  });

  it("blocks wake word when an unknown speaker is detected", async () => {
    mockSpeakerVerification.verifyPCM.mockResolvedValueOnce({
      speaker: "UNKNOWN",
      score: 0.1,
      is_user: false,
      verdict: "DISCARD",
    });

    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: "base64_unknown_wav" } });

    expect(mockSpeakerVerification.verifyPCM).toHaveBeenCalledWith("base64_unknown_wav");
    expect(onWake).not.toHaveBeenCalled();
    expect(service.consumeTransitionAudio()).toBeNull();
  });

  it("blocks wake word and purges transition audio when speaker verification throws an error (fail-closed)", async () => {
    mockSpeakerVerification.verifyPCM.mockRejectedValueOnce(new Error("Network / inference failure"));

    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: "base64_wav" } });

    expect(onWake).not.toHaveBeenCalled();
    expect(service.consumeTransitionAudio()).toBeNull();
  });

  it("allows wake word when profile was deleted or not found (HTTP 404)", async () => {
    mockSpeakerVerification.isUserEnrolledSync.mockReturnValue(true);
    const notFoundError = new Error("Speaker verification failed [HTTP 404]: Speaker profile not found");
    notFoundError.status = 404;
    mockSpeakerVerification.verifyPCM.mockRejectedValueOnce(notFoundError);

    await service.start({ onWake });
    await wake({ payload: { text: "hey rie", audio: "base64_wav" } });

    expect(mockSpeakerVerification.clearEnrolledCache).toHaveBeenCalled();
    expect(onWake).toHaveBeenCalledWith("hey rie");
  });

  it("buffers and consumes command transition audio on pause/stop", async () => {
    invoke.mockImplementation((cmd) => {
      if (cmd === "stop_native_wake_word") {
        return Promise.resolve("mock_transition_pcm_base64");
      }
      return Promise.resolve();
    });

    await service.start({ onWake });
    await service.pause();

    const transitionAudio = service.consumeTransitionAudio();
    expect(transitionAudio).toBe("mock_transition_pcm_base64");

    // Second consumption must be null since it was consumed
    expect(service.consumeTransitionAudio()).toBeNull();
  });
});


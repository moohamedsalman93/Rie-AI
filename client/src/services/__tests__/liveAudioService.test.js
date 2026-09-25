import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveAudioRecorder, LiveAudioPlayer, LiveVoiceSession } from "../liveAudioService";
import { upsertVoiceActivity, upsertVoiceMessage } from "../../utils/voiceActivity";

vi.mock("../chatApi", () => ({ API_BASE_URL: "http://localhost:8000", getAppToken: () => "test" }));

class Socket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
  constructor() { Socket.latest = this; }
  receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe("voice session lifecycle and event flow", () => {
  let session, callbacks;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", Socket);
    vi.spyOn(LiveAudioPlayer.prototype, "init").mockImplementation(() => {});
    vi.spyOn(LiveAudioRecorder.prototype, "start").mockImplementation(function (onChunk, onVolume) {
      this.isActive = true;
      this.isRecording = !this.isMuted;
      this.onChunkCallback = onChunk;
      this.onVolumeCallback = onVolume;
      return Promise.resolve();
    });
    vi.spyOn(LiveAudioRecorder.prototype, "stop");
    vi.spyOn(LiveAudioPlayer.prototype, "close");
    callbacks = { onStatusChange: vi.fn(), onError: vi.fn(), onTranscript: vi.fn(), onToolCall: vi.fn(), onToolResult: vi.fn() };
    session = new LiveVoiceSession(callbacks);
  });
  afterEach(() => {
    session.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function connect() {
    const started = session.start();
    Socket.latest.onopen();
    Socket.latest.receive({ type: "ready" });
    await started;
  }

  it("waits for Gemini readiness before opening the microphone", async () => {
    const started = session.start();
    Socket.latest.onopen();
    expect(session.recorder.start).not.toHaveBeenCalled();
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("connecting");
    Socket.latest.receive({ type: "ready" });
    Socket.latest.receive({ type: "ready" });
    await started;
    expect(session.recorder.start).toHaveBeenCalledTimes(1);
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("listening");
  });

  it("replaces partial captions in the panel and chat without duplicate final messages", async () => {
    let activity = [], messages = [];
    callbacks.onTranscript.mockImplementation((event) => {
      activity = upsertVoiceActivity(activity, event);
      messages = upsertVoiceMessage(messages, event);
    });
    await connect();
    for (const [text, isPartial] of [["Hello", true], ["Hello there", true], ["Hello there", false]]) {
      Socket.latest.receive({ type: "transcript", id: "a1", role: "assistant", text, isPartial });
    }
    Socket.latest.receive({ type: "turn_complete" });
    expect(activity).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: "Hello there", isPartial: false });
  });

  it("matches out-of-order tool results by ID and retains args and failed results", async () => {
    let items = [];
    callbacks.onToolCall.mockImplementation((event) => { items = upsertVoiceActivity(items, event); });
    callbacks.onToolResult.mockImplementation((event) => { items = upsertVoiceActivity(items, event); });
    await connect();
    Socket.latest.receive({ type: "tool_call", id: "one", name: "browser_open", args: { url: "https://example.com" }, status: "running" });
    Socket.latest.receive({ type: "tool_call", id: "two", name: "internet_search", args: { query: "weather" }, status: "running" });
    Socket.latest.receive({ type: "tool_result", id: "two", status: "failed", result: "Error: offline" });
    expect(session.tools.size).toBe(1);
    expect(items[1]).toMatchObject({ name: "internet_search", args: { query: "weather" }, status: "failed" });
    Socket.latest.receive({ type: "tool_result", id: "one", status: "completed", result: "Opened" });
    expect(items).toHaveLength(2);
    expect(items[0].args.url).toBe("https://example.com");
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("thinking");
  });

  it("plays the search answer after a completed preamble even with the microphone muted", async () => {
    await connect();
    session.setMuted(true);
    Socket.latest.receive({ type: "tool_call", id: "search", name: "internet_search", status: "running" });
    Socket.latest.receive({ type: "turn_complete" }); // 'Searching now' is not the answer.
    Socket.latest.receive({ type: "tool_result", id: "search", status: "completed", result: "The museum opens at 9:30 AM." });
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("thinking");
    const play = vi.spyOn(session.player, "playChunk").mockImplementation(() => {
      session.player.activeNodes.push({ stop: vi.fn() });
    });
    Socket.latest.receive({ type: "audio", data: "AAAA" });
    Socket.latest.receive({ type: "transcript", id: "answer", role: "assistant", text: "The museum opens at 9:30 AM.", isPartial: false });
    expect(play).toHaveBeenCalledWith("AAAA");
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("speaking");
    expect(callbacks.onTranscript).toHaveBeenCalledWith(expect.objectContaining({ id: "answer", text: "The museum opens at 9:30 AM." }));
    expect(session.recorder.isRecording).toBe(false);
    expect(session.recorder.start).toHaveBeenCalledTimes(1);
    expect(session.player.close).not.toHaveBeenCalled();
    Socket.latest.receive({ type: "turn_complete" });
    session.player.activeNodes = [];
    session.player.onIdle();
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("listening");
    expect(session.isMuted).toBe(true);
  });

  it("retains running tools when trimming a long activity history", () => {
    const running = { id: "running", type: "tool", status: "running", name: "browser_open", args: { url: "https://example.com" } };
    const items = upsertVoiceActivity([running, { id: "old", type: "transcript", text: "Old turn" }], { id: "new", type: "transcript", text: "New turn" }, 2);
    expect(items.map((item) => item.id)).toEqual(["running", "new"]);
    expect(upsertVoiceActivity(items, { id: "running", status: "completed" }, 2)[0].args).toEqual(running.args);
  });

  it("keeps speaking status until queued audio finishes", async () => {
    await connect();
    session.player.activeNodes.push({ stop: vi.fn() });
    Socket.latest.receive({ type: "turn_complete" });
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("speaking");
    session.player.activeNodes = [];
    session.player.onIdle();
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("listening");
  });

  it("signals audio stream end on mute", async () => {
    await connect();
    session.setMuted(true);
    expect(Socket.latest.send).toHaveBeenCalledWith(JSON.stringify({ type: "audio_end" }));
    expect(session.recorder.isMuted).toBe(true);
    expect(session.recorder.isRecording).toBe(false);
    expect(session.player.close).not.toHaveBeenCalled();
    expect(Socket.latest.close).not.toHaveBeenCalled();
  });

  it("reopens the microphone on unmute without restarting the call", async () => {
    await connect();
    session.setMuted(true);
    session.setMuted(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.recorder.start).toHaveBeenCalledTimes(2);
    expect(session.recorder.isRecording).toBe(true);
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("listening");
    expect(Socket.latest.close).not.toHaveBeenCalled();
  });

  it("does not allow unmute to reopen a stopped call", async () => {
    await connect();
    session.setMuted(true);
    session.stop();
    session.setMuted(false);
    expect(session.recorder.start).toHaveBeenCalledTimes(1);
    expect(session.recorder.isActive).toBe(false);
  });

  it("reports microphone reacquisition failure instead of silently showing listening", async () => {
    await connect();
    session.setMuted(true);
    session.recorder.start.mockRejectedValueOnce(new Error("Microphone permission denied"));
    session.setMuted(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onError).toHaveBeenCalledWith("Microphone permission denied");
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("closed");
    expect(Socket.latest.close).toHaveBeenCalledOnce();
  });

  it("can complete a muted call while the original permission prompt is pending", async () => {
    let resolveMic;
    session.recorder.start.mockImplementation(() => new Promise((resolve) => { resolveMic = resolve; }));
    const starting = session.start();
    Socket.latest.receive({ type: "ready" });
    session.setMuted(true);
    await starting;
    await vi.advanceTimersByTimeAsync(20001);
    expect(callbacks.onError).not.toHaveBeenCalled();
    resolveMic();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.isMuted).toBe(true);
    expect(session.stopped).toBe(false);
  });

  it("ignores an obsolete unmute failure after the user mutes again", async () => {
    await connect();
    session.setMuted(true);
    let rejectMic;
    session.recorder.start.mockImplementationOnce(() => new Promise((_, reject) => { rejectMic = reject; }));
    session.setMuted(false);
    session.setMuted(true);
    rejectMic(new Error("Old request cancelled"));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(session.stopped).toBe(false);
    expect(session.isMuted).toBe(true);
  });

  it("cleans up on unexpected close and ignores late events", async () => {
    await connect();
    const lateMessage = Socket.latest.onmessage;
    Socket.latest.onclose();
    expect(session.recorder.stop).toHaveBeenCalled();
    expect(session.player.close).toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    lateMessage({ data: JSON.stringify({ type: "ready" }) });
    expect(session.recorder.start).toHaveBeenCalledTimes(1);
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("closed");
  });

  it("does not revive a stopped session when microphone permission resolves late", async () => {
    let resolveMic;
    session.recorder.start.mockImplementation(() => new Promise((resolve) => { resolveMic = resolve; }));
    const starting = session.start().catch((error) => error);
    Socket.latest.receive({ type: "ready" });
    session.stop();
    resolveMic();
    expect((await starting).name).toBe("AbortError");
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("closed");
    expect(session.recorder.stop).toHaveBeenCalled();
  });

  it("fails setup with a timeout and releases resources", async () => {
    const starting = session.start().catch((error) => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect((await starting).message).toContain("timed out");
    expect(session.recorder.stop).toHaveBeenCalled();
    expect(callbacks.onStatusChange).toHaveBeenLastCalledWith("closed");
  });

  it("cuts off active audio and resets queue when a text message is sent", async () => {
    await connect();
    const stopSpy = vi.spyOn(session.player, "stopImmediately");
    session.player.activeNodes.push({ stop: vi.fn() });
    session.sendTextMessage("What is the time?");
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(session.turnComplete).toBe(true);
    expect(Socket.latest.send).toHaveBeenCalledWith(JSON.stringify({ type: "text", text: "What is the time?" }));
  });
});

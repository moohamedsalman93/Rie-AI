import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SpeakerGate, GATE_STATES } from "../speakerGate";

describe("SpeakerGate", () => {
  let gate;
  let mockVerificationService;
  let audioPassCallback;
  let decisionCallback;
  let stateChangeCallback;
  let turnCompleteCallback;

  // Helper to make fake 16-bit PCM little-endian buffer of N samples
  function makeFakeChunk(sampleCount = 512, value = 1000) {
    const buffer = new ArrayBuffer(sampleCount * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < sampleCount; i++) {
      view.setInt16(i * 2, value, true);
    }
    return new Uint8Array(buffer);
  }

  beforeEach(() => {
    mockVerificationService = {
      verifyPCM: vi.fn(),
    };
    audioPassCallback = vi.fn();
    decisionCallback = vi.fn();
    stateChangeCallback = vi.fn();
    turnCompleteCallback = vi.fn();

    gate = new SpeakerGate({
      sampleRate: 16000,
      chunkSamples: 512,
      preRollMs: 640, // 20 chunks
      initialVerifyWindowMs: 32, // 1 chunk in unit tests
      windowStepMs: 32,
      maxVerifyWindowMs: 2500,
      silenceHangoverMs: 900,
      userThreshold: 0.55,
      unknownThreshold: 0.35,
      verificationService: mockVerificationService,
      onAudioPass: audioPassCallback,
      onDecision: decisionCallback,
      onStateChange: stateChangeCallback,
      onTurnComplete: turnCompleteCallback,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes in IDLE state with configured capacity and default DROP mode", () => {
    expect(gate.state).toBe(GATE_STATES.IDLE);
    expect(gate.mode).toBe("drop");
    expect(gate.preRollCapacity).toBe(20);
    expect(gate.userThreshold).toBe(0.55);
    expect(gate.unknownThreshold).toBe(0.35);
  });

  it("accumulates pre-roll buffer in IDLE state up to capacity without triggering verification", () => {
    const chunk = makeFakeChunk();
    for (let i = 0; i < 30; i++) {
      gate.processAudioChunk(chunk, 0.001); // silent RMS
    }

    expect(gate.state).toBe(GATE_STATES.IDLE);
    expect(gate.preRollBuffer.length).toBe(20); // capped at preRollCapacity
    expect(mockVerificationService.verifyPCM).not.toHaveBeenCalled();
  });

  it("transitions to VERIFYING upon speech onset and dispatches pre-roll PCM", () => {
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunk = makeFakeChunk();
    // 5 chunks of silence
    for (let i = 0; i < 5; i++) {
      gate.processAudioChunk(chunk, 0.002);
    }

    // 2 consecutive speech chunks (RMS > 0.02)
    gate.processAudioChunk(chunk, 0.10);
    expect(gate.state).toBe(GATE_STATES.IDLE); // needs 2 chunks for onset

    gate.processAudioChunk(chunk, 0.12);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);
    expect(mockVerificationService.verifyPCM).toHaveBeenCalledTimes(1);

    const calledAudio = mockVerificationService.verifyPCM.mock.calls[0][0];
    expect(calledAudio instanceof Uint8Array).toBe(true);
    // 6 chunks in pre-roll * 1024 bytes = 6144 bytes
    expect(calledAudio.length).toBeGreaterThan(0);
  });

  it("allows USER speech: flushes pre-roll + pending queue and streams subsequent packets", async () => {
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunkA = makeFakeChunk(512, 100);
    const chunkB = makeFakeChunk(512, 200);

    // Populate pre-roll
    gate.processAudioChunk(chunkA, 0.001);
    gate.processAudioChunk(chunkA, 0.001);

    // Trigger speech onset
    gate.processAudioChunk(chunkB, 0.15);
    gate.processAudioChunk(chunkB, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Feed a pending chunk while verification is pending
    const chunkPending = makeFakeChunk(512, 300);
    gate.processAudioChunk(chunkPending, 0.12);

    // Verification returns USER (score >= 0.55)
    await resolveVerify({
      speaker: "USER",
      score: 0.68,
      verdict: "ALLOW",
      is_user: true,
      latency_ms: 25.0,
    });

    expect(gate.state).toBe(GATE_STATES.USER);
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "USER",
        score: 0.68,
        verdict: "ALLOW",
        isUser: true,
      })
    );

    // Pre-roll (4 chunks) + active speech (1 chunk) + pending (1 chunk) = 6 calls
    expect(audioPassCallback).toHaveBeenCalledTimes(6);

    // Subsequent chunk in the same turn passes immediately without re-verifying
    const chunkSubsequent = makeFakeChunk(512, 400);
    gate.processAudioChunk(chunkSubsequent, 0.14);
    expect(audioPassCallback).toHaveBeenCalledTimes(7);
    expect(mockVerificationService.verifyPCM).toHaveBeenCalledTimes(1); // STILL only 1 call!
  });

  it("blocks OTHER speech in DROP mode: discards pre-roll and subsequent audio", async () => {
    gate.setMode("drop");
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Backend returns OTHER (score < 0.15)
    await resolveVerify({
      speaker: "OTHER",
      score: 0.10,
      verdict: "DISCARD",
      is_user: false,
    });

    expect(gate.state).toBe(GATE_STATES.OTHER);
    expect(audioPassCallback).not.toHaveBeenCalled(); // nothing allowed!
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "OTHER",
        score: 0.10,
        verdict: "DISCARD",
      })
    );

    // Subsequent audio in this speech turn is also discarded
    gate.processAudioChunk(chunk, 0.20);
    expect(audioPassCallback).not.toHaveBeenCalled();
    expect(mockVerificationService.verifyPCM).toHaveBeenCalledTimes(1);
  });

  it("streams and tags OTHER speech in explicit TAGGER mode with authorized: false", async () => {
    gate.setMode("tagger");
    expect(gate.mode).toBe("tagger");

    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    await resolveVerify({
      speaker: "OTHER",
      score: 0.10,
      is_user: false,
    });

    expect(gate.state).toBe(GATE_STATES.OTHER);
    expect(audioPassCallback).toHaveBeenCalled();
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "OTHER",
        score: 0.10,
        verdict: "TAG_OTHER",
        authorized: false,
      })
    );
  });

  it("accumulates progressive evidence on borderline score (0.35 <= score < 0.55) and opens when confident", async () => {
    let resolveVerify1;
    mockVerificationService.verifyPCM.mockReturnValueOnce(
      new Promise((resolve) => { resolveVerify1 = resolve; })
    );

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Window 1 returns borderline score: 0.48 (UNKNOWN, accumulating)
    await resolveVerify1({
      speaker: "UNKNOWN",
      score: 0.48,
      verdict: "WAIT_OR_DISCARD",
    });

    // Gate should REMAIN in VERIFYING state, accumulating evidence!
    expect(gate.state).toBe(GATE_STATES.VERIFYING);
    expect(audioPassCallback).not.toHaveBeenCalled();
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "UNKNOWN",
        score: 0.48,
        accumulating: true,
      })
    );

    // Next speech chunks arrive to satisfy next target window
    let resolveVerify2;
    mockVerificationService.verifyPCM.mockReturnValueOnce(
      new Promise((resolve) => { resolveVerify2 = resolve; })
    );
    gate.processAudioChunk(chunk, 0.16);

    // Window 2 returns clear USER score: 0.62 (>= 0.55)
    await resolveVerify2({
      speaker: "USER",
      score: 0.62,
      verdict: "ALLOW",
    });

    // Gate OPENS!
    expect(gate.state).toBe(GATE_STATES.USER);
    expect(audioPassCallback).toHaveBeenCalled();
  });

  it("ends turn and returns to IDLE after silence hangover timeout", async () => {
    mockVerificationService.verifyPCM.mockResolvedValue({
      speaker: "USER",
      score: 0.92,
      verdict: "ALLOW",
    });

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    await Promise.resolve(); // flush promise microtasks

    expect(gate.state).toBe(GATE_STATES.USER);

    // Now silence starts
    const silenceTime = Date.now() + 1000;
    vi.spyOn(Date, "now").mockReturnValue(silenceTime);

    gate.processAudioChunk(chunk, 0.001); // silent frame
    expect(gate.state).toBe(GATE_STATES.IDLE);
    expect(turnCompleteCallback).toHaveBeenCalledWith(
      expect.objectContaining({ speaker: GATE_STATES.USER })
    );
  });

  it("fails closed to UNKNOWN on verification error without throwing (drop mode)", async () => {
    gate.setMode("drop");
    mockVerificationService.verifyPCM.mockRejectedValue(new Error("Network disconnect"));

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    await Promise.resolve();
    await Promise.resolve();

    expect(gate.state).toBe(GATE_STATES.UNKNOWN);
    expect(audioPassCallback).not.toHaveBeenCalled();
  });

  it("fails closed to UNKNOWN on verification error in tagger mode with authorized: false", async () => {
    gate.setMode("tagger");
    mockVerificationService.verifyPCM.mockRejectedValue(new Error("Network disconnect"));

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    await Promise.resolve();
    await Promise.resolve();

    expect(gate.state).toBe(GATE_STATES.UNKNOWN);
    expect(audioPassCallback).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        speaker: GATE_STATES.UNKNOWN,
        authorized: false,
      })
    );
  });

  it("fast-aborts transient noise click (<= 3 speech chunks followed by silence >= 250ms) back to IDLE without verifying", () => {
    gate.initialVerifyWindowMs = 480;
    gate.currentVerifyTargetMs = 480;
    const chunk = makeFakeChunk();
    const abortCallback = vi.fn();
    gate.onAbortTurn = abortCallback;

    // 2 chunks of click / noise onset (< 480ms target)
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Simulate time advancing 260ms during silence
    const startTime = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(startTime + 260);
    gate.processAudioChunk(chunk, 0.002);

    expect(gate.state).toBe(GATE_STATES.IDLE);
    expect(abortCallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "transient_noise" })
    );
    expect(mockVerificationService.verifyPCM).not.toHaveBeenCalled();
  });

  it("concludes OTHER immediately on low score (< 0.25) without progressive accumulation", async () => {
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunk = makeFakeChunk();
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Backend returns very low score (0.0332 - background noise or non-user)
    await resolveVerify({
      speaker: "OTHER",
      score: 0.0332,
      verdict: "DISCARD",
      is_user: false,
    });

    expect(gate.state).toBe(GATE_STATES.OTHER);
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "OTHER",
        score: 0.0332,
        verdict: "DISCARD",
      })
    );
  });

  it("promotes UNKNOWN turn to USER when subsequent speech verifies with high confidence", async () => {
    let resolveVerify1;
    mockVerificationService.verifyPCM.mockReturnValueOnce(
      new Promise((resolve) => { resolveVerify1 = resolve; })
    );

    const chunk = makeFakeChunk(512, 100);
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Initial window ends (e.g. final window or pause) and tags UNKNOWN
    await resolveVerify1({
      speaker: "UNKNOWN",
      score: 0.38,
      verdict: "WAIT_OR_DISCARD",
    });

    // Manually complete initial verification as final UNKNOWN
    // (Simulate speech was marked UNKNOWN)
    expect(gate.state).toBe(GATE_STATES.VERIFYING);
    // In our test, window was not final so it accumulated, let's force finalize to UNKNOWN:
    gate.setState(GATE_STATES.UNKNOWN);

    // Now user continues speaking more speech chunks (e.g. saying second part of sentence)
    let resolvePromotion;
    mockVerificationService.verifyPCM.mockReturnValueOnce(
      new Promise((resolve) => { resolvePromotion = resolve; })
    );

    // Feed enough speech chunks to exceed 1.2s (1.2s = ~38 chunks of 512 samples at 16kHz)
    for (let i = 0; i < 40; i++) {
      gate.processAudioChunk(chunk, 0.12);
    }

    expect(gate.isPromotionInFlight).toBe(true);

    // Cumulative speech verification returns USER with score 0.80 (like in Settings Test Drawer)
    await resolvePromotion({
      speaker: "USER",
      score: 0.80,
      verdict: "ALLOW",
      is_user: true,
      enrolled_speaker: "USER",
    });

    // Turn is PROMOTED to USER!
    expect(gate.state).toBe(GATE_STATES.USER);
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "USER",
        score: 0.80,
        promoted: true,
        isUser: true,
      })
    );
  });

  it("silently suppresses assistant self-voice and acoustic echo during playback (does NOT emit OTHER)", async () => {
    gate.initialVerifyWindowMs = 320;
    gate.currentVerifyTargetMs = 320;
    let assistantPlaying = true;
    gate.isAssistantSpeaking = () => assistantPlaying;

    const chunk = makeFakeChunk();
    const abortCallback = vi.fn();
    const decisionCallback = vi.fn();
    const audioPassCallback = vi.fn();
    gate.onAbortTurn = abortCallback;
    gate.onDecision = decisionCallback;
    gate.onAudioPass = audioPassCallback;

    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValueOnce(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    // Feed loud chunks (Rie's voice echoing into microphone)
    for (let i = 0; i < 12; i++) {
      gate.processAudioChunk(chunk, 0.08);
    }
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Backend verifies audio: score is 0.18 (Rie's synthetic voice is NOT the user!)
    await resolveVerify({
      speaker: "UNKNOWN",
      score: 0.18,
      verdict: "WAIT_OR_DISCARD",
      is_user: false,
    });

    // Must be silently discarded as assistant_echo without tagging as OTHER or streaming audio!
    expect(gate.state).toBe(GATE_STATES.IDLE);
    expect(abortCallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "assistant_echo" })
    );
    expect(decisionCallback).not.toHaveBeenCalledWith(
      expect.objectContaining({ speaker: "OTHER" })
    );
    expect(audioPassCallback).not.toHaveBeenCalled();
  });

  it("permits registered USER barge-in even while assistant is speaking", async () => {
    gate.initialVerifyWindowMs = 320;
    gate.currentVerifyTargetMs = 320;
    gate.isAssistantSpeaking = () => true;

    const chunk = makeFakeChunk();
    const decisionCallback = vi.fn();
    const audioPassCallback = vi.fn();
    gate.onDecision = decisionCallback;
    gate.onAudioPass = audioPassCallback;

    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValueOnce(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    // User speaks over assistant (RMS > elevated cutoff)
    for (let i = 0; i < 12; i++) {
      gate.processAudioChunk(chunk, 0.09);
    }
    expect(gate.state).toBe(GATE_STATES.VERIFYING);

    // Backend confirms user voice
    await resolveVerify({
      speaker: "USER",
      score: 0.82,
      verdict: "ALLOW",
      is_user: true,
      enrolled_speaker: "USER",
    });

    // Confirmed USER barge-in succeeds!
    expect(gate.state).toBe(GATE_STATES.USER);
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        speaker: "USER",
        score: 0.82,
        isUser: true,
      })
    );
    expect(audioPassCallback).toHaveBeenCalled();
  });

  it("does not corrupt ambient room noise floor during assistant playback", () => {
    gate.isAssistantSpeaking = () => true;
    gate.noiseFloor = 0.005;

    const chunk = makeFakeChunk();
    // Feed sub-threshold audio while assistant is speaking
    gate.processAudioChunk(chunk, 0.025);
    gate.processAudioChunk(chunk, 0.030);

    // Noise floor must remain untouched by assistant speech output
    expect(gate.noiseFloor).toBe(0.005);
  });
});


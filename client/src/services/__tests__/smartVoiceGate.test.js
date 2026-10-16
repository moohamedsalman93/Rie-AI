import { describe, it, expect, beforeEach, vi } from "vitest";
import { SmartVoiceGate, GATE_STATES, ADDRESS_TARGETS, ADDRESS_REASONS } from "../smartVoiceGate";

describe("SmartVoiceGate", () => {
  let gate;
  let mockVerificationService;
  let dispatchCallback;
  let decisionCallback;
  let abortCallback;

  // Helper to make fake 16-bit PCM chunk
  function makeChunk(sampleCount = 512, value = 500) {
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
    dispatchCallback = vi.fn();
    decisionCallback = vi.fn();
    abortCallback = vi.fn();

    gate = new SmartVoiceGate({
      enabled: true,
      userThreshold: 0.55,
      unknownThreshold: 0.35,
      verificationService: mockVerificationService,
      onDispatch: dispatchCallback,
      onDecision: decisionCallback,
      onAbortTurn: abortCallback,
      speakerGateOptions: {
        initialVerifyWindowMs: 32, // 1 chunk for fast unit testing
        windowStepMs: 32,
        preRollMs: 640,            // 20 chunks
      },
      addressDetectionOptions: {
        activeSessionTimeoutMs: 5000,
      },
    });
  });

  it("bypasses gate completely when disabled (feature flag false)", () => {
    const disabledGate = new SmartVoiceGate({ enabled: false, onDispatch: dispatchCallback });
    const chunk = makeChunk();

    disabledGate.processAudioChunk(chunk, 0.05);

    expect(dispatchCallback).toHaveBeenCalledTimes(1);
    expect(disabledGate.shouldDispatch()).toBe(true);
    expect(mockVerificationService.verifyPCM).not.toHaveBeenCalled();
  });

  it("blocks OTHER speaker in DROP mode: zero audio is dispatched to Gemini (Rie stays silent)", async () => {
    gate.setMode("drop");
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunk = makeChunk();

    // 2 chunks of silence in pre-roll
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.001);

    // Speech onset
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    expect(gate.speakerGate.state).toBe(GATE_STATES.VERIFYING);

    // Backend returns OTHER speaker (score 0.18)
    await resolveVerify({
      speaker: "OTHER",
      score: 0.18,
      is_user: false,
    });

    expect(gate.speakerGate.state).toBe(GATE_STATES.OTHER);
    expect(gate.shouldDispatch()).toBe(false);
    expect(dispatchCallback).not.toHaveBeenCalled();
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 1,
        allowed: false,
        action: "DISCARD",
        speaker: "OTHER",
      })
    );

    // Subsequent audio in this speech turn is also blocked
    gate.processAudioChunk(chunk, 0.20);
    expect(dispatchCallback).not.toHaveBeenCalled();
  });

  it("defaults to DROP mode: zero audio is dispatched to Gemini when non-user speaks", async () => {
    // Note: no gate.setMode("drop") called here! Verifying default behavior!
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    const chunk = makeChunk();
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    await resolveVerify({
      speaker: "OTHER",
      score: 0.20,
      is_user: false,
    });

    expect(gate.speakerGate.state).toBe(GATE_STATES.OTHER);
    expect(gate.shouldDispatch()).toBe(false);
    expect(dispatchCallback).not.toHaveBeenCalled();
  });

  it("allows USER speech: flushes pre-roll (640ms intact) and streams subsequent chunks to Gemini", async () => {
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    gate.startSession(); // Active session

    const chunkA = makeChunk(512, 100);
    const chunkB = makeChunk(512, 200);

    // Pre-roll audio
    gate.processAudioChunk(chunkA, 0.001);
    gate.processAudioChunk(chunkA, 0.001);

    // Speech onset ("Hey Rie...")
    gate.processAudioChunk(chunkB, 0.14);
    gate.processAudioChunk(chunkB, 0.16);

    // Verification returns USER (score 0.79)
    await resolveVerify({
      speaker: "USER",
      score: 0.79,
      is_user: true,
    });

    expect(gate.speakerGate.state).toBe(GATE_STATES.USER);
    expect(gate.shouldDispatch()).toBe(true);

    // Pre-roll (4 chunks) + active speech (1 chunk) = 5 dispatched
    expect(dispatchCallback).toHaveBeenCalledTimes(5);
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 2,
        allowed: true,
        action: "DISPATCH",
        speaker: "USER",
        addressedTo: ADDRESS_TARGETS.RIE,
      })
    );

    // Subsequent chunk in the turn streams through with zero delay
    const chunkStream = makeChunk(512, 300);
    gate.processAudioChunk(chunkStream, 0.15);
    expect(dispatchCallback).toHaveBeenCalledTimes(6);
  });

  it("handles turn follow-up without wake word during active session", async () => {
    gate.startSession();
    gate.recordAssistantTurn(); // Rie just finished speaking

    mockVerificationService.verifyPCM.mockResolvedValue({
      speaker: "USER",
      score: 0.85,
      is_user: true,
    });

    const chunk = makeChunk();
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    await Promise.resolve();

    expect(gate.shouldDispatch()).toBe(true);
    expect(dispatchCallback).toHaveBeenCalled();
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 2,
        action: "DISPATCH",
        reason: ADDRESS_REASONS.ACTIVE_SESSION,
      })
    );
  });

  it("aborts in-flight response when user turns to someone else ('John, can you open VS Code?')", () => {
    gate.startSession();
    gate.isDispatching = true;

    // Transcript arrives from STT
    gate.handleUserTranscript("John, can you open VS Code?");

    expect(gate.isDispatching).toBe(false);
    expect(abortCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DISCARD",
        target: "John",
        reason: ADDRESS_REASONS.EXPLICIT_OTHER,
      })
    );
  });

  it("tracks diagnostic telemetry metrics correctly", async () => {
    mockVerificationService.verifyPCM.mockResolvedValueOnce({
      speaker: "OTHER",
      score: 0.12,
    });

    const chunk = makeChunk();
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    await Promise.resolve();

    const stats = gate.getStats();
    expect(stats.enabled).toBe(true);
    expect(stats.stats.otherTurnsBlocked).toBe(1);
    expect(stats.canSpeak).toBe(false);
    expect(stats.canExecuteTools).toBe(false);
  });

  it("keeps audio alive when user speaks with no transcript or wake word yet (WHO=USER score: 0.8469 -> awaiting_transcript)", async () => {
    let resolveVerify;
    mockVerificationService.verifyPCM.mockReturnValue(
      new Promise((resolve) => { resolveVerify = resolve; })
    );

    // No active session! (Session is inactive or timed out)
    const chunk = makeChunk();
    gate.processAudioChunk(chunk, 0.001);
    gate.processAudioChunk(chunk, 0.15);
    gate.processAudioChunk(chunk, 0.18);

    // Stage 1 verifies USER (score: 0.8469)
    await resolveVerify({
      speaker: "USER",
      score: 0.8469,
      is_user: true,
    });

    // Address Detector has no transcript yet ("").
    // Must NOT classify as OTHER or stay silent!
    // Must classify as UNKNOWN / awaiting_transcript and keep audio alive!
    expect(gate.shouldDispatch()).toBe(true);
    expect(gate.isDispatching).toBe(true);
    expect(dispatchCallback).toHaveBeenCalled();
    expect(decisionCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 2,
        allowed: true,
        action: "DISPATCH",
        status: "AWAITING_TRANSCRIPT",
        addressedTo: ADDRESS_TARGETS.UNKNOWN,
        reason: ADDRESS_REASONS.AWAITING_TRANSCRIPT,
      })
    );

    // Subsequent audio stream chunks continue to Gemini
    gate.processAudioChunk(chunk, 0.16);
    expect(dispatchCallback).toHaveBeenCalledTimes(5);
  });

  it("continues conversation when subsequent transcript arrives without other-address ('Can you open VS Code?')", () => {
    gate.startSession();
    gate.isDispatching = true;

    gate.handleUserTranscript("Can you open VS Code?");

    // Remains dispatching and does NOT abort
    expect(gate.isDispatching).toBe(true);
    expect(abortCallback).not.toHaveBeenCalled();
  });

  it("does not abort on partial name ' John', but aborts once ' John did you send that file?' arrives", () => {
    gate.startSession();
    gate.isDispatching = true;

    // Partial 1: " John" arrives (streaming STT onset)
    gate.handleUserTranscript(" John");
    expect(gate.isDispatching).toBe(true);
    expect(abortCallback).not.toHaveBeenCalled();

    // Partial 2: " John did" arrives
    gate.handleUserTranscript(" John did");
    expect(gate.isDispatching).toBe(true);
    expect(abortCallback).not.toHaveBeenCalled();

    // Partial 3: " John did you send that file?" arrives -> Strong evidence!
    gate.handleUserTranscript(" John did you send that file?");
    expect(gate.isDispatching).toBe(false);
    expect(abortCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DISCARD",
        target: "John",
        reason: ADDRESS_REASONS.EXPLICIT_OTHER,
      })
    );
  });

  describe("Identity Tagger Mode (Hearing vs Authority to Respond)", () => {
    it("streams OTHER audio to Gemini tagged as unauthorized (Rie hears, stays silent)", async () => {
      const taggerGate = new SmartVoiceGate({
        enabled: true,
        mode: "tagger",
        verificationService: mockVerificationService,
        onDispatch: dispatchCallback,
        onDecision: decisionCallback,
        speakerGateOptions: {
          initialVerifyWindowMs: 32,
          windowStepMs: 32,
          preRollMs: 640,
        },
      });

      let resolveVerify;
      mockVerificationService.verifyPCM.mockReturnValue(
        new Promise((resolve) => { resolveVerify = resolve; })
      );

      const chunk = makeChunk();
      taggerGate.processAudioChunk(chunk, 0.001);
      taggerGate.processAudioChunk(chunk, 0.15);
      taggerGate.processAudioChunk(chunk, 0.18);

      // Backend verifies OTHER speaker
      await resolveVerify({
        speaker: "OTHER",
        score: 0.16,
        is_user: false,
      });

      // IN TAGGER MODE: Audio IS dispatched to Gemini so Rie hears the room!
      expect(taggerGate.shouldDispatch()).toBe(true);
      expect(dispatchCallback).toHaveBeenCalled();
      expect(decisionCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 1,
          mode: "tagger",
          action: "TAG_AND_STREAM",
          allowed: false,
          authorized: false,
          canSpeak: false,
          canExecuteTools: false,
        })
      );
      // But Rie has NO authority to speak or run tools:
      expect(taggerGate.authorizationPolicy.canSpeak()).toBe(false);
      expect(taggerGate.authorizationPolicy.canExecuteTools()).toBe(false);
    });

    it("allows response when user speaks to Rie ('Rie, tell John it will rain tomorrow')", () => {
      gate.startSession();
      gate.isDispatching = true;

      // Other person speaks first (John asked about weather)
      gate.currentTurnSpeaker = "OTHER";
      gate.handleUserTranscript("What's the weather tomorrow?");
      expect(gate.authorizationPolicy.getLastThirdPartyUtterance().text).toBe("What's the weather tomorrow?");

      // User speaks to Rie
      gate.currentTurnSpeaker = "USER";
      gate.handleUserTranscript("Rie, tell John it will rain tomorrow");

      expect(gate.authorizationPolicy.canSpeak()).toBe(true);
      expect(gate.authorizationPolicy.canExecuteTools()).toBe(true);
      expect(decisionCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ALLOW_RESPONSE",
          addressedTo: "RIE",
        })
      );
    });

    it("locks turn authority (canSpeak=false, canExecuteTools=false) immediately upon speech onset before verification completes", () => {
      let onsetFired = false;
      gate.onSpeechOnset = () => { onsetFired = true; };
      mockVerificationService.verifyPCM.mockReturnValue(new Promise(() => {}));

      expect(gate.authorizationPolicy.canSpeak()).toBe(true); // Idle before turn

      const chunk = makeChunk();
      // 2 chunks of speech to trigger onset
      gate.processAudioChunk(chunk, 0.15);
      gate.processAudioChunk(chunk, 0.18);

      expect(onsetFired).toBe(true);
      expect(gate.speakerGate.state).toBe(GATE_STATES.VERIFYING);
      // Hard Response Firewall: locked until biometric authentication succeeds!
      expect(gate.authorizationPolicy.canSpeak()).toBe(false);
      expect(gate.authorizationPolicy.canExecuteTools()).toBe(false);
    });

    it("active session continuity: verifies short follow-up ('யார் யாரு?', score 0.4996) as USER instead of dropping", () => {
      gate.startSession();
      gate.addressDetector.startSession({ triggeredBy: "user_turn" });
      expect(gate.addressDetector.isSessionActive()).toBe(true);

      let verifiedSpeaker = null;
      gate.speakerGate.setDecisionCallback((decision) => {
        verifiedSpeaker = decision.speaker;
      });

      // Simulate verification result on short final turn (duration 0.9s, score 0.4996)
      const fakeSpeechChunks = [makeChunk(), makeChunk()];
      gate.speakerGate.currentTurnId = 1;
      gate.speakerGate.handleVerificationResult(
        { speaker: "USER", score: 0.4996 },
        [],
        fakeSpeechChunks,
        true // isFinal
      );

      // Thanks to activeSessionProvider + effectiveUserThreshold (0.48), short turn is verified as USER
      expect(verifiedSpeaker).toBe(GATE_STATES.USER);
    });

    it("drops turn immediately when user addresses someone else in side conversation", () => {
      gate.startSession();
      gate.currentTurnSpeaker = "USER";
      gate.isDispatching = true;

      gate.handleUserTranscript("Sarah, could you check the logs please?");
      expect(gate.isDispatching).toBe(false);
      expect(abortCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DISCARD",
          target: "Sarah",
        })
      );
    });

    it("suppresses non-speech noise transcripts ('<noise>') and aborts response immediately", () => {
      let abortedReason = null;
      gate.onAbortTurn = (abort) => {
        abortedReason = abort?.reason;
      };

      gate.startSession();
      gate.handleUserTranscript(" <noise>");

      expect(abortedReason).toBe("noise_transcript");
    });

    it("verifies user's speech (score 0.5365 at 1.73s) as USER during active session", () => {
      gate.startSession();
      gate.addressDetector.startSession({ triggeredBy: "user_turn" });
      expect(gate.addressDetector.isSessionActive()).toBe(true);

      let verifiedSpeaker = null;
      gate.speakerGate.setDecisionCallback((decision) => {
        verifiedSpeaker = decision.speaker;
      });

      const speechChunks = [makeChunk(), makeChunk(), makeChunk(), makeChunk()];
      gate.speakerGate.currentTurnId = 2;
      gate.speakerGate.handleVerificationResult(
        { speaker: "USER", score: 0.5365 },
        [],
        speechChunks,
        false // speech in progress (Window 4: 1.73s)
      );

      expect(verifiedSpeaker).toBe(GATE_STATES.USER);
    });

    it("handles turn promotion: unlocks response firewall and emits updated speaker tag when promoted", () => {
      let speakerTag = null;
      gate.setSpeakerTagCallback((tag) => {
        speakerTag = tag;
      });

      // Initially locked or UNKNOWN
      gate.handleSpeechOnset({ turnId: 5, timestamp: Date.now() });
      expect(gate.authorizationPolicy.canSpeak()).toBe(false);

      // Early decision tagged UNKNOWN (e.g. Window 1 score 0.38 at 0.9s)
      gate.handleSpeakerDecision({
        speaker: GATE_STATES.UNKNOWN,
        score: 0.3885,
        isUser: false,
      });
      expect(gate.authorizationPolicy.canSpeak()).toBe(false);
      expect(gate.currentTurnSpeaker).toBe(GATE_STATES.UNKNOWN);

      // Later in the turn, progressive promotion triggers and verifies USER with 0.80
      gate.handleSpeakerDecision({
        speaker: GATE_STATES.USER,
        score: 0.80,
        isUser: true,
        promoted: true,
        durationSec: 1.8,
      });

      // Response firewall is UNLOCKED!
      expect(gate.authorizationPolicy.canSpeak()).toBe(true);
      expect(gate.authorizationPolicy.canExecuteTools()).toBe(true);
      expect(gate.currentTurnSpeaker).toBe(GATE_STATES.USER);
      expect(speakerTag).toEqual(
        expect.objectContaining({
          speaker: GATE_STATES.USER,
          authorized: true,
          promoted: true,
        })
      );
    });

    it("suppresses acoustic echo during assistant playback (does NOT emit OTHER or abort assistant)", () => {
      let isAssistantSpeaking = true;
      gate.isAssistantSpeaking = () => isAssistantSpeaking;

      let aborted = false;
      gate.onAbortTurn = () => { aborted = true; };

      let decisionFired = null;
      gate.onDecision = (d) => { decisionFired = d; };

      // Non-user speech arrives while assistant is speaking (Rie's voice echoing into microphone)
      gate.handleSpeakerDecision({
        speaker: GATE_STATES.OTHER,
        score: 0.18,
        isUser: false,
      });

      // Must NOT abort assistant playback!
      expect(aborted).toBe(false);
      expect(gate.isDispatching).toBe(false);
      expect(gate.currentTurnSpeaker).toBe(null);
    });

    it("suppresses echo transcripts arriving while assistant is speaking", () => {
      gate.isAssistantSpeaking = () => true;
      gate.currentTurnSpeaker = "OTHER";

      let aborted = false;
      gate.onAbortTurn = () => { aborted = true; };

      // A transcript of Rie's own echoed words arrives
      gate.handleUserTranscript("Hello! How can I help you today?");

      // Must NOT treat as third-party context or abort assistant!
      expect(aborted).toBe(false);
    });
  });
});




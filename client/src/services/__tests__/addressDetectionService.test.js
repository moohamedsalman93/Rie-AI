import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AddressDetectionService,
  ADDRESS_TARGETS,
  ADDRESS_REASONS,
} from "../addressDetectionService";

describe("AddressDetectionService", () => {
  let service;

  beforeEach(() => {
    service = new AddressDetectionService({
      activeSessionTimeoutMs: 5000,
    });
  });

  describe("Rule 1: Wake word / Direct Address to Rie", () => {
    it("detects direct command: 'Rie, open VS Code.'", () => {
      const result = service.detectAddressing("Rie, open VS Code.");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
      expect(result.reason).toBe(ADDRESS_REASONS.WAKE_WORD);
    });

    it("detects conversational question: 'Okay Rie, what do you think about this?'", () => {
      const result = service.detectAddressing("Okay Rie, what do you think about this?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
      expect(result.reason).toBe(ADDRESS_REASONS.WAKE_WORD);
    });

    it("detects standard salutations: 'Hey Rie, what time is it?'", () => {
      const result = service.detectAddressing("Hey Rie, what time is it?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
      expect(result.reason).toBe(ADDRESS_REASONS.WAKE_WORD);
    });

    it("detects trailing address: 'What is the forecast for tomorrow, Rie?'", () => {
      const result = service.detectAddressing("What is the forecast for tomorrow, Rie?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.WAKE_WORD);
    });

    it("detects phonetic speech-to-text variations (Ree, Ray, Rye)", () => {
      const variants = [
        "Hey Ree, search Google",
        "Hi Ray, help me with this code",
        "Okay Rye, stop music",
      ];
      for (const phrase of variants) {
        const result = service.detectAddressing(phrase);
        expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
        expect(result.reason).toBe(ADDRESS_REASONS.WAKE_WORD);
      }
    });

    it("honors native wake-word boolean flag", () => {
      const result = service.detectAddressing({ wakeWordDetected: true });
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.confidence).toBe(1.0);
      expect(result.reason).toBe(ADDRESS_REASONS.WAKE_WORD);
    });
  });

  describe("Rule 2: Explicit Address to Another Person (Negative Filter)", () => {
    it("rejects command directed at colleague: 'John, can you open VS Code?'", () => {
      const result = service.detectAddressing("John, can you open VS Code?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("John");
    });

    it("rejects conversational address to friend: 'Sarah, look at this error'", () => {
      const result = service.detectAddressing("Sarah, look at this error");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("Sarah");
    });

    it("rejects group address: 'Guys, let us begin the meeting'", () => {
      const result = service.detectAddressing("Guys, let us begin the meeting");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
    });

    it("rejects family/title address: 'Mom, did you call me?'", () => {
      const result = service.detectAddressing("Mom, did you call me?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
    });

    it("handles subtle indirect mention: 'John, can you ask Rie about this?'", () => {
      // The person addressed is John, even though "Rie" is mentioned as a third party
      const result = service.detectAddressing("John, can you ask Rie about this?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("John");
    });

    it("rejects trailing address to someone else: 'Can you commit the changes, Alex?'", () => {
      const result = service.detectAddressing("Can you commit the changes, Alex?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("Alex");
    });
  });

  describe("Rule 3: Active Rie Conversation Turn Continuity", () => {
    it("allows follow-up without wake word during active session", () => {
      service.startSession();
      service.recordAssistantTurn();

      const result = service.detectAddressing("Can you make it blue instead?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.ACTIVE_SESSION);
      expect(result.confidence).toBe(0.85);
    });

    it("allows short confirmation replies during active session: 'Yes, please.'", () => {
      service.startSession();
      service.recordAssistantTurn();

      const result = service.detectAddressing("Yes, please.");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.ACTIVE_SESSION);
    });

    it("expires follow-up window after timeout and reverts to silence", () => {
      service.startSession();
      const initialTime = 100000;
      service.lastInteractionTime = initialTime;

      // 6 seconds later (timeout is 5000ms)
      const laterTime = initialTime + 6000;
      const result = service.detectAddressing("What should we eat?", { currentTime: laterTime });

      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.SIDE_CONVERSATION);
    });

    it("explicit vocative to someone else still overrides active session", () => {
      service.startSession();
      service.recordAssistantTurn();

      // In the middle of talking to Rie, user turns to John in the room:
      const result = service.detectAddressing("John, wait a second.");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
    });

    it("explicit other address without comma overrides active session: 'John did you send that file?'", () => {
      service.startSession();
      service.recordAssistantTurn();

      // No comma after John (streaming STT output)
      const result = service.detectAddressing("John did you send that file?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("John");
      expect(result.confidence).toBeGreaterThanOrEqual(0.95);
    });

    it("streaming stutter / repeated vocative overrides active session: 'John did John did you send that file?'", () => {
      service.startSession();
      service.recordAssistantTurn();

      const result = service.detectAddressing("John did John did you send that file?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("John");
    });

    it("imperative other address without comma overrides active session: 'Sarah look at this'", () => {
      service.startSession();
      service.recordAssistantTurn();

      const result = service.detectAddressing("Sarah look at this");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.addressedOtherTarget).toBe("Sarah");
    });

    it("holds UNKNOWN / awaiting_transcript on isolated streaming partial name: ' John'", () => {
      service.startSession();
      service.recordAssistantTurn();

      // Partial streaming name without predicate: should NOT be marked RIE active_session
      const result = service.detectAddressing(" John");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.UNKNOWN);
      expect(result.reason).toBe(ADDRESS_REASONS.AWAITING_TRANSCRIPT);
    });

    it("holds UNKNOWN / awaiting_transcript on short partial: ' John did'", () => {
      service.startSession();
      service.recordAssistantTurn();

      const result = service.detectAddressing(" John did");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.UNKNOWN);
      expect(result.reason).toBe(ADDRESS_REASONS.AWAITING_TRANSCRIPT);
    });

    it("treats follow-up command 'Can you please open terminal?' as RIE active_session", () => {
      service.startSession();
      service.recordAssistantTurn();

      const result = service.detectAddressing("Can you please open terminal?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.ACTIVE_SESSION);
    });
  });

  describe("Rule 4: Side Conversation (No Wake Word & Inactive Session)", () => {
    it("treats side talk with colleague as OTHER: 'Did you finish the slide deck?'", () => {
      const result = service.detectAddressing("Did you finish the slide deck?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.SIDE_CONVERSATION);
    });

    it("treats casual ambient chatter as OTHER: 'What time is dinner tonight?'", () => {
      const result = service.detectAddressing("What time is dinner tonight?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.SIDE_CONVERSATION);
    });
  });

  describe("Complete 2-Stage Decision Pipeline (evaluatePipeline)", () => {
    it("Scenario A: You speak to Rie ('Hey Rie, open VS Code') -> ALLOW & DISPATCH", () => {
      const speakerDecision = { speaker: "USER", score: 0.79, isUser: true };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "Hey Rie, open VS Code",
      });

      expect(pipelineVerdict.stage).toBe(2);
      expect(pipelineVerdict.passToGemini).toBe(true);
      expect(pipelineVerdict.action).toBe("DISPATCH_TO_GEMINI");
      expect(pipelineVerdict.speaker).toBe("USER");
      expect(pipelineVerdict.addressDecision.addressedTo).toBe(ADDRESS_TARGETS.RIE);
    });

    it("Scenario B: You speak to friend ('John, can you open VS Code?') -> USER identified, but STAY SILENT", () => {
      const speakerDecision = { speaker: "USER", score: 0.67, isUser: true };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "John, can you open VS Code?",
      });

      expect(pipelineVerdict.stage).toBe(2);
      expect(pipelineVerdict.passToGemini).toBe(false);
      expect(pipelineVerdict.action).toBe("STAY_SILENT");
      expect(pipelineVerdict.speaker).toBe("USER");
      expect(pipelineVerdict.addressDecision.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
    });

    it("Scenario C: Friend speaks ('Hey Rie, open VS Code') -> Blocked at Stage 1 (DISCARD)", () => {
      const speakerDecision = { speaker: "OTHER", score: 0.18, isUser: false };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "Hey Rie, open VS Code",
      });

      expect(pipelineVerdict.stage).toBe(1);
      expect(pipelineVerdict.passToGemini).toBe(false);
      expect(pipelineVerdict.action).toBe("DISCARD");
      expect(pipelineVerdict.speaker).toBe("OTHER");
      expect(pipelineVerdict.addressDecision).toBeNull();
    });

    it("Scenario D: Overlapping speech / unknown speaker -> Blocked at Stage 1 (DISCARD)", () => {
      const speakerDecision = { speaker: "UNKNOWN", score: 0.28, isUser: false };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "Rie, do something",
      });

      expect(pipelineVerdict.stage).toBe(1);
      expect(pipelineVerdict.passToGemini).toBe(false);
      expect(pipelineVerdict.action).toBe("DISCARD");
    });

    it("Scenario E: Active dialogue follow-up ('Show me the error logs') -> ALLOW & DISPATCH", () => {
      service.startSession();
      service.recordAssistantTurn();

      const speakerDecision = { speaker: "USER", score: 0.81, isUser: true };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "Show me the error logs",
      });

      expect(pipelineVerdict.stage).toBe(2);
      expect(pipelineVerdict.passToGemini).toBe(true);
      expect(pipelineVerdict.action).toBe("DISPATCH_TO_GEMINI");
      expect(pipelineVerdict.reason).toBe(ADDRESS_REASONS.ACTIVE_SESSION);
    });

    it("Scenario F: User speaks, no transcript yet ('') -> UNKNOWN (awaiting_transcript), KEEP AUDIO ALIVE", () => {
      // Inactive session, no wake word signal yet, but speaker is verified USER (score: 0.8469)
      const speakerDecision = { speaker: "USER", score: 0.8469, isUser: true };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "",
        context: { isSessionActive: false },
      });

      expect(pipelineVerdict.stage).toBe(2);
      expect(pipelineVerdict.passToGemini).toBe(true);
      expect(pipelineVerdict.action).toBe("DISPATCH_TO_GEMINI");
      expect(pipelineVerdict.status).toBe("AWAITING_TRANSCRIPT");
      expect(pipelineVerdict.addressDecision.addressedTo).toBe(ADDRESS_TARGETS.UNKNOWN);
      expect(pipelineVerdict.addressDecision.reason).toBe(ADDRESS_REASONS.AWAITING_TRANSCRIPT);
    });

    it("Scenario G: Live Voice assumed continuation -> ALLOW & DISPATCH without wake word", () => {
      const speakerDecision = { speaker: "USER", score: 0.82, isUser: true };
      const pipelineVerdict = service.evaluatePipeline({
        speakerDecision,
        transcript: "Can you open VS Code?",
        context: { assumeContinuation: true },
      });

      expect(pipelineVerdict.stage).toBe(2);
      expect(pipelineVerdict.passToGemini).toBe(true);
      expect(pipelineVerdict.action).toBe("DISPATCH_TO_GEMINI");
      expect(pipelineVerdict.addressDecision.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(pipelineVerdict.addressDecision.reason).toBe(ADDRESS_REASONS.CONTINUATION);
    });
  });

  describe("Three-State Decision Handling (No Transcript Yet)", () => {
    it("returns UNKNOWN with reason awaiting_transcript when transcript is empty and session is inactive", () => {
      const result = service.detectAddressing("", { isSessionActive: false });
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.UNKNOWN);
      expect(result.reason).toBe(ADDRESS_REASONS.AWAITING_TRANSCRIPT);
      expect(result.confidence).toBe(0.50);
      expect(result.addressedTo).not.toBe(ADDRESS_TARGETS.OTHER);
    });

    it("returns RIE with reason active_session when transcript is empty and session is active", () => {
      const result = service.detectAddressing("", { isSessionActive: true });
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.ACTIVE_SESSION);
    });
  });

  describe("Explicit Delegation to Rie (Authorizing Third-Party Responses)", () => {
    it("recognizes 'Rie, tell John it will rain tomorrow' as delegation", () => {
      const result = service.detectAddressing("Rie, tell John it will rain tomorrow");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
      expect(result.target).toBe("john");
    });

    it("recognizes 'Rie, answer him' as delegation", () => {
      const result = service.detectAddressing("Rie, answer him");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
      expect(result.target).toBe("him");
    });

    it("recognizes 'John asked about the weather. Answer him.' as delegation", () => {
      const result = service.detectAddressing("John asked about the weather. Answer him.");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
      expect(result.target).toBe("him");
    });

    it("recognizes 'Answer his question, Rie' as delegation", () => {
      const result = service.detectAddressing("Answer his question, Rie");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
    });

    it("recognizes natural delegation 'Okay right and you need to answer my nephew'", () => {
      const result = service.detectAddressing("Okay right and you need to answer my nephew");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
      expect(result.target).toBe("nephew");
    });

    it("recognizes natural delegation 'Okay he will ask some question and you have to answer his question'", () => {
      const result = service.detectAddressing("Okay he will ask some question and you have to answer his question");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
    });

    it("recognizes Tamil delegation 'ஓகே நீ அவனுக்கு பதில் சொல்ல'", () => {
      const result = service.detectAddressing("ஓகே நீ அவனுக்கு பதில் சொல்ல");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.DELEGATION);
      expect(result.isDelegated).toBe(true);
    });

    it("recognizes Tamil revocation 'அவன் பேசினாலும் நீ வந்து இன்னோர் பண்ணிடணும் ஓகே'", () => {
      const result = service.detectAddressing("அவன் பேசினாலும் நீ வந்து இன்னோர் பண்ணிடணும் ஓகே");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.REVOCATION);
      expect(result.isRevocation).toBe(true);
    });

    it("recognizes English revocation 'Ignore him'", () => {
      const result = service.detectAddressing("Ignore him");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.RIE);
      expect(result.reason).toBe(ADDRESS_REASONS.REVOCATION);
      expect(result.isRevocation).toBe(true);
    });

    it("does NOT classify non-delegation vocative ('John did you send that file?') as delegation", () => {
      const result = service.detectAddressing("John did you send that file?");
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.OTHER);
      expect(result.reason).toBe(ADDRESS_REASONS.EXPLICIT_OTHER);
      expect(result.isDelegated).toBeUndefined();
    });
  });

  describe("Non-Speech Noise Suppression", () => {
    it("classifies '<noise>' as UNKNOWN / NOISE even during active session", () => {
      const result = service.detectAddressing(" <noise>", { isSessionActive: true });
      expect(result.addressedTo).toBe(ADDRESS_TARGETS.UNKNOWN);
      expect(result.reason).toBe(ADDRESS_REASONS.NOISE);
      expect(result.isNoise).toBe(true);
    });

    it("classifies '[music]' and '<silence>' as NOISE", () => {
      expect(service.detectAddressing("[music]").reason).toBe(ADDRESS_REASONS.NOISE);
      expect(service.detectAddressing("<silence>").reason).toBe(ADDRESS_REASONS.NOISE);
      expect(service.detectAddressing("...").reason).toBe(ADDRESS_REASONS.NOISE);
    });
  });
});


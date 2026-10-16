/**
 * Stage 2: Address Detection Service for Rie-AI.
 *
 * Implements fast, low-latency conversational address detection:
 *
 *              MICROPHONE
 *                  │
 *                  ▼
 *                 VAD
 *                  │
 *                  ▼
 *         ┌─────────────────┐
 *         │  Speaker Gate   │  (Stage 1: WHO is speaking?)
 *         └────────┬────────┘
 *                  │
 *            USER / OTHER
 *                  │
 *                 USER
 *                  │
 *                  ▼
 *        ┌──────────────────┐
 *        │ Address Detector │  (Stage 2: Is user addressing Rie?)
 *        └────────┬─────────┘
 *                 │
 *           ┌─────┴─────┐
 *          RIE          OTHER
 *           │             │
 *           ▼             ▼
 *        Gemini         SILENCE
 *
 * Decision Hierarchy:
 *   1. Explicit address to another person ("John, can you open VS Code?")
 *      -> OTHER (addressedTo: "other", reason: "explicit_other", SILENCE)
 *   2. Wake word / direct address to Rie ("Hey Rie", "Rie", "Okay Rie...")
 *      -> RIE (addressedTo: "rie", reason: "wake_word", GEMINI)
 *   3. Active Rie conversation in progress (turn continuity within timeout)
 *      -> RIE (addressedTo: "rie", reason: "active_session", GEMINI)
 *   4. Otherwise (side conversation with friend, ambient talk, self-talk)
 *      -> OTHER (addressedTo: "other", reason: "side_conversation", SILENCE)
 */

export const ADDRESS_TARGETS = {
  RIE: "rie",
  OTHER: "other",
  UNKNOWN: "unknown",
};

export const ADDRESS_REASONS = {
  WAKE_WORD: "wake_word",
  ACTIVE_SESSION: "active_session",
  CONTINUATION: "continuation",
  DELEGATION: "delegation",
  REVOCATION: "revocation",
  NOISE: "noise",
  AWAITING_TRANSCRIPT: "awaiting_transcript",
  EXPLICIT_OTHER: "explicit_other",
  SIDE_CONVERSATION: "side_conversation",
  CONTEXT: "context",
  UNKNOWN: "unknown",
};

/**
 * Checks if transcript text is purely non-speech noise, acoustic markers, or punctuation:
 *   - "<noise>", "[noise]", "<silence>", "[music]", "<cough>", "(laughter)", "..."
 */
export function isNoiseOnlyTranscript(text = "") {
  if (!text || typeof text !== "string") return true;

  const stripped = text
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]+\)/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
    
  return stripped.length === 0;
}

/** Known common vocative salutations and non-Rie names for explicit "other" detection */
const COMMON_OTHER_NAMES = new Set([
  "john", "sarah", "alex", "mike", "michael", "david", "dave", "chris",
  "sam", "sammy", "anna", "emily", "jessica", "james", "robert", "tom",
  "dan", "daniel", "matt", "matthew", "luke", "mark", "paul", "steve",
  "ben", "benjamin", "rachel", "lisa", "emma", "olivia", "jack", "brian",
  "mom", "dad", "babe", "honey", "sweetheart", "darling", "bro", "dude",
  "man", "guys", "everyone", "team", "folks", "all", "sir", "ma'am",
  "boss", "friend", "pal", "buddy",
]);

/** Words that frequently start sentences or follow discourse markers but are NOT person names */
const COMMON_NON_NAME_WORDS = new Set([
  // Discourse markers & interjections
  "yes", "no", "yeah", "yep", "nope", "sure", "okay", "ok", "well",
  "please", "oh", "so", "wait", "now", "right", "alright", "look",
  "see", "anyway", "actually", "basically", "like", "ah", "um", "uh",
  "hello", "hi", "hey", "yo", "good", "thanks", "thank", "sorry",
  "pardon", "excuse", "first", "second", "next", "finally", "again",
  "true", "false", "maybe", "perhaps", "definitely", "absolutely",
  // Auxiliary & modal verbs
  "can", "could", "would", "will", "shall", "should", "may", "might", "must",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "having",
  // Pronouns & demonstratives
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "their", "our", "mine", "yours", "this", "that", "these", "those",
  // Question words
  "what", "what's", "whats", "how", "how's", "hows", "why", "when", "where", "where's", "who", "which",
  // Common action verbs & commands
  "open", "close", "launch", "start", "stop", "run", "play", "pause", "resume",
  "show", "hide", "tell", "check", "find", "search", "create", "make", "delete",
  "remove", "clear", "set", "get", "put", "switch", "turn", "help", "list",
  "write", "read", "edit", "build", "test", "commit", "push", "pull", "send",
  // Articles & prepositions & conjunctions
  "a", "an", "the", "in", "on", "at", "to", "for", "with", "by", "from", "about",
  "and", "or", "but", "if", "then", "because", "as", "just",
]);

/** Discourse markers and interjections that precede commas but are NOT person names */
const COMMON_DISCOURSE_MARKERS = COMMON_NON_NAME_WORDS;

/** Phrases / words indicating direct conversational address to a person */
const DIRECT_ADDRESS_CUES = /^(?:can\s+you|could\s+you|would\s+you|will\s+you|are\s+you|did\s+you|do\s+you|have\s+you|were\s+you|should\s+you|look|listen|wait|tell|help|check|stop|please)\b/i;

/** Adverbs and words that follow commas at the end of sentences that are NOT person names */
const COMMON_TRAILING_ADVERBS = new Set([
  "please", "too", "either", "then", "now", "again", "today", "tonight",
  "tomorrow", "instead", "though", "anyway", "already", "right", "correct",
  "okay", "ok", "well", "yet", "all", "here", "there",
]);

/** Wake word root tokens and phonetic speech-to-text variations for Rie */
const RIE_ALIASES = ["rie", "ree", "ray", "rye", "ria", "riya", "reya", "ree-ah", "ree-ay"];

/** Regex pattern matching wake phrases directed at Rie */
const RIE_WAKE_REGEX = new RegExp(
  `\\b(?:hey|hi|hello|ok|okay|yo|listen|good\\s+(?:morning|afternoon|evening))?[\\s,]*\\b(?:${RIE_ALIASES.join("|")})\\b`,
  "i"
);

/** Regex pattern matching starting address to Rie: "Rie, ...", "Okay Rie, ..." */
const RIE_STARTS_WITH_REGEX = new RegExp(
  `^(?:hey|hi|hello|ok|okay|yo|listen|good\\s+(?:morning|afternoon|evening))?[\\s,]*\\b(?:${RIE_ALIASES.join("|")})\\b`,
  "i"
);

/** Regex pattern matching trailing vocative to Rie: "..., Rie?", "..., okay Rie?" */
const RIE_ENDS_WITH_REGEX = new RegExp(
  `[\\s,]+(?:hey|hi|hello|ok|okay|yo)?[\\s,]*\\b(?:${RIE_ALIASES.join("|")})[.?!]*$`,
  "i"
);

/** Regex detecting initial vocative to someone: "<Name>, <rest of sentence>" */
const INITIAL_VOCATIVE_REGEX = /^(?:hey|hi|hello|yo|listen|excuse\s+me)?[\s,]*([A-Za-z]+)[,:]\s+(.+)$/i;

/** Regex detecting trailing vocative to someone: "<rest of sentence>, <Name>" */
const TRAILING_VOCATIVE_REGEX = /[,]\s+([A-Za-z]+)[.?!]*$/i;

export class AddressDetectionService {
  constructor(options = {}) {
    this.activeSessionTimeoutMs = options.activeSessionTimeoutMs ?? 30000;
    this.minConfidenceThreshold = options.minConfidenceThreshold ?? 0.5;
    this.highConfidenceOtherThreshold = options.highConfidenceOtherThreshold ?? 0.85;

    // Session state
    this.sessionActive = false;
    this.lastInteractionTime = 0;
    this.lastAssistantSpokeTime = 0;
    this.sessionMetadata = {};

    // Custom wake word / phonetic configuration
    this.customWakeWords = options.customWakeWords ? [...options.customWakeWords] : [];
    this.knownOtherNames = new Set(COMMON_OTHER_NAMES);
    if (options.additionalOtherNames) {
      for (const name of options.additionalOtherNames) {
        this.knownOtherNames.add(String(name).toLowerCase());
      }
    }

    // Callbacks & listeners
    this.onDecisionCallback = options.onDecision || null;
    this.onStateChangeCallback = options.onStateChange || null;

    // History tracking for debugging & diagnostics
    this.decisionHistory = [];
    this.maxHistorySize = options.maxHistorySize || 50;
  }

  /**
   * Starts or resumes an active conversation session with Rie.
   *
   * @param {object} metadata - Optional context metadata (threadId, prompt, etc.)
   */
  startSession(metadata = {}) {
    this.sessionActive = true;
    this.lastInteractionTime = Date.now();
    this.sessionMetadata = { ...metadata, startedAt: this.lastInteractionTime };
    this.onStateChangeCallback?.({ sessionActive: true, metadata: this.sessionMetadata });
  }

  /**
   * Concludes an active conversation session with Rie.
   */
  endSession() {
    this.sessionActive = false;
    this.sessionMetadata = {};
    this.onStateChangeCallback?.({ sessionActive: false });
  }

  /**
   * Records that Rie finished speaking or emitted an answer.
   * Keeps the follow-up conversational window active.
   */
  recordAssistantTurn() {
    const now = Date.now();
    this.lastAssistantSpokeTime = now;
    this.lastInteractionTime = now;
  }

  /**
   * Records user speech or interaction.
   */
  recordUserTurn() {
    this.lastInteractionTime = Date.now();
  }

  /**
   * Returns whether a conversation with Rie is currently considered active.
   *
   * @param {number} [currentTime] - Optional timestamp for testing
   * @returns {boolean}
   */
  isSessionActive(currentTime = Date.now()) {
    if (!this.sessionActive) return false;
    if (this.lastInteractionTime === 0) return true;
    const elapsed = currentTime - this.lastInteractionTime;
    return elapsed <= this.activeSessionTimeoutMs;
  }

  /**
   * Evaluates if a given name or token refers to Rie.
   *
   * @param {string} token
   * @returns {boolean}
   */
  isRieAlias(token) {
    if (!token) return false;
    const clean = token.toLowerCase().trim().replace(/[^a-z-]/g, "");
    if (RIE_ALIASES.includes(clean)) return true;
    return this.customWakeWords.some((w) => w.toLowerCase() === clean);
  }

  /**
   * Evaluates if a given token represents a known non-Rie person or title.
   *
   * @param {string} token
   * @returns {boolean}
   */
  isKnownOther(token) {
    if (!token) return false;
    const clean = token.toLowerCase().trim().replace(/[^a-z-]/g, "");
    return this.knownOtherNames.has(clean);
  }

  /**
   * Evaluates if transcript contains explicit delegation authorizing Rie to answer a third party:
   *   - "Rie, answer John" / "Rie, answer him" / "Rie, answer her"
   *   - "Rie, tell John it'll rain tomorrow" / "Rie, tell him it's going to rain"
   *   - "John asked about the weather. Answer him."
   *   - "Answer his question, Rie" / "Answer John, Rie"
   *   - "Can you answer him, Rie?"
   *
   * @param {string} trimmed
   * @returns {{ isDelegated: boolean, target: string, verb: string, instruction: string } | null}
   */
  /**
   * Checks for explicit revocation or command to ignore third parties:
   *   - "Ignore him", "Don't answer him", "Do not reply to him", "Stop answering him"
   *   - "அவன் பேசினாலும் நீ வந்து இன்னோர் பண்ணிடணும் ஓகே" ("Even if he speaks, you must ignore him, okay?")
   *   - "அவனை இக்னோர் பண்ணு", "பதில் சொல்லாத"
   *
   * @param {string} trimmed
   * @returns {{ isRevocation: boolean, target: string, instruction: string } | null}
   */
  checkRevocation(trimmed) {
    if (!trimmed) return null;
    const clean = trimmed.trim();

    // 1. Tamil revocation / ignore:
    // Matches "அவன் பேசினாலும் நீ வந்து இன்னோர் பண்ணிடணும் ஓகே", "இன்னோர் பண்ணிடு", "இக்னோர் பண்ணு", "பதில் சொல்லாத"
    const tamilRevocationMatch = clean.match(
      /(?:(?:அவன்|அவள்|அவர்|அவங்க|மருமகன்)\s+பேசினாலும்\s+.*?)?(?:இன்னோர்|இக்னோர்|இக்னொர்|இக்னோர)\s*(?:பண்ணி|பண்ணு|பண்ணிடு|பண்ணிடணும்|செய்)|பதில்\s*(?:சொல்லாத|சொல்ல\s*வேண்டாம்|பேசாத)|ரிப்ளை\s*(?:பண்ணாத|பண்ண\s*வேண்டாம்)/i
    );
    if (tamilRevocationMatch) {
      return {
        isRevocation: true,
        target: "third_party",
        instruction: clean,
      };
    }

    // 2. English revocation / ignore:
    const englishRevocationMatch = clean.match(
      /\b(?:ignore|don't\s+answer|do\s+not\s+answer|don't\s+reply(?:\s+to)?|stop\s+answering|cancel\s+(?:that|delegation)|never\s*mind)\b(?:\s+(?:my\s+[a-z]+|him|her|them|[a-z]+))?/i
    );
    if (englishRevocationMatch) {
      return {
        isRevocation: true,
        target: "third_party",
        instruction: clean,
      };
    }

    return null;
  }

  /**
   * Checks for explicit delegation to Rie:
   *   - "Rie, tell John it will rain tomorrow"
   *   - "Rie, answer him"
   *   - "John asked about the weather. Answer him."
   *   - "Answer his question, Rie" / "Answer John, Rie"
   *   - "Can you answer him, Rie?"
   *   - "Okay right and you need to answer my nephew"
   *   - "Okay he will ask some question and you have to answer his question"
   *   - "ஓகே நீ அவனுக்கு பதில் சொல்ல" / "அவனுக்கு பதில் சொல்லு"
   *
   * @param {string} trimmed
   * @returns {{ isDelegated: boolean, target: string, verb: string, instruction: string } | null}
   */
  checkDelegation(trimmed) {
    if (!trimmed) return null;
    const clean = trimmed.trim();

    // 1. Tamil delegation:
    // "ஓகே நீ அவனுக்கு பதில் சொல்ல", "அவனுக்கு பதில் சொல்லு", "பதில் சொல்லு", "மருமகனுக்கு பதில் சொல்லு"
    const tamilDelegationMatch = clean.match(
      /(?:(?:ஓகே|சரி)[\s,]+)?(?:நீ\s+)?(?:அவனுக்கு|அவளுக்கு|அவருக்கு|இவருக்கு|அவங்களுக்கு|மருமகனுக்கு|தம்பிக்கு|அவருக்கு|அவர்க்கு)?\s*(?:பதில்\s*(?:சொல்லு|சொல்ல|சொல்லுங்க|பேசு)|ரிப்ளை\s*பண்ணு)(?:\s+(.*))?/i
    );
    if (tamilDelegationMatch) {
      return {
        isDelegated: true,
        target: "nephew",
        verb: "answer",
        instruction: clean,
      };
    }

    // 2. Rie prefix + delegation action: "Rie, tell John...", "Hey Rie, answer him", "Rie, can you answer John"
    const riePrefixMatch = clean.match(
      /^(?:(?:hey|hi|hello|ok|okay)[\s,]+)?(?:rie|ree|ray|rye|ria)[\s,]+(?:can\s+you\s+)?(?:please\s+)?(tell|answer|reply\s+to|respond\s+to)\s+([A-Za-z]+)\b[.,?!]*(?:\s+(.*))?$/i
    );
    if (riePrefixMatch) {
      const verb = riePrefixMatch[1].toLowerCase();
      const target = riePrefixMatch[2].toLowerCase();
      const instruction = riePrefixMatch[3]?.trim() || "";
      return {
        isDelegated: true,
        target,
        verb,
        instruction,
      };
    }

    // 5. Reference to prior question / third-party speech + command to answer:
    // "John asked about the weather. Answer him."
    // "He asked what time it is. Answer him."
    const priorSpeechMatch = clean.match(
      /\b(?:asked|asking|wondering|said|mentioned)\b.*?\b(?:answer|tell|reply\s+to|respond\s+to)\s+(him|her|them|it|[A-Za-z]+)\b/i
    );
    if (priorSpeechMatch) {
      const target = (priorSpeechMatch[1] || "third_party").toLowerCase();
      return {
        isDelegated: true,
        target,
        verb: "answer",
        instruction: clean,
      };
    }

    // 6. Direct imperative delegation to Rie: "Answer him, Rie", "Answer John, Rie", "Answer his question"
    const imperativeDelegationMatch = clean.match(
      /^(?:please\s+)?(?:answer|reply\s+to|respond\s+to)\s+(?:him|her|them|his\s+question|her\s+question|their\s+question|([A-Za-z]+))\b(?:[,\s]+(?:rie|ree|ray|rye))?[.?!]*$/i
    );
    if (imperativeDelegationMatch) {
      const target = (imperativeDelegationMatch[1] || "third_party").toLowerCase();
      return {
        isDelegated: true,
        target,
        verb: "answer",
        instruction: clean,
      };
    }

    // 7. "Can you answer him / tell John..." (in active session or addressing Rie)
    const canYouMatch = clean.match(
      /^(?:can\s+you|could\s+you)\s+(?:please\s+)?(?:tell|answer|reply\s+to|respond\s+to)\s+([A-Za-z]+)\b(?:\s+(.*))?$/i
    );
    if (canYouMatch) {
      const target = canYouMatch[1].toLowerCase();
      if (
        !this.isRieAlias(target) &&
        (!COMMON_NON_NAME_WORDS.has(target) || ["him", "her", "them"].includes(target) || this.isKnownOther(target))
      ) {
        return {
          isDelegated: true,
          target,
          verb: "tell",
          instruction: canYouMatch[2]?.trim() || "",
        };
      }
    }

    // 8. Natural conversational delegation in English:
    // "Okay right and you need to answer my nephew"
    // "Okay he will ask some question and you have to answer his question"
    // "You have to answer his question"
    // "You need to answer my nephew"
    const naturalDelegationMatch = clean.match(
      /\b(?:(?:you\s+)?(?:need\s+to|have\s+to|must|should|want\s+you\s+to)|can\s+you|could\s+you|please)?\s*(answer|reply\s+to|respond\s+to|tell)\s+(?:to\s+)?(?:(his|her|their)\s+question|my\s+([A-Za-z]+)|(him|her|them)|([A-Za-z]+))\b/i
    );
    if (naturalDelegationMatch) {
      const verb = naturalDelegationMatch[1].toLowerCase();
      let rawTarget = naturalDelegationMatch[3] || naturalDelegationMatch[4] || naturalDelegationMatch[5] || naturalDelegationMatch[2] || "third_party";
      if (["his", "her", "their"].includes(rawTarget.toLowerCase())) {
        rawTarget = rawTarget.toLowerCase() === "her" ? "her" : (rawTarget.toLowerCase() === "their" ? "them" : "him");
      }
      const target = rawTarget.toLowerCase();
      if (!this.isRieAlias(target) && (!COMMON_NON_NAME_WORDS.has(target) || ["him", "her", "them", "nephew", "niece", "friend", "third_party"].includes(target) || this.isKnownOther(target))) {
        return {
          isDelegated: true,
          target,
          verb,
          instruction: clean,
        };
      }
    }

    return null;
  }

  /**
   * Evaluates if transcript contains an explicit vocative or address to another person.
   * Handles:
   *   - "John, did you send that file?" (with comma)
   *   - "John did you send that file?" (without comma, streaming STT)
   *   - "Hey John did you send that file?" (salutation + name)
   *   - "John did John did you send that file?" (streaming ASR repetition/stutter)
   *   - "Sarah look at this" (imperative address)
   *   - "Can you commit the changes, Alex?" (trailing vocative)
   *   - "Did you send that file John?" (trailing vocative without comma)
   *
   * @param {string} trimmed - Utterance transcript text
   * @returns {{ target: string, confidence: number, hasStrongEvidence: boolean, reason: string } | null}
   */
  checkExplicitOther(trimmed) {
    if (!trimmed) return null;

    // Utterance directly starting with Rie is addressed to Rie, not other
    if (RIE_STARTS_WITH_REGEX.test(trimmed)) {
      return null;
    }

    // Optional salutation before the name (e.g. "Hey John...", "Excuse me Sarah...")
    const salutationMatch = trimmed.match(/^(?:hey|hi|hello|yo|listen|excuse\s+me)\b[\s,]*/i);
    const textAfterSalutation = salutationMatch
      ? trimmed.slice(salutationMatch[0].length).trim()
      : trimmed;

    if (!textAfterSalutation) return null;

    const words = textAfterSalutation.split(/\s+/);
    const firstWordRaw = words[0];
    const candidateName = firstWordRaw.replace(/[,:;.?!]+$/, "");
    const candidateLower = candidateName.toLowerCase();

    // Check if candidate is Rie
    if (this.isRieAlias(candidateLower)) {
      return null;
    }

    // Check if candidate is a known non-name word (verbs, discourse markers, pronouns)
    if (COMMON_NON_NAME_WORDS.has(candidateLower)) {
      return this.checkTrailingVocativeOther(trimmed);
    }

    const hasCommaOrColon = /[,:]$/.test(firstWordRaw);
    const isKnown = this.isKnownOther(candidateLower);
    const isCapitalized = /^[A-Z][a-z]+$/.test(candidateName);

    if (isKnown || isCapitalized) {
      const remainder = textAfterSalutation.slice(firstWordRaw.length).trim();
      const remainderTokens = remainder ? remainder.split(/\s+/) : [];
      const hasDirectCue = DIRECT_ADDRESS_CUES.test(remainder);

      // Case 1: Name followed by comma or colon ("John, ...")
      if (hasCommaOrColon) {
        return {
          target: candidateName,
          confidence: remainderTokens.length > 0 ? 0.95 : 0.90,
          hasStrongEvidence: true,
          reason: ADDRESS_REASONS.EXPLICIT_OTHER,
        };
      }

      // Case 2: Streaming transcript without comma ("John did you send that file?")
      if (isKnown || (isCapitalized && hasDirectCue)) {
        // If transcript is ONLY the name with no following words (" John"):
        if (remainderTokens.length === 0) {
          return {
            target: candidateName,
            confidence: 0.60,
            hasStrongEvidence: false, // Incomplete streaming partial
            reason: ADDRESS_REASONS.AWAITING_TRANSCRIPT,
          };
        }

        // If remainder is very short (1 word without direct cue, e.g. "John did"):
        if (remainderTokens.length === 1 && !hasDirectCue) {
          return {
            target: candidateName,
            confidence: 0.70,
            hasStrongEvidence: false, // Still partial evidence
            reason: ADDRESS_REASONS.AWAITING_TRANSCRIPT,
          };
        }

        // Substantive utterance: has direct cue ("did you...", "can you...", "look at...")
        // or has at least 2 words following a known other name:
        if (hasDirectCue || remainderTokens.length >= 2) {
          return {
            target: candidateName,
            confidence: 0.95,
            hasStrongEvidence: true,
            reason: ADDRESS_REASONS.EXPLICIT_OTHER,
          };
        }
      }
    }

    // Check trailing vocative
    return this.checkTrailingVocativeOther(trimmed);
  }

  /**
   * Checks if sentence ends with a vocative to another person ("..., John?" or "... John?")
   */
  checkTrailingVocativeOther(trimmed) {
    const words = trimmed.split(/\s+/);
    if (words.length < 2) return null;

    const lastWordRaw = words[words.length - 1];
    const candidateName = lastWordRaw.replace(/[,:;.?!]+$/, "");
    const candidateLower = candidateName.toLowerCase();

    if (this.isRieAlias(candidateLower) || COMMON_NON_NAME_WORDS.has(candidateLower) || COMMON_TRAILING_ADVERBS.has(candidateLower)) {
      return null;
    }

    const hasComma = /,$/.test(words[words.length - 2]) || lastWordRaw.startsWith(",");
    const isKnown = this.isKnownOther(candidateLower);
    const isCapitalized = /^[A-Z][a-z]+$/.test(candidateName);

    if (isKnown || (isCapitalized && hasComma)) {
      if (words.length >= 2) {
        return {
          target: candidateName,
          confidence: hasComma ? 0.95 : 0.90,
          hasStrongEvidence: true,
          reason: ADDRESS_REASONS.EXPLICIT_OTHER,
        };
      }
    }

    return null;
  }

  /**
   * Primary entry point for Address Detection.
   *
   * Priority Order:
   *   1. Explicitly addressing another person ("John did you send that file?") -> OTHER (overrides active session!)
   *   2. Explicitly addressing Rie ("Hey Rie, ...") -> RIE
   *   3. Active Rie conversation turn continuity / Continuation -> RIE
   *   4. Unknown / Side conversation -> OTHER
   *
   * @param {string|object} input - Transcript string or object with { transcript, audio, wakeWordDetected, context }
   * @param {object} [contextOptions] - Optional context overrides { isSessionActive, lastInteractionTime, ... }
   * @returns {{ addressedTo: string, confidence: number, reason: string, transcript: string, matchedWakeWord?: string, addressedOtherTarget?: string, details?: object }}
   */
  detectAddressing(input, contextOptions = {}) {
    // Standardize input parameters
    let transcript = "";
    let wakeWordFlag = false;
    let explicitContext = {};

    if (typeof input === "string") {
      transcript = input;
      explicitContext = contextOptions || {};
    } else if (input && typeof input === "object") {
      transcript = input.transcript || input.text || "";
      wakeWordFlag = Boolean(input.wakeWordDetected || input.wake_word_detected || input.isWakeWord);
      explicitContext = { ...(input.context || {}), ...contextOptions };
    }

    const trimmed = transcript.trim();
    const now = explicitContext.currentTime ?? Date.now();

    // Check session active status from context override or internal state
    const sessionIsActive = explicitContext.isSessionActive !== undefined
      ? Boolean(explicitContext.isSessionActive)
      : this.isSessionActive(now);

    let decision;

    // Direct native wake-word signal (from native Sherpa-ONNX KWS)
    if (wakeWordFlag) {
      decision = {
        addressedTo: ADDRESS_TARGETS.RIE,
        confidence: 1.0,
        reason: ADDRESS_REASONS.WAKE_WORD,
        transcript: trimmed,
        matchedWakeWord: "native_signal",
      };
      return this.finalizeDecision(decision);
    }

    // Empty transcript (audio onset / awaiting transcript)
    if (!trimmed) {
      if (sessionIsActive) {
        decision = {
          addressedTo: ADDRESS_TARGETS.RIE,
          confidence: 0.85,
          reason: ADDRESS_REASONS.ACTIVE_SESSION,
          transcript: "",
        };
      } else {
        decision = {
          addressedTo: ADDRESS_TARGETS.UNKNOWN,
          confidence: 0.50,
          reason: ADDRESS_REASONS.AWAITING_TRANSCRIPT,
          transcript: "",
        };
      }
      return this.finalizeDecision(decision);
    }

    // Non-speech noise or acoustic artifacts ("<noise>", "[music]", "<silence>", punctuation only)
    if (isNoiseOnlyTranscript(trimmed)) {
      decision = {
        addressedTo: ADDRESS_TARGETS.UNKNOWN,
        confidence: 0.0,
        reason: ADDRESS_REASONS.NOISE,
        transcript: trimmed,
        isNoise: true,
      };
      return this.finalizeDecision(decision);
    }

    // -------------------------------------------------------------
    // PRIORITY 0A: Explicit Revocation / Ignore Instruction to Rie
    // User explicitly cancels delegation or tells Rie to ignore third party:
    // Examples:
    //   - "Ignore him" / "Don't answer him"
    //   - "அவன் பேசினாலும் நீ வந்து இன்னோர் பண்ணிடணும் ஓகே"
    // -------------------------------------------------------------
    const revocationMatch = this.checkRevocation(trimmed);
    if (revocationMatch) {
      decision = {
        addressedTo: ADDRESS_TARGETS.RIE,
        confidence: 0.98,
        reason: ADDRESS_REASONS.REVOCATION,
        transcript: trimmed,
        isRevocation: true,
        target: revocationMatch.target,
        details: {
          matchedRevocation: true,
          target: revocationMatch.target,
          instruction: revocationMatch.instruction,
        },
      };
      return this.finalizeDecision(decision);
    }

    // -------------------------------------------------------------
    // PRIORITY 0B: Explicit Delegation to Rie
    // User explicitly authorizes Rie to answer/tell a third party:
    // Examples:
    //   - "Rie, tell John it'll rain tomorrow."
    //   - "Rie, answer him."
    //   - "John asked about the weather. Answer him."
    //   - "Answer his question, Rie."
    //   - "Okay right and you need to answer my nephew"
    //   - "ஓகே நீ அவனுக்கு பதில் சொல்ல"
    // -------------------------------------------------------------
    const delegationMatch = this.checkDelegation(trimmed);
    if (delegationMatch) {
      decision = {
        addressedTo: ADDRESS_TARGETS.RIE,
        confidence: 0.98,
        reason: ADDRESS_REASONS.DELEGATION,
        transcript: trimmed,
        isDelegated: true,
        target: delegationMatch.target,
        details: {
          matchedDelegation: true,
          target: delegationMatch.target,
          verb: delegationMatch.verb,
          instruction: delegationMatch.instruction,
        },
      };
      return this.finalizeDecision(decision);
    }

    // -------------------------------------------------------------
    // PRIORITY 1: Explicitly addressing another person
    // MUST override active_session!
    // Examples:
    //   - "John did you send that file?"
    //   - "John, did you send that file?"
    //   - "John did John did you send that file?"
    //   - "Sarah look at this"
    //   - "Can you commit the changes, Alex?"
    // -------------------------------------------------------------
    const otherMatch = this.checkExplicitOther(trimmed);
    if (otherMatch) {
      if (otherMatch.hasStrongEvidence) {
        decision = {
          addressedTo: ADDRESS_TARGETS.OTHER,
          confidence: otherMatch.confidence,
          reason: ADDRESS_REASONS.EXPLICIT_OTHER,
          transcript: trimmed,
          addressedOtherTarget: otherMatch.target,
          details: {
            rule: "explicit_other",
            target: otherMatch.target,
          },
        };
        return this.finalizeDecision(decision);
      } else {
        // Candidate other name in partial streaming transcript without complete predicate yet (" John", " John did")
        // Return UNKNOWN / AWAITING_TRANSCRIPT so active_session does NOT falsely claim it for Rie!
        decision = {
          addressedTo: ADDRESS_TARGETS.UNKNOWN,
          confidence: otherMatch.confidence,
          reason: ADDRESS_REASONS.AWAITING_TRANSCRIPT,
          transcript: trimmed,
          addressedOtherTarget: otherMatch.target,
          details: {
            rule: "partial_vocative_other",
            target: otherMatch.target,
          },
        };
        return this.finalizeDecision(decision);
      }
    }

    // -------------------------------------------------------------
    // PRIORITY 2: Explicitly addressing Rie
    // Examples:
    //   - "Hey Rie, open VS Code."
    //   - "Rie, what's the weather?"
    //   - "Okay Rie, what do you think about this?"
    //   - "Can you check that for me, Rie?"
    // -------------------------------------------------------------
    const startsWithRie = RIE_STARTS_WITH_REGEX.test(trimmed);
    const endsWithRie = RIE_ENDS_WITH_REGEX.test(trimmed);
    const containsRie = RIE_WAKE_REGEX.test(trimmed);

    if (startsWithRie || endsWithRie || containsRie) {
      const match = trimmed.match(RIE_WAKE_REGEX);
      const matchedPhrase = match ? match[0].trim() : "rie";

      decision = {
        addressedTo: ADDRESS_TARGETS.RIE,
        confidence: startsWithRie ? 0.98 : (endsWithRie ? 0.95 : 0.90),
        reason: ADDRESS_REASONS.WAKE_WORD,
        transcript: trimmed,
        matchedWakeWord: matchedPhrase,
        details: {
          position: startsWithRie ? "prefix" : (endsWithRie ? "suffix" : "infix"),
          matchedPhrase,
        },
      };
      return this.finalizeDecision(decision);
    }

    // -------------------------------------------------------------
    // PRIORITY 3: Active Rie conversation turn continuity / Continuation
    // If the user already engaged Rie and is in an active turn,
    // or continuation is assumed during an ongoing live voice call:
    // As long as they aren't addressing someone else, it's addressed to Rie!
    // Examples:
    //   - "Can you please open terminal?"
    //   - "Can you make it blue instead?"
    //   - "Show the logs."
    // -------------------------------------------------------------
    const assumeContinuation = Boolean(explicitContext.assumeContinuation);
    if (sessionIsActive || assumeContinuation) {
      decision = {
        addressedTo: ADDRESS_TARGETS.RIE,
        confidence: 0.85,
        reason: sessionIsActive ? ADDRESS_REASONS.ACTIVE_SESSION : ADDRESS_REASONS.CONTINUATION,
        transcript: trimmed,
        details: {
          sessionActive: sessionIsActive,
          assumeContinuation,
          timeSinceLastInteraction: now - this.lastInteractionTime,
        },
      };
      return this.finalizeDecision(decision);
    }

    // -------------------------------------------------------------
    // PRIORITY 4: Otherwise -> Side conversation / ambient talk
    // No wake word, no active conversation -> Stay silent!
    // -------------------------------------------------------------
    decision = {
      addressedTo: ADDRESS_TARGETS.OTHER,
      confidence: 0.80,
      reason: ADDRESS_REASONS.SIDE_CONVERSATION,
      transcript: trimmed,
      details: {
        sessionActive: false,
      },
    };

    return this.finalizeDecision(decision);
  }

  /**
   * Finalizes decision, logs it, updates activity if addressed to Rie, and notifies listener.
   */
  finalizeDecision(decision) {
    if (decision.addressedTo === ADDRESS_TARGETS.RIE) {
      this.recordUserTurn();
    }

    // Append to diagnostic history
    this.decisionHistory.push({
      ...decision,
      timestamp: Date.now(),
    });
    if (this.decisionHistory.length > this.maxHistorySize) {
      this.decisionHistory.shift();
    }

    this.onDecisionCallback?.(decision);
    return decision;
  }

  /**
   * Evaluates the complete 2-Stage pipeline decision:
   *
   *   Stage 1: SpeakerGate (WHO is speaking? -> USER vs OTHER)
   *   Stage 2: AddressDetection (Is USER addressing Rie? -> RIE vs OTHER)
   *
   * Returns a routing verdict:
   *   - passToGemini: true (only if Stage 1 is USER AND Stage 2 is RIE)
   *   - action: "DISPATCH_TO_GEMINI" | "STAY_SILENT" | "DISCARD"
   *
   * @param {object} params
   * @param {object} params.speakerDecision - Result from SpeakerGate (e.g. { speaker: "USER", score: 0.79 })
   * @param {string|object} params.transcript - Utterance transcript or payload
   * @param {object} [params.context] - Context options
   * @returns {object} Pipeline decision object
   */
  evaluatePipeline({ speakerDecision, transcript, context = {} }) {
    const isUser = speakerDecision?.speaker === "USER" || speakerDecision?.isUser === true;

    // Stage 1 Check: If not verified as USER, fail-closed immediately!
    if (!isUser) {
      return {
        stage: 1,
        passToGemini: false,
        action: "DISCARD",
        speaker: speakerDecision?.speaker || "OTHER",
        speakerScore: speakerDecision?.score ?? 0,
        addressDecision: null,
        reason: "speaker_not_user",
      };
    }

    // Stage 2 Check: WHO=USER confirmed.
    // Address Detector = soft filter until transcript evidence exists.
    const addressDecision = this.detectAddressing(transcript, context);
    const isAddressedToRie = addressDecision.addressedTo === ADDRESS_TARGETS.RIE;

    if (isAddressedToRie) {
      return {
        stage: 2,
        passToGemini: true,
        action: "DISPATCH_TO_GEMINI",
        speaker: "USER",
        speakerScore: speakerDecision?.score ?? 1.0,
        addressDecision,
        reason: addressDecision.reason,
      };
    }

    // If awaiting transcript (empty transcript or UNKNOWN address):
    // Soft filter: Keep audio alive so STT/Gemini can produce transcript!
    if (
      addressDecision.addressedTo === ADDRESS_TARGETS.UNKNOWN ||
      addressDecision.reason === ADDRESS_REASONS.AWAITING_TRANSCRIPT
    ) {
      return {
        stage: 2,
        passToGemini: true,
        action: "DISPATCH_TO_GEMINI",
        status: "AWAITING_TRANSCRIPT",
        speaker: "USER",
        speakerScore: speakerDecision?.score ?? 1.0,
        addressDecision,
        reason: addressDecision.reason,
      };
    }

    // Transcript evidence exists and indicates OTHER (e.g. "John, can you...", or friend side conversation)
    return {
      stage: 2,
      passToGemini: false,
      action: "STAY_SILENT",
      speaker: "USER",
      speakerScore: speakerDecision?.score ?? 1.0,
      addressDecision,
      reason: addressDecision.reason,
    };
  }

  /**
   * Sets callback for address decisions.
   */
  setDecisionCallback(callback) {
    this.onDecisionCallback = callback;
  }

  /**
   * Clears diagnostic decision history.
   */
  clearHistory() {
    this.decisionHistory = [];
  }
}

export const addressDetectionService = new AddressDetectionService();

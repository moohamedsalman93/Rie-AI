/**
 * Canonical normalizer and formatter for Interactive Questions in Rie-AI.
 * Guarantees a single, normalized question structure regardless of input source
 * (backend ask_question tool, streaming chunks, or <ask_question>/<question> XML tags).
 */

/**
 * Normalizes raw question payloads into canonical structure:
 * {
 *   id: string,
 *   header: string | null,
 *   questions: [
 *     {
 *       id: string,
 *       question: string,
 *       header: string | null,
 *       options: string[],
 *       is_multi_select: boolean,
 *       allow_custom: boolean,
 *       placeholder: string | null
 *     }
 *   ]
 * }
 */
export function normalizeQuestionPayload(raw, fallbackId = null) {
  if (!raw) return null;

  let parsed = raw;

  // 1. If raw is a string, try JSON parse or extract from XML tags
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    
    // Check if wrapped in XML tag: <ask_question>...</ask_question> or <question>...</question>
    const xmlMatch = trimmed.match(/<(?:ask_question|question)[^>]*>([\s\S]*?)<\/(?:ask_question|question)>/i);
    const candidateStr = xmlMatch ? xmlMatch[1].trim() : trimmed;

    if (candidateStr.startsWith("{") || candidateStr.startsWith("[")) {
      try {
        parsed = JSON.parse(candidateStr);
      } catch {
        // Not valid JSON, treat as plain text question
        parsed = { question: candidateStr };
      }
    } else {
      parsed = { question: candidateStr };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const baseHeader = parsed.header ? String(parsed.header).trim() : null;
  const canonicalQuestions = [];

  // 2. Multi-question list format: parsed.questions = [...]
  if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
    parsed.questions.forEach((q, idx) => {
      if (!q) return;
      if (typeof q === "string") {
        if (q.trim()) {
          canonicalQuestions.push({
            id: `q_${idx}`,
            question: q.trim(),
            header: baseHeader,
            options: [],
            is_multi_select: false,
            allow_custom: true,
            placeholder: "Type custom response...",
          });
        }
        return;
      }

      const qText = String(q.question || q.title || q.text || "").trim();
      if (!qText) return;

      const qHeader = q.header ? String(q.header).trim() : baseHeader;
      const rawOptions = q.options || q.choices || [];
      const cleanedOptions = [];

      if (Array.isArray(rawOptions)) {
        rawOptions.forEach((opt) => {
          if (opt !== null && opt !== undefined) {
            const optStr = String(opt).trim();
            if (optStr) cleanedOptions.push(optStr);
          }
        });
      } else if (typeof rawOptions === "string" && rawOptions.trim()) {
        cleanedOptions.push(rawOptions.trim());
      }

      const isMulti = Boolean(q.is_multi_select || q.multi_select || q.isMultiSelect);
      const allowCustom = q.allow_custom !== undefined ? Boolean(q.allow_custom) : (q.allowCustom !== undefined ? Boolean(q.allowCustom) : true);
      const placeholder = q.placeholder ? String(q.placeholder).trim() : (allowCustom ? "Type custom response..." : null);
      const qId = String(q.id || `q_${idx}`);

      canonicalQuestions.push({
        id: qId,
        question: qText,
        header: qHeader,
        options: cleanedOptions,
        is_multi_select: isMulti,
        allow_custom: allowCustom,
        placeholder,
      });
    });
  }

  // 3. Single-question format: parsed.question = "..."
  if (canonicalQuestions.length === 0 && (parsed.question || parsed.title || parsed.text)) {
    const qText = String(parsed.question || parsed.title || parsed.text || "").trim();
    if (qText) {
      const rawOptions = parsed.options || parsed.choices || [];
      const cleanedOptions = [];

      if (Array.isArray(rawOptions)) {
        rawOptions.forEach((opt) => {
          if (opt !== null && opt !== undefined) {
            const optStr = String(opt).trim();
            if (optStr) cleanedOptions.push(optStr);
          }
        });
      } else if (typeof rawOptions === "string" && rawOptions.trim()) {
        cleanedOptions.push(rawOptions.trim());
      }

      const isMulti = Boolean(parsed.is_multi_select || parsed.multi_select || parsed.isMultiSelect);
      const allowCustom = parsed.allow_custom !== undefined ? Boolean(parsed.allow_custom) : (parsed.allowCustom !== undefined ? Boolean(parsed.allowCustom) : true);
      const placeholder = parsed.placeholder ? String(parsed.placeholder).trim() : (allowCustom ? "Type custom response..." : null);

      canonicalQuestions.push({
        id: "q_0",
        question: qText,
        header: baseHeader,
        options: cleanedOptions,
        is_multi_select: isMulti,
        allow_custom: allowCustom,
        placeholder,
      });
    }
  }

  if (canonicalQuestions.length === 0) {
    return null;
  }

  return {
    id: fallbackId || parsed.id || `q_block_${Date.now()}`,
    header: baseHeader,
    questions: canonicalQuestions,
  };
}

/**
 * Formats user answers into a clean, unambiguous message for the agent.
 * @param {Array} questions - Canonical question objects
 * @param {Object} answersMap - { [questionId]: { selected: string[], custom: string } }
 * @returns {string} Clean response text to send to LLM
 */
export function formatAnswersForAgent(questions, answersMap) {
  if (!questions || questions.length === 0) return "Confirmed";
  if (!answersMap || typeof answersMap !== "object") return "Confirmed";

  // Single question formatting
  if (questions.length === 1) {
    const q = questions[0];
    const ans = answersMap[q.id] || { selected: [], custom: "" };
    const custom = (ans.custom || "").trim();
    const selected = ans.selected || [];

    if (custom) {
      return custom;
    }
    if (selected.length > 0) {
      return selected.join(", ");
    }
    return "Confirmed";
  }

  // Multi-question formatting (e.g. 1. Kubernetes: yes (basic), 2. IaC: Terraform...)
  const lines = questions.map((q, idx) => {
    const ans = answersMap[q.id] || { selected: [], custom: "" };
    const custom = (ans.custom || "").trim();
    const selected = ans.selected || [];

    let val = "";
    if (custom) {
      val = custom;
    } else if (selected.length > 0) {
      val = selected.join(", ");
    } else {
      val = "N/A";
    }

    const label = q.header || q.question;
    return `${idx + 1}. ${label}: ${val}`;
  });

  return lines.join("\n");
}

/**
 * Formats explicit Skip action for the agent.
 * @param {Array} questions - Canonical question objects
 * @returns {string} Unambiguous skip text
 */
export function formatSkipForAgent(questions) {
  if (!questions || questions.length === 0) return "Skipped";

  if (questions.length === 1) {
    const q = questions[0];
    const label = q.header || q.question;
    return `${label}: Skipped`;
  }

  return questions
    .map((q, idx) => {
      const label = q.header || q.question;
      return `${idx + 1}. ${label}: Skipped`;
    })
    .join("\n");
}

import { normalizeQuestionPayload } from "./questionNormalizer.js";

/**
 * Parse a raw assistant message content string into blocks
 * (separating <think>...</think> and <ask_question>/<question> tags from text).
 * @param {string} content
 * @returns {Array<{type: string, text?: string, isThinking?: boolean, id?: string, data?: any, isAnswered?: boolean}>}
 */
export function parseMessageContentToBlocks(content) {
  if (!content || typeof content !== "string") return [{ type: "text", text: "" }];

  // Match <think>...</think>, <thought>...</thought>, <ask_question>...</ask_question>, and <question>...</question>
  const tagRegex = /<(?:(think(?:ing)?)|(ask_question|question))[^>]*>([\s\S]*?)<\/(?:think(?:ing)?|ask_question|question)>/gi;
  const blocks = [];
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const textBefore = content.slice(lastIndex, match.index);
    if (textBefore.trim()) {
      blocks.push({ type: "text", text: textBefore });
    }

    const isThink = Boolean(match[1]);
    const isQuestion = Boolean(match[2]);
    const innerContent = (match[3] || "").trim();

    if (isThink && innerContent) {
      blocks.push({ type: "thought", text: innerContent, isThinking: false });
    } else if (isQuestion && innerContent) {
      const normalized = normalizeQuestionPayload(innerContent, `q_tag_${match.index}`);
      if (normalized) {
        blocks.push({
          type: "question",
          id: normalized.id,
          data: normalized,
          isAnswered: false,
        });
      } else {
        blocks.push({ type: "text", text: innerContent });
      }
    }

    lastIndex = tagRegex.lastIndex;
  }

  const remaining = content.slice(lastIndex);
  if (remaining.trim() || blocks.length === 0) {
    blocks.push({ type: "text", text: remaining });
  }

  return blocks;
}

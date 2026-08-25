import { normalizeQuestionPayload } from "./questionNormalizer.js";

/**
 * Parse a raw assistant message content string into blocks
 * (separating <think>...</think> and <ask_question>/<question> tags from text).
 * @param {string} content
 * @returns {Array<{type: string, text?: string, isThinking?: boolean, id?: string, data?: any, isAnswered?: boolean}>}
 */
export function parseMessageContentToBlocks(content) {
  if (!content || typeof content !== "string") return [{ type: "text", text: "" }];

  // If content starts with an orphan closing </think> or </thought> without an opening tag,
  // wrap it with <think> at the start so the tag parser can extract it into a thought block.
  let normalizedContent = content;
  const firstCloseMatch = normalizedContent.match(/<\/(?:think(?:ing)?|thought)>/i);
  const firstOpenMatch = normalizedContent.match(/<(?:think(?:ing)?|thought)[^>]*>/i);

  if (firstCloseMatch && (!firstOpenMatch || firstCloseMatch.index < firstOpenMatch.index)) {
    normalizedContent = "<think>" + normalizedContent;
  }

  // Match <think>...</think>, <thought>...</thought>, <ask_question>...</ask_question>, and <question>...</question>
  const tagRegex = /<(?:(think(?:ing)?|thought)|(ask_question|question))[^>]*>([\s\S]*?)<\/(?:think(?:ing)?|thought|ask_question|question)>/gi;
  const blocks = [];
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(normalizedContent)) !== null) {
    const textBefore = normalizedContent.slice(lastIndex, match.index);
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

  const remaining = normalizedContent.slice(lastIndex);
  if (remaining.trim() || blocks.length === 0) {
    blocks.push({ type: "text", text: remaining });
  }

  return blocks;
}

import { initialMessages } from "../constants/appConfig";

const WELCOME_ID = initialMessages[0]?.id;

function isWelcomeBotMessage(msg) {
  if (!msg || msg.from !== "bot" || msg.id !== WELCOME_ID) return false;
  const welcomeText = initialMessages[0]?.blocks?.[0]?.text;
  const blocks = msg.blocks || [];
  if (blocks.length !== 1 || blocks[0]?.type !== "text") return false;
  return blocks[0].text === welcomeText;
}

/**
 * Messages before the clicked user message, excluding later turns.
 * The branched message itself stays in the composer only (not copied).
 * Strips the default welcome bubble when there is other history.
 */
export function sliceMessagesForBranch(messages, untilMessageId) {
  const index = messages.findIndex((m) => m.id === untilMessageId);
  if (index < 0) return null;

  let sliced = messages.slice(0, index);
  if (sliced.length > 1 && isWelcomeBotMessage(sliced[0])) {
    sliced = sliced.slice(1);
  }
  return sliced.map((m) => ({
    ...m,
    blocks: m.blocks ? m.blocks.map((b) => ({ ...b })) : undefined,
    url_previews: m.url_previews ? [...m.url_previews] : undefined,
  }));
}

function botMessageText(msg) {
  const fromBlocks = (msg.blocks || [])
    .filter((b) => b.type === "text" && b.text && b.text.trim())
    .map((b) => b.text.trim())
    .join("\n");
  return (fromBlocks || msg.text || "").trim();
}

/**
 * Map a UI message to the fork API payload.
 */
export function messageToForkPayload(msg) {
  if (msg.from === "user") {
    const content = (msg.text || "").trim();
    if (!content && !msg.image_url) return null;
    return {
      role: "user",
      content: content || "(image)",
      ...(msg.image_url ? { image_url: msg.image_url } : {}),
    };
  }

  const content = botMessageText(msg);
  if (!content) return null;
  return { role: "assistant", content };
}

export function messagesToForkPayloads(messages) {
  return messages
    .map(messageToForkPayload)
    .filter(Boolean);
}

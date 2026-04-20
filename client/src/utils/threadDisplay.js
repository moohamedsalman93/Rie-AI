export function resolveThreadTitle(thread, friendMeta, sessionsByThread = {}) {
  const rawTitle = (thread?.title || "").trim();
  const isGenericTitle = !rawTitle || rawTitle === "New Chat" || rawTitle === "Untitled Chat";
  if (!isGenericTitle) return rawTitle;
  if (friendMeta?.friendName) return friendMeta.friendName;

  const threadId = thread?.id;
  const list = sessionsByThread?.[threadId] || sessionsByThread?.[String(threadId)] || [];
  const firstUser = list.find((m) => m?.from === "user" && m?.text?.trim());
  return firstUser?.text?.slice(0, 42) || "Untitled Chat";
}

export function resolveThreadFirstMessage(thread, sessionsByThread = {}) {
  const threadId = thread?.id;
  const list = sessionsByThread?.[threadId] || sessionsByThread?.[String(threadId)] || [];
  const firstUser = list.find((m) => m?.from === "user" && m?.text?.trim());
  if (firstUser?.text) return firstUser.text.slice(0, 42);
  if (thread?.first_user_message?.trim()) return thread.first_user_message.trim().slice(0, 42);
  if (thread?.first_message?.trim()) return thread.first_message.trim().slice(0, 42);

  const rawTitle = (thread?.title || "").trim();
  if (rawTitle && rawTitle !== "New Chat" && rawTitle !== "Untitled Chat") return rawTitle;
  return "Untitled Chat";
}

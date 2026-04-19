/**
 * Persisted last active thread id (companion to server-side /history).
 * Legacy key prefix Rie-tauri-history is kept for localStorage compatibility.
 */
const HISTORY_KEY = 'Rie-tauri-history';
const FRIEND_THREAD_META_KEY = `${HISTORY_KEY}-friend-thread-meta`;

/**
 * Save thread ID to localStorage
 * @param {string} threadId
 */
export function saveThreadId(threadId) {
  try {
    localStorage.setItem(`${HISTORY_KEY}-thread-id`, threadId);
  } catch (error) {
    console.error('Failed to save thread ID:', error);
  }
}

/**
 * Get stored thread ID
 * @returns {string|null}
 */
export function getStoredThreadId() {
  try {
    return localStorage.getItem(`${HISTORY_KEY}-thread-id`);
  } catch (error) {
    console.error('Failed to retrieve thread ID:', error);
    return null;
  }
}

/**
 * Persist friend-chat metadata by thread id.
 * Shape: { [threadId]: { friendId, friendName, isFriendChat } }
 * @param {Record<string, {friendId: string, friendName: string, isFriendChat: boolean}>} mapping
 */
export function saveFriendThreadMeta(mapping) {
  try {
    localStorage.setItem(FRIEND_THREAD_META_KEY, JSON.stringify(mapping || {}));
  } catch (error) {
    console.error('Failed to save friend thread metadata:', error);
  }
}

/**
 * Read persisted friend-chat metadata by thread id.
 * @returns {Record<string, {friendId: string, friendName: string, isFriendChat: boolean}>}
 */
export function getFriendThreadMeta() {
  try {
    const raw = localStorage.getItem(FRIEND_THREAD_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('Failed to retrieve friend thread metadata:', error);
    return {};
  }
}

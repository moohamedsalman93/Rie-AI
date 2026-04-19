/**
 * Persisted last active thread id (companion to server-side /history).
 * Legacy key prefix Rie-tauri-history is kept for localStorage compatibility.
 */
const HISTORY_KEY = 'Rie-tauri-history';

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

/**
 * History service for managing chat message persistence
 */

const HISTORY_KEY = 'Rie-tauri-history';
const MAX_HISTORY_ITEMS = 1000; // Limit history size

/**
 * Load chat history from localStorage
 * @returns {Array} Array of message objects
 */
export function loadHistory() {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (!stored) return [];
    
    const history = JSON.parse(stored);
    // Ensure it's an array and has valid structure
    if (Array.isArray(history)) {
      return history.filter(msg => msg && msg.id && msg.from && msg.text);
    }
    return [];
  } catch (error) {
    console.error('Failed to load history:', error);
    return [];
  }
}

/**
 * Save messages to localStorage
 * @param {Array} messages - Array of message objects to save
 */
export function saveHistory(messages) {
  try {
    // Limit history size to prevent localStorage overflow
    const messagesToSave = messages.slice(-MAX_HISTORY_ITEMS);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messagesToSave));
  } catch (error) {
    console.error('Failed to save history:', error);
    // If quota exceeded, try saving fewer messages
    if (error.name === 'QuotaExceededError') {
      try {
        const reducedMessages = messages.slice(-Math.floor(MAX_HISTORY_ITEMS / 2));
        localStorage.setItem(HISTORY_KEY, JSON.stringify(reducedMessages));
      } catch (retryError) {
        console.error('Failed to save reduced history:', retryError);
      }
    }
  }
}

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
 * Clear all chat history
 */
export function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(`${HISTORY_KEY}-thread-id`);
  } catch (error) {
    console.error('Failed to clear history:', error);
  }
}

/**
 * Get history size (number of messages)
 * @returns {number} Number of messages in history
 */
export function getHistorySize() {
  const history = loadHistory();
  return history.length;
}


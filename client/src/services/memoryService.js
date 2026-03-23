/**
 * Memory service for managing conversation context
 * Handles context window management and message prioritization
 */

const MAX_CONTEXT_MESSAGES = 50; // Maximum number of messages to include in context
const CONTEXT_WINDOW_SIZE = 20; // Preferred number of recent messages to include

/**
 * Get conversation context for API requests
 * Prioritizes recent messages and limits total context size
 * @param {Array} messages - Full array of messages
 * @param {boolean} includeWelcome - Whether to include the welcome message
 * @returns {Array} Filtered array of messages for context
 */
export function getConversationContext(messages, includeWelcome = false) {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Filter out welcome message unless explicitly included
  let filteredMessages = includeWelcome 
    ? messages 
    : messages.filter(msg => msg.id !== 1);

  // If we have fewer messages than the context window, return all
  if (filteredMessages.length <= CONTEXT_WINDOW_SIZE) {
    return filteredMessages;
  }

  // Prioritize recent messages - take the last N messages
  // This ensures the assistant has context from the most recent conversation
  const recentMessages = filteredMessages.slice(-CONTEXT_WINDOW_SIZE);

  // If we're still under the max, try to include some earlier context
  if (recentMessages.length < MAX_CONTEXT_MESSAGES && filteredMessages.length > CONTEXT_WINDOW_SIZE) {
    // Include some earlier messages for better context (every Nth message)
    const earlierMessages = [];
    const step = Math.ceil((filteredMessages.length - CONTEXT_WINDOW_SIZE) / (MAX_CONTEXT_MESSAGES - CONTEXT_WINDOW_SIZE));
    
    for (let i = 0; i < filteredMessages.length - CONTEXT_WINDOW_SIZE; i += step) {
      earlierMessages.push(filteredMessages[i]);
    }

    return [...earlierMessages, ...recentMessages].slice(-MAX_CONTEXT_MESSAGES);
  }

  return recentMessages;
}

/**
 * Calculate token estimate for messages (rough approximation)
 * @param {Array} messages - Array of messages
 * @returns {number} Estimated token count
 */
export function estimateTokens(messages) {
  if (!messages || messages.length === 0) {
    return 0;
  }

  // Rough estimate: ~4 characters per token
  const totalChars = messages.reduce((sum, msg) => {
    return sum + (msg.text?.length || 0);
  }, 0);

  return Math.ceil(totalChars / 4);
}

/**
 * Check if context is getting too large
 * @param {Array} messages - Array of messages
 * @returns {boolean} True if context might be too large
 */
export function isContextTooLarge(messages) {
  const tokens = estimateTokens(messages);
  // Warn if estimated tokens exceed ~8000 (roughly 32k context window with some buffer)
  return tokens > 8000;
}


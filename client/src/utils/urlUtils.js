const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/**
 * Extract unique HTTP(S) URLs from text (max 3).
 * @param {string} text
 * @param {number} [max=3]
 * @returns {string[]}
 */
export function extractUrls(text, max = 3) {
  if (!text) return [];
  const seen = new Set();
  const urls = [];
  let match;
  const re = new RegExp(URL_PATTERN.source, URL_PATTERN.flags);
  while ((match = re.exec(text)) !== null && urls.length < max) {
    const raw = match[0].replace(/[.,;:!?)\"']+$/, "");
    if (!seen.has(raw)) {
      seen.add(raw);
      urls.push(raw);
    }
  }
  return urls;
}

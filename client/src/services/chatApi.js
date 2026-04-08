/**
 * API service for communicating with server chat backend
 */

import { getConversationContext } from "./memoryService";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:14300";

/**
 * User device local clock for the backend (avoids wrong year/day in scheduling).
 * @returns {{ client_timezone?: string, client_local_datetime_iso: string }}
 */
export function getClientDatetimePayload() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzMin);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);
  const localIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offH}:${offM}`;
  let tz;
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    tz = undefined;
  }
  return {
    client_local_datetime_iso: localIso,
    ...(tz ? { client_timezone: tz } : {}),
  };
}

/**
 * Convert frontend messages to backend format
 * @param {Array} messages - Array of message objects with {id, from, text}
 * @returns {Array} Array of message objects with {role, content}
 */
function formatMessagesForBackend(messages) {
  return messages
    .filter((msg) => msg.from !== undefined && msg.text !== undefined)
    .map((msg) => ({
      role: msg.from === "user" ? "user" : "assistant",
      content: msg.text,
    }));
}

let appToken = null;

/**
 * Set the app token for future API calls
 * @param {string} token
 */
export function setAppToken(token) {
  appToken = token;
}

/**
 * Get headers for API calls including the security token
 * @returns {Object}
 */
function getHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };
  if (appToken) {
    headers["X-Rie-App-Token"] = appToken;
  }
  return headers;
}

function pickServerErrorMessage(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.trim();
  if (typeof payload !== "object") return "";

  const candidateKeys = ["detail", "message", "error"];
  for (const key of candidateKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

async function getResponseErrorMessage(response, fallbackMessage = "Request failed") {
  let serverMessage = "";

  try {
    const jsonPayload = await response.clone().json();
    serverMessage = pickServerErrorMessage(jsonPayload);
  } catch {
    // Non-JSON responses are handled below.
  }

  if (!serverMessage) {
    try {
      const textPayload = (await response.text()).trim();
      if (textPayload) {
        serverMessage = textPayload;
      }
    } catch {
      // Ignore body read failures and use fallback.
    }
  }

  if (serverMessage) {
    return serverMessage;
  }

  const statusPart = response.status ? ` (status ${response.status})` : "";
  return `${fallbackMessage}${statusPart}`;
}

async function throwHttpError(response, fallbackMessage) {
  const message = await getResponseErrorMessage(response, fallbackMessage);
  throw new Error(message);
}

/**
 * Resume a paused chat stream with decisions
 * @param {string} threadId
 * @param {Array} decisions
 * @param {Function} onChunk
 * @param {Function} onDone
 * @param {Function} onError
 * @param {AbortSignal} [signal]
 */
export async function resumeChat(
  threadId,
  decisions,
  onChunk,
  onDone,
  onError,
  signal = null,
  isVoice = false,
  projectRoot = null,
  token = null,
  chatMode = "agent",
  speedMode = "thinking"
) {
  const payload = {
    thread_id: threadId,
    decisions: decisions,
    project_root: projectRoot,
    is_voice: isVoice,
    token: token,
    chat_mode: chatMode,
    speed_mode: speedMode,
    ...getClientDatetimePayload(),
  };

  try {
    const response = await fetch(`${API_BASE_URL}/chat/resume`, {
      method: "POST",
      headers: getHeaders(),
      signal,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await throwHttpError(response, "Failed to resume chat");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.substring(6));
            onChunk(data);
          } catch (e) {
            console.error("Error parsing SSE data", e);
          }
        }
      }
    }
    onDone();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (onError) onError(error);
    else console.error("Resume error:", error);
  }
}

/**
 * Get pending HITL action for a thread
 * @param {string} threadId
 * @returns {Promise<Object|null>}
 */
export async function getPendingAction(threadId) {
  if (!threadId) return null;
  const response = await fetch(`${API_BASE_URL}/chat/pending/${threadId}`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
      await throwHttpError(response, "Failed to fetch pending action");
  }
  return response.json();
}

/**
 * Open a streaming chat connection using POST for large payloads (like images)
 * @param {string} message
 * @param {string} threadId
 * @param {string} imageUrl
 * @param {Function} onChunk
 * @param {Function} onDone
 * @param {Function} onError
 * @param {AbortSignal} [signal]
 * @param {boolean} [isVoice=false]
 * @param {string} [projectRoot=null]
 * @param {string} [saasToken=null]
 * @param {string} [clipboardText=null]
 * @param {string} [chatMode="agent"]
 * @param {string} [speedMode="thinking"]
 */
export async function streamChat(
  message,
  threadId = null,
  imageUrl = null,
  onChunk,
  onDone,
  onError,
  signal = null,
  isVoice = false,
  projectRoot = null,
  token = null,
  clipboardText = null,
  chatMode = "agent",
  speedMode = "thinking",
  friendTarget = null
) {
  const payload = {
    message,
    thread_id: threadId,
    image_url: imageUrl,
    is_voice: isVoice,
    project_root: projectRoot,
    token: token,
    clipboard_text: clipboardText,
    chat_mode: chatMode,
    speed_mode: speedMode,
    friend_target_id: friendTarget?.id || null,
    friend_target_name: friendTarget?.name || null,
    ...getClientDatetimePayload(),
  };
  try {
    const response = await fetch(`${API_BASE_URL}/chat/stream`, {
      method: "POST",
      headers: getHeaders(),
      signal,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      await throwHttpError(response, "Failed to start chat stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.substring(6));
            onChunk(data);
          } catch (e) {
            console.error("Error parsing SSE data", e);
          }
        }
      }
    }
    onDone();
  } catch (error) {
    if (onError) onError(error);
    else console.error("Stream error:", error);
  }
}

/**
 * Check if the API is available and configured
 * @returns {Promise<{message: string, agent_configured: boolean, tavily_configured: boolean}>}
 */
export async function checkApiHealth() {
  try {
    const response = await fetch(`${API_BASE_URL}/`, {
      method: "GET",
      headers: getHeaders(),
    });

    if (!response.ok) {
      await throwHttpError(response, "Health check failed");
    }

    return await response.json();
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new Error("Unable to connect to chat API.");
    }
    throw error;
  }
}

export async function stopAgent() {
  const response = await fetch(`${API_BASE_URL}/agent/stop`, {
    method: "POST",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to stop agent");
  }

  return response.json();
}

/**
 * Send a request to cancel a running chat stream
 * @param {string} threadId
 * @returns {Promise<Object>}
 */
export async function cancelChat(threadId) {
  if (!threadId) return;
  const response = await fetch(`${API_BASE_URL}/chat/cancel`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ thread_id: threadId }),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to cancel chat");
  }
  return response.json();
}

/**
 * Get current settings (always masked)
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  const response = await fetch(`${API_BASE_URL}/settings`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to load settings");
  }
  return response.json();
}

/**
 * Update a specific setting
 * @param {string} key
 * @param {string} value
 * @returns {Promise<Object>}
 */
export async function updateSetting(key, value) {
  const response = await fetch(`${API_BASE_URL}/settings`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ key, value }),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to update setting");
  }
  return response.json();
}

export async function getConnectivityIdentity() {
  const response = await fetch(`${API_BASE_URL}/connectivity/identity`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to load connectivity identity");
  }
  return response.json();
}

export async function initPairing(name = null) {
  const response = await fetch(`${API_BASE_URL}/connectivity/pair/init`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to initialize pairing");
  }
  return response.json();
}

export async function confirmPairing(payload) {
  const response = await fetch(`${API_BASE_URL}/connectivity/pair/confirm`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to confirm pairing");
  }
  return response.json();
}

export async function getFriends() {
  const response = await fetch(`${API_BASE_URL}/connectivity/friends`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch friends");
  }
  return response.json();
}

export async function askFriend(friendId, query) {
  const response = await fetch(`${API_BASE_URL}/connectivity/friends/${encodeURIComponent(friendId)}/ask`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ friend_id: friendId, query }),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to ask friend");
  }
  return response.json();
}

export async function checkFriendStatus(friendId) {
  const response = await fetch(`${API_BASE_URL}/connectivity/friends/${encodeURIComponent(friendId)}/status`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to check friend status");
  }
  return response.json();
}

export async function getCloudflareStatus() {
  const response = await fetch(`${API_BASE_URL}/connectivity/cloudflare/status`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to get Cloudflare status");
  }
  return response.json();
}

export async function installCloudflare(tunnelToken) {
  const response = await fetch(`${API_BASE_URL}/connectivity/cloudflare/install`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ confirmed: true, tunnel_token: tunnelToken }),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to install Cloudflare");
  }
  return response.json();
}

export async function installCloudflareNamedTunnel(tunnelToken) {
  return installCloudflare(tunnelToken);
}

export async function getFriendApproval(friendId, threadId) {
  const response = await fetch(`${API_BASE_URL}/connectivity/friends/${encodeURIComponent(friendId)}/approval?thread_id=${encodeURIComponent(threadId)}`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to get friend approval");
  }
  return response.json();
}

export async function approveFriendForThread(friendId, threadId) {
  const response = await fetch(`${API_BASE_URL}/connectivity/friends/${encodeURIComponent(friendId)}/approval`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ thread_id: threadId }),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to approve friend");
  }
  return response.json();
}

/**
 * Get backend logs
 * @returns {Promise<{logs: string}>}
 */
export async function getLogs() {
  const response = await fetch(`${API_BASE_URL}/logs`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch logs");
  }
  return response.json();
}

/**
 * Download the bundled embedding model with progress.
 * @param {Function} onProgress - Callback({ progress, message, done, error }) for each progress update
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function downloadEmbeddingModel(onProgress) {
  const response = await fetch(`${API_BASE_URL}/embedding/download`, {
    method: "POST",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to start embedding download");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.substring(6));
          if (onProgress) onProgress(data);
          if (data.done) {
            return { success: !data.error, error: data.error };
          }
        } catch (e) {
          console.error("Error parsing embedding download SSE:", e);
        }
      }
    }
  }
  return { success: true };
}

/**
 * Get MCP server status and available tools
 * @returns {Promise<{configured_servers: Array, server_count: number, loaded_tools_count: number, available_tools: Array, status: string}>}
 */
export async function getMcpStatus() {
  const response = await fetch(`${API_BASE_URL}/mcp/status`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch MCP status");
  }
  return response.json();
}

/**
 * Generate instruction text for a Boss Team member using backend LLM.
 * @param {{boss_name:string, member_name:string, member_description?:string, selected_tools?:string[], style?:string, tone?:string}} payload
 * @returns {Promise<{instruction_text: string, reasoning_summary?: string}>}
 */
export async function generatePlannerInstruction(payload) {
  const response = await fetch(`${API_BASE_URL}/planner/generate-instruction`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to generate instruction");
  }
  return response.json();
}

/**
 * Get chat history threads
 * @returns {Promise<Array>}
 */
export async function getHistory() {
  const response = await fetch(`${API_BASE_URL}/history`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch history");
  }
  return response.json();
}

/**
 * Get messages for a specific thread
 * @param {string} threadId
 * @returns {Promise<Array>}
 */
export async function getThreadMessages(threadId) {
  const response = await fetch(`${API_BASE_URL}/history/${threadId}`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch messages");
  }
  return response.json();
}

/**
 * Delete a thread
 * @param {string} threadId
 * @returns {Promise<Object>}
 */
export async function deleteThread(threadId) {
  const response = await fetch(`${API_BASE_URL}/history/${threadId}`, {
    method: "DELETE",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to delete thread");
  }
  return response.json();
}

/**
 * Capture a screenshot from the backend
 * @returns {Promise<{image: string}>} - base64 encoded image string
 */
export async function getScreenshot() {
  const response = await fetch(`${API_BASE_URL}/screenshot`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to capture screenshot");
  }
  return response.json();
}

/**
 * Transcribe audio blob using the backend STT endpoint
 * @param {Blob} audioBlob
 * @returns {Promise<{text: string}>}
 */
export async function transcribeAudio(audioBlob) {
  const formData = new FormData();
  formData.append("file", audioBlob, "recording.webm");

  const headers = getHeaders();
  delete headers["Content-Type"]; // Let browser set boundary for FormData

  const response = await fetch(`${API_BASE_URL}/audio/transcribe`, {
    method: "POST",
    headers: headers,
    body: formData,
  });

  if (!response.ok) {
    await throwHttpError(response, "Transcription failed");
  }

  return response.json();
}

/**
 * Convert text to speech using the backend TTS endpoint
 * @param {string} text - The text to speak
 * @param {string} [voice] - Optional voice name (e.g. "en-US-EmmaNeural")
 * @returns {Promise<Blob>} - The audio blob
 */
export async function speakText(
  text,
  voice = "en-US-EmmaNeural",
  provider = "edge-tts"
) {
  const response = await fetch(`${API_BASE_URL}/audio/speak`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ text, voice, provider }),
  });

  if (!response.ok) {
    await throwHttpError(response, "Text-to-speech failed");
  }

  return response.blob();
}

/**
 * Fetch list of downloaded models from local Ollama instance
 * @returns {Promise<{models: Array<string>}>}
 */
export async function getOllamaModels() {
  const response = await fetch(`${API_BASE_URL}/ollama/models`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch Ollama models");
  }
  return response.json();
}

/**
 * Proxy request to Rie SaaS usage endpoint using stored token
 * @returns {Promise<Object>}
 */
export async function getRieUsage() {
  const response = await fetch(`${API_BASE_URL}/rie/usage`, {
    method: "GET",
    headers: getHeaders(),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Session expired");
    }
    await throwHttpError(response, "Failed to fetch usage");
  }
  return response.json();
}

// --- Scheduled tasks & notifications ---

/**
 * @param {Object} payload
 * @param {string} payload.text
 * @param {string} payload.run_at ISO datetime
 * @param {string} payload.thread_id
 * @param {string} [payload.chat_mode]
 * @param {string} [payload.speed_mode]
 * @param {"reminder"|"analysis_silent"|"analysis_inform"} [payload.intent]
 * @param {string} [payload.title]
 */
export async function scheduleTaskRequest(payload) {
  const response = await fetch(`${API_BASE_URL}/scheduler/schedule`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to schedule task");
  }
  return response.json();
}

export async function listScheduledTasks() {
  const response = await fetch(`${API_BASE_URL}/scheduler/tasks`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to list scheduled tasks");
  }
  return response.json();
}

export async function cancelScheduledTask(jobId) {
  const response = await fetch(`${API_BASE_URL}/scheduler/tasks/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to cancel scheduled task");
  }
  return response.json();
}

export async function getScheduleNotifications() {
  const response = await fetch(`${API_BASE_URL}/scheduler/notifications`, {
    method: "GET",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to fetch schedule notifications");
  }
  return response.json();
}

export async function markScheduleNotificationRead(notifId) {
  const response = await fetch(
    `${API_BASE_URL}/scheduler/notifications/${encodeURIComponent(notifId)}/read`,
    {
      method: "POST",
      headers: getHeaders(),
    }
  );
  if (!response.ok) {
    await throwHttpError(response, "Failed to mark notification read");
  }
  return response.json();
}

export async function markAllScheduleNotificationsRead() {
  const response = await fetch(`${API_BASE_URL}/scheduler/notifications/read-all`, {
    method: "POST",
    headers: getHeaders(),
  });
  if (!response.ok) {
    await throwHttpError(response, "Failed to mark notifications read");
  }
  return response.json();
}

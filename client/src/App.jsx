import { useState, useEffect, useRef, useCallback } from "react";
import { LogicalSize, LogicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";

import { motion, AnimatePresence, animate } from "framer-motion";
import { checkApiHealth, getSettings, updateSetting, getThreadMessages, getHistory, streamChat, streamFriendChat, cancelFriendStream, getScreenshot, getDesktopText, cancelChat, transcribeAudio, speakText, setAppToken, resumeChat, getScheduleNotifications, markScheduleNotificationRead, markAllScheduleNotificationsRead, getFriends, getFriendApproval, approveFriendForThread, deleteThread, forkThread, clearAllHistory } from "./services/chatApi";
import { sliceMessagesForBranch, messagesToForkPayloads } from "./utils/branchUtils";
import { setShareLocationEnabled, prefetchClientLocation } from "./utils/locationUtils";
import { isTauri, startNativeRecording, stopNativeRecording } from "./utils/tauriNative";
import { extractUrls } from "./utils/urlUtils";
import { saveThreadId, getStoredThreadId, getFriendThreadMeta, saveFriendThreadMeta } from "./services/historyService";
import { SettingsPage } from "./components/SettingsPage";
import { PlannerWindowStandalone } from "./components/PlannerWindowPage";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { UpdateBanner, UpdateInstallDialog } from "./components/UpdateNotification";
import { checkForAppUpdate, downloadAppUpdate, installDownloadedUpdate } from "./services/updater";
import { NormalModeLayout } from "./components/NormalModeLayout";
import { FloatingBubble } from "./components/FloatingBubble";
import { FloatingChatWindow } from "./components/FloatingChatWindow";
import { HITLApproval } from "./components/HITLApproval";
import { ScreenPrivacyToast } from "./components/ScreenPrivacyToast";
import {
  WINDOW_SIZES,
  getToolDisplayName,
  initialMessages,
} from "./constants/appConfig";
import { useWindowManager } from "./hooks/useWindowManager";
import { useAttachments } from "./hooks/useAttachments";
import { useKnowledgeAttachment } from "./hooks/useKnowledgeAttachment";
import { normalizeQuestionPayload } from "./utils/questionNormalizer";
import { parseMessageContentToBlocks } from "./utils/messageParser";
export { parseMessageContentToBlocks };



/**
 * Clean markdown symbols, code blocks, URLs, and formatting from text for natural TTS speech output.
 * @param {string} text
 * @returns {string}
 */
function cleanTextForSpeech(text) {
  if (!text) return "";
  let clean = text;
  // Remove <think>...</think> or <thought>...</thought> blocks
  clean = clean.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  // Remove code blocks ```...```
  clean = clean.replace(/```[\s\S]*?```/g, "");
  // Remove inline code `...`
  clean = clean.replace(/`[^`]+`/g, "");
  // Remove URLs
  clean = clean.replace(/https?:\/\/\S+/gi, "");
  // Remove Markdown links [text](url) -> text
  clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove headers (#, ##, etc.)
  clean = clean.replace(/^\s*#+\s+/gm, "");
  // Remove bold/italic symbols (*, _, **)
  clean = clean.replace(/[*_]{1,3}/g, "");
  // Remove blockquote symbol (> )
  clean = clean.replace(/^\s*>\s+/gm, "");
  // Remove bullet list symbols (- , * , + )
  clean = clean.replace(/^\s*[-*+]\s+/gm, "");
  // Replace multiple spaces/newlines with single space
  clean = clean.replace(/\s+/g, " ").trim();
  return clean;
}


/** Merge unread poll into session log so items stay visible after mark-read (until app restart). */
function mergeScheduleNotificationLog(prev, incoming) {
  const map = new Map(prev.map((n) => [n.id, n]));
  for (const n of incoming) {
    map.set(n.id, n);
  }
  let arr = Array.from(map.values());
  arr.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (arr.length > 100) arr = arr.slice(0, 100);
  return arr;
}

function playScheduleAlertSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch (e) {
    console.warn("Schedule alert sound failed:", e);
  }
}

function normalizeFriendMetaMap(metaMap) {
  const source = metaMap && typeof metaMap === "object" ? metaMap : {};
  const normalized = {};
  Object.entries(source).forEach(([threadId, meta]) => {
    if (!meta || typeof meta !== "object") return;
    const friendId = meta.friendId || meta.friend_id || null;
    const friendName = meta.friendName || meta.friend_name || "Friend";
    if (!friendId) return;
    normalized[String(threadId)] = {
      friendId,
      friendName,
      isFriendChat: true,
    };
  });
  return normalized;
}

function mergeFriendMetaFromHistoryRows(baseMap, rows) {
  const next = { ...(baseMap || {}) };
  (rows || []).forEach((row) => {
    const threadId = String(row?.thread_id || row?.id || "");
    const friendId = row?.friend_id || null;
    const friendName = row?.friend_name || "Friend";
    if (!threadId || !friendId) return;
    next[threadId] = {
      friendId,
      friendName,
      isFriendChat: true,
    };
  });
  return next;
}

function MainApp() {
  //#region State
  const [isOpen, setIsOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({});
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [input, setInput] = useState("");
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [sessions, setSessions] = useState({});
  const [streamingThreads, setStreamingThreads] = useState(new Set());
  const [error, setError] = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");

  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [kioskOverlay, setKioskOverlay] = useState(false);
  const [kioskSelection, setKioskSelection] = useState(null);
  const [terminalLogs, setTerminalLogs] = useState([]);
  const [availableUpdate, setAvailableUpdate] = useState(null);
  const [updateDownloaded, setUpdateDownloaded] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState(0);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [updateNotificationDismissed, setUpdateNotificationDismissed] = useState(false);
  const [showInstallDialog, setShowInstallDialog] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [windowMode, setWindowMode] = useState("floating");
  const [isAppInitializing, setIsAppInitializing] = useState(true);
  const [currentTool, setCurrentTool] = useState(null);
  const [retryStatus, setRetryStatus] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isWindowDraggingFile, setIsWindowDraggingFile] = useState(false);
  const [pendingActions, setPendingActions] = useState({}); // Map: threadId -> HITL request

  // New states for toggles
  const [chatMode, setChatMode] = useState("agent"); // "agent" | "chat"
  const [speedMode, setSpeedMode] = useState("thinking"); // "thinking" | "flash"
  const [scheduleNotifications, setScheduleNotifications] = useState([]);
  const [scheduleNotificationLog, setScheduleNotificationLog] = useState([]);
  const [isFloatingScheduleOpen, setIsFloatingScheduleOpen] = useState(false);
  const [isFloatingFriendsOpen, setIsFloatingFriendsOpen] = useState(false);
  const [friends, setFriends] = useState([]);
  const [friendThreadMeta, setFriendThreadMeta] = useState({});
  const [privacyToast, setPrivacyToast] = useState(null);
  const privacyHoldTimerRef = useRef(null);
  const isPrivacyHoldingRef = useRef(false);
  const justDisabledTimeRef = useRef(0);
  const justEnabledTimeRef = useRef(0);
  const scheduleNotifInitializedRef = useRef(false);
  const scheduleNotifSeenIdsRef = useRef(new Set());
  const prevThreadScheduleNotifIdsRef = useRef(new Set());

  const windowManager = useWindowManager({ isOpen, setIsOpen, windowMode, settings });
  const {
    getWindow,
    getWindowPosition,
    snapToNearestEdge,
    handleOpen,
    handleMinimize,
    minimizeToBottomCenter,
    handleDragStart,
    handleBubbleMouseDown,
    isSnapping,
    side,
    pendingBubblePositionRef,
    shouldSnapOnMinimizeRef,
    positionCheckIntervalRef,
    isDraggingRef,
  } = windowManager;

  const attachments = useAttachments();
  const knowledgeAttachment = useKnowledgeAttachment();
  const {
    attachedKnowledge,
    loadThreadKnowledge,
    attachKnowledge,
    detachKnowledge,
    getNewKnowledgeIds,
    markAllLocked,
  } = knowledgeAttachment;
  const {
    attachedImage,
    setAttachedImage,
    isScreenAttached,
    setIsScreenAttached,
    projectRoot,
    setProjectRoot,
    projectRootChip,
    setProjectRootChip,
    attachedClipboardText,
    setAttachedClipboardText,
    isCapturing,
    setIsCapturing,
    isAttachmentPopoverOpen,
    setIsAttachmentPopoverOpen,
    attachedFiles,
    setAttachedFiles,
    removeAttachedFile,
    handlePickProjectPath,
    handleAttachClipboard,
    handleFileUpload,
    handleCaptureScreen,
    processFile,
    processFilePath,
  } = attachments;
  //#endregion



  //#region Refs
  const messagesEndRef = useRef(null);
  const threadIdRef = useRef(null);
  const clearConfirmTimerRef = useRef(null);
  const abortControllersRef = useRef({}); // Map of threadId -> AbortController
  const eventSourceRef = useRef(null);
  const firstToolMinimizedRef = useRef(false);
  const lastTerminalCommandRef = useRef(null);
  const lastTurnIdsRef = useRef({}); // Map of threadId -> { userMessageId, botMessageId }
  const lastSentInputsRef = useRef({}); // Map of threadId -> { text, image_url }
  const bubbleRef = useRef(null);
  const textareaRef = useRef(null);
  const isOpenRef = useRef(isOpen);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const currentAudioRef = useRef(null);
  const accumulatedTextRef = useRef("");
  const pendingStreamUpdatesRef = useRef({});
  const streamParserStateRef = useRef({});
  const rafIdRef = useRef(null);

  const flushStreamText = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const entries = Object.entries(pendingStreamUpdatesRef.current);
    if (entries.length === 0) return;
    const updates = { ...pendingStreamUpdatesRef.current };
    pendingStreamUpdatesRef.current = {};

    setSessions((prev) => {
      let changed = false;
      const nextSessions = { ...prev };
      Object.entries(updates).forEach(([tId, data]) => {
        const { botMsgId, pendingText, pendingThought, finishThinking, thoughtStartTime } = data;
        if (!nextSessions[tId]) return;
        if (!pendingText && !pendingThought && !finishThinking) return;

        changed = true;
        nextSessions[tId] = nextSessions[tId].map((m) => {
          if (m.id === botMsgId) {
            let blocks = m.blocks ? [...m.blocks] : [];

            // 1. Append thought tokens
            if (pendingThought) {
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === "thought" && lastBlock.isThinking) {
                blocks[blocks.length - 1] = {
                  ...lastBlock,
                  text: (lastBlock.text || "") + pendingThought,
                };
              } else {
                blocks.push({
                  type: "thought",
                  text: pendingThought,
                  isThinking: true,
                  startTime: thoughtStartTime || Date.now(),
                });
              }
            }

            // 2. Finish thinking if transitioning to text or explicitly finished
            if (pendingText || finishThinking) {
              blocks = blocks.map((b) => {
                if (b.type === "thought" && b.isThinking) {
                  const elapsed = b.startTime ? (Date.now() - b.startTime) : undefined;
                  return { ...b, isThinking: false, elapsedMs: elapsed };
                }
                return b;
              });
            }

            // 3. Append text tokens
            if (pendingText) {
              const lastBlock = blocks[blocks.length - 1];
              if (lastBlock && lastBlock.type === "text") {
                blocks[blocks.length - 1] = {
                  ...lastBlock,
                  text: (lastBlock.text || "") + pendingText,
                };
              } else {
                blocks.push({ type: "text", text: pendingText });
              }
            }

            return { ...m, blocks };
          }
          return m;
        });
      });
      return changed ? nextSessions : prev;
    });
  }, []);

  const voiceReplyRef = useRef(true);
  const lastTurnWasVoiceRef = useRef(false);
  const ttsProviderRef = useRef("edge-tts");
  const ttsVoiceRef = useRef("en-US-EmmaNeural");
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const sentenceBufferRef = useRef("");
  const isRecordingRef = useRef(isRecording);
  const friendStreamStateRef = useRef({});
  const messages = sessions[activeThreadId] || initialMessages;
  const isLoading = streamingThreads.has(activeThreadId);
  const isLoadingRef = useRef(isLoading);
  const isGlobalPTTPressedRef = useRef(false);
  const clipboardTimeoutRef = useRef(null);
  //#endregion

  //#region Functions
  const handleDeleteMessage = useCallback((messageId) => {
    setSessions((prev) => {
      const newSessions = { ...prev };
      if (activeThreadId && newSessions[activeThreadId]) {
        newSessions[activeThreadId] = newSessions[activeThreadId].filter((m) => m.id !== messageId);
      }
      return newSessions;
    });
  }, [activeThreadId]);
  
  const handleClearTerminal = useCallback(() => {
    setTerminalLogs([]);
  }, []);

  const loadFriends = useCallback(async () => {
    try {
      const data = await getFriends();
      setFriends(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Failed to load friends:", err);
    }
  }, []);

  const persistFriendMeta = useCallback((updater) => {
    setFriendThreadMeta((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveFriendThreadMeta(next);
      return next;
    });
  }, []);

  const handleAssignFriendToThread = useCallback((threadId, friend) => {
    if (!threadId || !friend?.id) return;
    persistFriendMeta((prev) => ({
      ...prev,
      [String(threadId)]: {
        friendId: friend.id,
        friendName: friend.name || "Friend",
        isFriendChat: true,
      },
    }));
  }, [persistFriendMeta]);

  const handleStartFriendChat = useCallback((friend) => {
    if (!friend?.id) return;
    const newThreadId = crypto.randomUUID();
    setSessions((prev) => ({ ...prev, [newThreadId]: initialMessages }));
    setActiveThreadId(newThreadId);
    saveThreadId(newThreadId);
    threadIdRef.current = newThreadId;
    handleAssignFriendToThread(newThreadId, friend);
    setAttachedImage(null);
    setInput("");
    setIsMenuOpen(false);
  }, [handleAssignFriendToThread]);

  const handleToggleWindowMode = useCallback(async () => {
    const newMode = windowMode === "floating" ? "normal" : "floating";
    // Save setting first
    try {
      await updateSetting("WINDOW_MODE", newMode);
      setWindowMode(newMode);
      setIsMenuOpen(false);
    } catch (err) {
      console.error("Failed to toggle window mode:", err);
      // Fallback
      setWindowMode(newMode);
      setIsMenuOpen(false);
    }
  }, [windowMode]);


  const handleOpenSettingsWindow = useCallback(async () => {
    // In plain web/dev mode, keep existing in-window settings behavior.
    if (!window.__TAURI_INTERNALS__) {
      setShowWelcome(false);
      setIsSettingsOpen(true);
      return;
    }

    try {
      const existing = await WebviewWindow.getByLabel("settings");
      if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
      }

      const settingsUrl = `${window.location.origin}${window.location.pathname}?view=settings`;
      const settingsWindow = new WebviewWindow("settings", {
        title: "Rie-AI Settings",
        url: settingsUrl,
        width: WINDOW_SIZES.SETTINGS.width,
        height: WINDOW_SIZES.SETTINGS.height,
        resizable: true,
        center: true,
        decorations: false,
      });

      settingsWindow.once("tauri://created", async () => {
        try {
          await settingsWindow.show();
          await settingsWindow.setFocus();
        } catch {
          // no-op
        }
      });
      settingsWindow.once("tauri://error", (e) => {
        console.error("Failed to create settings window:", e);
        setShowWelcome(false);
        setIsSettingsOpen(true);
      });
    } catch (err) {
      console.error("Failed to open settings window:", err);
      setShowWelcome(false);
      setIsSettingsOpen(true);
    }
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    setShowWelcome(false);
  }, []);

  const handleCloseApp = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("exit_app");
    } catch (err) {
      console.error("Failed to exit app:", err);
      // Fallback
      window.close();
    }
  }, []);

  // Stop & clear all audio playback and queues
  const stopSpeech = useCallback(() => {
    audioQueueRef.current = [];
    sentenceBufferRef.current = "";
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
        currentAudioRef.current.currentTime = 0;
      } catch (err) {
        console.error("Error stopping audio playback:", err);
      }
      currentAudioRef.current = null;
    }
    isPlayingRef.current = false;
  }, []);

  // Audio Queue Processor
  const processAudioQueue = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;

    isPlayingRef.current = true;

    // Get the first task (Promise)
    const currentTask = audioQueueRef.current.shift();

    try {
      const audioBlob = await currentTask;

      if (!audioBlob) {
        console.warn("Skipping failed/empty audio chunk");
        isPlayingRef.current = false;
        processAudioQueue();
        return;
      }

      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      currentAudioRef.current = audio;

      // Play and wait for end
      await new Promise((resolve) => {
        audio.onended = resolve;
        audio.onerror = resolve; // Continue even on error
        audio.play().catch(e => {
          console.error("Audio play failed", e);
          resolve();
        });
      });

      URL.revokeObjectURL(audioUrl);
      if (currentAudioRef.current === audio) {
        currentAudioRef.current = null;
      }
    } catch (err) {
      console.error("Queue processing error:", err);
    } finally {
      isPlayingRef.current = false;
      processAudioQueue();
    }
  }, []);


  const queueSentence = useCallback((text) => {
    if (!text || !text.trim()) return;
    const cleaned = cleanTextForSpeech(text);
    if (!cleaned) return;
    const audioPromise = speakText(cleaned, ttsVoiceRef.current, ttsProviderRef.current).catch(err => {
      console.error("TTS fetch error", err);
      return null;
    });
    audioQueueRef.current.push(audioPromise);
    processAudioQueue();
  }, [processAudioQueue]);

  const processStreamChunk = useCallback((data, botMessageId, threadId, userMessageId) => {
    try {
      if (data.done || data.step === "end") {
        if (streamParserStateRef.current[threadId]) {
          const parser = streamParserStateRef.current[threadId];
          if (parser.buffer) {
            if (!pendingStreamUpdatesRef.current[threadId]) {
              pendingStreamUpdatesRef.current[threadId] = { botMsgId: botMessageId, pendingText: "", pendingThought: "" };
            }
            if (parser.inThinkTag) {
              pendingStreamUpdatesRef.current[threadId].pendingThought = (pendingStreamUpdatesRef.current[threadId].pendingThought || "") + parser.buffer;
            } else {
              pendingStreamUpdatesRef.current[threadId].pendingText = (pendingStreamUpdatesRef.current[threadId].pendingText || "") + parser.buffer;
              accumulatedTextRef.current += parser.buffer;
            }
            parser.buffer = "";
          }
          delete streamParserStateRef.current[threadId];
        }
        if (pendingStreamUpdatesRef.current[threadId]) {
          pendingStreamUpdatesRef.current[threadId].finishThinking = true;
        }
        flushStreamText();
        setStreamingThreads(prev => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
        setCurrentTool(null);
        setRetryStatus(null);
        setIsTerminalOpen(false);

        // Ensure any active thought blocks in sessions are finalized
        setSessions((prev) => {
          if (!prev[threadId]) return prev;
          return {
            ...prev,
            [threadId]: prev[threadId].map((m) => {
              if (m.id === botMessageId && m.blocks) {
                return {
                  ...m,
                  blocks: m.blocks.map((b) =>
                    b.type === "thought" && b.isThinking
                      ? { ...b, isThinking: false, elapsedMs: b.startTime ? (Date.now() - b.startTime) : undefined }
                      : b
                  ),
                };
              }
              return m;
            }),
          };
        });

        // Flush & speak any remaining unspoken text left in sentenceBufferRef at the end of stream
        if (voiceReplyRef.current && lastTurnWasVoiceRef.current && sentenceBufferRef.current.trim()) {
          queueSentence(sentenceBufferRef.current);
        }
        // Reset sentence buffer and accumulated text for the next turn
        sentenceBufferRef.current = "";
        accumulatedTextRef.current = "";

        if (firstToolMinimizedRef.current) {
          firstToolMinimizedRef.current = false;
          handleOpen(true);
        }
        return;
      }

      if (data.step === "key_retry" || data.step === "model_fallback") {
        setRetryStatus({
          threadId,
          message: data.message || `Retrying with key #${data.key_index || 1}...`,
          keyIndex: data.key_index,
          totalKeys: data.total_keys,
          provider: data.provider,
        });
        return;
      }

      if (data.step === "url_preview" && Array.isArray(data.previews) && data.previews.length > 0) {
        setSessions((prev) => {
          const newSessions = { ...prev };
          if (newSessions[threadId]) {
            newSessions[threadId] = newSessions[threadId].map((m) => {
              if (m.id === userMessageId) {
                return { ...m, url_previews: data.previews };
              }
              return m;
            });
          }
          return newSessions;
        });
        return;
      }

      if (data.step === "interrupt") {
        flushStreamText();
        const hitl = data.hitl;
        const firstActionName = hitl?.action_requests?.[0]?.name;
        // Only surface HITL in the UI for terminal commands
        if (firstActionName !== "run_terminal_command") {
          return;
        }

        // Store HITL interrupt per-thread so multiple chats can run in parallel safely
        setPendingActions(prev => ({
          ...prev,
          [threadId]: hitl,
        }));
        setStreamingThreads(prev => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
        setCurrentTool(null);
        setRetryStatus(null);
        setIsTerminalOpen(false); // Auto-close terminal on HITL
        return;
      }

      if (data.error) {
        flushStreamText();
        setRetryStatus(null);
        const rawError = typeof data.error === "string" ? data.error.trim() : "";
        const rawDetails = typeof data.details === "string" ? data.details.trim() : "";
        const isGenericStreamError =
          !rawError ||
          rawError.toLowerCase() === "internal stream error" ||
          rawError.toLowerCase() === "internal server error";
        const errorMsg =
          rawDetails && isGenericStreamError
            ? rawDetails
            : rawDetails && rawError
              ? `${rawError}: ${rawDetails}`
              : rawError || "Unable to connect to chat API.";
        setError(errorMsg);
        setSessions((prev) => {
          const newSessions = { ...prev };
          if (newSessions[threadId]) {
            newSessions[threadId] = newSessions[threadId].map((m) => {
              if (m.id === userMessageId) {
                return { ...m, error: true, errorMessage: errorMsg };
              }
              return m;
            });
          }
          return newSessions;
        });
        setStreamingThreads(prev => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
        setCurrentTool(null);
        setIsTerminalOpen(false);
        if (firstToolMinimizedRef.current) {
          firstToolMinimizedRef.current = false;
          handleOpen(true);
        }
        return;
      }

      if (data.step === "terminal_chunk") {
        const line = data.data || "";
        setTerminalLogs((prev) => {
          const newLogs = [...prev];
          if (newLogs.length === 0 || newLogs[newLogs.length - 1].status !== "running") {
            newLogs.push({
              status: "running",
              command: lastTerminalCommandRef.current || "(running command...)",
              stdout: line,
              stderr: "",
              returncode: undefined
            });
          } else {
            newLogs[newLogs.length - 1] = {
              ...newLogs[newLogs.length - 1],
              stdout: newLogs[newLogs.length - 1].stdout + line
            };
          }
          return newLogs;
        });
        return;
      }

      const step = data.step;
      const msg = data.message || {};

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const first = msg.tool_calls[0];
        const toolName = first.name || null;
        setCurrentTool(toolName);

        if (toolName === "run_terminal_command") {
          if (first.args?.command) {
            lastTerminalCommandRef.current = first.args.command;
          }
          setIsTerminalOpen(true);

          if (lastTerminalCommandRef.current) {
            setTerminalLogs((prev) => {
              const newLogs = [...prev];
              if (newLogs.length === 0 || newLogs[newLogs.length - 1].status !== "running") {
                  newLogs.push({
                      status: "running",
                      command: lastTerminalCommandRef.current,
                      stdout: "",
                      stderr: "",
                      returncode: undefined
                  });
                  return newLogs;
              } else if (newLogs[newLogs.length - 1].status === "running" && newLogs[newLogs.length - 1].command !== lastTerminalCommandRef.current) {
                  // Update the command text as it streams in
                  newLogs[newLogs.length - 1] = {
                      ...newLogs[newLogs.length - 1],
                      command: lastTerminalCommandRef.current
                  };
                  return newLogs;
              }
              return prev;
            });
          }
        }

        if (toolName === "ask_question") {
          const qPayload = normalizeQuestionPayload(first.args, `q_call_${botMessageId}`);
          if (qPayload) {
            setSessions((prev) => {
              const newSessions = { ...prev };
              if (newSessions[threadId]) {
                newSessions[threadId] = newSessions[threadId].map((m) => {
                  if (m.id === botMessageId) {
                    const blocks = m.blocks || [];
                    const existingIdx = blocks.findIndex((b) => b.type === "question" || b.type === "ask_question");
                    if (existingIdx !== -1) {
                      const updatedBlocks = [...blocks];
                      updatedBlocks[existingIdx] = {
                        ...updatedBlocks[existingIdx],
                        data: qPayload,
                      };
                      return { ...m, blocks: updatedBlocks };
                    }
                    return {
                      ...m,
                      blocks: [...blocks, { type: "question", id: qPayload.id, data: qPayload, isAnswered: false }],
                    };
                  }
                  return m;
                });
              }
              return newSessions;
            });
          }
        }

        if (!firstToolMinimizedRef.current && toolName !== "run_terminal_command" && toolName !== "ask_question" && windowMode !== "normal") {
          firstToolMinimizedRef.current = true;
          minimizeToBottomCenter();
        }
      }

      const isModelMessage = step === "model" && (msg.type === "ai" || msg.type === "assistant");
      if (isModelMessage) {
        const textChunk = typeof msg.content === "string" ? msg.content : "";
        const thoughtChunk = typeof msg.reasoning_content === "string" ? msg.reasoning_content : (typeof msg.thought === "string" ? msg.thought : "");

        if (!pendingStreamUpdatesRef.current[threadId]) {
          pendingStreamUpdatesRef.current[threadId] = {
            botMsgId: botMessageId,
            pendingText: "",
            pendingThought: "",
            thoughtStartTime: Date.now(),
          };
        }

        // 1. Explicit reasoning_content from provider
        if (thoughtChunk) {
          pendingStreamUpdatesRef.current[threadId].pendingThought = (pendingStreamUpdatesRef.current[threadId].pendingThought || "") + thoughtChunk;
        }

        // 2. Normal text and/or inline <think>...</think> tags parsing
        if (textChunk) {
          if (!streamParserStateRef.current[threadId]) {
            streamParserStateRef.current[threadId] = { inThinkTag: false, buffer: "" };
          }
          const parser = streamParserStateRef.current[threadId];
          parser.buffer += textChunk;

          let speechNewText = "";

          while (parser.buffer.length > 0) {
            if (!parser.inThinkTag) {
              const thinkIdx = parser.buffer.indexOf("<think>");
              const altIdx = thinkIdx === -1 ? parser.buffer.indexOf("<thought>") : thinkIdx;
              const tagLen = thinkIdx !== -1 ? 7 : (parser.buffer.indexOf("<thought>") !== -1 ? 9 : 0);
              const tagIdx = thinkIdx !== -1 ? thinkIdx : (parser.buffer.indexOf("<thought>") !== -1 ? parser.buffer.indexOf("<thought>") : -1);

              if (tagIdx !== -1) {
                const textBefore = parser.buffer.slice(0, tagIdx);
                if (textBefore) {
                  pendingStreamUpdatesRef.current[threadId].pendingText = (pendingStreamUpdatesRef.current[threadId].pendingText || "") + textBefore;
                  accumulatedTextRef.current += textBefore;
                  speechNewText += textBefore;
                }
                parser.inThinkTag = true;
                parser.buffer = parser.buffer.slice(tagIdx + tagLen);
              } else {
                const partialMatch = parser.buffer.match(/<(?:t(?:h(?:i(?:n(?:k)?)?)?|o(?:u(?:g(?:h(?:t)?)?)?)?)?)?$/);
                if (partialMatch && partialMatch.index !== undefined && partialMatch.index > 0) {
                  const safeText = parser.buffer.slice(0, partialMatch.index);
                  pendingStreamUpdatesRef.current[threadId].pendingText = (pendingStreamUpdatesRef.current[threadId].pendingText || "") + safeText;
                  accumulatedTextRef.current += safeText;
                  speechNewText += safeText;
                  parser.buffer = parser.buffer.slice(partialMatch.index);
                  break;
                } else if (partialMatch && partialMatch.index === 0) {
                  break;
                } else {
                  pendingStreamUpdatesRef.current[threadId].pendingText = (pendingStreamUpdatesRef.current[threadId].pendingText || "") + parser.buffer;
                  accumulatedTextRef.current += parser.buffer;
                  speechNewText += parser.buffer;
                  parser.buffer = "";
                }
              }
            } else {
              const thinkEndIdx = parser.buffer.indexOf("</think>");
              const closeTagLen = thinkEndIdx !== -1 ? 8 : (parser.buffer.indexOf("</thought>") !== -1 ? 10 : 0);
              const closeTagIdx = thinkEndIdx !== -1 ? thinkEndIdx : (parser.buffer.indexOf("</thought>") !== -1 ? parser.buffer.indexOf("</thought>") : -1);

              if (closeTagIdx !== -1) {
                const thoughtBefore = parser.buffer.slice(0, closeTagIdx);
                if (thoughtBefore) {
                  pendingStreamUpdatesRef.current[threadId].pendingThought = (pendingStreamUpdatesRef.current[threadId].pendingThought || "") + thoughtBefore;
                }
                parser.inThinkTag = false;
                parser.buffer = parser.buffer.slice(closeTagIdx + closeTagLen);
                pendingStreamUpdatesRef.current[threadId].finishThinking = true;
              } else {
                const partialClose = parser.buffer.match(/<\/(?:t(?:h(?:i(?:n(?:k)?)?)?|o(?:u(?:g(?:h(?:t)?)?)?)?)?)?$/);
                if (partialClose && partialClose.index !== undefined && partialClose.index > 0) {
                  const safeThought = parser.buffer.slice(0, partialClose.index);
                  pendingStreamUpdatesRef.current[threadId].pendingThought = (pendingStreamUpdatesRef.current[threadId].pendingThought || "") + safeThought;
                  parser.buffer = parser.buffer.slice(partialClose.index);
                  break;
                } else if (partialClose && partialClose.index === 0) {
                  break;
                } else {
                  pendingStreamUpdatesRef.current[threadId].pendingThought = (pendingStreamUpdatesRef.current[threadId].pendingThought || "") + parser.buffer;
                  parser.buffer = "";
                }
              }
            }
          }

          // Real-time sentence-streaming for voice reply (strictly speaks final answer text only)
          if (speechNewText && voiceReplyRef.current && lastTurnWasVoiceRef.current) {
            sentenceBufferRef.current += speechNewText;
            let buffer = sentenceBufferRef.current;
            const sentenceRegex = /([^.!?\n]+[.!?\n]+(?:\s+|$))/g;
            let match;
            let lastIdx = 0;
            while ((match = sentenceRegex.exec(buffer)) !== null) {
              const rawSentence = match[0];
              lastIdx = sentenceRegex.lastIndex;
              if (rawSentence.trim()) {
                queueSentence(rawSentence);
              }
            }
            if (lastIdx > 0) {
              sentenceBufferRef.current = buffer.slice(lastIdx);
            }
          }
        }

        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null;
            flushStreamText();
          });
        }
      }

      if (step === "tools" || msg.type === "tool" || msg.role === "tool") {
        if (pendingStreamUpdatesRef.current[threadId]) {
          pendingStreamUpdatesRef.current[threadId].finishThinking = true;
        }
        flushStreamText();
        const content = msg.content;
        if (content && typeof content === "string") {
          const toolName = msg.name || currentTool;

          if (toolName === "ask_question") {
            const qPayload = normalizeQuestionPayload(content, `q_tool_${botMessageId}`);
            if (qPayload) {
              setSessions((prev) => {
                const newSessions = { ...prev };
                if (newSessions[threadId]) {
                  newSessions[threadId] = newSessions[threadId].map((m) => {
                    if (m.id === botMessageId) {
                      const blocks = m.blocks || [];
                      const existingIdx = blocks.findIndex((b) => b.type === "question" || b.type === "ask_question");
                      if (existingIdx !== -1) {
                        const updatedBlocks = [...blocks];
                        updatedBlocks[existingIdx] = {
                          ...updatedBlocks[existingIdx],
                          data: qPayload,
                        };
                        return { ...m, blocks: updatedBlocks };
                      }
                      return {
                        ...m,
                        blocks: [...blocks, { type: "question", id: qPayload.id, data: qPayload, isAnswered: false }],
                      };
                    }
                    return m;
                  });
                }
                return newSessions;
              });
            }
            return;
          }

          // Append tool output to the visible chat message as a ToolChip block
          setSessions((prev) => {
            const newSessions = { ...prev };
            if (newSessions[threadId]) {
              newSessions[threadId] = newSessions[threadId].map((m) => {
                if (m.id === botMessageId) {
                  const blocks = m.blocks || [];
                  return {
                    ...m,
                    blocks: [...blocks, { type: "tool", name: toolName, text: content }],
                  };
                }
                return m;
              });
            }
            return newSessions;
          });

          // If this is the system terminal tool, also mirror the output into the Terminal UI
          if (toolName === "run_terminal_command") {
            let logEntry = null;

            // Backend sends JSON string with {status, command, stdout, stderr, returncode}
            if (content.trim().startsWith("{")) {
              try {
                logEntry = JSON.parse(content);
              } catch (e) {
                console.error("Failed to parse run_terminal_command output:", e);
              }
            }

            if (!logEntry) {
              logEntry = {
                status: "ok",
                command: lastTerminalCommandRef.current || "(command)",
                stdout: content,
                stderr: "",
                returncode: undefined,
              };
            }

            setTerminalLogs((prev) => {
              const newLogs = [...prev];
              if (newLogs.length > 0 && newLogs[newLogs.length - 1].status === "running") {
                  newLogs[newLogs.length - 1] = logEntry;
                  return newLogs;
              }
              return [...prev, logEntry];
            });
          }
        }
      }
    } catch (err) {
      console.error("Stream processing error:", err);
    }
  }, [windowMode, queueSentence, handleOpen, minimizeToBottomCenter]);

  const handleRekeyThread = useCallback((fromThreadId, toThreadId) => {
    const fromKey = String(fromThreadId || "");
    const toKey = String(toThreadId || "");
    if (!fromKey || !toKey || fromKey === toKey) return;

    setSessions((prev) => {
      if (!prev[fromKey]) return prev;
      const next = { ...prev };
      next[toKey] = next[toKey] ? [...next[toKey], ...next[fromKey]] : next[fromKey];
      delete next[fromKey];
      return next;
    });
    persistFriendMeta((prev) => {
      if (!prev[fromKey]) return prev;
      const next = { ...prev };
      next[toKey] = prev[fromKey];
      delete next[fromKey];
      return next;
    });
    if (threadIdRef.current === fromKey) {
      threadIdRef.current = toKey;
    }
    if (String(activeThreadId || "") === fromKey) {
      setActiveThreadId(toKey);
      saveThreadId(toKey);
    }
    if (lastTurnIdsRef.current[fromKey]) {
      lastTurnIdsRef.current[toKey] = lastTurnIdsRef.current[fromKey];
      delete lastTurnIdsRef.current[fromKey];
    }
    if (lastSentInputsRef.current[fromKey]) {
      lastSentInputsRef.current[toKey] = lastSentInputsRef.current[fromKey];
      delete lastSentInputsRef.current[fromKey];
    }
  }, [activeThreadId, persistFriendMeta]);

  const handleSend = useCallback(async (overrideText = null, isVoice = false, overrideImage = null) => {
    const textToSend = (typeof overrideText === 'string') ? overrideText : input;
    const trimmed = textToSend.trim();
    const hasAttachments = attachedImage || isScreenAttached || attachedClipboardText || projectRoot || overrideImage || attachedKnowledge.length > 0 || attachedFiles.length > 0;
    if (!trimmed && !hasAttachments || isLoading) return;

    // Stop and clear audio
    stopSpeech();

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const clipboardToUse = attachedClipboardText;
    const isScreenToUse = isScreenAttached;
    const imageToUseFromState = overrideImage || attachedImage;
    const filesToUse = [...attachedFiles];

    const performSend = async (imageToUse = imageToUseFromState, desktopText = null) => {
      const threadId = threadIdRef.current;
      lastTurnWasVoiceRef.current = isVoice;
      const friendMeta = friendThreadMeta[threadId] || friendThreadMeta[String(threadId)] || null;
      const friendTarget = friendMeta?.friendId
        ? { id: friendMeta.friendId, name: friendMeta.friendName || "Friend" }
        : null;

      const detectedUrls = !friendTarget ? extractUrls(trimmed) : [];
      let finalMsgText = trimmed;
      if (desktopText) {
        finalMsgText = `${trimmed}\n\n[Attached Screen Content (extracted via Windows UI Automation)]:\n${desktopText}`;
      }

      const userMessage = {
        id: Date.now(),
        from: "user",
        text: finalMsgText,
        image_url: imageToUse,
        clipboard: clipboardToUse,
        ...(detectedUrls.length > 0
          ? { url_previews: detectedUrls.map((url) => ({ url, loading: true })) }
          : {}),
      };

      setSessions((prev) => ({
        ...prev,
        [threadId]: [...(prev[threadId] || []), userMessage]
      }));
      if (overrideText === null) {
        setInput("");
      }
      setAttachedImage(null);
      setIsScreenAttached(false);
      setAttachedClipboardText(null);
      setAttachedFiles([]);

      const userMessageId = userMessage.id;
      const botMessageId = Date.now() + 1;
      lastTurnIdsRef.current[threadId] = { userMessageId, botMessageId };
      lastSentInputsRef.current[threadId] = { text: finalMsgText, image_url: imageToUse };

      setStreamingThreads(prev => new Set(prev).add(threadId));
      setError(null);
      accumulatedTextRef.current = "";

      setSessions((prev) => ({
        ...prev,
        [threadId]: [
          ...(prev[threadId] || []),
          {
            id: botMessageId,
            from: "bot",
            blocks: [],
          },
        ]
      }));

      const controller = new AbortController();
      abortControllersRef.current[threadId] = controller;
      const signal = controller.signal;
      const toConnectivityHint = (message) => {
        const text = (message || "").toLowerCase();
        if (text.includes("[auth_failed]")) return "Peer rejected authentication. Re-run pairing or finalize on receiver.";
        if (text.includes("[timeout]")) return "Peer request timed out. Confirm receiver app is running and endpoint is reachable.";
        if (text.includes("[unreachable]")) return "Peer endpoint unreachable. Update the friend's endpoint in Connectivity settings.";
        return message || "Connection failed";
      };
      const resetFailedTurn = (errorMessage = null) => {
        if (errorMessage) {
          setError(errorMessage);
        }
        setStreamingThreads(prev => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
        delete abortControllersRef.current[threadId];
        setSessions((prev) => ({
          ...prev,
          [threadId]: (prev[threadId] || []).filter((m) => m.id !== botMessageId),
        }));
      };

      try {
        const token = localStorage.getItem('rie_token');
        const newKnowledgeIds = getNewKnowledgeIds();
        if (friendTarget?.id) {
          friendStreamStateRef.current[threadId] = {
            friendId: friendTarget.id,
            streamId: null,
          };
          const approval = await getFriendApproval(friendTarget.id, threadId);
          if (!approval?.approved) {
            const yes = window.confirm(`Allow asking ${friendTarget.name} in this chat? This is required only once per chat.`);
            if (!yes) {
              resetFailedTurn("Friend ask canceled by user");
              return;
            }
            try {
              await approveFriendForThread(friendTarget.id, threadId);
            } catch (approvalErr) {
              resetFailedTurn(approvalErr?.message || "Failed to save friend approval");
              return;
            }
          }
          try {
            await streamFriendChat(
              friendTarget.id,
              finalMsgText,
              threadId,
              (data) => {
                if (data?.step === "start") {
                  friendStreamStateRef.current[threadId] = {
                    friendId: friendTarget.id,
                    streamId: data.stream_id || null,
                  };
                }
                processStreamChunk(data, botMessageId, threadId, userMessageId);
              },
              () => {
                setStreamingThreads(prev => {
                  const next = new Set(prev);
                  next.delete(threadId);
                  return next;
                });
                setCurrentTool(null);
                delete abortControllersRef.current[threadId];
                delete friendStreamStateRef.current[threadId];
              },
              (friendErr) => {
                resetFailedTurn(toConnectivityHint(friendErr?.message || "Failed to ask friend"));
                delete friendStreamStateRef.current[threadId];
              },
              signal
            );
            return;
          } catch (friendErr) {
            resetFailedTurn(toConnectivityHint(friendErr?.message || "Failed to ask friend"));
            delete friendStreamStateRef.current[threadId];
            return;
          }
        }
        await streamChat(
          finalMsgText,
          threadId,
          imageToUse,
          (data) => processStreamChunk(data, botMessageId, threadId, userMessageId),
          () => {
            setStreamingThreads(prev => {
              const next = new Set(prev);
              next.delete(threadId);
              return next;
            });
            setCurrentTool(null);
            delete abortControllersRef.current[threadId];
            markAllLocked();
            loadThreadKnowledge(threadId);
            window.dispatchEvent(new CustomEvent("rie-schedule-refresh"));
          },
          (err) => {
            setError(toConnectivityHint(err.message));
            setStreamingThreads(prev => {
              const next = new Set(prev);
              next.delete(threadId);
              return next;
            });
            setCurrentTool(null);
            delete abortControllersRef.current[threadId];
            window.dispatchEvent(new CustomEvent("rie-schedule-refresh"));
          },
          signal,
          isVoice,
          projectRoot,
          token,
          clipboardToUse,
          chatMode,
          speedMode,
          friendTarget || undefined,
          newKnowledgeIds.length ? newKnowledgeIds : null,
          null,
          filesToUse.length ? filesToUse : null
        );
      } catch (err) {
        console.error("Chat error:", err);
        resetFailedTurn(toConnectivityHint(err?.message));
      } finally {
        setIsCapturing(false);
      }
    };
    if (isScreenToUse) {
      setIsCapturing(true);
      const isTauriEnv = isTauri();
      const win = isTauriEnv ? getWindow() : null;

      try {
        if (win && typeof win.hide === 'function') {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_foreground_lock", { lock: false });
          } catch (e) {
            console.error("Failed to unlock foreground for capture:", e);
          }
          await win.hide();
          await new Promise(resolve => setTimeout(resolve, 350));
        }

        let capturedImage = null;
        let desktopText = null;

        if (settings.capture_screen_as_text === true || settings.capture_screen_as_text === 'true') {
          try {
            const res = await getDesktopText();
            desktopText = res?.text || null;
          } catch (e) {
            console.error("Delayed desktop text capture failed:", e);
          }
        } else {
          try {
            const response = await getScreenshot();
            capturedImage = response?.image || null;
          } catch (e) {
            console.error("Delayed capture failed:", e);
          }
        }

        if (win && typeof win.show === 'function') {
          await win.show();
          await win.unminimize();
          await win.setFocus();
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_foreground_lock", { lock: true });
          } catch (e) {
            console.error("Failed to lock foreground post-capture:", e);
          }
        }

        await performSend(capturedImage, desktopText);
      } catch (err) {
        console.error("Delayed capture overall outer wrapper failed:", err);
        if (win && typeof win.show === 'function') {
          try {
            await win.show();
            await win.unminimize();
            await win.setFocus();
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_foreground_lock", { lock: true });
          } catch (e) {
            console.error("Failed to lock foreground post-capture-fail:", e);
          }
        }
        await performSend(null);
      } finally {
        setIsCapturing(false);
      }
    } else {
      await performSend();
    }
  }, [input, isLoading, messages, windowMode, attachedImage, isScreenAttached, attachedClipboardText, attachedKnowledge, minimizeToBottomCenter, handleOpen, queueSentence, processAudioQueue, chatMode, speedMode, friendThreadMeta, handleRekeyThread, getNewKnowledgeIds, markAllLocked, loadThreadKnowledge]);

  const handleAnswerQuestion = useCallback((blockId, formattedText, submittedAnswers) => {
    const threadId = activeThreadId;
    if (threadId) {
      setSessions((prev) => {
        if (!prev[threadId]) return prev;
        return {
          ...prev,
          [threadId]: prev[threadId].map((m) => {
            if (!m.blocks) return m;
            const hasBlock = m.blocks.some((b) => (b.type === "question" || b.type === "ask_question") && (b.id === blockId || !blockId));
            if (!hasBlock) return m;
            return {
              ...m,
              blocks: m.blocks.map((b) => {
                if ((b.type === "question" || b.type === "ask_question") && (b.id === blockId || !blockId)) {
                  return {
                    ...b,
                    isAnswered: true,
                    submittedAnswers,
                    submittedText: formattedText,
                  };
                }
                return b;
              }),
            };
          }),
        };
      });
    }
    handleSend(formattedText, false);
  }, [activeThreadId, handleSend]);

  const startRecording = useCallback(async () => {
    try {
      if (isRecording) return;

      stopSpeech();

      if (isTauri()) {
        await startNativeRecording();
        setIsRecording(true);
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      mediaRecorderRef.current = new MediaRecorder(stream);

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        try {
          const { text } = await transcribeAudio(audioBlob);
          if (text) {
            handleSend(text, true);
          }
        } catch (err) {
          console.error("Transcription failed:", err);
          setError("Transcription failed. Please try again.");
        } finally {
          stream.getTracks().forEach((track) => track.stop());
        }
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError("Microphone access denied or error starting recording.");
    }
  }, [isRecording, handleSend]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;

    if (isTauri()) {
      setIsRecording(false);
      try {
        const audioBlob = await stopNativeRecording();
        const { text } = await transcribeAudio(audioBlob, "recording.wav");
        if (text) {
          handleSend(text, true);
        }
      } catch (err) {
        console.error("Transcription failed:", err);
        setError(
          err?.message?.includes("denied") || err?.toString?.().includes("denied")
            ? "Microphone access denied. Allow Rie-AI under Windows Settings → Privacy → Microphone."
            : "Transcription failed. Please try again."
        );
      }
      return;
    }

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording, handleSend]);

    const handleCancelRequest = useCallback((targetThreadId = null) => {
    // If invoked from onClick, first arg is the event; ignore non-strings
    if (targetThreadId != null && typeof targetThreadId !== 'string') {
      targetThreadId = null;
    }
    const threadId = targetThreadId || threadIdRef.current;
    if (!threadId) return;

    if (abortControllersRef.current[threadId]) {
      abortControllersRef.current[threadId].abort();
      delete abortControllersRef.current[threadId];
    }

    const friendStreamState = friendStreamStateRef.current[threadId];
    if (friendStreamState?.friendId) {
      cancelFriendStream(friendStreamState.friendId, threadId, friendStreamState.streamId).catch((err) =>
        console.error("Failed to cancel friend stream:", err)
      );
      delete friendStreamStateRef.current[threadId];
    }

    // Explicitly cancel on backend
    cancelChat(threadId).catch(err => console.error("Failed to cancel on backend:", err));

    // Stop audio (only if cancelling current thread or shared audio)
    if (threadId === threadIdRef.current) {
      stopSpeech();
    }

    // Restore input if it's the current thread
    if (threadId === threadIdRef.current) {
      const lastSent = lastSentInputsRef.current[threadId];
      if (lastSent?.text !== undefined) {
        setInput(lastSent.text);
      }
      if (lastSent?.image_url !== undefined) {
        setAttachedImage(lastSent.image_url);
      }
    }

    // Remove messages from UI
    setSessions((prev) => {
      const newSessions = { ...prev };
      const ids = lastTurnIdsRef.current[threadId];
      if (threadId && newSessions[threadId] && ids) {
        newSessions[threadId] = newSessions[threadId].filter(m =>
          m.id !== ids.userMessageId &&
          m.id !== ids.botMessageId
        );
      }
      return newSessions;
    });

    setStreamingThreads(prev => {
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });

    if (threadId === threadIdRef.current) {
      setCurrentTool(null);
    }

    delete lastTurnIdsRef.current[threadId];
    delete lastSentInputsRef.current[threadId];
    // Clear any pending HITL action for this thread only
    setPendingActions(prev => {
      if (!prev[threadId]) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  }, []);

  const handleActionDecision = useCallback(async (decisions) => {
    if (decisions && decisions[0]?.type === "chat") {
      textareaRef.current?.focus();
      return;
    }
    const threadId = threadIdRef.current;
    if (!threadId || !pendingActions[threadId]) return;

    // Stop and reset any ongoing audio and buffers before resuming after HITL
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    sentenceBufferRef.current = "";
    accumulatedTextRef.current = "";

    // Clear pending HITL for this thread; other threads may still have pending actions
    setPendingActions(prev => {
      if (!prev[threadId]) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
    setStreamingThreads(prev => new Set(prev).add(threadId));
    setError(null);

    const token = localStorage.getItem('rie_token');
    const isVoice = voiceReplyRef.current;

    const controller = new AbortController();
    abortControllersRef.current[threadId] = controller;
    const signal = controller.signal;

    try {
      const ids = lastTurnIdsRef.current[threadId];
      const botMessageId = ids ? ids.botMessageId : Date.now();
      const userMessageId = ids ? ids.userMessageId : null;

      await resumeChat(
        threadId,
        decisions,
        (data) => processStreamChunk(data, botMessageId, threadId, userMessageId),
        () => {
          setStreamingThreads(prev => {
            const next = new Set(prev);
            next.delete(threadId);
            return next;
          });
          setCurrentTool(null);
          delete abortControllersRef.current[threadId];
          window.dispatchEvent(new CustomEvent("rie-schedule-refresh"));
        },
        (err) => {
          setError(err.message || "Failed to resume chat");
          setStreamingThreads(prev => {
            const next = new Set(prev);
            next.delete(threadId);
            return next;
          });
          setCurrentTool(null);
          delete abortControllersRef.current[threadId];
          window.dispatchEvent(new CustomEvent("rie-schedule-refresh"));
        },
        signal,
        isVoice,
        projectRoot,
        token,
        chatMode,
        speedMode
      );
    } catch (err) {
      console.error("Resume error:", err);
    }
  }, [pendingActions, projectRoot, processStreamChunk, chatMode, speedMode]);

  const showPrivacyToast = useCallback((type) => {
    setPrivacyToast({
      show: true,
      type, // 'enabled' | 'disabled' | 'hold_hint'
      id: Date.now(),
    });
  }, []);

  const enableScreenPrivacy = useCallback(async () => {
    justEnabledTimeRef.current = Date.now();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_window_capture_excluded", { exclude: true });
    } catch (e) {
      console.error("Failed to set window capture excluded:", e);
    }
    setSettings((prev) => ({ ...prev, exclude_from_capture: true }));
    updateSetting("EXCLUDE_FROM_CAPTURE", "true").catch(() => {});
    showPrivacyToast("enabled");
  }, [showPrivacyToast]);

  const disableScreenPrivacy = useCallback(async () => {
    justDisabledTimeRef.current = Date.now();
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_window_capture_excluded", { exclude: false });
    } catch (e) {
      console.error("Failed to disable window capture excluded:", e);
    }
    setSettings((prev) => ({ ...prev, exclude_from_capture: false }));
    updateSetting("EXCLUDE_FROM_CAPTURE", "false").catch(() => {});
    showPrivacyToast("disabled");
  }, [showPrivacyToast]);

  const handlePrivacyShortcutPress = useCallback(() => {
    const now = Date.now();
    // Cooldown protection: ignore press if privacy was just disabled within 800ms (prevents release/bounce re-enabling)
    if (now - justDisabledTimeRef.current < 800) {
      return;
    }
    if (now - justEnabledTimeRef.current < 400) {
      return;
    }

    const isCurrentlyExcluded = settings.exclude_from_capture !== false;
    
    if (!isCurrentlyExcluded) {
      // Screen privacy is OFF -> Pressing key is enough to ENABLE immediately!
      enableScreenPrivacy();
    } else {
      // Screen privacy is ON -> Must HOLD key for 1s to DISABLE!
      if (isPrivacyHoldingRef.current) return;
      isPrivacyHoldingRef.current = true;

      if (privacyHoldTimerRef.current) clearTimeout(privacyHoldTimerRef.current);
      privacyHoldTimerRef.current = setTimeout(() => {
        disableScreenPrivacy();
        isPrivacyHoldingRef.current = false;
        privacyHoldTimerRef.current = null;
      }, 1000);
    }
  }, [settings.exclude_from_capture, enableScreenPrivacy, disableScreenPrivacy]);

  const handlePrivacyShortcutRelease = useCallback(() => {
    const now = Date.now();
    // Ignore release event if privacy was just disabled within 800ms
    if (now - justDisabledTimeRef.current < 800) {
      if (privacyHoldTimerRef.current) {
        clearTimeout(privacyHoldTimerRef.current);
        privacyHoldTimerRef.current = null;
      }
      isPrivacyHoldingRef.current = false;
      return;
    }

    const isCurrentlyExcluded = settings.exclude_from_capture !== false;
    
    if (isCurrentlyExcluded && isPrivacyHoldingRef.current) {
      if (privacyHoldTimerRef.current) {
        // Key released BEFORE 1s hold completed -> Cancel hold & show hint toast
        clearTimeout(privacyHoldTimerRef.current);
        privacyHoldTimerRef.current = null;
        isPrivacyHoldingRef.current = false;
        showPrivacyToast("hold_hint");
      }
    }
  }, [settings.exclude_from_capture, showPrivacyToast]);

  const handleNewChat = useCallback(() => {
    const newThreadId = crypto.randomUUID();
    setSessions(prev => ({ ...prev, [newThreadId]: initialMessages }));
    setActiveThreadId(newThreadId);
    saveThreadId(newThreadId);
    threadIdRef.current = newThreadId;
    setAttachedImage(null);
    loadThreadKnowledge(newThreadId);
    setIsMenuOpen(false);
  }, [loadThreadKnowledge]);

  const handleOpenMessageInNewChat = useCallback(async (message) => {
    if (!message || message.from !== "user") return;
    const sourceThreadId = activeThreadId;
    const threadMessages = sessions[sourceThreadId] || [];
    const branchMessages = sliceMessagesForBranch(threadMessages, message.id);
    if (branchMessages === null) return;

    const newThreadId = crypto.randomUUID();
    const forkPayloads = messagesToForkPayloads(branchMessages);

    try {
      await forkThread({
        newThreadId,
        sourceThreadId,
        untilMessageId: message.id,
        messages: forkPayloads,
      });
    } catch (err) {
      console.error("Failed to fork thread:", err);
      setError("Failed to branch chat with history.");
      return;
    }

    setSessions((prev) => ({ ...prev, [newThreadId]: branchMessages }));
    setActiveThreadId(newThreadId);
    saveThreadId(newThreadId);
    threadIdRef.current = newThreadId;

    const sourceMeta =
      friendThreadMeta[sourceThreadId] || friendThreadMeta[String(sourceThreadId)];
    if (sourceMeta) {
      persistFriendMeta((prev) => ({
        ...prev,
        [newThreadId]: { ...sourceMeta },
      }));
    }

    setAttachedImage(message.image_url || null);
    setInput(message.text || "");
    setIsMenuOpen(false);
  }, [activeThreadId, sessions, friendThreadMeta, persistFriendMeta]);

  const handleSelectThread = useCallback(async (threadId) => {
    if (!threadId) return;
    setIsHistoryOpen(false); // Close drawer if open
    setAttachedImage(null);
    setError(null);

    // Update active state immediately to provide feedback
    setActiveThreadId(threadId);
    threadIdRef.current = threadId;

    saveThreadId(threadId);

    loadThreadKnowledge(threadId);

    // If session already exists in memory and not empty, don't refetch
    if (sessions[threadId] && sessions[threadId].length > 0) {
      return;
    }

    setStreamingThreads(prev => new Set(prev).add(threadId)); // Use as loading indicator
    try {
      const msgs = await getThreadMessages(threadId);
      const mergedMeta = mergeFriendMetaFromHistoryRows(friendThreadMeta, msgs);
      if (Object.keys(mergedMeta).length !== Object.keys(friendThreadMeta).length) {
        setFriendThreadMeta(mergedMeta);
        saveFriendThreadMeta(mergedMeta);
      }
      if (msgs && msgs.length > 0) {
        const formatted = msgs.map(m => ({
          id: m.id,
          from: m.role === 'user' ? 'user' : 'bot',
          text: m.content,
          image_url: m.image_url,
          blocks: m.role !== 'user' ? parseMessageContentToBlocks(m.content) : undefined
        }));
        setSessions(prev => ({ ...prev, [threadId]: formatted }));
      } else {
        // For new or empty threads, ensure they have initialMessages
        setSessions(prev => ({ ...prev, [threadId]: initialMessages }));
      }
    } catch (e) {
      console.error("Failed to load thread:", e);
      setError("Failed to load thread history.");
      setSessions(prev => ({ ...prev, [threadId]: initialMessages }));
    } finally {
      setStreamingThreads(prev => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  }, [sessions, friendThreadMeta, loadThreadKnowledge]);

  const handleDeleteThread = useCallback(async (threadId) => {
    if (!threadId) return;
    try {
      await deleteThread(threadId);
    } catch (err) {
      // Local-only threads will not exist in backend history.
      console.warn("Backend delete skipped/failed, removing local thread:", err?.message || err);
    } finally {
      setSessions((prev) => {
        const next = { ...prev };
        delete next[threadId];
        delete next[String(threadId)];
        return next;
      });
      persistFriendMeta((prev) => {
        const next = { ...prev };
        delete next[threadId];
        delete next[String(threadId)];
        return next;
      });
      if (threadIdRef.current === threadId || activeThreadId === threadId) {
        handleNewChat();
      }
    }
  }, [activeThreadId, handleNewChat, persistFriendMeta]);

  const handleClearAllHistory = useCallback(async () => {
    try {
      await clearAllHistory();
    } catch (err) {
      console.error("Failed to clear all history:", err);
    } finally {
      // Abort all active streams
      Object.values(abortControllersRef.current).forEach(c => c.abort());
      abortControllersRef.current = {};
      
      setStreamingThreads(new Set());
      persistFriendMeta({});
      
      // Generate a new thread ID
      const newThreadId = crypto.randomUUID();
      setSessions({ [newThreadId]: initialMessages });
      setActiveThreadId(newThreadId);
      saveThreadId(newThreadId);
      threadIdRef.current = newThreadId;
      setAttachedImage(null);
      loadThreadKnowledge(newThreadId);
    }
  }, [persistFriendMeta, loadThreadKnowledge]);

  const handleSelectFriendChat = useCallback(async (threadId, friend) => {
    if (!threadId || !friend) return;
    handleAssignFriendToThread(threadId, friend);
    await handleSelectThread(threadId);
  }, [handleAssignFriendToThread, handleSelectThread]);

  const handleScheduleMarkRead = useCallback(async (id) => {
    if (!id) return;
    try {
      await markScheduleNotificationRead(id);
    } catch (e) {
      console.error(e);
    }
    setScheduleNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const handleScheduleMarkAllRead = useCallback(async () => {
    try {
      await markAllScheduleNotificationsRead();
    } catch (e) {
      console.error(e);
    }
    setScheduleNotifications([]);
  }, []);

  const handleScheduleOpenChat = useCallback(
    async (notif) => {
      try {
        if (notif?.id) await markScheduleNotificationRead(notif.id);
      } catch (e) {
        console.error(e);
      }
      setScheduleNotifications((prev) => prev.filter((n) => n.id !== notif.id));
      if (notif?.thread_id) {
        await handleSelectThread(notif.thread_id);
      }
    },
    [handleSelectThread]
  );

  const handleDownloadUpdate = useCallback(async () => {
    if (!availableUpdate) return;
    try {
      setUpdateDownloading(true);
      setUpdateDownloadProgress(0);
      await downloadAppUpdate(availableUpdate, (downloaded, total) => {
        const percent = total ? Math.round((downloaded / total) * 100) : 0;
        setUpdateDownloadProgress(percent);
      });
      setUpdateDownloading(false);
      setUpdateDownloaded(true);
      setShowInstallDialog(true);

      try {
        const { emit } = await import("@tauri-apps/api/event");
        await emit("update-status-changed", { status: "downloaded", version: availableUpdate.version });
      } catch (e) {
        console.warn("Failed to emit update download status:", e);
      }
      try {
        const granted = await isPermissionGranted();
        if (granted) {
          sendNotification({
            title: "Rie-AI Update Downloaded",
            body: `Version ${availableUpdate.version} is ready to install.`,
          });
        }
      } catch (e) {
        console.warn("Failed to send download complete notification:", e);
      }
    } catch (err) {
      console.error("Update download failed:", err);
      setUpdateDownloading(false);
    }
  }, [availableUpdate]);

  const handleInstallUpdate = useCallback(async () => {
    if (!availableUpdate) return;
    try {
      await installDownloadedUpdate(availableUpdate);
    } catch (err) {
      console.error("Install failed:", err);
    }
  }, [availableUpdate]);
  //#endregion

  //#region useEffects
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (windowMode !== "floating") {
      setIsFloatingScheduleOpen(false);
      setIsFloatingFriendsOpen(false);
    }
  }, [windowMode]);

  useEffect(() => {
    let cancelled = false;
    const ensureNotificationPermission = async () => {
      try {
        const granted = await isPermissionGranted();
        if (cancelled || granted) return;
        await requestPermission();
      } catch (e) {
        console.warn("Notification permission check failed:", e);
      }
    };
    ensureNotificationPermission();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (apiStatus !== "online" || isSettingsOpen || showWelcome) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const list = await getScheduleNotifications();
        if (cancelled) return;
        const next = Array.isArray(list) ? list : [];
        let hasNewScheduleNotification = false;

        if (!scheduleNotifInitializedRef.current) {
          scheduleNotifInitializedRef.current = true;
          scheduleNotifSeenIdsRef.current = new Set(next.map((n) => n.id));
          setScheduleNotifications(next);
          setScheduleNotificationLog(mergeScheduleNotificationLog([], next));
          return;
        }

        for (const n of next) {
          if (!scheduleNotifSeenIdsRef.current.has(n.id)) {
            hasNewScheduleNotification = true;
            try {
              const granted = await isPermissionGranted();
              if (granted) {
                sendNotification({
                  title: n.title || "Scheduled task completed",
                  body: (n.body || "").slice(0, 200),
                  // These are best-effort across platforms.
                  ongoing: true,
                  sound: "default",
                });
              }
              playScheduleAlertSound();
            } catch (e) {
              console.warn("Desktop notification failed:", e);
            }
          }
        }

        if (hasNewScheduleNotification) {
          try {
            if (windowMode === "floating") {
              if (!isOpen) {
                await handleOpen();
              } else {
                const win = getWindow();
                await win.setFocus();
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  await invoke("set_foreground_lock", { lock: true });
                } catch (e) {
                  console.error("Failed to lock foreground on schedule notification:", e);
                }
              }
            } else {
              const win = getWindow();
              await win.show();
              await win.unminimize();
              await win.setFocus();
              try {
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("set_foreground_lock", { lock: true });
              } catch (e) {
                console.error("Failed to lock foreground on schedule notification:", e);
              }
            }
          } catch (e) {
            console.warn("Failed to open/focus window for schedule notification:", e);
          }
        }

        scheduleNotifSeenIdsRef.current = new Set(next.map((n) => n.id));
        setScheduleNotifications(next);
        setScheduleNotificationLog((prev) => mergeScheduleNotificationLog(prev, next));
      } catch (e) {
        console.warn("Schedule notifications poll:", e);
      }
    };

    poll();
    const id = setInterval(poll, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [apiStatus, isSettingsOpen, showWelcome, windowMode, isOpen, handleOpen, getWindow]);

  useEffect(() => {
    prevThreadScheduleNotifIdsRef.current = new Set();
  }, [activeThreadId]);

  // If a scheduled task completes for the thread you're viewing, pull new messages.
  useEffect(() => {
    if (!activeThreadId) return;
    const forThread = scheduleNotifications.filter((n) => n.thread_id === activeThreadId);
    const ids = new Set(forThread.map((n) => n.id));
    const newIds = [...ids].filter((id) => !prevThreadScheduleNotifIdsRef.current.has(id));
    prevThreadScheduleNotifIdsRef.current = ids;
    if (newIds.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const msgs = await getThreadMessages(activeThreadId);
        if (cancelled || !msgs?.length) return;
        const formatted = msgs.map((m) => ({
          id: m.id,
          from: m.role === "user" ? "user" : "bot",
          text: m.content,
          image_url: m.image_url,
          blocks: m.role !== "user" ? parseMessageContentToBlocks(m.content) : undefined,
        }));
        setSessions((prev) => ({ ...prev, [activeThreadId]: formatted }));
      } catch (e) {
        console.warn("Refresh thread after schedule:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scheduleNotifications, activeThreadId]);

  // Auto-resize textarea (max height matches ChatInputArea max-h-[280px])
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 280)}px`;
    };
  }, [input]);

  // Handle closing menu on outside click or Escape
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleEvents = (e) => {
      if (e.type === "click" || (e.type === "keydown" && e.key === "Escape")) {
        setIsMenuOpen(false);
      }
    };
    // Timeout prevents the opening click from immediately closing the menu
    const timer = setTimeout(() => {
      window.addEventListener("click", handleEvents);
      window.addEventListener("keydown", handleEvents);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", handleEvents);
      window.removeEventListener("keydown", handleEvents);
    };
  }, [isMenuOpen]);

  // Auto-focus textarea when opening chat or normal mode
  useEffect(() => {
    if (isOpen) {
      // We don't check textareaRef.current here because it's null during bubble exit (AnimatePresence mode="wait")
      // Timeout: Bubble exit (200ms) + buffer to ensure textarea is mounted and animation is smooth
      const timer = setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus();
        } else {
          // Fallback in case mounting takes longer or other race conditions
          setTimeout(() => textareaRef.current?.focus(), 200);
        }
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isOpen, windowMode]);


  // Handle Window Mode application
  useEffect(() => {
    const applyWindowMode = async () => {
      try {
        const win = getWindow();
        const { currentMonitor, LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");
        const isNormal = windowMode === "normal" && !isAppInitializing;
        console.log(`Applying window mode: ${windowMode}${isAppInitializing ? " (loading)" : ""}`);

        const centerNormalWindow = async () => {
          try {
            const monitor = await currentMonitor();
            if (monitor) {
              const workArea = monitor.workAreaSize || monitor.size;
              const scale = monitor.scaleFactor || 1;
              const screenWidth = workArea.width / scale;
              const screenHeight = workArea.height / scale;
              const cx = Math.max(0, Math.round((screenWidth - WINDOW_SIZES.NORMAL.width) / 2));
              const cy = Math.max(0, Math.round((screenHeight - WINDOW_SIZES.NORMAL.height) / 2));
              await win.setPosition(new LogicalPosition(cx, cy));
            } else {
              await win.center();
            }
          } catch (e) {
            try { await win.center(); } catch { /* ignore */ }
          }
        };

        if (isNormal) {
          await win.setSize(new LogicalSize(WINDOW_SIZES.NORMAL.width, WINDOW_SIZES.NORMAL.height));
          await centerNormalWindow();
        }

        // Set properties individually to avoid one failure blocking others
        setTimeout(async () => {
          try { await win.setDecorations(false); } catch (e) { console.error("setDecorations error:", e); } // Always frameless
          try { await win.setAlwaysOnTop(!isNormal && !isSettingsOpen && !showWelcome); } catch (e) { console.error("setAlwaysOnTop error:", e); }
          try { await win.setSkipTaskbar(!isNormal && !isSettingsOpen && !showWelcome); } catch (e) { console.error("setSkipTaskbar error:", e); }
          try { await win.setResizable(isNormal); } catch (e) { console.error("setResizable error:", e); }
          try { await win.setShadow(isNormal); } catch (e) { console.error("setShadow error:", e); }

          console.log("Clearing window effects for all modes");
          try {
            await win.setEffects({
              effects: [],
              color: [0, 0, 0, 0]
            });
          } catch (e) {
            console.error("clearEffects error:", e);
          }

          if (isNormal) {
            await centerNormalWindow();
          }
        }, 150);

        if (isNormal) {
          // If we are currently in bubble mode, open it (skip during loading)
          if (!isAppInitializing && !isOpenRef.current) {
            setIsOpen(true);
          }
        }
      } catch (err) {
        console.error("Failed to apply window mode:", err);
      }
    };
    applyWindowMode();
  }, [windowMode, getWindow, isSettingsOpen, showWelcome, isAppInitializing]);

  // Dynamic window resizing for bubble size, label & toast in Bubble Mode
  const prevBubbleWidthRef = useRef(180);
  useEffect(() => {
    if (windowMode !== "floating" || isOpen || isAppInitializing) return;

    const adjustBubbleWindow = async () => {
      try {
        const win = getWindow();
        const { currentMonitor, LogicalPosition, LogicalSize } = await import("@tauri-apps/api/window");

        const showLabel = settings.bubble_show_label !== false && settings.bubble_show_label !== "false";
        const sizeMode = settings.bubble_size || "medium";

        let baseWidth = 180;
        let baseHeight = 50;

        if (sizeMode === "small") {
          baseWidth = showLabel ? 140 : 54;
          baseHeight = 44;
        } else if (sizeMode === "large") {
          baseWidth = showLabel ? 215 : 78;
          baseHeight = 62;
        } else {
          baseWidth = showLabel ? 180 : 66;
          baseHeight = 54;
        }

        const isToastActive = privacyToast?.show;
        const targetWidth = isToastActive
          ? (privacyToast.type === "hold_hint" ? 250 : 220)
          : baseWidth;
        const targetHeight = baseHeight;

        if (targetWidth !== prevBubbleWidthRef.current) {
          const delta = targetWidth - prevBubbleWidthRef.current;
          prevBubbleWidthRef.current = targetWidth;

          if (side === "right") {
            try {
              const pos = await win.position();
              const monitor = await currentMonitor();
              const scale = monitor?.scaleFactor || 1;
              const curX = pos.x / scale;
              const curY = pos.y / scale;
              await win.setPosition(new LogicalPosition(curX - delta, curY));
            } catch (e) { /* ignore */ }
          }

          await win.setSize(new LogicalSize(targetWidth, targetHeight));
        }
      } catch (err) {
        console.warn("Failed to adjust bubble window size:", err);
      }
    };

    adjustBubbleWindow();
  }, [privacyToast, windowMode, isOpen, isAppInitializing, side, getWindow, settings.bubble_show_label, settings.bubble_size]);

  // Global mouse event handling
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current && !isOpen && windowMode === "floating") {
        isDraggingRef.current = false;
        if (settings.bubble_snap_edge !== false) {
          setTimeout(() => snapToNearestEdge(), 150);
        }
      } else {
        isDraggingRef.current = false;
      }
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, [isOpen, snapToNearestEdge, settings.bubble_snap_edge]);

  // Listen for deep links
  useEffect(() => {
    let unlistenPromise;
    const setupListener = async () => {
      unlistenPromise = listen("deep-link", (event) => {
        const urlString = event.payload;
        if (urlString && urlString.includes("auth")) {
          try {
            const url = new URL(urlString);
            const token = url.searchParams.get("token");
            if (token) {
              localStorage.setItem("rie_token", token);
              updateSetting("RIE_ACCESS_TOKEN", token).then(() => {
                checkApiHealth().then(health => setApiStatus(health?.agent_configured ? "online" : "offline"));
              });
            }
          } catch (e) {
            console.error("Deep link parse error:", e);
          }
        }
      });
    };
    setupListener();
    return () => {
      if (unlistenPromise) {
        unlistenPromise.then(unlisten => unlisten());
      }
    };
  }, []);

  // Check for updates on mount — show OS notification + banner (not popup)

  useEffect(() => {
    const triggerUpdateCheck = async () => {
      // Small delay to let initial animations settle
      setTimeout(async () => {
        const update = await checkForAppUpdate();
        if (update) {
          setAvailableUpdate(update);
          setUpdateDownloaded(false);
          setUpdateBannerDismissed(false);
          setShowInstallDialog(false);

          // Send OS notification so user is aware even if app is in background
          try {
            const granted = await isPermissionGranted();
            if (granted) {
              sendNotification({
                title: "Rie-AI Update Available",
                body: `Version ${update.version} is ready to download.`,
              });
            }
          } catch (e) {
            console.warn("Failed to send update notification:", e);
          }

          // Emit event so Settings window can pick it up
          try {
            const { emit } = await import("@tauri-apps/api/event");
            await emit("update-status-changed", { status: "available", version: update.version });
          } catch (e) {
            console.warn("Failed to emit update status:", e);
          }
        }
      }, 3000);
    };
    triggerUpdateCheck();
  }, []);

  // Load history and thread ID on mount
  useEffect(() => {
    const initChat = async () => {
      let normalizedMeta = normalizeFriendMetaMap(getFriendThreadMeta());
      try {
        const historyRows = await getHistory();
        normalizedMeta = mergeFriendMetaFromHistoryRows(normalizedMeta, historyRows);
      } catch (e) {
        console.warn("Failed to hydrate friend metadata from history:", e);
      }
      setFriendThreadMeta(normalizedMeta);
      saveFriendThreadMeta(normalizedMeta);
      let storedThreadId = getStoredThreadId();
      if (storedThreadId) {
        try {
          const msgs = await getThreadMessages(storedThreadId);
          const hydrated = mergeFriendMetaFromHistoryRows(normalizedMeta, msgs);
          if (Object.keys(hydrated).length !== Object.keys(normalizedMeta).length) {
            setFriendThreadMeta(hydrated);
            saveFriendThreadMeta(hydrated);
            normalizedMeta = hydrated;
          }
          if (msgs && msgs.length > 0) {
            const formatted = msgs.map(m => ({
              id: m.id,
              from: m.role === 'user' ? 'user' : 'bot',
              text: m.content,
              image_url: m.image_url,
              blocks: m.role !== 'user' ? parseMessageContentToBlocks(m.content) : undefined
            }));
            setSessions(prev => ({ ...prev, [storedThreadId]: formatted }));
            setActiveThreadId(storedThreadId);
            threadIdRef.current = storedThreadId;
            loadThreadKnowledge(storedThreadId);
            return;
          }
        } catch (e) {
          console.error("Failed to load thread", e);
        }
      }

      // If no stored ID or failed to load, start new
      const newId = crypto.randomUUID();
      saveThreadId(newId);
      threadIdRef.current = newId;
      setActiveThreadId(newId);
      setSessions(prev => ({ ...prev, [newId]: initialMessages }));
    };
    initChat();
  }, []);

  // Window-wide native drag and drop listeners
  useEffect(() => {
    let unlistenDrop;
    let unlistenEnter;
    let unlistenLeave;

    const setupListeners = async () => {
      unlistenDrop = await listen("tauri://drag-drop", (event) => {
        setIsWindowDraggingFile(false);
        const paths = event.payload.paths;
        if (paths && paths.length > 0) {
          processFilePath(paths[0]);
        }
      });

      unlistenEnter = await listen("tauri://drag-enter", () => {
        if (!isLoading) setIsWindowDraggingFile(true);
      });

      unlistenLeave = await listen("tauri://drag-leave", () => {
        setIsWindowDraggingFile(false);
      });
    };

    setupListeners();

    return () => {
      if (unlistenDrop) unlistenDrop();
      if (unlistenEnter) unlistenEnter();
      if (unlistenLeave) unlistenLeave();
    };
  }, [processFilePath, isLoading]);

  // Listen for settings-updated events from settings window
  useEffect(() => {
    const unlistenPromise = listen("settings-updated", (event) => {
      const { key, value } = event.payload;
      const field = key.toLowerCase();
      const isBoolKey = [
        'SHARE_LOCATION', 'EXCLUDE_FROM_CAPTURE', 'VOICE_REPLY', 'HITL_ENABLED',
        'LANGSMITH_TRACING', 'CONNECTIVITY_NGROK_ENABLED', 'SHOW_BUBBLE',
        'CAPTURE_SCREEN_AS_TEXT', 'BUBBLE_SHOW_LABEL', 'BUBBLE_TRANSPARENT_BG',
        'BUBBLE_SNAP_EDGE', 'BUBBLE_SHOW_TOOLS'
      ].includes(key);

      const parsedValue = isBoolKey
        ? (value === 'true' || value === true)
        : value;

      setSettings((prev) => ({ ...prev, [field]: parsedValue }));

      if (key === 'EXCLUDE_FROM_CAPTURE') {
        const applyAffinity = async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_window_capture_excluded", { exclude: parsedValue });
            showPrivacyToast(parsedValue ? "enabled" : "disabled");
          } catch (e) {
            console.error("Failed to update capture affinity in main window:", e);
          }
        };
        applyAffinity();
      } else if (key === 'SHARE_LOCATION') {
        setShareLocationEnabled(parsedValue);
        if (parsedValue) {
          prefetchClientLocation();
        }
      } else if (key === 'WINDOW_MODE') {
        setWindowMode(parsedValue);
      } else if (key === 'CHAT_MODE') {
        setChatMode(parsedValue);
      } else if (key === 'SPEED_MODE') {
        setSpeedMode(parsedValue);
      } else if (key === 'VOICE_REPLY') {
        voiceReplyRef.current = parsedValue;
      } else if (key === 'TTS_PROVIDER') {
        ttsProviderRef.current = parsedValue;
      } else if (key === 'TTS_VOICE') {
        ttsVoiceRef.current = parsedValue;
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Listen for tray show events
  useEffect(() => {
    let unlisten;
    const setupListener = async () => {
      try {
        unlisten = await listen("tray-show", () => {
          handleOpen();
        });
      } catch (err) {
        console.error("Failed to listen to tray-show:", err);
      }
    };
    setupListener();
    return () => {
      if (unlisten) unlisten();
    };
  }, [handleOpen]);


  // Initial configuration and window mode check
  useEffect(() => {
    const initConfig = async () => {
      const startTime = Date.now();
      try {
        // Fetch Security Token from Tauri first (doesn't depend on backend)
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const token = await invoke("get_app_token");
          setAppToken(token);
        } catch (e) {
          console.error("Failed to fetch app token:", e);
        }

        // Wait for backend to be responsive
        let isBackendReady = false;
        let attempts = 0;
        while (!isBackendReady) {
          try {
            await checkApiHealth();
            isBackendReady = true;
          } catch (e) {
            attempts++;
            // Log every 5 seconds to avoid flooding console
            if (attempts % 25 === 0) {
              console.log("Waiting for backend to wake up...");
            }
            await new Promise(r => setTimeout(r, 200));
          }
        }

        const settingsData = await getSettings();
        setSettings(settingsData);
        const settings = settingsData;
        const hasAnyKey = settings.google_api_key ||
          settings.groq_api_key ||
          settings.vertex_project ||
          settings.openai_api_key ||
          settings.deepseek_api_key ||
          settings.glm_api_key ||
          settings.anthropic_api_key;

        if (!settings.llm_provider && !hasAnyKey) {
          setShowWelcome(true);
        }

        if (settings.window_mode) {
          setWindowMode(settings.window_mode);
        }

        if (settings.chat_mode) {
          setChatMode(settings.chat_mode);
        }

        if (settings.speed_mode) {
          setSpeedMode(settings.speed_mode);
        }

        if (settings.hasOwnProperty('voice_reply')) {
          voiceReplyRef.current = settings.voice_reply;
        }

        if (settings.hasOwnProperty('share_location')) {
          setShareLocationEnabled(settings.share_location);
          if (settings.share_location) {
            prefetchClientLocation();
          }
        }

        if (settings.hasOwnProperty('exclude_from_capture')) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("set_window_capture_excluded", { exclude: settings.exclude_from_capture });
          } catch (e) {
            console.error("Failed to apply capture exclusion preference:", e);
          }
        }

        if (settings.tts_provider) {
          ttsProviderRef.current = settings.tts_provider;
        }

        if (settings.tts_voice) {
          ttsVoiceRef.current = settings.tts_voice;
        }

        // Smooth minimal transition delay
        const elapsed = Date.now() - startTime;
        const remainingDelay = Math.max(0, 300 - elapsed);
        setTimeout(() => {
          setIsAppInitializing(false);
        }, remainingDelay);
      } catch (err) {
        console.error("Init check failed:", err);
        setIsAppInitializing(false);
      }
    };
    initConfig();
  }, []); // Only run once on mount

  useEffect(() => {
    if (!isSettingsOpen && !isAppInitializing) {
      const reloadSettings = async () => {
        try {
          const settingsData = await getSettings();
          setSettings(settingsData);
          const settings = settingsData;
          if (settings.hasOwnProperty('voice_reply')) {
            voiceReplyRef.current = settings.voice_reply;
          }
          if (settings.hasOwnProperty('share_location')) {
            setShareLocationEnabled(settings.share_location);
            if (settings.share_location) {
              prefetchClientLocation();
            }
          }
          if (settings.window_mode) {
            setWindowMode(settings.window_mode);
          }
          if (settings.chat_mode) {
            setChatMode(settings.chat_mode);
          }
          if (settings.speed_mode) {
            setSpeedMode(settings.speed_mode);
          }
          if (settings.tts_provider) {
            ttsProviderRef.current = settings.tts_provider;
          }
          if (settings.tts_voice) {
            ttsVoiceRef.current = settings.tts_voice;
          }
        } catch (err) {
          console.error("Failed to reload settings:", err);
        }
      };
      reloadSettings();
    }
  }, [isSettingsOpen, isAppInitializing]);

  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  useEffect(() => {
    if (input.includes("/") && friends.length === 0) {
      loadFriends();
    }
  }, [input, friends.length, loadFriends]);

  // Force chat mode if using Rie provider (or if LLM provider is unset/default)
  useEffect(() => {
    const provider = settings?.llm_provider || 'rie';
    if (provider === 'rie' && chatMode === 'agent') {
      setChatMode('chat');
    }
  }, [settings?.llm_provider, chatMode]);

  // Persist chatMode to backend when it changes
  useEffect(() => {
    if (isAppInitializing) return;
    updateSetting("CHAT_MODE", chatMode).catch(err =>
      console.error("Failed to save chat mode:", err)
    );
  }, [chatMode, isAppInitializing]);

  // Persist speedMode to backend when it changes
  useEffect(() => {
    if (isAppInitializing) return;
    updateSetting("SPEED_MODE", speedMode).catch(err =>
      console.error("Failed to save speed mode:", err)
    );
  }, [speedMode, isAppInitializing]);

  const handleSelectProvider = async (newProvider) => {
    setSettings((prev) => ({ ...prev, llm_provider: newProvider }));
    try {
      await updateSetting("LLM_PROVIDER", newProvider);
    } catch (err) {
      console.error("Failed to save LLM provider setting:", err);
    }
  };

  const handleUpdateSetting = async (key, value) => {
    const fieldMap = {
      GEMINI_MODEL: "gemini_model",
      OPENAI_MODEL: "openai_model",
      DEEPSEEK_MODEL: "deepseek_model",
      GLM_MODEL: "glm_model",
      GROQ_MODEL: "groq_model",
      OLLAMA_MODEL: "ollama_model",
      VERTEX_MODEL: "vertex_model",
    };
    if (fieldMap[key]) {
      setSettings((prev) => ({ ...prev, [fieldMap[key]]: value }));
    }
    try {
      await updateSetting(key, value);
    } catch (err) {
      console.error(`Failed to update ${key} setting:`, err);
    }
  };

  // Polling mechanism for health status
  useEffect(() => {
    let pollInterval;
    const checkStatus = async () => {
      try {
        const health = await checkApiHealth().catch(() => ({ agent_configured: false }));
        setApiStatus(health.agent_configured ? "online" : "offline");
      } catch (err) {
        setApiStatus("offline");
      }
    };

    // Run immediately
    checkStatus();

    // Set up interval that respects idle state
    if (!isLoading) {
      pollInterval = setInterval(checkStatus, 5000);
    }

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [isLoading]);

  // Handle Window Resizing for Settings & Welcome (skip during loading - applyWindowMode handles it)
  useEffect(() => {
    if (isAppInitializing) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const win = getWindow();
        if (cancelled) return;
        if (isSettingsOpen || showWelcome) {
          await win.setSize(new LogicalSize(WINDOW_SIZES.SETTINGS.width, WINDOW_SIZES.SETTINGS.height));
        } else if (isOpen) {
          // Restore chat size if window is open (not bubble)
          const size = windowMode === "normal" ? WINDOW_SIZES.NORMAL : WINDOW_SIZES.CHAT;
          await win.setSize(new LogicalSize(size.width, size.height));
        }
      } catch (err) {
        console.error("Failed to resize window:", err);
      }
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isAppInitializing, isSettingsOpen, showWelcome, isOpen, getWindow, windowMode]);

  // Auto-scroll to bottom when messages change or window state shifts
  useEffect(() => {
    if (isOpen && !isSettingsOpen && !showWelcome) {
      if (streamingThreads.size > 0) {
        // Direct non-blocking scroll during active streaming
        if (messagesEndRef.current) {
          const scrollContainer = messagesEndRef.current.closest('.overflow-y-auto') || messagesEndRef.current.parentElement;
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
        }
        return;
      }
      const timer = setTimeout(() => {
        if (messagesEndRef.current) {
          const scrollContainer = messagesEndRef.current.closest('.overflow-y-auto') || messagesEndRef.current.parentElement;
          if (scrollContainer) {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: "smooth"
            });
          }
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, sessions, activeThreadId, isSettingsOpen, showWelcome, streamingThreads.size]);

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      if (clearConfirmTimerRef.current)
        clearTimeout(clearConfirmTimerRef.current);
      if (positionCheckIntervalRef.current)
        clearInterval(positionCheckIntervalRef.current);
      // Ensure any active SSE is closed on unmount
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  useEffect(() => {
    // On Windows, we intercept shortcuts via Raw Input in the backend to hide them from the kiosk
    const isWindows = navigator.userAgent.includes("Windows");
    if (isWindows) return;

    const shortcuts = [
      "Alt+Shift+S",
      "Alt+Shift+C",
      "Alt+Shift+A",
      "Alt+Shift+N",
      "Alt+Shift+V",
      "Alt+Shift+M",
      "Alt+Shift+K",
      "Alt+Shift+F",
      "Alt+Shift+Q",
    ];
    let mounted = true;

    const setupGlobalShortcuts = async () => {
      try {
        // Try to unregister first to avoid "already registered" errors
        for (const shortcut of shortcuts) {
          try { await unregister(shortcut); } catch (e) { /* ignore */ }
        }

        if (!mounted) return;

        // Register Global PTT (Hold to Talk)
        await register("Alt+Shift+S", (event) => {
          if (event.state === "Pressed") {
            if (!isGlobalPTTPressedRef.current) {
              isGlobalPTTPressedRef.current = true;
              startRecording();
            }
          } else if (event.state === "Released") {
            isGlobalPTTPressedRef.current = false;
            stopRecording();
          }
        });

        // Register Global Cancel
        await register("Alt+Shift+C", (event) => {
          if (event.state === "Pressed") {
            if (isLoadingRef.current && threadIdRef.current) {
              handleCancelRequest();
            }
          }
        });

        // Register Global Toggle (Chat/Bubble)
        await register("Alt+Shift+A", (event) => {
          if (event.state === "Pressed") {
            if (isOpenRef.current) {
              handleMinimize();
            } else {
              handleOpen();
            }
          }
        });

        // Register Global New Chat
        await register("Alt+Shift+N", (event) => {
          if (event.state === "Pressed") {
            handleNewChat();
            if (!isOpenRef.current) handleOpen();
            setTimeout(() => textareaRef.current?.focus(), 150);
          }
        });

        // Register Global Capture Screen
        await register("Alt+Shift+V", (event) => {
          if (event.state === "Pressed") {
            if (!isOpenRef.current) handleOpen();
            handleCaptureScreen();
          }
        });

        // Register Global Toggle Mic / Mute
        await register("Alt+Shift+M", (event) => {
          if (event.state === "Pressed") {
            if (isRecordingRef.current) stopRecording();
            else startRecording();
          }
        });

        // Register Global Toggle Kiosk
        await register("Alt+Shift+K", (event) => {
          if (event.state === "Pressed") {
            import("@tauri-apps/api/core").then(({ invoke }) => {
              invoke("get_kiosk_overlay_mode").then((cur) => {
                invoke("set_kiosk_overlay_mode", { enabled: !cur });
              });
            });
          }
        });

        // Register Global Focus Input
        await register("Alt+Shift+F", (event) => {
          if (event.state === "Pressed") {
            if (!isOpenRef.current) handleOpen();
            setTimeout(() => textareaRef.current?.focus(), 150);
          }
        });

        // Register Global Privacy Toggle
        await register("Alt+Shift+Q", (event) => {
          if (event.state === "Pressed") {
            handlePrivacyShortcutPress();
          } else if (event.state === "Released") {
            handlePrivacyShortcutRelease();
          }
        });
      } catch (err) {
        console.error("Failed to register global shortcuts:", err);
      }
    };

    setupGlobalShortcuts();

    return () => {
      mounted = false;
      shortcuts.forEach(async (s) => {
        try { await unregister(s); } catch (e) { /* ignore */ }
      });
    };
  }, [startRecording, stopRecording, handleCancelRequest, handleNewChat, handleCaptureScreen, handleOpen, handleMinimize]); // Removed state deps


  // Set small loading window size & center on desktop screen during init
  useEffect(() => {
    if (!isAppInitializing) return;
    const initWindow = async () => {
      try {
        const win = getWindow();
        const { currentMonitor, LogicalPosition } = await import("@tauri-apps/api/window");
        await win.setSize(new LogicalSize(WINDOW_SIZES.LOADING.width, WINDOW_SIZES.LOADING.height));

        const positionCenter = async () => {
          try {
            const monitor = await currentMonitor();
            if (monitor) {
              const workArea = monitor.workAreaSize || monitor.size;
              const scale = monitor.scaleFactor || 1;
              const screenWidth = workArea.width / scale;
              const screenHeight = workArea.height / scale;
              const x = Math.max(0, Math.round((screenWidth - WINDOW_SIZES.LOADING.width) / 2));
              const y = Math.max(0, Math.round((screenHeight - WINDOW_SIZES.LOADING.height) / 2));
              await win.setPosition(new LogicalPosition(x, y));
            } else {
              await win.center();
            }
          } catch (e) {
            try { await win.center(); } catch { /* ignore */ }
          }
        };

        await positionCenter();
        setTimeout(positionCenter, 200);
      } catch { /* Not in Tauri */ }
    };
    initWindow();
  }, [isAppInitializing, getWindow]);

  // Listen for clipboard updates from backend
  useEffect(() => {
    let unlistenClipboard;

    const setup = async () => {
      unlistenClipboard = await listen("clipboard-update", (event) => {
        const text = event.payload;
        if (text && text.trim()) {
          setAttachedClipboardText(text);
          if (clipboardTimeoutRef.current) {
            clearTimeout(clipboardTimeoutRef.current);
          }
          clipboardTimeoutRef.current = setTimeout(() => {
            setAttachedClipboardText(null);
            clipboardTimeoutRef.current = null;
          }, 10000);
        }
      });
    };

    setup();

    return () => {
      if (unlistenClipboard) unlistenClipboard();
      if (clipboardTimeoutRef.current) clearTimeout(clipboardTimeoutRef.current);
    };
  }, []);

  // Listen for kiosk overlay toggle events from backend/settings page
  useEffect(() => {
    let unlistenToggled;
    const setup = async () => {
      try {
        if (window.__TAURI_INTERNALS__) {
          const { invoke } = await import("@tauri-apps/api/core");
          const initialMode = await invoke("get_kiosk_overlay_mode");
          setKioskOverlay(initialMode);
          
          unlistenToggled = await listen("kiosk-overlay-toggled", (event) => {
            console.log("[App] Kiosk overlay toggled event payload:", event.payload);
            setKioskOverlay(event.payload);
          });
        }
      } catch (err) {
        console.error("Failed to set up kiosk overlay listeners:", err);
      }
    };
    setup();
    return () => {
      if (unlistenToggled) unlistenToggled();
    };
  }, []);

  // Listen for kiosk selection updates
  useEffect(() => {
    let unlistenSelection;

    const setup = async () => {
      try {
        unlistenSelection = await listen("kiosk-selection-detected", (event) => {
          const text = event.payload;
          console.log("[App] Kiosk selection event payload:", text);
          if (text && text.trim()) {
            setKioskSelection(text);
          }
        });
      } catch (err) {
        console.error("Failed to register kiosk-selection-detected listener:", err);
      }
    };

    setup();

    return () => {
      if (unlistenSelection) unlistenSelection();
    };
  }, []);

  // Global keyboard hook listener for kiosk mode (stealth input piping)
  // Uses a module-level singleton to guarantee exactly ONE listener exists,
  // even across React StrictMode double-mounts and Vite HMR reloads.
  useEffect(() => {
    // Always clean up any previously leaked listener first
    if (window.__rieKeypressUnlisten) {
      window.__rieKeypressUnlisten();
      window.__rieKeypressUnlisten = null;
    }

    let cancelled = false;

    const setup = async () => {
      const unlisten = await listen("rie-keypress", (event) => {
        // If the document already has OS focus, the browser natively handles the keyboard input.
        // Manually piping raw input in this state causes double-typing.
        if (document.hasFocus()) {
          return;
        }

        const { type, key } = event.payload;
        const textarea = textareaRef.current;
        if (!textarea) return;

        // Nuclear dedup: reject duplicate calls for same key within 30ms.
        // This catches ALL duplication — stacked listeners, HMR leaks, StrictMode, etc.
        if (type === "char" || type === "special") {
          if (!window.__rieLastKeyTime) window.__rieLastKeyTime = {};
          const dedupKey = `${type}:${key}`;
          const now = performance.now();
          if (now - (window.__rieLastKeyTime[dedupKey] || 0) < 30) return;
          window.__rieLastKeyTime[dedupKey] = now;
        }

        // Focus inside WebView's DOM (does not change OS active window)
        textarea.focus();

        if (type === "char") {
          document.execCommand("insertText", false, key);
        } else if (type === "special") {
          if (key === "Backspace") {
            document.execCommand("delete", false);
          } else if (key === "Enter") {
            const submitBtn = document.getElementById("send-btn");
            if (submitBtn) {
              submitBtn.click();
            }
          }
        } else if (type === "shortcut") {
          if (key === "a") {
            textarea.select();
          } else if (key === "v") {
            navigator.clipboard.readText().then((clipText) => {
              document.execCommand("insertText", false, clipText);
              setInput(textarea.value);
            }).catch(() => {});
          } else if (key === "c") {
            const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
            if (selectedText) {
              navigator.clipboard.writeText(selectedText).catch(() => {});
            }
          } else if (key === "x") {
            const selectedText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
            if (selectedText) {
              navigator.clipboard.writeText(selectedText).then(() => {
                document.execCommand("delete", false);
                setInput(textarea.value);
              }).catch(() => {});
            }
          }
        }

        // Sync local React state with the DOM textarea value modified by execCommand
        setInput(textarea.value);
      });

      if (cancelled) {
        // Effect was cleaned up before setup completed — dispose immediately
        unlisten();
      } else {
        window.__rieKeypressUnlisten = unlisten;
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (window.__rieKeypressUnlisten) {
        window.__rieKeypressUnlisten();
        window.__rieKeypressUnlisten = null;
      }
    };
  }, []);

  // Listen for history-cleared event from standalone settings window
  useEffect(() => {
    let unlistenEvent;
    const setupListener = async () => {
      unlistenEvent = await listen("history-cleared", () => {
        // Abort all active streams
        Object.values(abortControllersRef.current).forEach(c => c.abort());
        abortControllersRef.current = {};
        
        setStreamingThreads(new Set());
        persistFriendMeta({});
        
        // Generate a new thread ID
        const newThreadId = crypto.randomUUID();
        setSessions({ [newThreadId]: initialMessages });
        setActiveThreadId(newThreadId);
        saveThreadId(newThreadId);
        threadIdRef.current = newThreadId;
        setAttachedImage(null);
        loadThreadKnowledge(newThreadId);
      });
    };
    setupListener();
    return () => {
      if (unlistenEvent) {
        unlistenEvent();
      }
    };
  }, [persistFriendMeta, loadThreadKnowledge]);

  // Raw Input custom shortcut listeners on Windows (toggle, PTT, cancel, new chat, capture, mute, kiosk, focus)
  useEffect(() => {
    if (!navigator.userAgent.includes("Windows")) return;

    let isCancelled = false;
    const unlistens = [];

    const setup = async () => {
      const u1 = await listen("rie-shortcut-toggle", () => {
        if (isOpenRef.current) {
          handleMinimize();
        } else {
          handleOpen();
        }
      });
      unlistens.push(u1);

      const u2 = await listen("rie-shortcut-ptt", (event) => {
        const state = event.payload;
        if (state === "Pressed") {
          if (!isGlobalPTTPressedRef.current) {
            isGlobalPTTPressedRef.current = true;
            startRecording();
          }
        } else if (state === "Released") {
          isGlobalPTTPressedRef.current = false;
          stopRecording();
        }
      });
      unlistens.push(u2);

      const u3 = await listen("rie-shortcut-cancel", () => {
        if (isLoadingRef.current && threadIdRef.current) {
          handleCancelRequest();
        }
      });
      unlistens.push(u3);

      const u4 = await listen("rie-shortcut-new-chat", () => {
        handleNewChat();
        if (!isOpenRef.current) handleOpen();
        setTimeout(() => textareaRef.current?.focus(), 150);
      });
      unlistens.push(u4);

      const u5 = await listen("rie-shortcut-capture-screen", () => {
        if (!isOpenRef.current) handleOpen();
        handleCaptureScreen();
      });
      unlistens.push(u5);

      const u6 = await listen("rie-shortcut-toggle-mute", () => {
        if (isRecordingRef.current) {
          stopRecording();
        } else {
          startRecording();
        }
      });
      unlistens.push(u6);

      const u7 = await listen("rie-shortcut-toggle-kiosk", async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const mode = await invoke("get_kiosk_overlay_mode");
          await invoke("set_kiosk_overlay_mode", { enabled: !mode });
        } catch (e) {
          console.error("Failed to toggle kiosk mode:", e);
        }
      });
      unlistens.push(u7);

      const u8 = await listen("rie-shortcut-focus-input", () => {
        if (!isOpenRef.current) handleOpen();
        setTimeout(() => textareaRef.current?.focus(), 150);
      });
      unlistens.push(u8);

      const u9 = await listen("rie-shortcut-privacy", (event) => {
        const state = event.payload;
        if (state === "Pressed") {
          handlePrivacyShortcutPress();
        } else if (state === "Released") {
          handlePrivacyShortcutRelease();
        }
      });
      unlistens.push(u9);

      if (isCancelled) {
        unlistens.forEach((fn) => fn && fn());
      }
    };

    setup();

    return () => {
      isCancelled = true;
      unlistens.forEach((fn) => fn && fn());
    };
  }, [startRecording, stopRecording, handleCancelRequest, handleNewChat, handleCaptureScreen, handleOpen, handleMinimize, handlePrivacyShortcutPress, handlePrivacyShortcutRelease]);

  // In-app keydown & keyup shortcuts when focused (Ctrl+Shift+N, Escape, Ctrl+,, Ctrl+Shift+S, Alt+Shift+Q)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Alt + Shift + Q or Ctrl + Shift + Q -> Privacy Toggle
      if ((e.altKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "q") {
        e.preventDefault();
        handlePrivacyShortcutPress();
        return;
      }
      // Escape to minimize/close when floating/open
      if (e.key === "Escape" && isOpenRef.current && !isSettingsOpen && !isHistoryOpen) {
        handleMinimize();
        return;
      }
      // Ctrl + Shift + N -> New Chat
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handleNewChat();
        setTimeout(() => textareaRef.current?.focus(), 100);
        return;
      }
      // Ctrl + , -> Settings
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        handleOpenSettingsWindow();
        return;
      }
      // Ctrl + Shift + S -> Screen Capture
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleCaptureScreen();
        return;
      }
    };

    const handleKeyUp = (e) => {
      if (e.key.toLowerCase() === "q") {
        handlePrivacyShortcutRelease();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [handleMinimize, handleNewChat, handleOpenSettingsWindow, handleCaptureScreen, handlePrivacyShortcutPress, handlePrivacyShortcutRelease, isSettingsOpen, isHistoryOpen]);
  //#endregion

  return (
    <>
      {/* Update Banner — non-blocking top banner */}
      <AnimatePresence>
        {availableUpdate && !updateBannerDismissed && !showInstallDialog && (
          <UpdateBanner
            update={availableUpdate}
            onDownloadComplete={async () => {
              setUpdateDownloaded(true);
              setShowInstallDialog(true);
              // Emit so settings can react
              try {
                const { emit } = await import("@tauri-apps/api/event");
                await emit("update-status-changed", { status: "downloaded", version: availableUpdate.version });
              } catch (e) {
                console.warn("Failed to emit update download status:", e);
              }
              // OS notification that download is done
              try {
                const granted = await isPermissionGranted();
                if (granted) {
                  sendNotification({
                    title: "Rie-AI Update Downloaded",
                    body: `Version ${availableUpdate.version} is ready to install.`,
                  });
                }
              } catch (e) {
                console.warn("Failed to send download complete notification:", e);
              }
            }}
            onDismiss={() => {
              setUpdateBannerDismissed(true);
              setUpdateNotificationDismissed(false);
            }}
          />
        )}
      </AnimatePresence>

      {/* Update Install Dialog — popup only after download completes */}
      <AnimatePresence>
        {showInstallDialog && availableUpdate && updateDownloaded && (
          <UpdateInstallDialog
            update={availableUpdate}
            onRestart={handleInstallUpdate}
            onLater={() => {
              setShowInstallDialog(false);
              setUpdateBannerDismissed(true);
              setUpdateNotificationDismissed(false);
            }}
          />
        )}
      </AnimatePresence>

      <div className={`fixed inset-0 flex items-center pointer-events-none rounded-2xl overflow-hidden ${side === "right" ? "justify-end" : "justify-start"} ${(settings.exclude_from_capture !== false) ? "screen-privacy-active" : ""}`}>
        <AnimatePresence
          mode="wait"
          onExitComplete={async () => {
            if (!isOpen) {
              try {
                const win = getWindow();
                if (settings.show_bubble === false) {
                  await win.hide();
                  return;
                }
                const pos = await getWindowPosition();
                if (side === "right") {
                  const scale = await win.scaleFactor();
                  const outerSize = await win.outerSize();
                  const curW = Math.round(outerSize.width / scale);

                  const showLabel = settings.bubble_show_label !== false && settings.bubble_show_label !== "false";
                  const sizeMode = settings.bubble_size || "medium";
                  let targetBubbleWidth = 180;
                  if (sizeMode === "small") targetBubbleWidth = showLabel ? 140 : 54;
                  else if (sizeMode === "large") targetBubbleWidth = showLabel ? 215 : 78;
                  else targetBubbleWidth = showLabel ? 180 : 66;

                  const rightEdge = pos.x + curW;
                  let targetX = rightEdge - targetBubbleWidth;

                  const screenWidth = window.screen.availWidth;
                  const screenLeft = window.screen.availLeft || 0;
                  const maxAllowedX = screenLeft + screenWidth - targetBubbleWidth;
                  if (targetX > maxAllowedX) targetX = maxAllowedX;
                  if (targetX < screenLeft) targetX = screenLeft;

                  await win.setPosition(new LogicalPosition(targetX, pos.y));
                  await win.setSize(new LogicalSize(targetBubbleWidth, WINDOW_SIZES.BUBBLE.height));
                } else {
                  await win.setSize(new LogicalSize(WINDOW_SIZES.BUBBLE.width, WINDOW_SIZES.BUBBLE.height));
                }

                if (pendingBubblePositionRef.current) {
                  const { x, y } = pendingBubblePositionRef.current;
                  await win.setPosition(new LogicalPosition(x, y));
                  pendingBubblePositionRef.current = null;
                } else if (shouldSnapOnMinimizeRef.current) {
                  setTimeout(() => snapToNearestEdge(), 50);
                }
                shouldSnapOnMinimizeRef.current = true;
              } catch (err) {
                console.error("Failed to resize on close:", err);
              }
            }
          }}
        >
          {isAppInitializing ? (
            <LoadingScreen key="loading" onMouseDown={handleDragStart} onClose={handleCloseApp} onMinimize={() => getWindow().minimize()} />
          ) : windowMode === 'normal' ? (
            <motion.div
              key="normal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pointer-events-auto w-full h-full"
            >
              {showWelcome ? (
                <WelcomeScreen
                  onGetStarted={handleCompleteOnboarding}
                  onMouseDown={handleDragStart}
                  onClose={handleCloseApp}
                  onMinimize={() => getWindow().minimize()}
                />
              ) : isSettingsOpen ? (
                <SettingsPage onClose={() => setIsSettingsOpen(false)} onClearAllHistory={handleClearAllHistory} />
              ) : (
                <>
                  <NormalModeLayout
                    messages={sessions[activeThreadId] || initialMessages}
                    sessionsByThread={sessions}
                    input={input}
                    setInput={setInput}
                    isLoading={isLoading}
                    streamingThreads={streamingThreads}
                    onSend={handleSend}
                    onAnswerQuestion={handleAnswerQuestion}
                    onCancel={handleCancelRequest}
                    onSelectThread={handleSelectThread}
                    onDeleteThread={handleDeleteThread}
                    onClearAllHistory={handleClearAllHistory}
                    onNewChat={handleNewChat}
                    currentThreadId={activeThreadId}
                    onOpenSettings={handleOpenSettingsWindow}
                    onToggleFloating={handleToggleWindowMode}
                    onCloseApp={handleCloseApp}
                    onMinimize={() => getWindow().minimize()}
                    isTerminalOpen={isTerminalOpen}
                    onToggleTerminal={() => setIsTerminalOpen(!isTerminalOpen)}
                    terminalLogs={terminalLogs}
                    apiStatus={apiStatus}
                    messagesEndRef={messagesEndRef}
                    textareaRef={textareaRef}
                    streamingBotMessageId={isLoading ? lastTurnIdsRef.current[activeThreadId]?.botMessageId : null}
                    attachedImage={attachedImage}
                    setAttachedImage={setAttachedImage}
                    isScreenAttached={isScreenAttached}
                    setIsScreenAttached={setIsScreenAttached}
                    projectRoot={projectRoot}
                    projectRootChip={projectRootChip}
                    setProjectRoot={setProjectRoot}
                    setProjectRootChip={setProjectRootChip}
                    onFileUpload={handleFileUpload}
                    attachedFiles={attachedFiles}
                    onRemoveAttachedFile={removeAttachedFile}
                    onCaptureScreen={handleCaptureScreen}
                    onPickProjectPath={handlePickProjectPath}
                    isCapturing={isCapturing}
                    isRecording={isRecording}
                    onStartRecording={startRecording}
                    onStopRecording={stopRecording}
                    onToggleRecording={() => (isRecording ? stopRecording() : startRecording())}
                    isAttachmentPopoverOpen={isAttachmentPopoverOpen}
                    setIsAttachmentPopoverOpen={setIsAttachmentPopoverOpen}
                    attachedClipboardText={attachedClipboardText}
                    setAttachedClipboardText={setAttachedClipboardText}
                    onAttachClipboard={handleAttachClipboard}
                    onDeleteMessage={handleDeleteMessage}
                    onOpenMessageInNewChat={handleOpenMessageInNewChat}
                    isWindowDraggingFile={isWindowDraggingFile}
                    pendingAction={pendingActions[activeThreadId] || null}
                    onActionDecision={handleActionDecision}
                    chatMode={chatMode}
                    setChatMode={setChatMode}
                    speedMode={speedMode}
                    setSpeedMode={setSpeedMode}
                    provider={settings?.llm_provider || 'rie'}
                    onSelectProvider={handleSelectProvider}
                    settings={settings}
                    onUpdateSetting={handleUpdateSetting}
                    onClearTerminal={handleClearTerminal}
                    scheduleNotifications={scheduleNotificationLog}
                    scheduleUnreadCount={scheduleNotifications.length}
                    onScheduleMarkRead={handleScheduleMarkRead}
                    onScheduleMarkAllRead={handleScheduleMarkAllRead}
                    onScheduleOpenChat={handleScheduleOpenChat}
                    availableUpdate={availableUpdate}
                    updateDownloaded={updateDownloaded}
                    updateDownloading={updateDownloading}
                    updateDownloadProgress={updateDownloadProgress}
                    updateBannerDismissed={updateBannerDismissed}
                    updateNotificationDismissed={updateNotificationDismissed}
                    onDownloadUpdate={handleDownloadUpdate}
                    onInstallUpdate={handleInstallUpdate}
                    onDismissUpdateNotification={() => setUpdateNotificationDismissed(true)}
                    friends={friends}
                    friendThreadMeta={friendThreadMeta}
                    activeFriendMeta={(friendThreadMeta[activeThreadId] || friendThreadMeta[String(activeThreadId)] || null)}
                    onSelectFriendChat={handleSelectFriendChat}
                    onStartFriendChat={handleStartFriendChat}
                    attachedKnowledge={attachedKnowledge}
                    onAttachKnowledge={attachKnowledge}
                    onDetachKnowledge={detachKnowledge}
                    retryStatus={retryStatus}
                  />
                </>
              )}
            </motion.div>
          ) : !isOpen ? (
            <FloatingBubble
              key="bubble"
              privacyToast={privacyToast}
              currentTool={currentTool}
              retryStatus={retryStatus}
              isLoading={isLoading}
              isRecording={isRecording}
              hasPendingAction={Object.keys(pendingActions).length > 0} // Any thread has pending HITL
              isSnapping={isSnapping}
              onMouseDown={handleBubbleMouseDown}
              getToolDisplayName={getToolDisplayName}
              bubbleRef={bubbleRef}
              settings={settings}
            />
          ) : (
            <FloatingChatWindow
              key="chat"
              side={side}
              settings={settings}
              showWelcome={showWelcome}
              setShowWelcome={setShowWelcome}
              isSettingsOpen={isSettingsOpen}
              setIsSettingsOpen={setIsSettingsOpen}
              onOpenSettingsWindow={handleOpenSettingsWindow}
              apiStatus={apiStatus}
              isMenuOpen={isMenuOpen}
              setIsMenuOpen={setIsMenuOpen}
              retryStatus={retryStatus}
              windowMode={windowMode}
              onToggleWindowMode={handleToggleWindowMode}
              onOpenHistory={() => setIsHistoryOpen(true)}
              onNewChat={handleNewChat}
              onMinimize={handleMinimize}
              onCloseApp={handleCloseApp}
              onDragStart={handleDragStart}
              isTerminalOpen={isTerminalOpen}
              onToggleTerminal={() => setIsTerminalOpen(!isTerminalOpen)}
              onCloseTerminal={() => setIsTerminalOpen(false)}
              isHistoryOpen={isHistoryOpen}
              onCloseHistory={() => setIsHistoryOpen(false)}
              onSelectThread={handleSelectThread}
              onDeleteThread={handleDeleteThread}
              onClearAllHistory={handleClearAllHistory}
              activeThreadId={activeThreadId}
              streamingThreads={streamingThreads}
              messages={messages}
              sessionsByThread={sessions}
              isLoading={isLoading}
              streamingBotMessageId={isLoading ? lastTurnIdsRef.current[activeThreadId]?.botMessageId : null}
              messagesEndRef={messagesEndRef}
              input={input}
              setInput={setInput}
              isRecording={isRecording}
              isCapturing={isCapturing}
              isAttachmentPopoverOpen={isAttachmentPopoverOpen}
              setIsAttachmentPopoverOpen={setIsAttachmentPopoverOpen}
              attachedImage={attachedImage}
              setAttachedImage={setAttachedImage}
              isScreenAttached={isScreenAttached}
              setIsScreenAttached={setIsScreenAttached}
              projectRoot={projectRoot}
              projectRootChip={projectRootChip}
              setProjectRoot={setProjectRoot}
              setProjectRootChip={setProjectRootChip}
              attachedClipboardText={attachedClipboardText}
              setAttachedClipboardText={setAttachedClipboardText}
              onFileUpload={handleFileUpload}
              attachedFiles={attachedFiles}
              onRemoveAttachedFile={removeAttachedFile}
              onCaptureScreen={handleCaptureScreen}
              onPickProjectPath={handlePickProjectPath}
              onAttachClipboard={handleAttachClipboard}
              onSend={handleSend}
              onAnswerQuestion={handleAnswerQuestion}
              onCancelRequest={handleCancelRequest}
              textareaRef={textareaRef}
              terminalLogs={terminalLogs}
              isWindowDraggingFile={isWindowDraggingFile}
              pendingAction={pendingActions[activeThreadId] || null}
              onActionDecision={handleActionDecision}
              chatMode={chatMode}
              setChatMode={setChatMode}
              speedMode={speedMode}
              setSpeedMode={setSpeedMode}
              provider={settings?.llm_provider || 'rie'}
              onSelectProvider={handleSelectProvider}
              onUpdateSetting={handleUpdateSetting}
              onDeleteMessage={handleDeleteMessage}
              onOpenMessageInNewChat={handleOpenMessageInNewChat}
              onClearTerminal={handleClearTerminal}
              scheduleNotifications={scheduleNotificationLog}
              scheduleUnreadCount={scheduleNotifications.length}
              onScheduleMarkRead={handleScheduleMarkRead}
              onScheduleMarkAllRead={handleScheduleMarkAllRead}
              onScheduleOpenChat={handleScheduleOpenChat}
              availableUpdate={availableUpdate}
              updateDownloaded={updateDownloaded}
              updateDownloading={updateDownloading}
              updateDownloadProgress={updateDownloadProgress}
              updateBannerDismissed={updateBannerDismissed}
              updateNotificationDismissed={updateNotificationDismissed}
              onDownloadUpdate={handleDownloadUpdate}
              onInstallUpdate={handleInstallUpdate}
              onDismissUpdateNotification={() => setUpdateNotificationDismissed(true)}
              isScheduleSheetOpen={isFloatingScheduleOpen}
              onCloseScheduleSheet={() => setIsFloatingScheduleOpen(false)}
              onOpenScheduleSheet={() => setIsFloatingScheduleOpen(true)}
              isFriendsQuickOpen={isFloatingFriendsOpen}
              onToggleFriendsQuick={() => setIsFloatingFriendsOpen((prev) => !prev)}
              friends={friends}
              friendThreadMeta={friendThreadMeta}
              activeFriendMeta={(friendThreadMeta[activeThreadId] || friendThreadMeta[String(activeThreadId)] || null)}
              onSelectFriendChat={handleSelectFriendChat}
              onStartFriendChat={handleStartFriendChat}
              attachedKnowledge={attachedKnowledge}
              onAttachKnowledge={attachKnowledge}
              onDetachKnowledge={detachKnowledge}
              kioskOverlay={kioskOverlay}
              kioskSelection={kioskSelection}
              onAddKioskSelection={() => {
                if (kioskSelection) {
                  const separator = input.trim() ? " " : "";
                  setInput(input + separator + kioskSelection);
                  setKioskSelection(null);
                }
              }}
              onClearKioskSelection={() => setKioskSelection(null)}
            />
          )}
        </AnimatePresence>
      </div >

      <ScreenPrivacyToast toast={privacyToast} windowMode={windowMode} isOpen={isOpen} onDismiss={() => setPrivacyToast(null)} />
    </>
  );
}

function SettingsWindowApp() {
  const [isReady, setIsReady] = useState(false);
  const handleCloseSettingsWindow = useCallback(async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error("Failed to close settings window:", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initSettingsWindow = async () => {
      try {
        // Each Tauri window has its own JS context. Rehydrate app token here.
        const { invoke } = await import("@tauri-apps/api/core");
        const token = await invoke("get_app_token");
        setAppToken(token);
      } catch (err) {
        console.error("Failed to initialize settings window auth:", err);
      } finally {
        if (!cancelled) setIsReady(true);
      }
    };

    initSettingsWindow();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isReady) {
    return <LoadingScreen onMouseDown={() => {}} onClose={handleCloseSettingsWindow} onMinimize={() => getCurrentWindow().minimize()} />;
  }

  const settingsParams = new URLSearchParams(window.location.search);
  return (
    <SettingsPage
      onClose={handleCloseSettingsWindow}
      initialTab={settingsParams.get('tab') || undefined}
      initialSubTab={settingsParams.get('subtab') || undefined}
    />
  );
}

function PlannerWindowApp() {
  const [isReady, setIsReady] = useState(false);
  const handleClosePlannerWindow = useCallback(async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error("Failed to close planner window:", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const initPlannerWindow = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const token = await invoke("get_app_token");
        setAppToken(token);
      } catch (err) {
        console.error("Failed to initialize planner window auth:", err);
      } finally {
        if (!cancelled) setIsReady(true);
      }
    };

    initPlannerWindow();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isReady) {
    return (
      <LoadingScreen
        onMouseDown={() => {}}
        onClose={handleClosePlannerWindow}
        onMinimize={() => getCurrentWindow().minimize()}
      />
    );
  }

  return <PlannerWindowStandalone />;
}

function App() {
  const view =
    typeof window !== "undefined" ?
      new URLSearchParams(window.location.search).get("view") :
      null;
  const isSettingsWindow = view === "settings";
  const isPlannerWindow = view === "planner";

  if (isSettingsWindow) {
    return <SettingsWindowApp />;
  }
  if (isPlannerWindow) {
    return <PlannerWindowApp />;
  }

  return <MainApp />;
}

export default App;
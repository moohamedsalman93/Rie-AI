import { useState, useEffect, useRef, useCallback } from "react";
import { LogicalSize, LogicalPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";

import { motion, AnimatePresence, animate } from "framer-motion";
import { checkApiHealth, getSettings, updateSetting, getThreadMessages, streamChat, getScreenshot, cancelChat, transcribeAudio, speakText, setAppToken, resumeChat, getScheduleNotifications, markScheduleNotificationRead, markAllScheduleNotificationsRead } from "./services/chatApi";
import { saveThreadId, getStoredThreadId } from "./services/historyService";
import { SettingsPage } from "./components/SettingsPage";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { UpdateNotification } from "./components/UpdateNotification";
import { checkForAppUpdate } from "./services/updater";
import { NormalModeLayout } from "./components/NormalModeLayout";
import { FloatingBubble } from "./components/FloatingBubble";
import { FloatingChatWindow } from "./components/FloatingChatWindow";
import { HITLApproval } from "./components/HITLApproval";
import {
  WINDOW_SIZES,
  getToolDisplayName,
  initialMessages,
} from "./constants/appConfig";
import { useWindowManager } from "./hooks/useWindowManager";
import { useAttachments } from "./hooks/useAttachments";

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

function MainApp() {
  //#region State
  const [isOpen, setIsOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [input, setInput] = useState("");
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [sessions, setSessions] = useState({});
  const [streamingThreads, setStreamingThreads] = useState(new Set());
  const [error, setError] = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");

  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState([]);
  const [availableUpdate, setAvailableUpdate] = useState(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [windowMode, setWindowMode] = useState("floating");
  const [isAppInitializing, setIsAppInitializing] = useState(true);
  const [currentTool, setCurrentTool] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [typesWrite, setTypesWrite] = useState('');
  const [isWindowDraggingFile, setIsWindowDraggingFile] = useState(false);
  const [pendingActions, setPendingActions] = useState({}); // Map: threadId -> HITL request

  // New states for toggles
  const [chatMode, setChatMode] = useState("agent"); // "agent" | "chat"
  const [speedMode, setSpeedMode] = useState("thinking"); // "thinking" | "flash"
  const [scheduleNotifications, setScheduleNotifications] = useState([]);
  const [scheduleNotificationLog, setScheduleNotificationLog] = useState([]);
  const [isFloatingScheduleOpen, setIsFloatingScheduleOpen] = useState(false);
  const scheduleNotifInitializedRef = useRef(false);
  const scheduleNotifSeenIdsRef = useRef(new Set());
  const prevThreadScheduleNotifIdsRef = useRef(new Set());

  const windowManager = useWindowManager({ isOpen, setIsOpen, windowMode });
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
  const voiceReplyRef = useRef(true);
  const lastTurnWasVoiceRef = useRef(false);
  const ttsProviderRef = useRef("edge-tts");
  const ttsVoiceRef = useRef("en-US-EmmaNeural");
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const sentenceBufferRef = useRef("");
  const isRecordingRef = useRef(isRecording);
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
    const audioPromise = speakText(text, ttsVoiceRef.current, ttsProviderRef.current).catch(err => {
      console.error("TTS fetch error", err);
      return null;
    });
    audioQueueRef.current.push(audioPromise);
    processAudioQueue();
  }, [processAudioQueue]);

  const processStreamChunk = useCallback((data, botMessageId, threadId, userMessageId) => {
    try {
      if (data.done || data.step === "end") {
        setStreamingThreads(prev => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
        setCurrentTool(null);
        setIsTerminalOpen(false);

        // Speak the full accumulated assistant response once at the end of the stream
        // Only do this when the last turn was initiated via voice input
        if (voiceReplyRef.current && lastTurnWasVoiceRef.current && accumulatedTextRef.current.trim()) {
          queueSentence(accumulatedTextRef.current);
        }
        // Reset buffers for the next turn
        sentenceBufferRef.current = "";
        accumulatedTextRef.current = "";

        if (firstToolMinimizedRef.current) {
          firstToolMinimizedRef.current = false;
          handleOpen(true);
        }
        return;
      }

      if (data.step === "interrupt") {
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
        setIsTerminalOpen(false); // Auto-close terminal on HITL
        return;
      }

      if (data.error) {
        const errorMsg = data.error || "Unable to connect to chat API.";
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

        if (!firstToolMinimizedRef.current && toolName !== "run_terminal_command" && windowMode !== "normal") {
          firstToolMinimizedRef.current = true;
          minimizeToBottomCenter();
        }
      }

      const isModelMessage = step === "model" && (msg.type === "ai" || msg.type === "assistant");
      if (isModelMessage) {
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content) {
          accumulatedTextRef.current += content;

          setSessions((prev) => {
            const newSessions = { ...prev };
            if (newSessions[threadId]) {
              newSessions[threadId] = newSessions[threadId].map((m) => {
                if (m.id === botMessageId) {
                  const blocks = m.blocks || [];
                  const lastBlock = blocks[blocks.length - 1];
                  if (lastBlock && lastBlock.type === "text") {
                    return { ...m, blocks: [...blocks.slice(0, -1), { ...lastBlock, text: (lastBlock.text || "") + content }] };
                  } else {
                    return { ...m, blocks: [...blocks, { type: "text", text: content }] };
                  }
                }
                return m;
              });
            }
            return newSessions;
          });
        }
      }

      if (step === "tools" || msg.type === "tool" || msg.role === "tool") {
        const content = msg.content;
        if (content && typeof content === "string") {
          const toolName = msg.name || currentTool;

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
  const handleSend = useCallback(async (overrideText = null, isVoice = false, overrideImage = null) => {
    const textToSend = (typeof overrideText === 'string') ? overrideText : input;
    const trimmed = textToSend.trim();
    const hasAttachments = attachedImage || isScreenAttached || attachedClipboardText || projectRoot || overrideImage;
    if (!trimmed && !hasAttachments || isLoading) return;

    // Stop and clear audio
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    sentenceBufferRef.current = "";

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

    const performSend = async (imageToUse = imageToUseFromState) => {
      const threadId = threadIdRef.current;
      lastTurnWasVoiceRef.current = isVoice;
      const userMessage = {
        id: Date.now(),
        from: "user",
        text: trimmed,
        image_url: imageToUse,
        clipboard: clipboardToUse,
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

      const userMessageId = userMessage.id;
      const botMessageId = Date.now() + 1;
      lastTurnIdsRef.current[threadId] = { userMessageId, botMessageId };
      lastSentInputsRef.current[threadId] = { text: trimmed, image_url: imageToUse };

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

      try {
        const token = localStorage.getItem('rie_token');
        await streamChat(
          trimmed,
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
            window.dispatchEvent(new CustomEvent("rie-schedule-refresh"));
          },
          (err) => {
            setError(err.message || "Connection failed");
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
          speedMode
        );
      } catch (err) {
        console.error("Chat error:", err);
      } finally {
        setIsCapturing(false);
      }
    };
    if (isScreenToUse) {
      setIsCapturing(true);
      try {
        const win = getWindow();
        await win.hide();
        await new Promise(resolve => setTimeout(resolve, 300));
        const response = await getScreenshot();
        await win.show();
        await win.unminimize();
        await win.setFocus();

        const capturedImage = response?.image || null;
        await performSend(capturedImage);
      } catch (err) {
        console.error("Delayed capture failed:", err);
        const win = getWindow();
        await win.show();
        await performSend(null);
      } finally {
        setIsCapturing(false);
      }
    } else {
      await performSend();
    }
  }, [input, isLoading, messages, windowMode, attachedImage, isScreenAttached, attachedClipboardText, minimizeToBottomCenter, handleOpen, queueSentence, processAudioQueue, chatMode, speedMode]);

  const startRecording = useCallback(async () => {
    try {
      if (isRecording) return;

      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      // Reset queues
      audioQueueRef.current = [];
      isPlayingRef.current = false;
      sentenceBufferRef.current = "";


      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      mediaRecorderRef.current = new MediaRecorder(stream);

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        try {
          const { text } = await transcribeAudio(audioBlob);
          if (text) {
            handleSend(text, true); // Mark as voice to enable auto-speak
          }
        } catch (err) {
          console.error("Transcription failed:", err);
          setError("Transcription failed. Please try again.");
        } finally {
          // Stop all tracks to release the microphone
          stream.getTracks().forEach(track => track.stop());
        }
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Failed to start recording:", err);
      setError("Microphone access denied or error starting recording.");
    }
  }, [isRecording, handleSend]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

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

    // Explicitly cancel on backend
    cancelChat(threadId).catch(err => console.error("Failed to cancel on backend:", err));

    // Stop audio (only if cancelling current thread or shared audio)
    if (threadId === threadIdRef.current) {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      audioQueueRef.current = [];
      isPlayingRef.current = false;
      sentenceBufferRef.current = "";
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
  const handleNewChat = useCallback(() => {
    const newThreadId = crypto.randomUUID();
    setSessions(prev => ({ ...prev, [newThreadId]: initialMessages }));
    setActiveThreadId(newThreadId);
    saveThreadId(newThreadId);
    threadIdRef.current = newThreadId;
    setAttachedImage(null);
    setIsMenuOpen(false);
  }, []);

  const handleSelectThread = useCallback(async (threadId) => {
    if (!threadId) return;
    setIsHistoryOpen(false); // Close drawer if open
    setAttachedImage(null);
    setError(null);

    // Update active state immediately to provide feedback
    setActiveThreadId(threadId);
    threadIdRef.current = threadId;
    saveThreadId(threadId);

    // If session already exists in memory and not empty, don't refetch
    if (sessions[threadId] && sessions[threadId].length > 0) {
      return;
    }

    setStreamingThreads(prev => new Set(prev).add(threadId)); // Use as loading indicator
    try {
      const msgs = await getThreadMessages(threadId);
      if (msgs && msgs.length > 0) {
        const formatted = msgs.map(m => ({
          id: m.id,
          from: m.role === 'user' ? 'user' : 'bot',
          text: m.content,
          image_url: m.image_url,
          blocks: m.role !== 'user' ? [{ type: 'text', text: m.content }] : undefined
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
  }, [sessions]);

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
  //#endregion

  //#region useEffects
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (windowMode !== "floating") setIsFloatingScheduleOpen(false);
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
                await getWindow().setFocus();
              }
            } else {
              const win = getWindow();
              await win.show();
              await win.unminimize();
              await win.setFocus();
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
          blocks: m.role !== "user" ? [{ type: "text", text: m.content }] : undefined,
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
        // Loading screen always uses normal mode (full-size window, not floating)
        const isNormal = windowMode === "normal" || isAppInitializing;
        console.log(`Applying window mode: ${windowMode}${isAppInitializing ? " (loading)" : ""}`);

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
        }, 150);

        if (isNormal) {
          // In normal mode (or during loading), we want standard app size
          await win.setSize(new LogicalSize(WINDOW_SIZES.NORMAL.width, WINDOW_SIZES.NORMAL.height));

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

  // Global mouse event handling
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isDraggingRef.current && !isOpen && windowMode === "floating") {
        isDraggingRef.current = false;
        setTimeout(() => snapToNearestEdge(), 150);
      } else {
        isDraggingRef.current = false;
      }
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => window.removeEventListener("mouseup", handleGlobalMouseUp);
  }, [isOpen, snapToNearestEdge]);

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
                checkApiHealth().then(status => setApiStatus(status));
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

  // Check for updates on mount

  useEffect(() => {
    const triggerUpdateCheck = async () => {
      // Small delay to let initial animations settle
      setTimeout(async () => {
        const update = await checkForAppUpdate();
        if (update) {
          setAvailableUpdate(update);
        }
      }, 3000);
    };
    triggerUpdateCheck();
  }, []);

  // Load history and thread ID on mount
  useEffect(() => {
    const initChat = async () => {
      let storedThreadId = getStoredThreadId();
      if (storedThreadId) {
        try {
          const msgs = await getThreadMessages(storedThreadId);
          if (msgs && msgs.length > 0) {
            const formatted = msgs.map(m => ({
              id: m.id,
              from: m.role === 'user' ? 'user' : 'bot',
              text: m.content,
              image_url: m.image_url,
              blocks: m.role !== 'user' ? [{ type: 'text', text: m.content }] : undefined
            }));
            setSessions(prev => ({ ...prev, [storedThreadId]: formatted }));
            setActiveThreadId(storedThreadId);
            threadIdRef.current = storedThreadId;
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
            if (attempts % 10 === 0) {
              console.log("Waiting for backend to wake up...");
            }
            await new Promise(r => setTimeout(r, 500));
          }
        }

        const settings = await getSettings();
        const hasAnyKey = settings.google_api_key ||
          settings.groq_api_key ||
          settings.vertex_project ||
          settings.openai_api_key ||
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

        if (settings.tts_provider) {
          ttsProviderRef.current = settings.tts_provider;
        }

        if (settings.tts_voice) {
          ttsVoiceRef.current = settings.tts_voice;
        }

        // Artificial delay for premium feel
        const elapsed = Date.now() - startTime;
        const remainingDelay = Math.max(0, 1500 - elapsed);
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
          const settings = await getSettings();
          if (settings.hasOwnProperty('voice_reply')) {
            voiceReplyRef.current = settings.voice_reply;
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
    const resizeWindow = async () => {
      try {
        const win = getWindow();
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
    };
    resizeWindow();
  }, [isAppInitializing, isSettingsOpen, showWelcome, isOpen, getWindow, windowMode]);

  // Auto-scroll to bottom when messages change or window state shifts
  useEffect(() => {
    if (isOpen && !isSettingsOpen && !showWelcome) {
      // Small timeout to allow Framer Motion animations to finish and DOM to settle
      const timer = setTimeout(() => {
        if (messagesEndRef.current) {
          const scrollContainer = messagesEndRef.current.parentElement;
          if (scrollContainer) {
            scrollContainer.scrollTo({
              top: scrollContainer.scrollHeight,
              behavior: "smooth"
            });
          }
        }
      }, 300); // Increased timeout for bubble-to-chat animation
      return () => clearTimeout(timer);
    }
  }, [isOpen, sessions, activeThreadId, isSettingsOpen, showWelcome, typesWrite]);

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
    const shortcuts = ["Alt+Shift+S", "Alt+Shift+C", "Alt+Shift+A"];
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
  }, [startRecording, stopRecording, handleCancelRequest]); // Removed state deps


  // Set loading window size during init (resize effect handles post-load)
  useEffect(() => {
    if (!isAppInitializing) return;
    const initWindow = async () => {
      try {
        const win = getWindow();
        await win.setSize(new LogicalSize(WINDOW_SIZES.LOADING.width, WINDOW_SIZES.LOADING.height));
      } catch { /* Not in Tauri */ }
    };
    initWindow();
  }, [isAppInitializing]);

  // Listen for clipboard updates from backend
  useEffect(() => {
    let unlisten;
    const setupListener = async () => {
      unlisten = await listen("clipboard-update", (event) => {
        const text = event.payload;
        if (text && text.trim()) {
          // Auto-attach
          setAttachedClipboardText(text);

          // Clear previous timeout if exists
          if (clipboardTimeoutRef.current) {
            clearTimeout(clipboardTimeoutRef.current);
          }

          // Set auto-clear timeout (10 seconds)
          clipboardTimeoutRef.current = setTimeout(() => {
            setAttachedClipboardText(null);
            clipboardTimeoutRef.current = null;
          }, 10000);
        }
      });
    };
    setupListener();
    return () => {
      if (unlisten) unlisten();
      if (clipboardTimeoutRef.current) clearTimeout(clipboardTimeoutRef.current);
    };
  }, []);
  //#endregion

  return (
    <>
      <AnimatePresence>
        {availableUpdate && isOpen && (
          <UpdateNotification
            update={availableUpdate}
            onClose={() => setAvailableUpdate(null)}
          />
        )}
      </AnimatePresence>

      <div className={`fixed inset-0 flex pointer-events-none rounded-2xl overflow-hidden ${side === "right" ? "justify-end" : "justify-start"}`}>
        <AnimatePresence
          mode="wait"
          onExitComplete={async () => {
            if (!isOpen) {
              try {
                const win = getWindow();
                const pos = await getWindowPosition();
                if (side === "right") {
                  const shiftX = WINDOW_SIZES.CHAT.width - WINDOW_SIZES.BUBBLE.width;
                  await win.setPosition(new LogicalPosition(pos.x + shiftX, pos.y));
                }
                await win.setSize(new LogicalSize(WINDOW_SIZES.BUBBLE.width, WINDOW_SIZES.BUBBLE.height));

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
                  onGetStarted={handleOpenSettingsWindow}
                  onMouseDown={handleDragStart}
                  onClose={handleCloseApp}
                  onMinimize={() => getWindow().minimize()}
                />
              ) : isSettingsOpen ? (
                <SettingsPage onClose={() => setIsSettingsOpen(false)} />
              ) : (
              <NormalModeLayout
                  messages={sessions[activeThreadId] || initialMessages}
                  input={input}
                  setInput={setInput}
                  isLoading={isLoading}
                  streamingThreads={streamingThreads}
                  onSend={handleSend}
                  onCancel={handleCancelRequest}
                  onSelectThread={handleSelectThread}
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
                  onCaptureScreen={handleCaptureScreen}
                  onPickProjectPath={handlePickProjectPath}
                  isCapturing={isCapturing}
                  isRecording={isRecording}
                  isAttachmentPopoverOpen={isAttachmentPopoverOpen}
                  setIsAttachmentPopoverOpen={setIsAttachmentPopoverOpen}
                  attachedClipboardText={attachedClipboardText}
                  setAttachedClipboardText={setAttachedClipboardText}
                  onAttachClipboard={handleAttachClipboard}
                  onDeleteMessage={handleDeleteMessage}
                  typesWrite={typesWrite}
                  setTypesWrite={setTypesWrite}
                  isWindowDraggingFile={isWindowDraggingFile}
                  pendingAction={pendingActions[activeThreadId] || null}
                  onActionDecision={handleActionDecision}
                  chatMode={chatMode}
                  setChatMode={setChatMode}
                  speedMode={speedMode}
                  setSpeedMode={setSpeedMode}
                  onClearTerminal={handleClearTerminal}
                  scheduleNotifications={scheduleNotificationLog}
                  scheduleUnreadCount={scheduleNotifications.length}
                  onScheduleMarkRead={handleScheduleMarkRead}
                  onScheduleMarkAllRead={handleScheduleMarkAllRead}
                  onScheduleOpenChat={handleScheduleOpenChat}
                />
              )}
            </motion.div>
          ) : !isOpen ? (
            <FloatingBubble
              key="bubble"
              currentTool={currentTool}
              isLoading={isLoading}
              isRecording={isRecording}
              hasPendingAction={Object.keys(pendingActions).length > 0} // Any thread has pending HITL
              isSnapping={isSnapping}
              onMouseDown={handleBubbleMouseDown}
              getToolDisplayName={getToolDisplayName}
              bubbleRef={bubbleRef}
            />
          ) : (
            <FloatingChatWindow
              key="chat"
              showWelcome={showWelcome}
              setShowWelcome={setShowWelcome}
              isSettingsOpen={isSettingsOpen}
              setIsSettingsOpen={setIsSettingsOpen}
              onOpenSettingsWindow={handleOpenSettingsWindow}
              apiStatus={apiStatus}
              isMenuOpen={isMenuOpen}
              setIsMenuOpen={setIsMenuOpen}
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
              activeThreadId={activeThreadId}
              streamingThreads={streamingThreads}
              messages={messages}
              isLoading={isLoading}
              streamingBotMessageId={isLoading ? lastTurnIdsRef.current[activeThreadId]?.botMessageId : null}
              typesWrite={typesWrite}
              setTypesWrite={setTypesWrite}
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
              onCaptureScreen={handleCaptureScreen}
              onPickProjectPath={handlePickProjectPath}
              onAttachClipboard={handleAttachClipboard}
              onSend={handleSend}
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
              onDeleteMessage={handleDeleteMessage}
              onClearTerminal={handleClearTerminal}
              scheduleNotifications={scheduleNotificationLog}
              scheduleUnreadCount={scheduleNotifications.length}
              onScheduleMarkRead={handleScheduleMarkRead}
              onScheduleMarkAllRead={handleScheduleMarkAllRead}
              onScheduleOpenChat={handleScheduleOpenChat}
              isScheduleSheetOpen={isFloatingScheduleOpen}
              onCloseScheduleSheet={() => setIsFloatingScheduleOpen(false)}
              onOpenScheduleSheet={() => setIsFloatingScheduleOpen(true)}
            />
          )}
        </AnimatePresence>
      </div >

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

  return <SettingsPage onClose={handleCloseSettingsWindow} />;
}

function App() {
  const isSettingsWindow =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("view") === "settings";

  if (isSettingsWindow) {
    return <SettingsWindowApp />;
  }

  return <MainApp />;
}

export default App;
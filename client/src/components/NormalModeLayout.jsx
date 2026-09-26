import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    GitBranch,
    Info,
    RotateCw,
    ChevronDown,
    ChevronRight,
    Users,
    Trash2,
    RefreshCw,
    Mic,
    Plus,
    Folder,
    ArrowUp,
    Sparkles,
    ShieldCheck,
    Square,
    Globe,
    CalendarDays,
    PenLine,
    Search,
    Target,
    Compass,
    Hammer,
    FlaskConical,
} from 'lucide-react';
import { getHistory, getBrowserStatus } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import { MarkdownMessage } from './MarkdownMessage';
import { LinkPreview } from './LinkPreview';
import { ToolChip, ToolCallGroup, SubAgentActivity } from './ToolChip';
import { HITLApproval } from './HITLApproval';
import { ModeToggle } from './ModeToggle';
import { LlmProviderSelector } from './LlmProviderSelector';
import { ThinkingBlock } from './ThinkingBlock';
import { QuestionBlock } from './QuestionBlock';
import VoiceControls from './VoiceControls';
import VoiceToolActivity from './VoiceToolActivity';
import VoiceSubAgentActivity from './VoiceSubAgentActivity';

function renderMessageBlocks(blocks, tooltipPlacement, isStreaming, onAnswerQuestion, onCancelSubAgent) {
    if (!blocks || blocks.length === 0) return null;

    const elements = [];
    let currentToolGroup = [];

    const flushToolGroup = () => {
        if (currentToolGroup.length > 0) {
            const group = [...currentToolGroup];
            elements.push(
                <ToolCallGroup
                    key={`tool-group-${elements.length}`}
                    blocks={group}
                    tooltipPlacement={tooltipPlacement}
                />
            );
            currentToolGroup = [];
        }
    };

    blocks.forEach((block, idx) => {
        if (block.type === 'tool') {
            currentToolGroup.push(block);
        } else if (block.type === 'voice_tool') {
            flushToolGroup();
            elements.push(<VoiceToolActivity key={block.id} item={block} />);
        } else if (block.type === 'voice_subagent') {
            flushToolGroup();
            elements.push(
                <VoiceSubAgentActivity
                    key={block.id || `voice-subagent-${idx}`}
                    block={block}
                    onCancel={onCancelSubAgent}
                />
            );
        } else if (block.type === 'subagent') {
            flushToolGroup();
            elements.push(<SubAgentActivity key={block.id || `subagent-${idx}`} block={block} />);
        } else if (block.type === 'thought') {
            flushToolGroup();
            elements.push(
                <ThinkingBlock
                    key={`thought-${idx}`}
                    block={block}
                    isStreaming={isStreaming && block.isThinking}
                />
            );
        } else if (block.type === 'question' || block.type === 'ask_question') {
            flushToolGroup();
            elements.push(
                <QuestionBlock
                    key={block.id || `question-${idx}`}
                    block={block}
                    onAnswer={(answerText, rawAnswers) => {
                        onAnswerQuestion?.(block.id, answerText, rawAnswers);
                    }}
                    disabled={isStreaming}
                />
            );
        } else {
            flushToolGroup();
            elements.push(
                <div key={`text-${idx}`}>
                    <MarkdownMessage
                        content={block.text}
                        isStreaming={isStreaming}
                    />
                </div>
            );
        }
    });

    flushToolGroup();
    return elements;
}
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { ScheduleNotificationsBell } from './ScheduleNotificationsBell';
import { KnowledgeAttachmentChips, KnowledgeHistoryBadge, KnowledgeChatBanner } from './KnowledgeAttachmentChips';
import { KnowledgePickerModal } from './KnowledgePickerModal';
import { LiveCamoufoxPanel } from './LiveCamoufoxPanel';
import { HistorySidebar } from './HistorySidebar';
import { fetchActiveSkills } from '../services/skillsApi';
import logo from '../assets/logo.png';

export function NormalModeLayout({
    messages,
    sessionsByThread = {},
    input,
    setInput,
    isLoading,
    streamingThreads = new Set(),
    onSend,
    onAnswerQuestion,
    onCancel,
    onSelectThread,
    onDeleteThread = () => { },
    onNewChat,
    currentThreadId,
    onOpenSettings,
    onToggleFloating,
    onCloseApp,
    onMinimize,
    isTerminalOpen,
    onToggleTerminal,
    terminalLogs,
    apiStatus,
    messagesEndRef,
    textareaRef,
    streamingBotMessageId,
    attachedImage,
    setAttachedImage,
    isScreenAttached,
    setIsScreenAttached,
    projectRoot,
    projectRootChip,
    setProjectRoot,
    setProjectRootChip,
    onFileUpload,
    attachedFiles = [],
    onRemoveAttachedFile,
    onCaptureScreen,
    onPickProjectPath,
    isCapturing,
    isAttachmentPopoverOpen,
    setIsAttachmentPopoverOpen,
    attachedClipboardText,
    setAttachedClipboardText,
    onAttachClipboard,
    onDeleteMessage,
    onOpenMessageInNewChat,
    isWindowDraggingFile,
    pendingAction,
    onActionDecision,
    chatMode,
    setChatMode,
    speedMode,
    setSpeedMode,
    onClearTerminal,
    scheduleNotifications = [],
    scheduleUnreadCount = 0,
    onScheduleMarkRead = () => { },
    onScheduleMarkAllRead = () => { },
    onScheduleOpenChat = () => { },
    availableUpdate = null,
    updateDownloaded = false,
    updateDownloading = false,
    updateDownloadProgress = 0,
    updateBannerDismissed = false,
    updateNotificationDismissed = false,
    onDownloadUpdate,
    onInstallUpdate,
    onDismissUpdateNotification,
    friends = [],
    friendThreadMeta = {},
    activeFriendMeta = null,
    onSelectFriendChat = () => { },
    onStartFriendChat = () => { },
    attachedKnowledge = [],
    onAttachKnowledge = () => { },
    onDetachKnowledge = () => { },
    retryStatus = null,
    provider,
    onSelectProvider,
    settings = {},
    onUpdateSetting,
    onToggleLiveVoice = () => { },
    voiceControls = null,
    onCancelSubAgent,
}) {
    const [dragCounter, setDragCounter] = useState(0);
    const [isHistoryVisible, setIsHistoryVisible] = useState(true);
    const [showExitConfirm, setShowExitConfirm] = useState(false);
    const [isKnowledgePickerOpen, setIsKnowledgePickerOpen] = useState(false);
    const [isBrowserPanelOpen, setIsBrowserPanelOpen] = useState(false);
    const [browserEngine, setBrowserEngine] = useState(() => localStorage.getItem("rie_browser_engine") || "default");
    const [isBrowserBinaryAvailable, setIsBrowserBinaryAvailable] = useState(false);

    const botReplyCount = messages.filter(
        (msg) => msg.from === 'bot' && ((msg.blocks && msg.blocks.length > 0) || (msg.text && msg.text.trim()))
    ).length;
    const toolTooltipPlacement = botReplyCount <= 2 ? 'bottom' : 'top';
    const hasStreamingContent = messages.some((msg) => {
        if (msg.from !== 'bot' || msg.id !== streamingBotMessageId) return false;
        const hasActiveBlocks = (msg.blocks || []).some(
            (block) =>
                (block.type === 'text' && block.text && block.text.trim()) ||
                (block.type === 'thought' && block.text && block.text.trim()) ||
                block.type === 'tool'
        );
        return hasActiveBlocks || (msg.text && msg.text.trim());
    });
    const shouldShowThinkingShimmer = Boolean((isLoading && !hasStreamingContent) || retryStatus?.message);

    useEffect(() => {
        const checkBrowserStatus = async () => {
            try {
                const currentEngine = localStorage.getItem("rie_browser_engine") || "default";
                setBrowserEngine(currentEngine);
                const status = await getBrowserStatus();
                setIsBrowserBinaryAvailable(!!status?.browser_binary?.available);
            } catch (e) {
                console.error("Failed checking browser status in header layout:", e);
            }
        };
        checkBrowserStatus();

        const handleEngineChange = () => checkBrowserStatus();
        const handleOpenPanelEvent = () => {
            setIsBrowserPanelOpen(true);
        };

        window.addEventListener("rie_browser_engine_change", handleEngineChange);
        window.addEventListener("rie_open_browser_panel", handleOpenPanelEvent);
        window.addEventListener("focus", checkBrowserStatus);
        return () => {
            window.removeEventListener("rie_browser_engine_change", handleEngineChange);
            window.removeEventListener("rie_open_browser_panel", handleOpenPanelEvent);
            window.removeEventListener("focus", checkBrowserStatus);
        };
    }, []);

    const [browserPanelWidth, setBrowserPanelWidth] = useState(65);
    const [isResizingPanel, setIsResizingPanel] = useState(false);
    const [activeSkillsList, setActiveSkillsList] = useState([]);
    const [isFullWindow, setIsFullWindow] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1200);
    const isDragging = dragCounter > 0;
    const hasContent = Boolean(input?.trim() || attachedImage || isScreenAttached || attachedClipboardText || (attachedKnowledge && attachedKnowledge.length > 0) || (attachedFiles && attachedFiles.length > 0));
    const isNewChat = !messages || messages.length === 0;

    const chatContainerRef = useRef(null);
    const [chatPanelWidthPx, setChatPanelWidthPx] = useState(800);

    useEffect(() => {
        if (!chatContainerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (let entry of entries) {
                if (entry.contentRect) {
                    setChatPanelWidthPx(entry.contentRect.width);
                }
            }
        });
        observer.observe(chatContainerRef.current);
        return () => observer.disconnect();
    }, []);

    const isCompactChat = chatPanelWidthPx < 520;

    const handleStartResize = (e) => {
        e.preventDefault();
        setIsResizingPanel(true);
    };

    useEffect(() => {
        if (!isResizingPanel) return;

        const handleMouseMove = (e) => {
            const windowWidth = window.innerWidth;
            const mouseX = e.clientX;
            const minChatWidthPx = 380;
            const minBrowserWidthPx = 320;

            let maxBrowserPercent = Math.max(20, ((windowWidth - minChatWidthPx) / windowWidth) * 100);
            let minBrowserPercent = Math.min(80, (minBrowserWidthPx / windowWidth) * 100);

            let newPercent = ((windowWidth - mouseX) / windowWidth) * 100;
            if (newPercent < minBrowserPercent) newPercent = minBrowserPercent;
            if (newPercent > maxBrowserPercent) newPercent = maxBrowserPercent;
            setBrowserPanelWidth(newPercent);
        };

        const handleMouseUp = () => {
            setIsResizingPanel(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizingPanel]);

    useEffect(() => {
        const handleResize = () => {
            setIsFullWindow(window.innerWidth >= 1200);
        };
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const sidebarWidth = isFullWindow ? 300 : 240;

    useEffect(() => {
        if (!currentThreadId) {
            setActiveSkillsList([]);
            return;
        }
        fetchActiveSkills(currentThreadId, projectRoot)
            .then((data) => setActiveSkillsList(data))
            .catch(() => { });
    }, [currentThreadId, projectRoot]);

    const attachImageFile = (file) => {
        if (!file || !file.type?.startsWith("image/")) return;
        const reader = new FileReader();
        reader.onload = (re) => {
            setAttachedImage(re.target?.result || null);
        };
        reader.readAsDataURL(file);
    };

    const terminalScrollRef = useRef(null);
    const terminalBottomRef = useRef(null);

    useLayoutEffect(() => {
        if (!isTerminalOpen) return;
        terminalBottomRef.current?.scrollIntoView({ block: 'end', behavior: 'instant' });
        const el = terminalScrollRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [terminalLogs, isTerminalOpen]);



    return (
        <div className="w-full h-full flex flex-col bg-neutral-950 text-neutral-100 overflow-hidden">
            {/* Title Bar */}
            <header
                data-tauri-drag-region
                className="h-11 flex items-center justify-between px-3 bg-neutral-900 border-b border-neutral-800 shrink-0  "
            >
                {/* Left: Logo + Title */}
                <div data-tauri-drag-region className="flex items-center gap-2 w-[33.3%]">
                    <img src={logo} alt="Rie-AI" className="h-5 w-5 object-contain" />
                    <span className="text-sm font-semibold text-neutral-200">Rie-AI</span>
                </div>

                {/* Center: Action Icons */}
                <div data-tauri-drag-region className="flex items-center gap-1 w-[33.3%] justify-center" />

                {/* Right: Window Controls */}
                <div data-tauri-drag-region className="flex items-center gap-1 w-[33.3%] justify-end">

                    {!isHistoryVisible && (
                        <button
                            onClick={onNewChat}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                            title="New Chat"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                        </button>
                    )}

                    <button
                        onClick={() => setIsHistoryVisible(!isHistoryVisible)}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`p-2 rounded-lg transition-colors ${isHistoryVisible ? 'bg-neutral-800 text-emerald-400' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
                        title="Toggle History"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                        </svg>
                    </button>

                    <button
                        onClick={onToggleTerminal}
                        onMouseDown={(e) => e.stopPropagation()}
                        className={`p-2 rounded-lg transition-colors ${isTerminalOpen ? 'bg-neutral-700 text-emerald-400' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'}`}
                        title="Terminal"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="4 17 10 11 4 5"></polyline>
                            <line x1="12" y1="19" x2="20" y2="19"></line>
                        </svg>
                    </button>
                    {(() => {
                        const isBrowserDisabled = browserEngine !== "camoufox" || !isBrowserBinaryAvailable;
                        const browserTitle = browserEngine !== "camoufox"
                            ? "Camoufox workspace disabled (Default Windows engine selected in Settings)"
                            : !isBrowserBinaryAvailable
                            ? "Camoufox workspace disabled (Browser binary not downloaded yet)"
                            : "Live Camoufox Stealth Browser Workspace";
                        return (
                            <button
                                onClick={() => {
                                    if (!isBrowserDisabled) setIsBrowserPanelOpen(prev => !prev);
                                }}
                                disabled={isBrowserDisabled}
                                onMouseDown={(e) => e.stopPropagation()}
                                className={`p-2 rounded-lg transition-colors ${
                                    isBrowserDisabled
                                        ? 'text-neutral-600 opacity-35 cursor-not-allowed border border-transparent'
                                        : isBrowserPanelOpen
                                        ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                                        : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                                }`}
                                title={browserTitle}
                            >
                                <Globe size={16} />
                            </button>
                        );
                    })()}
                    <button
                        onClick={onToggleFloating}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                        title="Switch to Floating Mode"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
                            <path d="M15 13l5 5" />
                            <path d="M20 13v5h-5" />
                        </svg>
                    </button>
                    <button
                        onClick={onOpenSettings}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                        title="Settings"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                            <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                    </button>

                    <div className="h-4 w-[2px] bg-neutral-800 mx-1" />

                    <ScheduleNotificationsBell
                        notifications={scheduleNotifications}
                        unreadCount={scheduleUnreadCount}
                        onMarkRead={onScheduleMarkRead}
                        onMarkAllRead={onScheduleMarkAllRead}
                        onOpenChat={onScheduleOpenChat}
                        apiStatus={apiStatus}
                        availableUpdate={availableUpdate}
                        updateDownloaded={updateDownloaded}
                        updateDownloading={updateDownloading}
                        updateDownloadProgress={updateDownloadProgress}
                        updateBannerDismissed={updateBannerDismissed}
                        updateNotificationDismissed={updateNotificationDismissed}
                        onDownloadUpdate={onDownloadUpdate}
                        onInstallUpdate={onInstallUpdate}
                        onDismissUpdateNotification={onDismissUpdateNotification}
                    />


                    <div className="h-4 w-[2px] bg-neutral-800 mx-1" />

                    <button
                        onClick={onMinimize}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                        title="Minimize"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                    </button>
                    <button
                        onClick={() => setShowExitConfirm(true)}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="p-2 rounded-lg text-neutral-400 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                        title="Close"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* Sidebar */}
                <AnimatePresence initial={false}>
                    {isHistoryVisible && (
                        <motion.aside
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: sidebarWidth, opacity: 1 }}
                            exit={{ opacity: 0, width: 0 }}
                            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                            className="flex flex-col shrink-0 overflow-hidden h-full z-20"
                            style={{ width: sidebarWidth }}
                        >
                            <HistorySidebar
                                isOpen={isHistoryVisible}
                                onClose={() => setIsHistoryVisible(false)}
                                onToggleCollapse={() => setIsHistoryVisible(false)}
                                onSelectThread={onSelectThread}
                                onDeleteThread={onDeleteThread}
                                onNewChat={onNewChat}
                                currentThreadId={currentThreadId}
                                streamingThreads={streamingThreads}
                                windowMode="normal"
                                friends={friends}
                                friendThreadMeta={friendThreadMeta}
                                onStartFriendChat={onStartFriendChat}
                                sessionsByThread={sessionsByThread}
                                apiStatus={apiStatus}
                            />
                        </motion.aside>
                    )}
                </AnimatePresence>

                {/* Chat Area */}
                <div
                    ref={chatContainerRef}
                    style={isBrowserPanelOpen ? { width: `${100 - browserPanelWidth}%` } : undefined}
                    className={`flex flex-col min-w-[380px] bg-neutral-950 relative ${isBrowserPanelOpen ? "shrink-0 border-r border-neutral-800/80" : "flex-1"}`}
                >
                    {/* Messages */}
                    {!isNewChat || voiceControls ? (
                        <main className={`flex-1 min-h-0 transition-transform duration-300 py-4 ${isBrowserPanelOpen ? "px-3" : (isHistoryVisible ? "px-4" : "px-12")} overflow-y-auto overflow-x-hidden custom-scrollbar`}>
                            <div className="max-w-3xl mx-auto w-full space-y-3">
                                {activeFriendMeta?.isFriendChat && (
                                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                                        <div className="font-semibold">Friend chat: {activeFriendMeta.friendName || "Friend"}</div>
                                        <div className="text-emerald-200/80">You are chatting with {activeFriendMeta.friendName || "your friend"}&apos;s Rie.</div>
                                    </div>
                                )}
                                <KnowledgeChatBanner attachedKnowledge={attachedKnowledge} />
                                <SkillsChatBanner activeSkills={activeSkillsList} />
                                {isNewChat && voiceControls && <div className="py-12 text-center">
                                    <h2 className="text-base font-medium text-neutral-200">Your voice, in this chat</h2>
                                    <p className="mt-2 text-sm text-neutral-500">Your conversation and tool activity will appear here.</p>
                                </div>}
                                <AnimatePresence>
                                    {messages.map((m) => {
                                        if (m.from === 'bot' && (!m.blocks || m.blocks.length === 0) && (!m.text || !m.text.trim())) {
                                            return null;
                                        }
                                        return (
                                            <motion.div
                                                key={m.id}
                                                initial={{ opacity: 0, y: 10 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className={`flex flex-col ${m.from === 'user' ? 'items-end' : 'items-start'} w-full group`}
                                            >
                                                <div className={`flex items-end gap-2 min-w-0 w-full ${m.from === 'user' ? 'justify-end' : ''}`}>

                                                    {m.from === 'user' && m.error && (
                                                        <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mb-2">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onOpenMessageInNewChat?.(m);
                                                                }}
                                                                className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-800 transition-colors"
                                                                title="Branch to new chat with history"
                                                            >
                                                                <GitBranch size={14} />
                                                            </button>
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onDeleteMessage(m.id);
                                                                    onSend(m.text, false, m.image_url);
                                                                }}
                                                                className="p-1.5 rounded-lg text-red-400 hover:bg-neutral-800 transition-colors"
                                                                title="Retry"
                                                            >
                                                                <RotateCw size={14} />
                                                            </button>
                                                            <div className="relative group/info">
                                                                <div className="p-1.5 text-red-500 cursor-help">
                                                                    <Info size={14} />
                                                                </div>
                                                                <div className="absolute right-full mr-2 top-1/2 -translate-y-1/2 w-48 p-2.5 bg-neutral-900 border border-red-500/30 rounded-lg text-xs text-red-200 opacity-0 group-hover/info:opacity-100 transition-opacity pointer-events-none z-10 shadow-xl backdrop-blur-sm break-all">
                                                                    {m.errorMessage}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {m.from === 'user' && !m.error && (
                                                        <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mb-2">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onOpenMessageInNewChat?.(m);
                                                                }}
                                                                className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-800 transition-colors"
                                                                title="Branch to new chat with history"
                                                            >
                                                                <GitBranch size={14} />
                                                            </button>
                                                        </div>
                                                    )}

                                                    <div className={`min-w-0 max-w-full break-words overflow-x-hidden rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${m.from === 'user'
                                                        ? `bg-neutral-800 text-neutral-100 border ${m.error ? 'border-red-500/50 bg-red-900/10' : 'border-neutral-700'}`
                                                        : ' text-neutral-100  '
                                                        }`}>
                                                        {m.image_url && (
                                                            <div className="mb-2 overflow-hidden rounded-lg">
                                                                <img src={m.image_url} alt="Attached" className="max-h-60 w-full object-cover" />
                                                            </div>
                                                        )}
                                                        {m.url_previews?.length > 0 && (
                                                            <LinkPreview previews={m.url_previews} />
                                                        )}
                                                        {m.clipboard && (
                                                            <div className="mb-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10 p-2.5">
                                                                <div className="flex items-center gap-2 mb-1.5 opacity-80">
                                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-emerald-400">
                                                                        <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                                                                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                                                                    </svg>
                                                                    <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">Clipboard Content</span>
                                                                </div>
                                                                <p className="text-[11px] text-neutral-300 line-clamp-4 leading-relaxed font-mono italic">
                                                                    {m.clipboard}
                                                                </p>
                                                            </div>
                                                        )}
                                                        {m.from === 'bot' ? (
                                                            <div className="flex flex-col gap-2">
                                                                {renderMessageBlocks(
                                                                    m.blocks || [{ type: 'text', text: m.text }],
                                                                    toolTooltipPlacement,
                                                                    Boolean(m.isPartial) || m.id === streamingBotMessageId,
                                                                    onAnswerQuestion || ((_id, text) => onSend(text)),
                                                                    onCancelSubAgent
                                                                )}
                                                            </div>
                                                        ) : (
                                                            m.text
                                                        )}
                                                    </div>
                                                </div>
                                                <span className={`mt-1 text-[10px] font-medium text-neutral-600 ${m.error ? 'text-red-500/50' : ''}`}>
                                                    {m.from === 'user' ? 'You' : 'Assistant'} {m.error && '• Failed'}
                                                </span>
                                            </motion.div>
                                        );
                                    })}
                                </AnimatePresence>
                                {shouldShowThinkingShimmer && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="flex flex-col items-start w-full py-1"
                                    >
                                        {retryStatus?.message ? (
                                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-[11px] font-medium text-amber-300 animate-pulse">
                                                <RotateCw size={12} className="animate-spin text-amber-400 shrink-0" />
                                                <span>{retryStatus.message}</span>
                                            </div>
                                        ) : (
                                            <div className="flex items-center gap-2 text-neutral-400 py-1">
                                                <span className="flex gap-1 items-center">
                                                    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-pulse" />
                                                    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-pulse [animation-delay:200ms]" />
                                                    <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 animate-pulse [animation-delay:400ms]" />
                                                </span>
                                                <span className="text-[12px] text-neutral-500 font-medium">Thinking...</span>
                                            </div>
                                        )}
                                    </motion.div>
                                )}
                                {pendingAction && (
                                    <HITLApproval
                                        hitl={pendingAction}
                                        onDecision={onActionDecision}
                                    />
                                )}

                                <div className={`${voiceControls ? "h-2" : "h-28"} w-2`}>

                                </div>
                            </div>
                            <div ref={messagesEndRef} />
                        </main>
                    ) : (
                        <main className={`flex-1 min-h-0 flex flex-col items-center justify-center p-6 overflow-y-auto custom-scrollbar pb-28 ${isBrowserPanelOpen ? "px-3" : (isHistoryVisible ? "px-12" : "px-12")}`}>
                            <div className="w-full max-w-3xl mx-auto flex flex-col justify-center py-4">
                                <motion.div
                                    initial={{ opacity: 0, y: -10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    className="flex flex-col items-center text-center mb-6 space-y-1.5 select-none"
                                >
                                    <h1 className={`font-bold text-white font-sans tracking-tight ${
                                        chatPanelWidthPx < 480
                                            ? 'text-xl'
                                            : chatPanelWidthPx < 640
                                            ? 'text-2xl'
                                            : 'text-3xl'
                                    }`}>
                                        How can I help you today?
                                    </h1>

                                    <p className="text-xs sm:text-sm text-neutral-400/90 max-w-md">
                                        Select a quick action below or ask Rie-AI to schedule, search, write, or build.
                                    </p>
                                </motion.div>

                                {/* 4 Scenario Cards */}
                                <motion.div
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ delay: 0.05 }}
                                    className={`grid gap-2.5 w-full mb-6 ${
                                        chatPanelWidthPx < 400
                                            ? 'grid-cols-2'
                                            : chatPanelWidthPx < 640
                                            ? 'grid-cols-2'
                                            : 'grid-cols-4'
                                    }`}
                                >
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setInput("Search the web or research a topic");
                                            textareaRef?.current?.focus();
                                        }}
                                        className={`group relative rounded-xl bg-neutral-900/60 hover:bg-neutral-900 border border-neutral-800/80 hover:border-teal-500/30 transition-all duration-200 cursor-pointer text-left flex ${
                                            chatPanelWidthPx < 400
                                                ? 'flex-row items-center gap-3 min-h-[3.25rem] p-3'
                                                : 'flex-col justify-between min-h-[5.75rem] p-3.5 gap-2.5'
                                        } shadow-md hover:shadow-teal-500/10 hover:-translate-y-0.5`}
                                    >
                                        <div className="w-7 h-7 rounded-full bg-teal-950/80 border border-teal-500/40 text-teal-400 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                                            <Search size={16} />
                                        </div>
                                        <span className="text-[11.5px] sm:text-xs font-medium text-neutral-300 group-hover:text-white transition-colors leading-snug font-sans">
                                            Search the web & research topics
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            setInput("Schedule a task or set a reminder");
                                            textareaRef?.current?.focus();
                                        }}
                                        className={`group relative rounded-xl bg-neutral-900/60 hover:bg-neutral-900 border border-neutral-800/80 hover:border-purple-500/30 transition-all duration-200 cursor-pointer text-left flex ${
                                            chatPanelWidthPx < 400
                                                ? 'flex-row items-center gap-3 min-h-[3.25rem] p-3'
                                                : 'flex-col justify-between min-h-[5.75rem] p-3.5 gap-2.5'
                                        } shadow-md hover:shadow-purple-500/10 hover:-translate-y-0.5`}
                                    >
                                        <div className="w-7 h-7 rounded-full bg-purple-950/80 border border-purple-500/40 text-purple-400 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                                            <CalendarDays size={16} />
                                        </div>
                                        <span className="text-[11.5px] sm:text-xs font-medium text-neutral-300 group-hover:text-white transition-colors leading-snug font-sans">
                                            Schedule tasks & set reminders
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            setInput("Draft an article, email, or summary");
                                            textareaRef?.current?.focus();
                                        }}
                                        className={`group relative rounded-xl bg-neutral-900/60 hover:bg-neutral-900 border border-neutral-800/80 hover:border-emerald-500/30 transition-all duration-200 cursor-pointer text-left flex ${
                                            chatPanelWidthPx < 400
                                                ? 'flex-row items-center gap-3 min-h-[3.25rem] p-3'
                                                : 'flex-col justify-between min-h-[5.75rem] p-3.5 gap-2.5'
                                        } shadow-md hover:shadow-emerald-500/10 hover:-translate-y-0.5`}
                                    >
                                        <div className="w-7 h-7 rounded-full bg-emerald-950/80 border border-emerald-500/40 text-emerald-400 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                                            <PenLine size={16} />
                                        </div>
                                        <span className="text-[11.5px] sm:text-xs font-medium text-neutral-300 group-hover:text-white transition-colors leading-snug font-sans">
                                            Draft content, emails & summaries
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            setInput("Build a feature, tool, or script");
                                            textareaRef?.current?.focus();
                                        }}
                                        className={`group relative rounded-xl bg-neutral-900/60 hover:bg-neutral-900 border border-neutral-800/80 hover:border-amber-500/30 transition-all duration-200 cursor-pointer text-left flex ${
                                            chatPanelWidthPx < 400
                                                ? 'flex-row items-center gap-3 min-h-[3.25rem] p-3'
                                                : 'flex-col justify-between min-h-[5.75rem] p-3.5 gap-2.5'
                                        } shadow-md hover:shadow-amber-500/10 hover:-translate-y-0.5`}
                                    >
                                        <div className="w-7 h-7 rounded-full bg-amber-950/80 border border-amber-500/40 text-amber-400 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                                            <Hammer size={16} />
                                        </div>
                                        <span className="text-[11.5px] sm:text-xs font-medium text-neutral-300 group-hover:text-white transition-colors leading-snug font-sans">
                                            Build apps, tools & automate code
                                        </span>
                                    </button>
                                </motion.div>
                            </div>
                        </main>
                    )}

                    {/* Input Area */}
                    {voiceControls ? (
                        <footer className="w-full shrink-0 bg-neutral-950 px-4 py-3">
                            <div className="mx-auto max-w-3xl"><VoiceControls {...voiceControls} /></div>
                        </footer>
                    ) : <footer
                        onDragEnter={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!isLoading) setDragCounter(prev => prev + 1);
                        }}
                        onDragOver={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                        onDragLeave={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDragCounter(prev => prev - 1);
                        }}
                        onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDragCounter(0);
                            if (isLoading) return;
                            const files = e.dataTransfer.files;
                            if (files && files.length > 0) {
                                const file = files[0];
                                if (file.type.startsWith("image/")) {
                                    attachImageFile(file);
                                }
                            }
                        }}
                        className={`py-3 absolute bottom-0 left-0 w-full z-10 transition-all ${chatPanelWidthPx < 420 ? "px-2" : chatPanelWidthPx < 580 ? "px-3" : chatPanelWidthPx < 760 ? "px-4" : isHistoryVisible ? "px-6" : "px-10 xl:px-16"}`}
                    >
                        <div className="w-full max-w-xl xl:max-w-3xl mx-auto">
                            <div className="w-full rounded-2xl bg-neutral-900 border border-neutral-800/90 focus-within:border-neutral-700/80 shadow-2xl px-3.5 py-1.5 flex flex-col gap-2.5 transition-all">
                                {/* Inline Attachments (if any attached) */}
                                {(attachedImage || isScreenAttached || projectRoot || attachedClipboardText || (attachedKnowledge && attachedKnowledge.length > 0) || attachedFiles.length > 0) && (
                                    <div className="flex items-center gap-2 flex-wrap px-1">
                                        <AnimatePresence>
                                            {attachedImage && (
                                                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative flex items-center gap-1 shrink-0">
                                                    <div className="h-6 w-6 overflow-hidden rounded border border-neutral-700">
                                                        <img src={attachedImage} alt="Preview" className="h-full w-full object-cover" />
                                                    </div>
                                                    <button onClick={() => setAttachedImage(null)} className="text-neutral-400 hover:text-red-400 text-xs">×</button>
                                                </motion.div>
                                            )}
                                            {isScreenAttached && (
                                                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-400 shrink-0">
                                                    <span>@screen</span>
                                                    <button onClick={() => setIsScreenAttached(false)} className="text-emerald-400/60 hover:text-emerald-400">×</button>
                                                </motion.div>
                                            )}
                                            {projectRoot && (
                                                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[11px] text-amber-400 max-w-[160px] truncate shrink-0">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-amber-400">
                                                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                                                    </svg>
                                                    <span className="truncate">@{projectRootChip}</span>
                                                    <button onClick={() => { setProjectRoot(null); setProjectRootChip(null); }} className="text-amber-400/60 hover:text-amber-400 ml-0.5">×</button>
                                                </motion.div>
                                            )}
                                            {attachedClipboardText && (
                                                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="flex items-center gap-1.5 rounded-lg bg-pink-500/10 border border-pink-500/20 px-2 py-0.5 text-[11px] text-pink-400 shrink-0">
                                                    <span>@clipboard</span>
                                                    <button onClick={() => setAttachedClipboardText(null)} className="text-pink-400/60 hover:text-pink-400">×</button>
                                                </motion.div>
                                            )}
                                            {attachedFiles.length > 0 && attachedFiles.map((file, idx) => (
                                                <motion.div key={`file-${file.name}-${idx}`} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="flex items-center gap-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 px-2 py-0.5 text-[11px] text-cyan-400 max-w-[120px] truncate shrink-0">
                                                    <span>@{file.name}</span>
                                                    <button onClick={() => onRemoveAttachedFile?.(idx)} className="text-cyan-400/60 hover:text-cyan-400">×</button>
                                                </motion.div>
                                            ))}
                                            <KnowledgeAttachmentChips attachedKnowledge={attachedKnowledge} onDetach={onDetachKnowledge} variant="compact" />
                                        </AnimatePresence>
                                    </div>
                                )}

                                    <>
                                        {/* Textarea */}
                                        <div className="relative flex items-center">
                                            <textarea
                                                ref={textareaRef}
                                                rows={1}
                                                value={input}
                                                onChange={(e) => setInput(e.target.value)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' && !e.shiftKey) {
                                                        e.preventDefault();
                                                        onSend();
                                                    }
                                                }}
                                                onPaste={(e) => {
                                                    if (isLoading) return;
                                                    const items = e.clipboardData?.items || [];
                                                    for (const item of items) {
                                                        if (item.kind === "file" && item.type.startsWith("image/")) {
                                                            const file = item.getAsFile();
                                                            if (file) {
                                                                e.preventDefault();
                                                                attachImageFile(file);
                                                            }
                                                            break;
                                                        }
                                                    }
                                                }}
                                                placeholder={isNewChat ? 'Do anything' : 'Type a message...'}
                                                className="w-full resize-none bg-transparent px-1 py-1 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none max-h-[220px] custom-scrollbar font-sans"
                                                disabled={isLoading}
                                            />
                                        </div>

                                        {/* Bottom bar */}
                                        <div className="flex items-center justify-between pt-2 border-t border-neutral-800/60 gap-1.5 min-w-0">
                                            <div className="flex items-center gap-1.5 min-w-0 shrink-0">
                                                <div className="relative shrink-0">
                                                    <button
                                                        type="button"
                                                        onClick={() => setIsAttachmentPopoverOpen(!isAttachmentPopoverOpen)}
                                                        className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                                                        title="Add attachment"
                                                    >
                                                        <Plus size={16} />
                                                    </button>
                                                    <AnimatePresence>
                                                        {isAttachmentPopoverOpen && (
                                                            <motion.div
                                                                initial={{ opacity: 0, y: 10 }}
                                                                animate={{ opacity: 1, y: 0 }}
                                                                exit={{ opacity: 0, y: 10 }}
                                                                className="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-neutral-700 bg-neutral-800 p-1 shadow-xl z-50"
                                                            >
                                                                <button onClick={onFileUpload} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white">
                                                                    <Folder size={14} className="text-neutral-400" />
                                                                    <span>Upload File</span>
                                                                </button>
                                                                <button onClick={onCaptureScreen} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white">
                                                                    <Info size={14} className="text-neutral-400" />
                                                                    <span>Current Screen</span>
                                                                </button>
                                                                <button onClick={onPickProjectPath} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white">
                                                                    <Folder size={14} className="text-neutral-400" />
                                                                    <span>Project Path</span>
                                                                </button>
                                                                <button
                                                                    onClick={() => {
                                                                        setIsAttachmentPopoverOpen(false);
                                                                        setIsKnowledgePickerOpen(true);
                                                                    }}
                                                                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white"
                                                                >
                                                                    <Folder size={14} className="text-violet-400" />
                                                                    <span>Custom Knowledge</span>
                                                                </button>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>

                                                    <KnowledgePickerModal
                                                        isOpen={isKnowledgePickerOpen}
                                                        onClose={() => setIsKnowledgePickerOpen(false)}
                                                        onSelect={(pack) => onAttachKnowledge?.(pack)}
                                                        attachedIds={attachedKnowledge.map((k) => k.id)}
                                                        variant="popover"
                                                    />
                                                </div>

                                                <div className="flex items-center gap-1 shrink-0">
                                                    <ModeToggle
                                                        chatMode={chatMode}
                                                        setChatMode={setChatMode}
                                                        speedMode={speedMode}
                                                        setSpeedMode={setSpeedMode}
                                                        provider={provider}
                                                    />
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-1.5 min-w-0 shrink-0">
                                                <LlmProviderSelector
                                                    provider={provider}
                                                    onSelectProvider={onSelectProvider}
                                                    settings={settings}
                                                    onOpenSettings={onOpenSettings}
                                                    onUpdateSetting={onUpdateSetting}
                                                />

                                                {/* Unified Action Button */}
                                                <AnimatePresence mode="wait" initial={false}>
                                                    {isLoading ? (
                                                        <motion.button
                                                            key="btn-loading"
                                                            initial={{ scale: 0.8, opacity: 0 }}
                                                            animate={{ scale: 1, opacity: 1 }}
                                                            exit={{ scale: 0.8, opacity: 0 }}
                                                            transition={{ duration: 0.12 }}
                                                            type="button"
                                                            onClick={() => onCancel?.()}
                                                            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 active:scale-95 transition-all"
                                                            title="Stop generating"
                                                        >
                                                            <Square size={11} fill="currentColor" />
                                                        </motion.button>
                                                    ) : hasContent ? (
                                                        <motion.button
                                                            key="btn-send"
                                                            initial={{ scale: 0.8, opacity: 0 }}
                                                            animate={{ scale: 1, opacity: 1 }}
                                                            exit={{ scale: 0.8, opacity: 0 }}
                                                            transition={{ duration: 0.12 }}
                                                            type="button"
                                                            onClick={onSend}
                                                            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-white text-neutral-900 hover:bg-neutral-200 active:scale-95 shadow-sm transition-all"
                                                            title="Send message (Enter)"
                                                        >
                                                            <ArrowUp size={15} strokeWidth={2.5} />
                                                        </motion.button>
                                                    ) : (
                                                        <motion.button
                                                            key="btn-live-voice"
                                                            initial={{ scale: 0.8, opacity: 0 }}
                                                            animate={{ scale: 1, opacity: 1 }}
                                                            exit={{ scale: 0.8, opacity: 0 }}
                                                            transition={{ duration: 0.12 }}
                                                            type="button"
                                                            onClick={onToggleLiveVoice}
                                                            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-neutral-400 hover:text-white hover:bg-neutral-800 active:scale-95 transition-all"
                                                            title="Voice conversation (Gemini Live)"
                                                        >
                                                            <Mic size={15} />
                                                        </motion.button>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        </div>
                                    </>
                            </div>
                        </div>

                    </footer>}

                </div>

                {/* Terminal Sidebar - real terminal look */}
                <AnimatePresence>
                    {isTerminalOpen && (
                        <motion.aside
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: 320, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                            className="bg-[#0c0c0c] border-l border-neutral-800 flex flex-col overflow-hidden shrink-0"
                        >
                            {/* Terminal title bar */}
                            <div className="h-9 flex items-center justify-between px-3 bg-[#1a1a1a] border-b border-neutral-800 shrink-0">
                                <div className="flex items-center gap-2">
                                    <div className="flex gap-1">
                                        <div className="h-2 w-2 rounded-full bg-[#ff5f56]" />
                                        <div className="h-2 w-2 rounded-full bg-[#ffbd2e]" />
                                        <div className="h-2 w-2 rounded-full bg-[#27c93f]" />
                                    </div>
                                    <span className="text-[10px] font-medium text-neutral-500 ml-1.5 font-mono">Terminal</span>
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={onClearTerminal}
                                        className="p-1 rounded text-neutral-500 hover:bg-neutral-700/50 hover:text-neutral-300 transition-colors"
                                        title="Clear Terminal"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M3 6h18"></path>
                                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                        </svg>
                                    </button>
                                    <button
                                        onClick={onToggleTerminal}
                                        className="p-1 rounded text-neutral-500 hover:bg-neutral-700/50 hover:text-neutral-300 font-mono"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18"></line>
                                            <line x1="6" y1="6" x2="18" y2="18"></line>
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Terminal output - single scroll, raw lines */}
                            <div
                                ref={terminalScrollRef}
                                className="flex-1 overflow-y-auto overflow-x-auto custom-scrollbar p-3 font-mono text-[11px] leading-[1.45] text-[#d4d4d4] selection:bg-emerald-500/30"
                                style={{ fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace" }}
                            >
                                {terminalLogs.length === 0 ? (
                                    <div className="flex h-full items-center justify-center text-neutral-600 text-xs">
                                        <span className="text-[#3d8b40]">$</span>
                                        <span className="terminal-cursor w-2 h-3 bg-[#3d8b40] ml-0.5 inline-block" />
                                    </div>
                                ) : (
                                    <>
                                        {terminalLogs.map((log, i) => (
                                            <div key={i} className="mb-1">
                                                <div className="flex items-baseline gap-1 flex-wrap">
                                                    <span className="text-[#3d8b40] shrink-0">$</span>
                                                    <span className="text-[#d4d4d4] break-all">{log.command || "(command)"}</span>
                                                </div>
                                                {log.stdout && (
                                                    <pre className="mt-0 mb-0 whitespace-pre-wrap break-all text-[#d4d4d4] font-inherit text-inherit leading-[1.45]">{log.stdout}</pre>
                                                )}
                                                {log.stderr && (
                                                    <pre className="mt-0 mb-0 whitespace-pre-wrap break-all text-[#f14c4c] font-inherit text-inherit leading-[1.45]">{log.stderr}</pre>
                                                )}
                                                {log.status === 'ok' && !log.stdout && !log.stderr && (
                                                    <pre className="mt-0 mb-0 text-neutral-600 text-[10px]">(no output)</pre>
                                                )}
                                                {log.returncode !== undefined && (
                                                    <span className={`text-[10px] ${log.returncode === 0 ? 'text-neutral-600' : 'text-[#f14c4c]/80'}`}>
                                                        {" "}[exit {log.returncode}]
                                                    </span>
                                                )}
                                            </div>
                                        ))}
                                        <div className="flex items-center gap-0 mt-0.5">
                                            <span className="text-[#3d8b40]">$</span>
                                            <span className="terminal-cursor w-2 h-3 bg-[#3d8b40] ml-0.5 inline-block" />
                                        </div>
                                        <div ref={terminalBottomRef} className="h-0 w-0 shrink-0" aria-hidden />
                                    </>
                                )}
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>

                {/* Draggable Divider Handle */}
                {isBrowserPanelOpen && (
                    <div
                        onMouseDown={handleStartResize}
                        className="w-1.5 hover:w-2 bg-neutral-800/80 hover:bg-cyan-500/80 cursor-col-resize h-full shrink-0 transition-colors z-30 flex items-center justify-center group"
                        title="Drag to resize browser panel"
                    >
                        <div className="h-8 w-0.5 bg-neutral-600 group-hover:bg-cyan-200 rounded-full" />
                    </div>
                )}

                {/* Embedded Camoufox Browser Workspace Panel */}
                <AnimatePresence>
                    {isBrowserPanelOpen && (
                        <motion.aside
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: `${browserPanelWidth}%`, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={isResizingPanel ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 30 }}
                            style={{ width: `${browserPanelWidth}%` }}
                            className="h-full bg-neutral-950 flex flex-col overflow-hidden shrink-0"
                        >
                            <LiveCamoufoxPanel onClose={() => setIsBrowserPanelOpen(false)} />
                        </motion.aside>
                    )}
                </AnimatePresence>
            </div>



            <ConfirmationModal
                isOpen={showExitConfirm}
                onClose={() => setShowExitConfirm(false)}
                onConfirm={onCloseApp}
                title="Exit Rie-AI?"
                message="Are you sure you want to close the application?"
                confirmText="Exit"
                type="warning"
            />

            <KnowledgePickerModal
                isOpen={isKnowledgePickerOpen}
                onClose={() => setIsKnowledgePickerOpen(false)}
                onSelect={(pack) => onAttachKnowledge(pack)}
                attachedIds={attachedKnowledge.map((k) => k.id)}
            />
        </div>
    );
}

export function SkillsChatBanner({ activeSkills = [] }) {
    if (!activeSkills?.length) return null;
    const names = activeSkills.map((s) => `${s.icon || '🧠'} ${s.name}`).join(', ');
    return (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100 flex items-center justify-between gap-3 mb-3 animate-in fade-in duration-300">
            <div>
                <span className="font-semibold">Active Instructions: </span>
                <span className="text-emerald-200/80">{names}</span>
            </div>
            <span className="text-[10px] text-emerald-400 font-semibold shrink-0 bg-emerald-950/40 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                Injected
            </span>
        </div>
    );
}

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Info, RotateCw } from 'lucide-react';
import { getHistory, deleteThread } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import { MarkdownMessage } from './MarkdownMessage';
import { ToolChip } from './ToolChip';
import { HITLApproval } from './HITLApproval';
import { ModeToggle } from './ModeToggle';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { ScheduleNotificationsBell } from './ScheduleNotificationsBell';
import logo from '../assets/logo.png';

export function NormalModeLayout({
    messages,
    input,
    setInput,
    isLoading,
    streamingThreads = new Set(),
    onSend,
    onCancel,
    onSelectThread,
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
    onCaptureScreen,
    onPickProjectPath,
    isCapturing,
    isRecording,
    isAttachmentPopoverOpen,
    setIsAttachmentPopoverOpen,
    attachedClipboardText,
    setAttachedClipboardText,
    onAttachClipboard,
    onDeleteMessage,
    typesWrite,
    setTypesWrite,
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
    onScheduleMarkRead = () => {},
    onScheduleMarkAllRead = () => {},
    onScheduleOpenChat = () => {},
}) {
    // Sidebar state
    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [threadToDelete, setThreadToDelete] = useState(null);
    const [dragCounter, setDragCounter] = useState(0);
    const [isHistoryVisible, setIsHistoryVisible] = useState(true);
    const [showExitConfirm, setShowExitConfirm] = useState(false);
    const isDragging = dragCounter > 0;
    const hasContent = input.trim() || attachedImage || isScreenAttached || attachedClipboardText || projectRoot;

    useEffect(() => {
        loadThreads();
    }, [currentThreadId]);

    const loadThreads = async () => {
        setLoading(true);
        try {
            const data = await getHistory();
            setThreads(data);
        } catch (err) {
            console.error('Failed to load history:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteClick = (e, threadId) => {
        e.stopPropagation();
        setThreadToDelete(threadId);
        setIsConfirmOpen(true);
    };

    const confirmDelete = async () => {
        if (!threadToDelete) return;
        try {
            await deleteThread(threadToDelete);
            setThreads(prev => prev.filter(t => t.id !== threadToDelete));
            if (threadToDelete === currentThreadId) {
                onNewChat();
            }
        } catch (err) {
            console.error('Failed to delete thread:', err);
        } finally {
            setThreadToDelete(null);
        }
    };

    const formatDate = (isoString) => {
        const date = new Date(isoString);
        const now = new Date();
        const diff = now - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        if (days === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const filteredThreads = threads.filter(t =>
        (t.title || 'Untitled Chat').toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="w-full h-full flex flex-col bg-neutral-950 text-neutral-100 overflow-hidden">
            {/* Title Bar */}
            <header
                data-tauri-drag-region
                className="h-11 flex items-center justify-between px-3 bg-neutral-900 border-b border-neutral-800 shrink-0 cursor-move"
            >
                {/* Left: Logo + Title */}
                <div data-tauri-drag-region className="flex items-center gap-2 w-[33.3%]">
                    <img src={logo} alt="Rie-AI" className="h-5 w-5 object-contain" />
                    <span className="text-sm font-semibold text-neutral-200">Rie-AI</span>
                    <span className={`text-[10px] px-1.5 py-0.5 mt-[2px] rounded ${apiStatus === 'online' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                        {apiStatus === 'online' ? 'Online' : 'Offline'}
                    </span>
                </div>

                {/* Center: Action Icons */}
                <div data-tauri-drag-region className="flex items-center gap-1 w-[33.3%] justify-center">


                    <div className="px-1 scale-[0.85] origin-center translate-y-[1px]">
                        <ModeToggle
                            chatMode={chatMode}
                            setChatMode={setChatMode}
                            speedMode={speedMode}
                            setSpeedMode={setSpeedMode}
                        />
                    </div>
                </div>

                {/* Right: Window Controls */}
                <div data-tauri-drag-region className="flex items-center gap-1 w-[33.3%] justify-end">
                    <ScheduleNotificationsBell
                        notifications={scheduleNotifications}
                        unreadCount={scheduleUnreadCount}
                        onMarkRead={onScheduleMarkRead}
                        onMarkAllRead={onScheduleMarkAllRead}
                        onOpenChat={onScheduleOpenChat}
                        apiStatus={apiStatus}
                    />
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




                    <div className="h-4 w-[1px] bg-neutral-800 mx-1" />

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
                            animate={{ width: 240, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                            className="bg-neutral-900 border-r border-neutral-800 flex flex-col shrink-0 overflow-hidden"
                        >
                            {/* Sidebar Header: Search + New Chat */}
                            <div className="p-3 border-b border-neutral-800 shrink-0">
                                <div className="flex items-center gap-2">
                                    <div className="relative flex-1">
                                        <input
                                            type="text"
                                            placeholder="Search..."
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                            className="w-full bg-neutral-800 border border-neutral-700 rounded-lg pl-8 pr-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-emerald-500/50 transition-colors"
                                        />
                                        <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <circle cx="11" cy="11" r="8" />
                                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                            </svg>
                                        </div>
                                    </div>
                                    <button
                                        onClick={onNewChat}
                                        className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                        title="New Chat"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="12" y1="5" x2="12" y2="19" />
                                            <line x1="5" y1="12" x2="19" y2="12" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Thread List */}
                            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-0.5">
                                {loading ? (
                                    <div className="flex justify-center py-8">
                                        <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-emerald-500"></div>
                                    </div>
                                ) : filteredThreads.length === 0 ? (
                                    <div className="text-center py-8 text-neutral-500 text-xs">
                                        {searchTerm ? 'No matches' : 'No history'}
                                    </div>
                                ) : (
                                    filteredThreads.map(thread => (
                                        <button
                                            key={thread.id}
                                            onClick={() => onSelectThread(thread.id)}
                                            className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors group relative ${thread.id === currentThreadId
                                                ? 'bg-neutral-800 text-neutral-100'
                                                : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
                                                }`}
                                        >
                                            <div className="pr-5">
                                                <div className="flex items-center gap-1.5">
                                                    <div className="text-xs font-medium truncate">{thread.title || 'Untitled Chat'}</div>
                                                    {streamingThreads.has(thread.id) && (
                                                        <div className="flex items-center gap-1 shrink-0">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="text-[10px] opacity-50 mt-0.5">{formatDate(thread.updated_at || thread.created_at)}</div>
                                            </div>
                                            <div
                                                onClick={(e) => handleDeleteClick(e, thread.id)}
                                                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="3 6 5 6 21 6"></polyline>
                                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                                </svg>
                                            </div>
                                        </button>
                                    ))
                                )}
                            </div>
                            <ScheduledTasksPanel apiStatus={apiStatus} />
                        </motion.aside>
                    )}
                </AnimatePresence>

                {/* Chat Area */}
                <div className="flex-1 flex flex-col min-w-0 bg-neutral-950">
                    {/* Messages */}
                    <main className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar transition-transform duration-300  py-4 space-y-3 ${isHistoryVisible ? "px-6" : "px-24"}`}>
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
                                        <div className={`flex items-end gap-2 min-w-0 max-w-[85%] ${m.from === 'user' ? 'justify-end' : ''}`}>

                                            {m.from === 'user' && m.error && (
                                                <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mb-2">
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
                                                        <div className="absolute right-full mr-2 top-1/2 -translate-y-1/2 w-48 p-2.5 bg-neutral-900 border border-red-500/30 rounded-lg text-xs text-red-200 opacity-0 group-hover/info:opacity-100 transition-opacity pointer-events-none z-10 shadow-xl backdrop-blur-sm">
                                                            {m.errorMessage}
                                                        </div>
                                                    </div>
                                                </div>
                                            )}

                                            <div className={`min-w-0 max-w-full break-words overflow-x-auto rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ${m.from === 'user'
                                                ? `bg-neutral-800 text-neutral-100 border ${m.error ? 'border-red-500/50 bg-red-900/10' : 'border-neutral-700'}`
                                                : 'bg-neutral-900 text-neutral-100 border border-neutral-800'
                                                }`}>
                                                {m.image_url && (
                                                    <div className="mb-2 overflow-hidden rounded-lg">
                                                        <img src={m.image_url} alt="Attached" className="max-h-60 w-full object-cover" />
                                                    </div>
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
                                                        {(m.blocks || [{ type: 'text', text: m.text }]).map((block, idx) => (
                                                            <div key={idx}>
                                                                {block.type === 'text' ? (
                                                                    <MarkdownMessage
                                                                        content={block.text}
                                                                        isStreaming={m.id === streamingBotMessageId}
                                                                        typesWrite={typesWrite}
                                                                        setTypesWrite={setTypesWrite}
                                                                    />
                                                                ) : (
                                                                    <ToolChip name={block.name} content={block.text} />
                                                                )}
                                                            </div>
                                                        ))}
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
                        {pendingAction && (
                            <HITLApproval
                                hitl={pendingAction}
                                onDecision={onActionDecision}
                            />
                        )}
                        <div ref={messagesEndRef} />
                    </main>

                    {/* Input Area */}
                    <footer
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
                                    onFileDrop(file);
                                }
                            }
                        }}
                        className={`px-4 py-2 relative ${isHistoryVisible ? "px-6" : "px-24"}`}
                    >
                        <AnimatePresence>
                            {(isDragging || isWindowDraggingFile) && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="absolute inset-x-4 inset-y-2 z-[100] flex items-center justify-center rounded-xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/10 backdrop-blur-sm pointer-events-none"
                                >
                                    <div className="flex items-center gap-3 text-emerald-400">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                            <polyline points="17 8 12 3 7 8" />
                                            <line x1="12" y1="3" x2="12" y2="15" />
                                        </svg>
                                        <span className="text-xs font-bold  tracking-wider">Drop image to attach</span>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                        <div className="flex flex-col gap-2">
                            {/* Attachment previews */}
                            <div className='flex flex-wrap gap-2 w-[70%] mx-auto overflow-x-auto'>
                                <AnimatePresence>
                                    {attachedImage && (
                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.9 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.9 }}
                                            className="relative self-start"
                                        >
                                            <div className="h-16 w-16 overflow-hidden rounded-lg border border-neutral-700">
                                                <img src={attachedImage} alt="Preview" className="h-full w-full object-cover" />
                                            </div>
                                            <button
                                                onClick={() => setAttachedImage(null)}
                                                className="absolute -right-1.5 -top-1.5 rounded-full bg-red-500 p-0.5 text-white"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                </svg>
                                            </button>
                                        </motion.div>
                                    )}
                                    {isScreenAttached && (
                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.9 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.9 }}
                                            className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 self-start"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                                                <rect width="20" height="14" x="2" y="3" rx="2" />
                                                <path d="M8 21h8" />
                                                <path d="M12 17v4" />
                                            </svg>
                                            <span className="text-xs text-emerald-400">@current_screen</span>
                                            <button onClick={() => setIsScreenAttached(false)} className="text-emerald-400/60 hover:text-emerald-400">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                </svg>
                                            </button>
                                        </motion.div>
                                    )}
                                    {projectRoot && (
                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.9 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.9 }}
                                            className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-2 py-1 self-start"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                                                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                                            </svg>
                                            <span className="text-xs text-amber-400">@{projectRootChip}</span>
                                            <button onClick={() => { setProjectRoot(null); setProjectRootChip(null); }} className="text-amber-400/60 hover:text-amber-400">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                </svg>
                                            </button>
                                        </motion.div>
                                    )}
                                    {attachedClipboardText && (
                                        <motion.div
                                            initial={{ opacity: 0, scale: 0.9 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, scale: 0.9 }}
                                            className="flex items-center gap-2 rounded-lg bg-pink-500/10 border border-pink-500/20 px-2 py-1 self-start"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-pink-400">
                                                <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                                                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                                            </svg>
                                            <span className="text-xs text-pink-400">@clipboard</span>
                                            <button onClick={() => setAttachedClipboardText(null)} className="text-pink-400/60 hover:text-pink-400">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                </svg>
                                            </button>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            <div className="flex items-end justify-center gap-2">
                                {/* Attachment button */}
                                <div className="relative">
                                    <button
                                        onClick={() => setIsAttachmentPopoverOpen(!isAttachmentPopoverOpen)}
                                        disabled={isLoading || isCapturing}
                                        className={`p-[10px] rounded-lg border transition-colors ${isAttachmentPopoverOpen ? 'bg-neutral-700 border-neutral-600' : 'bg-neutral-800 border-neutral-700 hover:bg-neutral-700'} disabled:opacity-50`}
                                    >
                                        {isCapturing ? (
                                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
                                        ) : (
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-400">
                                                <path d="m18 15-6-6-6 6" />
                                            </svg>
                                        )}
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
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
                                                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                                                        <circle cx="9" cy="9" r="2" />
                                                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                                                    </svg>
                                                    Upload Image
                                                </button>
                                                <button onClick={onCaptureScreen} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400">
                                                        <rect width="20" height="14" x="2" y="3" rx="2" />
                                                        <path d="M8 21h8" />
                                                        <path d="M12 17v4" />
                                                    </svg>
                                                    Current Screen
                                                </button>
                                                <button onClick={onPickProjectPath} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                                                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                                                    </svg>
                                                    Project Path
                                                </button>
                                                <button onClick={onAttachClipboard} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 hover:text-white">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-pink-400">
                                                        <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                                                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                                                    </svg>
                                                    Read Clipboard
                                                </button>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>

                                {/* Text input */}
                                <div className="w-[70%] max-h-fit relative flex items-center justify-center">
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
                                        placeholder={isRecording ? 'Listening...' : 'Type a message...'}
                                        className={`w-full resize-none rounded-xl border bg-neutral-800 px-4 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 outline-none transition-all max-h-[280px] custom-scrollbar ${isRecording ? 'border-emerald-500 ring-1 ring-emerald-500/20' : `border-neutral-700/50 focus:bg-neutral-800/50 ${chatMode === 'agent' ? 'focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10' : 'focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10'}`} disabled:opacity-50`}
                                        disabled={isLoading}
                                    />
                                    {isRecording && (
                                        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                                            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                                            <span className="text-[10px] font-bold text-emerald-500 uppercase">Live</span>
                                        </div>
                                    )}
                                </div>

                                {/* Send/Cancel button */}
                                <button
                                    onClick={isLoading ? () => onCancel() : onSend}
                                    disabled={!isLoading && !hasContent}
                                    className={`p-2.5 rounded-xl border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${isLoading
                                        ? 'bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20'
                                        : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'
                                        }`}
                                >
                                    {isLoading ? (
                                        <div className="relative flex items-center justify-center">
                                            <div className="absolute h-5 w-5 animate-spin rounded-full border-2 border-red-500/30 border-t-red-500" />
                                            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                                <rect x="6" y="6" width="12" height="12" rx="1" />
                                            </svg>
                                        </div>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="m22 2-7 20-4-9-9-4Z" />
                                            <path d="M22 2 11 13" />
                                        </svg>
                                    )}
                                </button>
                            </div>
                        </div>
                    </footer>

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
                                    </>
                                )}
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>
            </div>

            <ConfirmationModal
                isOpen={isConfirmOpen}
                onClose={() => setIsConfirmOpen(false)}
                onConfirm={confirmDelete}
                title="Delete Chat?"
                message="This will permanently delete this conversation."
                confirmText="Delete"
            />

            <ConfirmationModal
                isOpen={showExitConfirm}
                onClose={() => setShowExitConfirm(false)}
                onConfirm={onCloseApp}
                title="Exit Rie-AI?"
                message="Are you sure you want to close the application?"
                confirmText="Exit"
                type="warning"
            />
        </div>
    );
}

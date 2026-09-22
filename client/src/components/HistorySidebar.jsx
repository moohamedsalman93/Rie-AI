import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    ChevronDown,
    Search,
    X,
    Plus,
    Users,
    CalendarClock,
    Trash2,
    PanelLeftClose
} from 'lucide-react';
import { getHistory, listScheduledTasks, cancelScheduledTask } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import { KnowledgeHistoryBadge } from './KnowledgeAttachmentChips';

const INTENT_LABEL = {
    reminder: 'Reminder',
    analysis_silent: 'Analysis',
    analysis_inform: 'Analysis + notify',
};

function formatRunAt(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch {
        return String(iso);
    }
}

export function HistorySidebar({
    isOpen,
    onClose,
    onSelectThread,
    onDeleteThread = () => {},
    onNewChat,
    currentThreadId,
    streamingThreads = new Set(),
    windowMode,
    friends = [],
    friendThreadMeta = {},
    onStartFriendChat = () => {},
    sessionsByThread = {},
    apiStatus = 'online',
    onToggleCollapse = null,
}) {
    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [threadToDelete, setThreadToDelete] = useState(null);

    // Accordions (Friends & Scheduled)
    const [friendsOpen, setFriendsOpen] = useState(false);
    const [scheduledOpen, setScheduledOpen] = useState(false);

    // Scheduled tasks
    const [scheduledTasks, setScheduledTasks] = useState([]);
    const [loadingTasks, setLoadingTasks] = useState(false);

    const isPersistent = windowMode === 'normal';
    const showSidebar = isOpen || isPersistent;
    const PAGE_SIZE = 18;

    const loadInitialHistory = useCallback(async () => {
        if (!showSidebar) return;
        setLoading(true);
        setError(null);
        try {
            const data = await getHistory(PAGE_SIZE, 0, searchTerm);
            const loaded = Array.isArray(data) ? data : [];
            setThreads(loaded);
            setHasMore(loaded.length >= PAGE_SIZE);
        } catch (err) {
            console.error("Failed to load history:", err);
            setError("Failed to load history");
        } finally {
            setLoading(false);
        }
    }, [showSidebar, searchTerm]);

    useEffect(() => {
        loadInitialHistory();
    }, [loadInitialHistory]);

    useEffect(() => {
        const refresh = () => loadInitialHistory();
        window.addEventListener('rie-history-refresh', refresh);
        return () => window.removeEventListener('rie-history-refresh', refresh);
    }, [loadInitialHistory]);

    const loadScheduledTasks = useCallback(async () => {
        if (apiStatus !== 'online') return;
        setLoadingTasks(true);
        try {
            const data = await listScheduledTasks();
            setScheduledTasks(Array.isArray(data) ? data : []);
        } catch (err) {
            console.error("Failed to load scheduled tasks:", err);
        } finally {
            setLoadingTasks(false);
        }
    }, [apiStatus]);

    useEffect(() => {
        if (!showSidebar) return;
        loadScheduledTasks();
        const interval = setInterval(loadScheduledTasks, 20000);
        return () => clearInterval(interval);
    }, [showSidebar, loadScheduledTasks]);

    useEffect(() => {
        const handleRefresh = () => loadScheduledTasks();
        window.addEventListener('rie-schedule-refresh', handleRefresh);
        return () => window.removeEventListener('rie-schedule-refresh', handleRefresh);
    }, [loadScheduledTasks]);

    const handleCancelScheduledTask = async (e, jobId) => {
        e.stopPropagation();
        try {
            await cancelScheduledTask(jobId);
            await loadScheduledTasks();
        } catch (err) {
            console.error("Failed to cancel scheduled task:", err);
        }
    };

    const handleScroll = async (e) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        if (scrollHeight - scrollTop - clientHeight < 60) {
            if (loading || loadingMore || !hasMore) return;
            setLoadingMore(true);
            try {
                const nextOffset = threads.length;
                const data = await getHistory(PAGE_SIZE, nextOffset, searchTerm);
                if (Array.isArray(data)) {
                    if (data.length < PAGE_SIZE) {
                        setHasMore(false);
                    }
                    setThreads((prev) => {
                        const existingIds = new Set(prev.map((t) => String(t.id)));
                        const newItems = data.filter((t) => !existingIds.has(String(t.id)));
                        return [...prev, ...newItems];
                    });
                }
            } catch (err) {
                console.error("Failed to load more history:", err);
            } finally {
                setLoadingMore(false);
            }
        }
    };

    const formatDate = (isoString) => {
        if (!isoString) return "";
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const confirmDelete = async () => {
        if (!threadToDelete) return;
        try {
            await onDeleteThread(threadToDelete);
            setThreads((prev) => prev.filter((t) => t.id !== threadToDelete));
        } catch (err) {
            console.error("Failed to delete thread:", err);
        } finally {
            setThreadToDelete(null);
            setIsConfirmOpen(false);
        }
    };

    const getThreadFriendMeta = (threadId) => {
        if (!friendThreadMeta) return null;
        return friendThreadMeta[threadId] || friendThreadMeta[String(threadId)] || null;
    };

    const mergedThreads = useMemo(() => {
        const known = new Set((threads || []).map((t) => String(t.id)));
        const localOnly = Object.keys(sessionsByThread || {})
            .filter((threadId) => !known.has(String(threadId)))
            .filter((threadId) => {
                const messages = sessionsByThread[threadId] || [];
                return messages.length === 0 || messages.every((message) => message.id === undefined);
            })
            .map((threadId) => ({
                id: threadId,
                title: "Untitled Chat",
                created_at: null,
                updated_at: null,
            }));
        return [...localOnly, ...(threads || [])];
    }, [threads, sessionsByThread]);

    const filteredThreads = useMemo(() => {
        return mergedThreads.filter((t) =>
            (t.title || "Untitled Chat").toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [mergedThreads, searchTerm]);

    const groupedThreads = useMemo(() => {
        const groups = {
            today: { title: "Today", threads: [] },
            yesterday: { title: "Yesterday", threads: [] },
            previous7: { title: "Previous 7 Days", threads: [] },
            older: { title: "Older", threads: [] },
        };

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        filteredThreads.forEach((thread) => {
            const dateStr = thread.updated_at || thread.created_at;
            if (!dateStr) {
                groups.today.threads.push(thread);
                return;
            }

            const date = new Date(dateStr);
            const threadStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const diffDays = Math.round((todayStart - threadStart) / (1000 * 60 * 60 * 24));

            if (diffDays <= 0) {
                groups.today.threads.push(thread);
            } else if (diffDays === 1) {
                groups.yesterday.threads.push(thread);
            } else if (diffDays < 7) {
                groups.previous7.threads.push(thread);
            } else {
                groups.older.threads.push(thread);
            }
        });

        return Object.values(groups).filter((g) => g.threads.length > 0);
    }, [filteredThreads]);

    const renderContent = (closeOnSelect = false) => (
        <div className="flex flex-col h-full overflow-hidden select-none bg-neutral-900 text-neutral-100">
            {/* Top Row: Search + New Chat + Collapse */}
            <div className="p-2.5 pb-2 shrink-0 border-b border-neutral-800">
                <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                        <Search
                            size={13}
                            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
                        />
                        <input
                            type="text"
                            placeholder="Search chats..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-neutral-800/70 border border-neutral-700/50 hover:border-neutral-600 focus:border-neutral-500 rounded-lg pl-8 pr-6 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-500 outline-none transition-colors"
                        />
                        {searchTerm && (
                            <button
                                onClick={() => setSearchTerm("")}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            onNewChat();
                            if (closeOnSelect) onClose();
                        }}
                        className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-750 text-neutral-300 hover:text-white border border-neutral-700/50 transition-colors shrink-0"
                        title="New Chat (Ctrl+N)"
                    >
                        <Plus size={15} />
                    </button>
                    {isPersistent && onToggleCollapse && (
                        <button
                            onClick={onToggleCollapse}
                            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors shrink-0"
                            title="Collapse Sidebar"
                        >
                            <PanelLeftClose size={15} />
                        </button>
                    )}
                    {!isPersistent && (
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors shrink-0"
                            title="Close"
                        >
                            <X size={15} />
                        </button>
                    )}
                </div>
            </div>

            {/* Scrollable Center: Friends & Scheduled Accordions + Chat Threads */}
            <div
                className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2"
                onScroll={handleScroll}
            >
                {/* 1. Friends Accordion */}
                <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setFriendsOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800/40 transition-colors"
                    >
                        <span className="flex items-center gap-2">
                            <Users size={13} className="text-neutral-400" />
                            <span className="font-medium text-[11px]">Friends</span>
                            {friends.length > 0 && (
                                <span className="text-[10px] text-neutral-500 font-mono">
                                    ({friends.length})
                                </span>
                            )}
                        </span>
                        <ChevronDown
                            size={12}
                            className={`text-neutral-500 transition-transform duration-150 ${friendsOpen ? "rotate-180" : ""}`}
                        />
                    </button>

                    {friendsOpen && (
                        <div className="border-t border-neutral-800/70 p-1.5 space-y-1 bg-neutral-950/30">
                            {friends.length === 0 ? (
                                <div className="px-2 py-1.5 text-[11px] text-neutral-500 text-center">
                                    No connections yet.
                                </div>
                            ) : (
                                friends.map((friend) => (
                                    <div
                                        key={friend.id}
                                        className="flex items-center justify-between px-2 py-1 rounded bg-neutral-800/40 hover:bg-neutral-800/70 transition-colors"
                                    >
                                        <span className="text-xs text-neutral-300 truncate">
                                            {friend.name || "Friend"}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                onStartFriendChat(friend);
                                                if (closeOnSelect) onClose();
                                            }}
                                            className="text-[10px] text-emerald-400 hover:text-emerald-300 font-medium px-1.5 py-0.5 rounded hover:bg-emerald-500/10 transition-colors shrink-0"
                                        >
                                            Chat
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>

                {/* 2. Scheduled Tasks Accordion (Modeled identically to Friends) */}
                <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setScheduledOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800/40 transition-colors"
                    >
                        <span className="flex items-center gap-2">
                            <CalendarClock size={13} className="text-neutral-400" />
                            <span className="font-medium text-[11px]">Scheduled</span>
                            {scheduledTasks.length > 0 && (
                                <span className="text-[10px] text-neutral-500 font-mono">
                                    ({scheduledTasks.length})
                                </span>
                            )}
                        </span>
                        <ChevronDown
                            size={12}
                            className={`text-neutral-500 transition-transform duration-150 ${scheduledOpen ? "rotate-180" : ""}`}
                        />
                    </button>

                    {scheduledOpen && (
                        <div className="border-t border-neutral-800/70 p-1.5 space-y-1 bg-neutral-950/30">
                            {loadingTasks && scheduledTasks.length === 0 ? (
                                <div className="px-2 py-1.5 text-[11px] text-neutral-500 text-center">
                                    Loading…
                                </div>
                            ) : scheduledTasks.length === 0 ? (
                                <div className="px-2 py-1.5 text-[11px] text-neutral-500 text-center">
                                    No scheduled tasks.
                                </div>
                            ) : (
                                scheduledTasks.map((t) => (
                                    <div
                                        key={t.id}
                                        className="group relative rounded bg-neutral-800/40 hover:bg-neutral-800/70 p-1.5 transition-colors"
                                    >
                                        <div className="flex items-center justify-between gap-1">
                                            <span className="text-[9px] uppercase font-mono text-neutral-400">
                                                {INTENT_LABEL[t.intent] || t.intent || "Task"}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={(e) => handleCancelScheduledTask(e, t.id)}
                                                className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 transition-opacity p-0.5"
                                                title="Cancel"
                                            >
                                                <Trash2 size={11} />
                                            </button>
                                        </div>
                                        <div className="text-xs text-neutral-300 truncate mt-0.5">
                                            {t.title || t.text}
                                        </div>
                                        <div className="text-[10px] text-neutral-500 mt-0.5">
                                            {formatRunAt(t.run_at)}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </div>

                {/* 3. Chat History List */}
                <div className="pt-1">
                    {loading ? (
                        <div className="flex justify-center py-8">
                            <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-500 border-t-transparent" />
                        </div>
                    ) : error ? (
                        <div className="py-6 text-center text-xs text-red-400 space-y-1">
                            <p>{error}</p>
                            <button
                                onClick={loadInitialHistory}
                                className="text-[11px] text-neutral-400 hover:text-neutral-200 underline"
                            >
                                Retry
                            </button>
                        </div>
                    ) : filteredThreads.length === 0 ? (
                        <div className="py-8 text-center text-xs text-neutral-500">
                            {searchTerm ? "No chats match." : "No chats yet."}
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {groupedThreads.map((group) => (
                                <div key={group.title} className="space-y-0.5">
                                    <div className="px-2.5 py-1 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
                                        {group.title}
                                    </div>
                                    {group.threads.map((thread) => {
                                        const isActive = thread.id === currentThreadId;
                                        const isStreaming = streamingThreads.has(thread.id);
                                        const friendMeta = getThreadFriendMeta(thread.id);

                                        return (
                                            <button
                                                key={thread.id}
                                                onClick={() => {
                                                    onSelectThread(thread.id);
                                                    if (closeOnSelect) onClose();
                                                }}
                                                className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors group relative flex items-center justify-between ${
                                                    isActive
                                                        ? "bg-neutral-800 text-neutral-100 font-medium"
                                                        : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
                                                }`}
                                            >
                                                <div className="pr-5 min-w-0">
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-xs truncate">
                                                            {thread.title || "Untitled Chat"}
                                                        </span>
                                                        {Boolean(friendMeta?.isFriendChat || friendMeta?.friendId) && (
                                                            <span className="rounded bg-emerald-500/10 text-emerald-400 text-[9px] px-1 py-0.2 shrink-0">
                                                                Friend
                                                            </span>
                                                        )}
                                                        <KnowledgeHistoryBadge knowledgeNames={thread.knowledge_names} />
                                                        {isStreaming && (
                                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                                                        )}
                                                    </div>
                                                    <div className="text-[10px] opacity-50 mt-0.5">
                                                        {formatDate(thread.updated_at || thread.created_at)}
                                                    </div>
                                                </div>

                                                <div
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setThreadToDelete(thread.id);
                                                        setIsConfirmOpen(true);
                                                    }}
                                                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-neutral-500 hover:text-red-400 transition-all"
                                                    title="Delete conversation"
                                                >
                                                    <Trash2 size={12} />
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            ))}

                            {loadingMore && (
                                <div className="flex justify-center py-2">
                                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-emerald-500 border-t-transparent" />
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            <ConfirmationModal
                isOpen={isConfirmOpen}
                onClose={() => setIsConfirmOpen(false)}
                onConfirm={confirmDelete}
                title="Delete Chat?"
                message="This will permanently delete this conversation."
                confirmText="Delete"
            />
        </div>
    );

    // Persistent Docked Mode
    if (isPersistent) {
        return (
            <aside className="w-full bg-neutral-900 border-r border-neutral-800 flex flex-col h-full shrink-0 relative z-20">
                {renderContent(false)}
            </aside>
        );
    }

    // Floating Drawer Mode
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
                    />
                    <motion.aside
                        initial={{ x: "-100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "-100%" }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="fixed left-0 top-0 bottom-0 w-64 bg-neutral-900 border-r border-neutral-800 z-50 flex flex-col shadow-2xl"
                    >
                        {renderContent(true)}
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}

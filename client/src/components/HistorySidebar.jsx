import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Users, Trash2 } from 'lucide-react';
import { getHistory } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import { KnowledgeHistoryBadge } from './KnowledgeAttachmentChips';

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
}) {
    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [threadToDelete, setThreadToDelete] = useState(null);
    const [friendsOpen, setFriendsOpen] = useState(true);

    const isPersistent = windowMode === 'normal';
    const showSidebar = isOpen || isPersistent;
    const PAGE_SIZE = 15;

    useEffect(() => {
        if (!showSidebar) return;
        let isCancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const data = await getHistory(PAGE_SIZE, 0, searchTerm);
                if (!isCancelled) {
                    const loaded = Array.isArray(data) ? data : [];
                    setThreads(loaded);
                    setHasMore(loaded.length >= PAGE_SIZE);
                }
            } catch (err) {
                if (!isCancelled) {
                    console.error("Failed to load history:", err);
                    setError("Failed to load history");
                }
            } finally {
                if (!isCancelled) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            isCancelled = true;
        };
    }, [showSidebar, searchTerm]);

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
        const days = Math.floor((now - date) / (1000 * 60 * 60 * 24));
        if (days === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
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
        }
    };

    const getThreadFriendMeta = (threadId) => {
        if (!friendThreadMeta) return null;
        return friendThreadMeta[threadId] || friendThreadMeta[String(threadId)] || null;
    };
    const mergedThreads = (() => {
        const known = new Set((threads || []).map((t) => String(t.id)));
        const localOnly = Object.keys(sessionsByThread || {})
            .filter((threadId) => !known.has(String(threadId)))
            .map((threadId) => {
                const list = sessionsByThread[threadId] || [];
                return {
                    id: threadId,
                    title: "Untitled Chat",
                    created_at: null,
                    updated_at: null,
                };
            });
        return [...localOnly, ...(threads || [])];
    })();

    const filteredThreads = useMemo(() => {
        return mergedThreads.filter((t) =>
            (t.title || "Untitled Chat").toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [mergedThreads, searchTerm]);

    const groupedThreads = useMemo(() => {
        const groups = {
            today: { title: "Today", threads: [] },
            yesterday: { title: "Yesterday", threads: [] },
            twoDaysAgo: { title: "2 days ago", threads: [] },
            threeDaysAgo: { title: "3 days ago", threads: [] },
            fourDaysAgo: { title: "4 days ago", threads: [] },
            fiveDaysAgo: { title: "5 days ago", threads: [] },
            sixDaysAgo: { title: "6 days ago", threads: [] },
            lastWeek: { title: "Previous 7 Days", threads: [] },
            older: { title: "Older", threads: [] }
        };

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        filteredThreads.forEach(thread => {
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
            } else if (diffDays === 2) {
                groups.twoDaysAgo.threads.push(thread);
            } else if (diffDays === 3) {
                groups.threeDaysAgo.threads.push(thread);
            } else if (diffDays === 4) {
                groups.fourDaysAgo.threads.push(thread);
            } else if (diffDays === 5) {
                groups.fiveDaysAgo.threads.push(thread);
            } else if (diffDays === 6) {
                groups.sixDaysAgo.threads.push(thread);
            } else if (diffDays >= 7 && diffDays < 14) {
                groups.lastWeek.threads.push(thread);
            } else {
                groups.older.threads.push(thread);
            }
        });

        return Object.values(groups).filter(g => g.threads.length > 0);
    }, [filteredThreads]);


    const renderBody = (closeOnSelect = false) => (
        <>
            <div className="p-3">
                <div className="relative group">
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-neutral-800/50 border border-neutral-700/30 rounded-lg px-9 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-emerald-500/30 transition-all"
                    />
                </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1" onScroll={handleScroll}>
                <div className="rounded-lg border border-white/5 bg-neutral-900/50">
                    <button type="button" onClick={() => setFriendsOpen((prev) => !prev)} className="flex w-full items-center justify-between px-2.5 py-2 text-left text-xs font-semibold text-neutral-200">
                        <span className="inline-flex items-center gap-1.5"><Users size={13} /> Friends</span>
                        {friendsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </button>
                    {friendsOpen && (
                        <div className="space-y-1 border-t border-white/5 p-1.5">
                            {friends.map((friend) => {
                                return (
                                    <div key={friend.id} className="rounded-md border border-white/5 bg-neutral-900/45">
                                        <button type="button" onClick={() => onStartFriendChat(friend)} className="flex w-full items-center justify-between px-2 py-1.5 text-xs text-neutral-200">
                                            <span className="truncate">{friend.name || "Friend"}</span>
                                            <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">Chat</span>
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
                {loading ? (
                    <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-emerald-500"></div></div>
                ) : error ? (
                    <div className="py-6 text-center text-xs text-red-300">{error}</div>
                ) : (
                    <div className="space-y-4">
                        {groupedThreads.map((group) => (
                            <div key={group.title} className="space-y-1">
                                <div className="px-2.5 py-1 text-[10px] font-semibold text-neutral-500 uppercase tracking-wider">
                                    {group.title}
                                </div>
                                {group.threads.map((thread) => (
                                    <button
                                        key={thread.id}
                                        onClick={() => {
                                            onSelectThread(thread.id);
                                            if (closeOnSelect) onClose();
                                        }}
                                        className={`w-full text-left p-2.5 rounded-lg transition-all group relative border ${thread.id === currentThreadId ? "bg-neutral-800/80 border-neutral-700/50 text-neutral-100" : "border-transparent text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200"}`}
                                    >
                                        <div className="pr-6">
                                            <div className="flex items-center gap-1.5 mb-0.5">
                                                <div className="font-medium text-xs truncate">{thread.title || "Untitled Chat"}</div>
                                                {Boolean(getThreadFriendMeta(thread.id)?.isFriendChat || getThreadFriendMeta(thread.id)?.friendId) && <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] uppercase text-emerald-300">Friend</span>}
                                                <KnowledgeHistoryBadge knowledgeNames={thread.knowledge_names} />
                                                {streamingThreads.has(thread.id) && <span className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />}
                                            </div>
                                            <div className="text-[9px] opacity-40">{formatDate(thread.updated_at || thread.created_at)}</div>
                                        </div>
                                        <div onClick={(e) => { e.stopPropagation(); setThreadToDelete(thread.id); setIsConfirmOpen(true); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all">x</div>
                                    </button>
                                ))}
                            </div>
                        ))}
                        {loadingMore && (
                            <div className="flex justify-center py-2">
                                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-emerald-500" />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );

    if (isPersistent) {
        return (
            <div className="w-64 bg-neutral-900/40 border-r border-neutral-800/40 flex flex-col h-full shrink-0">
                <div className="p-4 border-b border-neutral-800/40"><h2 className="text-sm font-semibold text-neutral-100/70 uppercase tracking-wider">History</h2></div>
                {renderBody(false)}
                <ConfirmationModal isOpen={isConfirmOpen} onClose={() => setIsConfirmOpen(false)} onConfirm={confirmDelete} title="Delete Chat History?" message="This will permanently delete this conversation." confirmText="Delete" />
            </div>
        );
    }

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm z-40" />
                    <motion.div initial={{ x: "-100%" }} animate={{ x: 0 }} exit={{ x: "-100%" }} transition={{ type: "spring", stiffness: 300, damping: 30 }} className="absolute left-0 top-0 bottom-0 w-64 bg-neutral-900 border-r border-neutral-800 z-50 flex flex-col shadow-2xl">
                        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
                            <h2 className="text-lg font-semibold text-neutral-100">History</h2>
                            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors">x</button>
                        </div>
                        {renderBody(true)}
                    </motion.div>
                    <ConfirmationModal isOpen={isConfirmOpen} onClose={() => setIsConfirmOpen(false)} onConfirm={confirmDelete} title="Delete Chat History?" message="This will permanently delete this conversation." confirmText="Delete" />
                </>
            )}
        </AnimatePresence>
    );
}

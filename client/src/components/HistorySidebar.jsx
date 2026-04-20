import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, Users, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { getHistory } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import { resolveThreadTitle, resolveThreadFirstMessage } from '../utils/threadDisplay';

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
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [threadToDelete, setThreadToDelete] = useState(null);
    const [friendsOpen, setFriendsOpen] = useState(true);

    const isPersistent = windowMode === 'normal';
    const showSidebar = isOpen || isPersistent;

    useEffect(() => {
        if (!showSidebar) return;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const data = await getHistory();
                setThreads(Array.isArray(data) ? data : []);
            } catch (err) {
                console.error("Failed to load history:", err);
                setError("Failed to load history");
            } finally {
                setLoading(false);
            }
        })();
    }, [showSidebar]);

    useEffect(() => {
        const onRefresh = () => {
            if (!showSidebar) return;
            (async () => {
                try {
                    const data = await getHistory();
                    setThreads(Array.isArray(data) ? data : []);
                } catch (err) {
                    console.error("Failed to load history:", err);
                }
            })();
        };
        window.addEventListener('rie-history-refresh', onRefresh);
        return () => window.removeEventListener('rie-history-refresh', onRefresh);
    }, [showSidebar]);

    const parseTimestamp = (value) => {
        if (value === null || value === undefined || value === "") return null;
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
        if (typeof value === "number" && Number.isFinite(value)) {
            const millis = Math.abs(value) < 1e12 ? value * 1000 : value;
            const d = new Date(millis);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (!trimmed) return null;
            if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                const numeric = Number(trimmed);
                if (Number.isFinite(numeric)) {
                    const millis = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
                    const d = new Date(millis);
                    return Number.isNaN(d.getTime()) ? null : d;
                }
            }
            // DB legacy values are often UTC ISO strings without timezone suffix.
            // JS interprets those as local time, causing hour offsets in UI.
            const hasExplicitTimezone = /(?:[zZ]|[+\-]\d{2}:\d{2})$/.test(trimmed);
            const normalized = !hasExplicitTimezone && /^\d{4}-\d{2}-\d{2}T/.test(trimmed)
                ? `${trimmed}Z`
                : trimmed;
            const d = new Date(normalized);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        return null;
    };

    const formatDate = (value) => {
        const date = parseTimestamp(value);
        if (!date) return "";
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const days = Math.floor((startOfToday - startOfDate) / (1000 * 60 * 60 * 24));

        if (days <= 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
                const firstUser = list.find((m) => m?.from === "user" && m?.text?.trim());
                return {
                    id: threadId,
                    title: firstUser?.text?.slice(0, 42) || "Untitled Chat",
                    created_at: null,
                    updated_at: null,
                };
            });
        return [...localOnly, ...(threads || [])];
    })();

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
            <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
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
                    mergedThreads
                        .filter((t) => resolveThreadTitle(t, getThreadFriendMeta(t?.id), sessionsByThread).toLowerCase().includes(searchTerm.toLowerCase()))
                        .map((thread) => {
                            const threadMeta = getThreadFriendMeta(thread.id);
                            const isFriendThread = Boolean(threadMeta?.isFriendChat || threadMeta?.friendId);
                            const friendLabel = resolveThreadTitle(thread, threadMeta, sessionsByThread);
                            return (
                            <button
                                key={thread.id}
                                onClick={() => {
                                    onSelectThread(thread.id);
                                    if (closeOnSelect) onClose();
                                }}
                                className={`w-full text-left p-2.5 rounded-lg transition-all group relative border ${thread.id === currentThreadId ? "bg-neutral-800/80 border-neutral-700/50 text-neutral-100" : "border-transparent text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200"}`}
                            >
                                <div className="pr-6">
                                    <div className="font-medium text-xs truncate">
                                        {resolveThreadFirstMessage(thread, sessionsByThread)}
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <div className="text-[9px] opacity-40">{formatDate(thread.updated_at || thread.created_at)}</div>
                                        {isFriendThread && (
                                            <>
                                                <span className="text-[9px] opacity-40">•</span>
                                                <span className="text-[9px] opacity-50 truncate max-w-[90px]">{friendLabel}</span>
                                                {threadMeta?.isRemoteOrigin ? (
                                                    <ArrowDownLeft size={11} className="text-emerald-300 shrink-0" aria-label="Receiver thread" title="Receiver thread" />
                                                ) : (
                                                    <ArrowUpRight size={11} className="text-emerald-300 shrink-0" aria-label="Sender thread" title="Sender thread" />
                                                )}
                                            </>
                                        )}
                                        {streamingThreads.has(thread.id) && <span className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />}
                                    </div>
                                </div>
                                <div onClick={(e) => { e.stopPropagation(); setThreadToDelete(thread.id); setIsConfirmOpen(true); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all">x</div>
                            </button>
                        )})
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

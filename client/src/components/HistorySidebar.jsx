import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getHistory, deleteThread } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';

export function HistorySidebar({ isOpen, onClose, onSelectThread, onNewChat, currentThreadId, streamingThreads = new Set(), windowMode }) {
    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [threadToDelete, setThreadToDelete] = useState(null);

    const isPersistent = windowMode === 'normal';
    const showSidebar = isOpen || isPersistent;

    useEffect(() => {
        if (showSidebar) {
            loadThreads();
        }
    }, [showSidebar]);

    const loadThreads = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await getHistory();
            setThreads(data);
        } catch (err) {
            console.error("Failed to load history:", err);
            setError("Failed to load history");
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
            setThreads(prev => prev.filter(t => t.id === threadToDelete ? false : true));
            if (threadToDelete === currentThreadId) {
                onNewChat();
            }
        } catch (err) {
            console.error("Failed to delete thread:", err);
        } finally {
            setThreadToDelete(null);
        }
    };

    const formatDate = (isoString) => {
        const date = new Date(isoString);
        const now = new Date();
        const diff = now - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (days < 7) {
            return date.toLocaleDateString([], { weekday: 'short' });
        } else {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
    };

    if (isPersistent) {
        return (
            <div className="w-64 bg-neutral-900/40 border-r border-neutral-800/40 flex flex-col h-full shrink-0">
                {/* Header */}
                <div className="p-4 border-b border-neutral-800/40 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-neutral-100/70 uppercase tracking-wider">History</h2>
                </div>

                {/* Search Bar */}
                <div className="p-3">
                    <div className="relative group">
                        <input
                            type="text"
                            placeholder="Search..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-neutral-800/50 border border-neutral-700/30 rounded-lg px-9 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-emerald-500/30 transition-all"
                        />
                        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                        </div>
                    </div>
                </div>

                {/* Thread List */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                    {loading ? (
                        <div className="flex justify-center py-8">
                            <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-emerald-500"></div>
                        </div>
                    ) : (
                        threads.filter(t => (t.title || "Untitled Chat").toLowerCase().includes(searchTerm.toLowerCase())).map(thread => (
                            <button
                                key={thread.id}
                                onClick={() => onSelectThread(thread.id)}
                                className={`w-full text-left p-2.5 rounded-lg transition-all group relative border ${thread.id === currentThreadId
                                    ? "bg-neutral-800/80 border-neutral-700/50 text-neutral-100"
                                    : "border-transparent text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200"
                                    }`}
                            >
                                <div className="pr-6">
                                    <div className="flex items-center gap-1.5 mb-0.5">
                                        <div className="font-medium text-xs truncate">{thread.title || "Untitled Chat"}</div>
                                        {streamingThreads.has(thread.id) && (
                                            <div className="flex items-center gap-1 shrink-0">
                                                <span className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />
                                            </div>
                                        )}
                                    </div>
                                    <div className="text-[9px] opacity-40">{formatDate(thread.updated_at || thread.created_at)}</div>
                                </div>
                                <div
                                    onClick={(e) => handleDeleteClick(e, thread.id)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all"
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
                <ConfirmationModal
                    isOpen={isConfirmOpen}
                    onClose={() => setIsConfirmOpen(false)}
                    onConfirm={confirmDelete}
                    title="Delete Chat History?"
                    message="This will permanently delete this conversation."
                    confirmText="Delete"
                />
            </div>
        );
    }

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/50 backdrop-blur-sm z-40"
                    />

                    {/* Drawer */}
                    <motion.div
                        initial={{ x: "-100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "-100%" }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="absolute left-0 top-0 bottom-0 w-64 bg-neutral-900 border-r border-neutral-800 z-50 flex flex-col shadow-2xl"
                    >
                        {/* Header */}
                        <div className="p-4 border-b border-neutral-800 flex items-center justify-between">
                            <h2 className="text-lg font-semibold text-neutral-100">History</h2>
                            <button
                                onClick={onClose}
                                className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition-colors"
                                title="Close History"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>

                        {/* Search Bar */}
                        <div className="p-4">
                            <div className="relative group">
                                <input
                                    type="text"
                                    placeholder="Search chats..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    className="w-full bg-neutral-800 border border-neutral-700/50 rounded-xl px-10 py-2.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all"
                                />
                                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-500 group-focus-within:text-emerald-500 transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="11" cy="11" r="8" />
                                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                    </svg>
                                </div>
                                {searchTerm && (
                                    <button
                                        onClick={() => setSearchTerm("")}
                                        className="absolute right-3.5 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18" />
                                            <line x1="6" y1="6" x2="18" y2="18" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Thread List */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
                            {loading ? (
                                <div className="flex justify-center py-8">
                                    <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-emerald-500"></div>
                                </div>
                            ) : error ? (
                                <div className="text-center py-8 text-neutral-500 text-sm">
                                    {error}
                                    <button onClick={loadThreads} className="block mx-auto mt-2 text-emerald-400 hover:underline">
                                        Retry
                                    </button>
                                </div>
                            ) : (
                                (() => {
                                    const filteredThreads = threads.filter(thread =>
                                        (thread.title || "Untitled Chat").toLowerCase().includes(searchTerm.toLowerCase())
                                    );

                                    if (filteredThreads.length === 0) {
                                        return (
                                            <div className="text-center py-8 text-neutral-500 text-sm">
                                                {searchTerm ? "No chats match your search." : "No history found."}
                                            </div>
                                        );
                                    }

                                    return filteredThreads.map(thread => (
                                        <button
                                            key={thread.id}
                                            onClick={() => {
                                                onSelectThread(thread.id);
                                                onClose();
                                            }}
                                            className={`w-full text-left p-3 rounded-xl transition-all group relative border ${thread.id === currentThreadId
                                                ? "bg-neutral-800 border-neutral-700 text-neutral-100"
                                                : "border-transparent text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
                                                }`}
                                        >
                                            <div className="pr-6">
                                                <div className="flex items-center gap-1.5 mb-0.5">
                                                    <div className="font-medium text-sm truncate">{thread.title || "Untitled Chat"}</div>
                                                    {streamingThreads.has(thread.id) && (
                                                        <div className="flex items-center gap-1 shrink-0">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="text-[10px] opacity-60">{formatDate(thread.updated_at || thread.created_at)}</div>
                                            </div>

                                            <div
                                                onClick={(e) => handleDeleteClick(e, thread.id)}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-400 transition-all"
                                                title="Delete Chat"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <polyline points="3 6 5 6 21 6"></polyline>
                                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                                </svg>
                                            </div>
                                        </button>
                                    ));
                                })()
                            )}
                        </div>
                    </motion.div>
                    <ConfirmationModal
                        isOpen={isConfirmOpen}
                        onClose={() => setIsConfirmOpen(false)}
                        onConfirm={confirmDelete}
                        title="Delete Chat History?"
                        message="This will permanently delete this conversation and all its messages."
                        confirmText="Delete"
                    />
                </>
            )}
        </AnimatePresence>
    );
}

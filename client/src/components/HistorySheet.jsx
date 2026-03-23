
import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fetchHistory, deleteChat } from "../services/chatApi";
import { ConfirmationModal } from './ConfirmationModal';

export const HistorySheet = ({ isOpen, onClose, onSelectChat }) => {
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [chatToDelete, setChatToDelete] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");

    useEffect(() => {
        if (isOpen) {
            loadHistory();
        }
    }, [isOpen]);

    const loadHistory = async () => {
        setLoading(true);
        try {
            const data = await fetchHistory();
            setHistory(data);
        } catch (error) {
            console.error("Failed to load history:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteClick = (e, id) => {
        e.stopPropagation();
        setChatToDelete(id);
        setIsConfirmOpen(true);
    };

    const confirmDelete = async () => {
        if (!chatToDelete) return;

        try {
            await deleteChat(chatToDelete);
            setHistory((prev) => prev.filter((chat) => chat.id !== chatToDelete));
        } catch (error) {
            console.error("Failed to delete chat:", error);
        } finally {
            setChatToDelete(null);
        }
    };

    const formatTime = (timestamp) => {
        const date = new Date(timestamp * 1000);
        return date.toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.5 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black z-40"
                    />

                    {/* Bottom Sheet */}
                    <motion.div
                        initial={{ y: "100%" }}
                        animate={{ y: 0 }}
                        exit={{ y: "100%" }}
                        transition={{ type: "spring", damping: 25, stiffness: 200 }}
                        className="fixed bottom-0 left-0 right-0 h-[80%] bg-neutral-900 rounded-t-3xl z-50 overflow-hidden shadow-2xl border-t border-white/10 flex flex-col"
                    >
                        {/* Handle Bar */}
                        <div className="flex justify-center pt-3 pb-2" onClick={onClose}>
                            <div className="w-16 h-1.5 bg-neutral-700 rounded-full" />
                        </div>

                        <div className="px-6 pb-4 border-b border-white/10">
                            <div className="flex justify-between items-center mb-4">
                                <h2 className="text-xl font-semibold text-white">History</h2>
                                <button
                                    onClick={onClose}
                                    className="text-neutral-400 hover:text-white transition-colors text-sm"
                                >
                                    Close
                                </button>
                            </div>
                            <div className="relative group">
                                <input
                                    type="text"
                                    placeholder="Search your chats..."
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

                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {loading ? (
                                <div className="text-center text-neutral-500 py-8">Loading...</div>
                            ) : (
                                (() => {
                                    const filteredHistory = history.filter(chat =>
                                        (chat.title || "New Chat").toLowerCase().includes(searchTerm.toLowerCase())
                                    );

                                    if (filteredHistory.length === 0) {
                                        return (
                                            <div className="text-center py-8 text-neutral-500 text-sm">
                                                {searchTerm ? "No chats match your search." : "No history found."}
                                            </div>
                                        );
                                    }

                                    return filteredHistory.map((chat) => (
                                        <motion.div
                                            key={chat.id}
                                            layoutId={chat.id}
                                            onClick={() => onSelectChat(chat.id)}
                                            className="group flex flex-col p-4 rounded-xl bg-neutral-800/50 hover:bg-neutral-800 border border-white/5 hover:border-white/10 transition-all cursor-pointer relative"
                                        >
                                            <div className="flex justify-between items-start mb-1 h-30px">
                                                <span className="font-medium text-white truncate pr-8">{chat.title || "New Chat"}</span>
                                                <div className="flex flex-col gap-5 items-end">
                                                    <span className="text-xs text-neutral-500 whitespace-nowrap">{formatTime(chat.updated_at)}</span>
                                                    <button
                                                        onClick={(e) => handleDeleteClick(e, chat.id)}
                                                        className="opacity-0 group-hover:opacity-100 p-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-400/10 rounded-full transition-all"
                                                        title="Delete Chat"
                                                    >
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                            <path d="M3 6h18"></path>
                                                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                                        </svg>
                                                    </button>
                                                </div>
                                            </div>
                                        </motion.div>
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
};

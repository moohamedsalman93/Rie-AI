import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { MarkdownMessage } from "./MarkdownMessage";

const HOVER_DELAY_MS = 120;

// Extract todo items with content + status from write_todos tool output
// Handles both Python-style [{'content': '...', 'status': '...'}] and JSON
function parseTodoContent(raw) {
    if (!raw || typeof raw !== "string") return null;
    const str = raw.trim();

    // Try JSON first (e.g. after normalizing single quotes in safe cases)
    const listMatch = str.match(/\[[\s\S]*\]/);
    if (listMatch) {
        const listStr = listMatch[0];
        try {
            const jsonStr = listStr.replace(/'/g, '"');
            const list = JSON.parse(jsonStr);
            if (!Array.isArray(list)) return null;
            const items = list
                .map((item) => {
                    if (item && typeof item === "object" && "content" in item) {
                        return {
                            content: typeof item.content === "string" ? item.content : String(item.content),
                            status: typeof item.status === "string" ? item.status : (item.status ?? "pending"),
                        };
                    }
                    return null;
                })
                .filter(Boolean);
            if (items.length) return items;
        } catch {
            // fall through to regex
        }

        // Python-style: 'content': '...', 'status': '...' (content can contain escaped or simple quotes)
        const re = /'content':\s*'((?:[^'\\]|\\.)*)'\s*,\s*'status':\s*'([^']*)'/g;
        const items = [];
        let m;
        while ((m = re.exec(listStr)) !== null) {
            items.push({ content: m[1].replace(/\\./g, (c) => (c === "\\'" ? "'" : c)), status: m[2] || "pending" });
        }
        if (items.length) return items;
    }

    return null;
}

export const ToolChip = ({ name, content }) => {
    const [showPopup, setShowPopup] = useState(false);
    const hideTimeoutRef = useRef(null);
    const triggerRef = useRef(null);
    const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });

    const updatePopupPosition = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        setPopupPos({ top: r.bottom + 4, left: r.left });
    }, []);

    const show = () => {
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = null;
        }
        setShowPopup(true);
    };

    const hide = () => {
        hideTimeoutRef.current = setTimeout(() => setShowPopup(false), HOVER_DELAY_MS);
    };

    useLayoutEffect(() => {
        if (!showPopup) return;
        updatePopupPosition();
    }, [showPopup, updatePopupPosition]);

    useEffect(() => {
        if (!showPopup) return;
        const onScrollOrResize = () => updatePopupPosition();
        window.addEventListener("scroll", onScrollOrResize, true);
        window.addEventListener("resize", onScrollOrResize);
        return () => {
            window.removeEventListener("scroll", onScrollOrResize, true);
            window.removeEventListener("resize", onScrollOrResize);
        };
    }, [showPopup, updatePopupPosition]);

    // Helper to format the tool name
    const formatToolName = (name) => {
        if (!name) return "SYSTEM OPERATION";
        return name
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ')
            .toUpperCase();
    };

    const isWriteTodos = name && (name.toLowerCase() === "write_todos" || name.toLowerCase() === "write todos");
    const todoItems = isWriteTodos ? parseTodoContent(content) : null;

    const popupNode = (
        <AnimatePresence>
            {showPopup && (
                <motion.div
                    initial={{ opacity: 0, y: -4, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.96 }}
                    transition={{ duration: 0.15 }}
                    style={{ top: popupPos.top, left: popupPos.left }}
                    className="fixed z-[1000] min-w-[200px] max-w-[320px] rounded-lg bg-neutral-900 border border-neutral-700 shadow-xl p-3 text-xs text-neutral-300 custom-scrollbar max-h-64 overflow-y-auto"
                    onMouseEnter={show}
                    onMouseLeave={hide}
                >
                    {todoItems ? (
                        <div>
                            <div className="flex items-center gap-2 mb-2 pb-2 border-b border-neutral-700/50">
                                <svg className="shrink-0 text-neutral-500" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="8" y1="6" x2="21" y2="6" />
                                    <line x1="8" y1="12" x2="21" y2="12" />
                                    <line x1="8" y1="18" x2="21" y2="18" />
                                    <circle cx="4" cy="6" r="1.5" fill="currentColor" />
                                    <circle cx="4" cy="12" r="1.5" fill="currentColor" />
                                    <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                                </svg>
                                <span className="text-xs font-medium text-neutral-400">To-dos {todoItems.length}</span>
                            </div>
                            <ul className="space-y-1.5 list-none p-0 m-0">
                                {todoItems.map((item, i) => (
                                    <li key={i} className="flex items-start gap-2">
                                        <span className="shrink-0 mt-0.5 text-neutral-500">
                                            {item.status === "completed" ? (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <circle cx="12" cy="12" r="10" />
                                                    <path d="M8 12l3 3 5-6" />
                                                </svg>
                                            ) : (
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <circle cx="12" cy="12" r="10" />
                                                    <line x1="15" y1="9" x2="9" y2="15" />
                                                    <line x1="9" y1="9" x2="15" y2="15" />
                                                </svg>
                                            )}
                                        </span>
                                        <span className="text-[11px] text-neutral-500/90 leading-snug">{item.content}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : (
                        <MarkdownMessage content={content} />
                    )}
                </motion.div>
            )}
        </AnimatePresence>
    );

    return (
        <div className="inline-flex flex-col my-1">
            <span
                ref={triggerRef}
                onMouseEnter={show}
                onMouseLeave={hide}
                className="group inline-flex items-center gap-1.5 cursor-default"
            >
                <span className="text-[10px] font-medium text-neutral-500/70 tracking-wide truncate">
                    {formatToolName(name)}
                </span>
                <span className="flex shrink-0 text-neutral-500/60 group-hover:text-neutral-500/90">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                    </svg>
                </span>
            </span>

            {typeof document !== "undefined" ? createPortal(popupNode, document.body) : null}
        </div>
    );
};

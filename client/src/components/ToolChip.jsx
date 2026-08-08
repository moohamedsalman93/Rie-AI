import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo } from "react";
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
        let match;
        while ((match = re.exec(listStr)) !== null) {
            items.push({ content: match[1], status: match[2] });
        }
        if (items.length) return items;
    }

    return null;
}

function formatToolName(name) {
    if (!name) return "tool";
    const raw = String(name);

    if (raw === "run_terminal_command") return "Ran terminal command";
    if (raw === "list_directory") return "Listed directory";
    if (raw === "view_file") return "Viewed file";
    if (raw === "write_file") return "Wrote to file";
    if (raw === "delete_file") return "Deleted file";
    if (raw === "grep_search") return "Searched codebase";
    if (raw === "web_search") return "Searched the web";
    if (raw === "fetch_web_page") return "Fetched web page";
    if (raw === "python_eval") return "Executed Python script";
    if (raw === "take_screenshot") return "Took screenshot";
    if (raw === "view_screen") return "Captured screen content";
    if (raw === "write_todos") return "Updated plan todos";
    if (raw === "browser_subagent") return "Ran browser subagent";
    if (raw === "add_knowledge") return "Saved to knowledge base";
    if (raw === "search_knowledge") return "Searched knowledge base";

    return raw.replace(/_/g, " ");
}

export const ToolChip = memo(({ name, content, tooltipPlacement = "bottom" }) => {
    const [showPopup, setShowPopup] = useState(false);
    const hideTimeoutRef = useRef(null);
    const triggerRef = useRef(null);
    const popupRef = useRef(null);
    const [popupPos, setPopupPos] = useState({ top: 0, left: 0 });

    const updatePopupPosition = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const isTop = tooltipPlacement === "top";
        const popupHeight = popupRef.current?.offsetHeight || 180;
        const newTop = Math.round(isTop ? Math.max(10, r.top - popupHeight - 8) : Math.min(window.innerHeight - popupHeight - 10, r.bottom + 4));
        const newLeft = Math.round(Math.max(10, Math.min(r.left, window.innerWidth - 340)));

        setPopupPos((prev) => {
            if (prev.top === newTop && prev.left === newLeft) return prev;
            return { top: newTop, left: newLeft };
        });
    }, [tooltipPlacement]);

    const show = useCallback(() => {
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = null;
        }
        if (triggerRef.current) {
            const r = triggerRef.current.getBoundingClientRect();
            const isTop = tooltipPlacement === "top";
            const initialTop = Math.round(isTop ? Math.max(10, r.top - 180) : Math.min(window.innerHeight - 190, r.bottom + 4));
            const initialLeft = Math.round(Math.max(10, Math.min(r.left, window.innerWidth - 340)));
            setPopupPos({ top: initialTop, left: initialLeft });
        }
        setShowPopup(true);
    }, [tooltipPlacement]);

    const hide = useCallback(() => {
        if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = setTimeout(() => {
            setShowPopup(false);
        }, HOVER_DELAY_MS);
    }, []);

    useEffect(() => {
        if (!showPopup) return;
        updatePopupPosition();
        const handleScrollOrResize = () => updatePopupPosition();
        window.addEventListener("scroll", handleScrollOrResize, true);
        window.addEventListener("resize", handleScrollOrResize);
        return () => {
            window.removeEventListener("scroll", handleScrollOrResize, true);
            window.removeEventListener("resize", handleScrollOrResize);
        };
    }, [showPopup, updatePopupPosition]);

    const isWriteTodos = name && (name.toLowerCase() === "write_todos" || name.toLowerCase() === "write todos");
    const todoItems = isWriteTodos ? parseTodoContent(content) : null;

    const displayContent = useMemo(() => {
        if (!content || typeof content !== "string") return "";
        if (content.length > 2500) {
            return content.slice(0, 2500) + "\n\n... *(output truncated for tooltip preview)*";
        }
        return content;
    }, [content]);

    const popupNode = (
        <AnimatePresence>
            {showPopup && (
                <motion.div
                    ref={popupRef}
                    initial={{ opacity: 0, y: tooltipPlacement === "top" ? 4 : -4, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: tooltipPlacement === "top" ? 4 : -4, scale: 0.96 }}
                    transition={{ duration: 0.12 }}
                    style={{
                        top: popupPos.top,
                        left: popupPos.left,
                    }}
                    className="fixed z-[1000] min-w-[200px] max-w-[320px] rounded-lg bg-neutral-900 border border-neutral-700 shadow-xl p-3 text-xs text-neutral-300 custom-scrollbar max-h-64 overflow-y-auto pointer-events-auto"
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
                        <MarkdownMessage content={displayContent} />
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

            {showPopup && typeof document !== "undefined" ? createPortal(popupNode, document.body) : null}
        </div>
    );
});

ToolChip.displayName = "ToolChip";


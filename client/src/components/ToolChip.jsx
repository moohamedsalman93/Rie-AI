import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Wrench, ChevronDown, ChevronUp, MessageSquare, ExternalLink } from "lucide-react";
import { MarkdownMessage } from "./MarkdownMessage";
import { useChatStore } from "../stores/useChatStore";

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

  const togglePopup = useCallback((e) => {
    e?.stopPropagation();
    setShowPopup((prev) => {
      const nextState = !prev;
      if (nextState && triggerRef.current) {
        const r = triggerRef.current.getBoundingClientRect();
        const isTop = tooltipPlacement === "top";
        const initialTop = Math.round(isTop ? Math.max(10, r.top - 180) : Math.min(window.innerHeight - 190, r.bottom + 4));
        const initialLeft = Math.round(Math.max(10, Math.min(r.left, window.innerWidth - 340)));
        setPopupPos({ top: initialTop, left: initialLeft });
      }
      return nextState;
    });
  }, [tooltipPlacement]);

  useEffect(() => {
    if (!showPopup) return;
    updatePopupPosition();

    const handleClickOutside = (e) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target)
      ) {
        setShowPopup(false);
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setShowPopup(false);
      }
    };

    const handleScrollOrResize = () => updatePopupPosition();

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [showPopup, updatePopupPosition]);

  const isWriteTodos = useMemo(() => {
    if (!name) return false;
    const lower = name.toLowerCase();
    return lower === "write_todos" || lower === "write todos";
  }, [name]);

  const todoItems = useMemo(() => {
    if (!showPopup || !isWriteTodos) return null;
    return parseTodoContent(content);
  }, [showPopup, isWriteTodos, content]);

  const displayContent = useMemo(() => {
    if (!showPopup || !content || typeof content !== "string") return "";
    if (content.length > 2500) {
      return content.slice(0, 2500) + "\n\n... *(output truncated for tooltip preview)*";
    }
    return content;
  }, [content, showPopup]);

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
        <div className="inline-flex flex-col my-0.5">
            <button
                type="button"
                ref={triggerRef}
                onClick={togglePopup}
                className="group inline-flex items-center gap-1.5 cursor-pointer select-none text-left focus:outline-none"
            >
                <Wrench
                    size={10}
                    className="shrink-0 text-neutral-500/70 group-hover:text-neutral-300 transition-colors"
                />
                <span className="text-[10px] font-medium text-neutral-500/70 group-hover:text-neutral-300 transition-colors tracking-wide truncate">
                    {formatToolName(name)}
                </span>
                <span className="flex shrink-0 text-neutral-500/60 group-hover:text-neutral-200 transition-colors">
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
            </button>

      {showPopup && typeof document !== "undefined" ? createPortal(popupNode, document.body) : null}
    </div>
  );
});

ToolChip.displayName = "ToolChip";

export const SubAgentActivity = memo(({ block, onOpenSubchat }) => {
  const [expanded, setExpanded] = useState(false);
  const running = block.status === "running";
  const displayName = String(block.name || "subagent").replace(/_/g, " ");
  const initial = displayName.trim().charAt(0).toUpperCase() || "A";
  const { openSubchat, activeThreadId } = useChatStore();

  const subchatId = block.subchatId || (block.id ? (String(block.id).startsWith("subchat_") ? block.id : `subchat_${block.id}`) : null);

  const handleOpen = useCallback((e) => {
    e?.stopPropagation();
    if (!subchatId) return;
    if (onOpenSubchat) {
      onOpenSubchat(subchatId, activeThreadId, displayName, block.name);
    } else if (openSubchat) {
      openSubchat(subchatId, activeThreadId, displayName, block.name);
    }
  }, [subchatId, onOpenSubchat, openSubchat, activeThreadId, displayName, block.name]);

  return (
    <div className="my-2 max-w-2xl rounded-xl border border-white/[0.06] bg-neutral-900/40 p-2 transition-all">
      <div className="w-full flex items-center justify-between gap-2.5">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="group flex-1 flex items-center gap-2.5 text-left focus:outline-none min-w-0 cursor-pointer"
        >
          <div className="relative shrink-0">
            {block.image ? (
              <img src={block.image} alt="" className="w-7 h-7 rounded-lg object-cover border border-neutral-700" />
            ) : (
              <div className="w-7 h-7 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center text-xs font-semibold text-neutral-300">
                {initial}
              </div>
            )}
            <span className={`absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full border-2 border-neutral-950 ${running ? "bg-amber-400 animate-pulse" : "bg-emerald-500"}`} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-xs font-medium text-neutral-200 capitalize truncate">{displayName}</span>
              <span className="text-[10px] text-neutral-500 shrink-0">
                {running ? "working" : "completed"}
              </span>
            </div>
            <p className="text-[11px] leading-4 text-neutral-400 truncate">{block.description}</p>
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          {subchatId && (
            <button
              type="button"
              onClick={handleOpen}
              className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 rounded-md transition-colors cursor-pointer"
              title="Open Subchat Thread"
            >
              <MessageSquare size={11} />
              <span>Subchat</span>
              <ExternalLink size={9} className="opacity-70" />
            </button>
          )}

          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="p-1 text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="ml-9 mt-2 pl-3 border-l border-neutral-800 text-xs text-neutral-400 space-y-2.5 pb-1">
          <div>
            <div className="text-[10px] text-neutral-500 mb-0.5 font-medium uppercase tracking-wider">Delegated Task</div>
            <div className="leading-relaxed text-neutral-300">{block.description}</div>
          </div>
          {block.result && (
            <div>
              <div className="text-[10px] text-neutral-500 mb-0.5 font-medium uppercase tracking-wider">Report & Result</div>
              <MarkdownMessage content={block.result} />
            </div>
          )}
          {subchatId && (
            <div className="pt-1">
              <button
                type="button"
                onClick={handleOpen}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-neutral-200 bg-neutral-800/80 hover:bg-neutral-800 border border-neutral-700 rounded-lg transition-colors cursor-pointer"
              >
                <MessageSquare size={12} className="text-emerald-400" />
                <span>View Full Subchat Conversation</span>
                <ExternalLink size={11} className="text-neutral-400" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

SubAgentActivity.displayName = "SubAgentActivity";

export const ToolCallGroup = memo(({ blocks, tooltipPlacement = "bottom" }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!blocks || blocks.length === 0) return null;

    if (blocks.length < 3) {
        return (
            <div className="flex flex-col gap-0.5 my-0.5">
                {blocks.map((block, idx) => (
                    <ToolChip
                        key={idx}
                        name={block.name}
                        content={block.text}
                        tooltipPlacement={tooltipPlacement}
                    />
                ))}
            </div>
        );
    }

    const count = blocks.length;
    const label = `Ran ${count} ${count === 1 ? "tool" : "tools"}`;

    return (
        <div className="my-1.5 w-full">
            <button
                type="button"
                onClick={() => setIsExpanded((prev) => !prev)}
                className="group inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors select-none py-0.5 cursor-pointer focus:outline-none"
            >
                <Wrench
                    size={12}
                    className="text-neutral-500 group-hover:text-neutral-300 transition-colors shrink-0"
                />
                <span className="text-[11px] font-medium tracking-wide">
                    {label}
                </span>
                <span className="text-neutral-500 group-hover:text-neutral-300 transition-colors shrink-0">
                    {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </span>
            </button>

            {isExpanded && (
                <div className="mt-1 ml-1 pl-3 border-l border-neutral-800 flex flex-col gap-1 py-0.5">
                    {blocks.map((block, idx) => (
                        <ToolChip
                            key={idx}
                            name={block.name}
                            content={block.text}
                            tooltipPlacement={tooltipPlacement}
                        />
                    ))}
                </div>
            )}
        </div>
    );
});

ToolCallGroup.displayName = "ToolCallGroup";

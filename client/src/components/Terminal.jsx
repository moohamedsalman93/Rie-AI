import { motion, AnimatePresence } from "framer-motion";
import { useLayoutEffect, useRef } from "react";

export function Terminal({ isOpen, onClose, onClear, logs = [] }) {
    const scrollRef = useRef(null);
    const bottomRef = useRef(null);

    useLayoutEffect(() => {
        if (!isOpen) return;
        bottomRef.current?.scrollIntoView({ block: "end", behavior: "instant" });
        const el = scrollRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [logs, isOpen]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0, y: 100 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 100 }}
                    transition={{ type: "spring", damping: 25, stiffness: 200 }}
                    className="absolute inset-x-2 bottom-16 top-12 z-50 flex flex-col rounded-lg overflow-hidden border border-neutral-800 bg-[#0c0c0c] shadow-2xl shadow-black/60"
                >
                    {/* Title bar - minimal, terminal-style */}
                    <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1a1a] border-b border-neutral-800 shrink-0">
                        <div className="flex items-center gap-2">
                            <div className="flex gap-1">
                                <div className="h-2 w-2 rounded-full bg-[#ff5f56]" />
                                <div className="h-2 w-2 rounded-full bg-[#ffbd2e]" />
                                <div className="h-2 w-2 rounded-full bg-[#27c93f]" />
                            </div>
                            <span className="text-[10px] font-medium text-neutral-500 ml-1.5 font-mono">
                                System Terminal
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={onClear}
                                className="rounded p-1 text-neutral-500 hover:bg-neutral-700/50 hover:text-neutral-300 transition-colors"
                                title="Clear Terminal"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18"></path>
                                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                </svg>
                            </button>
                            <button
                                onClick={onClose}
                                className="rounded p-1 text-neutral-500 hover:bg-neutral-700/50 hover:text-neutral-300 font-mono"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        </div>
                    </div>

                    {/* Terminal content - single scroll, raw output */}
                    <div
                        ref={scrollRef}
                        className="flex-1 overflow-y-auto overflow-x-auto p-3 font-mono text-[12px] leading-[1.45] text-[#d4d4d4] selection:bg-emerald-500/30 custom-scrollbar"
                        style={{ fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace" }}
                    >
                        {logs.length === 0 ? (
                            <div className="flex h-full items-center justify-center text-neutral-600 text-xs">
                                <span className="text-[#3d8b40]">$</span>
                                <span className="animate-pulse ml-1">_</span>
                            </div>
                        ) : (
                            <>
                                {logs.map((log, i) => (
                                    <div key={i} className="mb-1">
                                        {/* Prompt + command (single line like real terminal) */}
                                        <div className="flex items-baseline gap-1 flex-wrap">
                                            <span className="text-[#3d8b40] shrink-0">$</span>
                                            <span className="text-[#d4d4d4] break-all">{log.command || "(command)"}</span>
                                        </div>
                                        {/* Stdout - raw lines, no extra box */}
                                        {log.stdout && (
                                            <pre className="mt-0 mb-0 whitespace-pre-wrap break-all text-[#d4d4d4] font-inherit text-inherit leading-[1.45]">{log.stdout}</pre>
                                        )}
                                        {/* Stderr - red, like real terminal */}
                                        {log.stderr && (
                                            <pre className="mt-0 mb-0 whitespace-pre-wrap break-all text-[#f14c4c] font-inherit text-inherit leading-[1.45]">{log.stderr}</pre>
                                        )}
                                        {log.status === "ok" && !log.stdout && !log.stderr && (
                                            <pre className="mt-0 mb-0 text-neutral-600 text-[11px]">(no output)</pre>
                                        )}
                                        {/* Exit code inline like shell (optional, subtle) */}
                                        {log.returncode !== undefined && (
                                            <span className={`text-[10px] ${log.returncode === 0 ? "text-neutral-600" : "text-[#f14c4c]/80"}`}>
                                                {" "}[exit {log.returncode}]
                                            </span>
                                        )}
                                    </div>
                                ))}
                                {/* Blinking cursor */}
                                <div className="flex items-center gap-0 mt-0.5">
                                    <span className="text-[#3d8b40]">$</span>
                                    <span className="w-2 h-3.5 bg-[#3d8b40] ml-0.5 terminal-cursor" />
                                </div>
                                <div ref={bottomRef} className="h-0 w-0 shrink-0" aria-hidden />
                            </>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

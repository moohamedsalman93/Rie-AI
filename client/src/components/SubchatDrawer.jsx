import { useState, useEffect, useRef, useCallback, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Bot,
  Loader2,
  Send,
  ExternalLink,
  ChevronRight,
  ArrowLeft,
  Terminal,
  Clock,
  Sparkles,
} from "lucide-react";
import { getThreadMessages, streamChat, getThreadInfo } from "../services/chatApi";
import { MarkdownMessage } from "./MarkdownMessage";
import { ToolChip, ToolCallGroup } from "./ToolChip";

function parseSubchatMessageBlocks(msg) {
  if (msg.blocks && Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    return msg.blocks;
  }
  const content = String(msg.content || msg.text || "").trim();
  if (!content) return [{ type: "text", text: "" }];

  // Look for serialized tool calls or output blocks
  if (content.startsWith("[Tool Call:")) {
    const endHeader = content.indexOf("]:");
    const name = content.slice(11, endHeader).trim();
    const argsStr = content.slice(endHeader + 2).trim();
    return [{ type: "tool", name, text: argsStr }];
  }
  if (content.startsWith("[Tool Output (") || content.startsWith("[") && content.includes("output]:")) {
    return [{ type: "tool", name: "tool_result", text: content }];
  }

  return [{ type: "text", text: content }];
}

export const SubchatDrawer = memo(({
  isOpen,
  onClose,
  subchatId,
  parentThreadId,
  initialTitle,
  initialType,
  onSwitchToFullChat,
}) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [threadMeta, setThreadMeta] = useState(null);
  const messagesEndRef = useRef(null);
  const pollTimerRef = useRef(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Fetch subchat messages and metadata
  const fetchMessages = useCallback(async (isInitial = false) => {
    if (!subchatId) return;
    if (isInitial) setLoading(true);
    try {
      const [msgs, info] = await Promise.all([
        getThreadMessages(subchatId),
        getThreadInfo(subchatId),
      ]);
      setMessages(Array.isArray(msgs) ? msgs : []);
      if (info) setThreadMeta(info);
    } catch (err) {
      console.warn("Failed fetching subchat messages:", err);
    } finally {
      if (isInitial) setLoading(false);
    }
  }, [subchatId]);

  useEffect(() => {
    if (!isOpen || !subchatId) {
      setMessages([]);
      setThreadMeta(null);
      return;
    }

    fetchMessages(true);

    // Poll while subagent might be running
    pollTimerRef.current = setInterval(() => {
      fetchMessages(false);
    }, 2500);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [isOpen, subchatId, fetchMessages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSend = async (e) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isSending || !subchatId) return;

    setInput("");
    setIsSending(true);

    const userMsg = {
      id: `local_${Date.now()}`,
      role: "user",
      content: trimmed,
      created_at: new Date().toISOString(),
    };
    const botMsgId = `local_bot_${Date.now() + 1}`;
    const botMsg = {
      id: botMsgId,
      role: "assistant",
      content: "",
      blocks: [],
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg, botMsg]);

    try {
      await streamChat(
        trimmed,
        subchatId,
        null,
        (data) => {
          if (!data) return;
          const msgObj = data.message || {};
          const chunkText = msgObj.content || "";
          if (chunkText) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === botMsgId
                  ? { ...m, content: (m.content || "") + chunkText }
                  : m
              )
            );
          }
        },
        () => {
          setIsSending(false);
          fetchMessages(false);
        },
        null, // abort controller
        { chat_mode: "agent" }
      );
    } catch (err) {
      console.error("Subchat follow-up error:", err);
      setIsSending(false);
    }
  };

  const displayName = initialTitle || threadMeta?.title || (initialType ? String(initialType).replace(/_/g, " ") : "Subagent Chat");
  const isRunning = threadMeta?.subagent_status === "running";

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 pointer-events-none flex justify-end">
        {/* Backdrop for mobile / narrow windows */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/40 backdrop-blur-xs pointer-events-auto md:hidden"
        />

        {/* Slide-over Drawer Panel */}
        <motion.div
          initial={{ x: "100%", opacity: 0.5 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", damping: 28, stiffness: 300 }}
          className="relative w-full sm:w-[460px] md:w-[500px] h-full bg-neutral-950/95 border-l border-white/[0.08] shadow-2xl flex flex-col pointer-events-auto backdrop-blur-xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] bg-neutral-900/60 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center text-emerald-400 shrink-0">
                <Bot size={16} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-neutral-200 capitalize truncate">
                    {displayName}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[9px] font-medium border ${
                      isRunning
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/25 animate-pulse"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                    }`}
                  >
                    {isRunning ? "Running" : "Subchat"}
                  </span>
                </div>
                {threadMeta?.parent_title && (
                  <p className="text-[10px] text-neutral-500 truncate flex items-center gap-1">
                    <span>↳</span>
                    <span>Parent: {threadMeta.parent_title}</span>
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {onSwitchToFullChat && (
                <button
                  type="button"
                  onClick={() => onSwitchToFullChat(subchatId)}
                  className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                  title="Switch to full window chat"
                >
                  <ExternalLink size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                title="Close drawer"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          {/* Messages Feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16 text-neutral-500 space-y-2">
                <Loader2 size={20} className="animate-spin text-emerald-500" />
                <span className="text-xs">Loading subchat conversation...</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-neutral-500 px-6">
                <Bot size={28} className="mb-2 opacity-40 text-emerald-400" />
                <p className="text-xs font-medium text-neutral-400">Subchat Initialized</p>
                <p className="text-[11px] mt-1 text-neutral-500 leading-relaxed">
                  The subagent was launched to execute this task in isolation. Intermediate steps will appear here.
                </p>
              </div>
            ) : (
              messages.map((m, idx) => {
                const isUser = m.role === "user" || m.from === "user";
                const isTool = m.role === "tool";
                const blocks = parseSubchatMessageBlocks(m);

                if (isTool) {
                  return (
                    <div key={m.id || idx} className="my-1.5">
                      <ToolChip
                        name="tool_result"
                        content={m.content || m.text}
                        tooltipPlacement="top"
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={m.id || idx}
                    className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
                  >
                    <div
                      className={`max-w-[92%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                        isUser
                          ? "bg-neutral-800 text-neutral-100 rounded-br-xs border border-white/[0.06]"
                          : "bg-neutral-900/80 text-neutral-200 rounded-bl-xs border border-white/[0.06]"
                      }`}
                    >
                      {blocks.map((b, bIdx) => {
                        if (b.type === "tool") {
                          return (
                            <div key={bIdx} className="my-1">
                              <ToolChip name={b.name} content={b.text} tooltipPlacement="top" />
                            </div>
                          );
                        }
                        return <MarkdownMessage key={bIdx} content={b.text || m.content || m.text || ""} />;
                      })}
                    </div>
                    <span className="text-[10px] text-neutral-500 mt-1 px-1">
                      {isUser ? "Delegated Task" : "Specialist Agent"}
                    </span>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Follow-up Prompt Input Footer */}
          <form
            onSubmit={handleSend}
            className="p-3 border-t border-white/[0.08] bg-neutral-900/70 shrink-0 flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Instruct ${displayName}...`}
              disabled={isSending}
              className="flex-1 bg-neutral-950/80 border border-white/[0.08] rounded-lg px-3 py-2 text-xs text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-emerald-500/50 transition-colors"
            />
            <button
              type="submit"
              disabled={!input.trim() || isSending}
              className="p-2 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              title="Send to Subagent"
            >
              {isSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            </button>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
});

SubchatDrawer.displayName = "SubchatDrawer";
export default SubchatDrawer;

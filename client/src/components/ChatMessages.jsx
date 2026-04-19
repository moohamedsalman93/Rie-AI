import { motion, AnimatePresence } from "framer-motion";
import { GitBranch, Info, RotateCw } from 'lucide-react';
import { MarkdownMessage } from "./MarkdownMessage";
import { ToolChip } from "./ToolChip";
import { HITLApproval } from "./HITLApproval";

export function ChatMessages({
  messages,
  isLoading,
  streamingBotMessageId,
  typesWrite,
  setTypesWrite,
  messagesEndRef,
  pendingAction,
  onActionDecision,
  onDeleteMessage,
  onSend,
  onOpenInNewChat,
  activeFriendMeta = null,
}) {
  return (
    <main className="custom-scrollbar pt-12 px-3.5 pb-16 flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden bg-neutral-900/70 py-4 min-h-0">
      {activeFriendMeta?.isFriendChat && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
          <div className="font-semibold">Friend chat: {activeFriendMeta.friendName || "Friend"}</div>
          <div className="text-emerald-200/80">You are chatting with {activeFriendMeta.friendName || "your friend"}&apos;s Rie.</div>
        </div>
      )}
      <AnimatePresence>
        {messages.map((m) => {
          // Skip empty bot messages that haven't started streaming blocks yet,
          // UNLESS they are the last message and have a pendingAction (HITL).
          const isLastBotMessage = m.from === "bot" && m.id === messages[messages.length - 1].id;
          if (m.from === "bot" && (!m.blocks || m.blocks.length === 0) && (!m.text || !m.text.trim())) {
            if (!(pendingAction && isLastBotMessage)) {
              return null;
            }
          }

          return (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className={`flex flex-col ${m.from === "user" ? "items-end" : "items-start"} w-full group`}
            >
              <div className={`flex items-end gap-2 min-w-0 max-w-[95%] ${m.from === 'user' ? 'justify-end' : ''}`}>
                {m.from === 'user' && (
                  <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mb-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenInNewChat?.(m);
                      }}
                      className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                      title="Open in new chat"
                    >
                      <GitBranch size={14} />
                    </button>
                    {m.error && (
                      <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteMessage(m.id);
                        onSend(m.text, false, m.image_url);
                      }}
                      className="p-1.5 rounded-lg text-red-400 hover:bg-neutral-800 transition-colors"
                      title="Retry"
                    >
                      <RotateCw size={14} />
                    </button>
                    <div className="relative group/info">
                      <div className="p-1.5 text-red-500 cursor-help">
                        <Info size={14} />
                      </div>
                      <div className="absolute right-full mr-2 top-1/2 -translate-y-1/2 w-48 p-2.5 bg-neutral-900 border border-red-500/30 rounded-lg text-xs text-red-200 opacity-0 group-hover/info:opacity-100 transition-opacity pointer-events-none z-10 shadow-xl backdrop-blur-sm">
                        {m.errorMessage}
                      </div>
                    </div>
                      </>
                    )}
                  </div>
                )}
                <div className={`min-w-0 max-w-full break-words overflow-x-auto rounded-xl px-3.5 py-2 text-sm leading-snug shadow-sm transition ${m.from === "user" ? `bg-neutral-700 text-neutral-50 border ${m.error ? 'border-red-500/50 bg-red-900/10' : 'border-neutral-600/40'}` : "bg-neutral-800 text-neutral-100 border border-neutral-700/50"}`}>
                {m.image_url && (
                  <div className="mb-2 overflow-hidden rounded-lg">
                    <img src={m.image_url} alt="Attached" className="max-h-60 w-full object-cover" />
                  </div>
                )}
                {m.clipboard && (
                  <div className="mb-2 rounded-lg bg-blue-500/10 border border-blue-500/20 p-2.5">
                    <div className="flex items-center gap-2 mb-1.5 opacity-80">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400">
                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                        <circle cx="9" cy="9" r="2" />
                      </svg>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">Clipboard</span>
                    </div>
                    <p className="text-[11px] text-neutral-300 line-clamp-4 leading-relaxed font-mono italic">
                      {m.clipboard}
                    </p>
                  </div>
                )}
                {m.from === "bot" ? (
                  <div className="flex flex-col gap-2">
                    {(m.blocks || [{ type: "text", text: m.text }]).map((block, idx) => (
                      <div key={idx}>
                        {block.type === "text" ? (
                          <MarkdownMessage
                            content={block.text}
                            isStreaming={isLoading && m.id === streamingBotMessageId}
                            typesWrite={typesWrite}
                            setTypesWrite={setTypesWrite}
                          />
                        ) : (
                          <ToolChip name={block.name} content={block.text} />
                        )}
                      </div>
                    ))}
                    {pendingAction && m.id === messages[messages.length - 1].id && m.from === "bot" && (
                      <HITLApproval
                        hitl={pendingAction}
                        onDecision={onActionDecision}
                      />
                    )}
                  </div>
                ) : (
                  m.text
                )}
              </div>
            </div>
            <span className={`mt-1 text-[10px] font-medium text-neutral-500 ${m.error ? 'text-red-500/50' : ''}`}>
              {m.from === "user" ? "You" : "Assistant"} {m.error && '• Failed'}
            </span>
          </motion.div>
          );
        })}
      </AnimatePresence>
      <div ref={messagesEndRef} />
    </main>
  );
}

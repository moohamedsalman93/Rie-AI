import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { ScheduledTasksPanel } from "./ScheduledTasksPanel";

function previewBody(text, max = 140) {
  if (!text) return "";
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Full floating-window sheet: upcoming scheduled tasks + completed notification log.
 */
export function FloatingScheduleSheet({
  open,
  onClose,
  apiStatus,
  notifications = [],
  unreadCount: unreadCountProp,
  onMarkRead,
  onMarkAllRead,
  onOpenChat,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const unreadCount =
    typeof unreadCountProp === "number" ? unreadCountProp : notifications.length;
  const listCount = notifications.length;

  const formatTime = (iso) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
    } catch {
      return "";
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="floating-schedule-overlay"
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[50] flex items-center justify-center p-3"
        >
          <motion.button
            type="button"
            aria-label="Close schedule"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-0 bg-black/55 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="relative z-10 flex max-h-[min(85vh,520px)] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900/98 shadow-2xl backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2.5 shrink-0">
              <span className="text-sm font-medium text-neutral-100">Schedule</span>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                title="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar overflow-x-hidden">
              <ScheduledTasksPanel apiStatus={apiStatus} variant="sheet" />

              <div className="border-t border-neutral-800/80 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Completed
                  </span>
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      onClick={() => onMarkAllRead?.()}
                      className="text-[10px] text-neutral-500 hover:text-emerald-400 shrink-0"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2 px-3 pb-4 pt-1">
                {listCount === 0 ? (
                  <div className="text-xs text-neutral-500 py-3 text-left leading-relaxed">
                    No completed schedule notifications yet.
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div
                      key={n.id}
                      className="rounded-lg border border-neutral-800/80 bg-neutral-800/40 p-2.5 text-left"
                    >
                      <div className="font-medium text-xs text-neutral-100 line-clamp-2">{n.title}</div>
                      <div className="text-[11px] text-neutral-400 mt-1 line-clamp-3 whitespace-pre-wrap break-words">
                        {previewBody(n.body)}
                      </div>
                      <div className="text-[10px] text-neutral-500 mt-1.5">{formatTime(n.created_at)}</div>
                      <div className="flex flex-wrap gap-3 mt-2">
                        {n.thread_id && (
                          <button
                            type="button"
                            onClick={() => {
                              onOpenChat?.(n);
                              onClose();
                            }}
                            className="text-[11px] text-emerald-400 hover:text-emerald-300"
                          >
                            Open chat
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onMarkRead?.(n.id)}
                          className="text-[11px] text-neutral-500 hover:text-neutral-300"
                        >
                          Mark read
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

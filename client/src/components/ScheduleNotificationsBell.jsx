import { useState, useEffect, useRef } from "react";
import { Bell } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

function previewBody(text, max = 140) {
  if (!text) return "";
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Bell + badge for unread schedule completion notifications; click opens list with previews.
 */
export function ScheduleNotificationsBell({
  notifications = [],
  /** Unread count for badge; list `notifications` may include read items kept in session. */
  unreadCount: unreadCountProp,
  onMarkRead,
  onMarkAllRead,
  onOpenChat,
  apiStatus,
  /** When `floating`, the popover is centered in the window; otherwise it aligns under the bell (right). */
  windowMode = "normal",
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const unreadCount =
    typeof unreadCountProp === "number" ? unreadCountProp : notifications.length;
  const listCount = notifications.length;

  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

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

  const online = apiStatus === "online";
  const floating = windowMode === "floating";

  const panelBody = (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-800/80 shrink-0">
        <span className="text-xs font-medium text-neutral-200">Completed schedules</span>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => {
              onMarkAllRead?.();
              setOpen(false);
            }}
            className="text-[10px] text-neutral-500 hover:text-emerald-400"
          >
            Mark all read
          </button>
        )}
      </div>
      <div className="overflow-y-auto custom-scrollbar flex-1 max-h-64 p-2 space-y-2">
        {listCount === 0 ? (
          <div className="text-xs text-neutral-500 px-2 py-6 text-center">
            No completed schedule notifications
          </div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className="rounded-lg border border-neutral-800/80 bg-black p-2.5 text-left"
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
                      setOpen(false);
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
    </>
  );

  return (
    <div className="relative" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (!online) return;
          setOpen(!open);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={!online}
        className={`relative rounded-full p-1 transition ${
          !online
            ? "text-neutral-600 cursor-not-allowed"
            : unreadCount > 0
              ? "text-amber-400 bg-amber-500/15 hover:bg-amber-500/25"
              : "text-neutral-400 bg-neutral-700/60 hover:text-neutral-200"
        }`}
        title={
          !online
            ? "Connect to see schedule notifications"
            : unreadCount > 0
              ? `Unread (${unreadCount})`
              : "Schedule notifications"
        }
      >
        <Bell className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-[10px] font-semibold text-neutral-950 flex items-center justify-center tabular-nums">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && online && (
          floating ? (
            <motion.div
              key="schedule-popover-floating"
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-x-0 top-12 z-[60] flex justify-center px-3 pt-1 cursor-default"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className=" w-[min(20rem,calc(100%-1.5rem))] max-h-80 rounded-xl border border-neutral-700 bg-neutral-900/98 shadow-2xl backdrop-blur-xl overflow-hidden flex flex-col cursor-default">
                {panelBody}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="schedule-popover-docked"
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full z-[60] mt-2 w-80 max-h-80 rounded-xl border border-neutral-700 bg-neutral-900/98 shadow-2xl backdrop-blur-xl overflow-hidden flex flex-col cursor-default"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {panelBody}
            </motion.div>
          )
        )}
      </AnimatePresence>
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { Bell } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

function previewBody(text, max = 140) {
  if (!text) return "";
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Split notifications bell:
 * - "Notifications" tab: App updates (postponed via "Later"), system alerts
 * - "Completed schedules" tab: Schedule task completion alerts
 */
export function ScheduleNotificationsBell({
  notifications = [],
  unreadCount: unreadCountProp,
  onMarkRead,
  onMarkAllRead,
  onOpenChat,
  apiStatus,
  windowMode = "normal",
  // Update state props
  availableUpdate = null,
  updateDownloaded = false,
  updateDownloading = false,
  updateDownloadProgress = 0,
  updateBannerDismissed = false,
  updateNotificationDismissed = false,
  onDownloadUpdate,
  onInstallUpdate,
  onDismissUpdateNotification,
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("notifications");
  const ref = useRef(null);

  const hasUpdateNotification =
    Boolean(availableUpdate) && updateBannerDismissed && !updateNotificationDismissed;
  const appNotificationsCount = hasUpdateNotification ? 1 : 0;

  const scheduleUnreadCount =
    typeof unreadCountProp === "number" ? unreadCountProp : notifications.length;
  const scheduleListCount = notifications.length;

  const totalUnreadCount = appNotificationsCount + scheduleUnreadCount;

  useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const online = apiStatus === "online";
  const floating = windowMode === "floating";

  const handleToggleOpen = (e) => {
    e.stopPropagation();
    if (!online) return;
    if (!open) {
      if (appNotificationsCount > 0) {
        setActiveTab("notifications");
      } else if (scheduleUnreadCount > 0) {
        setActiveTab("schedules");
      }
    }
    setOpen(!open);
  };

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

  const panelBody = (
    <>
      {/* Compact Segmented Pill Tabs Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-neutral-800/60 bg-neutral-900/90 shrink-0">
        <div className="flex items-center gap-1 p-0.5 rounded-xl bg-neutral-950/80 border border-neutral-800/80">
          <button
            type="button"
            onClick={() => setActiveTab("notifications")}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-lg transition-all ${
              activeTab === "notifications"
                ? "bg-neutral-800 text-neutral-100 shadow-sm border border-neutral-700/60 font-semibold"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <span>Notifications</span>
            {appNotificationsCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[9px] bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30">
                {appNotificationsCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("schedules")}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-lg transition-all ${
              activeTab === "schedules"
                ? "bg-neutral-800 text-neutral-100 shadow-sm border border-neutral-700/60 font-semibold"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <span>Schedules</span>
            {scheduleUnreadCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[9px] bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">
                {scheduleUnreadCount}
              </span>
            )}
          </button>
        </div>

        {activeTab === "schedules" && scheduleUnreadCount > 0 && (
          <button
            type="button"
            onClick={() => {
              onMarkAllRead?.();
            }}
            className="text-[10px] text-neutral-400 hover:text-emerald-400 font-medium transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Tab Content */}
      <div className="overflow-y-auto custom-scrollbar flex-1 max-h-64 p-2 space-y-2">
        {activeTab === "notifications" ? (
          appNotificationsCount === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-7 px-4">
              <div className="w-8 h-8 rounded-xl bg-neutral-800/40 border border-neutral-800/80 flex items-center justify-center text-neutral-500 mb-2">
                <Bell className="w-4 h-4 stroke-[1.5]" />
              </div>
              <span className="text-xs font-medium text-neutral-300">All caught up</span>
              <span className="text-[10px] text-neutral-500 mt-0.5">No general notifications right now</span>
            </div>
          ) : (
            <>
              {hasUpdateNotification && (
                <div className="group rounded-xl border border-neutral-800/80 bg-neutral-950/70 hover:bg-neutral-950/90 hover:border-neutral-700/80 p-3 text-left transition-all duration-200 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <div className="w-7 h-7 bg-emerald-500/10 rounded-lg flex items-center justify-center shrink-0 border border-emerald-500/20 text-emerald-400 mt-0.5">
                        {updateDownloaded ? (
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                        ) : (
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        )}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-semibold text-xs text-neutral-100">
                          {updateDownloaded
                            ? `Update v${availableUpdate.version} ready`
                            : `Update v${availableUpdate.version} available`}
                        </span>
                        <span className="text-[11px] text-neutral-400 mt-0.5 leading-snug">
                          {updateDownloading
                            ? `Downloading update... ${updateDownloadProgress}%`
                            : updateDownloaded
                            ? `Version ${availableUpdate.version} downloaded. Restart to apply.`
                            : `Version ${availableUpdate.version} is ready to download.`}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => onDismissUpdateNotification?.()}
                      className="text-neutral-500 hover:text-neutral-300 p-1 rounded-lg hover:bg-neutral-800/60 transition-colors shrink-0"
                      title="Dismiss notification"
                    >
                      ✕
                    </button>
                  </div>

                  {updateDownloading && (
                    <div className="mt-2.5 h-1 w-full bg-neutral-800 rounded-full overflow-hidden border border-neutral-700/50">
                      <div
                        className="h-full bg-emerald-500 transition-all duration-200"
                        style={{ width: `${updateDownloadProgress}%` }}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 mt-2.5">
                    {!updateDownloaded && !updateDownloading && (
                      <button
                        type="button"
                        onClick={() => onDownloadUpdate?.()}
                        className="px-3 py-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg transition-all active:scale-95 shadow-sm"
                      >
                        Download Update
                      </button>
                    )}
                    {updateDownloaded && (
                      <button
                        type="button"
                        onClick={() => onInstallUpdate?.()}
                        className="px-3 py-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-lg transition-all active:scale-95 shadow-sm"
                      >
                        Restart Now
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )
        ) : (
          scheduleListCount === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-7 px-4">
              <div className="w-8 h-8 rounded-xl bg-neutral-800/40 border border-neutral-800/80 flex items-center justify-center text-neutral-500 mb-2">
                <Bell className="w-4 h-4 stroke-[1.5]" />
              </div>
              <span className="text-xs font-medium text-neutral-300">No schedules completed</span>
              <span className="text-[10px] text-neutral-500 mt-0.5">Completed task reminders will appear here</span>
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className="group rounded-xl border border-neutral-800/80 bg-neutral-950/70 hover:bg-neutral-950/90 hover:border-neutral-700/80 p-3 text-left transition-all duration-200 shadow-sm"
              >
                <div className="font-semibold text-xs text-neutral-100 line-clamp-2">{n.title}</div>
                <div className="text-[11px] text-neutral-400 mt-1 line-clamp-3 whitespace-pre-wrap break-words leading-relaxed">
                  {previewBody(n.body)}
                </div>
                <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-neutral-800/50">
                  <span className="text-[10px] text-neutral-500 font-mono">{formatTime(n.created_at)}</span>
                  <div className="flex items-center gap-2">
                    {n.thread_id && (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChat?.(n);
                          setOpen(false);
                        }}
                        className="px-2 py-0.5 text-[11px] text-emerald-400 hover:bg-emerald-500/10 border border-emerald-500/20 rounded-md font-medium transition-all"
                      >
                        Open chat
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onMarkRead?.(n.id)}
                      className="px-2 py-0.5 text-[11px] text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))
          )
        )}
      </div>
    </>
  );

  return (
    <div className="relative" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={handleToggleOpen}
        onMouseDown={(e) => e.stopPropagation()}
        disabled={!online}
        className={`relative rounded-full p-1.5 transition-all duration-150 ${
          !online
            ? "text-neutral-600 cursor-not-allowed"
            : totalUnreadCount > 0
              ? "text-amber-400 bg-amber-500/15 hover:bg-amber-500/25 ring-1 ring-amber-500/30"
              : "text-neutral-400 bg-neutral-700/60 hover:text-neutral-200"
        }`}
        title={
          !online
            ? "Connect to see notifications"
            : totalUnreadCount > 0
              ? `Unread notifications (${totalUnreadCount})`
              : "Notifications"
        }
      >
        <Bell className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        {totalUnreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-amber-500 text-[10px] font-bold text-neutral-950 flex items-center justify-center tabular-nums shadow-sm">
            {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
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
              <div className="w-[min(22rem,calc(100%-1.5rem))] max-h-80 rounded-2xl border border-neutral-800/90 bg-neutral-900/98 shadow-2xl backdrop-blur-2xl overflow-hidden flex flex-col cursor-default">
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
              className="absolute right-0 top-full z-[60] mt-2 w-80 max-h-80 rounded-2xl border border-neutral-800/90 bg-neutral-900/98 shadow-2xl backdrop-blur-2xl overflow-hidden flex flex-col cursor-default"
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



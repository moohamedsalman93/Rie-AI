import { motion, AnimatePresence } from "framer-motion";
import { CalendarClock } from "lucide-react";
import { ModeToggle } from "./ModeToggle";
import { ScheduleNotificationsBell } from "./ScheduleNotificationsBell";
import logo from "../assets/logo.png";

export function ChatHeader({
  apiStatus,
  isMenuOpen,
  setIsMenuOpen,
  windowMode,
  onToggleWindowMode,
  onOpenSettings,
  onOpenHistory,
  onNewChat,
  onMinimize,
  onCloseApp,
  onDragStart,
  isTerminalOpen,
  onToggleTerminal,
  chatMode,
  setChatMode,
  speedMode,
  setSpeedMode,
  scheduleNotifications = [],
  scheduleUnreadCount,
  onScheduleMarkRead = () => {},
  onScheduleMarkAllRead = () => {},
  onScheduleOpenChat = () => {},
  /** Floating mode: opens full schedule sheet from ⋮ menu */
  onOpenSchedule = null,
}) {
  return (
    <header
      data-tauri-drag-region
      className="flex rounded-xl absolute w-[95%] left-1/2 -translate-x-1/2 top-1 border-b border-neutral-700/40 bg-neutral-800 cursor-move h-10 items-center justify-between gap-3 px-2 py-2.5 z-10"
      onMouseDown={onDragStart}
    >
      <div className="flex items-center gap-2">
        <img src={logo} alt="Rie-AI" className="h-6 w-6 object-contain" />
        <div className="flex flex-col">
          <span className="text-xs font-medium text-neutral-100">Rie-AI Assistant</span>
          <span className={`text-[10px] font-medium ${apiStatus === "online" ? "text-emerald-400/80" : apiStatus === "checking" ? "text-amber-400/80" : "text-red-400/80"}`}>
            {apiStatus === "online" ? "Online" : apiStatus === "checking" ? "Connecting..." : "Offline"}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <ScheduleNotificationsBell
          notifications={scheduleNotifications}
          unreadCount={scheduleUnreadCount}
          onMarkRead={onScheduleMarkRead}
          onMarkAllRead={onScheduleMarkAllRead}
          onOpenChat={onScheduleOpenChat}
          apiStatus={apiStatus}
          windowMode={windowMode}
        />
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setIsMenuOpen(!isMenuOpen); }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`rounded-full p-1 transition bg-neutral-700/60 hover:text-neutral-200 ${isMenuOpen ? "text-emerald-400" : "text-neutral-400"}`}
            title="More options"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>

          <AnimatePresence>
            {isMenuOpen && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -10 }}
                transition={{ duration: 0.2 }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-2 w-40 origin-top-right rounded-xl border border-neutral-700 bg-neutral-800/95 p-1.5 shadow-2xl backdrop-blur-xl z-50 overflow-hidden"
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleTerminal();
                    setIsMenuOpen(false);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs transition-colors ${isTerminalOpen ? "bg-emerald-500/10 text-emerald-400" : "text-neutral-300 hover:bg-neutral-700/50 hover:text-white"}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <polyline points="4 17 10 11 4 5"></polyline>
                    <line x1="12" y1="19" x2="20" y2="19"></line>
                  </svg>
                  <span>System Terminal</span>
                </button>

                {windowMode === "floating" && typeof onOpenSchedule === "function" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenSchedule();
                      setIsMenuOpen(false);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-700/50 hover:text-white"
                  >
                    <CalendarClock className="h-3.5 w-3.5 shrink-0 text-neutral-300" />
                    <span>Schedule</span>
                  </button>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleWindowMode();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-700/50 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    {windowMode === 'floating' ? (
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    ) : (
                      <path d="M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
                    )}
                    {windowMode === 'floating' && <line x1="3" y1="9" x2="21" y2="9" />}
                    <path d="M15 13l5 5" />
                    <path d="M20 13v5h-5" />
                  </svg>
                  <span>{windowMode === "floating" ? "Normal Mode" : "Floating Mode"}</span>
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenSettings();
                    setIsMenuOpen(false);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-700/50 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                    <circle cx="12" cy="12" r="3"></circle>
                  </svg>
                  <span>Settings</span>
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenHistory();
                    setIsMenuOpen(false);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-700/50 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                  </svg>
                  <span>History</span>
                </button>

                <div className="my-1 h-[1px] bg-neutral-700/50" />
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewChat();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-xs text-neutral-300 transition-colors hover:bg-neutral-700/50 hover:text-white"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>New Chat</span>
                </button>

                <div className="my-1 h-[1px] bg-neutral-700/50" />
                
                <div className=" py-1">
                  <ModeToggle 
                    chatMode={chatMode} 
                    setChatMode={setChatMode} 
                    speedMode={speedMode} 
                    setSpeedMode={setSpeedMode} 
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onMinimize(); }}
          onMouseDown={(e) => e.stopPropagation()}
          className="rounded-full p-1 text-neutral-400 transition bg-neutral-700/60 hover:text-neutral-200"
          title={windowMode === 'normal' ? "Minimize" : "Minimize to bubble"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 block">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {windowMode === 'normal' && (
          <>
            <button
              onClick={(e) => { e.stopPropagation(); onCloseApp(); }}
              onMouseDown={(e) => e.stopPropagation()}
              className="rounded-full p-1 text-neutral-400 transition bg-red-500/20 hover:bg-red-500/50 hover:text-white"
              title="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </>
        )}
      </div>
    </header>
  );
}

import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { ChatHeader } from "./ChatHeader";
import { FloatingScheduleSheet } from "./FloatingScheduleSheet";
import { ChatMessages } from "./ChatMessages";
import { ChatInputArea } from "./ChatInputArea";
import { HistorySidebar } from "./HistorySidebar";
import { Terminal } from "./Terminal";
import { WelcomeScreen } from "./WelcomeScreen";
import { SettingsPage } from "./SettingsPage";
export function FloatingChatWindow({
  showWelcome,
  setShowWelcome,
  isSettingsOpen,
  setIsSettingsOpen,
  onOpenSettingsWindow = null,
  apiStatus,
  isMenuOpen,
  setIsMenuOpen,
  windowMode,
  onToggleWindowMode,
  onOpenHistory,
  onNewChat,
  disableNewChat = false,
  onMinimize,
  onCloseApp,
  onDragStart,
  isTerminalOpen,
  onToggleTerminal,
  onCloseTerminal,
  isHistoryOpen,
  onCloseHistory,
  onSelectThread,
  onDeleteThread,
  activeThreadId,
  streamingThreads,
  messages,
  sessionsByThread = {},
  isLoading,
  streamingBotMessageId,
  typesWrite,
  setTypesWrite,
  messagesEndRef,
  input,
  setInput,
  isRecording,
  isCapturing,
  isAttachmentPopoverOpen,
  setIsAttachmentPopoverOpen,
  attachedImage,
  setAttachedImage,
  isScreenAttached,
  setIsScreenAttached,
  projectRoot,
  projectRootChip,
  setProjectRoot,
  setProjectRootChip,
  attachedClipboardText,
  setAttachedClipboardText,
  onFileUpload,
  onCaptureScreen,
  onPickProjectPath,
  onAttachClipboard,
  onSend,
  onCancelRequest,
  chatMode,
  setChatMode,
  speedMode,
  setSpeedMode,
  textareaRef,
  terminalLogs,
  isWindowDraggingFile,
  pendingAction,
  onActionDecision,
  onDeleteMessage,
  onOpenMessageInNewChat,
  onClearTerminal,
  scheduleNotifications = [],
  scheduleUnreadCount,
  onScheduleMarkRead = () => {},
  onScheduleMarkAllRead = () => {},
  onScheduleOpenChat = () => {},
  isScheduleSheetOpen = false,
  onCloseScheduleSheet = () => {},
  onOpenScheduleSheet = () => {},
  friends = [],
  friendThreadMeta = {},
  activeFriendMeta = null,
  isReceiverReadOnlyThread = false,
  onSelectFriendChat = () => {},
  onStartFriendChat = () => {},
  isFriendsQuickOpen = false,
  onToggleFriendsQuick = () => {},
  onCloseFriendsQuick = () => {},
}) {
  const friendsQuickRef = useRef(null);

  useEffect(() => {
    if (!isFriendsQuickOpen) return;

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        onCloseFriendsQuick();
      }
    };

    const handleOutsideClick = (event) => {
      if (!friendsQuickRef.current) return;
      if (!friendsQuickRef.current.contains(event.target)) {
        onCloseFriendsQuick();
      }
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("mousedown", handleOutsideClick);

    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isFriendsQuickOpen, onCloseFriendsQuick]);

  return (
    <motion.section
      key="chat"
      initial={{ opacity: 0, scale: 0.9, y: 20, filter: "blur(8px)" }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.9, y: 20, filter: "blur(8px)" }}
      transition={{
        duration: 0.4,
        ease: [0.23, 1, 0.32, 1] // Custom easeOutQuint for premium feel
      }}
      className="pointer-events-auto w-full relative h-full flex flex-col overflow-hidden bg-transparent rounded-xl z-0"
    >
      <ChatHeader
        apiStatus={apiStatus}
        isMenuOpen={isMenuOpen}
        setIsMenuOpen={setIsMenuOpen}
        windowMode={windowMode}
        onToggleWindowMode={onToggleWindowMode}
        onOpenSettings={() => {
          if (onOpenSettingsWindow) {
            onOpenSettingsWindow();
            return;
          }
          setShowWelcome(false);
          setIsSettingsOpen(true);
        }}
        onOpenHistory={onOpenHistory}
        onNewChat={onNewChat}
        disableNewChat={disableNewChat}
        onMinimize={onMinimize}
        onCloseApp={onCloseApp}
        onDragStart={onDragStart}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={onToggleTerminal}
        chatMode={chatMode}
        setChatMode={setChatMode}
        speedMode={speedMode}
        setSpeedMode={setSpeedMode}
        scheduleNotifications={scheduleNotifications}
        scheduleUnreadCount={scheduleUnreadCount}
        onScheduleMarkRead={onScheduleMarkRead}
        onScheduleMarkAllRead={onScheduleMarkAllRead}
        onScheduleOpenChat={onScheduleOpenChat}
        onOpenSchedule={onOpenScheduleSheet}
        onToggleFriends={onToggleFriendsQuick}
      />

      {showWelcome ? (
        <WelcomeScreen
          onGetStarted={() => {
            if (onOpenSettingsWindow) {
              onOpenSettingsWindow();
              return;
            }
            setShowWelcome(false);
            setIsSettingsOpen(true);
          }}
          onMouseDown={onDragStart}
          onMinimize={onMinimize}
          onClose={onCloseApp}
        />
      ) : isSettingsOpen ? (
        <SettingsPage onClose={() => setIsSettingsOpen(false)} />
      ) : (
        <>
          <div className="flex flex-1 min-h-0 w-full overflow-hidden">
            <HistorySidebar
              isOpen={isHistoryOpen}
              onClose={onCloseHistory}
              onSelectThread={onSelectThread}
              onDeleteThread={onDeleteThread}
              onNewChat={onNewChat}
              currentThreadId={activeThreadId}
              streamingThreads={streamingThreads}
              windowMode={windowMode}
              friends={friends}
              friendThreadMeta={friendThreadMeta}
              onSelectFriendChat={onSelectFriendChat}
              onStartFriendChat={onStartFriendChat}
              sessionsByThread={sessionsByThread}
            />
            <div className="flex-1 flex flex-col relative min-w-0 h-full min-h-0">
              {isFriendsQuickOpen && (
                <div
                  ref={friendsQuickRef}
                  className="absolute left-1/2 top-14 z-30 max-h-72 w-72 -translate-x-1/2 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900/95 p-2 shadow-xl backdrop-blur"
                >
                  <div className="mb-1 flex items-center justify-between px-1">
                    <div className="text-[11px] font-semibold text-neutral-300">Friends</div>
                    <button
                      onClick={onCloseFriendsQuick}
                      className="rounded p-1 text-neutral-400 transition hover:bg-neutral-700/50 hover:text-neutral-200"
                      title="Close friends list"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                  {friends.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-neutral-500">No connections.</div>
                  ) : (
                    friends.map((friend) => {
                      return (
                        <div key={friend.id} className="mb-1 rounded-lg border border-white/10 bg-neutral-900/60 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-xs text-neutral-200">{friend.name || "Friend"}</span>
                            <button
                              onClick={() => {
                                onStartFriendChat(friend);
                                onCloseFriendsQuick();
                              }}
                              className="rounded-md border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-300 transition hover:border-emerald-400/40 hover:text-emerald-200"
                            >
                              Chat
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
              <ChatMessages
                messages={messages}
                isLoading={isLoading}
                streamingBotMessageId={streamingBotMessageId}
                typesWrite={typesWrite}
                setTypesWrite={setTypesWrite}
                messagesEndRef={messagesEndRef}
                pendingAction={pendingAction}
                onActionDecision={onActionDecision}
                onDeleteMessage={onDeleteMessage}
                onSend={onSend}
                onOpenInNewChat={onOpenMessageInNewChat}
                activeFriendMeta={activeFriendMeta}
                isReceiverReadOnlyThread={isReceiverReadOnlyThread}
              />
            </div>
          </div>

          <ChatInputArea
            input={input}
            setInput={setInput}
            isLoading={isLoading}
            isRecording={isRecording}
            isCapturing={isCapturing}
            isAttachmentPopoverOpen={isAttachmentPopoverOpen}
            setIsAttachmentPopoverOpen={setIsAttachmentPopoverOpen}
            attachedImage={attachedImage}
            setAttachedImage={setAttachedImage}
            isScreenAttached={isScreenAttached}
            setIsScreenAttached={setIsScreenAttached}
            projectRoot={projectRoot}
            projectRootChip={projectRootChip}
            setProjectRoot={setProjectRoot}
            setProjectRootChip={setProjectRootChip}
            attachedClipboardText={attachedClipboardText}
            setAttachedClipboardText={setAttachedClipboardText}
            onFileUpload={onFileUpload}
            onCaptureScreen={onCaptureScreen}
            onPickProjectPath={onPickProjectPath}
            onAttachClipboard={onAttachClipboard}
            onSend={onSend}
            onCancelRequest={onCancelRequest}
            textareaRef={textareaRef}
            isWindowDraggingFile={isWindowDraggingFile}
            threadReadOnly={isReceiverReadOnlyThread}
            readOnlyMessage={`This chat was created by Device A (${activeFriendMeta?.originDeviceName || activeFriendMeta?.originDeviceId || "remote device"}) and is read-only on this device.`}
          />

          <Terminal
            isOpen={isTerminalOpen}
            onClose={onCloseTerminal}
            onClear={onClearTerminal}
            logs={terminalLogs}
          />

          <FloatingScheduleSheet
            open={isScheduleSheetOpen}
            onClose={onCloseScheduleSheet}
            apiStatus={apiStatus}
            notifications={scheduleNotifications}
            unreadCount={scheduleUnreadCount}
            onMarkRead={onScheduleMarkRead}
            onMarkAllRead={onScheduleMarkAllRead}
            onOpenChat={onScheduleOpenChat}
          />
        </>
      )}
    </motion.section>
  );
}

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
  onSelectFriendChat = () => {},
  onStartFriendChat = () => {},
  isFriendsQuickOpen = false,
  onToggleFriendsQuick = () => {},
}) {
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
                <div className="absolute left-3 top-12 z-30 max-h-72 w-72 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900/95 p-2 shadow-xl backdrop-blur">
                  <div className="mb-1 px-1 text-[11px] font-semibold text-neutral-300">Friends</div>
                  {friends.length === 0 ? (
                    <div className="px-2 py-2 text-xs text-neutral-500">No connections.</div>
                  ) : (
                    friends.map((friend) => {
                      return (
                        <div key={friend.id} className="mb-1 rounded-lg border border-white/10 bg-neutral-900/60 p-1.5">
                          <div className="mb-1 flex items-center justify-between">
                            <span className="truncate text-xs text-neutral-200">{friend.name || "Friend"}</span>
                            <button onClick={() => onStartFriendChat(friend)} className="text-[10px] text-emerald-300 hover:text-emerald-200">Chat</button>
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

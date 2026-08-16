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
  retryStatus = null,
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
  onClearAllHistory,
  activeThreadId,
  streamingThreads,
  messages,
  sessionsByThread = {},
  isLoading,
  streamingBotMessageId,
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
  attachedFiles = [],
  onRemoveAttachedFile,
  onCaptureScreen,
  onPickProjectPath,
  onAttachClipboard,
  onSend,
  onAnswerQuestion,
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
  availableUpdate = null,
  updateDownloaded = false,
  updateDownloading = false,
  updateDownloadProgress = 0,
  updateBannerDismissed = false,
  updateNotificationDismissed = false,
  onDownloadUpdate,
  onInstallUpdate,
  onDismissUpdateNotification,
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
  attachedKnowledge = [],
  onAttachKnowledge = () => {},
  onDetachKnowledge = () => {},
  settings = {},
  kioskOverlay = false,
  kioskSelection = null,
  onAddKioskSelection = null,
  onClearKioskSelection = null,
  provider,
  onSelectProvider,
  onUpdateSetting,
  side = "left",
}) {
  const origin = side === "right" ? "top right" : "top left";

  return (
    <motion.section
      key="chat"
      initial={{ opacity: 0, scale: 0.15, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, scale: 0.15, filter: "blur(6px)" }}
      transition={{
        type: "spring",
        stiffness: 350,
        damping: 28,
        mass: 0.7
      }}
      className="pointer-events-auto w-full relative h-full flex flex-col overflow-hidden bg-transparent rounded-2xl z-0"
      style={{
        transformOrigin: origin,
        '--floating-chat-opacity': settings?.floating_chat_opacity ?? 0.85
      }}
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
        provider={provider}
        onSelectProvider={onSelectProvider}
        settings={settings}
        scheduleNotifications={scheduleNotifications}
        scheduleUnreadCount={scheduleUnreadCount}
        onScheduleMarkRead={onScheduleMarkRead}
        onScheduleMarkAllRead={onScheduleMarkAllRead}
        onScheduleOpenChat={onScheduleOpenChat}
        availableUpdate={availableUpdate}
        updateDownloaded={updateDownloaded}
        updateDownloading={updateDownloading}
        updateDownloadProgress={updateDownloadProgress}
        updateBannerDismissed={updateBannerDismissed}
        updateNotificationDismissed={updateNotificationDismissed}
        onDownloadUpdate={onDownloadUpdate}
        onInstallUpdate={onInstallUpdate}
        onDismissUpdateNotification={onDismissUpdateNotification}
        onOpenSchedule={onOpenScheduleSheet}
        onToggleFriends={onToggleFriendsQuick}
        kioskOverlay={kioskOverlay}
      />

      {showWelcome ? (
        <WelcomeScreen
          onGetStarted={() => setShowWelcome(false)}
          onMouseDown={onDragStart}
          onMinimize={onMinimize}
          onClose={onCloseApp}
        />
      ) : isSettingsOpen ? (
        <SettingsPage onClose={() => setIsSettingsOpen(false)} onClearAllHistory={onClearAllHistory} />
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
                messagesEndRef={messagesEndRef}
                pendingAction={pendingAction}
                onActionDecision={onActionDecision}
                onDeleteMessage={onDeleteMessage}
                onSend={onSend}
                onAnswerQuestion={onAnswerQuestion}
                onOpenInNewChat={onOpenMessageInNewChat}
                activeFriendMeta={activeFriendMeta}
                attachedKnowledge={attachedKnowledge}
                retryStatus={retryStatus}
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
            attachedFiles={attachedFiles}
            onRemoveAttachedFile={onRemoveAttachedFile}
            onCaptureScreen={onCaptureScreen}
            onPickProjectPath={onPickProjectPath}
            onAttachClipboard={onAttachClipboard}
            onSend={onSend}
            onCancelRequest={onCancelRequest}
            textareaRef={textareaRef}
            isWindowDraggingFile={isWindowDraggingFile}
            attachedKnowledge={attachedKnowledge}
            onAttachKnowledge={onAttachKnowledge}
            onDetachKnowledge={onDetachKnowledge}
            kioskOverlay={kioskOverlay}
            kioskSelection={kioskSelection}
            onAddKioskSelection={onAddKioskSelection}
            onClearKioskSelection={onClearKioskSelection}
            provider={provider}
            onSelectProvider={onSelectProvider}
            settings={settings}
            onOpenSettings={onOpenSettingsWindow}
            onUpdateSetting={onUpdateSetting}
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

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
  activeThreadId,
  streamingThreads,
  messages,
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
  onClearTerminal,
  scheduleNotifications = [],
  scheduleUnreadCount,
  onScheduleMarkRead = () => {},
  onScheduleMarkAllRead = () => {},
  onScheduleOpenChat = () => {},
  isScheduleSheetOpen = false,
  onCloseScheduleSheet = () => {},
  onOpenScheduleSheet = () => {},
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
        onOpenSettings={() => { setShowWelcome(false); setIsSettingsOpen(true); }}
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
      />

      {showWelcome ? (
        <WelcomeScreen
          onGetStarted={() => { setShowWelcome(false); setIsSettingsOpen(true); }}
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
              onNewChat={onNewChat}
              currentThreadId={activeThreadId}
              streamingThreads={streamingThreads}
              windowMode={windowMode}
            />
            <div className="flex-1 flex flex-col relative min-w-0 h-full min-h-0">
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

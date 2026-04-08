import { motion, AnimatePresence } from "framer-motion";
import { useMemo, useState } from "react";
import { ModeToggle } from './ModeToggle';

export function ChatInputArea({
  input,
  setInput,
  isLoading,
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
  textareaRef,
  isWindowDraggingFile,
  chatMode,
  friends = [],
  selectedFriend = null,
  onSelectFriendTarget = () => {},
}) {
  const [dragCounter, setDragCounter] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const isDragging = dragCounter > 0;
  const hasContent = input.trim() || attachedImage || isScreenAttached || attachedClipboardText || projectRoot;
  const slashQuery = useMemo(() => {
    const idx = input.lastIndexOf("/");
    if (idx < 0) return "";
    return input.slice(idx + 1).trim().toLowerCase();
  }, [input]);
  const filteredFriends = useMemo(() => {
    if (!slashQuery) return friends.slice(0, 8);
    return friends.filter((f) => (f.name || "").toLowerCase().includes(slashQuery)).slice(0, 8);
  }, [friends, slashQuery]);

  const selectFriend = (friend) => {
    if (!friend) return;
    const idx = input.lastIndexOf("/");
    const replacement = `/${friend.name} `;
    const next = idx >= 0 ? `${input.slice(0, idx)}${replacement}` : `${input}${replacement}`;
    setInput(next);
    onSelectFriendTarget(friend);
    setSlashOpen(false);
    setSlashIndex(0);
  };

  return (
    <footer
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isLoading) setDragCounter(prev => prev + 1);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragCounter(prev => prev - 1);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragCounter(0);
        if (isLoading) return;
        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
          const file = files[0];
          if (file.type.startsWith("image/")) {
            onFileDrop(file);
          }
        }
      }}
      className="w-[95%] absolute bottom-0 left-1/2 -translate-x-1/2 p-2 py-3 z-10"
    >
      <AnimatePresence>
        {(isDragging || isWindowDraggingFile) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[100] mb-2 flex items-center justify-center rounded-2xl border-2 border-dashed border-emerald-500/50 bg-emerald-500/10 backdrop-blur-sm pointer-events-none"
          >
            <div className="flex flex-col items-center gap-2 text-emerald-400">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-xs font-bold  tracking-wider">Drop image to attach</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex flex-col gap-2">
        <AnimatePresence>
          {attachedImage && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 10 }}
              className="relative self-start"
            >
              <div className="h-20 w-20 overflow-hidden rounded-xl border border-white/20 shadow-lg">
                <img src={attachedImage} alt="Preview" className="h-full w-full object-cover" />
              </div>
              <button
                onClick={() => setAttachedImage(null)}
                className="absolute -right-2 -top-2 rounded-full bg-red-500 p-1 text-white shadow-md hover:bg-red-600"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </motion.div>
          )}
          {isScreenAttached && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 10 }}
              className="relative self-start"
            >
              <div className="flex items-center gap-2 rounded-lg bg-emerald-500/20 border border-emerald-500/30 px-2.5 py-1.5 backdrop-blur-md">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-emerald-500/20 text-emerald-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="20" height="14" x="2" y="3" rx="2" />
                    <path d="M8 21h8" />
                    <path d="M12 17v4" />
                  </svg>
                </div>
                <span className="text-xs font-semibold text-emerald-400">@current_screen</span>
                <button
                  onClick={() => setIsScreenAttached(false)}
                  className="ml-1 rounded-full p-0.5 text-emerald-400/60 hover:bg-emerald-500/20 hover:text-emerald-400 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </motion.div>
          )}
          {projectRoot && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 10 }}
              className="relative self-start"
            >
              <div className="flex items-center gap-2 rounded-lg bg-amber-500/20 border border-amber-500/30 px-2.5 py-1.5 backdrop-blur-md">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-amber-500/20 text-amber-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                  </svg>
                </div>
                <span className="text-xs font-semibold text-amber-400">@{projectRootChip}</span>
                <button
                  onClick={() => { setProjectRoot(null); setProjectRootChip(null); }}
                  className="ml-1 rounded-full p-0.5 text-amber-400/60 hover:bg-amber-500/20 hover:text-amber-400 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </motion.div>
          )}
          {attachedClipboardText && (
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 10 }}
              className="relative self-start"
            >
              <div className="flex items-center gap-2 rounded-lg bg-blue-500/20 border border-blue-500/30 px-2.5 py-1.5 backdrop-blur-md">
                <div className="flex h-5 w-5 items-center justify-center rounded bg-blue-500/20 text-blue-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                    <circle cx="9" cy="9" r="2" />
                  </svg>
                </div>
                <span className="text-xs font-semibold text-blue-400 max-w-[120px] truncate">@clipboard</span>
                <button
                  onClick={() => setAttachedClipboardText(null)}
                  className="ml-1 rounded-full p-0.5 text-blue-400/60 hover:bg-blue-500/20 hover:text-blue-400 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-end gap-2">
          <div className="relative">
            <button
              onClick={() => setIsAttachmentPopoverOpen(!isAttachmentPopoverOpen)}
              disabled={isLoading || isCapturing}
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 shadow-sm transition active:scale-95 disabled:opacity-50 ${isAttachmentPopoverOpen ? "bg-neutral-600 text-white" : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200"}`}
              title="Attach"
            >
              {isCapturing ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m18 15-6-6-6 6" />
                </svg>
              )}
            </button>

            <AnimatePresence>
              {isAttachmentPopoverOpen && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: -10 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: -10 }}
                  className="absolute bottom-full left-0 mb-2 w-48 origin-bottom-left rounded-2xl border border-white/10 bg-neutral-800/95 p-1.5 shadow-2xl backdrop-blur-xl z-[100]"
                >
                  <button
                    onClick={onFileUpload}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-1 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                        <circle cx="9" cy="9" r="2" />
                        <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                      </svg>
                    </div>
                    <div className="flex flex-col items-start translate-y-[1px]">
                      <span className="font-medium text-[13px]">Upload Image</span>
                    </div>
                  </button>

                  <button
                    onClick={onCaptureScreen}
                    className="flex w-full items-center gap-3 rounded-xl py-1 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="20" height="14" x="2" y="3" rx="2" />
                        <path d="M8 21h8" />
                        <path d="M12 17v4" />
                      </svg>
                    </div>
                    <div className="flex flex-col items-start translate-y-[1px]">
                      <span className="font-medium text-[13px]">Current Screen</span>
                    </div>
                  </button>

                  <button
                    onClick={onPickProjectPath}
                    className="flex w-full items-center gap-3 rounded-xl py-1 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                      </svg>
                    </div>
                    <div className="flex flex-col items-start translate-y-[1px]">
                      <span className="font-medium text-[13px]">Project Path</span>
                    </div>
                  </button>

                  <button
                    onClick={onAttachClipboard}
                    className="flex w-full items-center gap-3 rounded-xl py-1 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-pink-500/10 text-pink-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
                        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                      </svg>
                    </div>
                    <div className="flex flex-col items-start translate-y-[1px]">
                      <span className="font-medium text-[13px]">Read Clipboard</span>
                    </div>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Text input container */}
          <div className="relative flex flex-col w-full justify-end group">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
                if (v.includes("/")) {
                  setSlashOpen(true);
                } else {
                  setSlashOpen(false);
                }
              }}
              onKeyDown={(e) => {
                if (slashOpen && filteredFriends.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((prev) => (prev + 1) % filteredFriends.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex((prev) => (prev - 1 + filteredFriends.length) % filteredFriends.length);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashOpen(false);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    selectFriend(filteredFriends[slashIndex] || filteredFriends[0]);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder={isRecording ? "Listening..." : "Tell Rie what to do..."}
              className={`custom-scrollbar w-full resize-none rounded-2xl border bg-neutral-800/80 px-3 py-2 text-[13px] text-neutral-100 placeholder-neutral-500 shadow-sm outline-none transition-all placeholder:transition-opacity ${isRecording ? "border-emerald-500 ring-2 ring-emerald-500/20" : `border-white/10 focus:bg-neutral-800 ${chatMode === 'agent' ? 'focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10' : 'focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10'}`} disabled:opacity-50 max-h-[280px]`}
              disabled={isLoading}
            />
            {slashOpen && filteredFriends.length > 0 && (
              <div className="absolute bottom-full mb-2 left-0 w-full rounded-xl border border-white/10 bg-neutral-800/95 z-[120] p-1 max-h-48 overflow-y-auto custom-scrollbar">
                {filteredFriends.map((friend, idx) => (
                  <button
                    key={friend.id}
                    onClick={() => selectFriend(friend)}
                    className={`w-full text-left px-2 py-1.5 rounded-lg text-xs ${idx === slashIndex ? "bg-emerald-500/20 text-emerald-200" : "text-neutral-300 hover:bg-white/5"}`}
                  >
                    /{friend.name}
                  </button>
                ))}
              </div>
            )}
            <AnimatePresence>
              {isRecording && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2"
                >
                  <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Live</span>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {selectedFriend && (
            <div className="text-[10px] text-emerald-300 whitespace-nowrap">target: {selectedFriend.name}</div>
          )}
          <button
            onClick={isLoading ? () => onCancelRequest() : onSend}
            disabled={!isLoading && !hasContent}
            className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/20 text-neutral-100 shadow-sm transition active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 ${isLoading ? "bg-red-500/20 hover:bg-red-500/40 text-red-400" : "bg-neutral-700 hover:bg-neutral-600"}`}
            title={isLoading ? "Stop generating" : "Send message"}
          >
            {isLoading ? (
              <div className="relative flex items-center justify-center">
                <div className="absolute h-6 w-6 animate-spin rounded-full border-2 border-red-500/30 border-t-red-500" />
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </div>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </footer>
  );
}

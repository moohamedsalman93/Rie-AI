import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

/**
 * Unified AttachmentPopover component used across Floating and Normal workspace modes.
 * Provides access to Upload File, Current Screen, Project Path, Clipboard, and Custom Knowledge.
 */
export function AttachmentPopover({
  isOpen,
  onClose,
  triggerRef,
  onFileUpload,
  onCaptureScreen,
  onPickProjectPath,
  onAttachClipboard,
  onOpenCustomKnowledge,
  className = "absolute bottom-full left-0 mb-2 z-50",
}) {
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event) {
      // Don't close if clicking inside the popover or on the trigger button (which toggles it)
      if (
        (popoverRef.current && popoverRef.current.contains(event.target)) ||
        (triggerRef?.current && triggerRef.current.contains(event.target))
      ) {
        return;
      }
      onClose?.();
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose?.();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, triggerRef]);

  if (!isOpen) return null;

  return (
    <motion.div
      ref={popoverRef}
      initial={{ opacity: 0, scale: 0.95, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 8 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={`${className} w-52 rounded-2xl border border-white/10 bg-neutral-900/95 p-1.5 shadow-2xl backdrop-blur-xl`}
    >
      {/* 1. Upload File */}
      <button
        type="button"
        onClick={() => {
          onClose?.();
          onFileUpload?.();
        }}
        className="flex w-full items-center gap-3 rounded-xl py-1.5 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white group"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div className="flex flex-col items-start translate-y-[0.5px]">
          <span className="font-medium text-[13px]">Upload File</span>
        </div>
      </button>

      {/* 2. Current Screen */}
      <button
        type="button"
        onClick={() => {
          onClose?.();
          onCaptureScreen?.();
        }}
        className="flex w-full items-center gap-3 rounded-xl py-1.5 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white group"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="20" height="14" x="2" y="3" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
        </div>
        <div className="flex flex-col items-start translate-y-[0.5px]">
          <span className="font-medium text-[13px]">Current Screen</span>
        </div>
      </button>

      {/* 3. Project Path */}
      <button
        type="button"
        onClick={() => {
          onClose?.();
          onPickProjectPath?.();
        }}
        className="flex w-full items-center gap-3 rounded-xl py-1.5 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white group"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400 group-hover:bg-amber-500/20 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
          </svg>
        </div>
        <div className="flex flex-col items-start translate-y-[0.5px]">
          <span className="font-medium text-[13px]">Project Path</span>
        </div>
      </button>

      {/* 4. Clipboard */}
      <button
        type="button"
        onClick={() => {
          onClose?.();
          onAttachClipboard?.();
        }}
        className="flex w-full items-center gap-3 rounded-xl py-1.5 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white group"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-pink-500/10 text-pink-400 group-hover:bg-pink-500/20 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          </svg>
        </div>
        <div className="flex flex-col items-start translate-y-[0.5px]">
          <span className="font-medium text-[13px]">Clipboard</span>
        </div>
      </button>

      {/* 5. Custom Knowledge */}
      <button
        type="button"
        onClick={() => {
          onClose?.();
          onOpenCustomKnowledge?.();
        }}
        className="flex w-full items-center gap-3 rounded-xl py-1.5 px-2 text-sm text-neutral-300 transition-all hover:bg-white/5 hover:text-white group"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400 group-hover:bg-violet-500/20 transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
          </svg>
        </div>
        <div className="flex flex-col items-start translate-y-[0.5px]">
          <span className="font-medium text-[13px]">Custom Knowledge</span>
        </div>
      </button>
    </motion.div>
  );
}

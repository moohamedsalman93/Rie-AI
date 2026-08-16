import React, { useState, useEffect, useRef, memo } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";

function ThinkingBlockImpl({ block, isStreaming = false }) {
  const [isExpanded, setIsExpanded] = useState(Boolean(block.isThinking));
  const [copied, setCopied] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    if (block.elapsedMs) return Math.round(block.elapsedMs / 1000);
    return 0;
  });
  const contentRef = useRef(null);
  const wasThinkingRef = useRef(block.isThinking);

  // Keep expanded while thinking is in progress
  useEffect(() => {
    if (block.isThinking) {
      setIsExpanded(true);
      wasThinkingRef.current = true;
    } else if (wasThinkingRef.current) {
      wasThinkingRef.current = false;
      setIsExpanded(false);
    }
  }, [block.isThinking]);

  // Live timer while thinking is active
  useEffect(() => {
    if (!block.isThinking) return;
    const start = block.startTime || Date.now();
    const interval = setInterval(() => {
      const elapsed = Math.max(1, Math.round((Date.now() - start) / 1000));
      setElapsedSeconds(elapsed);
    }, 1000);
    return () => clearInterval(interval);
  }, [block.isThinking, block.startTime]);

  // Auto-scroll thought content as new tokens stream in
  useEffect(() => {
    if (isExpanded && block.isThinking && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [block.text, isExpanded, block.isThinking]);

  const handleCopy = (e) => {
    e.stopPropagation();
    if (!block.text) return;
    navigator.clipboard.writeText(block.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const formattedTime = () => {
    if (block.elapsedMs) {
      const sec = (block.elapsedMs / 1000).toFixed(1);
      return `${sec}s`;
    }
    if (elapsedSeconds > 0) {
      return `${elapsedSeconds}s`;
    }
    return null;
  };

  const timeLabel = formattedTime();

  return (
    <div className="my-1.5 w-full">
      {/* Simple Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="group flex items-center gap-1.5 text-xs text-neutral-400 hover:text-neutral-200 transition-colors select-none py-0.5"
      >
        <span className="text-neutral-500 group-hover:text-neutral-300 transition-colors">
          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>

        <span className="font-normal">
          {block.isThinking
            ? `Thinking${timeLabel ? ` (${timeLabel})` : ""}...`
            : timeLabel
            ? `Thought for ${timeLabel}`
            : "Thinking process"}
        </span>

        {block.isThinking && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-400 animate-pulse" />
        )}
      </button>

      {/* Simple Expanded Content */}
      {isExpanded && (
        <div className="relative mt-1 pl-3 border-l border-neutral-700/70 text-xs text-neutral-400 leading-relaxed font-sans group/thought">
          <div
            ref={contentRef}
            className="max-h-56 overflow-y-auto custom-scrollbar pr-6 py-0.5 whitespace-pre-wrap break-words opacity-85"
          >
            {block.text || "Thinking..."}
            {block.isThinking && (
              <span className="inline-block w-1 h-3 bg-neutral-400 animate-pulse ml-0.5 align-middle" />
            )}
          </div>

          {block.text && !block.isThinking && (
            <button
              onClick={handleCopy}
              className="absolute top-0 right-0 p-1 text-neutral-500 hover:text-neutral-300 opacity-0 group-hover/thought:opacity-100 transition"
              title="Copy thinking"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const ThinkingBlock = memo(ThinkingBlockImpl);
ThinkingBlock.displayName = "ThinkingBlock";

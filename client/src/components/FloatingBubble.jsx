import { useEffect } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import logo from "../assets/logo.png";

export function FloatingBubble({
  privacyToast,
  currentTool,
  retryStatus = null,
  isLoading,
  isRecording,
  hasPendingAction,
  isSnapping,
  onMouseDown,
  getToolDisplayName,
  bubbleRef,
  settings = {},
}) {
  const showLabel = settings.bubble_show_label !== false && settings.bubble_show_label !== "false";
  const bubbleSize = settings.bubble_size || "medium"; // 'small' | 'medium' | 'large'
  const transparentBg = settings.bubble_transparent_bg === true || settings.bubble_transparent_bg === "true";
  const showTools = settings.bubble_show_tools !== false && settings.bubble_show_tools !== "false";

  const isToastActive = privacyToast?.show;

  useEffect(() => {
    if (!bubbleRef || !bubbleRef.current) return;
    const element = bubbleRef.current;

    const adjustWindowSize = async () => {
      try {
        const scrollW = element.scrollWidth;
        const scrollH = element.scrollHeight;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const measuredW = Math.max(rect.width, scrollW);
        const measuredH = Math.max(rect.height, scrollH);

        const targetWidth = Math.max(40, Math.ceil(measuredW) + 14);
        const targetHeight = Math.max(40, Math.ceil(measuredH) + 14);

        const win = getCurrentWindow();
        const scale = await win.scaleFactor();
        const outerSize = await win.outerSize();
        const curW = Math.round(outerSize.width / scale);
        const curH = Math.round(outerSize.height / scale);

        if (Math.abs(curW - targetWidth) > 3 || Math.abs(curH - targetHeight) > 3) {
          const outerPos = await win.outerPosition();
          const curX = Math.round(outerPos.x / scale);
          const curY = Math.round(outerPos.y / scale);

          const screenWidth = window.screen.availWidth;
          const screenLeft = window.screen.availLeft || 0;
          const isRightSide = curX > screenLeft + screenWidth / 2;

          if (isRightSide) {
            const newX = curX + (curW - targetWidth);
            await win.setPosition(new LogicalPosition(newX, curY));
          }
          await win.setSize(new LogicalSize(targetWidth, targetHeight));
        }
      } catch (err) {
        console.error("Failed to dynamically adjust bubble window size:", err);
      }
    };

    const observer = new ResizeObserver(() => {
      adjustWindowSize();
    });

    observer.observe(element);
    adjustWindowSize();

    return () => {
      observer.disconnect();
    };
  }, [bubbleRef, privacyToast, currentTool, isLoading, isRecording, hasPendingAction, bubbleSize, showLabel, transparentBg, showTools]);

  const activeToolText = showTools && currentTool ? getToolDisplayName(currentTool) : null;
  const shouldShowText = isToastActive || isRecording || hasPendingAction || activeToolText || Boolean(retryStatus?.message) || isLoading || showLabel;

  // Size styling classes
  const sizeClasses =
    bubbleSize === "small"
      ? (shouldShowText ? "px-2.5 py-1 text-xs" : "p-1.5 text-xs aspect-square")
      : bubbleSize === "large"
      ? (shouldShowText ? "px-4.5 py-2.5 text-sm" : "p-2.5 text-sm aspect-square")
      : (shouldShowText ? "px-3.5 py-1.5 text-xs" : "p-2 text-xs aspect-square");

  // Icon dimensions
  const iconSizes = shouldShowText
    ? bubbleSize === "small"
      ? "h-4 w-4"
      : bubbleSize === "large"
      ? "h-7 w-7"
      : "h-5 w-5"
    : bubbleSize === "small"
    ? "h-6 w-6"
    : bubbleSize === "large"
    ? "h-11 w-11"
    : "h-8 w-8";

  // Background styling classes — zero border and transparent when transparentBg is enabled
  const bgClasses = transparentBg
    ? "bg-transparent border-transparent hover:bg-white/10 shadow-none text-white"
    : "bg-neutral-900/95 backdrop-blur-md hover:bg-neutral-800 border-neutral-700/60 shadow-xl text-neutral-100";

  return (
    <motion.button
      key="bubble"
      initial={{ opacity: 0, scale: 0.6 }}
      animate={
        isToastActive
          ? {
              opacity: 1,
              scale: 1,
              rotate: 0,
              boxShadow:
                privacyToast.type === "enabled"
                  ? "0 0 20px rgba(16,185,129,0.3)"
                  : privacyToast.type === "hold_hint"
                  ? "0 0 20px rgba(245,158,11,0.3)"
                  : "0 0 20px rgba(239,68,68,0.3)",
              borderColor:
                privacyToast.type === "enabled"
                  ? "rgba(16,185,129,0.6)"
                  : privacyToast.type === "hold_hint"
                  ? "rgba(245,158,11,0.6)"
                  : "rgba(239,68,68,0.6)",
            }
          : currentTool || isLoading || isRecording || hasPendingAction
          ? {
              opacity: 1,
              scale: [1, 1.04, 1],
              rotate: 0,
              boxShadow: hasPendingAction
                ? [
                    "0 0 0px rgba(245,158,11,0.0)",
                    "0 0 25px rgba(245,158,11,0.45)",
                    "0 0 0px rgba(245,158,11,0.0)",
                  ]
                : [
                    "0 0 0px rgba(16,185,129,0.0)",
                    "0 0 25px rgba(16,185,129,0.45)",
                    "0 0 0px rgba(16,185,129,0.0)",
                  ],
              borderColor: hasPendingAction
                ? ["rgba(82,82,82,0.5)", "rgba(245,158,11,0.8)", "rgba(82,82,82,0.5)"]
                : ["rgba(82,82,82,0.5)", "rgba(16,185,129,0.8)", "rgba(82,82,82,0.5)"],
            }
          : {
              opacity: 1,
              scale: 1,
              rotate: 0,
              boxShadow: transparentBg ? "none" : "0 4px 12px rgba(0,0,0,0.1)",
              borderColor: transparentBg ? "transparent" : "rgba(82,82,82,0.5)",
            }
      }
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
      transition={{ type: "spring", stiffness: 340, damping: 28 }}
      onMouseDown={onMouseDown}
      ref={bubbleRef}
      className={`pointer-events-auto flex items-center justify-center gap-2 rounded-full border transition-all select-none ${sizeClasses} ${bgClasses} ${
        isSnapping ? "pointer-events-none opacity-80" : ""
      }`}
    >
      {!isToastActive && (
        <div className="relative flex items-center justify-center shrink-0 pointer-events-none select-none">
          <img
            src={logo}
            alt="Rie-AI"
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            className={`${iconSizes} object-contain z-10 pointer-events-none select-none transition-all duration-200`}
          />
          {(currentTool || isLoading || isRecording || hasPendingAction) && (
            <motion.div
              className={`absolute inset-0 rounded-full blur-md ${
                hasPendingAction ? "bg-amber-500/20" : "bg-emerald-500/20"
              }`}
              animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0.6, 0.3] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          )}
        </div>
      )}

      {shouldShowText && (
        <span className="font-semibold text-neutral-100 flex items-center gap-1.5 min-w-0 overflow-hidden pointer-events-none select-none">
          {isToastActive ? (
            privacyToast.type === "enabled" ? (
              <>
                <ShieldCheck size={16} className="text-emerald-400 shrink-0 animate-pulse" />
                <span className="text-emerald-300 font-bold text-xs whitespace-nowrap">Privacy ON</span>
              </>
            ) : privacyToast.type === "hold_hint" ? (
              <>
                <ShieldAlert size={16} className="text-amber-400 shrink-0" />
                <span className="text-amber-300 font-bold text-xs whitespace-nowrap">Hold Alt+Shift+Q (1s)</span>
              </>
            ) : (
              <>
                <ShieldOff size={16} className="text-red-400 shrink-0" />
                <span className="text-red-300 font-bold text-xs whitespace-nowrap">Privacy OFF</span>
              </>
            )
          ) : isRecording ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="text-emerald-500 font-bold text-[10px] uppercase tracking-wider">Live</span>
            </>
          ) : hasPendingAction ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
              <span className="truncate text-amber-500">Wait...</span>
            </>
          ) : activeToolText ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="truncate">{activeToolText}</span>
            </>
          ) : retryStatus?.message ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping shrink-0" />
              <span className="truncate text-amber-300 font-medium text-[11px]">{`Key #${retryStatus.keyIndex || 2}...`}</span>
            </>
          ) : isLoading ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="truncate">Thinking...</span>
            </>
          ) : showLabel ? (
            "Rie-AI"
          ) : null}
        </span>
      )}
    </motion.button>
  );
}

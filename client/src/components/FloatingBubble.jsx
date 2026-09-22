import { useEffect } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import logo from "../assets/logo.png";

function BubbleVoiceBars({
  isSpeaking,
  isUserSpeaking,
  isMuted,
  volume = 0,
  status = "listening",
  activeTool = null,
  bubbleSize = "medium",
}) {
  if (isMuted) {
    return (
      <div
        className="flex items-center gap-[3px] h-5 px-1.5 justify-center"
        title="Microphone muted"
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="w-[3px] h-1.5 rounded-full bg-red-400/60 transition-colors"
          />
        ))}
      </div>
    );
  }

  // 5 Symmetrical equalizer bars
  const barConfigs =
    bubbleSize === "small"
      ? [
          { height: 11, delay: 0.28 },
          { height: 14, delay: 0.12 },
          { height: 18, delay: 0 },
          { height: 14, delay: 0.2 },
          { height: 11, delay: 0.35 },
        ]
      : bubbleSize === "large"
      ? [
          { height: 16, delay: 0.32 },
          { height: 22, delay: 0.14 },
          { height: 26, delay: 0 },
          { height: 22, delay: 0.22 },
          { height: 16, delay: 0.4 },
        ]
      : [
          { height: 13, delay: 0.3 },
          { height: 18, delay: 0.12 },
          { height: 22, delay: 0 },
          { height: 18, delay: 0.2 },
          { height: 13, delay: 0.36 },
        ];

  const isTool = status === "tool" || Boolean(activeTool);
  const isConnecting = status === "connecting";

  // Gradient and shadow style based on state
  let barGradient = "bg-gradient-to-t from-emerald-500/80 via-teal-400 to-cyan-300";
  let barGlow = "shadow-[0_0_8px_rgba(45,212,191,0.5)]";
  let animationName = "voice-wave-listening";
  let animationDuration = "1.2s";
  let title = "Listening to you...";

  if (isSpeaking) {
    barGradient = "bg-gradient-to-t from-violet-500 via-fuchsia-400 to-indigo-300";
    barGlow = "shadow-[0_0_10px_rgba(168,85,247,0.7)]";
    animationName = "voice-wave-speaking";
    animationDuration = "0.55s";
    title = "Rie is speaking...";
  } else if (isUserSpeaking) {
    barGradient = "bg-gradient-to-t from-emerald-400 via-teal-300 to-cyan-300";
    barGlow = "shadow-[0_0_10px_rgba(16,185,129,0.75)]";
    animationName = "voice-wave-speaking";
    animationDuration = "0.45s";
    title = "Listening to your voice...";
  } else if (isTool) {
    barGradient = "bg-gradient-to-t from-amber-400 via-orange-400 to-violet-400";
    barGlow = "shadow-[0_0_8px_rgba(245,158,11,0.6)]";
    animationName = "voice-wave-thinking";
    animationDuration = "0.85s";
    title = activeTool ? `Running ${getToolDisplayName(activeTool.name || activeTool)}...` : "Processing action...";
  } else if (isConnecting) {
    barGradient = "bg-gradient-to-t from-indigo-400 via-purple-300 to-cyan-300";
    barGlow = "shadow-[0_0_8px_rgba(99,102,241,0.5)]";
    animationName = "voice-wave-listening";
    animationDuration = "0.7s";
    title = "Connecting to Gemini Live...";
  }

  // Volume scale boost during active speech
  const volMultiplier = isSpeaking || isUserSpeaking
    ? Math.max(0.6, Math.min(1.45, 0.7 + volume * 2.0))
    : 1;

  return (
    <div
      className="flex items-center gap-[3px] h-6 px-1 justify-center min-w-[32px]"
      title={title}
    >
      {barConfigs.map((bar, idx) => (
        <span
          key={idx}
          className={`w-[3px] rounded-full transform-gpu ${barGradient} ${barGlow}`}
          style={{
            height: `${bar.height}px`,
            transformOrigin: "center",
            animationName,
            animationDuration,
            animationTimingFunction: isSpeaking || isUserSpeaking ? "ease-in-out" : "cubic-bezier(0.4, 0, 0.2, 1)",
            animationIterationCount: "infinite",
            animationDelay: `${bar.delay}s`,
            transform: `scaleY(${volMultiplier})`,
            transition: "transform 0.1s ease-out, background 0.3s ease",
          }}
        />
      ))}
    </div>
  );
}

export function FloatingBubble({
  privacyToast,
  currentTool,
  retryStatus = null,
  isLoading,
  isLiveVoiceActive,
  liveVoiceStatus = "listening",
  liveVoiceVolumes = { userVolume: 0, assistantVolume: 0 },
  liveVoiceMuted = false,
  liveVoiceActiveTool = null,
  suspendWindowResize,
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

  const isSpeaking = isLiveVoiceActive && (liveVoiceStatus === "speaking" || liveVoiceVolumes.assistantVolume > 0.05);
  const isUserSpeaking = isLiveVoiceActive && (liveVoiceVolumes.userVolume > 0.06 && !liveVoiceMuted);
  const vol = isSpeaking ? liveVoiceVolumes.assistantVolume : isUserSpeaking ? liveVoiceVolumes.userVolume : 0.0;

  useEffect(() => {
    if (!bubbleRef || !bubbleRef.current) return;
    const element = bubbleRef.current;
    let cancelled = false;

    const adjustWindowSize = async () => {
      if (cancelled || suspendWindowResize?.()) return;
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
        if (cancelled || suspendWindowResize?.()) return;
        const curW = Math.round(outerSize.width / scale);
        const curH = Math.round(outerSize.height / scale);

        if (Math.abs(curW - targetWidth) > 3 || Math.abs(curH - targetHeight) > 3) {
          const outerPos = await win.outerPosition();
          if (cancelled || suspendWindowResize?.()) return;
          const curX = Math.round(outerPos.x / scale);
          const curY = Math.round(outerPos.y / scale);

          const screenWidth = window.screen.availWidth;
          const screenLeft = window.screen.availLeft || 0;
          const isRightSide = curX > screenLeft + screenWidth / 2;

          if (isRightSide) {
            const newX = curX + (curW - targetWidth);
            await win.setPosition(new LogicalPosition(newX, curY));
          }
          if (!cancelled && !suspendWindowResize?.()) await win.setSize(new LogicalSize(targetWidth, targetHeight));
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
      cancelled = true;
      observer.disconnect();
    };
  }, [bubbleRef, privacyToast, currentTool, isLoading, isLiveVoiceActive, liveVoiceStatus, hasPendingAction, bubbleSize, showLabel, transparentBg, showTools, suspendWindowResize]);

  const activeToolText = showTools && (currentTool || liveVoiceActiveTool) ? getToolDisplayName(currentTool || liveVoiceActiveTool.name || liveVoiceActiveTool) : null;
  const shouldShowText = isToastActive || isLiveVoiceActive || hasPendingAction || activeToolText || Boolean(retryStatus?.message) || isLoading || showLabel;

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
    : "bg-neutral-900/95 backdrop-blur-md hover:bg-neutral-800 border-neutral-700/60 shadow-none text-neutral-100";

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
              boxShadow: "none",
              borderColor:
                privacyToast.type === "enabled"
                  ? "rgba(16,185,129,0.6)"
                  : privacyToast.type === "hold_hint"
                  ? "rgba(245,158,11,0.6)"
                  : "rgba(239,68,68,0.6)",
            }
          : isLiveVoiceActive
          ? {
              opacity: 1,
              scale: 1,
              rotate: 0,
              boxShadow: isSpeaking
                ? "0 0 16px rgba(168,85,247,0.45), inset 0 0 8px rgba(168,85,247,0.2)"
                : isUserSpeaking
                ? "0 0 16px rgba(16,185,129,0.45), inset 0 0 8px rgba(16,185,129,0.2)"
                : liveVoiceStatus === "tool"
                ? "0 0 14px rgba(245,158,11,0.4), inset 0 0 6px rgba(245,158,11,0.15)"
                : "0 0 10px rgba(16,185,129,0.25)",
              borderColor: isSpeaking
                ? "rgba(168,85,247,0.75)"
                : isUserSpeaking
                ? "rgba(16,185,129,0.75)"
                : liveVoiceStatus === "tool"
                ? "rgba(245,158,11,0.7)"
                : "rgba(16,185,129,0.5)",
            }
          : currentTool || isLoading || hasPendingAction
          ? {
              opacity: 1,
              scale: [1, 1.04, 1],
              rotate: 0,
              boxShadow: "none",
              borderColor: hasPendingAction
                ? ["rgba(82,82,82,0.5)", "rgba(245,158,11,0.8)", "rgba(82,82,82,0.5)"]
                : ["rgba(82,82,82,0.5)", "rgba(16,185,129,0.8)", "rgba(82,82,82,0.5)"],
            }
          : {
              opacity: 1,
              scale: 1,
              rotate: 0,
              boxShadow: "none",
              borderColor: transparentBg ? "transparent" : "rgba(82,82,82,0.5)",
            }
      }
      exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
              transition={{ duration: 0.22, ease: "easeOut" }}
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
          ) : isLiveVoiceActive ? (
            <BubbleVoiceBars
              isSpeaking={isSpeaking}
              isUserSpeaking={isUserSpeaking}
              isMuted={liveVoiceMuted}
              volume={vol}
              status={liveVoiceStatus}
              activeTool={liveVoiceActiveTool}
              bubbleSize={bubbleSize}
            />
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

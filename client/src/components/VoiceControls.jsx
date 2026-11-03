import { AlertCircle, Loader2, Mic, MicOff, PhoneOff, RotateCcw, X } from "lucide-react";
import { getToolDisplayName } from "../constants/appConfig";

export default function VoiceControls({
  status = "connecting",
  activeTool = null,
  isMuted = false,
  volumes = { userVolume: 0, assistantVolume: 0 },
  onToggleMute,
  onEndSession,
  error = null,
  onRetry,
}) {
  if (error) {
    return (
      <section aria-label="Voice controls" className="flex w-full max-w-md items-start gap-3 rounded-2xl border border-red-400/20 bg-neutral-900 px-3 py-3 text-neutral-200 shadow-lg">
        <AlertCircle aria-hidden="true" size={18} className="mt-1 shrink-0 text-red-400" />
        <div role="alert" className="min-w-0 flex-1">
          <p className="text-xs font-medium">Voice connection failed</p>
          <p className="mt-1 break-words text-xs text-neutral-400">{error}</p>
          <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15 focus-visible:outline focus-visible:outline-emerald-400">
            <RotateCcw aria-hidden="true" size={13} /> Retry voice
          </button>
        </div>
        <button type="button" onClick={onEndSession} aria-label="Dismiss voice error" title="Back to chat"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-emerald-400">
          <X size={17} />
        </button>
      </section>
    );
  }
  const connecting = status === "connecting" || status === "starting";
  const speaking = status === "speaking";
  const isThinking = status === "thinking" || Boolean(activeTool);
  const userVol = volumes?.userVolume ?? 0;
  const assistantVol = volumes?.assistantVolume ?? 0;
  const hearing = !isMuted && userVol > 0.08;

  const statusText = connecting ? (status === "starting" ? "Starting microphone…" : "Connecting…")
    : activeTool ? `${activeTool.status === "queued" ? "Waiting for" : "Running"} ${getToolDisplayName(activeTool.name)}`
    : speaking ? "Rie is speaking"
    : isThinking ? "Rie is thinking"
    : isMuted ? "Microphone off"
    : hearing ? "Listening to you" : "Listening";

  const level = speaking ? assistantVol : hearing ? userVol : 0;
  const waveColor = isMuted && !speaking
    ? "bg-neutral-600"
    : speaking
      ? "bg-neutral-200"
      : isThinking
        ? "bg-amber-400"
        : "bg-emerald-400";

  return (
    <section
      aria-label="Voice controls"
      className="inline-flex items-center gap-2 sm:gap-3 rounded-full border border-white/10 bg-neutral-900/95 p-1.5 sm:p-2 text-neutral-200 shadow-2xl backdrop-blur-md"
    >
      {/* Left: Mic Mute Button */}
      <button
        type="button"
        onClick={onToggleMute}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={isMuted}
        title={isMuted ? "Unmute microphone" : "Mute microphone"}
        className={`flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-full transition-all outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${
          isMuted
            ? "bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
            : "bg-white/[0.06] text-neutral-300 hover:bg-white/10 hover:text-white"
        }`}
      >
        {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>

      {/* Center: Animated Design */}
      <div
        title={statusText}
        aria-label={statusText}
        className="flex h-9 sm:h-10 min-w-[68px] sm:min-w-[76px] items-center justify-center gap-1 sm:gap-1.5 px-3.5 rounded-full bg-white/[0.04] border border-white/[0.06] select-none"
      >
        {connecting ? (
          <Loader2 size={16} className="text-emerald-400 motion-safe:animate-spin" />
        ) : (
          [0.5, 0.85, 1, 0.7, 0.4].map((weight, index) => (
            <span
              key={index}
              className={`w-1 rounded-full motion-safe:transition-[height] duration-100 ease-out ${waveColor}`}
              style={{
                height: isThinking
                  ? `${6 + weight * 10}px`
                  : `${4 + weight * Math.min(20, (speaking ? Math.max(0.2, level) : level) * 28)}px`,
                transformOrigin: "center",
                ...(isThinking
                  ? {
                      animation: `voice-wave-thinking 0.9s ease-in-out infinite ${index * 0.15}s`,
                    }
                  : {}),
              }}
            />
          ))
        )}
      </div>

      {/* Right: Disconnect Button */}
      <button
        type="button"
        onClick={onEndSession}
        aria-label="End voice conversation"
        title="End voice conversation"
        className="flex h-9 w-9 sm:h-10 sm:w-10 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-400 transition-all hover:bg-red-500/25 outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
      >
        <PhoneOff size={18} />
      </button>
    </section>
  );
}

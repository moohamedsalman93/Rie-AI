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
      <section aria-label="Voice controls" className="flex w-full min-w-0 items-start gap-3 rounded-2xl border border-red-400/20 bg-neutral-900 px-3 py-3 text-neutral-200">
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
  const hearing = !isMuted && volumes.userVolume > 0.08;
  const statusText = connecting ? (status === "starting" ? "Starting microphone…" : "Connecting…")
    : activeTool ? `${activeTool.status === "queued" ? "Waiting for" : "Running"} ${getToolDisplayName(activeTool.name)}`
    : speaking ? "Rie is speaking"
    : status === "thinking" ? "Rie is thinking"
    : isMuted ? "Microphone off"
    : hearing ? "Listening to you" : "Listening";
  const level = speaking ? volumes.assistantVolume : hearing ? volumes.userVolume : 0;
  const waveColor = isMuted && !speaking ? "bg-neutral-600" : speaking ? "bg-neutral-200" : "bg-emerald-400";

  return (
    <section aria-label="Voice controls" className="flex w-full min-w-0 items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 px-3 py-3 text-neutral-200 shadow-sm">
      <div aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center gap-0.5 rounded-full bg-white/[0.04]">
        {connecting ? <Loader2 size={16} className="text-neutral-500 motion-safe:animate-spin" /> :
          [0.5, 0.85, 1, 0.7, 0.4].map((weight, index) => (
            <span key={index} className={`w-0.5 rounded-full motion-safe:transition-[height] duration-100 ${waveColor}`}
              style={{ height: `${4 + weight * Math.min(20, level * 28)}px` }} />
          ))}
      </div>
      <div className="min-w-0 flex-1">
        <p role="status" className="truncate text-xs font-medium text-neutral-100" title={statusText}>{statusText}</p>
        <p className="mt-0.5 truncate text-[11px] text-neutral-500">
          {isMuted ? (speaking || status === "thinking" || activeTool ? "Microphone off · You can still hear Rie" : "Unmute to speak") : "Transcript and actions appear in this chat"}
        </p>
      </div>
      <button type="button" onClick={onToggleMute}
        aria-label={isMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={isMuted}
        title={isMuted ? "Unmute microphone" : "Mute microphone"}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 ${isMuted ? "bg-white/10 text-white" : "text-neutral-400 hover:bg-white/[0.06] hover:text-white"}`}>
        {isMuted ? <MicOff size={17} /> : <Mic size={17} />}
      </button>
      <button type="button" onClick={onEndSession} aria-label="End voice conversation" title="End voice conversation"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-400 transition-colors hover:bg-red-500/20 outline-none focus-visible:ring-2 focus-visible:ring-red-400/60">
        <PhoneOff size={17} />
      </button>
    </section>
  );
}

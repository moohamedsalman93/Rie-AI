import { Check, ChevronDown, CircleSlash, Loader2, Wrench, XCircle } from "lucide-react";
import { getToolDisplayName } from "../constants/appConfig";

const TOOL_STATES = {
  queued: { label: "Queued", Icon: Wrench, color: "text-neutral-400" },
  running: { label: "Running", Icon: Loader2, color: "text-amber-300" },
  completed: { label: "Done", Icon: Check, color: "text-emerald-400" },
  failed: { label: "Failed", Icon: XCircle, color: "text-red-400" },
  cancelled: { label: "Cancelled", Icon: CircleSlash, color: "text-neutral-400" },
};

const printable = (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2);

export default function VoiceToolActivity({ item }) {
  const { label, Icon, color } = TOOL_STATES[item.status] || TOOL_STATES.queued;
  const detail = item.args?.url || item.args?.query || item.args?.name || item.args?.target;
  return (
    <details className="group/voice-tool min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.025]">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 [&::-webkit-details-marker]:hidden">
        <Icon size={14} aria-hidden="true" className={`shrink-0 ${color} ${item.status === "running" ? "motion-safe:animate-spin" : ""}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-neutral-200">{item.name === "internet_search" ? "Web search" : getToolDisplayName(item.name) || "Action"}</span>
          {detail && <span className="block truncate text-[11px] text-neutral-500" title={String(detail)}>{String(detail)}</span>}
        </span>
        <span className={`shrink-0 text-[10px] ${color}`}>{label}</span>
        <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-neutral-500 transition-transform group-open/voice-tool:rotate-180" />
      </summary>
      <div className="space-y-2 border-t border-white/[0.05] px-3 py-2.5 text-[11px]">
        {item.args && Object.keys(item.args).length > 0 && <div>
          <p className="mb-1 text-neutral-500">Input</p>
          <pre className="whitespace-pre-wrap break-words font-mono text-neutral-400">{printable(item.args)}</pre>
        </div>}
        <div>
          <p className="mb-1 text-neutral-500">Result</p>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-neutral-300">{item.result != null ? printable(item.result) : item.status === "queued" ? "Waiting for the previous action." : "Waiting for the result…"}</pre>
        </div>
      </div>
    </details>
  );
}

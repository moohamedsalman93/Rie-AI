import React, { memo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  CircleSlash,
  Clock,
  Loader2,
  Terminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { MarkdownMessage } from "./MarkdownMessage";

export const VoiceSubAgentActivity = memo(({ block, onCancel }) => {
  const [expanded, setExpanded] = useState(false);
  const isRunning = block.status === "running";
  const isCompleted = block.status === "completed";
  const isCancelled = block.status === "cancelled";
  const isFailed = block.status === "failed";

  const events = block.events || [];
  const latestEvent = block.latest_event || (isRunning ? "Subagent starting execution..." : "Execution ended");

  return (
    <div className="my-2.5 max-w-2xl rounded-xl border border-white/[0.08] bg-neutral-900/70 backdrop-blur-md shadow-lg overflow-hidden transition-all duration-200">
      {/* Header bar */}
      <div
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center justify-between gap-3 px-3.5 py-2.5 cursor-pointer hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {/* Bot Avatar Icon */}
          <div className="relative shrink-0">
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center border transition-all ${
                isRunning
                  ? "bg-amber-500/10 text-amber-400 border-amber-500/30 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                  : isCompleted
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : isCancelled
                  ? "bg-neutral-800 text-neutral-400 border-neutral-700"
                  : "bg-red-500/10 text-red-400 border-red-500/30"
              }`}
            >
              <Bot size={15} />
            </div>
            {isRunning && (
              <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
            )}
          </div>

          {/* Title & Task Summary */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-neutral-200 tracking-tight">
                Autonomous Subagent
              </span>
              <span className="text-[10px] font-mono text-neutral-500 truncate">
                {block.job_id}
              </span>
            </div>
            <p className="text-[11px] text-neutral-400 truncate leading-relaxed">
              {block.task}
            </p>
          </div>
        </div>

        {/* Action Controls & Status */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Status Badge */}
          {isRunning && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <Loader2 size={10} className="animate-spin" />
              <span>Working</span>
            </span>
          )}
          {isCompleted && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Check size={10} />
              <span>Done</span>
            </span>
          )}
          {isCancelled && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-800 text-neutral-400 border border-neutral-700">
              <CircleSlash size={10} />
              <span>Cancelled</span>
            </span>
          )}
          {isFailed && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
              <XCircle size={10} />
              <span>Failed</span>
            </span>
          )}

          {/* Cancel Button */}
          {isRunning && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancel?.(block.job_id);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30 transition-all hover:scale-105 active:scale-95"
              title="Cancel subagent"
            >
              <X size={10} />
              <span>Cancel</span>
            </button>
          )}

          <ChevronDown
            size={13}
            className={`text-neutral-500 transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </div>
      </div>

      {/* Live Tool Calling / Current Step Strip */}
      {isRunning && (
        <div className="flex items-center gap-2 px-3.5 py-1.5 bg-black/30 border-t border-white/[0.05] text-[11px] text-amber-300 font-mono">
          <Terminal size={11} className="shrink-0 text-amber-400" />
          <span className="truncate flex-1">{latestEvent}</span>
          <Loader2 size={11} className="shrink-0 animate-spin text-amber-400" />
        </div>
      )}

      {/* Expandable Body */}
      {expanded && (
        <div className="border-t border-white/[0.06] bg-black/20 px-3.5 py-3 space-y-3 text-xs">
          {/* Objective */}
          <div>
            <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1">
              Task Objective
            </div>
            <div className="text-neutral-300 leading-relaxed bg-white/[0.02] p-2 rounded-lg border border-white/[0.04]">
              {block.task}
            </div>
          </div>

          {/* Live Tool Calling & Execution Events */}
          {events.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Clock size={10} />
                <span>Execution Timeline ({events.length} steps)</span>
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1 text-[11px] font-mono">
                {events.map((evt, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-1.5 text-neutral-400 bg-white/[0.015] px-2 py-1 rounded border border-white/[0.02]"
                  >
                    <span className="text-neutral-600 shrink-0 select-none">
                      {idx + 1}.
                    </span>
                    <span className="truncate">{evt}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Result or Error */}
          {block.result && (
            <div>
              <div className="text-[10px] font-semibold text-neutral-500 uppercase tracking-wider mb-1">
                Outcome
              </div>
              <div className="text-neutral-200 bg-white/[0.02] p-2.5 rounded-lg border border-white/[0.04] leading-relaxed">
                <MarkdownMessage content={block.result} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

VoiceSubAgentActivity.displayName = "VoiceSubAgentActivity";
export default VoiceSubAgentActivity;

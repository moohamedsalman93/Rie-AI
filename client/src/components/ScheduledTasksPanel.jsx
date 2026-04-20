import { useState, useEffect, useCallback } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { listScheduledTasks, cancelScheduledTask } from '../services/chatApi';

const INTENT_LABEL = {
  reminder: 'Reminder',
  analysis_silent: 'Analysis',
  analysis_inform: 'Analysis + notify',
};

function formatRunAt(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return String(iso);
  }
}

export function ScheduledTasksPanel({ apiStatus, className = "", variant = "default" }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (apiStatus !== 'online') return;
    setLoading(true);
    setError(null);
    try {
      const data = await listScheduledTasks();
      setTasks(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || 'Failed to load');
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [apiStatus]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onWs = () => load();
    window.addEventListener("rie-scheduler-tasks-refresh", onWs);
    return () => window.removeEventListener("rie-scheduler-tasks-refresh", onWs);
  }, [load]);

  // Refresh when a chat finishes (agent may have called schedule_chat_task)
  useEffect(() => {
    const onRefresh = () => load();
    window.addEventListener('rie-schedule-refresh', onRefresh);
    return () => window.removeEventListener('rie-schedule-refresh', onRefresh);
  }, [load]);

  const handleCancel = async (e, jobId) => {
    e.stopPropagation();
    try {
      await cancelScheduledTask(jobId);
      await load();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div
      className={`shrink-0 ${variant === "sheet" ? "border-t-0" : "border-t border-neutral-800"} ${className}`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200 transition-colors"
      >
        <span className="flex items-center gap-2">
          <CalendarClock className="w-3.5 h-3.5 text-amber-400/90" />
          Scheduled
          {tasks.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
              {tasks.length}
            </span>
          )}
        </span>
        <span className="text-neutral-600">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-2 pb-2 max-h-48 overflow-y-auto custom-scrollbar space-y-1">
          {loading && tasks.length === 0 && (
            <div className="text-[10px] text-neutral-500 px-1 py-2">Loading…</div>
          )}
          {error && (
            <div className="text-[10px] text-red-400/90 px-1 py-1">{error}</div>
          )}
          {!loading && tasks.length === 0 && !error && (
            <div className="text-[10px] text-neutral-500 px-1 py-2">Nothing scheduled</div>
          )}
          {tasks.map((t) => (
            <div
              key={t.id}
              className="group relative rounded-lg bg-black border border-neutral-800 px-2 py-1.5 text-[10px]"
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-[9px] uppercase tracking-wide text-neutral-500 shrink-0">
                  {INTENT_LABEL[t.intent] || t.intent}
                </span>
                <button
                  type="button"
                  onClick={(e) => handleCancel(e, t.id)}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-neutral-500 hover:text-red-400 transition-all"
                  title="Cancel"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="text-neutral-300 mt-0.5 line-clamp-2">{t.title || t.text}</div>
              <div className="text-neutral-500 mt-0.5">{formatRunAt(t.run_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

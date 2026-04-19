import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, RefreshCw, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { fetchPeerQueryHistory, clearPeerQueryHistory } from '../services/chatApi';

/**
 * Full-height scrollable list of inbound/outbound peer queries (connectivity).
 */
export function PeerQueryHistoryPanel({ className = '' }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchPeerQueryHistory(100, 0);
      setEvents(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to load peer query history:', err);
      setError(err.message || String(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleClear = async () => {
    if (!window.confirm('Clear all peer query history on this device?')) {
      return;
    }
    try {
      await clearPeerQueryHistory();
      setEvents([]);
      setExpandedId(null);
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
    }
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${className}`}>
      <div className="mb-3 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-neutral-900/80">
            <MessageSquare className="h-4 w-4 text-neutral-300" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">Peer query history</h2>
            <p className="text-[11px] text-neutral-500">
              Inbound runs on this device; outbound from this app or the agent tool.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            onClick={() => load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden />
            Refresh
          </motion.button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            onClick={handleClear}
            disabled={loading || events.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-neutral-900/60 px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:border-red-500/35 hover:bg-red-950/35 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Trash2 size={14} aria-hidden />
            Clear
          </motion.button>
        </div>
      </div>

      {error ? <p className="mb-2 text-xs text-red-300/95">{error}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar pr-1">
        {loading && events.length === 0 ? (
          <div className="flex items-center gap-2 py-8 text-xs text-neutral-500">
            <RefreshCw size={14} className="animate-spin" aria-hidden />
            Loading…
          </div>
        ) : null}

        {!loading && !error && events.length === 0 ? (
          <div className="rounded-xl border border-dashed border-neutral-700/70 bg-neutral-900/25 px-4 py-10 text-center text-xs text-neutral-500">
            No peer queries recorded yet.
          </div>
        ) : null}

        {events.length > 0 ? (
          <ul className="space-y-2 pb-4">
            {events.map((ev) => {
              const expanded = expandedId === ev.id;
              const dirIn = ev.direction === 'inbound';
              const ok = ev.status === 'ok';
              let timeLabel = '—';
              try {
                if (ev.created_at) {
                  timeLabel = new Date(ev.created_at).toLocaleString();
                }
              } catch {
                /* ignore */
              }
              const name = (ev.friend_name && String(ev.friend_name).trim()) || 'Unknown peer';
              const previewLine =
                (ev.query_text || '').split('\n')[0].slice(0, 120) + ((ev.query_text || '').length > 120 ? '…' : '');
              return (
                <li key={ev.id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : ev.id)}
                    className="w-full rounded-xl border border-white/10 bg-neutral-900/35 text-left transition-colors hover:bg-neutral-900/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/15"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3 p-3 sm:p-3.5">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              dirIn
                                ? 'border-sky-500/30 bg-sky-950/40 text-sky-200/95'
                                : 'border-violet-500/30 bg-violet-950/40 text-violet-200/95'
                            }`}
                          >
                            {dirIn ? 'Inbound' : 'Outbound'}
                          </span>
                          <span
                            className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                              ok
                                ? 'border-emerald-500/25 bg-emerald-950/35 text-emerald-200/90'
                                : 'border-red-500/25 bg-red-950/35 text-red-200/85'
                            }`}
                          >
                            {ok ? 'ok' : 'error'}
                          </span>
                          <span className="truncate text-xs font-medium text-white" title={name}>
                            {name}
                          </span>
                        </div>
                        <p className="text-[11px] leading-snug text-neutral-400 line-clamp-2">{previewLine || '(empty)'}</p>
                        <p className="text-[10px] text-neutral-600">{timeLabel}</p>
                      </div>
                      <span className="shrink-0 pt-0.5 text-neutral-500" aria-hidden>
                        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                    </div>
                    {expanded ? (
                      <div className="border-t border-white/[0.06] bg-neutral-950/50 px-3 py-3 sm:px-4 space-y-3 text-left">
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Query</div>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-neutral-200">
                            {ev.query_text || '(empty)'}
                          </pre>
                        </div>
                        {ev.response_preview ? (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                              Response preview
                            </div>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-neutral-200">
                              {ev.response_preview}
                            </pre>
                          </div>
                        ) : null}
                        {ev.error_detail ? (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">Error</div>
                            <p className="mt-1 text-[11px] leading-relaxed text-red-200/95">{ev.error_detail}</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Activity, RefreshCw, Copy, Check, Trash2, Database, AlertCircle } from 'lucide-react';
import { getLogs, vacuumCheckpointDb } from '../../../services/chatApi';

export function DiagnosticsTab({ settings, onUpdateSetting }) {
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const [vacuumStats, setVacuumStats] = useState(null);
  const [vacuuming, setVacuuming] = useState(false);

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const data = await getLogs(300);
      setLogs(typeof data === 'string' ? data : (data?.logs || JSON.stringify(data, null, 2)));
    } catch (e) {
      setLogs(`Failed to fetch logs: ${e.message}`);
    } finally {
      setLoadingLogs(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const handleCopy = () => {
    if (!logs) return;
    navigator.clipboard.writeText(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleVacuum = async () => {
    setVacuuming(true);
    try {
      const res = await vacuumCheckpointDb();
      setVacuumStats(res);
    } catch (e) {
      setVacuumStats({ error: e.message });
    } finally {
      setVacuuming(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* DB MAINTENANCE */}
      <div className="rounded-xl border border-white/[0.06] bg-neutral-900/40 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Database & Checkpoints Storage</h3>
            <p className="text-xs text-neutral-500">Reclaim disk space by vacuuming the SQLite checkpoint database</p>
          </div>
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={handleVacuum}
            disabled={vacuuming}
            className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-60 cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${vacuuming ? 'animate-spin' : ''}`} />
            {vacuuming ? 'Vacuuming...' : 'Vacuum Checkpoints DB'}
          </motion.button>
        </div>

        {vacuumStats && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-3 text-xs text-neutral-300 space-y-1">
            {vacuumStats.error ? (
              <span className="text-red-400">{vacuumStats.error}</span>
            ) : (
              <div className="flex gap-4">
                <span>Before: <strong className="text-white">{vacuumStats.size_before_mb || 0} MB</strong></span>
                <span>After: <strong className="text-white">{vacuumStats.size_after_mb || 0} MB</strong></span>
                <span>Freed: <strong className="text-emerald-400">{vacuumStats.freed_mb || 0} MB</strong></span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* LOGS VIEWER */}
      <div className="rounded-xl border border-white/[0.06] bg-neutral-900/40 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Application Logs</h3>
            <p className="text-xs text-neutral-500">Real-time backend diagnostics and runtime logs</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-700 cursor-pointer"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={fetchLogs}
              disabled={loadingLogs}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-700 cursor-pointer"
            >
              <RefreshCw className={`h-3 w-3 ${loadingLogs ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="h-96 w-full overflow-auto rounded-xl border border-neutral-800 bg-neutral-950 p-4 font-mono text-[11px] text-neutral-300 whitespace-pre-wrap select-text custom-scrollbar leading-relaxed">
          {logs || 'No logs recorded.'}
        </div>
      </div>
    </div>
  );
}

export default DiagnosticsTab;

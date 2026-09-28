import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  AppWindow,
  Clock,
  Clipboard,
  Globe,
  Code2,
  Terminal,
  Shield,
  Brain,
  Sparkles,
  RefreshCw,
  Check,
  ExternalLink,
  Copy,
  Lock,
  X,
  Zap,
  FolderOpen,
  Trash2,
  Download,
} from 'lucide-react';
import {
  getWorkstreamConfig,
  updateWorkstreamConfig,
  getWorkstreamSensorsStatus,
  triggerWorkstreamAggregation,
  getWorkstreamPluginsStatus,
  installIdePlugin,
  uninstallIdePlugin,
  installTerminalPlugin,
  uninstallTerminalPlugin,
  openBrowserPluginFolder,
} from '../../services/chatApi';

let invokeTauri = null;
try {
  import('@tauri-apps/api/core').then((mod) => {
    invokeTauri = mod.invoke;
  }).catch(() => {});
} catch (e) {}

export default function WorkstreamSettingsSection() {
  const [config, setConfig] = useState(null);
  const [sensorStatus, setSensorStatus] = useState(null);
  const [pluginStatus, setPluginStatus] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isAggregating, setIsAggregating] = useState(false);
  const [aggregationMessage, setAggregationMessage] = useState(null);
  const [installingPlugin, setInstallingPlugin] = useState(null); // 'ide' | 'terminal' | 'browser' | null
  const [pluginNotice, setPluginNotice] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);
  const [showHelpModal, setShowHelpModal] = useState(null); // 'browser' | 'ide' | 'terminal' | null
  const pollIntervalRef = useRef(null);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const [cfg, status, pStatus] = await Promise.all([
        getWorkstreamConfig(),
        getWorkstreamSensorsStatus(),
        getWorkstreamPluginsStatus(),
      ]);
      setConfig(cfg);
      setSensorStatus(status);
      setPluginStatus(pStatus);
    } catch (err) {
      console.warn('[ActivitySensors] Error loading settings:', err);
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    pollIntervalRef.current = setInterval(() => {
      loadData(true);
    }, 4000);

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [loadData]);

  const handleConfigUpdate = async (updater) => {
    if (!config) return;
    const newConfig = typeof updater === 'function' ? updater(config) : updater;
    setConfig(newConfig);
    setIsSaving(true);

    try {
      const res = await updateWorkstreamConfig(newConfig);
      if (res?.config) {
        setConfig(res.config);
      }

      if (invokeTauri) {
        try {
          await invokeTauri('update_workstream_sensor_config', { config: newConfig });
        } catch (tauriErr) {
          console.debug('[ActivitySensors] Tauri config sync:', tauriErr);
        }
      }

      const updatedStatus = await getWorkstreamSensorsStatus();
      setSensorStatus(updatedStatus);
    } catch (err) {
      console.error('[ActivitySensors] Failed to update config:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // --- Auto-Inject Plugin Actions ---
  const handleInstallIde = async () => {
    setInstallingPlugin('ide');
    setPluginNotice(null);
    try {
      const res = await installIdePlugin();
      setPluginNotice(res.message || 'Auto-injected into IDE!');
      await loadData(true);
    } catch (err) {
      setPluginNotice(`IDE install failed: ${err.message}`);
    } finally {
      setInstallingPlugin(null);
      setTimeout(() => setPluginNotice(null), 5000);
    }
  };

  const handleUninstallIde = async () => {
    if (!window.confirm('Remove Rie companion from VS Code / Antigravity?')) return;
    setInstallingPlugin('ide');
    try {
      await uninstallIdePlugin();
      setPluginNotice('Removed IDE companion extension.');
      await loadData(true);
    } catch (err) {
      alert(`Uninstall failed: ${err.message}`);
    } finally {
      setInstallingPlugin(null);
      setTimeout(() => setPluginNotice(null), 4000);
    }
  };

  const handleInstallTerminal = async () => {
    setInstallingPlugin('terminal');
    setPluginNotice(null);
    try {
      const res = await installTerminalPlugin();
      setPluginNotice(res.message || 'Hooks injected into PowerShell & Git Bash!');
      await loadData(true);
    } catch (err) {
      setPluginNotice(`Terminal inject failed: ${err.message}`);
    } finally {
      setInstallingPlugin(null);
      setTimeout(() => setPluginNotice(null), 5000);
    }
  };

  const handleUninstallTerminal = async () => {
    if (!window.confirm('Remove Rie shell hooks from PowerShell profile & Git Bash?')) return;
    setInstallingPlugin('terminal');
    try {
      await uninstallTerminalPlugin();
      setPluginNotice('Removed terminal hooks.');
      await loadData(true);
    } catch (err) {
      alert(`Uninstall failed: ${err.message}`);
    } finally {
      setInstallingPlugin(null);
      setTimeout(() => setPluginNotice(null), 4000);
    }
  };

  const handleOpenBrowserFolder = async () => {
    try {
      await openBrowserPluginFolder();
      setShowHelpModal('browser');
    } catch (err) {
      setShowHelpModal('browser');
    }
  };

  const handleCopy = (text, key) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleManualAggregate = async () => {
    setIsAggregating(true);
    setAggregationMessage(null);
    try {
      const res = await triggerWorkstreamAggregation('today', true);
      const count = res?.count || 0;
      setAggregationMessage(`Aggregated ${count} session(s) successfully!`);
      loadData(true);
    } catch (err) {
      setAggregationMessage(`Aggregation failed: ${err.message}`);
    } finally {
      setIsAggregating(false);
      setTimeout(() => setAggregationMessage(null), 5000);
    }
  };

  if (isLoading && !config) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-neutral-400 space-y-3">
        <RefreshCw className="w-5 h-5 animate-spin text-emerald-400" />
        <span className="text-xs font-medium">Loading activity sensors...</span>
      </div>
    );
  }

  const isMasterOn = config?.workstream !== false;
  const sensors = config?.sensors || {};
  const privacy = config?.privacy || {};
  const memory = config?.memory || {};

  const activeSensorsCount = [
    sensors.windows !== false,
    sensors.idle !== false,
    sensors.clipboard === true,
    sensors.browser !== false,
    sensors.ide !== false,
    sensors.terminal !== false,
  ].filter(Boolean).length;

  return (
    <div className="space-y-5 text-neutral-200 animate-in fade-in duration-200">
      {/* 1. Master Switch Card */}
      <div className="p-4 rounded-xl bg-neutral-900/40 border border-white/5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <Activity className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-white">Activity Awareness</h4>
              <span className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full ${
                isMasterOn
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-neutral-800 text-neutral-400 border border-neutral-700'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isMasterOn ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-500'}`} />
                {isMasterOn ? 'Active & Collecting' : 'Disabled'}
              </span>
              {isSaving && (
                <span className="text-[10px] text-emerald-400 animate-pulse font-medium">Syncing...</span>
              )}
            </div>
            <p className="text-xs text-neutral-400 mt-0.5 leading-normal">
              Allows Rie to passively understand your open apps, code changes, and research context to build continuous working memory.
            </p>
          </div>
        </div>

        <div className="shrink-0">
          <ToggleSwitch
            checked={isMasterOn}
            onChange={(checked) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                workstream: checked,
              }));
            }}
          />
        </div>
      </div>

      {/* Plugin notification toast */}
      {pluginNotice && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-2.5 px-3 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between"
        >
          <span>{pluginNotice}</span>
          <button onClick={() => setPluginNotice(null)} className="text-emerald-400 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}

      {/* 2. Sensors List */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-semibold tracking-wider text-neutral-400 uppercase">
            Sensors
          </h3>
          <span className="text-xs text-neutral-500">
            {activeSensorsCount} of 6 active
          </span>
        </div>

        <div className="rounded-xl border border-white/5 bg-neutral-900/30 divide-y divide-white/5 overflow-hidden">
          {/* Windows Apps & Focus */}
          <SensorRow
            icon={<AppWindow className="w-4 h-4 text-sky-400" />}
            iconBg="bg-sky-500/10"
            title="Windows Apps & Focus"
            description="Detects active application switches and time spent in each window."
            enabled={sensors.windows !== false}
            masterEnabled={isMasterOn}
            status={sensorStatus?.sensors?.windows}
            onChange={(val) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                sensors: { ...prev.sensors, windows: val },
              }));
            }}
          />

          {/* Idle Detection */}
          <SensorRow
            icon={<Clock className="w-4 h-4 text-amber-400" />}
            iconBg="bg-amber-500/10"
            title="Idle Detection"
            description="Detects user inactivity (>2 min) to split activity into coherent work sessions."
            enabled={sensors.idle !== false}
            masterEnabled={isMasterOn}
            status={sensorStatus?.sensors?.idle}
            onChange={(val) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                sensors: { ...prev.sensors, idle: val },
              }));
            }}
          />

          {/* Clipboard Activity */}
          <SensorRow
            icon={<Clipboard className="w-4 h-4 text-purple-400" />}
            iconBg="bg-purple-500/10"
            title="Clipboard Activity"
            badge="OFF by default"
            badgeColor="bg-purple-500/10 text-purple-300 border-purple-500/20"
            description="Captures copied text context. Sensitive apps & passwords are automatically masked."
            enabled={sensors.clipboard === true}
            masterEnabled={isMasterOn}
            status={sensorStatus?.sensors?.clipboard}
            onChange={(val) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                sensors: { ...prev.sensors, clipboard: val },
              }));
            }}
          />

          {/* Browser Activity */}
          <SensorRow
            icon={<Globe className="w-4 h-4 text-teal-400" />}
            iconBg="bg-teal-500/10"
            title="Browser Activity"
            description="Captures active tabs and research context across Brave, Chrome, and Edge."
            detectedText={sensorStatus?.sensors?.browser?.detected_browsers?.join(', ')}
            enabled={sensors.browser !== false}
            masterEnabled={isMasterOn}
            status={sensorStatus?.sensors?.browser}
            pluginAction={{
              label: 'Load Extension',
              icon: <FolderOpen className="w-3 h-3 text-teal-400" />,
              onClick: handleOpenBrowserFolder,
            }}
            onChange={(val) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                sensors: { ...prev.sensors, browser: val },
              }));
            }}
          />

          {/* IDE Activity */}
          <SensorRow
            icon={<Code2 className="w-4 h-4 text-blue-400" />}
            iconBg="bg-blue-500/10"
            title="IDE Activity"
            description="Streams active workspace files and code edits from VS Code and Antigravity."
            detectedText={sensorStatus?.sensors?.ide?.detected_ides?.join(', ')}
            enabled={sensors.ide !== false}
            masterEnabled={isMasterOn}
            status={sensorStatus?.sensors?.ide}
            pluginAction={
              pluginStatus?.ide?.installed
                ? {
                    isInstalled: true,
                    installedBadge: `Injected (${(pluginStatus.ide.installed_editors || ['VS Code']).join(', ')})`,
                    onReinstall: handleInstallIde,
                    onUninstall: handleUninstallIde,
                    loading: installingPlugin === 'ide',
                  }
                : {
                    label: '⚡ Auto-Inject',
                    onClick: handleInstallIde,
                    loading: installingPlugin === 'ide',
                    highlight: true,
                  }
            }
            onChange={(val) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                sensors: { ...prev.sensors, ide: val },
              }));
            }}
          />

          {/* Terminal Activity */}
          <SensorRow
            icon={<Terminal className="w-4 h-4 text-rose-400" />}
            iconBg="bg-rose-500/10"
            title="Terminal Activity"
            description="Captures executed commands, working directories, and execution exit codes."
            detectedText={sensorStatus?.sensors?.terminal?.detected_shells?.join(', ')}
            enabled={sensors.terminal !== false}
            masterEnabled={isMasterOn}
            status={sensorStatus?.sensors?.terminal}
            pluginAction={
              pluginStatus?.terminal?.installed
                ? {
                    isInstalled: true,
                    installedBadge: 'Hooks Injected',
                    onReinstall: handleInstallTerminal,
                    onUninstall: handleUninstallTerminal,
                    loading: installingPlugin === 'terminal',
                  }
                : {
                    label: '⚡ Inject Hooks',
                    onClick: handleInstallTerminal,
                    loading: installingPlugin === 'terminal',
                    highlight: true,
                  }
            }
            onChange={(val) => {
              handleConfigUpdate((prev) => ({
                ...prev,
                sensors: { ...prev.sensors, terminal: val },
              }));
            }}
          />
        </div>
      </div>

      {/* 3. Privacy Safeguards */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 px-1">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <h3 className="text-xs font-semibold tracking-wider text-neutral-400 uppercase">
            Privacy Safeguards
          </h3>
        </div>

        <div className="rounded-xl border border-white/5 bg-neutral-900/30 divide-y divide-white/5 overflow-hidden">
          {/* Track Clipboard Content */}
          <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-neutral-200">Track Clipboard Content</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 font-medium">
                  OFF by default
                </span>
              </div>
              <p className="text-[11px] text-neutral-400 mt-0.5 leading-normal">
                Stores actual copied text. When OFF, only application names and hashes are saved to prevent exposing tokens.
              </p>
            </div>
            <div className="shrink-0">
              <ToggleSwitch
                checked={privacy.track_clipboard_content === true}
                disabled={!isMasterOn}
                onChange={(val) => {
                  handleConfigUpdate((prev) => ({
                    ...prev,
                    privacy: { ...prev.privacy, track_clipboard_content: val },
                  }));
                }}
              />
            </div>
          </div>

          {/* Track File Changes */}
          <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
            <div className="min-w-0">
              <span className="text-xs font-semibold text-neutral-200">Track File Diffs & Changes</span>
              <p className="text-[11px] text-neutral-400 mt-0.5 leading-normal">
                Records file save events and lines modified count in IDE editors.
              </p>
            </div>
            <div className="shrink-0">
              <ToggleSwitch
                checked={privacy.track_file_changes !== false}
                disabled={!isMasterOn}
                onChange={(val) => {
                  handleConfigUpdate((prev) => ({
                    ...prev,
                    privacy: { ...prev.privacy, track_file_changes: val },
                  }));
                }}
              />
            </div>
          </div>

          {/* Track Web URLs */}
          <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
            <div className="min-w-0">
              <span className="text-xs font-semibold text-neutral-200">Track Visited URLs</span>
              <p className="text-[11px] text-neutral-400 mt-0.5 leading-normal">
                Records full URLs in browser telemetry. When OFF, only page titles are recorded.
              </p>
            </div>
            <div className="shrink-0">
              <ToggleSwitch
                checked={privacy.track_urls !== false}
                disabled={!isMasterOn}
                onChange={(val) => {
                  handleConfigUpdate((prev) => ({
                    ...prev,
                    privacy: { ...prev.privacy, track_urls: val },
                  }));
                }}
              />
            </div>
          </div>

          {/* Sensitive Apps Always Blocked */}
          <div className="p-3.5 px-4 bg-neutral-950/40 flex items-start gap-3">
            <div className="p-1 rounded bg-rose-500/10 text-rose-400 shrink-0 mt-0.5">
              <Lock className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-neutral-200">Sensitive Apps Shield</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20 font-medium">
                  Always Blocked
                </span>
              </div>
              <p className="text-[11px] text-neutral-400 leading-normal">
                Password managers, authenticators, and banking tools are automatically filtered out before recording:
              </p>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {(privacy.exclude_apps || ['1password', 'bitwarden', 'keepass', 'lastpass', 'credential', 'banking', 'wallet', 'secret']).map((item) => (
                  <span
                    key={item}
                    className="px-2 py-0.5 text-[10px] rounded bg-white/5 text-neutral-300 border border-white/5"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Memory Pipelines */}
      <div className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5 text-indigo-400" />
            <h3 className="text-xs font-semibold tracking-wider text-neutral-400 uppercase">
              Memory Pipelines
            </h3>
          </div>
          {aggregationMessage && (
            <span className="text-xs text-emerald-400 animate-in fade-in duration-150">
              {aggregationMessage}
            </span>
          )}
        </div>

        <div className="rounded-xl border border-white/5 bg-neutral-900/30 divide-y divide-white/5 overflow-hidden">
          {/* Session Aggregation */}
          <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-neutral-200">Session Aggregation</span>
                {sensorStatus?.memory?.sessions?.total_sessions > 0 && (
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-medium">
                    {sensorStatus.memory.sessions.total_sessions} sessions synthesized
                  </span>
                )}
              </div>
              <p className="text-[11px] text-neutral-400 mt-0.5 leading-normal">
                Clusters granular raw activity events into coherent work blocks using idle thresholds.
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={handleManualAggregate}
                disabled={isAggregating || !isMasterOn}
                className="px-2.5 py-1 text-xs font-medium rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors border border-white/10 disabled:opacity-40"
              >
                {isAggregating ? 'Synthesizing...' : 'Aggregate Now'}
              </button>
              <ToggleSwitch
                checked={memory.sessions !== false}
                disabled={!isMasterOn}
                onChange={(val) => {
                  handleConfigUpdate((prev) => ({
                    ...prev,
                    memory: { ...prev.memory, sessions: val },
                  }));
                }}
              />
            </div>
          </div>

          {/* Semantic Summaries */}
          <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
            <div className="min-w-0">
              <span className="text-xs font-semibold text-neutral-200">Semantic Summaries</span>
              <p className="text-[11px] text-neutral-400 mt-0.5 leading-normal">
                Generates high-level narrative summaries and task topics using background reasoning.
              </p>
            </div>
            <div className="shrink-0">
              <ToggleSwitch
                checked={memory.semantic !== false}
                disabled={!isMasterOn}
                onChange={(val) => {
                  handleConfigUpdate((prev) => ({
                    ...prev,
                    memory: { ...prev.memory, semantic: val },
                  }));
                }}
              />
            </div>
          </div>

          {/* Long-Term Memory (Chroma) */}
          <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
            <div className="min-w-0">
              <span className="text-xs font-semibold text-neutral-200">Vector Storage (Chroma)</span>
              <p className="text-[11px] text-neutral-400 mt-0.5 leading-normal">
                Indexes aggregated work sessions into local vector database for instant semantic recall in chat.
              </p>
            </div>
            <div className="shrink-0">
              <ToggleSwitch
                checked={memory.ltm !== false}
                disabled={!isMasterOn}
                onChange={(val) => {
                  handleConfigUpdate((prev) => ({
                    ...prev,
                    memory: { ...prev.memory, ltm: val },
                  }));
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 5. Browser Assisted Loading Modal */}
      <AnimatePresence>
        {showHelpModal === 'browser' && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl p-5 shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-teal-400" />
                  <h4 className="text-sm font-semibold text-white">Browser Extension (1-Time Setup)</h4>
                </div>
                <button
                  onClick={() => setShowHelpModal(null)}
                  className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-neutral-400 leading-relaxed">
                Chromium browsers require a one-time approval to load local extensions. We've opened the extension folder on your desktop:
              </p>

              <ol className="text-xs text-neutral-300 space-y-2 list-decimal list-inside bg-neutral-950/60 p-3.5 rounded-lg border border-neutral-800 font-mono">
                <li>Open your browser to <code className="text-teal-300">brave://extensions</code> or <code className="text-teal-300">chrome://extensions</code></li>
                <li>Turn ON <strong>Developer mode</strong> (toggle in top-right corner).</li>
                <li>Click <strong>Load unpacked</strong>.</li>
                <li>Select the opened extension folder:</li>
              </ol>

              <div className="flex items-center justify-between gap-2 p-2.5 bg-neutral-950 rounded-lg border border-neutral-800 text-xs font-mono text-neutral-300">
                <span className="truncate">{pluginStatus?.browser?.path || 'app/extensions/browser'}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleOpenBrowserFolder}
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 text-xs border border-teal-500/30 transition-colors"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Open Folder</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopy(pluginStatus?.browser?.path || 'app/extensions/browser', 'browser_ext')}
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs transition-colors"
                  >
                    {copiedKey === 'browser_ext' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedKey === 'browser_ext' ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Compact, macOS-style Sensor Row Component with Plugin Actions
function SensorRow({
  icon,
  iconBg = 'bg-neutral-800',
  title,
  badge,
  badgeColor,
  description,
  enabled,
  masterEnabled,
  status,
  detectedText,
  pluginAction,
  onChange,
}) {
  const isEffectivelyActive = masterEnabled && enabled;
  const rawStatus = status?.status || (isEffectivelyActive ? 'idle' : 'disabled');

  let statusLabel = 'Disabled';
  let statusBadgeStyle = 'bg-white/5 text-neutral-500 border-white/5';
  let dotColor = 'bg-neutral-500';

  if (!masterEnabled || !enabled) {
    statusLabel = 'Disabled';
    statusBadgeStyle = 'bg-white/5 text-neutral-500 border-white/5';
    dotColor = 'bg-neutral-500';
  } else if (rawStatus === 'connected' || rawStatus === 'active') {
    statusLabel = 'Connected';
    statusBadgeStyle = 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    dotColor = 'bg-emerald-400 animate-pulse';
  } else if (rawStatus === 'idle') {
    statusLabel = 'Active (Idle)';
    statusBadgeStyle = 'bg-neutral-800 text-neutral-400 border-neutral-700/60';
    dotColor = 'bg-neutral-400';
  } else {
    statusLabel = 'Not Connected';
    statusBadgeStyle = 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    dotColor = 'bg-amber-400';
  }

  return (
    <div className="flex items-center justify-between p-3.5 px-4 hover:bg-white/[0.015] transition-colors gap-4">
      {/* Left Column: Icon + Text */}
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-8 h-8 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>
          {icon}
        </div>

        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-neutral-200">{title}</span>

            {/* Live status badge */}
            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusBadgeStyle}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
              {statusLabel}
            </span>

            {/* Plugin Injected Badge if applicable */}
            {pluginAction?.isInstalled && pluginAction.installedBadge && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Check className="w-2.5 h-2.5" />
                {pluginAction.installedBadge}
              </span>
            )}

            {/* Extra badge if present (e.g. OFF by default) */}
            {badge && (
              <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.2 rounded border ${badgeColor}`}>
                {badge}
              </span>
            )}

            {/* Detected apps/shells */}
            {detectedText && (
              <span className="text-[10px] text-neutral-500 truncate max-w-[140px]">
                ({detectedText})
              </span>
            )}
          </div>

          <p className="text-[11px] text-neutral-400 leading-normal line-clamp-1">
            {description}
          </p>
        </div>
      </div>

      {/* Right Column: Plugin Action Button + Toggle */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* On-Demand Auto-Inject or Load Button */}
        {pluginAction && (
          <>
            {pluginAction.isInstalled ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title="Reinstall / Update companion"
                  onClick={pluginAction.onReinstall}
                  disabled={pluginAction.loading}
                  className="text-[10px] text-neutral-400 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors flex items-center gap-1"
                >
                  <RefreshCw className={`w-3 h-3 ${pluginAction.loading ? 'animate-spin text-emerald-400' : ''}`} />
                  <span>Update</span>
                </button>
                <button
                  type="button"
                  title="Remove companion"
                  onClick={pluginAction.onUninstall}
                  disabled={pluginAction.loading}
                  className="text-[10px] text-neutral-500 hover:text-rose-400 px-1 py-0.5 rounded hover:bg-rose-500/10 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={pluginAction.onClick}
                disabled={pluginAction.loading}
                className={`text-xs font-semibold px-2.5 py-1 rounded-lg transition-all flex items-center gap-1.5 ${
                  pluginAction.highlight
                    ? 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 shadow-sm shadow-emerald-950/20'
                    : 'bg-white/5 hover:bg-white/10 text-neutral-300 border border-white/10'
                }`}
              >
                {pluginAction.loading ? (
                  <RefreshCw className="w-3 h-3 animate-spin text-emerald-400" />
                ) : (
                  pluginAction.icon || <Zap className="w-3 h-3 text-emerald-400" />
                )}
                <span>{pluginAction.loading ? 'Injecting...' : pluginAction.label}</span>
              </button>
            )}
          </>
        )}

        <ToggleSwitch
          checked={enabled}
          disabled={!masterEnabled}
          onChange={onChange}
        />
      </div>
    </div>
  );
}

// Toggle Switch Primitive
function ToggleSwitch({ checked, disabled = false, onChange }) {
  return (
    <label className={`relative inline-flex items-center ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <div className="w-9 h-5 bg-neutral-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500" />
    </label>
  );
}

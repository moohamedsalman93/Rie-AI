import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getVersion } from '@tauri-apps/api/app';
import { getSettings, updateSetting, getLogs, getMcpStatus, getOllamaModels, getRieUsage, downloadEmbeddingModel } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import {
  MessageSquare,
  Cpu,
  Wrench,
  Plug2,
  Settings,
  FileText,
  Search,
  Shield,
  Globe,
  Mic,
  Rocket,
  RefreshCw,
  Trash2,
  Plus,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Cloud,
  Zap,
  Activity,
  X,
  Pencil,
  Info,
  Volume2,
  Copy,
  Check,
  Link,
  ExternalLink
} from 'lucide-react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { listen } from '@tauri-apps/api/event';

const PROVIDERS = {
  gemini: { label: "Google Gemini", icon: <Sparkles className="w-5 h-5" /> },
  vertex: { label: "Vertex AI", icon: <Cloud className="w-5 h-5" /> },
  groq: { label: "Groq", icon: <Zap className="w-5 h-5" /> },
  openai: { label: "OpenAI", icon: <Globe className="w-5 h-5" /> },
  rie: { label: "Rie", icon: <Sparkles className="w-5 h-5 " /> },
  ollama: { label: "Ollama", icon: <Cpu className="w-5 h-5" /> }
};

const AVAILABLE_TOOLS = [
  { id: "internet_search", label: "Internet Search", desc: "Allows searching the web for information." },
  { id: "run_terminal_command", label: "System Terminal", desc: "Execute commands on the Windows system." },
  { id: "get_desktop_state", label: "Desktop State", desc: "Captures current desktop state and interactive elements." },
  { id: "app_control", label: "App Control", desc: "Launch, resize, or switch Windows applications." },
  { id: "mouse_click", label: "Mouse Click", desc: "Performs a mouse click at specific coordinates." },
  { id: "keyboard_type", label: "Keyboard Type", desc: "Types text at specific coordinates." },
  { id: "move_mouse", label: "Move Mouse", desc: "Moves the mouse cursor to specific coordinates." },
  { id: "scroll_mouse", label: "Scroll Mouse", desc: "Scrolls vertically or horizontally." },
  { id: "drag_mouse", label: "Drag Mouse", desc: "Drags from current position to target coordinates." },
  { id: "press_keys", label: "Press Keys", desc: "Presses keyboard shortcuts or keys." },
  { id: "scrape_web", label: "Scrape Web", desc: "Scrapes content from a URL or active browser tab." },
  { id: "wait", label: "Wait", desc: "Pauses execution for a specified duration." }
];

export function SettingsPage({ onClose }) {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('provider'); // 'provider', 'tools', 'general', 'logs'
  const [savingKey, setSavingKey] = useState(null);
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef(null);

  // Local state for edits
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [enabledTools, setEnabledTools] = useState([]);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  // Rie Auth State
  // Rie Auth State
  const [rieToken, setRieToken] = useState(null);
  const [rieUsage, setRieUsage] = useState(null);
  const [rieLoading, setRieLoading] = useState(false);
  const [rieAuthMode, setRieAuthMode] = useState('signin'); // 'signin' or 'signup'
  const [rieEmail, setRieEmail] = useState('');
  const [riePassword, setRiePassword] = useState('');
  const [rieError, setRieError] = useState(null);
  const [isRieLoginModalOpen, setIsRieLoginModalOpen] = useState(false);

  // Embedding model download
  const [embeddingDownloadProgress, setEmbeddingDownloadProgress] = useState(null);
  const [embeddingDownloading, setEmbeddingDownloading] = useState(false);
  const [embeddingDownloadError, setEmbeddingDownloadError] = useState(null);

  useEffect(() => {
    loadSettings();
    // fetchRieUsage is now called inside loadSettings once token is retrieved
    getVersion().then(v => setAppVersion(v)).catch(() => setAppVersion('0.1.7'));
  }, []);

  // Listen for deep links to update UI immediately
  useEffect(() => {
    let unlistenPromise;
    const setupListener = async () => {
      unlistenPromise = listen("deep-link", (event) => {
        const urlString = event.payload;
        if (urlString.includes("auth")) {
          try {
            const url = new URL(urlString);
            const token = url.searchParams.get("token");
            if (token) {
              // App.jsx also handles this, but we force a reload here
              setTimeout(() => {
                loadSettings();
              }, 500); // Small delay to allow App.jsx/Backend to process
            }
          } catch (e) {
            console.error("SettingsPage: Failed to parse deep link URL:", e);
          }
        }
      });
    };
    setupListener();
    return () => {
      if (unlistenPromise) {
        unlistenPromise.then(unlisten => unlisten());
      }
    };
  }, []);

  // No longer needed to pass token, usage fetch uses backend stored token
  const fetchRieUsage = async () => {
    try {
      const data = await getRieUsage();
      setRieUsage(data);
      // If we successfully got usage, we are authenticated
      if (!rieToken) setRieToken("authenticated");
    } catch (err) {
      if (err.message === 'Session expired') {
        handleRieSignOut();
      }
      console.error("Failed to fetch Rie usage:", err);
    }
  };

  const handleRieSignOut = async () => {
    // Clear token from backend settings
    await updateSetting('RIE_ACCESS_TOKEN', '');
    setRieToken(null);
    setRieUsage(null);
    await loadSettings();
  };

  useEffect(() => {
    loadSettings();
  }, []);

  // fetchRieUsage is called inside loadSettings if a token (masked) exists
  // But since we changed logic, we need to adapt loadSettings too.

  useEffect(() => {
    if (activeTab === 'logs') {
      fetchLogs();
    }
  }, [activeTab]);

  const fetchLogs = async () => {
    try {
      setLoadingLogs(true);
      const data = await getLogs();
      // Extract the logs string from the response object
      const logsText = data?.logs || "";
      setLogs(logsText);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
      setLogs("Error fetching logs: " + err.message);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handleCopyLogs = () => {
    if (!logs || typeof logs !== 'string') return;
    navigator.clipboard.writeText(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderLogLine = (line, index) => {
    if (!line || typeof line !== 'string') return null;
    if (!line.trim()) return <div key={index} className="h-4" />;

    // Detect startup markers for separation
    const isStartup =
      line.includes("Backend starting") ||
      line.includes("Started server process") ||
      line.includes("Application startup complete") ||
      line.includes("uvicorn running on");

    // Simple parser for log parts
    // Expected format: 2026-01-20 15:47:37,248 - app.agent - ERROR - ...
    const parts = line.split(' - ');

    // Check if it's a standard log line
    const isStandardLog = line.match(/^\d{4}-\d{2}-\d{2}/);

    const logContent = (() => {
      if (isStandardLog && parts.length >= 3) {
        const timestamp = parts[0];
        const source = parts[1];
        const level = parts[2];
        const message = parts.slice(3).join(' - ');

        const getLevelColor = (lvl) => {
          const l = lvl.toUpperCase();
          if (l.includes('ERROR')) return 'text-red-400';
          if (l.includes('WARNING')) return 'text-amber-400';
          if (l.includes('INFO')) return 'text-emerald-400';
          if (l.includes('DEBUG')) return 'text-blue-400';
          return 'text-neutral-400';
        };

        return (
          <div className="group grid grid-cols-[30%_1fr] gap-4 hover:bg-neutral-900/50 -mx-4 px-4 py-1.5 transition-colors items-start">
            <div className="flex items-center gap-3 shrink-0 overflow-hidden">
              <span className="text-neutral-600 select-none font-mono text-[10px] w-[140px] shrink-0">{timestamp}</span>
              <span className="text-neutral-500 w-[100px] truncate shrink-0" title={source}>{source}</span>
              <span className={`w-16 font-bold text-center rounded text-[9px] py-0.5 border shrink-0 ${getLevelColor(level)} bg-current/5 border-current/20`}>{level}</span>
            </div>
            <div className="text-neutral-300 break-all leading-relaxed pt-0.5 border-l border-neutral-800/50 pl-4">
              {message}
            </div>
          </div>
        );
      }

      // Stack traces or continuation lines
      if (line.trim().startsWith('File "') || line.trim().startsWith('Traceback') || line.trim().startsWith('  ')) {
        return (
          <div className="grid grid-cols-[30%_1fr] gap-4 -mx-4 px-4 py-1 transition-colors group">
            <div className="flex justify-end pr-4 text-[10px] text-red-500/40 font-mono italic select-none">
              Traceback
            </div>
            <div className="text-red-300/80 italic font-light whitespace-pre-wrap border-l border-red-500/20 pl-4 py-0.5 bg-red-500/5 rounded-r-lg">
              {line}
            </div>
          </div>
        );
      }

      return (
        <div className="grid grid-cols-[30%_1fr] gap-4 -mx-4 px-4 py-1.5 hover:bg-neutral-900/30 transition-colors">
          <div />
          <div className="text-neutral-400 px-4 border-l border-neutral-800/50">{line}</div>
        </div>
      );
    })();

    return (
      <div key={index}>
        {isStartup && (
          <div className="flex items-center gap-4 py-6 -mx-4 group">
            <div className="h-px bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent flex-1" />
            <div className="px-3 py-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold text-emerald-400 uppercase tracking-widest shadow-[0_0_15px_rgba(16,185,129,0.2)]">
              Backend Startup Sequence
            </div>
            <div className="h-px bg-gradient-to-r from-transparent via-emerald-500/50 to-transparent flex-1" />
          </div>
        )}
        {logContent}
      </div>
    );
  };

  const loadSettings = async () => {
    try {
      setLoading(true);
      const data = await getSettings(false); // Always load masked by default
      setSettings(data);
      setSelectedProvider(data.llm_provider || 'gemini'); // Default to gemini if not set
      // Initialize embedding download state based on persisted path
      if (data.embedding_model_path) {
        setEmbeddingDownloadProgress(100);
      } else {
        setEmbeddingDownloadProgress(null);
      }

      // Default to all tools enabled if not configured (null/undefined)
      // If configured but empty list, it stays empty.
      if (data.enabled_tools === null || data.enabled_tools === undefined) {
        setEnabledTools(AVAILABLE_TOOLS.map(t => t.id));
      } else {
        setEnabledTools(data.enabled_tools);
      }

      setError(null);
      // Check auto-start status
      const autostart = await isEnabled();
      setAutoStartEnabled(autostart);

      // Restore Rie Token from settings if available
      if (data.rie_access_token) {
        setRieToken(data.rie_access_token);
        // Fetch usage to verify valid session
        fetchRieUsage();
      } else {
        setRieToken(null);
      }
    } catch (err) {
      console.error("Settings load error:", err);
      setError("Failed to load settings: " + (err.message || String(err)));
    } finally {
      setLoading(false);
    }
  };

  const fetchOllamaModels = async () => {
    try {
      setLoadingOllamaModels(true);
      const data = await getOllamaModels();
      setOllamaModels(data.models || []);
    } catch (err) {
      console.error("Failed to fetch Ollama models:", err);
    } finally {
      setLoadingOllamaModels(false);
    }
  };

  useEffect(() => {
    if (selectedProvider === 'ollama') {
      fetchOllamaModels();
    }
  }, [selectedProvider]);

  const handleSaveSetting = async (key, value) => {
    try {
      setSavingKey(key);
      await updateSetting(key, value);

      // Update local state to reflect change immediately
      setSettings(prev => ({ ...prev, [key]: value }));

      // Auto-set LLM_PROVIDER if it's not set and we just saved a key for one
      if (!settings.llm_provider) {
        let autoProvider = null;
        if (key === 'GOOGLE_API_KEY') autoProvider = 'gemini';
        else if (key === 'GROQ_API_KEY') autoProvider = 'groq';
        else if (key === 'OPENAI_API_KEY') autoProvider = 'openai';
        else if (key === 'VERTEX_PROJECT' || key === 'VERTEX_CREDENTIALS_PATH') autoProvider = 'vertex';
        // Rie is hardcoded, no auto-provider selection needed

        if (autoProvider) {
          console.log(`Auto-setting LLM_PROVIDER to ${autoProvider}`);
          await updateSetting('LLM_PROVIDER', autoProvider);
          setSelectedProvider(autoProvider);
        }
      }

      // Reload to get properly masked values and server-side validation
      await loadSettings();
    } catch (err) {
      setError(`Failed to save ${key}: ${err.message}`);
    } finally {
      setSavingKey(null);
    }
  };

  const handleProviderChange = async (provider) => {
    setSelectedProvider(provider);
    await handleSaveSetting('LLM_PROVIDER', provider);
  };

  const handleToolToggle = async (toolId) => {
    const newTools = enabledTools.includes(toolId)
      ? enabledTools.filter(t => t !== toolId)
      : [...enabledTools, toolId];

    setEnabledTools(newTools);
    await handleSaveSetting('ENABLED_TOOLS', JSON.stringify(newTools));
  };

  const handleAutoStartToggle = async () => {
    try {
      const newState = !autoStartEnabled;
      if (newState) {
        await enable();
      } else {
        await disable();
      }
      setAutoStartEnabled(newState);
    } catch (err) {
      console.error("Failed to toggle auto-start:", err);
      setError("Failed to change auto-start setting: " + err.message);
    }
  };

  return (
    <div className="absolute inset-0 premium-surface z-50 flex flex-col font-sans border border-white/10 overflow-hidden shadow-2xl">
      {/* Header */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between px-6 py-1 border-b border-white/5 bg-neutral-900 cursor-move shrink-0"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500/10 rounded-xl">
            <Settings className="w-3 h-3 text-emerald-400" />
          </div>
          <h2 className="text-lg font-bold text-white tracking-tight">System Settings</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            onMouseDown={(e) => e.stopPropagation()}
            className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm font-semibold tracking-wide transition-all group"
            title="Close settings"
          >
            Close
          </button>
        </div>
      </div>

      {/* Main Layout: Sidebar + Content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar */}
        <div className="w-64 bg-neutral-950/50 border-r border-white/5 flex flex-col p-4 gap-1.5 shrink-0 overflow-y-auto custom-scrollbar">

          <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-[0.2em] px-3 py-3 mb-1">
            Core
          </div>

          <SidebarButton
            active={activeTab === 'provider'}
            onClick={() => setActiveTab('provider')}
            icon={<Cpu size={18} />}
          >
            AI Provider
          </SidebarButton>

          <SidebarButton
            active={activeTab === 'tools'}
            onClick={() => setActiveTab('tools')}
            icon={<Wrench size={18} />}
          >
            Tools & MCP
          </SidebarButton>

          <SidebarButton
            active={activeTab === 'external'}
            onClick={() => setActiveTab('external')}
            icon={<Link size={18} />}
          >
            External APIs
          </SidebarButton>

          <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-[0.2em] px-3 py-3 mt-4 mb-1">
            System
          </div>

          <SidebarButton
            active={activeTab === 'general'}
            onClick={() => setActiveTab('general')}
            icon={<Settings size={18} />}
          >
            General
          </SidebarButton>

          <SidebarButton
            active={activeTab === 'logs'}
            onClick={() => setActiveTab('logs')}
            icon={<FileText size={18} />}
          >
            System Logs
          </SidebarButton>

          <SidebarButton
            active={activeTab === 'voice'}
            onClick={() => setActiveTab('voice')}
            icon={<Volume2 size={18} />}
          >
            Voice & TTS
          </SidebarButton>

          <SidebarButton
            active={activeTab === 'observability'}
            onClick={() => setActiveTab('observability')}
            icon={<Search size={18} />}
          >
            Observability
          </SidebarButton>

          <div className="mt-auto pt-6 px-3">
            <div className="p-4 rounded-2xlborder border-white/5">
              <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-1">Version</div>
              <div className="text-xs font-semibold text-white">Rie-AI v{appVersion}</div>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8 custom-scrollbar bg-neutral-900/50">
          {loading ? (
            <div className="flex justify-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          ) : (
            <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-300 slide-in-from-bottom-2">

              {/* PROVIDER TAB */}
              {activeTab === 'provider' && (
                <div className="space-y-6">
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold text-white tracking-tight">AI Provider</h3>
                    <p className="text-sm text-neutral-500">Select the model that powers your assistant's intelligence.</p>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {Object.entries(PROVIDERS).map(([key, info]) => (
                      <button
                        key={key}
                        onClick={() => handleProviderChange(key)}
                        className={`flex flex-col items-start gap-3 p-4 rounded-2xl border transition-all duration-300 ${selectedProvider === key
                          ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-100 shadow-[0_0_20px_rgba(16,185,129,0.1)] ring-1 ring-emerald-500/20'
                          : 'bg-white/[0.03] border-white/5 hover:bg-white/[0.06] text-neutral-400 hover:text-neutral-200'
                          }`}
                      >
                        <div className={`p-2 rounded-xl ${selectedProvider === key ? 'bg-emerald-500/20' : 'bg-white/5'}`}>
                          {info.icon}
                        </div>
                        <span className="text-sm font-semibold tracking-wide">{info.label}</span>
                      </button>
                    ))}
                  </div>

                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <div className="flex items-center gap-3 pb-4 border-b border-white/5">
                      <div className="p-2 bg-emerald-500/10 rounded-lg text-emerald-400">
                        {PROVIDERS[selectedProvider]?.icon}
                      </div>
                      <h3 className="text-sm font-bold text-white tracking-wide uppercase">
                        {PROVIDERS[selectedProvider]?.label === 'Rie' ? 'Rie Usage' : PROVIDERS[selectedProvider]?.label + ' Configuration'}
                      </h3>
                    </div>

                    {selectedProvider === 'gemini' && (
                      <>
                        <SettingInput
                          label="Google API Key"
                          dbKey="GOOGLE_API_KEY"
                          value={settings.google_api_key}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "GOOGLE_API_KEY"}
                          isSecret
                        />
                        <SettingInput
                          label="Model Name"
                          dbKey="GEMINI_MODEL"
                          value={settings.gemini_model}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "GEMINI_MODEL"}
                          placeholder="gemini-1.5-pro"
                        />
                      </>
                    )}

                    {selectedProvider === 'vertex' && (
                      <>
                        <SettingInput
                          label="Project ID"
                          dbKey="VERTEX_PROJECT"
                          value={settings.vertex_project}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "VERTEX_PROJECT"}
                        />
                        <SettingInput
                          label="Location"
                          dbKey="VERTEX_LOCATION"
                          value={settings.vertex_location}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "VERTEX_LOCATION"}
                          placeholder="us-central1"
                        />
                        <SettingInput
                          label="Credentials JSON Path"
                          dbKey="VERTEX_CREDENTIALS_PATH"
                          value={settings.vertex_credentials_path}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "VERTEX_CREDENTIALS_PATH"}
                          placeholder="C:\path\to\credentials.json"
                        />
                        <SettingInput
                          label="Model Name"
                          dbKey="VERTEX_MODEL"
                          value={settings.vertex_model}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "VERTEX_MODEL"}
                          placeholder="gemini-1.5-pro"
                        />
                      </>
                    )}

                    {selectedProvider === 'groq' && (
                      <>
                        <SettingInput
                          label="Groq API Key"
                          dbKey="GROQ_API_KEY"
                          value={settings.groq_api_key}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "GROQ_API_KEY"}
                          isSecret
                          type="textarea"
                          placeholder="Enter keys separated by commas or lines:
gsk_key1,
gsk_key2,
..."
                        />
                        <p className="text-[10px] text-neutral-500 mt-1">
                          Tip: Add multiple keys to bypass Groq's per-minute rate limits. They will be rotated automatically.
                        </p>
                        <SettingInput
                          label="Model Name"
                          dbKey="GROQ_MODEL"
                          value={settings.groq_model}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "GROQ_MODEL"}
                          placeholder="llama-3.1-70b-versatile"
                        />
                      </>
                    )}

                    {selectedProvider === 'openai' && (
                      <>
                        <SettingInput
                          label="OpenAI API Key"
                          dbKey="OPENAI_API_KEY"
                          value={settings.openai_api_key}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "OPENAI_API_KEY"}
                          isSecret
                          type="textarea"
                          placeholder="Enter keys separated by commas or lines:
key1,
key2,
..."
                        />
                        <p className="text-[10px] text-neutral-500 mt-1">
                          Tip: Add multiple keys to bypass rate limits. They will be rotated automatically.
                        </p>
                        <SettingInput
                          label="Base URL"
                          dbKey="OPENAI_BASE_URL"
                          value={settings.openai_base_url}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "OPENAI_BASE_URL"}
                          placeholder="https://api.z.ai/api/paas/v4/"
                        />
                        <SettingInput
                          label="Model Name"
                          dbKey="OPENAI_MODEL"
                          value={settings.openai_model}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "OPENAI_MODEL"}
                          placeholder="glm-4.5-flash"
                        />
                      </>
                    )}

                    {selectedProvider === 'rie' && (
                      <div className="space-y-4">
                        {/* ... existing rie code ... */}
                        {!rieToken ? (
                          <div className=" p-12 rounded-2xl flex flex-col items-center justify-center text-center space-y-6">
                            <div className="space-y-2">
                              <h4 className="text-xl font-semibold text-neutral-100">Unlock the Full Power of Rie</h4>
                              <p className="text-sm text-neutral-400 max-w-xs mx-auto">
                                Sign in to access advanced models, system controls, and get up to 50 free requests per day.
                              </p>
                            </div>
                            <button
                              onClick={async () => {
                                try {
                                  const { openUrl } = await import('@tauri-apps/plugin-opener');
                                  await openUrl('http://localhost:14200/login?redirect_to_app=true');
                                } catch (e) {
                                  console.error("Failed to open login URL:", e);
                                  // Fallback for dev if plugin naming is different or not found
                                  window.open('http://localhost:14200/login?redirect_to_app=true', '_blank');
                                }
                              }}
                              className="px-8 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-semibold transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:scale-105 active:scale-95"
                            >
                              Sign In via Website
                            </button>
                          </div>
                        ) : (
                          <div className=" rounded-2xl  overflow-hidden">
                            {/* Account Header */}
                            <div className="px-6 py-4 flex items-center justify-between bg-neutral-800/20 border-b border-neutral-700/50">
                              <div className="flex items-center gap-3">
                                <div className="p-2 bg-emerald-500/10 rounded-xl">
                                  <Shield className="w-5 h-5 text-emerald-400" />
                                </div>
                                {rieUsage && (
                                  <div>
                                    <div className="text-xs text-neutral-500 font-medium lowercase">Account</div>
                                    <div className="text-sm font-semibold text-neutral-100">{rieUsage.email || 'Authenticated'}</div>
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={handleRieSignOut}
                                className="text-xs font-medium text-neutral-500 hover:text-red-400 transition-colors px-3 py-1.5 hover:bg-red-500/10 rounded-lg"
                              >
                                Sign Out
                              </button>
                            </div>

                            {/* Usage Section */}
                            <div className="p-6 space-y-6">
                              {rieUsage && (
                                <div className="space-y-4">
                                  <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                      <h4 className="text-sm font-medium text-neutral-200">Request Usage</h4>
                                      <p className="text-[11px] text-neutral-500">Reset daily at 00:00 UTC</p>
                                    </div>
                                    <div className="text-right">
                                      <span className="text-lg font-bold text-emerald-400">{rieUsage.current_usage}</span>
                                      <span className="text-sm text-neutral-500 font-medium"> / {rieUsage.limit}</span>
                                    </div>
                                  </div>

                                  {/* Progress Bar */}
                                  <div className="h-2 w-full bg-neutral-900 rounded-full overflow-hidden border border-neutral-700/30">
                                    <motion.div
                                      initial={{ width: 0 }}
                                      animate={{ width: `${(rieUsage.current_usage / rieUsage.limit) * 100}%` }}
                                      transition={{ duration: 1, ease: "easeOut" }}
                                      className={`h-full rounded-full ${(rieUsage.current_usage / rieUsage.limit) > 0.9
                                        ? 'bg-red-500'
                                        : (rieUsage.current_usage / rieUsage.limit) > 0.7
                                          ? 'bg-amber-500'
                                          : 'bg-emerald-500'
                                        } shadow-[0_0_10px_rgba(16,185,129,0.3)]`}
                                    />
                                  </div>

                                  <div className="grid grid-cols-2 gap-4 pt-2">
                                    <div className="p-3 bg-neutral-900/40 rounded-xl border border-neutral-700/50">
                                      <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Status</div>
                                      <div className="flex items-center gap-1.5">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <span className="text-xs font-medium text-neutral-200">Active</span>
                                      </div>
                                    </div>
                                    <div className="p-3 bg-neutral-900/40 rounded-xl border border-neutral-700/50">
                                      <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Remaining</div>
                                      <div className="text-xs font-semibold text-emerald-400">{rieUsage.remaining} requests</div>
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* Footer Info */}
                              <div className="flex items-center gap-3 px-4 py-3 bg-emerald-500/5 rounded-xl border border-emerald-500/10">
                                <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
                                <p className="text-[11px] text-emerald-300/80 leading-normal">
                                  Your requests are optimized by Rie's backend using <span className="font-semibold text-emerald-400">glm-4.5-flash</span>.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {selectedProvider === 'ollama' && (
                      <>
                        <SettingInput
                          label="Ollama Endpoint"
                          dbKey="OLLAMA_API_URL"
                          value={settings.ollama_api_url}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "OLLAMA_API_URL"}
                          placeholder="http://localhost:11434"
                          allowEmpty
                        />
                        <p className="text-[10px] text-neutral-500 -mt-1">
                          Leave empty to use default <code className="text-neutral-400">http://localhost:11434</code>.
                        </p>
                        <SettingInput
                          label="Ollama API Key (optional)"
                          dbKey="OLLAMA_API_KEY"
                          value={settings.ollama_api_key}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "OLLAMA_API_KEY"}
                          isSecret
                          placeholder="For secured or remote Ollama instances"
                        />
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-neutral-400">Ollama Model</label>
                          <div className="flex gap-2">
                            <select
                              value={settings.ollama_model || ''}
                              onChange={(e) => handleSaveSetting('OLLAMA_MODEL', e.target.value)}
                              className="flex-1 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer"
                              disabled={savingKey === "OLLAMA_MODEL" || loadingOllamaModels}
                            >
                              <option value="" disabled>{loadingOllamaModels ? 'Loading models...' : 'Select a model'}</option>
                              {ollamaModels.length > 0 && ollamaModels.map(model => (
                                <option key={model} value={model}>{model}</option>
                              ))}
                              {ollamaModels.length === 0 && !loadingOllamaModels && settings.ollama_model && (
                                <option value={settings.ollama_model}>{settings.ollama_model} (Not found)</option>
                              )}
                            </select>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                fetchOllamaModels();
                              }}
                              disabled={loadingOllamaModels}
                              className="p-2 bg-neutral-800 border border-neutral-700 rounded-lg text-neutral-400 hover:text-emerald-400 transition-colors"
                              title="Refresh models"
                            >
                              <RefreshCw size={18} className={loadingOllamaModels ? 'animate-spin' : ''} />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 px-4 py-3 bg-blue-500/5 rounded-xl border border-blue-500/10">
                          <Info className="w-4 h-4 text-blue-400 shrink-0" />
                          <p className="text-[11px] text-blue-300/80 leading-normal">
                            Using Ollama at <code className="text-blue-400">{settings.ollama_api_url?.trim() || 'http://localhost:11434'}</code>. Make sure it's running and you've downloaded at least one model.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* TOOLS & MCP TAB */}
              {activeTab === 'tools' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold text-white tracking-tight">Tools & Capabilities</h3>
                    <p className="text-sm text-neutral-500">Expand your assistant's skills with built-in tools and MCP servers.</p>
                  </div>

                  {/* Built-in tools as chips */}
                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <div className="flex items-center justify-between pb-4 border-b border-white/5">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-emerald-500/10 rounded-lg text-emerald-400">
                          <Wrench size={16} />
                        </div>
                        <h4 className="text-sm font-bold text-white tracking-wide uppercase">Built-in Tools</h4>
                      </div>
                      <span className="text-[10px] font-bold bg-white/5 border border-white/10 px-2 py-1 rounded-md text-neutral-400 tracking-wider">
                        {enabledTools.length} ACTIVE
                      </span>
                    </div>

                    <div className="flex flex-wrap gap-2.5">
                      {AVAILABLE_TOOLS.map(tool => {
                        const isMissingKey = tool.id === 'internet_search' && !settings.tavily_api_key;
                        const isEnabled = !isMissingKey && enabledTools.includes(tool.id);
                        const tooltipText = isMissingKey
                          ? 'Add Tavily API key in General settings to enable'
                          : tool.desc;
                        return (
                          <div key={tool.id} className="group relative">
                            <button
                              type="button"
                              onClick={() => !isMissingKey && handleToolToggle(tool.id)}
                              disabled={isMissingKey}
                              className={`px-4 py-2 rounded-xl border text-xs font-semibold tracking-wide transition-all duration-300 ${isMissingKey
                                ? 'opacity-40 cursor-not-allowed bg-neutral-900 border-white/5 text-neutral-600'
                                : isEnabled
                                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 shadow-[0_0_15px_rgba(16,185,129,0.1)]'
                                  : 'bg-white/[0.02] border-white/5 text-neutral-500 hover:bg-white/[0.05] hover:border-white/10 hover:text-neutral-300'
                                }`}
                            >
                              {tool.label}
                            </button>
                            {/* Hover tooltip */}
                            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 w-48 rounded-xl border border-white/10 bg-neutral-900 shadow-2xl text-[10px] leading-relaxed text-neutral-400 opacity-0 group-hover:opacity-100 transition-all duration-300 z-50 pointer-events-none scale-95 group-hover:scale-100 origin-top">
                              {tooltipText}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* MCP Servers section */}
                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <div className="flex items-center gap-3 pb-4 border-b border-white/5">
                      <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400">
                        <Plug2 size={16} />
                      </div>
                      <h4 className="text-sm font-bold text-white tracking-wide uppercase">MCP Servers</h4>
                    </div>
                    
                    <p className="text-xs text-neutral-500 leading-relaxed max-w-xl">
                      Model Context Protocol (MCP) allows your assistant to connect to local or remote services, providing access to specific files, databases, or APIs.
                    </p>

                    <div className="pt-2">
                      <McpServersManager
                        servers={settings.mcp_servers || []}
                        onSave={(newServers) => handleSaveSetting('MCP_SERVERS', JSON.stringify(newServers))}
                        isSaving={savingKey === 'MCP_SERVERS'}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* GENERAL TAB */}
              {activeTab === 'general' && (
                <div className="space-y-8">
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold text-white tracking-tight">General Settings</h3>
                    <p className="text-sm text-neutral-500">Configure global behavior and system-level preferences.</p>
                  </div>

                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <h3 className="text-sm font-bold text-blue-400 border-b border-white/5 pb-3 flex items-center gap-2 tracking-wider uppercase">
                      <Shield size={16} />
                      Security & Safety
                    </h3>
                    <SettingInput
                      label="Terminal Restrictions"
                      dbKey="TERMINAL_RESTRICTIONS"
                      value={settings.terminal_restrictions}
                      onSave={handleSaveSetting}
                      isSaving={savingKey === "TERMINAL_RESTRICTIONS"}
                      type="textarea"
                      placeholder="e.g. rm, del, format, curl, wget
Separate keywords by commas. Commands containing these words will be blocked."
                    />
                    <p className="text-[10px] text-neutral-500 mt-1">
                      Protect your system by blacklisting dangerous keywords. The agent will be unable to run any command that contains these strings.
                    </p>

                    <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400">
                          <Info size={16} />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-neutral-200">Human-in-the-Loop (HITL)</h4>
                          <p className="text-[11px] text-neutral-500 max-w-xs">
                            Terminal commands require manual approval before execution for maximum safety.
                          </p>
                        </div>
                      </div>
                      <div
                        onClick={() => handleSaveSetting('HITL_ENABLED', String(!(settings.hitl_enabled)))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-all duration-300 ${settings.hitl_enabled ? 'bg-emerald-500' : 'bg-neutral-800 border border-white/10'
                          }`}
                      >
                        <motion.span
                          animate={{ x: settings.hitl_enabled ? 24 : 4 }}
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-lg`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <h3 className="text-sm font-bold text-emerald-400 border-b border-white/5 pb-3 flex items-center gap-2 tracking-wider uppercase">
                      <Search size={16} />
                      Search & Memory
                    </h3>
                    <SettingInput
                      label="Tavily API Key"
                      dbKey="TAVILY_API_KEY"
                      value={settings.tavily_api_key}
                      onSave={handleSaveSetting}
                      isSaving={savingKey === "TAVILY_API_KEY"}
                      isSecret
                      placeholder="tvly-..."
                    />

                    <div className="mt-4 pt-4 border-t border-neutral-700/60 space-y-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="text-sm font-medium text-neutral-200">Embedding Source</h4>
                          <p className="text-[10px] text-neutral-500">
                            Choose how long-term memory embeddings are computed (bundled model vs Ollama).
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSaveSetting('EMBEDDING_SOURCE', 'bundled')}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                              (settings.embedding_source || 'bundled') === 'bundled'
                                ? 'bg-emerald-500/15 border-emerald-500/60 text-emerald-100'
                                : 'bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500'
                            }`}
                          >
                            Bundled
                          </button>
                          <button
                            onClick={() => handleSaveSetting('EMBEDDING_SOURCE', 'ollama')}
                            className={`px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all ${
                              (settings.embedding_source || 'bundled') === 'ollama'
                                ? 'bg-emerald-500/15 border-emerald-500/60 text-emerald-100'
                                : 'bg-neutral-900 border-neutral-700 text-neutral-400 hover:border-neutral-500'
                            }`}
                          >
                            Ollama
                          </button>
                        </div>
                      </div>

                      {(settings.embedding_source || 'bundled') === 'bundled' && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <h4 className="text-xs font-medium text-neutral-300">Embedding Model</h4>
                              <p className="text-[10px] text-neutral-500">
                                Download ONNX <code className="text-neutral-400">all-MiniLM-L6-v2</code> for bundled LTM (~80MB one-time).
                              </p>
                            </div>
                            <button
                              onClick={async () => {
                                // If already downloaded, do nothing
                                if (embeddingDownloadProgress === 100) return;
                                setEmbeddingDownloading(true);
                                setEmbeddingDownloadError(null);
                                setEmbeddingDownloadProgress(0);
                                try {
                                  const result = await downloadEmbeddingModel((data) => {
                                    setEmbeddingDownloadProgress(data.progress >= 0 ? data.progress : null);
                                    if (data.error) setEmbeddingDownloadError(data.error);
                                  });
                                  if (result.error) setEmbeddingDownloadError(result.error);
                                  else setEmbeddingDownloadProgress(100);
                                } catch (err) {
                                  setEmbeddingDownloadError(err.message || 'Download failed');
                                } finally {
                                  setEmbeddingDownloading(false);
                                }
                              }}
                              disabled={embeddingDownloading || embeddingDownloadProgress === 100}
                              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                            >
                              {embeddingDownloading ? (
                                <span className="flex items-center gap-2">
                                  <RefreshCw size={14} className="animate-spin" />
                                  Downloading...
                                </span>
                              ) : embeddingDownloadProgress === 100 ? (
                                'Downloaded'
                              ) : (
                                'Download Model'
                              )}
                            </button>
                          </div>

                          {embeddingDownloading && embeddingDownloadProgress != null && embeddingDownloadProgress >= 0 && (
                            <div className="space-y-1">
                              <div className="flex justify-between text-[10px] text-neutral-400">
                                <span>{embeddingDownloadProgress}%</span>
                                <span>{embeddingDownloadProgress >= 100 ? 'Complete' : 'Downloading...'}</span>
                              </div>
                              <div className="h-2 w-full bg-neutral-900 rounded-full overflow-hidden border border-neutral-700/30">
                                <motion.div
                                  initial={{ width: 0 }}
                                  animate={{ width: `${Math.min(100, embeddingDownloadProgress)}%` }}
                                  transition={{ duration: 0.3 }}
                                  className="h-full bg-emerald-500 rounded-full"
                                />
                              </div>
                            </div>
                          )}

                          {embeddingDownloadError && (
                            <p className="text-xs text-red-400">{embeddingDownloadError}</p>
                          )}

                          <SettingInput
                            label="Bundled Model Path (optional)"
                            dbKey="EMBEDDING_MODEL_PATH"
                            value={settings.embedding_model_path}
                            onSave={handleSaveSetting}
                            isSaving={savingKey === "EMBEDDING_MODEL_PATH"}
                            placeholder="Leave empty to use downloaded model"
                            allowEmpty
                          />
                        </div>
                      )}

                      {(settings.embedding_source || 'bundled') === 'ollama' && (
                        <p className="text-[10px] text-neutral-500">
                          Embeddings will be computed by Ollama using <code className="text-neutral-400">nomic-embed-text</code> at{' '}
                          <code className="text-neutral-400">{settings.ollama_api_url?.trim() || 'http://localhost:11434'}</code>.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="p-6 bg-neutral-800/30 rounded-xl border border-neutral-700/50 space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Mic className="text-neutral-400" size={20} />
                        <div>
                          <h3 className="text-sm font-medium text-neutral-200">Voice Reply</h3>
                          <p className="text-[10px] text-neutral-500">Automatically speak the response when you use voice input.</p>
                        </div>
                      </div>
                      <div
                        onClick={() => handleSaveSetting('VOICE_REPLY', String(!(settings.voice_reply)))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors ${settings.voice_reply ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.voice_reply ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="p-6 bg-neutral-800/30 rounded-xl border border-neutral-700/50 space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Rocket className="text-neutral-400" size={20} />
                        <div>
                          <h3 className="text-sm font-medium text-neutral-200">Auto-start</h3>
                          <p className="text-[10px] text-neutral-500">Launch Rie-AI automatically when you log in.</p>
                        </div>
                      </div>
                      <div
                        onClick={handleAutoStartToggle}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors ${autoStartEnabled ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${autoStartEnabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>
                  </div>

                  {/* About Section */}
                  <div className="p-6 bg-neutral-800/30 rounded-xl border border-neutral-700/50 space-y-4">
                    <h3 className="text-sm font-medium text-blue-400 border-b border-neutral-700/50 pb-2 flex items-center gap-2">
                      <Info size={14} />
                      About
                    </h3>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Sparkles className="text-emerald-400" size={18} />
                        <div>
                          <h4 className="text-sm font-medium text-neutral-200">Application Version</h4>
                          <p className="text-[10px] text-neutral-500">Current installed version of Rie-AI.</p>
                        </div>
                      </div>
                      <span className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-sm font-semibold text-emerald-400 tracking-wide">
                        v{appVersion}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText className="text-neutral-400" size={18} />
                        <div>
                          <h4 className="text-sm font-medium text-neutral-200">Documentation</h4>
                          <p className="text-[10px] text-neutral-500">Learn how to configure and use Rie-AI.</p>
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            const { openUrl } = await import('@tauri-apps/plugin-opener');
                            await openUrl('https://rie-ai.web.app/docs');
                          } catch {
                            window.open('https://rie-ai.web.app/docs', '_blank');
                          }
                        }}
                        className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 hover:border-neutral-600 rounded-lg text-sm font-medium text-neutral-300 hover:text-white transition-all"
                      >
                        <ExternalLink size={14} />
                        View Docs
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* VOICE & TTS TAB */}
              {activeTab === 'voice' && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
                    <div>
                      <h3 className="text-lg font-medium text-neutral-100">Voice & TTS</h3>
                      <p className="text-sm text-neutral-500">Configure how your assistant speaks.</p>
                    </div>
                  </div>

                  <div className="p-6 bg-neutral-800/30 rounded-xl border border-neutral-700/50 space-y-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Mic className="text-neutral-400" size={20} />
                        <div>
                          <h3 className="text-sm font-medium text-neutral-200">Voice Reply</h3>
                          <p className="text-[10px] text-neutral-500">Automatically speak the response when you use voice input.</p>
                        </div>
                      </div>
                      <div
                        onClick={() => handleSaveSetting('VOICE_REPLY', String(!(settings.voice_reply)))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors ${settings.voice_reply ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.voice_reply ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="p-6 bg-neutral-800/30 rounded-xl border border-neutral-700/50 space-y-4">
                    <h4 className="text-sm font-medium text-neutral-300">TTS Provider</h4>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSaveSetting('TTS_PROVIDER', 'edge-tts')}
                        className={`px-4 py-2 rounded-lg border text-sm transition-all ${settings.tts_provider === 'edge-tts'
                          ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-100'
                          : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}
                      >
                        Edge TTS (Neural)
                      </button>
                      <button
                        onClick={() => settings.groq_api_key ? handleSaveSetting('TTS_PROVIDER', 'groq') : null}
                        disabled={!settings.groq_api_key}
                        title={!settings.groq_api_key ? 'Add Groq API key in AI Provider settings to enable' : ''}
                        className={`px-4 py-2 rounded-lg border text-sm transition-all ${!settings.groq_api_key
                          ? 'opacity-50 cursor-not-allowed bg-neutral-800 border-neutral-700 text-neutral-500'
                          : settings.tts_provider === 'groq'
                            ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-100'
                            : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}
                      >
                        Groq (Orpheus)
                      </button>
                    </div>
                    {!settings.groq_api_key && (
                      <p className="text-[10px] text-amber-500/80 bg-amber-500/5 p-2 rounded border border-amber-500/10">
                        Add a Groq API key in the AI Provider tab to unlock Groq TTS.
                      </p>
                    )}
                    {settings.tts_provider === 'groq' && settings.groq_api_key && (
                      <p className="text-[10px] text-amber-500/80 bg-amber-500/5 p-2 rounded border border-amber-500/10">
                        Note: Groq TTS uses the `canopylabs/orpheus-v1-english` model. It is high quality but limited to 200 characters per segment.
                      </p>
                    )}
                  </div>

                  <div className="p-6 bg-neutral-800/30 rounded-xl border border-neutral-700/50 space-y-4">
                    <h4 className="text-sm font-medium text-neutral-300">Voice Character</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {settings.tts_provider === 'groq' ? (
                        <>
                          {['hannah', 'troy'].map(v => (
                            <button
                              key={v}
                              onClick={() => handleSaveSetting('TTS_VOICE', v)}
                              className={`px-4 py-3 rounded-xl border text-left transition-all ${settings.tts_voice === v
                                ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-100'
                                : 'bg-neutral-800/50 border-neutral-700 text-neutral-400 hover:bg-neutral-800'}`}
                            >
                              <div className="text-sm font-medium capitalize">{v}</div>
                              <div className="text-[10px] text-neutral-500">Groq Orpheus Voice</div>
                            </button>
                          ))}
                        </>
                      ) : (
                        <>
                          {[
                            { id: 'en-US-EmmaNeural', name: 'Emma', loc: 'US' },
                            { id: 'en-US-AndrewNeural', name: 'Andrew', loc: 'US' },
                            { id: 'en-GB-SoniaNeural', name: 'Sonia', loc: 'UK' },
                            { id: 'en-GB-RyanNeural', name: 'Ryan', loc: 'UK' }
                          ].map(v => (
                            <button
                              key={v.id}
                              onClick={() => handleSaveSetting('TTS_VOICE', v.id)}
                              className={`px-4 py-3 rounded-xl border text-left transition-all ${settings.tts_voice === v.id
                                ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-100'
                                : 'bg-neutral-800/50 border-neutral-700 text-neutral-400 hover:bg-neutral-800'}`}
                            >
                              <div className="text-sm font-medium">{v.name} ({v.loc})</div>
                              <div className="text-[10px] text-neutral-500">Edge Neural Voice</div>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* LOGS TAB */}
              {activeTab === 'logs' && (
                <div className="space-y-6 flex flex-col h-full max-h-[600px]">
                  <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
                    <div>
                      <h3 className="text-lg font-medium text-neutral-100">System Logs</h3>
                      <p className="text-sm text-neutral-500">View backend debug logs for troubleshooting.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleCopyLogs}
                        disabled={!logs}
                        className="p-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white transition-all flex items-center gap-2 text-xs border border-neutral-700/50"
                      >
                        {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                        {copied ? 'Copied' : 'Copy Logs'}
                      </button>
                      <button
                        onClick={fetchLogs}
                        disabled={loadingLogs}
                        className="p-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white transition-all flex items-center gap-2 text-xs border border-neutral-700/50"
                      >
                        <RefreshCw size={14} className={loadingLogs ? "animate-spin" : ""} />
                        Refresh
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 bg-black/40 rounded-2xl border border-neutral-800 font-mono text-[11px] p-4 overflow-y-auto custom-scrollbar whitespace-normal backdrop-blur-sm">
                    {loadingLogs && !logs ? (
                      <div className="flex flex-col justify-center items-center h-full gap-3">
                        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
                        <span className="text-neutral-500 text-xs animate-pulse">Fetching latest logs...</span>
                      </div>
                    ) : (
                      <div className="min-w-fit">
                        {logs ? logs.split('\n').map((line, i) => renderLogLine(line, i)) : (
                          <div className="text-neutral-600 italic text-center py-20">No logs available.</div>
                        )}
                        <div ref={logsEndRef} />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-neutral-600 italic">
                      Showing the last 1000 lines of <code className="text-neutral-500">backend_debug.log</code>
                    </p>
                    <div className="flex gap-4">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-emerald-500" />
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tight">Info</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-red-500" />
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tight">Error</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-amber-500" />
                        <span className="text-[10px] text-neutral-500 uppercase tracking-tight">Warning</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* OBSERVABILITY TAB */}
              {activeTab === 'observability' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold text-white tracking-tight">Observability</h3>
                    <p className="text-sm text-neutral-500">Enable deep tracing and real-time monitoring of agent behavior.</p>
                  </div>

                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <div className="flex items-center justify-between pb-4 border-b border-white/5">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-purple-500/10 rounded-lg text-purple-400">
                          <Activity size={16} />
                        </div>
                        <h4 className="text-sm font-bold text-white tracking-wide uppercase">LangSmith Tracing</h4>
                      </div>
                      <div
                        onClick={() => handleSaveSetting('LANGSMITH_TRACING', String(!(settings.langsmith_tracing)))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-all duration-300 ${settings.langsmith_tracing ? 'bg-emerald-500' : 'bg-neutral-800 border border-white/10'
                          }`}
                      >
                        <motion.span
                          animate={{ x: settings.langsmith_tracing ? 24 : 4 }}
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-lg`}
                        />
                      </div>
                    </div>

                    <p className="text-xs text-neutral-500 leading-relaxed max-w-xl">
                      Detailed execution traces, tool call history, and LLM input/output logs. Helps in debugging and performance tuning.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-white/5">
                      <SettingInput
                        label="LangSmith API Key"
                        dbKey="LANGSMITH_API_KEY"
                        value={settings.langsmith_api_key}
                        onSave={handleSaveSetting}
                        isSaving={savingKey === "LANGSMITH_API_KEY"}
                        isSecret
                        placeholder="ls__..."
                      />
                      <SettingInput
                        label="Project Name"
                        dbKey="LANGSMITH_PROJECT"
                        value={settings.langsmith_project}
                        onSave={handleSaveSetting}
                        isSaving={savingKey === "LANGSMITH_PROJECT"}
                        placeholder="Rie-AI"
                      />
                      <div className="md:col-span-2">
                        <SettingInput
                          label="API Endpoint"
                          dbKey="LANGSMITH_ENDPOINT"
                          value={settings.langsmith_endpoint}
                          onSave={handleSaveSetting}
                          isSaving={savingKey === "LANGSMITH_ENDPOINT"}
                          placeholder="https://api.smith.langchain.com"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* EXTERNAL APIS TAB */}
              {activeTab === 'external' && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
                    <div>
                      <h3 className="text-lg font-medium text-neutral-100">External APIs</h3>
                      <p className="text-sm text-neutral-500">Connect custom API endpoints as tools for the agent.</p>
                      <p className="text-xs text-neutral-500 mt-1">
                        <strong>Method:</strong> GET/DELETE use query params; POST/PUT/PATCH send a body. Use <strong>Request body (JSON)</strong> to set a fixed or templated payload (e.g. <code className="bg-neutral-800 px-1 rounded">{'{"query": "{query}"}'}</code>).
                      </p>
                    </div>
                  </div>

                  <ExternalApisManager
                    apis={settings.external_apis || []}
                    onSave={(updatedApis) => handleSaveSetting('EXTERNAL_APIS', JSON.stringify(updatedApis))}
                    isSaving={savingKey === 'EXTERNAL_APIS'}
                  />
                </div>
              )}

            </div>
          )}
        </div>
      </div>
      {/* Rie Login Modal */}
      <AnimatePresence>
        {isRieLoginModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsRieLoginModalOpen(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-3xl p-8 shadow-2xl"
            >
              <button
                onClick={() => setIsRieLoginModalOpen(false)}
                className="absolute top-4 right-4 p-2 text-neutral-500 hover:text-white rounded-full transition-colors"
              >
                <X size={20} />
              </button>

              <div className="flex flex-col items-center mb-8">
                <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-4">
                  <Shield className="w-6 h-6 text-emerald-400" />
                </div>
                <h3 className="text-xl font-bold text-white">
                  {rieAuthMode === 'signin' ? 'Welcome Back' : 'Join Rie'}
                </h3>
                <p className="text-xs text-neutral-500 mt-1 text-center">
                  {rieAuthMode === 'signin' ? 'Enter your credentials to continue' : 'Create an account to get started'}
                </p>
              </div>

              <form onSubmit={handleRieAuth} className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider ml-1">Email</label>
                  <input
                    type="email"
                    value={rieEmail}
                    onChange={(e) => setRieEmail(e.target.value)}
                    className="w-full px-4 py-3 bg-neutral-800/50 border border-neutral-700 rounded-xl text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 transition-all"
                    placeholder="you@example.com"
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-neutral-400 uppercase tracking-wider ml-1">Password</label>
                  <input
                    type="password"
                    value={riePassword}
                    onChange={(e) => setRiePassword(e.target.value)}
                    className="w-full px-4 py-3 bg-neutral-800/50 border border-neutral-700 rounded-xl text-sm text-neutral-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/50 transition-all"
                    placeholder="••••••••"
                    required
                  />
                </div>

                {rieError && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-[11px] text-red-400"
                  >
                    <Info size={14} className="shrink-0" />
                    {rieError}
                  </motion.div>
                )}

                <button
                  type="submit"
                  disabled={rieLoading}
                  className="w-full py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-sm font-bold transition-all shadow-[0_4px_15px_rgba(16,185,129,0.2)] mt-2"
                >
                  {rieLoading ? (
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto text-white/50" />
                  ) : (
                    rieAuthMode === 'signin' ? 'Sign In' : 'Create Account'
                  )}
                </button>

                <div className="pt-4 text-center">
                  <p className="text-xs text-neutral-500">
                    {rieAuthMode === 'signin' ? "Don't have an account?" : "Already have an account?"}{' '}
                    <button
                      type="button"
                      onClick={() => setRieAuthMode(rieAuthMode === 'signin' ? 'signup' : 'signin')}
                      className="text-emerald-400 hover:text-emerald-300 font-semibold"
                    >
                      {rieAuthMode === 'signin' ? 'Sign Up' : 'Sign In'}
                    </button>
                  </p>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function McpServersManager({ servers, onSave, isSaving }) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [newServer, setNewServer] = useState({ type: 'stdio', command: '', args: '', env: '', url: '' });
  const [error, setError] = useState(null);
  const [mcpStatus, setMcpStatus] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState(null);
  const [expandedServers, setExpandedServers] = useState(new Set());
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [indexToDelete, setIndexToDelete] = useState(null);

  // Fetch MCP status on component mount
  useEffect(() => {
    fetchMcpStatus();
  }, []);

  const fetchMcpStatus = async () => {
    try {
      setLoadingStatus(true);
      setStatusError(null);
      const status = await getMcpStatus();
      setMcpStatus(status);
    } catch (err) {
      console.error('Failed to fetch MCP status:', err);
      setStatusError(err.message);
    } finally {
      setLoadingStatus(false);
    }
  };

  const toggleServerExpand = (index) => {
    const newExpanded = new Set(expandedServers);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedServers(newExpanded);
  };

  const handleEditClick = (index) => {
    const server = servers[index];
    const isSse = !!server.url;
    
    setNewServer({
      type: isSse ? 'sse' : 'stdio',
      command: server.command || '',
      args: server.args ? server.args.join('\n') : '',
      env: server.env ? JSON.stringify(server.env, null, 2) : '',
      url: server.url || ''
    });
    
    setEditingIndex(index);
    setIsAdding(true);
    setError(null);
  };

  const handleSave = () => {
    if (newServer.type === 'stdio' && !newServer.command.trim()) {
      setError("Command is required");
      return;
    }
    if (newServer.type === 'sse' && !newServer.url.trim()) {
      setError("URL is required");
      return;
    }

    try {
      let server;
      if (newServer.type === 'stdio') {
        server = {
          command: newServer.command.trim(),
          args: newServer.args ? newServer.args.split('\n').map(a => a.trim()).filter(a => a) : [],
          env: newServer.env ? JSON.parse(newServer.env) : {}
        };
      } else {
        server = {
          url: newServer.url.trim()
        };
      }

      let updatedServers;
      if (editingIndex !== null) {
        updatedServers = [...servers];
        updatedServers[editingIndex] = server;
      } else {
        updatedServers = [...servers, server];
      }
      
      onSave(updatedServers);
      setIsAdding(false);
      setEditingIndex(null);
      setNewServer({ type: 'stdio', command: '', args: '', env: '', url: '' });
      setError(null);

      // Refresh status after adding
      setTimeout(fetchMcpStatus, 1000);
    } catch (e) {
      setError("Invalid JSON for environment variables");
    }
  };

  const handleDeleteClick = (index) => {
    setIndexToDelete(index);
    setIsConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (indexToDelete === null) return;
    const updatedServers = servers.filter((_, i) => i !== indexToDelete);
    onSave(updatedServers);
    setIndexToDelete(null);
    
    // If we were editing, cancel it to avoid index mismatches
    setIsAdding(false);
    setEditingIndex(null);
    setNewServer({ type: 'stdio', command: '', args: '', env: '', url: '' });

    // Refresh status after deleting
    setTimeout(fetchMcpStatus, 500);
  };

  const getServerStatus = () => {
    if (!mcpStatus) return 'unknown';
    return mcpStatus.status === 'connected' ? 'connected' : 'error';
  };

  const getToolsCount = () => {
    return mcpStatus?.loaded_tools_count || 0;
  };

  return (
    <div className="space-y-4">
      {/* Header with Refresh Button */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-500">
          {servers.length === 0 ? (
            'No servers configured'
          ) : (
            <>
              {servers.length} server{servers.length !== 1 ? 's' : ''} configured
              {mcpStatus && (
                <span className="ml-2">
                  • {getToolsCount()} tool{getToolsCount() !== 1 ? 's' : ''} loaded
                </span>
              )}
            </>
          )}
        </div>
        <button
          onClick={fetchMcpStatus}
          disabled={loadingStatus}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={loadingStatus ? "animate-spin" : ""} />
          {loadingStatus ? 'Checking...' : 'Refresh Status'}
        </button>
      </div>

      {/* Status Error Message */}
      {statusError && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
          <div className="flex items-center gap-2">
            <Shield size={14} />
            {statusError}
          </div>
        </div>
      )}

      {/* Server List */}
      <div className="space-y-3">
        {servers.length === 0 ? (
          <div className="p-8 border-2 border-dashed border-neutral-800 rounded-xl text-center">
            <p className="text-sm text-neutral-500">No MCP servers configured yet.</p>
          </div>
        ) : (
          servers.map((server, idx) => {
            const isExpanded = expandedServers.has(idx);
            const status = getServerStatus();
            const toolsCount = getToolsCount();

            return (
              <div key={idx} className="border border-neutral-700/50 rounded-xl overflow-hidden bg-neutral-800/20">
                {/* Server Header */}
                <div className="p-4 flex items-start justify-between group">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-semibold text-neutral-200">{server.url || server.command}</span>

                      {/* Status Badge */}
                      {loadingStatus ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-500/10 text-neutral-500 border border-neutral-500/20">
                          Checking...
                        </span>
                      ) : status === 'connected' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                          Connected
                        </span>
                      ) : status === 'error' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 border border-red-500/20 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                          Error
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-500/10 text-neutral-500 border border-neutral-500/20">
                          Unknown
                        </span>
                      )}

                      {/* Tools Count Badge */}
                      {mcpStatus && toolsCount > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {toolsCount} tool{toolsCount !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>

                    {server.url && (
                      <p className="text-xs text-neutral-500 font-mono truncate max-w-md">
                        URL: {server.url}
                      </p>
                    )}
                    {server.args && server.args.length > 0 && (
                      <p className="text-xs text-neutral-500 font-mono truncate max-w-md">
                        Args: {server.args.join(' ')}
                      </p>
                    )}
                    {server.env && Object.keys(server.env).length > 0 && (
                      <p className="text-xs text-neutral-500 font-mono truncate max-w-md">
                        Env: {JSON.stringify(server.env)}
                      </p>
                    )}

                    {/* Tools Toggle Button */}
                    {mcpStatus && mcpStatus.available_tools && mcpStatus.available_tools.length > 0 && (
                      <button
                        onClick={() => toggleServerExpand(idx)}
                        className="mt-2 text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
                      >
                        <ChevronDown
                          size={12}
                          className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                        />
                        {isExpanded ? 'Hide' : 'Show'} available tools
                      </button>
                    )}
                  </div>

                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleEditClick(idx)}
                        className="p-2 text-neutral-500 hover:text-emerald-400 transition-colors"
                        title="Edit server"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => handleDeleteClick(idx)}
                        className="p-2 text-neutral-500 hover:text-red-400 transition-colors"
                        title="Remove server"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                {/* Expanded Tools List */}
                <AnimatePresence>
                  {isExpanded && mcpStatus && mcpStatus.available_tools && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="border-t border-neutral-700/50 bg-neutral-900/50"
                    >
                      <div className="p-4 space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
                        <div className="text-xs font-medium text-neutral-400 mb-2">Available Tools:</div>
                        {mcpStatus.available_tools.map((tool, toolIdx) => (
                          <div key={toolIdx} className="p-2 bg-neutral-800/50 rounded border border-neutral-700/30">
                            <div className="flex items-start gap-2">
                              <div className="mt-0.5 text-emerald-500">
                                <Wrench size={12} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-mono font-medium text-neutral-200 truncate">
                                  {tool.name}
                                </div>
                                <div className="text-[10px] text-neutral-500 mt-0.5">
                                  {tool.description}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })
        )}
      </div>

      {/* Add Button / Form */}
      {!isAdding ? (
        <button
          onClick={() => {
            setIsAdding(true);
            setEditingIndex(null);
            setNewServer({ type: 'stdio', command: '', args: '', env: '', url: '' });
          }}
          className="w-full py-3 border border-dashed border-neutral-700 hover:border-emerald-500/50 hover:bg-emerald-500/5 rounded-xl text-sm text-neutral-400 hover:text-emerald-400 transition-all flex items-center justify-center gap-2"
        >
          <Plus size={16} />
          Add MCP Server
        </button>
      ) : (
        <div className="p-6 bg-neutral-800/50 border border-neutral-700 rounded-xl space-y-4 animate-in slide-in-from-top-2">
          <h4 className="text-sm font-medium text-neutral-200">
            {editingIndex !== null ? 'Edit MCP Server' : 'New MCP Server'}
          </h4>

          <div className="space-y-3">
            <div className="flex bg-neutral-900 p-1 rounded-lg border border-neutral-700 mb-4">
              <button
                onClick={() => setNewServer(prev => ({ ...prev, type: 'stdio' }))}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${newServer.type === 'stdio' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                Stdio (Local)
              </button>
              <button
                onClick={() => setNewServer(prev => ({ ...prev, type: 'sse' }))}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${newServer.type === 'sse' ? 'bg-neutral-800 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}
              >
                SSE (Remote/URL)
              </button>
            </div>

            {newServer.type === 'stdio' ? (
              <>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1 block">Executable Command</label>
                  <input
                    type="text"
                    value={newServer.command}
                    onChange={(e) => setNewServer(prev => ({ ...prev, command: e.target.value }))}
                    placeholder="e.g. npx, python, node"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1 block">Arguments (one per line)</label>
                  <textarea
                    value={newServer.args}
                    onChange={(e) => setNewServer(prev => ({ ...prev, args: e.target.value }))}
                    placeholder="-y&#10;@modelcontextprotocol/server-everything"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-24 font-mono"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1 block">Environment Variables (JSON)</label>
                  <textarea
                    value={newServer.env}
                    onChange={(e) => setNewServer(prev => ({ ...prev, env: e.target.value }))}
                    placeholder='{"API_KEY": "secret"}'
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-20 font-mono"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium mb-1 block">Server SSE URL</label>
                <input
                  type="text"
                  value={newServer.url}
                  onChange={(e) => setNewServer(prev => ({ ...prev, url: e.target.value }))}
                  placeholder="http://localhost:39300/model_context_protocol/2024-11-05/sse"
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
                />
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={isSaving || (newServer.type === 'stdio' ? !newServer.command : !newServer.url)}
              className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? "Saving..." : (editingIndex !== null ? "Update Server" : "Add Server")}
            </button>
            <button
              onClick={() => { 
                setIsAdding(false); 
                setEditingIndex(null);
                setNewServer({ type: 'stdio', command: '', args: '', env: '', url: '' });
                setError(null); 
              }}
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={confirmDelete}
        title="Remove MCP Server?"
        message="This will disconnect the server and remove its tools from your assistant."
        confirmText="Remove"
      />
    </div>
  );
}

function SidebarButton({ children, active, onClick, icon }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-300 relative group ${
        active
          ? 'text-emerald-400 bg-emerald-500/10'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/5'
      }`}
    >
      <div className={`transition-transform duration-300 ${active ? 'scale-110' : 'group-hover:scale-110'}`}>
        {icon}
      </div>
      <span className={`text-sm font-semibold tracking-wide ${active ? 'opacity-100' : 'opacity-80 group-hover:opacity-100'}`}>
        {children}
      </span>
      {active && (
        <motion.div
           layoutId="sidebar-active"
           className="absolute left-0 w-1 h-6 bg-emerald-500 rounded-r-full shadow-[0_0_10px_rgba(16,185,129,0.5)]"
        />
      )}
    </button>
  );
}

function SettingInput({ label, dbKey, value, onSave, isSaving, placeholder, isSecret, type = "text", allowEmpty = false }) {
  const [inputValue, setInputValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const isConfigured = !!value;

  const handleEditClick = async () => {
    // If it's a secret and we're currently seeing a masked value, fetch the real one
    if (isSecret && value && value.includes('****')) {
      try {
        const unmaskedSettings = await getSettings(true);
        // dbKey is e.g. "GOOGLE_API_KEY", response has "google_api_key"
        const apiKeyField = dbKey.toLowerCase();
        setInputValue(unmaskedSettings[apiKeyField] || '');
      } catch (err) {
        console.error("Failed to fetch unmasked key:", err);
        setInputValue('');
      }
    } else {
      setInputValue(value || '');
    }
    setIsEditing(true);
  };

  const handleSaveClick = async () => {
    if (!allowEmpty && !inputValue.trim()) return;
    await onSave(dbKey, inputValue);
    setIsEditing(false);
    setInputValue('');
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center">
        <label className="text-xs font-medium text-neutral-400 uppercase tracking-wider">{label}</label>
        {isConfigured && !isEditing && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
            Set
          </span>
        )}
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-2">
          {type === "textarea" ? (
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={placeholder}
              className="w-full bg-neutral-900 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 placeholder:text-neutral-600 min-h-[100px] font-mono"
              autoFocus
            />
          ) : (
            <input
              type={(isSecret && !inputValue) ? "password" : "text"} // Mask while typing if it's secret but show if revealed
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={placeholder}
              className="flex-1 bg-neutral-900 border border-neutral-600 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 placeholder:text-neutral-600"
              autoFocus
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={handleSaveClick}
              disabled={isSaving || (!allowEmpty && !inputValue.trim())}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? "..." : "Save"}
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 group">
          <div
            onClick={handleEditClick}
            className={`flex-1 cursor-pointer bg-neutral-900/50 border border-neutral-700/50 rounded-lg px-3 py-2 text-sm text-neutral-300 font-mono hover:border-neutral-600 transition-colors ${type === 'textarea' ? 'whitespace-pre-wrap' : 'truncate'}`}
          >
            {value || <span className="text-neutral-600 italic">Not configured</span>}
          </div>
          <button
            onClick={handleEditClick}
            className="hidden group-hover:block px-2 text-neutral-400 hover:text-white"
          >
            <Pencil size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function ExternalApisManager({ apis, onSave, isSaving }) {
  const [isAdding, setIsAdding] = useState(false);
  const [newApi, setNewApi] = useState({
    name: '',
    description: '',
    url: '',
    method: 'GET',
    headers: '{}',
    body: '',
  });
  const [error, setError] = useState(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [indexToDelete, setIndexToDelete] = useState(null);

  const handleAdd = () => {
    if (!newApi.name.trim() || !newApi.description.trim() || !newApi.url.trim()) {
      setError("Name, description, and URL are required");
      return;
    }

    try {
      const headers = JSON.parse(newApi.headers || '{}');
      const payload = { ...newApi, headers };
      if (newApi.body?.trim()) {
        JSON.parse(newApi.body.trim()); // validate JSON
        payload.body = newApi.body.trim();
      }
      const updatedApis = [...apis, payload];
      onSave(updatedApis);
      setIsAdding(false);
      setNewApi({ name: '', description: '', url: '', method: 'GET', headers: '{}', body: '' });
      setError(null);
    } catch (e) {
      setError(newApi.body?.trim() && e instanceof SyntaxError ? "Invalid JSON for body" : "Invalid JSON for headers");
    }
  };

  const handleDeleteClick = (index) => {
    setIndexToDelete(index);
    setIsConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (indexToDelete === null) return;
    const updatedApis = apis.filter((_, i) => i !== indexToDelete);
    onSave(updatedApis);
    setIndexToDelete(null);
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {apis.length === 0 && !isAdding ? (
          <div className="text-center py-10 bg-neutral-800/20 rounded-xl border border-dashed border-neutral-700">
            <Link size={32} className="mx-auto text-neutral-600 mb-3 opacity-20" />
            <p className="text-sm text-neutral-500">No external APIs configured yet.</p>
          </div>
        ) : (
          apis.map((api, idx) => (
            <div key={idx} className="group bg-neutral-800/30 border border-neutral-700/50 rounded-xl overflow-hidden hover:border-neutral-600 transition-all">
              <div className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-emerald-500/10 rounded-lg text-emerald-400">
                    <Globe size={18} />
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-neutral-100">{api.name}</h4>
                    <p className="text-[11px] text-neutral-500 line-clamp-1">{api.description}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 text-neutral-400 border border-neutral-700 font-mono">{api.method}</span>
                      <span className="text-[10px] text-neutral-600 font-mono truncate max-w-[200px]">{api.url}</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteClick(idx)}
                  className="p-2 text-neutral-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {!isAdding ? (
        <button
          onClick={() => setIsAdding(true)}
          className="w-full py-3 border border-dashed border-neutral-700 hover:border-emerald-500/50 hover:bg-emerald-500/5 rounded-xl text-sm text-neutral-400 hover:text-emerald-400 transition-all flex items-center justify-center gap-2"
        >
          <Plus size={16} />
          Add Custom API Tool
        </button>
      ) : (
        <div className="p-6 bg-neutral-800/50 border border-neutral-700 rounded-xl space-y-4 animate-in slide-in-from-top-2">
          <h4 className="text-sm font-medium text-neutral-200">New API Tool</h4>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Tool Name</label>
              <input
                type="text"
                value={newApi.name}
                onChange={(e) => setNewApi(prev => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. get_weather"
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">HTTP Method</label>
              <select
                value={newApi.method}
                onChange={(e) => setNewApi(prev => ({ ...prev, method: e.target.value }))}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 appearance-none cursor-pointer"
              >
                <option value="GET">GET (query params)</option>
                <option value="POST">POST (body)</option>
                <option value="PUT">PUT (body)</option>
                <option value="PATCH">PATCH (body)</option>
                <option value="DELETE">DELETE (query params)</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Description (For AI context)</label>
            <input
              type="text"
              value={newApi.description}
              onChange={(e) => setNewApi(prev => ({ ...prev, description: e.target.value }))}
              placeholder="e.g. Use this tool to get current weather for a city."
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">API URL (Supports {'{param}'} placeholders)</label>
            <input
              type="text"
              value={newApi.url}
              onChange={(e) => setNewApi(prev => ({ ...prev, url: e.target.value }))}
              placeholder="https://api.example.com/weather?q={city}"
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50"
            />
          </div>

          {(newApi.method === 'POST' || newApi.method === 'PUT' || newApi.method === 'PATCH') && (
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Request body (JSON)</label>
              <textarea
                value={newApi.body}
                onChange={(e) => setNewApi(prev => ({ ...prev, body: e.target.value }))}
                placeholder='{"key": "value"} or use {param_name} for values the AI will fill. Leave empty to send tool parameters as JSON.'
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-24 font-mono"
              />
              <p className="text-[10px] text-neutral-500">Optional. Use <code className="bg-neutral-800 px-1 rounded">{'{param}'}</code> placeholders; the AI will pass those as tool arguments.</p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium">Headers (JSON)</label>
            <textarea
              value={newApi.headers}
              onChange={(e) => setNewApi(prev => ({ ...prev, headers: e.target.value }))}
              placeholder='{"Authorization": "Bearer secret_key"}'
              className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-20 font-mono"
            />
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={isSaving}
              className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {isSaving ? "Saving..." : "Add API Tool"}
            </button>
            <button
              onClick={() => { setIsAdding(false); setError(null); }}
              className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={isConfirmOpen}
        onClose={() => setIsConfirmOpen(false)}
        onConfirm={confirmDelete}
        title="Remove API Tool?"
        message="This will remove the tool and it will no longer be available for the AI."
        confirmText="Remove"
      />
    </div>
  );
}

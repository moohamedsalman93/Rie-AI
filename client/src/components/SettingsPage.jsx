import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getVersion } from '@tauri-apps/api/app';
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getSettings, updateSetting, getLogs, getMcpStatus, getOllamaModels, getRieUsage, downloadEmbeddingModel, getConnectivityIdentity, initPairing, confirmPairing, finalizePairing, getFriends, checkFriendStatus, getNgrokStatus, installNgrok, removeFriend, getPeerAccessCatalog, updateFriendAccess } from '../services/chatApi';
import { setLogsRealtimeHandler, setRealtimeLogsEnabled } from '../services/realtimeClient';
import { ConfirmationModal } from './ConfirmationModal';
import {
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
  Workflow,
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
  AlertTriangle,
  Volume2,
  Copy,
  Check,
  Link,
  ExternalLink,
  Users,
  Fingerprint,
  Wifi
} from 'lucide-react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { listen } from '@tauri-apps/api/event';
import { WINDOW_SIZES } from '../constants/appConfig';

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

const PEER_MEMORY_TOOL_IDS = ['save_memory', 'get_memory', 'search_memory'];

const DEFAULT_SUBAGENTS = [
  {
    name: 'coding_specialist',
    description: 'Expert at modifying and understanding code in the local filesystem.',
    system_prompt: 'You are a coding specialist. You have direct access to the files.',
    tool_ids: [],
    enabled: true,
  },
  {
    name: 'mcp_registry',
    description: 'Expert at managing MCP server connections and registry. Use this to add, update, list, or delete MCP servers.',
    system_prompt: 'You are an MCP registry specialist. You can list, add, update, and delete MCP server configurations. Use your tools to manage the external capabilities of the Rie agent.',
    tool_ids: [],
    enabled: true,
  },
];

function SettingsPage({ onClose }) {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('provider'); // 'provider', 'tools', 'orchestration', ...
  const [savingKey, setSavingKey] = useState(null);
  const [logs, setLogs] = useState('');
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef(null);
  const logsLoadTimeoutRef = useRef(null);

  // Local state for edits
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [enabledTools, setEnabledTools] = useState([]);
  const [subagentsConfig, setSubagentsConfig] = useState([]);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [connectivityIdentity, setConnectivityIdentity] = useState(null);
  const [friends, setFriends] = useState([]);
  const [pairingToken, setPairingToken] = useState('');
  const [pairingPayload, setPairingPayload] = useState('');
  const [incomingPairToken, setIncomingPairToken] = useState('');
  const [receiverPayload, setReceiverPayload] = useState('');
  const [pairingMode, setPairingMode] = useState('sender');
  const [ngrokStatus, setNgrokStatus] = useState(null);
  const [ngrokInstallResult, setNgrokInstallResult] = useState(null);
  const [ngrokInstalling, setNgrokInstalling] = useState(false);
  const [ngrokConfirmOpen, setNgrokConfirmOpen] = useState(false);
  const [ngrokReadyState, setNgrokReadyState] = useState('idle');
  const [ngrokTokenInput, setNgrokTokenInput] = useState('');
  const [ngrokDomainInput, setNgrokDomainInput] = useState('');
  const [connectivityConfigOpen, setConnectivityConfigOpen] = useState(false);
  const [pairModalOpen, setPairModalOpen] = useState(false);
  const [friendStatusById, setFriendStatusById] = useState({});
  const [checkingFriendId, setCheckingFriendId] = useState(null);
  const [removingFriendId, setRemovingFriendId] = useState(null);
  const [connectivityRefreshing, setConnectivityRefreshing] = useState(false);
  const [pairTokenCopied, setPairTokenCopied] = useState(false);
  const [pairPayloadCopied, setPairPayloadCopied] = useState(false);
  const [pairConfirmResult, setPairConfirmResult] = useState(null);
  const [receiverFinalizePayload, setReceiverFinalizePayload] = useState('');
  const [connectivityQuickCopy, setConnectivityQuickCopy] = useState(null);
  const [peerAccessOpen, setPeerAccessOpen] = useState(false);
  const [peerAccessFriend, setPeerAccessFriend] = useState(null);
  const [peerAccessCatalog, setPeerAccessCatalog] = useState(null);
  const [peerAccessProfile, setPeerAccessProfile] = useState('chat');
  const [peerAccessMemory, setPeerAccessMemory] = useState(true);
  const [peerAccessTools, setPeerAccessTools] = useState(() => new Set());
  const [peerAccessUseAllDefault, setPeerAccessUseAllDefault] = useState(true);
  const [peerAccessSaving, setPeerAccessSaving] = useState(false);

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
    setRealtimeLogsEnabled(activeTab === 'logs');
    return () => setRealtimeLogsEnabled(false);
  }, [activeTab]);

  const clearLogsLoadTimeout = useCallback(() => {
    if (logsLoadTimeoutRef.current) {
      clearTimeout(logsLoadTimeoutRef.current);
      logsLoadTimeoutRef.current = null;
    }
  }, []);

  const fetchLogs = useCallback(async () => {
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
      clearLogsLoadTimeout();
      setLoadingLogs(false);
    }
  }, [clearLogsLoadTimeout]);

  useEffect(() => {
    if (activeTab !== 'logs') {
      clearLogsLoadTimeout();
      setLogsRealtimeHandler(null);
      return;
    }
    setLoadingLogs(true);
    setLogsRealtimeHandler((payload) => {
      if (payload.action === 'snapshot') {
        setLogs(payload.text || '');
        clearLogsLoadTimeout();
        setLoadingLogs(false);
      }
      if (payload.action === 'append') {
        setLogs((prev) => (prev || '') + (payload.text || ''));
        clearLogsLoadTimeout();
        setLoadingLogs(false);
      }
    });

    // Always fetch once on tab-open so logs render even if realtime is unavailable.
    fetchLogs();

    // Guard against indefinite spinner if both realtime and HTTP are unavailable.
    logsLoadTimeoutRef.current = setTimeout(() => {
      setLoadingLogs(false);
    }, 8000);

    return () => {
      clearLogsLoadTimeout();
      setLogsRealtimeHandler(null);
    };
  }, [activeTab, clearLogsLoadTimeout, fetchLogs]);

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
      setSubagentsConfig(Array.isArray(data.subagents_config) && data.subagents_config.length > 0 ? data.subagents_config : DEFAULT_SUBAGENTS);

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
      await loadConnectivityData();
    } catch (err) {
      console.error("Settings load error:", err);
      setError("Failed to load settings: " + (err.message || String(err)));
    } finally {
      setLoading(false);
    }
  };

  const loadConnectivityData = useCallback(async () => {
    try {
      const [identityData, friendsData, tunnelStatus] = await Promise.all([
        getConnectivityIdentity(),
        getFriends(),
        getNgrokStatus(),
      ]);
      setConnectivityIdentity(identityData);
      setFriends(Array.isArray(friendsData) ? friendsData : []);
      setNgrokStatus(tunnelStatus);
      setNgrokReadyState(tunnelStatus?.ready_state || 'not_ready');
    } catch (err) {
      console.error('Failed to load connectivity data:', err);
    }
  }, []);

  useEffect(() => {
    const onConn = () => loadConnectivityData();
    window.addEventListener('rie-connectivity-refresh', onConn);
    return () => window.removeEventListener('rie-connectivity-refresh', onConn);
  }, [loadConnectivityData]);

  const handleRefreshConnectivity = async () => {
    try {
      setConnectivityRefreshing(true);
      await loadConnectivityData();
    } finally {
      setConnectivityRefreshing(false);
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

  const handleInitPairing = async () => {
    try {
      setPairConfirmResult(null);
      const result = await initPairing(settings.connectivity_device_name || connectivityIdentity?.name || null);
      setPairingToken(result.pairing_token || '');
      setConnectivityIdentity(result.identity || null);
    } catch (err) {
      setError(`Failed to start pairing: ${err.message}`);
    }
  };

  const handleGeneratePairingPayload = async () => {
    try {
      const token = incomingPairToken.trim();
      if (!token) {
        setError('Paste a pairing token first.');
        return;
      }
      let identity = connectivityIdentity;
      if (!identity?.device_id || !identity?.fingerprint || !identity?.public_key) {
        identity = await getConnectivityIdentity();
        setConnectivityIdentity(identity);
      }
      if (!identity?.device_id || !identity?.fingerprint || !identity?.public_key) {
        throw new Error('Unable to load local identity. Refresh Connectivity and try again.');
      }
      const payload = {
        pairing_token: token,
        peer_name: (identity?.name || settings.connectivity_device_name || 'My Rie').trim(),
        peer_device_id: identity.device_id,
        peer_fingerprint: identity.fingerprint,
        peer_public_key: identity.public_key,
        peer_public_url: identity.public_url || null,
      };
      setReceiverPayload(JSON.stringify(payload, null, 2));
      setError(null);
    } catch (err) {
      setError(`Failed to generate pairing payload: ${err.message}`);
    }
  };

  const handleConfirmPairing = async () => {
    try {
      const parsed = JSON.parse(pairingPayload || '{}');
      const result = await confirmPairing(parsed);
      setPairConfirmResult(result || null);
      setPairingPayload(result?.reciprocal_synced ? '' : pairingPayload);
      await loadConnectivityData();
    } catch (err) {
      setError(`Failed to confirm pairing: ${err.message}`);
    }
  };

  const handleReceiverFinalize = async () => {
    try {
      const parsed = JSON.parse(receiverFinalizePayload || '{}');
      await finalizePairing(parsed);
      setReceiverFinalizePayload('');
      await loadConnectivityData();
      setPairModalOpen(false);
    } catch (err) {
      setError(`Failed to finalize pairing on this device: ${err.message}`);
    }
  };

  const handleOpenPairModal = () => {
    setPairModalOpen(true);
    setPairingMode('sender');
    setPairTokenCopied(false);
    setPairPayloadCopied(false);
    setPairConfirmResult(null);
    setReceiverFinalizePayload('');
  };

  const handleCheckFriendStatus = async (friendId) => {
    try {
      setCheckingFriendId(friendId);
      const result = await checkFriendStatus(friendId);
      setFriendStatusById(prev => ({ ...prev, [friendId]: result }));
    } catch (err) {
      setFriendStatusById(prev => ({
        ...prev,
        [friendId]: { status: 'offline', message: err.message, checked_at: new Date().toISOString(), reachable: false }
      }));
    } finally {
      setCheckingFriendId(null);
    }
  };

  const handleRemoveFriend = async (friendId, friendName) => {
    const displayName = (friendName || "this paired device").trim() || "this paired device";
    const confirmed = window.confirm(`Remove pairing with ${displayName}?`);
    if (!confirmed) return;

    try {
      setRemovingFriendId(friendId);
      await removeFriend(friendId);
      setFriendStatusById((prev) => {
        const next = { ...prev };
        delete next[friendId];
        return next;
      });
      await loadConnectivityData();
    } catch (err) {
      setError(`Failed to remove pairing: ${err.message}`);
    } finally {
      setRemovingFriendId(null);
    }
  };

  const getEligibleForProfile = (cat, profile) => {
    if (!cat) return [];
    return profile === 'chat' ? (cat.chat_eligible || []) : (cat.agent_eligible || []);
  };

  const openPeerAccessModal = async (friend) => {
    setPeerAccessFriend(friend);
    setPeerAccessOpen(true);
    setError(null);
    try {
      const cat = await getPeerAccessCatalog();
      setPeerAccessCatalog(cat);
      const policy = friend.peer_access || {};
      const profile = policy.receive_profile === 'agent' ? 'agent' : 'chat';
      setPeerAccessProfile(profile);
      const memOn = policy.memory_enabled !== false;
      setPeerAccessMemory(memOn);
      const eligible = profile === 'chat' ? cat.chat_eligible || [] : cat.agent_eligible || [];
      const useAll = policy.allowed_tool_ids == null;
      setPeerAccessUseAllDefault(useAll);
      const selected = new Set();
      if (useAll) {
        eligible.forEach((id) => selected.add(id));
        if (!memOn) {
          PEER_MEMORY_TOOL_IDS.forEach((id) => selected.delete(id));
        }
      } else {
        (policy.allowed_tool_ids || []).forEach((id) => selected.add(id));
      }
      setPeerAccessTools(selected);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Failed to load peer access settings');
    }
  };

  const handlePeerProfileChange = (profile) => {
    setPeerAccessProfile(profile);
    if (!peerAccessCatalog) return;
    const eligible = getEligibleForProfile(peerAccessCatalog, profile);
    if (peerAccessUseAllDefault) {
      const s = new Set(eligible);
      if (!peerAccessMemory) {
        PEER_MEMORY_TOOL_IDS.forEach((id) => s.delete(id));
      }
      setPeerAccessTools(s);
      return;
    }
    const e = new Set(eligible);
    setPeerAccessTools((prev) => {
      const next = new Set();
      prev.forEach((id) => {
        if (e.has(id)) next.add(id);
      });
      return next;
    });
  };

  const handlePeerMemoryToggle = (next) => {
    setPeerAccessMemory(next);
    const eligible = getEligibleForProfile(peerAccessCatalog, peerAccessProfile);
    const eligibleSet = new Set(eligible);
    setPeerAccessTools((prev) => {
      const n = new Set(prev);
      PEER_MEMORY_TOOL_IDS.forEach((id) => {
        if (!eligibleSet.has(id)) return;
        if (next) n.add(id);
        else n.delete(id);
      });
      return n;
    });
  };

  const handleSavePeerAccess = async () => {
    if (!peerAccessFriend) return;
    setPeerAccessSaving(true);
    try {
      const payload = {
        receive_profile: peerAccessProfile,
        memory_enabled: peerAccessMemory,
      };
      if (!peerAccessUseAllDefault) {
        payload.allowed_tool_ids = Array.from(peerAccessTools);
      }
      const updated = await updateFriendAccess(peerAccessFriend.id, payload);
      setFriends((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
      setPeerAccessOpen(false);
      setPeerAccessFriend(null);
    } catch (err) {
      setError(err.message || 'Failed to save peer access');
    } finally {
      setPeerAccessSaving(false);
    }
  };

  const handleInstallNgrok = async () => {
    try {
      if (!ngrokTokenInput.trim()) {
        setError('ngrok auth token is required.');
        return;
      }
      setNgrokConfirmOpen(false);
      setNgrokInstalling(true);
      setNgrokInstallResult(null);
      setNgrokReadyState('starting');
      const result = await installNgrok(ngrokTokenInput.trim(), ngrokDomainInput.trim() || null);
      setNgrokInstallResult(result);
      setNgrokReadyState(result?.ready_state || (result?.ok ? 'ready' : 'failed'));
      await loadSettings();
    } catch (err) {
      setNgrokInstallResult({ ok: false, steps: [{ step: 'install', ok: false, message: err.message }] });
      setNgrokReadyState('failed');
    } finally {
      setNgrokInstalling(false);
    }
  };

  const handleToolToggle = async (toolId) => {
    const newTools = enabledTools.includes(toolId)
      ? enabledTools.filter(t => t !== toolId)
      : [...enabledTools, toolId];

    setEnabledTools(newTools);
    await handleSaveSetting('ENABLED_TOOLS', JSON.stringify(newTools));
  };

  const handleOpenPlannerWindow = async () => {
    if (!window.__TAURI_INTERNALS__) {
      window.open(`${window.location.origin}${window.location.pathname}?view=planner`, '_blank');
      return;
    }
    try {
      const existing = await WebviewWindow.getByLabel("planner");
      if (existing) {
        await existing.show();
        await existing.setFocus();
        return;
      }
      const plannerUrl = `${window.location.origin}${window.location.pathname}?view=planner`;
      const plannerWindow = new WebviewWindow("planner", {
        title: "Boss Team Planner",
        url: plannerUrl,
        width: WINDOW_SIZES.SETTINGS.width + 120,
        height: WINDOW_SIZES.SETTINGS.height + 80,
        resizable: true,
        center: true,
        decorations: false,
      });
      plannerWindow.once("tauri://created", async () => {
        try {
          await plannerWindow.show();
          await plannerWindow.setFocus();
        } catch {
          // no-op
        }
      });
      plannerWindow.once("tauri://error", (e) => {
        console.error("Failed to create planner window:", e);
      });
    } catch (err) {
      console.error("Failed to open planner window:", err);
    }
  };

  const connectivityChipState = (() => {
    if (!ngrokStatus?.installed) return 'not install';
    const needsConfig = !ngrokStatus?.public_url;
    if (needsConfig || !ngrokStatus?.tunnel_running) return 'config needed';
    return 'running';
  })();

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
        <div className="w-64 relative bg-neutral-950/50 border-r border-white/5 flex flex-col p-4 gap-1.5 shrink-0 overflow-y-auto custom-scrollbar">

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
            Capability
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

          <div className="text-[10px] font-bold text-neutral-500 uppercase tracking-[0.2em] px-3 py-3 mt-4 mb-1">
            Advanced Topics
          </div>

          <SidebarButton
            active={activeTab === 'orchestration'}
            onClick={() => setActiveTab('orchestration')}
            icon={<Workflow size={18} />}
          >
            Orchestration & Planner
          </SidebarButton>

          <SidebarButton
            active={activeTab === 'connectivity'}
            onClick={() => setActiveTab('connectivity')}
            icon={<Link size={18} />}
          >
            Connectivity
          </SidebarButton>

          

          <div className="mt-auto pt-1 px-3 border-t border-white/5  w-full bg-neutral-950/50">
            <div className=" rounded-2xlborder border-white/5">
              <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-1">Version</div>
              <div className="text-xs font-semibold text-white">Rie-AI v{appVersion}</div>
            </div>
          </div>
        </div>

        {/* Content Area — min-w-0 lets this flex child shrink; overflow-x-hidden avoids horizontal scroll from wide content / absolute decor */}
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-8 custom-scrollbar bg-neutral-900/50">
          {loading ? (
            <div className="flex justify-center py-20">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          ) : (
            <div
              className={`mx-auto space-y-8 animate-in fade-in duration-300 slide-in-from-bottom-2 `}
            >

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

              {/* CAPABILITY TAB */}
              {activeTab === 'tools' && (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold text-white tracking-tight">Capability</h3>
                    <p className="text-sm text-neutral-500">Manage your assistant capabilities: built-in tools, MCP servers, and external APIs.</p>
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

                  {/* External APIs section */}
                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <div className="flex items-center gap-3 pb-4 border-b border-white/5">
                      <div className="p-2 bg-purple-500/10 rounded-lg text-purple-400">
                        <Link size={16} />
                      </div>
                      <h4 className="text-sm font-bold text-white tracking-wide uppercase">External APIs</h4>
                    </div>

                    <p className="text-xs text-neutral-500 leading-relaxed max-w-xl">
                      Connect custom API endpoints as tools for the agent. GET/DELETE use query params, while POST/PUT/PATCH send a body.
                    </p>
                    <p className="text-xs text-neutral-500 leading-relaxed max-w-xl">
                      Use Request body (JSON) for fixed or templated payloads, for example <code className="bg-neutral-800 px-1 rounded">{'{"query": "{query}"}'}</code>.
                    </p>

                    <div className="pt-2">
                      <ExternalApisManager
                        apis={settings.external_apis || []}
                        onSave={(updatedApis) => handleSaveSetting('EXTERNAL_APIS', JSON.stringify(updatedApis))}
                        isSaving={savingKey === 'EXTERNAL_APIS'}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ORCHESTRATION & PLANNER TAB */}
              {activeTab === 'orchestration' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="space-y-1">
                    <h3 className="text-xl font-bold text-white tracking-tight">Orchestration &amp; Planner</h3>
                    <p className="text-sm text-neutral-500">
                      Choose how agents are structured: one main agent, or a planner-led team with separate roles.
                    </p>
                  </div>

                  <div className="premium-card rounded-2xl p-6 space-y-6">
                    <div className="space-y-3 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-neutral-400">Orchestration Mode</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveSetting('AGENT_ORCHESTRATION_MODE', 'solo')}
                          className={`px-3 py-1.5 rounded-lg text-xs border ${
                            (settings.agent_orchestration_mode || 'team') === 'solo'
                              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                              : 'bg-white/[0.02] border-white/10 text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          Solo (Main only)
                        </button>
                        <button
                          type="button"
                          onClick={() => handleSaveSetting('AGENT_ORCHESTRATION_MODE', 'team')}
                          className={`px-3 py-1.5 rounded-lg text-xs border ${
                            (settings.agent_orchestration_mode || 'team') === 'team'
                              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                              : 'bg-white/[0.02] border-white/10 text-neutral-400 hover:text-neutral-200'
                          }`}
                        >
                          Team (Planner delegation)
                        </button>
                      </div>
                      {(settings.agent_orchestration_mode || 'team') === 'solo' ? (
                        <div className="text-sm text-neutral-500 leading-relaxed space-y-1">
                          <div className="text-neutral-300 font-medium text-xs uppercase tracking-wider">
                            Solo
                          </div>
                          <p>
                            One main agent runs the full workflow: reasoning, tool use, and answers stay in a single
                            pipeline with one shared configuration.
                          </p>
                          <p className="text-neutral-500 text-xs">
                            Use this when you want the simplest setup and do not need separate roles or delegated
                            sub-agents.
                          </p>
                        </div>
                      ) : (
                        <div className="text-sm text-neutral-500 leading-relaxed space-y-1">
                          <div className="text-neutral-300 font-medium text-xs uppercase tracking-wider">
                            Team
                          </div>
                          <p>
                            The planner breaks work into steps and delegates to a boss and member agents. Each role can
                            have its own tools, external APIs, and instructions.
                          </p>
                          <p className="text-neutral-500 text-xs">
                            Use this when tasks benefit from structured delegation or when different agents should use
                            different capabilities.
                          </p>
                        </div>
                      )}
                    </div>

                    

                    <button
                      type="button"
                      onClick={handleOpenPlannerWindow}
                      className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors"
                    >
                      Open planner
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'connectivity' && (
                <div className="relative overflow-x-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="pointer-events-none absolute -right-16 -top-12 h-56 w-56 rounded-full bg-white/[0.03] blur-3xl" />

                  <div className="relative flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-neutral-900/80 ring-1 ring-white/[0.04]">
                        <Link className="h-6 w-6 text-neutral-300" strokeWidth={2} aria-hidden />
                      </div>
                      <div className="space-y-1.5 min-w-0">
                        <h3 className="text-2xl font-bold tracking-tight text-white">Remote access & pairing</h3>
                        <p className="max-w-xl text-sm leading-relaxed text-neutral-500">
                          Expose your agent safely through ngrok, then pair trusted devices so friends can reach this instance
                          at a stable URL.
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 lg:justify-end shrink-0">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900/80 px-3 py-1.5 text-[11px] text-neutral-300">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            connectivityChipState === 'running' ? 'bg-emerald-500/80' : connectivityChipState === 'not install' ? 'bg-red-400/80' : 'bg-amber-400/90'
                          }`}
                        />
                        Tunnel: <span className="font-semibold text-neutral-100">{connectivityChipState}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900/80 px-3 py-1.5 text-[11px] text-neutral-300">
                        <Users size={12} className="text-neutral-500" aria-hidden />
                        Pairs: <span className="font-semibold text-neutral-100">{friends.length}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-neutral-900/80 px-3 py-1.5 text-[11px] text-neutral-300">
                        Ready:{' '}
                        <span className="font-mono text-[10px] font-semibold uppercase text-neutral-100">{ngrokReadyState || '—'}</span>
                      </span>
                    </div>
                  </div>

                  <div className="relative mt-5 rounded-2xl border border-amber-500/30 bg-amber-950/20 p-4 sm:p-5">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-500/10">
                        <AlertTriangle className="h-4 w-4 text-amber-300" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-amber-200">Warning before using connectivity</h4>
                        <p className="mt-1 text-xs leading-relaxed text-amber-100/85">
                          Opening remote connectivity can expose your local agent to the internet. This may lead to
                          unauthorized access or data leakage if you share endpoints with untrusted devices.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="relative mt-8 grid grid-cols-1 gap-6 xl:grid-cols-12">
                    <div className="xl:col-span-7 space-y-4">
                      <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-neutral-950/80 p-1 shadow-lg shadow-black/20">
                        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                        <div className="rounded-[14px] bg-neutral-950/90 p-5 sm:p-6">
                          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex gap-4 min-w-0">
                              <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-neutral-900/80">
                                <Wifi className="h-5 w-5 text-neutral-400" aria-hidden />
                                {connectivityChipState === 'running' ? (
                                  <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5 rounded-full bg-emerald-500/90 ring-2 ring-neutral-950" title="Tunnel running" />
                                ) : null}
                              </div>
                              <div className="min-w-0 space-y-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <h4 className="text-base font-semibold text-white">ngrok public tunnel</h4>
                                  <span
                                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                                      connectivityChipState === 'running'
                                        ? 'border-emerald-500/25 bg-emerald-950/40 text-emerald-200/90'
                                        : connectivityChipState === 'not install'
                                        ? 'border-red-500/25 bg-red-950/35 text-red-200/85'
                                        : 'border-amber-500/25 bg-amber-950/35 text-amber-200/85'
                                    }`}
                                  >
                                    {connectivityChipState}
                                  </span>
                                </div>
                                <p className="text-xs leading-relaxed text-neutral-500">
                                  When enabled, Rie can advertise an HTTPS URL peers use instead of a LAN address.
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-3 rounded-xl border border-white/5 bg-neutral-900/50 px-3 py-2">
                              <span className="text-[11px] font-medium text-neutral-400">Expose tunnel</span>
                              <button
                                type="button"
                                onClick={() => handleSaveSetting('CONNECTIVITY_NGROK_ENABLED', String(!settings.connectivity_ngrok_enabled))}
                                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-all duration-300 ${
                                  settings.connectivity_ngrok_enabled
                                    ? 'bg-emerald-700/85'
                                    : 'border border-neutral-700 bg-neutral-800'
                                }`}
                                aria-label="Toggle ngrok tunnel"
                              >
                                <motion.span
                                  animate={{ x: settings.connectivity_ngrok_enabled ? 28 : 4 }}
                                  className="inline-block h-5 w-5 rounded-full bg-white shadow-md"
                                />
                              </button>
                            </div>
                          </div>

                          <div className="mt-6 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-xl border border-white/10 bg-black/30 p-4">
                              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">Engine state</div>
                              <p className="mt-2 font-mono text-sm font-semibold text-white">{ngrokReadyState || 'unknown'}</p>
                            </div>
                            <div className="rounded-xl border border-white/10 bg-black/30 p-4 sm:col-span-1">
                              <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">Public HTTPS</div>
                              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <p className="min-w-0 break-all font-mono text-[11px] leading-snug text-neutral-200">
                                  {ngrokStatus?.public_url || (
                                    <span className="text-neutral-500">Not assigned — run tunnel config when you are ready.</span>
                                  )}
                                </p>
                                {ngrokStatus?.public_url ? (
                                  <motion.button
                                    type="button"
                                    whileTap={{ scale: 0.97 }}
                                    onClick={async () => {
                                      try {
                                        await navigator.clipboard.writeText(ngrokStatus.public_url);
                                        setConnectivityQuickCopy('url');
                                        setTimeout(() => setConnectivityQuickCopy(null), 1400);
                                      } catch {
                                        /* ignore */
                                      }
                                    }}
                                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/12 bg-neutral-900/70 px-2.5 py-1.5 text-[10px] font-medium text-neutral-300 hover:border-white/18 hover:bg-neutral-800 hover:text-neutral-100"
                                  >
                                    {connectivityQuickCopy === 'url' ? <Check size={12} /> : <Copy size={12} />}
                                    {connectivityQuickCopy === 'url' ? 'Copied' : 'Copy'}
                                  </motion.button>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-white/5 pt-5">
                            <motion.button
                              whileTap={{ scale: 0.97 }}
                              onClick={() => setConnectivityConfigOpen(true)}
                              className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-600 bg-neutral-900/60 px-3.5 py-2.5 text-xs font-medium text-neutral-100 transition-colors hover:border-neutral-500 hover:bg-neutral-800"
                            >
                              <Settings size={14} aria-hidden />
                              Tunnel setup
                            </motion.button>
                            <motion.button
                              whileTap={{ scale: 0.97 }}
                              onClick={handleOpenPairModal}
                              className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-950/45 px-3.5 py-2.5 text-xs font-medium text-emerald-100/95 transition-colors hover:border-emerald-500/50 hover:bg-emerald-950/70"
                            >
                              <Plus size={14} aria-hidden />
                              Pair a device
                            </motion.button>
                            <button
                              type="button"
                              onClick={handleRefreshConnectivity}
                              disabled={connectivityRefreshing}
                              className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-700 px-3.5 py-2.5 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <RefreshCw size={14} className={connectivityRefreshing ? 'animate-spin' : ''} aria-hidden />
                              Refresh
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="xl:col-span-5">
                      <div className="h-full rounded-2xl border border-white/[0.08] bg-neutral-950/70 p-5 shadow-lg shadow-black/15">
                        <div className="flex items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-neutral-900/80">
                            <Fingerprint className="h-5 w-5 text-neutral-400" aria-hidden />
                          </div>
                          <div className="min-w-0">
                            <h5 className="text-sm font-semibold text-white">This device</h5>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500">
                              Shown to the other device when you start a pairing handoff.
                            </p>
                          </div>
                        </div>

                        <div className="mt-5 space-y-4">
                          <div className="rounded-xl border border-white/10 bg-black/25 p-3">
                            <SettingInput
                              label="Device display name"
                              dbKey="CONNECTIVITY_DEVICE_NAME"
                              value={settings.connectivity_device_name ?? connectivityIdentity?.name ?? ''}
                              onSave={handleSaveSetting}
                              isSaving={savingKey === 'CONNECTIVITY_DEVICE_NAME'}
                              placeholder="e.g. My Rie"
                              allowEmpty={false}
                            />
                          </div>

                          <div className="rounded-xl border border-white/10 bg-black/25 p-4">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-500">Identity ID</span>
                              {connectivityIdentity?.device_id ? (
                                <motion.button
                                  type="button"
                                  whileTap={{ scale: 0.97 }}
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(connectivityIdentity.device_id);
                                      setConnectivityQuickCopy('id');
                                      setTimeout(() => setConnectivityQuickCopy(null), 1400);
                                    } catch {
                                      /* ignore */
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 rounded-lg border border-neutral-600 px-2 py-1 text-[10px] font-medium text-neutral-300 hover:border-neutral-500"
                                >
                                  {connectivityQuickCopy === 'id' ? <Check size={11} /> : <Copy size={11} />}
                                  {connectivityQuickCopy === 'id' ? 'Copied' : 'Copy'}
                                </motion.button>
                              ) : null}
                            </div>
                            <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-neutral-200 selection:bg-neutral-600">
                              {connectivityIdentity?.device_id || '—'}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="relative mt-2 rounded-2xl border border-white/[0.08] bg-neutral-950/60 p-5 sm:p-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-900 ring-1 ring-white/10">
                          <Users className="h-5 w-5 text-neutral-200" aria-hidden />
                        </div>
                        <div>
                          <h5 className="text-sm font-semibold text-white">Trusted peers</h5>
                          <p className="text-[11px] text-neutral-500">
                            Last health check is per-row — tap the refresh control to update.
                          </p>
                        </div>
                      </div>
                      <span className="self-start rounded-full border border-white/10 bg-neutral-900/80 px-3 py-1 text-[11px] text-neutral-400 sm:self-center">
                        {friends.length} linked {friends.length === 1 ? 'device' : 'devices'}
                      </span>
                    </div>

                    {friends.length === 0 ? (
                      <div className="mt-6 rounded-2xl border border-dashed border-neutral-700/80 bg-neutral-900/20 px-6 py-14 text-center">
                        <p className="text-sm font-medium text-neutral-300">No peers linked yet</p>
                        <p className="mx-auto mt-1 max-w-sm text-xs text-neutral-500">
                          Pair another Rie install so you can route work or share context across machines.
                        </p>
                        <motion.button
                          whileTap={{ scale: 0.97 }}
                          onClick={handleOpenPairModal}
                          className="mt-5 inline-flex items-center gap-2 rounded-xl border border-emerald-500/35 bg-emerald-950/45 px-4 py-2.5 text-xs font-medium text-emerald-100/95 transition-colors hover:border-emerald-500/50 hover:bg-emerald-950/70"
                        >
                          <Plus size={14} aria-hidden />
                          Start pairing
                        </motion.button>
                      </div>
                    ) : (
                      <ul className="mt-6 space-y-3">
                        {friends.map((friend) => {
                          const statusRow = friendStatusById[friend.id];
                          const reachable = statusRow?.reachable === true;
                          const hasStatus = !!statusRow;
                          const initials = (friend.name || '?')
                            .trim()
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((w) => w[0]?.toUpperCase())
                            .join('');
                          return (
                            <li key={friend.id}>
                              <div className="overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/35 transition-colors hover:bg-neutral-900/55">
                                <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5">
                                  <div className="flex min-w-0 flex-1 gap-3">
                                    
                                    <div className="min-w-0 flex-1 space-y-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate font-semibold text-white" title={friend.name || 'Unnamed friend'}>
                                          {friend.name || 'Unnamed friend'}
                                        </span>
                                        <span
                                          className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                                            !hasStatus
                                              ? 'border-neutral-600 bg-neutral-800/80 text-neutral-400'
                                              : reachable
                                              ? 'border-emerald-500/25 bg-emerald-950/45 text-emerald-200/90'
                                              : 'border-red-500/25 bg-red-950/35 text-red-200/85'
                                          }`}
                                        >
                                          {!hasStatus ? 'unknown' : reachable ? 'online' : 'offline'}
                                        </span>
                                      </div>
                                      <p
                                        className="break-all font-mono text-[10px] leading-relaxed text-neutral-500"
                                        title={friend.public_url || undefined}
                                      >
                                        {friend.public_url || 'No public endpoint saved'}
                                      </p>
                                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-500">
                                        <span>
                                          Latency{' '}
                                          <span className="tabular-nums text-neutral-300">
                                            {statusRow?.latency_ms != null ? `${statusRow.latency_ms} ms` : '—'}
                                          </span>
                                        </span>
                                        <span>
                                          Checked{' '}
                                          <span className="text-neutral-400">
                                            {statusRow?.checked_at ? new Date(statusRow.checked_at).toLocaleString() : '—'}
                                          </span>
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
                                    <motion.button
                                      type="button"
                                      whileTap={{ scale: 0.97 }}
                                      onClick={() => openPeerAccessModal(friend)}
                                      disabled={removingFriendId === friend.id}
                                      className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-neutral-900/60 p-2.5 text-neutral-400 transition-colors hover:border-white/15 hover:bg-neutral-800/90 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                                      title="Inbound access — tools and memory"
                                      aria-label="Configure peer access"
                                    >
                                      <Shield size={16} aria-hidden />
                                    </motion.button>
                                    <motion.button
                                      type="button"
                                      whileTap={{ scale: 0.97 }}
                                      onClick={() => handleRemoveFriend(friend.id, friend.name)}
                                      disabled={removingFriendId === friend.id}
                                      className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-neutral-900/60 p-2.5 text-neutral-400 transition-colors hover:border-red-500/35 hover:bg-red-950/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                                      title="Remove pairing"
                                      aria-label={removingFriendId === friend.id ? 'Removing pairing' : 'Remove pairing'}
                                    >
                                      <Trash2 size={16} aria-hidden />
                                    </motion.button>
                                    <motion.button
                                      type="button"
                                      whileTap={{ scale: 0.97 }}
                                      onClick={() => handleCheckFriendStatus(friend.id)}
                                      disabled={checkingFriendId === friend.id || removingFriendId === friend.id}
                                      className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-neutral-900/60 p-2.5 text-neutral-400 transition-colors hover:border-white/15 hover:bg-neutral-800/90 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
                                      title="Ping peer health"
                                      aria-label={checkingFriendId === friend.id ? 'Checking status' : 'Check status'}
                                    >
                                      <RefreshCw size={16} className={checkingFriendId === friend.id ? 'animate-spin' : ''} aria-hidden />
                                    </motion.button>
                                  </div>
                                </div>
                                {statusRow?.failure_code ? (
                                  <div className="border-t border-white/[0.06] bg-neutral-900/40 px-4 py-2.5 text-[11px] text-neutral-300">
                                    <span className="font-medium text-neutral-200">Issue:</span>{' '}
                                    {statusRow.failure_code}
                                    {statusRow?.failure_stage ? ` (${statusRow.failure_stage})` : ''}
                                  </div>
                                ) : null}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
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

                    <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-blue-500/10 rounded-lg text-blue-400">
                          <Info size={16} />
                        </div>
                        <div>
                          <h4 className="text-sm font-bold text-neutral-200">Human-in-the-Loop (HITL)</h4>
                          <p className="text-[11px] text-neutral-500 max-w-xs">
                            Choose how approvals are handled for potentially risky tool calls.
                          </p>
                        </div>
                      </div>
                      <div className=" max-w-xs">
                        <select
                          value={settings.hitl_mode || (settings.hitl_enabled ? 'always' : 'disable')}
                          onChange={(e) => handleSaveSetting('HITL_MODE', e.target.value)}
                          disabled={savingKey === "HITL_MODE"}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-200 text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-70 disabled:cursor-not-allowed"
                        >
                          <option value="disable">Disable</option>
                          <option value="always">Always ask</option>
                          <option value="let_decide">Let AI decide</option>
                        </select>
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
      <ConfirmationModal
        isOpen={ngrokConfirmOpen}
        onClose={() => setNgrokConfirmOpen(false)}
        onConfirm={handleInstallNgrok}
        title="Install ngrok Tunnel?"
        message="Rie will download ngrok if needed, then start a tunnel using your token and save the public endpoint."
        confirmText="Install"
        cancelText="Cancel"
        type="warning"
      />
      <AnimatePresence>
        {connectivityConfigOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="w-full max-w-xl rounded-2xl border border-neutral-700 bg-neutral-950 p-5 space-y-4"
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold text-white">Connection Config</h4>
                <button onClick={() => setConnectivityConfigOpen(false)} className="text-neutral-400 hover:text-white text-xs cursor-pointer">Close</button>
              </div>
              <input
                type="password"
                value={ngrokTokenInput}
                onChange={(e) => setNgrokTokenInput(e.target.value)}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200"
                placeholder="Paste ngrok auth token"
              />
              <input
                type="text"
                value={ngrokDomainInput}
                onChange={(e) => setNgrokDomainInput(e.target.value)}
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200"
                placeholder="Optional reserved domain (leave empty for random)"
              />
              <div className="flex items-center gap-2">
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={() => {
                    if (ngrokStatus?.installed) {
                      handleInstallNgrok();
                      return;
                    }
                    setNgrokConfirmOpen(true);
                  }}
                  disabled={ngrokInstalling || !ngrokTokenInput.trim()}
                  className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer transition-colors"
                >
                  {ngrokInstalling ? 'Setting up...' : 'Run Setup'}
                </motion.button>
                <button onClick={handleRefreshConnectivity} disabled={connectivityRefreshing} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-neutral-700 text-neutral-300 text-xs cursor-pointer disabled:opacity-60">
                  <RefreshCw size={14} className={connectivityRefreshing ? "animate-spin" : ""} />
                  Refresh
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {pairModalOpen && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="flex min-h-0 max-h-[min(90vh,920px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl"
            >
              <div className="shrink-0 space-y-3 border-b border-neutral-800 px-5 pb-4 pt-5">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-bold text-white">New Pair</h4>
                  <button type="button" onClick={() => setPairModalOpen(false)} className="shrink-0 text-neutral-400 hover:text-white text-xs cursor-pointer">
                    Close
                  </button>
                </div>
                <p className="text-xs text-neutral-400">Choose your role, then follow the stepper.</p>
                <div className="inline-flex max-w-full flex-wrap rounded-lg border border-neutral-700 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPairingMode('sender')}
                    className={`px-3 py-1.5 text-xs font-semibold transition-colors ${pairingMode === 'sender' ? 'bg-emerald-600 text-white' : 'bg-neutral-900 text-neutral-300'}`}
                  >
                    This is Device A (sender)
                  </button>
                  <button
                    type="button"
                    onClick={() => setPairingMode('receiver')}
                    className={`px-3 py-1.5 text-xs font-semibold transition-colors ${pairingMode === 'receiver' ? 'bg-indigo-600 text-white' : 'bg-neutral-900 text-neutral-300'}`}
                  >
                    This is Device B (receiver)
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(() => {
                    const labels = [
                      pairingMode === 'sender' ? 'Create token' : 'Paste token',
                      pairingMode === 'sender' ? 'Share token' : 'Generate payload',
                      pairingMode === 'sender' ? 'Confirm pairing' : 'Send payload back',
                    ];
                    const currentStep = pairingMode === 'sender'
                      ? (pairingToken ? (pairingPayload.trim() ? 3 : 2) : 1)
                      : (incomingPairToken.trim() ? (receiverPayload.trim() ? 3 : 2) : 1);

                    return labels.map((label, idx) => {
                      const stepNum = idx + 1;
                      const isCurrent = stepNum === currentStep;
                      const isDone = stepNum < currentStep;

                      return (
                        <div
                          key={label}
                          className={`rounded-xl border px-3 py-3 text-xs transition-colors ${isCurrent
                            ? 'border-emerald-500/80 bg-emerald-500/15 text-emerald-100'
                            : isDone
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                              : 'border-neutral-700 bg-neutral-900/60 text-neutral-400'
                            }`}
                        >
                          <div className="font-bold">Step {stepNum}</div>
                          <div className="mt-0.5">{label}</div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
                {pairingMode === 'sender' ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-2">
                      <motion.button whileTap={{ scale: 0.97 }} onClick={handleInitPairing} className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold cursor-pointer transition-colors">Create Pair Token</motion.button>
                      {pairingToken && (
                        <motion.button
                          whileTap={{ scale: 0.97 }}
                          onClick={async () => {
                            await navigator.clipboard.writeText(pairingToken);
                            setPairTokenCopied(true);
                            setTimeout(() => setPairTokenCopied(false), 1200);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-neutral-700 text-neutral-200 text-xs cursor-pointer hover:border-neutral-500 transition-colors"
                        >
                          {pairTokenCopied ? <Check size={14} className="text-emerald-300" /> : <Copy size={14} />}
                          {pairTokenCopied ? 'Copied' : 'Copy Token'}
                        </motion.button>
                      )}
                    </div>
                    {pairingToken && <div className="p-2 rounded border border-neutral-700 bg-neutral-900 text-xs text-neutral-200 break-all">{pairingToken}</div>}
                    <textarea
                      value={pairingPayload}
                      onChange={(e) => setPairingPayload(e.target.value)}
                      className="max-h-48 min-h-[8rem] w-full resize-y overflow-y-auto bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200"
                      placeholder='Paste payload JSON from Device B, then click "Confirm Pairing"'
                    />
                    {pairConfirmResult && (
                      <div className={`rounded-lg border px-3 py-2 text-xs ${
                        pairConfirmResult.reciprocal_synced
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                      }`}>
                        <div className="font-semibold">
                          {pairConfirmResult.reciprocal_synced ? 'Paired on both devices' : 'Only local pairing saved'}
                        </div>
                        <div className="mt-1">{pairConfirmResult.reciprocal_message || 'No message available.'}</div>
                        {!pairConfirmResult.reciprocal_synced && pairConfirmResult.finalize_payload && (
                          <div className="mt-2 space-y-2">
                            <div className="text-[11px] text-amber-200">Send this finalize payload to Device B and import it there:</div>
                            <textarea
                              readOnly
                              value={JSON.stringify(pairConfirmResult.finalize_payload, null, 2)}
                              className="max-h-40 min-h-[7rem] w-full resize-y overflow-y-auto bg-neutral-900 border border-neutral-700 rounded-lg px-2 py-2 text-[11px] text-neutral-200"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-neutral-700 bg-neutral-900/50 p-3 space-y-2">
                    <div className="text-xs font-semibold text-neutral-200">Paste token from Device A</div>
                    <input
                      value={incomingPairToken}
                      onChange={(e) => setIncomingPairToken(e.target.value)}
                      className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200"
                      placeholder="Paste token here, then click Generate Payload"
                    />
                    <div className="flex flex-wrap gap-2">
                      <motion.button
                        whileTap={{ scale: 0.97 }}
                        onClick={handleGeneratePairingPayload}
                        className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer transition-colors"
                      >
                        Generate Payload
                      </motion.button>
                      <motion.button
                        whileTap={{ scale: 0.97 }}
                        onClick={async () => {
                          if (!receiverPayload.trim()) return;
                          await navigator.clipboard.writeText(receiverPayload);
                          setPairPayloadCopied(true);
                          setTimeout(() => setPairPayloadCopied(false), 1200);
                        }}
                        disabled={!receiverPayload.trim()}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-neutral-700 text-neutral-200 text-xs cursor-pointer hover:border-neutral-500 transition-colors disabled:opacity-60"
                      >
                        {pairPayloadCopied ? <Check size={14} className="text-emerald-300" /> : <Copy size={14} />}
                        {pairPayloadCopied ? 'Copied Payload' : 'Copy Payload'}
                      </motion.button>
                    </div>
                    <textarea
                      value={receiverPayload}
                      onChange={(e) => setReceiverPayload(e.target.value)}
                      className="max-h-48 min-h-[8rem] w-full resize-y overflow-y-auto bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200"
                      placeholder='Generated payload appears here. Send this JSON to Device A.'
                    />
                    <div className="space-y-2 border-t border-neutral-700/70 pt-2">
                      <div className="text-xs font-semibold text-neutral-200">Manual Finalize (fallback)</div>
                      <textarea
                        value={receiverFinalizePayload}
                        onChange={(e) => setReceiverFinalizePayload(e.target.value)}
                        className="max-h-40 min-h-[7rem] w-full resize-y overflow-y-auto bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200"
                        placeholder='If Device A reports reciprocal sync failed, paste finalize payload JSON here and click Finalize on this Device B.'
                      />
                      <button
                        type="button"
                        onClick={handleReceiverFinalize}
                        disabled={!receiverFinalizePayload.trim()}
                        className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer transition-colors"
                      >
                        Finalize On This Device
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-neutral-800 px-5 py-4">
                <button type="button" onClick={() => setPairModalOpen(false)} className="px-3 py-2 rounded-lg border border-neutral-700 text-neutral-300 text-xs cursor-pointer">
                  Cancel
                </button>
                {pairingMode === 'sender' ? (
                  <motion.button
                    whileTap={{ scale: 0.97 }}
                    onClick={handleConfirmPairing}
                    disabled={!pairingPayload.trim()}
                    className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer transition-colors"
                  >
                    Confirm Pairing
                  </motion.button>
                ) : (
                  <button type="button" onClick={() => setPairModalOpen(false)} className="px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs cursor-pointer">
                    Done (Send JSON to Device A)
                  </button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {peerAccessOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 sm:p-6">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="flex max-h-[min(90vh,880px)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-700 bg-neutral-950 shadow-2xl"
            >
              <div className="shrink-0 border-b border-neutral-800 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-bold text-white">Inbound peer access</h4>
                    <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
                      When <span className="text-neutral-300">{peerAccessFriend?.name || 'this device'}</span> calls your tunnel, limit what their query can do on this machine.
                      Long-term memory for guests uses an isolated namespace when enabled.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPeerAccessOpen(false);
                      setPeerAccessFriend(null);
                    }}
                    className="shrink-0 text-neutral-400 hover:text-white text-xs cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <div className="space-y-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Receive profile</span>
                  <div className="flex rounded-xl border border-white/10 bg-neutral-900/50 p-0.5">
                    <button
                      type="button"
                      onClick={() => handlePeerProfileChange('chat')}
                      className={`flex-1 rounded-[10px] px-3 py-2 text-xs font-medium transition-colors ${
                        peerAccessProfile === 'chat'
                          ? 'border border-emerald-500/30 bg-emerald-950/55 text-emerald-100'
                          : 'border border-transparent bg-transparent text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      Chat (safer)
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePeerProfileChange('agent')}
                      className={`flex-1 rounded-[10px] px-3 py-2 text-xs font-medium transition-colors ${
                        peerAccessProfile === 'agent'
                          ? 'border border-white/12 bg-neutral-800/90 text-white'
                          : 'border border-transparent bg-transparent text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      Agent (full tools)
                    </button>
                  </div>
                </div>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-neutral-700 bg-neutral-900/40 px-3 py-2.5">
                  <span className="text-xs text-neutral-200">Allow long-term memory tools</span>
                  <input
                    type="checkbox"
                    checked={peerAccessMemory}
                    onChange={(e) => handlePeerMemoryToggle(e.target.checked)}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500"
                  />
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-700 bg-neutral-900/40 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={peerAccessUseAllDefault}
                    onChange={(e) => {
                      const v = e.target.checked;
                      setPeerAccessUseAllDefault(v);
                      if (v && peerAccessCatalog) {
                        const eligible = getEligibleForProfile(peerAccessCatalog, peerAccessProfile);
                        const s = new Set(eligible);
                        if (!peerAccessMemory) {
                          PEER_MEMORY_TOOL_IDS.forEach((id) => s.delete(id));
                        }
                        setPeerAccessTools(s);
                      }
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-emerald-500"
                  />
                  <span className="text-xs leading-relaxed text-neutral-300">
                    <span className="font-semibold text-white">Match profile defaults</span>
                    <span className="block text-[11px] text-neutral-500">
                      When on, allowed tools track the profile and your installed capabilities. Turn off to pick tools explicitly.
                    </span>
                  </span>
                </label>
                {!peerAccessUseAllDefault && peerAccessCatalog && (
                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Allowed tools</span>
                    <ul className="max-h-48 space-y-1.5 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-900/30 p-2">
                      {getEligibleForProfile(peerAccessCatalog, peerAccessProfile).map((toolId) => {
                        const isMem = PEER_MEMORY_TOOL_IDS.includes(toolId);
                        const disabled =
                          peerAccessUseAllDefault || (isMem && !peerAccessMemory);
                        return (
                          <li key={toolId}>
                            <label
                              className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] ${
                                disabled ? 'opacity-50' : 'hover:bg-neutral-800/80'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={peerAccessTools.has(toolId)}
                                disabled={disabled}
                                onChange={(e) => {
                                  const on = e.target.checked;
                                  setPeerAccessTools((prev) => {
                                    const n = new Set(prev);
                                    if (on) n.add(toolId);
                                    else n.delete(toolId);
                                    return n;
                                  });
                                }}
                                className="h-3.5 w-3.5 rounded border-neutral-600 bg-neutral-800 text-emerald-500"
                              />
                              <span className="font-mono text-neutral-200">{toolId}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-neutral-800 px-5 py-4">
                <button
                  type="button"
                  onClick={() => {
                    setPeerAccessOpen(false);
                    setPeerAccessFriend(null);
                  }}
                  className="rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 cursor-pointer"
                >
                  Cancel
                </button>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  type="button"
                  onClick={handleSavePeerAccess}
                  disabled={peerAccessSaving || !peerAccessFriend}
                  className="rounded-lg border border-emerald-500/35 bg-emerald-950/45 px-3 py-2 text-xs font-medium text-emerald-100/95 transition-colors hover:border-emerald-500/50 hover:bg-emerald-950/70 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                >
                  {peerAccessSaving ? 'Saving…' : 'Save'}
                </motion.button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export { SettingsPage };
export default SettingsPage;

function McpServersManager({ servers, onSave, isSaving }) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [newServer, setNewServer] = useState({ type: 'stdio', command: '', args: '', env: '', url: '' });
  const [jsonConfigInput, setJsonConfigInput] = useState('');
  const [jsonConfigError, setJsonConfigError] = useState(null);
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

  const resetServerForm = () => {
    setNewServer({ type: 'stdio', command: '', args: '', env: '', url: '' });
    setJsonConfigInput('');
    setJsonConfigError(null);
    setError(null);
  };

  const extractServerFromJson = (jsonText) => {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error('Invalid JSON. Please paste valid JSON.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON must be an object.');
    }

    let candidate = parsed;
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
      const entries = Object.entries(parsed.mcpServers);
      if (entries.length === 0) {
        throw new Error('`mcpServers` is empty.');
      }
      candidate = entries[0][1];
    }

    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Could not find a valid MCP server object to extract.');
    }

    const hasUrl = typeof candidate.url === 'string' && candidate.url.trim();
    const hasCommand = typeof candidate.command === 'string' && candidate.command.trim();

    if (!hasUrl && !hasCommand) {
      throw new Error('Server must include either `command` (stdio) or `url` (SSE).');
    }

    if (candidate.args && !Array.isArray(candidate.args)) {
      throw new Error('`args` must be an array when provided.');
    }
    if (candidate.env && (typeof candidate.env !== 'object' || Array.isArray(candidate.env))) {
      throw new Error('`env` must be an object when provided.');
    }

    const type = hasUrl ? 'sse' : 'stdio';
    return {
      type,
      command: hasCommand ? candidate.command.trim() : '',
      args: Array.isArray(candidate.args) ? candidate.args.map((arg) => String(arg)).join('\n') : '',
      env: candidate.env ? JSON.stringify(candidate.env, null, 2) : '',
      url: hasUrl ? candidate.url.trim() : '',
    };
  };

  const handleExtractJsonConfig = () => {
    if (!jsonConfigInput.trim()) {
      setJsonConfigError('Paste JSON first.');
      return;
    }

    try {
      const extracted = extractServerFromJson(jsonConfigInput.trim());
      setNewServer(extracted);
      setJsonConfigError(null);
      setError(null);
    } catch (e) {
      setJsonConfigError(e.message || 'Failed to extract MCP server config from JSON.');
    }
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
    setJsonConfigInput('');
    setJsonConfigError(null);
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
      resetServerForm();

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
    resetServerForm();

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
      <div className="flex items-center justify-between gap-2">
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setIsAdding(true);
              setEditingIndex(null);
              resetServerForm();
            }}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
          >
            <Plus size={12} />
            Add MCP Server
          </button>
          <button
            onClick={fetchMcpStatus}
            disabled={loadingStatus}
            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loadingStatus ? "animate-spin" : ""} />
            {loadingStatus ? 'Checking...' : 'Refresh Status'}
          </button>
        </div>
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

      <AnimatePresence>
        {isAdding && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 top-4 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => {
              setIsAdding(false);
              setEditingIndex(null);
              resetServerForm();
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              transition={{ duration: 0.16 }}
              className="w-full max-w-xl max-h-[88vh] bg-neutral-900 border border-neutral-700 rounded-xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-neutral-700 bg-neutral-900">
                <h4 className="text-sm font-medium text-neutral-200">
                  {editingIndex !== null ? 'Edit MCP Server' : 'New MCP Server'}
                </h4>
                <button
                  type="button"
                  onClick={() => {
                    setIsAdding(false);
                    setEditingIndex(null);
                    resetServerForm();
                  }}
                  className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-wider text-neutral-500 font-medium block">Paste JSON Config (Optional)</label>
                  <textarea
                    value={jsonConfigInput}
                    onChange={(e) => {
                      setJsonConfigInput(e.target.value);
                      if (jsonConfigError) setJsonConfigError(null);
                    }}
                    placeholder={'{"mcpServers":{"browsermcp":{"command":"npx","args":["@browsermcp/mcp@latest"]}}}'}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-200 focus:outline-none focus:border-emerald-500/50 h-24 font-mono"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-neutral-500">
                      Accepts full config (`mcpServers`) or a single server object.
                    </p>
                    <button
                      type="button"
                      onClick={handleExtractJsonConfig}
                      className="px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-100 rounded-lg transition-colors"
                    >
                      Extract
                    </button>
                  </div>
                  {jsonConfigError && <p className="text-xs text-red-400">{jsonConfigError}</p>}
                </div>

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
              </div>

              <div className="sticky bottom-0 z-10 flex gap-2 px-6 py-4 border-t border-neutral-700 bg-neutral-900">
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
                    resetServerForm();
                  }}
                  className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
      <span className={`text-sm text-start font-semibold tracking-wide ${active ? 'opacity-100' : 'opacity-80 group-hover:opacity-100'}`}>
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
  const [editingIndex, setEditingIndex] = useState(null);
  const [newApi, setNewApi] = useState({
    name: '',
    description: '',
    url: '',
    method: 'GET',
    headers: '{}',
    body: '',
    enabled: true,
  });
  const [error, setError] = useState(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [indexToDelete, setIndexToDelete] = useState(null);

  const resetApiForm = () => {
    setError(null);
    setNewApi({ name: '', description: '', url: '', method: 'GET', headers: '{}', body: '', enabled: true });
  };

  const handleSaveApi = () => {
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
      const updatedApis = [...apis];
      if (editingIndex !== null) {
        updatedApis[editingIndex] = payload;
      } else {
        updatedApis.push(payload);
      }
      onSave(updatedApis);
      setIsAdding(false);
      setEditingIndex(null);
      resetApiForm();
    } catch (e) {
      setError(newApi.body?.trim() && e instanceof SyntaxError ? "Invalid JSON for body" : "Invalid JSON for headers");
    }
  };

  const handleEditClick = (api, index) => {
    setEditingIndex(index);
    setIsAdding(true);
    setError(null);
    setNewApi({
      name: api.name || '',
      description: api.description || '',
      url: api.url || '',
      method: api.method || 'GET',
      headers: JSON.stringify(api.headers || {}, null, 2),
      body: typeof api.body === 'string' ? api.body : '',
      enabled: api.enabled !== false,
    });
  };

  const handleDeleteClick = (index) => {
    setIndexToDelete(index);
    setIsConfirmOpen(true);
  };

  const handleToggleApi = (index) => {
    const updatedApis = apis.map((api, idx) => (
      idx === index ? { ...api, enabled: api.enabled !== false ? false : true } : api
    ));
    onSave(updatedApis);
  };

  const confirmDelete = () => {
    if (indexToDelete === null) return;
    const updatedApis = apis.filter((_, i) => i !== indexToDelete);
    onSave(updatedApis);
    setIndexToDelete(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-500">
          {apis.length === 0 ? 'No external APIs configured' : `${apis.length} API tool${apis.length !== 1 ? 's' : ''} configured`}
        </div>
        <button
          onClick={() => {
            setIsAdding(true);
            setEditingIndex(null);
            resetApiForm();
          }}
          className="flex items-center gap-2 px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors"
        >
          <Plus size={12} />
          Add API Tool
        </button>
      </div>

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
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold tracking-wide ${
                        api.enabled !== false
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                          : 'bg-neutral-900 border-neutral-700 text-neutral-500'
                      }`}>
                        {api.enabled !== false ? 'ENABLED' : 'DISABLED'}
                      </span>
                      <span className="text-[10px] text-neutral-600 font-mono truncate max-w-[200px]">{api.url}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => handleEditClick(api, idx)}
                    disabled={isSaving}
                    className="p-2 text-neutral-500 hover:text-neutral-200 transition-colors disabled:opacity-50"
                    title="Edit API"
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => handleToggleApi(idx)}
                    disabled={isSaving}
                    className={`px-2.5 py-1 rounded-md text-[10px] font-semibold tracking-wide border transition-colors ${
                      api.enabled !== false
                        ? 'border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10'
                        : 'border-white/10 text-neutral-400 hover:bg-white/5'
                    } disabled:opacity-50`}
                  >
                    {api.enabled !== false ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => handleDeleteClick(idx)}
                    className="p-2 text-neutral-500 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <AnimatePresence>
        {isAdding && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 top-4 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
            onClick={() => {
              setIsAdding(false);
              setEditingIndex(null);
              resetApiForm();
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              transition={{ duration: 0.16 }}
              className="w-full max-w-xl max-h-[88vh] bg-neutral-900 border border-neutral-700 rounded-xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-neutral-700 bg-neutral-900">
                <h4 className="text-sm font-medium text-neutral-200">
                  {editingIndex !== null ? 'Edit API Tool' : 'New API Tool'}
                </h4>
                <button
                  type="button"
                  onClick={() => {
                    setIsAdding(false);
                    setEditingIndex(null);
                    resetApiForm();
                  }}
                  className="p-1.5 rounded-md text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-4">
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
              </div>

              <div className="sticky bottom-0 z-10 flex gap-2 px-6 py-4 border-t border-neutral-700 bg-neutral-900">
                <button
                  onClick={handleSaveApi}
                  disabled={isSaving}
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  {isSaving ? "Saving..." : (editingIndex !== null ? "Update API Tool" : "Add API Tool")}
                </button>
                <button
                  onClick={() => {
                    setIsAdding(false);
                    setEditingIndex(null);
                    resetApiForm();
                  }}
                  className="px-4 py-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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

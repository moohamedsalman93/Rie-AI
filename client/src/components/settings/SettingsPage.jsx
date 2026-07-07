import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { getVersion } from '@tauri-apps/api/app';
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getSettings, updateSetting, getLogs, getOllamaModels, getGeminiModels, getRieUsage, downloadEmbeddingModel, getConnectivityIdentity, initPairing, confirmPairing, finalizePairing, getFriends, checkFriendStatus, getNgrokStatus, installNgrok, removeFriend, getPeerAccessCatalog, updateFriendAccess } from '../../services/chatApi';
import { setShareLocationEnabled, prefetchClientLocation } from '../../utils/locationUtils';
import { SettingInput } from './SettingInput';
import { McpServersManager } from './McpServersManager';
import { ExternalApisManager } from './ExternalApisManager';
import { KnowledgeManager } from './KnowledgeManager';
import { SidebarButton } from './Sidebar';
import { ConfirmationModal } from '../ConfirmationModal';
import { BetaLabel } from '../BetaLabel';
import {
  DEFAULT_TAB,
  normalizeTabId,
  normalizeSubTab,
  SETTINGS_NAV_GROUPS,
  filterNavGroups,
  searchSettings,
  DIAGNOSTICS_SUB_TABS,
  ADVANCED_SUB_TABS,
  CAPABILITY_SUB_TABS,
} from './settingsNav';
import { SubTabBar } from './SubTabBar';
import { PROVIDERS, AVAILABLE_TOOLS, PEER_MEMORY_TOOL_IDS, WEB_SEARCH_PROVIDERS } from './constants';
import {
  getWebSearchProvider,
  isWebSearchConfigured,
  webSearchMissingKeyMessage,
} from '../../utils/webSearchSettings';
import { SL } from './settingsLayout';
import {
  Wrench,
  Plug2,
  Settings,
  FileText,
  Search,
  Shield,
  Mic,
  MapPin,
  Rocket,
  RefreshCw,
  Trash2,
  Plus,
  Sparkles,
  Activity,
  Info,
  AlertTriangle,
  Copy,
  Check,
  Link,
  ExternalLink,
  Users,
  Fingerprint,
  Wifi,
} from 'lucide-react';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import { listen, emit } from '@tauri-apps/api/event';
import { WINDOW_SIZES } from '../../constants/appConfig';

function SettingsPage({ onClose, initialTab, initialSubTab }) {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState(() => normalizeTabId(initialTab) || DEFAULT_TAB);
  const [capabilityTab, setCapabilityTab] = useState(() =>
    normalizeTabId(initialTab) === 'capabilities' ? normalizeSubTab('capabilities', initialSubTab) || 'builtin' : 'builtin'
  );
  const [diagnosticsSubTab, setDiagnosticsSubTab] = useState(() =>
    normalizeTabId(initialTab) === 'diagnostics' ? normalizeSubTab('diagnostics', initialSubTab) || 'logs' : 'logs'
  );
  const [advancedSubTab, setAdvancedSubTab] = useState(() =>
    normalizeTabId(initialTab) === 'advanced' ? normalizeSubTab('advanced', initialSubTab) || 'orchestration' : 'orchestration'
  );
  const [settingsSearch, setSettingsSearch] = useState('');
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
  const [geminiModels, setGeminiModels] = useState([]);
  const [loadingGeminiModels, setLoadingGeminiModels] = useState(false);
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
  const friendStatusPollInFlightRef = useRef(false);
  const FRIEND_STATUS_POLL_MS = 30000;
  const FRIEND_STATUS_STALE_MS = 90000;

  // Rie Auth State (token via website deep link; see App.jsx)
  const [rieToken, setRieToken] = useState(null);
  const [rieUsage, setRieUsage] = useState(null);

  // Embedding model download
  const [embeddingDownloadProgress, setEmbeddingDownloadProgress] = useState(null);
  const [embeddingDownloading, setEmbeddingDownloading] = useState(false);
  const [embeddingDownloadError, setEmbeddingDownloadError] = useState(null);

  // Unsaved changes states
  const [pendingChanges, setPendingChanges] = useState({});
  const [pendingAutoStart, setPendingAutoStart] = useState(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [isSavingAll, setIsSavingAll] = useState(false);

  // Kiosk mode state
  const [kioskOverlay, setKioskOverlay] = useState(false);

  useEffect(() => {
    loadSettings();
    // fetchRieUsage is now called inside loadSettings once token is retrieved
    getVersion().then(v => setAppVersion(v)).catch(() => setAppVersion('0.1.7'));

    if (window.__TAURI_INTERNALS__) {
      import("@tauri-apps/api/core").then(({ invoke }) => {
        invoke("get_kiosk_overlay_mode")
          .then((enabled) => setKioskOverlay(enabled))
          .catch((err) => console.error("Failed to get kiosk overlay mode:", err));
      });
    }
  }, []);

  // Listen for kiosk overlay toggle events from backend/other windows
  useEffect(() => {
    let unlistenToggled;
    const setup = async () => {
      try {
        if (window.__TAURI_INTERNALS__) {
          const { listen } = await import("@tauri-apps/api/event");
          unlistenToggled = await listen("kiosk-overlay-toggled", (event) => {
            setKioskOverlay(event.payload);
          });
        }
      } catch (err) {
        console.error("Failed to listen for kiosk-overlay-toggled in SettingsPage:", err);
      }
    };
    setup();
    return () => {
      if (unlistenToggled) unlistenToggled();
    };
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

  const handleToggleKioskOverlaySetting = async () => {
    const newState = !kioskOverlay;
    try {
      if (window.__TAURI_INTERNALS__) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_kiosk_overlay_mode", { enabled: newState });
      }
      setKioskOverlay(newState);
    } catch (err) {
      console.error("Failed to toggle kiosk overlay mode setting:", err);
    }
  };

  useEffect(() => {
    if (activeTab === 'diagnostics' && diagnosticsSubTab === 'logs') {
      fetchLogs();
    }
  }, [activeTab, diagnosticsSubTab]);

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

  const loadSettings = async (showSpinner = true) => {
    try {
      if (showSpinner) setLoading(true);
      const data = await getSettings(false); // Always load masked by default
      setSettings(data);
      if (data.hasOwnProperty('share_location')) {
        setShareLocationEnabled(data.share_location);
        if (data.share_location) {
          prefetchClientLocation();
        }
      }
      setSelectedProvider(data.llm_provider || 'rie'); // Default to rie if not set
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
      await loadConnectivityData();
    } catch (err) {
      console.error("Settings load error:", err);
      setError("Failed to load settings: " + (err.message || String(err)));
    } finally {
      if (showSpinner) setLoading(false);
    }
  };

  const loadConnectivityData = async () => {
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
  };

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

  const fetchGeminiModels = async () => {
    try {
      setLoadingGeminiModels(true);
      const data = await getGeminiModels();
      setGeminiModels(data.models || []);
    } catch (err) {
      console.error("Failed to fetch Gemini models:", err);
    } finally {
      setLoadingGeminiModels(false);
    }
  };

  useEffect(() => {
    if (selectedProvider === 'ollama') {
      fetchOllamaModels();
    } else if (selectedProvider === 'gemini') {
      fetchGeminiModels();
    }
  }, [selectedProvider]);

  const handleLocalSettingChange = (key, value) => {
    setPendingChanges(prev => ({ ...prev, [key]: value }));

    const field = key.toLowerCase();
    let parsedValue = value;
    if (key === 'SHARE_LOCATION' || key === 'EXCLUDE_FROM_CAPTURE' || key === 'VOICE_REPLY' || key === 'LANGSMITH_TRACING' || key === 'CAPTURE_SCREEN_AS_TEXT') {
      parsedValue = (value === 'true' || value === true);
    } else if (key === 'MCP_SERVERS' || key === 'EXTERNAL_APIS' || key === 'ENABLED_TOOLS') {
      try {
        parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
      } catch (e) {
        console.error(`Failed to parse local update for ${key}:`, e);
      }
    }

    setSettings(prev => ({ ...prev, [field]: parsedValue }));

    if (key === 'LLM_PROVIDER') {
      setSelectedProvider(value);
    }

    if (key === 'ENABLED_TOOLS') {
      try {
        const toolsList = typeof value === 'string' ? JSON.parse(value) : value;
        setEnabledTools(toolsList);
      } catch (e) {}
    }

    // Auto-set LLM_PROVIDER if not set
    if (!settings.llm_provider && !pendingChanges.LLM_PROVIDER) {
      let autoProvider = null;
      if (key === 'GOOGLE_API_KEY') autoProvider = 'gemini';
      else if (key === 'GROQ_API_KEY') autoProvider = 'groq';
      else if (key === 'OPENAI_API_KEY') autoProvider = 'openai';
      else if (key === 'VERTEX_PROJECT' || key === 'VERTEX_CREDENTIALS_PATH') autoProvider = 'vertex';

      if (autoProvider) {
        setPendingChanges(prev => ({ ...prev, LLM_PROVIDER: autoProvider }));
        setSelectedProvider(autoProvider);
        setSettings(prev => ({ ...prev, llm_provider: autoProvider }));
      }
    }

    // Auto-set WEB_SEARCH_PROVIDER if not set
    if (!settings.web_search_provider && !pendingChanges.WEB_SEARCH_PROVIDER) {
      if (key === 'TAVILY_API_KEY') {
        setPendingChanges(prev => ({ ...prev, WEB_SEARCH_PROVIDER: 'tavily' }));
        setSettings(prev => ({ ...prev, web_search_provider: 'tavily' }));
      } else if (key === 'BRAVE_SEARCH_API_KEY') {
        setPendingChanges(prev => ({ ...prev, WEB_SEARCH_PROVIDER: 'brave' }));
        setSettings(prev => ({ ...prev, web_search_provider: 'brave' }));
      }
    }
  };

  const handleProviderChange = (provider) => {
    handleLocalSettingChange('LLM_PROVIDER', provider);
  };

  const handleSaveAll = async () => {
    setIsSavingAll(true);
    setError(null);
    try {
      // 1. Save all changed settings
      for (const [key, value] of Object.entries(pendingChanges)) {
        await updateSetting(key, value);
        try {
          await emit("settings-updated", { key, value });
        } catch (e) {
          console.error(`Failed to emit settings-updated for ${key}:`, e);
        }
      }

      // 2. Autostart plugin
      if (pendingAutoStart !== null) {
        const { enable, disable } = await import('@tauri-apps/plugin-autostart');
        if (pendingAutoStart) {
          await enable();
        } else {
          await disable();
        }
        setAutoStartEnabled(pendingAutoStart);
        setPendingAutoStart(null);
      }

      // 3. Apply side-effects for applied changes
      if ('SHARE_LOCATION' in pendingChanges) {
        const parsedVal = pendingChanges.SHARE_LOCATION === 'true' || pendingChanges.SHARE_LOCATION === true;
        setShareLocationEnabled(parsedVal);
        if (parsedVal) {
          prefetchClientLocation();
        }
      }
      if ('EXCLUDE_FROM_CAPTURE' in pendingChanges) {
        const parsedVal = pendingChanges.EXCLUDE_FROM_CAPTURE === 'true' || pendingChanges.EXCLUDE_FROM_CAPTURE === true;
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("set_window_capture_excluded", { exclude: parsedVal });
        } catch (e) {
          console.error("Failed to update capture exclusion:", e);
        }
      }

      // 4. Fetch models if keys changed
      if ('GOOGLE_API_KEY' in pendingChanges && selectedProvider === 'gemini') {
        fetchGeminiModels();
      }
      if ('OLLAMA_API_KEY' in pendingChanges && selectedProvider === 'ollama') {
        fetchOllamaModels();
      }

      // 5. Clear local pending changes
      setPendingChanges({});

      // 6. Reload settings from backend to get properly masked / validated state
      await loadSettings(false);
    } catch (err) {
      console.error("Failed to save changes:", err);
      setError("Failed to save changes: " + (err.message || String(err)));
    } finally {
      setIsSavingAll(false);
    }
  };

  const handleDiscard = () => {
    setPendingChanges({});
    setPendingAutoStart(null);
    loadSettings(false);
  };

  const handleClose = () => {
    const isDirty = Object.keys(pendingChanges).length > 0 || pendingAutoStart !== null;
    if (isDirty) {
      setDiscardConfirmOpen(true);
    } else {
      onClose();
    }
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

  useEffect(() => {
    if (activeTab !== 'advanced' || advancedSubTab !== 'remote' || friends.length === 0) {
      return undefined;
    }

    let cancelled = false;

    const pollFriendStatuses = async () => {
      if (friendStatusPollInFlightRef.current) return;
      friendStatusPollInFlightRef.current = true;
      try {
        const friendIds = friends.map((friend) => friend.id).filter(Boolean);
        if (friendIds.length === 0) return;

        const settled = await Promise.allSettled(
          friendIds.map(async (friendId) => {
            const result = await checkFriendStatus(friendId);
            return [friendId, result];
          })
        );
        if (cancelled) return;

        setFriendStatusById((prev) => {
          const next = { ...prev };
          settled.forEach((entry, index) => {
            const friendId = friendIds[index];
            if (!friendId) return;
            if (entry.status === 'fulfilled') {
              const [, result] = entry.value;
              next[friendId] = result;
            } else {
              next[friendId] = {
                status: 'offline',
                message: entry.reason?.message || 'Failed to refresh status',
                checked_at: new Date().toISOString(),
                reachable: false,
                failure_code: 'network_error',
                failure_stage: 'network',
              };
            }
          });
          return next;
        });
      } finally {
        friendStatusPollInFlightRef.current = false;
      }
    };

    pollFriendStatuses();
    const intervalId = window.setInterval(pollFriendStatuses, FRIEND_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTab, advancedSubTab, friends]);

  const handleSettingsSearch = (query) => {
    setSettingsSearch(query);
    const hit = searchSettings(query);
    if (hit) {
      setActiveTab(hit.tab);
      if (hit.subTab) {
        if (hit.tab === 'capabilities') setCapabilityTab(hit.subTab);
        if (hit.tab === 'diagnostics') setDiagnosticsSubTab(hit.subTab);
        if (hit.tab === 'advanced') setAdvancedSubTab(hit.subTab);
      }
    }
  };

  const navGroups = filterNavGroups(settingsSearch);

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

  const handleToolToggle = (toolId) => {
    const newTools = enabledTools.includes(toolId)
      ? enabledTools.filter(t => t !== toolId)
      : [...enabledTools, toolId];

    handleLocalSettingChange('ENABLED_TOOLS', JSON.stringify(newTools));
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

  const handleAutoStartToggle = () => {
    const nextVal = pendingAutoStart !== null ? !pendingAutoStart : !autoStartEnabled;
    setPendingAutoStart(nextVal);
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
          <h2 className="text-lg font-semibold text-white tracking-tight">Settings</h2>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleClose}
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
        <div className={SL.sidebar}>
          <div className="px-1.5 pb-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-500" aria-hidden />
              <input
                type="search"
                value={settingsSearch}
                onChange={(e) => handleSettingsSearch(e.target.value)}
                placeholder="Search settings..."
                className="w-full rounded-lg border border-white/10 bg-neutral-900/80 py-2 pl-8 pr-2 text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-emerald-500/40"
              />
            </div>
          </div>

          {navGroups.map((group) => (
            <div key={group.id}>
              <div className={SL.navGroup}>
                {group.label}
              </div>
              {group.tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <SidebarButton
                    key={tab.id}
                    active={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    icon={<Icon size={17} />}
                  >
                    {tab.label}
                  </SidebarButton>
                );
              })}
            </div>
          ))}
        </div>

        {/* Content Area â€” min-w-0 lets this flex child shrink; overflow-x-hidden avoids horizontal scroll from wide content / absolute decor */}
        <div className={SL.content}>
          {loading ? (
            <div className="flex justify-center py-10">
              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
              {error}
            </div>
          ) : (
            <div className={SL.contentInner}>

              {/* PROVIDER TAB */}
              {activeTab === 'assistant' && (
                <div className={SL.tabStack}>
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Assistant</h3>
                    <p className={SL.pageDesc}>Select the model that powers your assistant.</p>
                  </div>

                  <div className={`${SL.toggleRow} space-y-3`}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-neutral-800 rounded-lg text-neutral-200">
                          {PROVIDERS[selectedProvider]?.icon}
                        </div>
                        <div>
                          <h3 className="text-sm font-medium text-neutral-200">Assistant Provider</h3>
                          <p className="text-[10px] text-neutral-500">Choose the model provider that powers your assistant.</p>
                        </div>
                      </div>
                      <div className="relative">
                        <select
                          value={selectedProvider}
                          onChange={(e) => handleProviderChange(e.target.value)}
                          className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[160px]"
                        >
                          {Object.entries(PROVIDERS).map(([key, info]) => (
                            <option key={key} value={key}>
                              {info.label}
                            </option>
                          ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                          <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                            <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        {PROVIDERS[selectedProvider]?.icon}
                      </div>
                      <h3 className={SL.sectionTitle}>
                        {PROVIDERS[selectedProvider]?.label === 'Rie' ? 'Rie Usage' : PROVIDERS[selectedProvider]?.label + ' Configuration'}
                      </h3>
                    </div>

                    {selectedProvider === 'gemini' && (
                      <>
                        <SettingInput
                          label="Google API Key"
                          dbKey="GOOGLE_API_KEY"
                          value={settings.google_api_key}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                          isSecret
                          type="textarea"
                          placeholder="Enter keys separated by commas or lines:
key1,
key2,
..."
                        />
                        <p className="text-[10px] text-neutral-500 mt-1">
                          Tip: Add multiple keys to bypass Google's rate limits. They will be rotated automatically.
                        </p>
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 py-2 border-b border-white/5 last:border-0">
                          <div className="flex items-center gap-2.5 shrink-0">
                            <label className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Model</label>
                          </div>
                          <div className="flex-1 max-w-xs w-full sm:w-auto flex gap-2">
                            <div className="relative flex-1">
                              <select
                                value={settings.gemini_model || ''}
                                onChange={(e) => handleLocalSettingChange('GEMINI_MODEL', e.target.value)}
                                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10"
                                disabled={isSavingAll || loadingGeminiModels}
                              >
                                <option value="" disabled>{loadingGeminiModels ? 'Loading models...' : 'Select a model'}</option>
                                {geminiModels.length > 0 && geminiModels.map(model => (
                                  <option key={model} value={model}>{model}</option>
                                ))}
                                {geminiModels.length === 0 && !loadingGeminiModels && settings.gemini_model && (
                                  <option value={settings.gemini_model}>{settings.gemini_model} (Not in list)</option>
                                )}
                              </select>
                              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                                  <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                                </svg>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                fetchGeminiModels();
                              }}
                              disabled={loadingGeminiModels}
                              className="p-2 bg-neutral-800 border border-neutral-700 rounded-lg text-neutral-400 hover:text-emerald-400 transition-colors shrink-0"
                              title="Refresh models"
                            >
                              <RefreshCw size={18} className={loadingGeminiModels ? 'animate-spin' : ''} />
                            </button>
                          </div>
                        </div>
                        {!settings.google_api_key && (
                          <p className="text-[10px] text-neutral-500 mt-1">Add a Google API key to load live models from Google. Showing common defaults until then.</p>
                        )}
                      </>
                    )}

                    {selectedProvider === 'vertex' && (
                      <>
                        <SettingInput
                          label="Project ID"
                          dbKey="VERTEX_PROJECT"
                          value={settings.vertex_project}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                        />
                        <SettingInput
                          label="Location"
                          dbKey="VERTEX_LOCATION"
                          value={settings.vertex_location}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                          placeholder="us-central1"
                        />
                        <SettingInput
                          label="Credentials JSON Path"
                          dbKey="VERTEX_CREDENTIALS_PATH"
                          value={settings.vertex_credentials_path}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                          placeholder="C:\path\to\credentials.json"
                        />
                        <SettingInput
                          label="Model Name"
                          dbKey="VERTEX_MODEL"
                          value={settings.vertex_model}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
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
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
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
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
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
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
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
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                          placeholder="https://api.z.ai/api/paas/v4/"
                        />
                        <SettingInput
                          label="Model Name"
                          dbKey="OPENAI_MODEL"
                          value={settings.openai_model}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                          placeholder="glm-4.5-flash"
                        />
                      </>
                    )}

                    {selectedProvider === 'rie' && (
                      <div className="space-y-4">
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
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
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
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
                          isSecret
                          placeholder="For secured or remote Ollama instances"
                        />
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 py-2 border-b border-white/5 last:border-0">
                          <div className="flex items-center gap-2.5 shrink-0">
                            <label className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Ollama Model</label>
                          </div>
                          <div className="flex-1 max-w-xs w-full sm:w-auto flex gap-2">
                            <div className="relative flex-1">
                              <select
                                value={settings.ollama_model || ''}
                                onChange={(e) => handleLocalSettingChange('OLLAMA_MODEL', e.target.value)}
                                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10"
                                disabled={isSavingAll || loadingOllamaModels}
                              >
                                <option value="" disabled>{loadingOllamaModels ? 'Loading models...' : 'Select a model'}</option>
                                {ollamaModels.length > 0 && ollamaModels.map(model => (
                                  <option key={model} value={model}>{model}</option>
                                ))}
                                {ollamaModels.length === 0 && !loadingOllamaModels && settings.ollama_model && (
                                  <option value={settings.ollama_model}>{settings.ollama_model} (Not found)</option>
                                )}
                              </select>
                              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                                  <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                                </svg>
                              </div>
                            </div>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                fetchOllamaModels();
                              }}
                              disabled={loadingOllamaModels}
                              className="p-2 bg-neutral-800 border border-neutral-700 rounded-lg text-neutral-400 hover:text-emerald-400 transition-colors shrink-0"
                              title="Refresh models"
                            >
                              <RefreshCw size={18} className={loadingOllamaModels ? 'animate-spin' : ''} />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 px-4 py-3 bg-neutral-800/30 rounded-xl border border-neutral-700/50 mt-3">
                          <Info className="w-4 h-4 text-neutral-400 shrink-0" />
                          <p className="text-[11px] text-neutral-400 leading-normal">
                            Using Ollama at <code className="text-neutral-300 bg-neutral-900 px-1 rounded">{settings.ollama_api_url?.trim() || 'http://localhost:11434'}</code>. Make sure it's running and you've downloaded at least one model.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* CAPABILITY TAB */}
              {activeTab === 'capabilities' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Tools & APIs</h3>
                    <p className={SL.pageDesc}>Built-in tools, MCP servers, and external APIs.</p>
                  </div>

                  <SubTabBar tabs={CAPABILITY_SUB_TABS} activeId={capabilityTab} onChange={setCapabilityTab} />

                  {capabilityTab === 'builtin' && (
                    <div className="premium-card rounded-xl p-5 space-y-4">
                      <div className="flex items-center justify-between pb-3 border-b border-white/5 mb-4">
                        <div className="flex items-center gap-2.5">
                          <div className={SL.cardHeaderIcon}>
                            <Wrench size={16} />
                          </div>
                          <h4 className={SL.sectionTitle}>Built-in Tools</h4>
                        </div>
                        <span className="text-[10px] font-bold bg-white/5 border border-white/10 px-2 py-1 rounded-md text-neutral-400 tracking-wider">
                          {enabledTools.length} ACTIVE
                        </span>
                      </div>

                      {!isWebSearchConfigured(settings) && (
                        <div className="rounded-xl border border-amber-500/25 bg-amber-950/20 p-4 space-y-3">
                          <p className="text-xs text-amber-200/90">
                            {webSearchMissingKeyMessage(settings) || 'Configure a web search provider in Memory settings.'}
                          </p>
                          <button
                            type="button"
                            onClick={() => setActiveTab('memory')}
                            className="text-[11px] text-emerald-400 hover:text-emerald-300 font-medium"
                          >
                            Open Memory settings →
                          </button>
                        </div>
                      )}

                      <div className="flex flex-wrap gap-2.5">
                        {AVAILABLE_TOOLS.map(tool => {
                          const isMissingKey = tool.id === 'internet_search' && !isWebSearchConfigured(settings);
                          const isEnabled = !isMissingKey && enabledTools.includes(tool.id);
                          const tooltipText = isMissingKey
                            ? (webSearchMissingKeyMessage(settings) || 'Configure web search in Memory settings')
                            : tool.desc;
                          return (
                            <div key={tool.id} className="group relative">
                              <button
                                type="button"
                                onClick={() => !isMissingKey && handleToolToggle(tool.id)}
                                disabled={isMissingKey}
                                className={`px-4 py-2 rounded-xl border text-xs font-semibold tracking-wide transition-all duration-200 flex items-center gap-2 ${isMissingKey
                                  ? 'opacity-40 cursor-not-allowed bg-neutral-900 border-white/5 text-neutral-600'
                                  : isEnabled
                                    ? 'bg-neutral-800 border-neutral-700 text-neutral-200'
                                    : 'bg-white/[0.01] border-white/5 text-neutral-500 hover:bg-white/[0.03] hover:border-white/10 hover:text-neutral-400'
                                  }`}
                              >
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isMissingKey ? 'bg-neutral-800' : isEnabled ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)] animate-pulse' : 'bg-neutral-600'}`} />
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
                  )}

                  {capabilityTab === 'mcp' && (
                    <div className="premium-card rounded-xl p-5 space-y-4">
                      <div className={SL.cardHeader}>
                        <div className={SL.cardHeaderIcon}>
                          <Plug2 size={16} />
                        </div>
                        <h4 className={SL.sectionTitle}>MCP Servers</h4>
                      </div>

                      <p className="text-xs text-neutral-500 leading-relaxed max-w-xl">
                        Model Context Protocol (MCP) allows your assistant to connect to local or remote services, providing access to specific files, databases, or APIs.
                      </p>

                      <div className="pt-2">
                        <McpServersManager
                          servers={settings.mcp_servers || []}
                          onSave={(newServers) => handleLocalSettingChange('MCP_SERVERS', JSON.stringify(newServers))}
                          isSaving={isSavingAll}
                        />
                      </div>
                    </div>
                  )}

                  {capabilityTab === 'external' && (
                    <div className="premium-card rounded-xl p-5 space-y-4">
                      <div className={SL.cardHeader}>
                        <div className={SL.cardHeaderIcon}>
                          <Link size={16} />
                        </div>
                        <h4 className={SL.sectionTitle}>External APIs</h4>
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
                          onSave={(updatedApis) => handleLocalSettingChange('EXTERNAL_APIS', JSON.stringify(updatedApis))}
                          isSaving={isSavingAll}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'advanced' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Advanced</h3>
                    <p className={SL.pageDesc}>Orchestration and remote access.</p>
                  </div>
                  <SubTabBar tabs={ADVANCED_SUB_TABS} activeId={advancedSubTab} onChange={setAdvancedSubTab} />

              {advancedSubTab === 'orchestration' && (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Orchestration &amp; Planner</h3>
                    <p className={SL.pageDesc}>
                      Solo agent or planner-led team.
                    </p>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className="space-y-3 p-3">
                      <div className="text-[11px] uppercase tracking-wider text-neutral-400">Orchestration Mode</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleLocalSettingChange('AGENT_ORCHESTRATION_MODE', 'solo')}
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
                          onClick={() => handleLocalSettingChange('AGENT_ORCHESTRATION_MODE', 'team')}
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
                        <div className="text-xs text-neutral-500 leading-relaxed space-y-1">
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
                        <div className="text-xs text-neutral-500 leading-relaxed space-y-1">
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

              {advancedSubTab === 'remote' && (
                <div className="relative overflow-x-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="pointer-events-none absolute -right-16 -top-12 h-56 w-56 rounded-full bg-white/[0.03] blur-3xl" />

                  <div className="relative flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-neutral-900/80">
                        <Link className="h-5 w-5 text-neutral-300" strokeWidth={2} aria-hidden />
                      </div>
                      <div className="space-y-0.5 min-w-0">
                        <h3 className="text-base font-semibold tracking-tight text-white">Remote access & pairing</h3>
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
                        <span className="font-mono text-[10px] font-semibold uppercase text-neutral-100">{ngrokReadyState || 'â€”'}</span>
                      </span>
                    </div>
                  </div>

                  <div className="relative mt-3 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3">
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

                  <div className="relative mt-4 grid grid-cols-1 gap-4 xl:grid-cols-12">
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
                                onClick={() => handleLocalSettingChange('CONNECTIVITY_NGROK_ENABLED', String(!settings.connectivity_ngrok_enabled))}
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
                              onSave={handleLocalSettingChange}
                              isSaving={isSavingAll}
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
                              {connectivityIdentity?.device_id || 'â€”'}
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
                            Last health check is per-row â€” tap the refresh control to update.
                          </p>
                        </div>
                      </div>
                      <span className="self-start rounded-full border border-white/10 bg-neutral-900/80 px-3 py-1 text-[11px] text-neutral-400 sm:self-center">
                        {friends.length} linked {friends.length === 1 ? 'device' : 'devices'}
                      </span>
                    </div>

                    {friends.length === 0 ? (
                      <div className="mt-4 rounded-lg border border-dashed border-neutral-700/80 bg-neutral-900/20 px-4 py-8 text-center">
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
                          const checkedAtMs = statusRow?.checked_at ? Date.parse(statusRow.checked_at) : NaN;
                          const isFresh = Number.isFinite(checkedAtMs) && (Date.now() - checkedAtMs) <= FRIEND_STATUS_STALE_MS;
                          const hasStatus = !!statusRow;
                          const isStale = hasStatus && !isFresh;
                          const reachable = statusRow?.reachable === true && !isStale;
                          const statusLabel = !hasStatus || isStale ? 'unknown' : (reachable ? 'online' : 'offline');
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
                                            statusLabel === 'unknown'
                                              ? 'border-neutral-600 bg-neutral-800/80 text-neutral-400'
                                              : statusLabel === 'online'
                                              ? 'border-emerald-500/25 bg-emerald-950/45 text-emerald-200/90'
                                              : 'border-red-500/25 bg-red-950/35 text-red-200/85'
                                          }`}
                                        >
                                          {statusLabel}
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
                                            {statusRow?.latency_ms != null ? `${statusRow.latency_ms} ms` : 'â€”'}
                                          </span>
                                        </span>
                                        <span>
                                          Checked{' '}
                                          <span className="text-neutral-400">
                                            {statusRow?.checked_at ? new Date(statusRow.checked_at).toLocaleString() : 'â€”'}
                                            {isStale ? ' (stale)' : ''}
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
                                      title="Inbound access â€” tools and memory"
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
                </div>
              )}

              {activeTab === 'privacy' && (
                <div className={SL.tabStack}>
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Privacy & system</h3>
                    <p className={SL.pageDesc}>Security, location, startup, and about.</p>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        <Shield size={16} />
                      </div>
                      <h3 className={SL.sectionTitle}>Security & Safety</h3>
                    </div>
                    <SettingInput
                      label="Terminal Restrictions"
                      dbKey="TERMINAL_RESTRICTIONS"
                      value={settings.terminal_restrictions}
                      onSave={handleLocalSettingChange}
                      isSaving={isSavingAll}
                      type="textarea"
                      placeholder="e.g. rm, del, format, curl, wget
Separate keywords by commas. Commands containing these words will be blocked."
                    />
                    <p className="text-[10px] text-neutral-500 mt-1">
                      Protect your system by blacklisting dangerous keywords. The agent will be unable to run any command that contains these strings.
                    </p>

                    <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-bold text-neutral-200">Human-in-the-Loop (HITL)</h4>
                        <p className="text-[11px] text-neutral-500 max-w-xs">
                          Choose how approvals are handled for potentially risky tool calls.
                        </p>
                      </div>
                      <div className=" max-w-xs">
                        <select
                          value={settings.hitl_mode || (settings.hitl_enabled ? 'always' : 'disable')}
                          onChange={(e) => handleLocalSettingChange('HITL_MODE', e.target.value)}
                          disabled={isSavingAll}
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-200 text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-70 disabled:cursor-not-allowed"
                        >
                          <option value="disable">Disable</option>
                          <option value="always">Always ask</option>
                          <option value="let_decide">Let AI decide</option>
                        </select>
                      </div>
                    </div>

                    <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-bold text-neutral-200">Screen Privacy</h4>
                        <p className="text-[11px] text-neutral-500 max-w-xs">
                          Exclude the application from screenshots and screen recordings to protect your private chat data.
                        </p>
                      </div>
                      <div
                        onClick={() => handleLocalSettingChange('EXCLUDE_FROM_CAPTURE', String(!(settings.exclude_from_capture ?? true)))}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full cursor-pointer transition-colors ${(settings.exclude_from_capture ?? true) ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${(settings.exclude_from_capture ?? true) ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>

                    <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-bold text-neutral-200">Kiosk Overlay</h4>
                        <p className="text-[11px] text-neutral-500 max-w-xs">
                          Float and overlay above full-screen kiosk apps. (Windows only)
                        </p>
                      </div>
                      <div
                        onClick={handleToggleKioskOverlaySetting}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full cursor-pointer transition-colors ${kioskOverlay ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${kioskOverlay ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-t border-white/5 pt-4">
                      <div>
                        <h4 className="text-sm font-bold text-neutral-200">UIA Screen Capture (Text)</h4>
                        <p className="text-[11px] text-neutral-500 max-w-xs">
                          Extract text/structure via Windows UI Automation when attaching "Current Screen" instead of capturing a visual screenshot. Useful in kiosk/lockdown environments.
                        </p>
                      </div>
                      <div
                        onClick={() => handleLocalSettingChange('CAPTURE_SCREEN_AS_TEXT', String(!(settings.capture_screen_as_text ?? false)))}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full cursor-pointer transition-colors ${(settings.capture_screen_as_text ?? false) ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${(settings.capture_screen_as_text ?? false) ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        <Sparkles size={16} />
                      </div>
                      <h3 className={SL.sectionTitle}>Appearance &amp; Customization</h3>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <h4 className="text-sm font-medium text-neutral-200">Floating Chat Transparency</h4>
                          <p className="text-[10px] text-neutral-500 max-w-md">
                            Adjust the transparency/opacity of the floating chat window.
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="text-xs font-semibold text-neutral-300">
                            {Math.round((settings.floating_chat_opacity ?? 0.85) * 100)}%
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <input
                          type="range"
                          min="10"
                          max="100"
                          step="5"
                          value={Math.round((settings.floating_chat_opacity ?? 0.85) * 100)}
                          onChange={(e) => handleLocalSettingChange('FLOATING_CHAT_OPACITY', String(parseFloat(e.target.value) / 100))}
                          disabled={isSavingAll}
                          className="flex-1 accent-emerald-500 h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer"
                        />
                      </div>

                      <div className="pt-4 border-t border-white/5 flex items-center justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-medium text-neutral-200">Show Floating Bubble</h4>
                          <p className="text-[10px] text-neutral-500 max-w-xs">
                            Display the floating bubble on your screen when minimized. Disable to hide it completely (restore via system tray or global shortcut Alt+Shift+A).
                          </p>
                        </div>
                        <div
                          onClick={() => handleLocalSettingChange('SHOW_BUBBLE', String(!(settings.show_bubble ?? true)))}
                          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full cursor-pointer transition-colors ${(settings.show_bubble ?? true) ? 'bg-emerald-500' : 'bg-neutral-700'
                            }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${(settings.show_bubble ?? true) ? 'translate-x-6' : 'translate-x-1'
                              }`}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        <MapPin size={16} />
                      </div>
                      <h3 className={SL.sectionTitle}>Device &amp; Location</h3>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-medium text-neutral-200">Share location</h4>
                        <p className="text-[10px] text-neutral-500 max-w-md">
                          Send approximate GPS with chat messages so Rie can answer nearby places, weather, and &quot;where am I&quot; questions.
                          The first time, Windows will ask for location access for Rie-AI (Settings → Privacy → Location).
                        </p>
                      </div>
                      <div
                        onClick={() => handleLocalSettingChange('SHARE_LOCATION', String(!(settings.share_location ?? true)))}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full cursor-pointer transition-colors ${(settings.share_location ?? true) ? 'bg-emerald-500' : 'bg-neutral-700'
                          }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${(settings.share_location ?? true) ? 'translate-x-6' : 'translate-x-1'
                            }`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className={`${SL.toggleRow} space-y-3`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-neutral-200">Auto-start</h3>
                        <p className="text-[10px] text-neutral-500">Launch Rie-AI automatically when you log in.</p>
                      </div>
                      <div
                        onClick={handleAutoStartToggle}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full cursor-pointer transition-colors ${
                          (pendingAutoStart !== null ? pendingAutoStart : autoStartEnabled) ? 'bg-emerald-500' : 'bg-neutral-700'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            (pendingAutoStart !== null ? pendingAutoStart : autoStartEnabled) ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </div>
                    </div>
                  </div>

                  {/* About Section */}
                  <div className={`${SL.toggleRow} space-y-3`}>
                    <div className="flex items-center gap-2.5 pb-2 border-b border-white/5 mb-3">
                      <div className="p-1.5 bg-neutral-800 rounded-lg text-neutral-300">
                        <Info size={14} />
                      </div>
                      <h3 className="text-sm font-medium text-neutral-200">About</h3>
                    </div>
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-sm font-medium text-neutral-200">Application Version</h4>
                        <p className="text-[10px] text-neutral-500">Current installed version of Rie-AI.</p>
                      </div>
                      <span className="px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-sm font-semibold text-emerald-400 tracking-wide flex items-center gap-2">
                        v{appVersion}
                        <BetaLabel />
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

              {activeTab === 'memory' && (
                <div className={SL.tabStack}>
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Memory</h3>
                    <p className={SL.pageDesc}>Web search provider and memory embeddings.</p>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        <Search size={16} />
                      </div>
                      <h3 className={SL.sectionTitle}>Web Search</h3>
                    </div>
                    <div className="flex items-center justify-between gap-4 py-1.5">
                      <div>
                        <h4 className="text-sm font-medium text-neutral-300">Search Provider</h4>
                        <p className="text-[10px] text-neutral-500">Select the search engine service used by the Internet Search tool.</p>
                      </div>
                      <div className="relative">
                        <select
                          value={getWebSearchProvider(settings)}
                          onChange={(e) => handleLocalSettingChange('WEB_SEARCH_PROVIDER', e.target.value)}
                          className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[160px]"
                        >
                          {Object.entries(WEB_SEARCH_PROVIDERS).map(([id, info]) => (
                            <option key={id} value={id}>
                              {info.label}
                            </option>
                          ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                          <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                            <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                          </svg>
                        </div>
                      </div>
                    </div>
                    {(() => {
                      const providerId = getWebSearchProvider(settings);
                      const provider = WEB_SEARCH_PROVIDERS[providerId];
                      if (!provider?.requiresKey) {
                        return (
                          <div className="text-[10px] text-amber-200/90 bg-amber-950/25 border border-amber-500/25 rounded-lg p-3 space-y-1">
                            <p className="font-semibold text-amber-100/95">DuckDuckGo is not stable</p>
                            <p>{provider.description}</p>
                          </div>
                        );
                      }
                      return (
                        <>
                          <SettingInput
                            label={`${provider.label} API Key`}
                            dbKey={provider.keyDb}
                            value={settings[provider.keyField]}
                            onSave={handleLocalSettingChange}
                            isSaving={isSavingAll}
                            isSecret
                            placeholder={provider.placeholder}
                          />
                          <p className="text-[10px] text-neutral-500">
                            Powers the Internet Search tool in Capabilities.
                          </p>
                        </>
                      );
                    })()}
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        <FileText size={16} />
                      </div>
                      <h3 className={SL.sectionTitle}>Custom Knowledge</h3>
                    </div>
                    <p className="text-[10px] text-neutral-500">
                      Create named knowledge packs with custom instructions and files. Attach them in chat to inject context into the assistant.
                    </p>
                    <KnowledgeManager />
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className={SL.cardHeader}>
                      <div className={SL.cardHeaderIcon}>
                        <Activity size={16} />
                      </div>
                      <h3 className={SL.sectionTitle}>Embeddings</h3>
                    </div>
                    <div className="space-y-4">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <h4 className="text-sm font-medium text-neutral-200">Embedding Source</h4>
                          <p className="text-[10px] text-neutral-500">
                            Choose how long-term memory embeddings are computed (bundled model vs Ollama).
                          </p>
                        </div>
                        <div className="relative">
                          <select
                            value={settings.embedding_source || 'bundled'}
                            onChange={(e) => handleLocalSettingChange('EMBEDDING_SOURCE', e.target.value)}
                            className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[160px]"
                          >
                            <option value="bundled">Bundled</option>
                            <option value="ollama">Ollama</option>
                          </select>
                          <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                            <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                              <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                            </svg>
                          </div>
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
                            onSave={handleLocalSettingChange}
                            isSaving={isSavingAll}
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
                </div>
              )}

              {activeTab === 'voice' && (
                <div className={SL.tabStack}>
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Voice</h3>
                    <p className={SL.pageDesc}>Voice reply and text-to-speech.</p>
                  </div>

                  <div className={`${SL.toggleRow} space-y-3`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Mic className="text-neutral-400" size={20} />
                        <div>
                          <h3 className="text-sm font-medium text-neutral-200">Voice Reply</h3>
                          <p className="text-[10px] text-neutral-500">Automatically speak the response when you use voice input.</p>
                        </div>
                      </div>
                      <div
                        onClick={() => handleLocalSettingChange('VOICE_REPLY', String(!(settings.voice_reply)))}
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

                  <div className={`${SL.toggleRow} space-y-3`}>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-medium text-neutral-300">TTS Provider</h4>
                        <p className="text-[10px] text-neutral-500">Choose the service to read responses aloud.</p>
                      </div>
                      <div className="relative">
                        <select
                          value={settings.tts_provider || 'edge-tts'}
                          onChange={(e) => handleLocalSettingChange('TTS_PROVIDER', e.target.value)}
                          className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[160px]"
                        >
                          <option value="edge-tts">Edge TTS (Neural)</option>
                          <option value="groq" disabled={!settings.groq_api_key}>
                            Groq (Orpheus) {!settings.groq_api_key ? '(Key missing)' : ''}
                          </option>
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                          <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                            <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                          </svg>
                        </div>
                      </div>
                    </div>
                    {!settings.groq_api_key && (
                      <div className="text-[10px] text-amber-500/80 bg-amber-500/5 p-2 rounded border border-amber-500/10 flex flex-wrap items-center justify-between gap-2">
                        <span>Add a Groq API key in Assistant settings to unlock Groq TTS.</span>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedProvider('groq');
                            setActiveTab('assistant');
                          }}
                          className="text-emerald-400 hover:text-emerald-300 font-semibold shrink-0"
                        >
                          Go to Assistant →
                        </button>
                      </div>
                    )}
                    {settings.tts_provider === 'groq' && settings.groq_api_key && (
                      <p className="text-[10px] text-amber-500/80 bg-amber-500/5 p-2 rounded border border-amber-500/10">
                        Note: Groq TTS uses the `canopylabs/orpheus-v1-english` model. It is high quality but limited to 200 characters per segment.
                      </p>
                    )}
                  </div>

                  <div className={`${SL.toggleRow} space-y-3`}>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <h4 className="text-sm font-medium text-neutral-300">Voice Character</h4>
                        <p className="text-[10px] text-neutral-500">Choose the speaker's voice persona.</p>
                      </div>
                      <div className="relative">
                        <select
                          value={settings.tts_voice || ''}
                          onChange={(e) => handleLocalSettingChange('TTS_VOICE', e.target.value)}
                          className="bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-200 focus:outline-none focus:border-emerald-500 transition-colors appearance-none cursor-pointer pr-10 min-w-[160px]"
                        >
                          {settings.tts_provider === 'groq' ? (
                            <>
                              <option value="hannah">Hannah (Groq Orpheus)</option>
                              <option value="troy">Troy (Groq Orpheus)</option>
                            </>
                          ) : (
                            <>
                              <option value="en-US-EmmaNeural">Emma (US)</option>
                              <option value="en-US-AndrewNeural">Andrew (US)</option>
                              <option value="en-GB-SoniaNeural">Sonia (UK)</option>
                              <option value="en-GB-RyanNeural">Ryan (UK)</option>
                            </>
                          )}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-neutral-400">
                          <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                            <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'diagnostics' && (
                <div className={SL.tabStack}>
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Diagnostics</h3>
                    <p className={SL.pageDesc}>Local logs and optional LangSmith tracing.</p>
                  </div>
                  <SubTabBar tabs={DIAGNOSTICS_SUB_TABS} activeId={diagnosticsSubTab} onChange={setDiagnosticsSubTab} />

              {diagnosticsSubTab === 'logs' && (
                <div className="space-y-4 flex flex-col max-h-[520px]">
                  <div className="flex items-center justify-between pb-4 border-b border-neutral-800">
                    <div>
                      <h3 className="text-sm font-medium text-neutral-100">Local logs</h3>
                      <p className={SL.pageDesc}>Backend debug output on this machine.</p>
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

                  <div className="flex-1 bg-black/40 rounded-xl border border-neutral-800 font-mono text-[11px] p-4 overflow-y-auto custom-scrollbar whitespace-normal backdrop-blur-sm max-h-[480px]">
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

              {diagnosticsSubTab === 'tracing' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className={SL.pageHeader}>
                    <h3 className={SL.pageTitle}>Tracing (LangSmith)</h3>
                    <p className={SL.pageDesc}>Optional LangSmith tracing—not the same as local logs.</p>
                  </div>

                  <div className="premium-card rounded-xl p-5 space-y-4">
                    <div className="flex items-center justify-between pb-3 border-b border-white/5 mb-4">
                      <div className="flex items-center gap-2.5">
                        <div className={SL.cardHeaderIcon}>
                          <Activity size={16} />
                        </div>
                        <h4 className={SL.sectionTitle}>LangSmith Tracing</h4>
                      </div>
                      <div
                        onClick={() => handleLocalSettingChange('LANGSMITH_TRACING', String(!(settings.langsmith_tracing)))}
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
                        onSave={handleLocalSettingChange}
                        isSaving={isSavingAll}
                        isSecret
                        placeholder="ls__..."
                      />
                      <SettingInput
                        label="Project Name"
                        dbKey="LANGSMITH_PROJECT"
                        value={settings.langsmith_project}
                        onSave={handleLocalSettingChange}
                        isSaving={isSavingAll}
                        placeholder="Rie-AI"
                      />
                      <div className="md:col-span-2">
                        <SettingInput
                          label="API Endpoint"
                          dbKey="LANGSMITH_ENDPOINT"
                          value={settings.langsmith_endpoint}
                          onSave={handleLocalSettingChange}
                          isSaving={isSavingAll}
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
          )}
        </div>
      </div>

      <AnimatePresence>
        {(Object.keys(pendingChanges).length > 0 || pendingAutoStart !== null) && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="flex items-center justify-between px-6 py-4 bg-neutral-950 border-t border-white/10 shrink-0 z-40"
          >
            <div className="text-sm text-neutral-300">
              You have unsaved changes.
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleDiscard}
                className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm font-medium transition-colors cursor-pointer"
                disabled={isSavingAll}
              >
                Discard
              </button>
              <button
                onClick={handleSaveAll}
                className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors flex items-center gap-2 shadow-[0_0_15px_rgba(16,185,129,0.2)] cursor-pointer"
                disabled={isSavingAll}
              >
                {isSavingAll ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save Changes'
                )}
              </button>
            </div>
          </motion.div>
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

      <ConfirmationModal
        isOpen={discardConfirmOpen}
        onClose={() => setDiscardConfirmOpen(false)}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          setPendingChanges({});
          setPendingAutoStart(null);
          onClose();
        }}
        title="Discard Unsaved Changes?"
        message="You have unsaved changes. Are you sure you want to close settings without saving?"
        confirmText="Discard and Close"
        cancelText="Keep Editing"
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
                  onClick={() => setNgrokConfirmOpen(true)}
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
                  {peerAccessSaving ? 'Savingâ€¦' : 'Save'}
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

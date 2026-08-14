import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plug,
  CheckCircle2,
  RefreshCw,
  X,
  Key,
  Mail,
  Calendar,
  Github,
  MessageSquare,
  FileText,
  Boxes,
  Zap,
  AlertTriangle,
  Settings2,
  Lock,
  Search
} from 'lucide-react';

const BRAND_LOGOS = {
  github: 'https://raw.githubusercontent.com/gilbarbara/logos/main/logos/github-icon.svg',
  gmail: 'https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-gmail.svg',
  jira: 'https://raw.githubusercontent.com/gilbarbara/logos/main/logos/jira.svg',
  slack: 'https://raw.githubusercontent.com/gilbarbara/logos/main/logos/slack-icon.svg',
  notion: 'https://raw.githubusercontent.com/gilbarbara/logos/main/logos/notion-icon.svg',
  calendar: 'https://raw.githubusercontent.com/gilbarbara/logos/main/logos/google-calendar.svg'
};

const ICON_FALLBACKS = {
  gmail: Mail,
  calendar: Calendar,
  github: Github,
  slack: MessageSquare,
  notion: FileText,
  default: Boxes
};

async function openExternalBrowser(href) {
  if (!href) return;
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(href);
  } catch (err) {
    console.warn('Tauri opener plugin not available, falling back to window.open:', err);
    window.open(href, '_blank', 'noopener,noreferrer');
  }
}

function PluginBrandLogo({ pluginId, className = "w-5 h-5" }) {
  const [imageError, setImageError] = useState(false);
  const normalizedId = pluginId?.toLowerCase();
  const logoUrl = BRAND_LOGOS[normalizedId];
  const FallbackIcon = ICON_FALLBACKS[normalizedId] || ICON_FALLBACKS.default;

  const isDarkSvg = normalizedId === 'github' || normalizedId === 'notion';

  if (logoUrl && !imageError) {
    return (
      <img
        src={logoUrl}
        alt={`${pluginId} logo`}
        className={`${className} object-contain ${isDarkSvg ? 'brightness-0 invert' : ''}`}
        onError={() => setImageError(true)}
      />
    );
  }

  return <FallbackIcon className={`${className} text-neutral-400`} />;
}

export function ConnectorsManager() {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectingId, setConnectingId] = useState(null);
  const [selectedPluginId, setSelectedPluginId] = useState(null);
  const [customClientIds, setCustomClientIds] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [message, setMessage] = useState(null);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  const fetchCatalog = async () => {
    try {
      setLoading(true);
      const res = await fetch('http://127.0.0.1:14300/api/plugins/catalog');
      if (res.ok) {
        const data = await res.json();
        setPlugins(data.plugins || []);
      }
    } catch (err) {
      console.error('Failed to fetch plugin catalog:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCatalog();

    const handleMessage = (event) => {
      if (event.data && event.data.type === 'PLUGIN_CONNECTED') {
        setMessage({ type: 'success', text: `Successfully connected ${event.data.provider}!` });
        fetchCatalog();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleConnect = async (plugin) => {
    try {
      setConnectingId(plugin.id);
      setMessage(null);

      const customClientId = customClientIds[plugin.id] || null;
      let url = `http://127.0.0.1:14300/api/plugins/${plugin.id}/connect`;
      if (customClientId) {
        url += `?custom_client_id=${encodeURIComponent(customClientId)}`;
      }

      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();

      if (data.status === 'ok' && data.auth_url) {
        // Open authorization link directly in the user's system default browser (Chrome/Edge/Firefox)
        await openExternalBrowser(data.auth_url);
      } else {
        setMessage({
          type: 'error',
          pluginId: plugin.id,
          text: data.message || 'Failed to initiate OAuth authorization.'
        });
      }
    } catch (err) {
      console.error('Connect error:', err);
      setMessage({
        type: 'error',
        pluginId: plugin.id,
        text: 'OAuth server is offline. Click "Manage" to configure a custom Client ID or start the OAuth server.'
      });
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async (pluginId) => {
    try {
      setLoading(true);
      const res = await fetch(`http://127.0.0.1:14300/api/plugins/${pluginId}/disconnect`, { method: 'POST' });
      if (res.ok) {
        setMessage({ type: 'info', text: `Disconnected ${pluginId}.` });
        await fetchCatalog();
      } else {
        const errData = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: errData.detail || `Failed to disconnect ${pluginId}.` });
      }
    } catch (err) {
      console.error('Disconnect error:', err);
      setMessage({ type: 'error', text: `Failed to disconnect ${pluginId}.` });
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async (pluginId) => {
    try {
      setMessage({ type: 'info', text: `Testing connection for ${pluginId}...` });
      const res = await fetch(`http://127.0.0.1:14300/api/plugins/${pluginId}/sync`, { method: 'POST' });
      if (res.ok) {
        setMessage({ type: 'success', text: `${pluginId} connection verified!` });
        await fetchCatalog();
      } else {
        const errData = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: errData.detail || `Verification failed for ${pluginId}.` });
      }
    } catch (err) {
      console.error('Sync error:', err);
      setMessage({ type: 'error', text: `Failed to test connection for ${pluginId}.` });
    }
  };

  const handleToggleCapability = async (pluginId, capability, currentEnabled) => {
    try {
      const res = await fetch(
        `http://127.0.0.1:14300/api/plugins/${pluginId}/capabilities?capability=${encodeURIComponent(
          capability
        )}&enabled=${!currentEnabled}`,
        { method: 'POST' }
      );
      if (res.ok) {
        setMessage({ type: 'info', text: `Updated capability '${capability}'.` });
        await fetchCatalog();
      }
    } catch (err) {
      console.error('Capability toggle error:', err);
    }
  };

  // Derive available categories dynamically
  const categories = useMemo(() => {
    const set = new Set(['All', 'Connected']);
    plugins.forEach((p) => {
      if (p.category) set.add(p.category);
    });
    return Array.from(set);
  }, [plugins]);

  // Compute filtered plugins
  const filteredPlugins = useMemo(() => {
    return plugins.filter((p) => {
      if (selectedCategory === 'Connected' && p.status !== 'connected') return false;
      if (selectedCategory !== 'All' && selectedCategory !== 'Connected' && p.category !== selectedCategory) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const nameMatch = p.displayName?.toLowerCase().includes(q);
        const descMatch = p.description?.toLowerCase().includes(q);
        const categoryMatch = p.category?.toLowerCase().includes(q);
        const toolMatch = p.tools?.some((t) => t.name.toLowerCase().includes(q));
        return nameMatch || descMatch || categoryMatch || toolMatch;
      }
      return true;
    });
  }, [plugins, selectedCategory, searchQuery]);

  const activePlugin = plugins.find((p) => p.id === selectedPluginId);

  return (
    <div className="space-y-4 text-neutral-200">
      {/* Clean Compact Search & Category Filter Toolbar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pb-1 border-b border-neutral-800/60">
        {/* Search Bar */}
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-neutral-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search connectors or tools..."
            className="w-full pl-8 pr-7 py-1.5 rounded-lg bg-neutral-900 border border-neutral-800 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-emerald-500/80 transition"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-500 hover:text-white"
            >
              ×
            </button>
          )}
        </div>

        {/* Category Pills & Refresh Button */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          {categories.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap transition ${
                  isSelected
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200 border border-neutral-800'
                }`}
              >
                {cat}
              </button>
            );
          })}

          <button
            onClick={fetchCatalog}
            disabled={loading}
            className="p-1.5 text-neutral-400 hover:text-white bg-neutral-900 hover:bg-neutral-800 rounded-md transition border border-neutral-800 shrink-0 ml-1"
            title="Refresh Catalog"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-emerald-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Alert Notification Toast */}
      {message && (
        <div
          className={`p-3 rounded-lg text-xs border flex items-center justify-between gap-3 ${
            message.type === 'success'
              ? 'bg-emerald-950/40 text-emerald-300 border-emerald-500/30'
              : message.type === 'error'
              ? 'bg-rose-950/40 text-rose-300 border-rose-500/30'
              : 'bg-neutral-900 text-neutral-300 border-neutral-700'
          }`}
        >
          <span className="flex-1">{message.text}</span>
          <div className="flex items-center gap-2 shrink-0">
            {message.pluginId && message.type === 'error' && (
              <button
                onClick={() => {
                  setSelectedPluginId(message.pluginId);
                  setShowAdvanced(true);
                }}
                className="px-2 py-0.5 rounded bg-rose-900/60 hover:bg-rose-800 text-white text-[11px] font-medium border border-rose-700 transition"
              >
                Configure Client ID
              </button>
            )}
            <button onClick={() => setMessage(null)} className="text-[11px] hover:underline text-neutral-400 hover:text-white">
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* 2-Column Plugin Cards */}
      {filteredPlugins.length === 0 ? (
        <div className="py-8 text-center rounded-xl bg-neutral-900/30 border border-neutral-800/60 text-xs text-neutral-500">
          No matching connectors found
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredPlugins.map((plugin) => {
            const isConnected = plugin.status === 'connected';

            return (
              <div
                key={plugin.id}
                className={`p-4 rounded-xl border flex flex-col justify-between gap-3 transition-all duration-200 ${
                  isConnected
                    ? 'bg-neutral-900/90 border-emerald-500/30'
                    : 'bg-neutral-900/40 border-neutral-800 hover:border-neutral-700'
                }`}
              >
                {/* Top Row: Logo, Title, Category & Status Pill */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-neutral-950 border border-neutral-800 flex items-center justify-center shrink-0">
                      <PluginBrandLogo pluginId={plugin.id} className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-semibold text-white text-sm truncate">
                        {plugin.displayName}
                      </h4>
                      {plugin.category && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-normal inline-block mt-0.5">
                          {plugin.category}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status Indicator */}
                  <span
                    className={`shrink-0 text-[11px] px-2.5 py-1 rounded-full font-medium border flex items-center gap-1 ${
                      isConnected
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-neutral-800/60 text-neutral-400 border-neutral-700/60'
                    }`}
                  >
                    {isConnected && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                    {isConnected ? 'Connected' : 'Not Connected'}
                  </span>
                </div>

                {/* Description */}
                <p className="text-xs text-neutral-400 leading-relaxed line-clamp-2 min-h-[2.5rem]">
                  {plugin.description}
                </p>

                {/* Bottom Row: Actions */}
                <div className="pt-3 border-t border-neutral-800/60 flex items-center justify-between gap-2">
                  <button
                    onClick={() => {
                      setSelectedPluginId(plugin.id);
                      setShowAdvanced(false);
                    }}
                    className="text-xs text-neutral-400 hover:text-emerald-400 font-medium flex items-center gap-1.5 transition-colors"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    <span>Manage & Tools ({plugin.tools?.length || 0})</span>
                  </button>

                  {isConnected ? (
                    <button
                      onClick={() => {
                        setSelectedPluginId(plugin.id);
                        setShowAdvanced(false);
                      }}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition"
                    >
                      Manage
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(plugin)}
                      disabled={connectingId === plugin.id}
                      className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition disabled:opacity-50"
                    >
                      {connectingId === plugin.id ? 'Connecting...' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal for Plugin Management */}
      <AnimatePresence>
        {activePlugin && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            >
              {/* Modal Header */}
              <div className="p-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/60">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-neutral-950 border border-neutral-800 flex items-center justify-center shrink-0">
                    <PluginBrandLogo pluginId={activePlugin.id} className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-white text-base flex items-center gap-2">
                      {activePlugin.displayName}
                      <span className="text-xs px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 font-normal">
                        {activePlugin.category}
                      </span>
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">{activePlugin.description}</p>
                  </div>
                </div>

                <button
                  onClick={() => setSelectedPluginId(null)}
                  className="p-1.5 text-neutral-400 hover:text-white rounded-lg hover:bg-neutral-800 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-5 overflow-y-auto space-y-5 flex-1 text-xs">
                {/* Connection Status & Main Actions */}
                <div className="p-3.5 rounded-xl bg-neutral-950/60 border border-neutral-800/80 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] text-neutral-400 font-medium">Connection Status</div>
                    <div className="mt-1 flex items-center gap-2">
                      {activePlugin.status === 'connected' ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Connected
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                          Not Connected
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {activePlugin.status === 'connected' ? (
                      <>
                        <button
                          onClick={() => handleSync(activePlugin.id)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 transition"
                        >
                          Verify
                        </button>
                        <button
                          onClick={() => handleDisconnect(activePlugin.id)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 border border-rose-800/30 transition"
                        >
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => handleConnect(activePlugin)}
                        disabled={connectingId === activePlugin.id}
                        className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Plug className="w-3.5 h-3.5" />
                        {connectingId === activePlugin.id ? 'Connecting...' : 'Connect'}
                      </button>
                    )}
                  </div>
                </div>

                {/* Account Details if Connected */}
                {activePlugin.status === 'connected' && (activePlugin.account_info?.email || activePlugin.account_info?.name) && (
                  <div className="p-3 rounded-xl bg-neutral-950/40 border border-neutral-800 space-y-1">
                    <div className="text-[11px] text-neutral-400">Authenticated Account</div>
                    <div className="text-white font-medium flex items-center justify-between">
                      <span>{activePlugin.account_info?.email || activePlugin.account_info?.name}</span>
                      <span className="text-[10px] text-neutral-500 flex items-center gap-1">
                        <Lock className="w-3 h-3 text-emerald-400" /> Fernet Encrypted
                      </span>
                    </div>
                  </div>
                )}

                {/* Tool Capabilities & HITL Security Controls */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-200 flex items-center gap-1.5">
                      <Zap className="w-3.5 h-3.5 text-emerald-400" />
                      Agent Tools & Security ({activePlugin.tools?.length || 0})
                    </span>
                    <span className="text-[10px] text-neutral-500">HITL = Human Approval</span>
                  </div>

                  <div className="space-y-2">
                    {activePlugin.tools?.map((tool) => {
                      const isWrite = tool.risk_level === 'write' || tool.risk_level === 'destructive';
                      const disabledCaps = activePlugin.config?.disabled_capabilities || [];
                      const isCapEnabled = !tool.capability || !disabledCaps.includes(tool.capability);

                      return (
                        <div
                          key={tool.name}
                          className={`p-3 rounded-xl border transition-all ${
                            isCapEnabled
                              ? 'bg-neutral-950/80 border-neutral-800'
                              : 'bg-neutral-950/30 border-neutral-900 opacity-60'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2.5">
                              {tool.capability && activePlugin.status === 'connected' && (
                                <input
                                  type="checkbox"
                                  checked={isCapEnabled}
                                  onChange={() =>
                                    handleToggleCapability(activePlugin.id, tool.capability, isCapEnabled)
                                  }
                                  className="w-3.5 h-3.5 rounded border-neutral-700 bg-neutral-900 text-emerald-500 focus:ring-0 cursor-pointer"
                                />
                              )}
                              <div className="font-mono text-emerald-400 font-medium">{tool.name}</div>
                            </div>

                            <span
                              className={`text-[9px] px-2 py-0.5 rounded font-sans font-semibold border flex items-center gap-1 ${
                                isWrite
                                  ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                  : 'bg-neutral-800 text-neutral-300 border-neutral-700'
                              }`}
                            >
                              {isWrite ? (
                                <>
                                  <AlertTriangle className="w-3 h-3 text-amber-400" /> WRITE (HITL)
                                </>
                              ) : (
                                'READ ONLY'
                              )}
                            </span>
                          </div>
                          <div className="font-sans text-[11px] text-neutral-400 mt-1.5 leading-relaxed">
                            {tool.description}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Advanced Custom OAuth Section */}
                <div className="pt-2 border-t border-neutral-800/60">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-[11px] text-neutral-400 hover:text-white flex items-center gap-1 font-medium"
                  >
                    <Key className="w-3.5 h-3.5 text-neutral-500" />
                    {showAdvanced ? 'Hide Custom Credentials' : 'Custom Client ID (Self-Host)'}
                  </button>

                  {showAdvanced && (
                    <div className="mt-2 p-3 rounded-xl bg-neutral-950 border border-neutral-800 space-y-2">
                      <label className="text-[11px] text-neutral-400 block font-sans">
                        Custom OAuth Client ID (Optional override):
                      </label>
                      <input
                        type="text"
                        value={customClientIds[activePlugin.id] || ''}
                        onChange={(e) =>
                          setCustomClientIds({ ...customClientIds, [activePlugin.id]: e.target.value })
                        }
                        placeholder="e.g. 123456789-abc.apps.googleusercontent.com"
                        className="w-full px-3 py-1.5 rounded-lg bg-neutral-900 border border-neutral-700 text-xs text-white placeholder-neutral-600 focus:outline-none focus:border-emerald-500"
                      />
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default ConnectorsManager;

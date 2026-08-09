import React, { useState, useEffect, useCallback } from "react";
import {
  Globe,
  RefreshCw,
  CheckCircle2,
  Plus,
  ShieldCheck,
  Package,
  Cpu,
  Download,
  AlertTriangle,
  Loader2,
  Monitor,
  Eye,
  EyeOff,
  Sparkles,
  Trash2,
  Play
} from "lucide-react";
import {
  getBrowserStatus,
  getBrowserProfiles,
  createBrowserProfile,
  deleteBrowserProfile,
  fetchBrowserBinary,
  deleteBrowserBinary,
  performBrowserAction,
  updateSetting
} from "../../services/chatApi";

export default function BrowserSettingsSection() {
  const [engineChoice, setEngineChoice] = useState(() => {
    return localStorage.getItem("rie_browser_engine") || "default";
  });
  const [headlessMode, setHeadlessMode] = useState(() => {
    return localStorage.getItem("rie_camofox_headless_mode") || "auto";
  });
  const [status, setStatus] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [fetchingBinary, setFetchingBinary] = useState(false);
  const [newProfileId, setNewProfileId] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deletingProfileId, setDeletingProfileId] = useState(null);
  const [launchingProfileId, setLaunchingProfileId] = useState(null);
  const [deletingBinary, setDeletingBinary] = useState(false);
  const [error, setError] = useState(null);

  const fetchBrowserData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [statusData, profilesData] = await Promise.all([
        getBrowserStatus(),
        getBrowserProfiles(),
      ]);
      setStatus(statusData);
      setProfiles(profilesData);
      if (statusData?.headless_mode) {
        setHeadlessMode(statusData.headless_mode);
        localStorage.setItem("rie_camofox_headless_mode", statusData.headless_mode);
      }
      if (statusData?.is_fetching) {
        setFetchingBinary(true);
      } else {
        setFetchingBinary(false);
      }
    } catch (err) {
      console.error("Error fetching browser subsystem data:", err);
      setError(err.message || "Failed to connect to browser engine service.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBrowserData();
  }, [fetchBrowserData]);

  const handleSelectEngine = (choice) => {
    setEngineChoice(choice);
    localStorage.setItem("rie_browser_engine", choice);
    window.dispatchEvent(new Event("rie_browser_engine_change"));
  };

  const handleSelectHeadlessMode = async (mode) => {
    setHeadlessMode(mode);
    localStorage.setItem("rie_camofox_headless_mode", mode);
    try {
      await updateSetting("CAMOFOX_HEADLESS_MODE", mode);
    } catch (e) {
      console.error("Failed to save headless mode setting:", e);
    }
  };

  // Poll while binary is fetching
  useEffect(() => {
    let timer;
    let mounted = true;
    if (fetchingBinary) {
      timer = setInterval(async () => {
        try {
          const statusData = await getBrowserStatus();
          if (!mounted) return;
          setStatus(statusData);
          if (!statusData?.is_fetching) {
            setFetchingBinary(false);
          }
        } catch (e) {
          console.error("Polling status error:", e);
        }
      }, 1000);
    }
    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [fetchingBinary]);

  const handleDownloadBinary = async () => {
    try {
      setFetchingBinary(true);
      setError(null);
      await fetchBrowserBinary();
      await fetchBrowserData();
    } catch (err) {
      setFetchingBinary(false);
      setError(err.message || "Failed to download browser binary.");
    }
  };

  const handleDeleteBinary = async () => {
    if (!window.confirm("Are you sure you want to delete the downloaded Camoufox stealth browser binary (~150MB)? You can re-download it anytime.")) {
      return;
    }
    try {
      setDeletingBinary(true);
      setError(null);
      await deleteBrowserBinary();
      await fetchBrowserData();
    } catch (err) {
      setError(err.message || "Failed to delete browser binary.");
    } finally {
      setDeletingBinary(false);
    }
  };

  const handleCreateProfile = async (e) => {
    e.preventDefault();
    if (!newProfileId.trim()) return;
    try {
      setActionLoading(true);
      setError(null);
      await createBrowserProfile(newProfileId, newProfileName);
      setNewProfileId("");
      setNewProfileName("");
      setShowCreateModal(false);
      await fetchBrowserData();
    } catch (err) {
      setError(err.message || "Failed to create profile.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteProfile = async (profileId) => {
    if (!profileId || profileId === "default") return;
    if (!window.confirm(`Are you sure you want to delete profile '${profileId}'? This will permanently remove its saved cookies, session data, and directory.`)) {
      return;
    }
    try {
      setDeletingProfileId(profileId);
      setError(null);
      await deleteBrowserProfile(profileId);
      await fetchBrowserData();
    } catch (err) {
      setError(err.message || `Failed to delete profile '${profileId}'.`);
    } finally {
      setDeletingProfileId(null);
    }
  };

  const handleLaunchProfile = async (profileId) => {
    try {
      setLaunchingProfileId(profileId);
      setError(null);
      await performBrowserAction("open", { url: "https://google.com", profile: profileId, headless: false });
      window.dispatchEvent(new CustomEvent("rie_open_browser_panel", { detail: { profile: profileId } }));
      await fetchBrowserData();
    } catch (err) {
      setError(err.message || `Failed to launch profile '${profileId}'.`);
    } finally {
      setLaunchingProfileId(null);
    }
  };

  const isBinaryAvailable = status?.browser_binary?.available;
  const isFetching = fetchingBinary || status?.is_fetching;
  const downloadPct = status?.download_percentage ?? 0;
  const downloadStage = status?.download_stage || (isFetching ? "downloading" : "idle");
  const downloadBytes = status?.download_bytes || 0;
  const totalBytes = status?.total_bytes || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium text-neutral-100 flex items-center gap-2">
            <Globe className="w-4 h-4 text-neutral-400" /> Browser Engine & Profiles
          </h3>
          <p className="text-xs text-neutral-400 mt-0.5">
            Choose your preferred browser engine for web tasks and automation.
          </p>
        </div>
        {engineChoice === "camoufox" && (
          <button
            onClick={fetchBrowserData}
            disabled={loading || actionLoading}
            className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors border border-neutral-800"
            title="Refresh Status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs rounded-lg">
          {error}
        </div>
      )}

      {/* Selector Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Default Browser Option */}
        <div
          onClick={() => handleSelectEngine("default")}
          className={`p-4 rounded-xl border cursor-pointer transition-all ${
            engineChoice === "default"
              ? "bg-neutral-800/80 border-neutral-600 text-neutral-100"
              : "bg-neutral-900/40 border-neutral-800/80 text-neutral-400 hover:border-neutral-700"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`p-2 rounded-lg ${
                engineChoice === "default"
                  ? "bg-neutral-700 text-neutral-100"
                  : "bg-neutral-800/60 text-neutral-400"
              }`}
            >
              <Monitor className="w-4 h-4" />
            </div>
            <div>
              <div className="font-medium text-xs text-neutral-200 flex items-center gap-2">
                Default Browser (Windows UI Tool)
                {engineChoice === "default" && (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-neutral-700 text-neutral-200 border border-neutral-600">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
                Uses native Windows UI automation and system default browser. No downloads required.
              </p>
            </div>
          </div>
        </div>

        {/* Camoufox Option */}
        <div
          onClick={() => handleSelectEngine("camoufox")}
          className={`p-4 rounded-xl border cursor-pointer transition-all ${
            engineChoice === "camoufox"
              ? "bg-neutral-800/80 border-neutral-600 text-neutral-100"
              : "bg-neutral-900/40 border-neutral-800/80 text-neutral-400 hover:border-neutral-700"
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`p-2 rounded-lg ${
                engineChoice === "camoufox"
                  ? "bg-neutral-700 text-neutral-100"
                  : "bg-neutral-800/60 text-neutral-400"
              }`}
            >
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <div className="font-medium text-xs text-neutral-200 flex items-center gap-2">
                Camoufox Engine (Stealth Firefox)
                {engineChoice === "camoufox" && (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-neutral-700 text-neutral-200 border border-neutral-600">
                    Active
                  </span>
                )}
              </div>
              <p className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
                Embedded stealth browser engine with C++ anti-fingerprinting. Requires binary download.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Default Browser View */}
      {engineChoice === "default" && (
        <div className="p-4 bg-neutral-900/40 border border-neutral-800/80 rounded-xl space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-neutral-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" /> Windows Native UI Automation Active
          </div>
          <p className="text-xs text-neutral-400 leading-relaxed">
            Rie will use your system's default browser with native Windows UI tools. Camoufox browser binaries and stealth profile management are hidden.
          </p>
        </div>
      )}

      {/* Camoufox View */}
      {engineChoice === "camoufox" && (
        <div className="space-y-4">
          {/* Status Card */}
          <div className="bg-neutral-900/40 border border-neutral-800/80 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-neutral-800 text-neutral-300 rounded-lg border border-neutral-700/60">
                  <Cpu className="w-4 h-4" />
                </div>
                <div>
                  <div className="font-medium text-xs text-neutral-200">Camoufox Stealth Engine</div>
                  <div className="text-[11px] text-neutral-400 font-mono mt-0.5">Embedded Firefox (Playwright)</div>
                </div>
              </div>

              <div>
                {isFetching ? (
                  <span className="px-2.5 py-1 text-[11px] rounded bg-neutral-800 text-neutral-200 border border-neutral-700 flex items-center gap-1.5 font-mono">
                    <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
                    {downloadPct > 0 ? `Downloading (${downloadPct.toFixed(1)}%)` : "Downloading..."}
                  </span>
                ) : isBinaryAvailable ? (
                  <span className="px-2.5 py-1 text-[11px] rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    ● Ready
                  </span>
                ) : (
                  <span className="px-2.5 py-1 text-[11px] rounded bg-neutral-800 text-neutral-400 border border-neutral-700">
                    ● Download Required
                  </span>
                )}
              </div>
            </div>

            {/* Binary Download Banner */}
            {!isBinaryAvailable && (
              <div className="p-3.5 bg-neutral-950 border border-neutral-800 rounded-lg space-y-3 text-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-neutral-200 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400" /> Camoufox Browser Binary Needed (~150MB)
                    </div>
                    <p className="text-neutral-400 text-[11px] mt-0.5">
                      Download the stealth Firefox executable to enable the Camoufox engine.
                    </p>
                  </div>
                  <button
                    onClick={handleDownloadBinary}
                    disabled={isFetching}
                    className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-colors shrink-0 disabled:opacity-50"
                  >
                    {isFetching ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                        {downloadPct > 0 ? `Downloading (${downloadPct.toFixed(1)}%)` : "Downloading..."}
                      </>
                    ) : (
                      <>
                        <Download className="w-3.5 h-3.5" /> Download Binary
                      </>
                    )}
                  </button>
                </div>

                {/* Real-time Progress Bar during binary download */}
                {isFetching && (
                  <div className="pt-2.5 border-t border-neutral-800/80 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-neutral-300 font-medium capitalize flex items-center gap-1.5">
                        <span className="inline-block w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
                        Stage: <span className="text-sky-400 font-mono">{downloadStage}</span>
                      </span>
                      <span className="text-neutral-200 font-mono">
                        {downloadPct > 0 ? `${downloadPct.toFixed(1)}%` : "Starting..."}
                        {totalBytes > 0 && (
                          <span className="text-neutral-400 ml-1.5">
                            ({(downloadBytes / (1024 * 1024)).toFixed(1)}MB / {(totalBytes / (1024 * 1024)).toFixed(1)}MB)
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="w-full bg-neutral-900 rounded-full h-2 border border-neutral-800 overflow-hidden">
                      <div
                        className="bg-sky-500 h-full rounded-full transition-all duration-300 ease-out"
                        style={{ width: `${Math.min(100, Math.max(2, downloadPct))}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-3 border-t border-neutral-800/80 text-xs">
              <div>
                <span className="text-neutral-400 block text-[11px]">Package Version</span>
                <span className="text-neutral-200 font-mono">{status?.camoufox_version || "—"}</span>
              </div>
              <div>
                <span className="text-neutral-400 block text-[11px]">Mode</span>
                <span className="text-neutral-200 font-mono capitalize">{status?.mode || "embedded"}</span>
              </div>
              <div>
                <span className="text-neutral-400 block text-[11px]">Anti-Fingerprinting</span>
                <span className="text-emerald-400 flex items-center gap-1 font-medium text-[11px]">
                  <ShieldCheck className="w-3.5 h-3.5" /> Active
                </span>
              </div>
            </div>

            {/* Binary Info */}
            {status?.browser_binary && (
              <div className="pt-2 border-t border-neutral-800/80 flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs">
                  <Package className="w-3.5 h-3.5 text-neutral-400" />
                  <span className="text-neutral-400 text-[11px]">Browser Binary:</span>
                  {status.browser_binary.available ? (
                    <span className="text-emerald-400 flex items-center gap-1 font-mono text-[11px]">
                      <CheckCircle2 className="w-3 h-3" />
                      {status.browser_binary.version || "Installed"}
                    </span>
                  ) : (
                    <span className="text-neutral-400 font-mono text-[11px]">Not downloaded</span>
                  )}
                </div>
                {status.browser_binary.available && (
                  <button
                    onClick={handleDeleteBinary}
                    disabled={deletingBinary || isFetching}
                    className="px-2.5 py-1 text-[11px] rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 flex items-center gap-1.5 transition-colors disabled:opacity-50 font-medium"
                    title="Delete downloaded browser binary (~150MB)"
                  >
                    {deletingBinary ? (
                      <Loader2 className="w-3 h-3 animate-spin text-rose-400" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                    Delete Binary
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Browser Window Mode Selector (headless, normal, auto) */}
          <div className="bg-neutral-900/40 border border-neutral-800/80 rounded-xl p-4 space-y-3">
            <div>
              <h4 className="font-medium text-xs text-neutral-200 flex items-center gap-2">
                <Monitor className="w-3.5 h-3.5 text-neutral-400" /> Browser Window Mode
              </h4>
              <p className="text-[11px] text-neutral-400 mt-0.5">
                Configure whether Camoufox runs in headless mode, visible desktop GUI mode, or smart auto mode.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
              {/* Headless Option */}
              <div
                onClick={() => handleSelectHeadlessMode("headless")}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  headlessMode === "headless"
                    ? "bg-neutral-800/90 border-neutral-600 text-neutral-100 ring-1 ring-neutral-500/50"
                    : "bg-neutral-950/60 border-neutral-800/80 text-neutral-400 hover:border-neutral-700"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <EyeOff className={`w-3.5 h-3.5 ${headlessMode === "headless" ? "text-amber-400" : "text-neutral-500"}`} />
                  <span className="font-medium text-xs text-neutral-200">Headless</span>
                  {headlessMode === "headless" && (
                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-neutral-700 text-neutral-200 border border-neutral-600 font-mono">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-neutral-400 leading-normal">
                  Invisibly runs in background. Fastest performance without opening desktop windows.
                </p>
              </div>

              {/* Normal / GUI Option */}
              <div
                onClick={() => handleSelectHeadlessMode("normal")}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  headlessMode === "normal"
                    ? "bg-neutral-800/90 border-neutral-600 text-neutral-100 ring-1 ring-neutral-500/50"
                    : "bg-neutral-950/60 border-neutral-800/80 text-neutral-400 hover:border-neutral-700"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Eye className={`w-3.5 h-3.5 ${headlessMode === "normal" ? "text-emerald-400" : "text-neutral-500"}`} />
                  <span className="font-medium text-xs text-neutral-200">Normal</span>
                  {headlessMode === "normal" && (
                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-neutral-700 text-neutral-200 border border-neutral-600 font-mono">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-neutral-400 leading-normal">
                  Opens a visible GUI window on desktop with full video/audio playback and manual input.
                </p>
              </div>

              {/* Auto Option */}
              <div
                onClick={() => handleSelectHeadlessMode("auto")}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  headlessMode === "auto"
                    ? "bg-neutral-800/90 border-neutral-600 text-neutral-100 ring-1 ring-neutral-500/50"
                    : "bg-neutral-950/60 border-neutral-800/80 text-neutral-400 hover:border-neutral-700"
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Sparkles className={`w-3.5 h-3.5 ${headlessMode === "auto" ? "text-sky-400" : "text-neutral-500"}`} />
                  <span className="font-medium text-xs text-neutral-200">Auto</span>
                  {headlessMode === "auto" && (
                    <span className="ml-auto text-[9px] px-1.5 py-0.5 rounded bg-neutral-700 text-neutral-200 border border-neutral-600 font-mono">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-neutral-400 leading-normal">
                  LLM Decided. AI automatically passes headless=True for background tasks and visible GUI for user media & interactive sessions.
                </p>
              </div>
            </div>
          </div>

          {/* Profiles Card */}
          <div className="bg-neutral-900/40 border border-neutral-800/80 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-xs text-neutral-200">Persistent Browser Profiles</h4>
                <p className="text-[11px] text-neutral-400 mt-0.5">
                  Isolated user identities containing cookies, localStorage, and login sessions.
                </p>
              </div>
              <button
                onClick={() => setShowCreateModal(true)}
                className="px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> New Profile
              </button>
            </div>

            <div className="divide-y divide-slate-800/60">
              {profiles.length === 0 ? (
                <div className="py-4 text-center text-xs text-neutral-500">
                  No custom browser profiles created yet.
                </div>
              ) : (
                profiles.map((prof) => (
                  <div key={prof.id} className="py-2.5 flex items-center justify-between">
                    <div>
                      <span className="font-medium text-xs text-neutral-200">{prof.name || prof.id}</span>
                      <span className="ml-2 text-[11px] font-mono text-neutral-400">({prof.id})</span>
                      <div className="text-[11px] text-neutral-500 mt-0.5">
                        Last used: {prof.last_used_at ? new Date(prof.last_used_at).toLocaleString() : "Never"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleLaunchProfile(prof.id)}
                        disabled={launchingProfileId === prof.id || !isBinaryAvailable}
                        className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 flex items-center gap-1.5 transition-colors disabled:opacity-50"
                        title={isBinaryAvailable ? `Launch browser session with profile '${prof.id}'` : "Download browser binary first"}
                      >
                        {launchingProfileId === prof.id ? (
                          <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
                        ) : (
                          <Play className="w-3 h-3 text-emerald-400" />
                        )}
                        Launch
                      </button>
                      <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-neutral-800 text-neutral-300 border border-neutral-700">
                        {prof.provider}
                      </span>
                      {prof.id !== "default" && (
                        <button
                          onClick={() => handleDeleteProfile(prof.id)}
                          disabled={deletingProfileId === prof.id}
                          className="p-1.5 text-neutral-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors border border-transparent hover:border-rose-500/20 disabled:opacity-50"
                          title={`Delete profile '${prof.id}'`}
                        >
                          {deletingProfileId === prof.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-400" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Profile Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 w-full max-w-md space-y-4 shadow-xl">
            <h4 className="text-sm font-medium text-neutral-100">Create Persistent Profile</h4>
            <form onSubmit={handleCreateProfile} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Profile Identifier (ID)</label>
                <input
                  type="text"
                  placeholder="e.g. work or research"
                  value={newProfileId}
                  onChange={(e) => setNewProfileId(e.target.value)}
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 text-xs focus:outline-none focus:border-neutral-600"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Display Name (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Work Profile"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  className="w-full px-3 py-2 bg-neutral-950 border border-neutral-800 rounded-lg text-neutral-200 text-xs focus:outline-none focus:border-neutral-600"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-1.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-medium rounded-lg transition-colors border border-neutral-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-3.5 py-1.5 bg-neutral-700 hover:bg-neutral-600 text-neutral-100 text-xs font-medium rounded-lg transition-colors"
                >
                  Create Profile
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

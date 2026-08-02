import React, { useState, useEffect } from "react";
import { Globe, RefreshCw, CheckCircle2, Plus, ShieldCheck, Package, Cpu } from "lucide-react";
import {
  getBrowserStatus,
  getBrowserProfiles,
  createBrowserProfile,
} from "../../services/chatApi";

export default function BrowserSettingsSection() {
  const [status, setStatus] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [newProfileId, setNewProfileId] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [error, setError] = useState(null);

  const fetchBrowserData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [statusData, profilesData] = await Promise.all([
        getBrowserStatus(),
        getBrowserProfiles(),
      ]);
      setStatus(statusData);
      setProfiles(profilesData);
    } catch (err) {
      console.error("Error fetching browser subsystem data:", err);
      setError(err.message || "Failed to connect to browser engine service.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBrowserData();
  }, []);

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

  const getBadgeStyle = (state) => {
    switch (state) {
      case "ready":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
      case "starting":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20";
      case "stopped":
        return "bg-slate-500/10 text-slate-400 border-slate-500/20";
      default:
        return "bg-rose-500/10 text-rose-400 border-rose-500/20";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium text-slate-100 flex items-center gap-2">
            <Globe className="w-5 h-5 text-indigo-400" /> Browser Engine & Profiles
          </h3>
          <p className="text-sm text-slate-400 mt-1">
            Rie's native Camoufox stealth browser engine — embedded in-process via Playwright. No external server required.
          </p>
        </div>
        <button
          onClick={fetchBrowserData}
          disabled={loading || actionLoading}
          className="p-2 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors"
          title="Refresh Browser Status"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm rounded-lg">
          {error}
        </div>
      )}

      {/* Status Card */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-indigo-400">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="font-medium text-slate-200">Camoufox Engine</div>
              <div className="text-xs text-slate-400 font-mono mt-0.5">Embedded Stealth Firefox (Playwright)</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`px-3 py-1 text-xs font-semibold rounded-full border capitalize ${getBadgeStyle(
                status?.state || "stopped"
              )}`}
            >
              ● {status?.state || "stopped"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-3 border-t border-slate-800/80 text-xs">
          <div>
            <span className="text-slate-400 block">Package Version</span>
            <span className="text-slate-200 font-mono">{status?.camoufox_version || "—"}</span>
          </div>
          <div>
            <span className="text-slate-400 block">Mode</span>
            <span className="text-slate-200 font-mono capitalize">{status?.mode || "embedded"}</span>
          </div>
          <div>
            <span className="text-slate-400 block">Anti-Fingerprinting</span>
            <span className="text-emerald-400 flex items-center gap-1 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" /> Active
            </span>
          </div>
        </div>

        {/* Browser Binary Info */}
        {status?.browser_binary && (
          <div className="pt-2 border-t border-slate-800/80">
            <div className="flex items-center gap-2 text-xs">
              <Package className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-slate-400">Browser Binary:</span>
              {status.browser_binary.available ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />
                  {status.browser_binary.version || "Installed"}
                </span>
              ) : (
                <span className="text-amber-400">Not downloaded — run: camoufox fetch</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Profiles Card */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-medium text-slate-200">Persistent Browser Profiles</h4>
            <p className="text-xs text-slate-400 mt-0.5">
              Isolated user identities containing cookies, localStorage, and login sessions.
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New Profile
          </button>
        </div>

        <div className="divide-y divide-slate-800/60">
          {profiles.map((prof) => (
            <div key={prof.id} className="py-3 flex items-center justify-between">
              <div>
                <span className="font-medium text-sm text-slate-200">{prof.name}</span>
                <span className="ml-2 text-xs font-mono text-slate-400">({prof.id})</span>
                <div className="text-xs text-slate-400 mt-0.5">
                  Last used: {prof.last_used_at ? new Date(prof.last_used_at).toLocaleString() : "Never"}
                </div>
              </div>
              <span className="px-2.5 py-1 text-[11px] font-mono rounded bg-slate-800 text-slate-300 border border-slate-700">
                {prof.provider}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Create Profile Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 w-full max-w-md space-y-4 shadow-xl">
            <h4 className="text-base font-medium text-slate-100">Create Persistent Profile</h4>
            <form onSubmit={handleCreateProfile} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Profile Identifier (ID)</label>
                <input
                  type="text"
                  placeholder="e.g. work or research"
                  value={newProfileId}
                  onChange={(e) => setNewProfileId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 text-sm focus:outline-none focus:border-indigo-500"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Display Name (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Work Profile"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors"
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

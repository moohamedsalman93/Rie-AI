import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  BarChart3,
  RefreshCw,
  TrendingUp,
  Calendar,
  Layers,
  Cpu,
  Trash2,
  Download,
  AlertCircle,
  Clock,
  Zap,
  Info,
  ChevronDown,
  ChevronUp,
  Check,
} from "lucide-react";
import {
  getTokenUsageSummary,
  getDailyTokenUsage,
  getTokenUsageLogs,
  clearTokenUsage,
} from "../../services/chatApi";
import { SL } from "./settingsLayout";

function formatNumber(num) {
  if (num == null || isNaN(num)) return "0";
  return Number(num).toLocaleString();
}

function formatCompact(num) {
  if (num == null || isNaN(num)) return "0";
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function formatDateLabel(dateStr) {
  if (!dateStr) return "";
  try {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(year, month, day);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  } catch (e) {
    // fallback
  }
  return dateStr;
}

function formatDateLong(dateStr) {
  if (!dateStr) return "";
  try {
    const parts = dateStr.split("-");
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      const d = new Date(year, month, day);
      return d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  } catch (e) {
    // fallback
  }
  return dateStr;
}

function estimateCost(promptTokens = 0, completionTokens = 0) {
  // Blended approximation: ~$1.50 per 1M prompt tokens, ~$3.00 per 1M completion tokens
  const promptCost = (promptTokens / 1_000_000) * 1.5;
  const completionCost = (completionTokens / 1_000_000) * 3.0;
  const total = promptCost + completionCost;
  if (total < 0.001 && total > 0) return "<$0.001";
  return `$${total.toFixed(3)}`;
}

export default function TokenUsageSettingsSection() {
  const [daysRange, setDaysRange] = useState(30);
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [hoveredDay, setHoveredDay] = useState(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [copiedExport, setCopiedExport] = useState(false);

  const fetchData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const summary = await getTokenUsageSummary(daysRange);
      setData(summary);

      if (showLogs) {
        const rawLogs = await getTokenUsageLogs(50, 0);
        setLogs(rawLogs || []);
      }
    } catch (err) {
      console.error("Failed to load token usage:", err);
      setError(err.message || "Failed to load token usage statistics.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [daysRange, showLogs]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleToggleLogs = async () => {
    const nextShow = !showLogs;
    setShowLogs(nextShow);
    if (nextShow && logs.length === 0) {
      try {
        const rawLogs = await getTokenUsageLogs(50, 0);
        setLogs(rawLogs || []);
      } catch (e) {
        console.error("Failed to load token logs:", e);
      }
    }
  };

  const handleClearHistory = async () => {
    try {
      setClearing(true);
      await clearTokenUsage();
      setShowClearConfirm(false);
      await fetchData(true);
    } catch (err) {
      console.error("Failed to clear token history:", err);
      setError(err.message || "Failed to clear token usage history.");
    } finally {
      setClearing(false);
    }
  };

  const handleExportData = () => {
    if (!data?.daily) return;
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rie-token-usage-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setCopiedExport(true);
    setTimeout(() => setCopiedExport(false), 2000);
  };

  // Build continuous daily chart data for the selected range
  const chartDays = useMemo(() => {
    if (!data?.daily) return [];
    const count = daysRange > 0 ? daysRange : 30;
    const map = new Map();
    for (const d of data.daily) {
      map.set(d.date, d);
    }

    const result = [];
    const today = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const existing = map.get(iso);
      if (existing) {
        result.push(existing);
      } else {
        result.push({
          date: iso,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          request_count: 0,
        });
      }
    }
    return result;
  }, [data, daysRange]);

  const maxDailyTokens = useMemo(() => {
    if (!chartDays.length) return 1;
    const maxVal = Math.max(...chartDays.map((d) => d.total_tokens || 0));
    return maxVal > 0 ? maxVal : 1;
  }, [chartDays]);

  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  if (loading && !data) {
    return (
      <div className={SL.tabStack}>
        <div className={SL.pageHeader}>
          <h3 className={SL.pageTitle}>Token Usage</h3>
          <p className={SL.pageDesc}>Loading token consumption statistics...</p>
        </div>
        <div className="flex flex-col items-center justify-center p-16 space-y-4 rounded-xl bg-neutral-900/30 border border-white/[0.06]">
          <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-emerald-500"></div>
          <span className="text-xs text-neutral-400">Fetching usage metrics...</span>
        </div>
      </div>
    );
  }

  const today = data?.today || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, request_count: 0 };
  const yesterday = data?.yesterday || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, request_count: 0 };
  const last7d = data?.last_7_days || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, request_count: 0, avg_daily_tokens: 0 };
  const allTime = data?.all_time || { total_tokens: 0, total_prompt: 0, total_completion: 0, total_requests: 0, active_days: 0 };
  const byProvider = data?.by_provider || [];
  const byModel = data?.by_model || [];

  return (
    <div className={SL.tabStack}>
      {/* Header with Title & Action Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-white/[0.06]">
        <div>
          <div className="flex items-center gap-2">
            <h3 className={SL.pageTitle}>Token Usage</h3>
            <span className="px-2 py-0.5 text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full">
              Live Tracker
            </span>
          </div>
          <p className={SL.pageDesc}>
            Track day-to-day token consumption, input/output ratio, and model breakdown.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Time range selector */}
          <div className="flex items-center rounded-lg bg-neutral-900/80 p-0.5 border border-white/[0.08] text-xs">
            {[
              { id: 7, label: "7D" },
              { id: 14, label: "14D" },
              { id: 30, label: "30D" },
              { id: 0, label: "All" },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setDaysRange(opt.id)}
                className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                  daysRange === opt.id
                    ? "bg-emerald-500/20 text-emerald-300 font-semibold shadow-sm"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Export button */}
          <button
            type="button"
            onClick={handleExportData}
            title="Export usage data as JSON"
            className="p-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white transition-all text-xs border border-white/[0.08] flex items-center gap-1.5"
          >
            {copiedExport ? <Check size={13} className="text-emerald-400" /> : <Download size={13} />}
            <span className="hidden sm:inline">{copiedExport ? "Saved" : "Export"}</span>
          </button>

          {/* Refresh button */}
          <button
            type="button"
            onClick={() => fetchData(true)}
            disabled={refreshing}
            title="Refresh token usage"
            className="p-2 rounded-lg bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white transition-all text-xs border border-white/[0.08] flex items-center gap-1.5"
          >
            <RefreshCw size={13} className={refreshing ? "animate-spin text-emerald-400" : ""} />
            <span className="hidden sm:inline">Refresh</span>
          </button>

          {/* Reset button */}
          <button
            type="button"
            onClick={() => setShowClearConfirm(true)}
            title="Clear all recorded token history"
            className="p-2 rounded-lg bg-neutral-900/60 hover:bg-red-500/10 text-neutral-500 hover:text-red-400 transition-all text-xs border border-white/[0.08] flex items-center gap-1"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2.5">
          <AlertCircle size={15} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Confirmation Modal for Clearing History */}
      {showClearConfirm && (
        <div className="p-4 bg-neutral-900/95 border border-red-500/30 rounded-xl space-y-3 animate-in fade-in zoom-in-95 duration-200">
          <div className="flex items-center gap-2 text-red-400 font-semibold text-xs uppercase tracking-wider">
            <AlertCircle size={15} />
            <span>Reset Token Usage Data?</span>
          </div>
          <p className="text-xs text-neutral-300">
            This will permanently remove all tracked token records from your local database. Historical messages in chat will remain intact.
          </p>
          <div className="flex items-center gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={() => setShowClearConfirm(false)}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleClearHistory}
              disabled={clearing}
              className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs text-white font-medium transition-colors flex items-center gap-1.5"
            >
              {clearing ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Confirm Reset
            </button>
          </div>
        </div>
      )}

      {/* Top Metric KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Today */}
        <div className="rounded-xl p-4 bg-neutral-900/40 border border-white/[0.06] flex flex-col justify-between hover:border-emerald-500/30 transition-colors group">
          <div className="flex items-center justify-between text-neutral-400 mb-2">
            <span className="text-[11px] font-medium tracking-wide uppercase">Today</span>
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]"></span>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-bold text-neutral-100 tracking-tight">
              {formatCompact(today.total_tokens)}
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-neutral-400">
              <span className="text-cyan-400">{formatCompact(today.prompt_tokens)} in</span>
              <span>·</span>
              <span className="text-emerald-400">{formatCompact(today.completion_tokens)} out</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-white/[0.04] flex items-center justify-between text-[10px] text-neutral-500">
            <span>{today.request_count || 0} requests</span>
            <span>{estimateCost(today.prompt_tokens, today.completion_tokens)}</span>
          </div>
        </div>

        {/* Yesterday */}
        <div className="rounded-xl p-4 bg-neutral-900/40 border border-white/[0.06] flex flex-col justify-between hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between text-neutral-400 mb-2">
            <span className="text-[11px] font-medium tracking-wide uppercase">Yesterday</span>
            <Clock size={13} className="text-neutral-500" />
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-bold text-neutral-200 tracking-tight">
              {formatCompact(yesterday.total_tokens)}
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-neutral-400">
              <span className="text-cyan-400/80">{formatCompact(yesterday.prompt_tokens)} in</span>
              <span>·</span>
              <span className="text-emerald-400/80">{formatCompact(yesterday.completion_tokens)} out</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-white/[0.04] flex items-center justify-between text-[10px] text-neutral-500">
            <span>{yesterday.request_count || 0} requests</span>
            <span>{estimateCost(yesterday.prompt_tokens, yesterday.completion_tokens)}</span>
          </div>
        </div>

        {/* 7-Day Total */}
        <div className="rounded-xl p-4 bg-neutral-900/40 border border-white/[0.06] flex flex-col justify-between hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between text-neutral-400 mb-2">
            <span className="text-[11px] font-medium tracking-wide uppercase">Last 7 Days</span>
            <TrendingUp size={13} className="text-neutral-500" />
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-bold text-neutral-200 tracking-tight">
              {formatCompact(last7d.total_tokens)}
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-neutral-400">
              <span>Avg {formatCompact(last7d.avg_daily_tokens)} / day</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-white/[0.04] flex items-center justify-between text-[10px] text-neutral-500">
            <span>{last7d.request_count || 0} requests</span>
            <span>{estimateCost(last7d.prompt_tokens, last7d.completion_tokens)}</span>
          </div>
        </div>

        {/* All Time Total */}
        <div className="rounded-xl p-4 bg-neutral-900/40 border border-white/[0.06] flex flex-col justify-between hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between text-neutral-400 mb-2">
            <span className="text-[11px] font-medium tracking-wide uppercase">All-Time Total</span>
            <Layers size={13} className="text-neutral-500" />
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-bold text-neutral-100 tracking-tight">
              {formatCompact(allTime.total_tokens)}
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[11px] text-neutral-400">
              <span>{allTime.active_days || 0} active days</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-white/[0.04] flex items-center justify-between text-[10px] text-neutral-500">
            <span>{formatNumber(allTime.total_requests)} total turns</span>
            <span>{estimateCost(allTime.total_prompt, allTime.total_completion)}</span>
          </div>
        </div>
      </div>

      {/* Day-to-Day Interactive Visualizer / Bar Chart */}
      <div className="rounded-xl p-5 bg-neutral-900/40 border border-white/[0.06] space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 size={16} className="text-emerald-400" />
            <h4 className="text-xs font-semibold text-neutral-200 tracking-wider uppercase">
              Day-to-Day Consumption ({daysRange > 0 ? `Last ${daysRange} Days` : "Recent"})
            </h4>
          </div>

          <div className="flex items-center gap-3 text-[11px]">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-cyan-500/80"></span>
              <span className="text-neutral-400">Input (Prompt)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500"></span>
              <span className="text-neutral-400">Output (Completion)</span>
            </div>
          </div>
        </div>

        {/* Hover detail tooltip bar */}
        <div className="h-6 flex items-center text-xs">
          {hoveredDay ? (
            <div className="flex items-center gap-3 text-neutral-200 animate-in fade-in duration-150">
              <span className="font-semibold text-white">{formatDateLong(hoveredDay.date)}</span>
              <span>·</span>
              <span className="font-bold text-emerald-400">{formatNumber(hoveredDay.total_tokens)} tokens</span>
              <span className="text-neutral-400">
                ({formatNumber(hoveredDay.prompt_tokens)} in / {formatNumber(hoveredDay.completion_tokens)} out)
              </span>
              <span>·</span>
              <span className="text-neutral-400">{hoveredDay.request_count} requests</span>
              <span>·</span>
              <span className="text-neutral-400">{estimateCost(hoveredDay.prompt_tokens, hoveredDay.completion_tokens)}</span>
            </div>
          ) : (
            <span className="text-[11px] text-neutral-500 italic">
              Hover over any daily bar to inspect detailed token metrics
            </span>
          )}
        </div>

        {/* Bar chart container */}
        <div className="pt-4 pb-2 border-t border-white/[0.04]">
          <div className="h-44 flex items-end gap-1 sm:gap-1.5 w-full">
            {chartDays.map((d) => {
              const total = d.total_tokens || 0;
              const prompt = d.prompt_tokens || 0;
              const completion = d.completion_tokens || 0;
              const heightPercent = total > 0 ? Math.max(4, Math.round((total / maxDailyTokens) * 100)) : 2;
              const promptRatio = total > 0 ? (prompt / total) * 100 : 50;
              const completionRatio = total > 0 ? (completion / total) * 100 : 50;
              const isToday = d.date === todayStr;

              return (
                <div
                  key={d.date}
                  onMouseEnter={() => setHoveredDay(d)}
                  onMouseLeave={() => setHoveredDay(null)}
                  className="flex-1 flex flex-col justify-end items-center h-full group relative cursor-pointer"
                >
                  {/* Top indicator for today */}
                  {isToday && (
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 mb-1 animate-pulse" />
                  )}

                  {/* Stacked bar */}
                  <div
                    style={{ height: `${heightPercent}%` }}
                    className={`w-full rounded-t-sm flex flex-col overflow-hidden transition-all duration-200 ${
                      total > 0
                        ? "group-hover:brightness-125 group-hover:scale-y-[1.03]"
                        : "bg-neutral-800/20"
                    } ${isToday ? "ring-1 ring-emerald-500/50" : ""}`}
                  >
                    {total > 0 && (
                      <>
                        <div
                          style={{ height: `${completionRatio}%` }}
                          className="w-full bg-emerald-500"
                          title={`Completion: ${formatNumber(completion)}`}
                        />
                        <div
                          style={{ height: `${promptRatio}%` }}
                          className="w-full bg-cyan-600/90"
                          title={`Prompt: ${formatNumber(prompt)}`}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* X Axis Labels */}
          <div className="flex items-center justify-between text-[10px] text-neutral-500 pt-2 font-mono">
            {chartDays.length > 0 && (
              <>
                <span>{formatDateLabel(chartDays[0].date)}</span>
                {chartDays.length > 10 && (
                  <span>{formatDateLabel(chartDays[Math.floor(chartDays.length / 2)].date)}</span>
                )}
                <span>{formatDateLabel(chartDays[chartDays.length - 1].date)} (Today)</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Provider & Model Distribution Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* By Provider */}
        <div className="rounded-xl p-5 bg-neutral-900/40 border border-white/[0.06] space-y-3">
          <div className="flex items-center gap-2">
            <Cpu size={15} className="text-cyan-400" />
            <h4 className="text-xs font-semibold text-neutral-200 tracking-wider uppercase">
              Provider Share
            </h4>
          </div>

          <div className="space-y-2.5 pt-1">
            {byProvider.length > 0 ? (
              byProvider.map((p) => (
                <div key={p.provider} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-neutral-200 capitalize">
                      {p.provider || "Unknown"}
                    </span>
                    <div className="flex items-center gap-2 text-neutral-400">
                      <span>{formatCompact(p.total_tokens)}</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-neutral-800 text-neutral-400">
                        {p.percentage || 0}%
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      style={{ width: `${Math.min(100, Math.max(2, p.percentage || 0))}%` }}
                      className="h-full bg-cyan-500 rounded-full"
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="text-xs text-neutral-500 italic py-4 text-center">
                No provider data recorded yet.
              </div>
            )}
          </div>
        </div>

        {/* By Model */}
        <div className="rounded-xl p-5 bg-neutral-900/40 border border-white/[0.06] space-y-3">
          <div className="flex items-center gap-2">
            <Zap size={15} className="text-emerald-400" />
            <h4 className="text-xs font-semibold text-neutral-200 tracking-wider uppercase">
              Top Models Used
            </h4>
          </div>

          <div className="space-y-2.5 pt-1">
            {byModel.length > 0 ? (
              byModel.map((m) => (
                <div key={`${m.provider}-${m.model}`} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 truncate max-w-[200px]">
                      <span className="font-mono text-neutral-200 truncate">{m.model}</span>
                      <span className="text-[9px] uppercase px-1 py-0.2 rounded bg-neutral-800/80 text-neutral-500">
                        {m.provider}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-neutral-400">
                      <span>{formatCompact(m.total_tokens)}</span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-neutral-800 text-neutral-400">
                        {m.percentage || 0}%
                      </span>
                    </div>
                  </div>
                  <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
                    <div
                      style={{ width: `${Math.min(100, Math.max(2, m.percentage || 0))}%` }}
                      className="h-full bg-emerald-500 rounded-full"
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="text-xs text-neutral-500 italic py-4 text-center">
                No model data recorded yet.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Day-to-Day Breakdown Table */}
      <div className="rounded-xl bg-neutral-900/40 border border-white/[0.06] overflow-hidden">
        <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Calendar size={15} className="text-neutral-400" />
            <h4 className="text-xs font-semibold text-neutral-200 tracking-wider uppercase">
              Daily Usage History
            </h4>
          </div>
          <span className="text-xs text-neutral-500">
            {data?.daily?.length || 0} active days
          </span>
        </div>

        <div className="overflow-x-auto max-h-[380px] custom-scrollbar">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-neutral-950/60 text-neutral-400 sticky top-0 border-b border-white/[0.06] font-medium text-[11px]">
              <tr>
                <th className="py-2.5 px-4">Date</th>
                <th className="py-2.5 px-4 text-right">Input Tokens</th>
                <th className="py-2.5 px-4 text-right">Output Tokens</th>
                <th className="py-2.5 px-4 text-right">Total Tokens</th>
                <th className="py-2.5 px-4 text-right">Requests</th>
                <th className="py-2.5 px-4 text-right">Est. Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04] text-neutral-300">
              {data?.daily && data.daily.length > 0 ? (
                data.daily.map((row) => {
                  const isToday = row.date === todayStr;
                  return (
                    <tr
                      key={row.date}
                      className={`hover:bg-white/[0.02] transition-colors ${
                        isToday ? "bg-emerald-500/[0.04]" : ""
                      }`}
                    >
                      <td className="py-2.5 px-4 flex items-center gap-2">
                        <span className="font-medium text-white">{formatDateLong(row.date)}</span>
                        {isToday && (
                          <span className="px-1.5 py-0.5 text-[9px] font-semibold bg-emerald-500/20 text-emerald-400 rounded">
                            TODAY
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-cyan-400/90">
                        {formatNumber(row.prompt_tokens)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-emerald-400/90">
                        {formatNumber(row.completion_tokens)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono font-semibold text-white">
                        {formatNumber(row.total_tokens)}
                      </td>
                      <td className="py-2.5 px-4 text-right text-neutral-400">
                        {row.request_count}
                      </td>
                      <td className="py-2.5 px-4 text-right text-neutral-400">
                        {estimateCost(row.prompt_tokens, row.completion_tokens)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-neutral-500 italic">
                    No token usage recorded for this timeframe.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Raw Event Logs Drawer / Section (Collapsible) */}
      <div className="rounded-xl bg-neutral-900/40 border border-white/[0.06] overflow-hidden">
        <button
          type="button"
          onClick={handleToggleLogs}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-white/[0.02] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Info size={15} className="text-neutral-400" />
            <h4 className="text-xs font-semibold text-neutral-200 tracking-wider uppercase">
              Recent Invocations Log (Raw Events)
            </h4>
          </div>
          <div className="flex items-center gap-2 text-neutral-400">
            <span className="text-xs">{showLogs ? "Hide" : "Inspect"}</span>
            {showLogs ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </div>
        </button>

        {showLogs && (
          <div className="border-t border-white/[0.06] p-4 space-y-3 animate-in fade-in duration-200">
            <div className="overflow-x-auto max-h-[300px] custom-scrollbar">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="bg-neutral-950/60 text-neutral-400 sticky top-0 font-medium text-[10px] uppercase">
                  <tr>
                    <th className="py-2 px-3">Time</th>
                    <th className="py-2 px-3">Provider</th>
                    <th className="py-2 px-3">Model</th>
                    <th className="py-2 px-3 text-right">In</th>
                    <th className="py-2 px-3 text-right">Out</th>
                    <th className="py-2 px-3 text-right">Total</th>
                    <th className="py-2 px-3">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04] text-neutral-300 font-mono text-[11px]">
                  {logs && logs.length > 0 ? (
                    logs.map((l) => (
                      <tr key={l.id} className="hover:bg-white/[0.02]">
                        <td className="py-2 px-3 text-neutral-400">
                          {l.timestamp ? l.timestamp.slice(11, 19) : "—"}
                        </td>
                        <td className="py-2 px-3 text-cyan-400">{l.provider || "—"}</td>
                        <td className="py-2 px-3 text-neutral-200">{l.model || "—"}</td>
                        <td className="py-2 px-3 text-right text-cyan-400/80">
                          {formatNumber(l.prompt_tokens)}
                        </td>
                        <td className="py-2 px-3 text-right text-emerald-400/80">
                          {formatNumber(l.completion_tokens)}
                        </td>
                        <td className="py-2 px-3 text-right font-semibold text-white">
                          {formatNumber(l.total_tokens)}
                        </td>
                        <td className="py-2 px-3 text-neutral-500 text-[10px] uppercase">
                          {l.source || "chat"}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="py-4 text-center text-neutral-500 italic">
                        No recent log records found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

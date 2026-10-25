import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const DEFAULT_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#6366f1', // indigo
];

export function SvgBarChart({ data = [], horizontal = false, height = 220 }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);

  const items = useMemo(() => {
    if (!Array.isArray(data)) return [];
    return data.map((d, i) => {
      const label = String(d?.label ?? d?.name ?? d?.title ?? d?.category ?? `Item ${i + 1}`);
      const val = Number(d?.value ?? d?.count ?? d?.val ?? d?.amount ?? 0);
      const color = d?.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      return {
        label,
        value: Number.isNaN(val) ? 0 : val,
        color,
        tooltip: d?.tooltip || d?.description,
      };
    });
  }, [data]);

  const { maxValue, total } = useMemo(() => {
    let max = 0;
    let tot = 0;
    items.forEach((item) => {
      if (item.value > max) max = item.value;
      tot += item.value;
    });
    return { maxValue: max || 1, total: tot || 1 };
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center text-xs text-neutral-500 italic">
        No chart data available
      </div>
    );
  }

  if (horizontal) {
    return (
      <div className="flex flex-col gap-2.5 py-2">
        {items.map((item, idx) => {
          const pct = Math.max(0, Math.min(100, (item.value / maxValue) * 100));
          const isHovered = hoveredIdx === idx;

          return (
            <div
              key={idx}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="group flex flex-col gap-1 transition-all"
            >
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-neutral-300 truncate max-w-[65%] group-hover:text-white transition-colors">
                  {item.label}
                </span>
                <span className="font-mono text-xs font-semibold text-neutral-200">
                  {typeof item.value === 'number' ? item.value.toLocaleString() : item.value}
                </span>
              </div>
              <div className="relative h-4 w-full overflow-hidden rounded-md bg-neutral-800/80 border border-neutral-700/40">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.5, ease: 'easeOut', delay: idx * 0.04 }}
                  className="h-full rounded-sm"
                  style={{
                    backgroundColor: item.color,
                    boxShadow: isHovered ? `0 0 12px ${item.color}80` : 'none',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Vertical Bar Chart
  const svgHeight = height;
  const paddingBottom = 28;
  const paddingTop = 20;
  const chartHeight = svgHeight - paddingBottom - paddingTop;
  const barWidthPercent = Math.max(12, Math.min(48, 80 / items.length));

  return (
    <div className="relative w-full">
      <div className="relative flex items-end justify-between gap-1 px-2 pt-2" style={{ height: `${svgHeight}px` }}>
        {/* Background Grid Lines */}
        <div className="absolute inset-x-2 top-4 bottom-7 flex flex-col justify-between pointer-events-none opacity-20">
          <div className="w-full border-b border-neutral-600 border-dashed" />
          <div className="w-full border-b border-neutral-600 border-dashed" />
          <div className="w-full border-b border-neutral-600 border-dashed" />
        </div>

        {items.map((item, idx) => {
          const heightPct = Math.max(4, Math.min(100, (item.value / maxValue) * 100));
          const barHeightPx = (heightPct / 100) * chartHeight;
          const isHovered = hoveredIdx === idx;

          return (
            <div
              key={idx}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className="relative flex flex-1 flex-col items-center justify-end h-full group cursor-pointer z-10"
            >
              {/* Tooltip on hover */}
              <AnimatePresence>
                {isHovered && (
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 4, scale: 0.95 }}
                    transition={{ duration: 0.15 }}
                    className="absolute -top-10 z-30 whitespace-nowrap rounded-lg bg-neutral-900 border border-neutral-700 px-2.5 py-1 text-[11px] font-medium text-white shadow-xl backdrop-blur-md pointer-events-none flex items-center gap-1.5"
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="font-semibold">{item.label}:</span>
                    <span className="font-mono text-neutral-300">
                      {item.value.toLocaleString()} ({Math.round((item.value / total) * 100)}%)
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Bar Value label on top (subtle) */}
              <span
                className={`mb-1 text-[10px] font-mono transition-opacity ${
                  isHovered ? 'text-white font-bold opacity-100' : 'text-neutral-400 opacity-70 group-hover:opacity-100'
                }`}
              >
                {item.value > 9999 ? `${(item.value / 1000).toFixed(1)}k` : item.value}
              </span>

              {/* Animated Bar */}
              <div
                className="w-full flex justify-center items-end"
                style={{ height: `${chartHeight}px` }}
              >
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${barHeightPx}px` }}
                  transition={{ duration: 0.5, ease: 'easeOut', delay: idx * 0.05 }}
                  className="rounded-t-md transition-all duration-150"
                  style={{
                    width: `${barWidthPercent}%`,
                    maxWidth: '42px',
                    minWidth: '12px',
                    backgroundColor: item.color,
                    boxShadow: isHovered
                      ? `0 0 16px ${item.color}90, inset 0 1px 0 rgba(255,255,255,0.4)`
                      : 'inset 0 1px 0 rgba(255,255,255,0.2)',
                    filter: isHovered ? 'brightness(1.15)' : 'none',
                  }}
                />
              </div>

              {/* X Axis Label */}
              <div className="mt-2 h-5 w-full text-center">
                <span
                  title={item.label}
                  className={`block truncate text-[11px] font-medium transition-colors ${
                    isHovered ? 'text-white font-semibold' : 'text-neutral-400 group-hover:text-neutral-200'
                  }`}
                >
                  {item.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

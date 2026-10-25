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

export function SvgPieChart({ data = [], isDonut = true, size = 200 }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);

  const items = useMemo(() => {
    if (!Array.isArray(data)) return [];
    return data.map((d, i) => {
      const label = String(d?.label ?? d?.name ?? d?.title ?? `Slice ${i + 1}`);
      const val = Math.max(0, Number(d?.value ?? d?.count ?? d?.val ?? d?.amount ?? 0));
      const color = d?.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
      return {
        label,
        value: Number.isNaN(val) ? 0 : val,
        color,
      };
    });
  }, [data]);

  const total = useMemo(() => {
    return items.reduce((acc, curr) => acc + curr.value, 0) || 1;
  }, [items]);

  // Compute angles and SVG path data
  const slices = useMemo(() => {
    const center = size / 2;
    const outerRadius = size * 0.42;
    const innerRadius = isDonut ? size * 0.25 : 0;

    let currentAngle = -Math.PI / 2; // start from 12 o'clock

    return items.map((item, idx) => {
      const sliceAngle = (item.value / total) * 2 * Math.PI;
      const startAngle = currentAngle;
      const endAngle = currentAngle + sliceAngle;
      currentAngle = endAngle;

      const pct = Math.round((item.value / total) * 100);

      // Arc coordinates
      const x1 = center + outerRadius * Math.cos(startAngle);
      const y1 = center + outerRadius * Math.sin(startAngle);
      const x2 = center + outerRadius * Math.cos(endAngle);
      const y2 = center + outerRadius * Math.sin(endAngle);

      const largeArcFlag = sliceAngle > Math.PI ? 1 : 0;

      let pathData = '';
      if (isDonut) {
        const x3 = center + innerRadius * Math.cos(endAngle);
        const y3 = center + innerRadius * Math.sin(endAngle);
        const x4 = center + innerRadius * Math.cos(startAngle);
        const y4 = center + innerRadius * Math.sin(startAngle);

        pathData = [
          `M ${x1} ${y1}`,
          `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
          `L ${x3} ${y3}`,
          `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 0 ${x4} ${y4}`,
          'Z',
        ].join(' ');
      } else {
        pathData = [
          `M ${center} ${center}`,
          `L ${x1} ${y1}`,
          `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 1 ${x2} ${y2}`,
          'Z',
        ].join(' ');
      }

      // Mid angle for hover explode offset
      const midAngle = startAngle + sliceAngle / 2;
      const explodeOffset = 4;
      const explodeX = Math.cos(midAngle) * explodeOffset;
      const explodeY = Math.sin(midAngle) * explodeOffset;

      return {
        ...item,
        pathData,
        pct,
        explodeX,
        explodeY,
        idx,
      };
    });
  }, [items, total, size, isDonut]);

  if (items.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center text-xs text-neutral-500 italic">
        No chart data available
      </div>
    );
  }

  const activeSlice = hoveredIdx !== null ? slices[hoveredIdx] : null;

  return (
    <div className="flex flex-col sm:flex-row items-center justify-center gap-6 py-2">
      {/* SVG Container */}
      <div className="relative shrink-0" style={{ width: `${size}px`, height: `${size}px` }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full overflow-visible">
          {slices.map((slice) => {
            const isHovered = hoveredIdx === slice.idx;

            return (
              <motion.path
                key={slice.idx}
                d={slice.pathData}
                fill={slice.color}
                stroke="#0f172a"
                strokeWidth="2"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  x: isHovered ? slice.explodeX : 0,
                  y: isHovered ? slice.explodeY : 0,
                }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                onMouseEnter={() => setHoveredIdx(slice.idx)}
                onMouseLeave={() => setHoveredIdx(null)}
                className="cursor-pointer transition-all duration-150"
                style={{
                  filter: isHovered
                    ? `brightness(1.15) drop-shadow(0 0 8px ${slice.color}90)`
                    : 'none',
                }}
              />
            );
          })}
        </svg>

        {/* Center Donut Label */}
        {isDonut && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none">
            {activeSlice ? (
              <>
                <span className="text-sm font-bold text-white font-mono leading-none">
                  {activeSlice.pct}%
                </span>
                <span className="text-[10px] text-neutral-400 truncate max-w-[70px] mt-0.5">
                  {activeSlice.label}
                </span>
              </>
            ) : (
              <>
                <span className="text-xs font-bold text-neutral-300 font-mono leading-none">
                  {typeof total === 'number' && total > 9999 ? `${(total / 1000).toFixed(1)}k` : total.toLocaleString()}
                </span>
                <span className="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold mt-0.5">
                  Total
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Legend chips */}
      <div className="flex flex-col gap-1.5 min-w-[120px] max-w-[200px]">
        {slices.map((slice) => {
          const isHovered = hoveredIdx === slice.idx;

          return (
            <button
              key={slice.idx}
              type="button"
              onMouseEnter={() => setHoveredIdx(slice.idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              className={`flex items-center justify-between gap-2 px-2 py-1 rounded-md text-left transition-all ${
                isHovered
                  ? 'bg-neutral-800/80 text-white font-medium'
                  : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/40'
              }`}
            >
              <div className="flex items-center gap-2 truncate">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: slice.color }}
                />
                <span className="text-xs truncate">{slice.label}</span>
              </div>
              <span className="text-xs font-mono font-semibold shrink-0 text-neutral-300">
                {slice.pct}%
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

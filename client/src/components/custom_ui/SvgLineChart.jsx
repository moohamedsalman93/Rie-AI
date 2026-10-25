import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const DEFAULT_STROKE = '#3b82f6';

export function SvgLineChart({ data = [], height = 220, isArea = true, strokeColor = DEFAULT_STROKE }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);

  const items = useMemo(() => {
    if (!Array.isArray(data)) return [];
    return data.map((d, i) => {
      const label = String(d?.label ?? d?.name ?? d?.x ?? `Point ${i + 1}`);
      const val = Number(d?.value ?? d?.count ?? d?.y ?? d?.amount ?? 0);
      return {
        label,
        value: Number.isNaN(val) ? 0 : val,
        color: d?.color || strokeColor,
      };
    });
  }, [data, strokeColor]);

  const { minVal, maxVal, range } = useMemo(() => {
    if (items.length === 0) return { minVal: 0, maxVal: 1, range: 1 };
    let min = items[0].value;
    let max = items[0].value;
    items.forEach((item) => {
      if (item.value < min) min = item.value;
      if (item.value > max) max = item.value;
    });
    // Add small headroom
    const pad = max === min ? (max || 1) * 0.1 : (max - min) * 0.1;
    const effectiveMin = Math.max(0, min - pad);
    const effectiveMax = max + pad;
    return {
      minVal: effectiveMin,
      maxVal: effectiveMax,
      range: effectiveMax - effectiveMin || 1,
    };
  }, [items]);

  const width = 500;
  const paddingX = 40;
  const paddingTop = 25;
  const paddingBottom = 35;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingTop - paddingBottom;

  const points = useMemo(() => {
    if (items.length === 0) return [];
    if (items.length === 1) {
      return [{ x: width / 2, y: height / 2, item: items[0], index: 0 }];
    }
    const step = plotWidth / (items.length - 1);
    return items.map((item, i) => {
      const x = paddingX + i * step;
      const normY = (item.value - minVal) / range;
      const y = paddingTop + plotHeight - normY * plotHeight;
      return { x, y, item, index: i };
    });
  }, [items, minVal, range, plotWidth, plotHeight, width, height]);

  // Construct smooth bezier curve path
  const { linePath, areaPath } = useMemo(() => {
    if (points.length === 0) return { linePath: '', areaPath: '' };
    if (points.length === 1) {
      return {
        linePath: `M ${points[0].x - 10} ${points[0].y} L ${points[0].x + 10} ${points[0].y}`,
        areaPath: '',
      };
    }

    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = i > 0 ? points[i - 1] : points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = i < points.length - 2 ? points[i + 2] : p2;

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }

    const last = points[points.length - 1];
    const first = points[0];
    const bottomY = paddingTop + plotHeight;
    const a = `${d} L ${last.x} ${bottomY} L ${first.x} ${bottomY} Z`;

    return { linePath: d, areaPath: a };
  }, [points, plotHeight]);

  if (items.length === 0) {
    return (
      <div className="flex h-36 items-center justify-center text-xs text-neutral-500 italic">
        No chart data available
      </div>
    );
  }

  const gradientId = `line-gradient-${Math.random().toString(36).substr(2, 6)}`;
  const activePoint = hoveredIdx !== null ? points[hoveredIdx] : null;

  return (
    <div className="relative w-full overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full overflow-visible"
        style={{ height: `${height}px` }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.4" />
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {[0, 0.5, 1].map((ratio, i) => {
          const y = paddingTop + plotHeight * ratio;
          return (
            <line
              key={i}
              x1={paddingX}
              y1={y}
              x2={width - paddingX}
              y2={y}
              stroke="#334155"
              strokeDasharray="4 4"
              strokeOpacity="0.4"
            />
          );
        })}

        {/* Area fill */}
        {isArea && areaPath && (
          <motion.path
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
            d={areaPath}
            fill={`url(#${gradientId})`}
          />
        )}

        {/* Line stroke */}
        {linePath && (
          <motion.path
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            d={linePath}
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Vertical crosshair line for hovered point */}
        {activePoint && (
          <line
            x1={activePoint.x}
            y1={paddingTop}
            x2={activePoint.x}
            y2={paddingTop + plotHeight}
            stroke="#94a3b8"
            strokeDasharray="2 2"
            strokeWidth="1.5"
            strokeOpacity="0.8"
          />
        )}

        {/* Data points */}
        {points.map((pt, i) => {
          const isHovered = hoveredIdx === i;
          return (
            <g key={i}>
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isHovered ? 6 : 4}
                fill="#0f172a"
                stroke={strokeColor}
                strokeWidth={isHovered ? 3 : 2}
                className="transition-all duration-150 cursor-pointer"
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
              {/* Invisible larger hover target */}
              <circle
                cx={pt.x}
                cy={pt.y}
                r={16}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
            </g>
          );
        })}

        {/* X axis labels */}
        {points.map((pt, i) => {
          // Avoid collision if there are too many labels
          const skipInterval = items.length > 8 ? Math.ceil(items.length / 6) : 1;
          const shouldShow = i % skipInterval === 0 || i === items.length - 1;
          if (!shouldShow) return null;

          return (
            <text
              key={i}
              x={pt.x}
              y={height - 10}
              textAnchor="middle"
              className="text-[10px] font-mono fill-neutral-400 select-none"
            >
              {pt.item.label}
            </text>
          );
        })}
      </svg>

      {/* Floating Tooltip */}
      <AnimatePresence>
        {activePoint && (
          <motion.div
            initial={{ opacity: 0, y: 4, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute -top-2 left-1/2 -translate-x-1/2 z-20 whitespace-nowrap rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-1 text-xs font-medium text-white shadow-xl backdrop-blur-md flex items-center gap-2 pointer-events-none"
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: strokeColor }} />
            <span className="text-neutral-300">{activePoint.item.label}:</span>
            <span className="font-mono font-bold text-white">
              {activePoint.item.value.toLocaleString()}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

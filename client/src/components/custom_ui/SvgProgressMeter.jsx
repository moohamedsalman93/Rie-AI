import React from 'react';
import { motion } from 'framer-motion';

export function SvgProgressMeter({
  value = 0,
  max = 100,
  label = '',
  unit = '%',
  status = 'default',
  color = null,
  circular = false,
  size = 120,
}) {
  const numVal = Number(value) || 0;
  const numMax = Number(max) || 100;
  const pct = Math.max(0, Math.min(100, Math.round((numVal / numMax) * 100)));

  const statusColor = color || (
    status === 'success' || pct >= 90
      ? '#10b981' // emerald
      : status === 'warning' || pct >= 70
      ? '#f59e0b' // amber
      : status === 'error'
      ? '#ef4444' // red
      : '#3b82f6' // blue
  );

  if (circular) {
    const strokeWidth = 10;
    const radius = (size - strokeWidth * 2) / 2;
    const center = size / 2;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (pct / 100) * circumference;

    return (
      <div className="flex flex-col items-center justify-center p-2">
        <div className="relative" style={{ width: `${size}px`, height: `${size}px` }}>
          <svg className="w-full h-full -rotate-90 transform" viewBox={`0 0 ${size} ${size}`}>
            {/* Background track */}
            <circle
              cx={center}
              cy={center}
              r={radius}
              stroke="#262626"
              strokeWidth={strokeWidth}
              fill="transparent"
            />
            {/* Animated progress stroke */}
            <motion.circle
              cx={center}
              cy={center}
              r={radius}
              stroke={statusColor}
              strokeWidth={strokeWidth}
              fill="transparent"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 6px ${statusColor}70)` }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-xl font-bold text-white">
              {pct}
              <span className="text-xs text-neutral-400 ml-0.5">{unit}</span>
            </span>
            {label && (
              <span className="text-[10px] text-neutral-400 font-medium truncate max-w-[80px]">
                {label}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Linear progress bar
  return (
    <div className="flex flex-col gap-1.5 py-1 w-full">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-neutral-300">{label || 'Progress'}</span>
        <span className="font-mono text-neutral-200 font-semibold">
          {numVal} / {numMax} {unit && `(${pct}${unit})`}
        </span>
      </div>
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-neutral-800 border border-neutral-700/50">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="h-full rounded-full"
          style={{
            backgroundColor: statusColor,
            boxShadow: `0 0 10px ${statusColor}70`,
          }}
        />
      </div>
    </div>
  );
}

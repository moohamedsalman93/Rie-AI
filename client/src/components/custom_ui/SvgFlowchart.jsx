import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowDown, ArrowRight, Check, CheckCircle2, Clock, AlertCircle, Play, ChevronRight } from 'lucide-react';
import { CustomUiIcon } from './CustomUiIcon';

export function SvgFlowchart({ data = {}, onSend, onAction, disabled = false }) {
  const [selectedNode, setSelectedNode] = useState(null);

  const title = data?.title || data?.header || '';
  const subtitle = data?.subtitle || data?.description || '';

  // Can receive nodes, stages, phases, pipeline, steps, or workflow items
  const rawSteps =
    data?.steps ||
    data?.stages ||
    data?.phases ||
    data?.pipeline ||
    data?.nodes ||
    data?.workflow ||
    data?.tasks ||
    data?.items ||
    [];

  const steps = Array.isArray(rawSteps)
    ? rawSteps
    : typeof rawSteps === 'object' && rawSteps !== null
    ? Object.values(rawSteps)
    : [];

  const orientation = String(data?.orientation || data?.direction || 'vertical').toLowerCase();
  const isHorizontal = orientation === 'horizontal' || orientation === 'lr';

  if (steps.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-neutral-500 italic">
        No flowchart nodes defined
      </div>
    );
  }

  const hasExplicitStatus = steps.some(
    (s) => s && typeof s === 'object' && (s.status || s.state || s.stageStatus)
  );

  const handleNodeClick = (node, idx) => {
    if (disabled) return;
    setSelectedNode(idx);

    const actionText = node?.action || node?.prompt || node?.value;
    if (actionText) {
      if (onAction) {
        onAction({ type: 'message', text: actionText });
      } else if (onSend) {
        onSend(actionText);
      }
    }
  };

  const getInferredIcon = (label, explicitIcon) => {
    if (explicitIcon) return explicitIcon;
    const lower = String(label || '').toLowerCase();
    if (lower.includes('test') || lower.includes('check') || lower.includes('verify') || lower.includes('lint')) {
      return 'CheckSquare';
    }
    if (lower.includes('build') || lower.includes('compile') || lower.includes('package') || lower.includes('bundle')) {
      return 'Box';
    }
    if (lower.includes('deploy') || lower.includes('release') || lower.includes('ship') || lower.includes('publish')) {
      return 'Rocket';
    }
    if (lower.includes('start') || lower.includes('init') || lower.includes('trigger')) {
      return 'Play';
    }
    if (lower.includes('monitor') || lower.includes('audit') || lower.includes('health') || lower.includes('metric')) {
      return 'Activity';
    }
    if (lower.includes('gate') || lower.includes('approve') || lower.includes('security') || lower.includes('scan')) {
      return 'ShieldCheck';
    }
    return null;
  };

  return (
    <div className="w-full flex flex-col gap-3">
      {/* Optional Header */}
      {(title || subtitle) && (
        <div className="flex flex-col gap-0.5 border-b border-neutral-800/80 pb-2.5">
          {title && (
            <h4 className="text-xs sm:text-sm font-semibold text-neutral-100 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              {title}
            </h4>
          )}
          {subtitle && (
            <p className="text-[11px] text-neutral-400">{subtitle}</p>
          )}
        </div>
      )}

      {/* Steps List */}
      <div
        className={
          isHorizontal
            ? 'flex flex-row items-center gap-2 overflow-x-auto py-2'
            : 'flex flex-col gap-2 py-1'
        }
      >
        {steps.map((rawNode, idx) => {
          const node = typeof rawNode === 'string' ? { label: rawNode } : (rawNode || {});
          const status = String(
            node?.status ||
            node?.state ||
            node?.stageStatus ||
            (hasExplicitStatus ? (idx === 0 ? 'completed' : 'pending') : 'ready')
          ).toLowerCase();

          const isSelected = selectedNode === idx;
          const isLast = idx === steps.length - 1;

          let statusBg = 'bg-neutral-800/60 border-neutral-700/60 text-neutral-300';
          let iconBg = 'bg-neutral-800 text-neutral-400 border-neutral-700';

          if (status === 'completed' || status === 'done' || status === 'success') {
            statusBg = 'bg-emerald-950/20 border-emerald-500/30 text-emerald-100';
            iconBg = 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40';
          } else if (status === 'active' || status === 'running' || status === 'in-progress') {
            statusBg = 'bg-blue-950/30 border-blue-500/50 text-blue-100 shadow-md shadow-blue-500/10';
            iconBg = 'bg-blue-500/20 text-blue-400 border-blue-500/40 ring-2 ring-blue-500/20 animate-pulse';
          } else if (status === 'failed' || status === 'error') {
            statusBg = 'bg-red-950/20 border-red-500/30 text-red-100';
            iconBg = 'bg-red-500/20 text-red-400 border-red-500/40';
          } else if (status === 'ready' || status === 'default') {
            statusBg = 'bg-neutral-900/80 border-neutral-700/70 text-neutral-200';
            iconBg = 'bg-blue-500/10 text-blue-400 border-blue-500/25';
          }

          const nodeLabel =
            node?.label ||
            node?.name ||
            node?.title ||
            node?.stage ||
            node?.phase ||
            node?.step ||
            `Step ${idx + 1}`;

          // Extract gates, tasks, or description
          const rawGates = node?.gates || node?.gate || node?.tasks || node?.criteria;
          const gatesList = Array.isArray(rawGates)
            ? rawGates.map((g) => (typeof g === 'object' ? g?.name || g?.label || JSON.stringify(g) : String(g)))
            : typeof rawGates === 'string' && rawGates
            ? [rawGates]
            : [];

          const nodeDesc =
            node?.description ||
            node?.desc ||
            node?.subtext ||
            node?.details ||
            (gatesList.length === 1 ? gatesList[0] : '');

          const condition = node?.condition || node?.edgeLabel || (isHorizontal ? null : node?.gateLabel);
          const iconName = getInferredIcon(nodeLabel, node?.icon);

          return (
            <React.Fragment key={idx}>
              <motion.div
                whileHover={{ scale: disabled ? 1 : 1.01 }}
                onClick={() => handleNodeClick(node, idx)}
                className={`relative flex items-center justify-between gap-3 p-3 rounded-xl border transition-all ${statusBg} ${
                  node?.action ? 'cursor-pointer hover:border-blue-500/60' : ''
                } ${isSelected ? 'ring-1 ring-blue-500/60' : ''}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* Step number / icon */}
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-bold shrink-0 ${iconBg}`}>
                    {status === 'completed' ? (
                      <CheckCircle2 size={16} />
                    ) : status === 'failed' ? (
                      <AlertCircle size={16} />
                    ) : iconName ? (
                      <CustomUiIcon name={iconName} size={15} />
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>

                  {/* Node text */}
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-semibold truncate leading-tight">
                      {nodeLabel}
                    </span>
                    {nodeDesc && (
                      <span className="text-[11px] text-neutral-400 truncate leading-snug mt-0.5">
                        {nodeDesc}
                      </span>
                    )}
                    {gatesList.length > 1 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {gatesList.map((gate, gIdx) => (
                          <span
                            key={gIdx}
                            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-800/80 border border-neutral-700/60 text-neutral-300"
                          >
                            {gate}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Status chip / Action prompt indicator */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {node?.badge && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-neutral-900 border border-neutral-700/60 text-neutral-300">
                      {node.badge}
                    </span>
                  )}
                  {node?.action && (
                    <div className="p-1 rounded-md text-neutral-400 hover:text-white transition-colors" title={node.action}>
                      <ChevronRight size={14} />
                    </div>
                  )}
                </div>
              </motion.div>

              {/* Connecting Arrow */}
              {!isLast && (
                <div className={isHorizontal ? 'flex items-center px-1' : 'flex flex-col items-center my-0.5'}>
                  {isHorizontal ? (
                    <ArrowRight size={14} className="text-neutral-500" />
                  ) : (
                    <div className="flex flex-col items-center">
                      <div className="h-2.5 w-0.5 bg-neutral-700" />
                      {condition && (
                        <span className="my-0.5 px-2 py-0.5 rounded text-[9px] font-mono font-semibold bg-neutral-800 text-blue-400 border border-neutral-700">
                          {condition}
                        </span>
                      )}
                      <ArrowDown size={13} className="text-neutral-500" />
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

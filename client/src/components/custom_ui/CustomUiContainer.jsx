import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles,
  BarChart3,
  Layers,
  Code2,
  Copy,
  Check,
  Eye,
  CheckCircle2,
} from 'lucide-react';
import { CustomChart } from './CustomChart';
import { CustomCard } from './CustomCard';
import { CustomButtons } from './CustomButtons';
import { SvgFlowchart } from './SvgFlowchart';
import { MermaidDiagram } from './MermaidDiagram';

/**
 * Lenient JSON parser with basic error recovery for streaming / LLM quirks
 */
function tryParseJson(input) {
  if (!input) return null;
  if (typeof input === 'object') return input;

  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // Direct parse attempt
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Attempt lenient cleanup: remove trailing commas before closing braces/brackets
    try {
      const cleaned = trimmed
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/```(?:json|chart|card|ui|buttons)?/gi, '')
        .replace(/```/g, '')
        .trim();
      return JSON.parse(cleaned);
    } catch (e2) {
      return null;
    }
  }
}

export const CustomUiContainer = React.memo(function CustomUiContainer({
  code,
  data,
  type = 'ui',
  isStreaming = false,
  onSend,
  onAction,
  className = '',
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  // Parse payload from either data prop or code string
  const parsedData = useMemo(() => {
    if (data && typeof data === 'object') return data;
    return tryParseJson(code);
  }, [data, code]);

  const rawCodeString = useMemo(() => {
    if (typeof code === 'string' && code) return code;
    if (parsedData) return JSON.stringify(parsedData, null, 2);
    return '';
  }, [code, parsedData]);

  const handleCopyRaw = async () => {
    try {
      await navigator.clipboard.writeText(rawCodeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy raw UI JSON:', err);
    }
  };

  // Extract potential mermaid diagram code from multiple possible properties (text, diagram, graph, code, etc.)
  const mermaidCode = useMemo(() => {
    if (!parsedData) return null;
    if (typeof parsedData === 'string') {
      const trimmed = parsedData.trim();
      if (
        /^(?:graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|gitGraph)/m.test(trimmed) ||
        (trimmed.includes('-->') && (trimmed.includes('[') || trimmed.includes('{') || trimmed.includes('(')))
      ) {
        return trimmed;
      }
      return null;
    }
    if (typeof parsedData !== 'object') return null;

    const candidates = [
      parsedData.mermaid,
      parsedData.diagram,
      parsedData.graph,
      parsedData.code,
      parsedData.text,
      parsedData.content,
      parsedData.source,
      parsedData.data,
    ];
    for (const c of candidates) {
      if (typeof c === 'string') {
        const trimmed = c.trim();
        if (
          /^(?:graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|gitGraph)/m.test(trimmed) ||
          (trimmed.includes('-->') && (trimmed.includes('[') || trimmed.includes('{') || trimmed.includes('(')))
        ) {
          return trimmed;
        }
      }
    }
    if (parsedData.data && typeof parsedData.data === 'object') {
      const sub = [parsedData.data.mermaid, parsedData.data.diagram, parsedData.data.graph, parsedData.data.code, parsedData.data.text];
      for (const c of sub) {
        if (typeof c === 'string') {
          const trimmed = c.trim();
          if (
            /^(?:graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|gitGraph)/m.test(trimmed) ||
            (trimmed.includes('-->') && (trimmed.includes('[') || trimmed.includes('{') || trimmed.includes('(')))
          ) {
            return trimmed;
          }
        }
      }
    }
    return null;
  }, [parsedData]);

  // Determine normalized component type
  const resolvedType = useMemo(() => {
    const rawType = (
      parsedData?.type ||
      parsedData?.component ||
      type ||
      'ui'
    ).toLowerCase();

    // 1. Flowchart, Pipeline, Stages, or Workflow
    // CRITICAL: Must be evaluated BEFORE chart check because 'flowchart'.includes('chart') === true
    if (
      rawType.includes('flowchart') ||
      rawType.includes('mermaid') ||
      rawType === 'workflow' ||
      rawType === 'pipeline' ||
      rawType === 'stages' ||
      rawType === 'process' ||
      Boolean(mermaidCode) ||
      Boolean(parsedData?.steps) ||
      Boolean(parsedData?.stages) ||
      Boolean(parsedData?.phases) ||
      Boolean(parsedData?.pipeline) ||
      Boolean(parsedData?.nodes) ||
      Boolean(parsedData?.mermaid)
    ) {
      return 'flowchart';
    }

    // 2. Buttons / Actions
    if (
      rawType.includes('button') ||
      rawType === 'actions' ||
      (Array.isArray(parsedData) && parsedData[0]?.action)
    ) {
      return 'buttons';
    }

    // 3. Charts (Bar, Line, Area, Pie, Donut, Gauge, Progress)
    if (
      (rawType.includes('chart') && !rawType.includes('flowchart')) ||
      rawType === 'bar' ||
      rawType === 'line' ||
      rawType === 'area' ||
      rawType === 'pie' ||
      rawType === 'donut' ||
      rawType === 'gauge' ||
      rawType === 'progress' ||
      parsedData?.chartType ||
      (Array.isArray(parsedData?.data) && parsedData?.data[0]?.value !== undefined)
    ) {
      return 'chart';
    }

    // 4. Cards / Metrics
    if (rawType.includes('card') || parsedData?.cards || parsedData?.metrics || parsedData?.title) {
      return 'card';
    }

    return 'ui';
  }, [parsedData, type]);

  // Streaming skeleton state
  if (isStreaming && !parsedData) {
    return (
      <div className={`my-3 w-full rounded-2xl border border-neutral-700/60 bg-neutral-900/60 p-4 shadow-xl backdrop-blur-md animate-pulse ${className}`}>
        <div className="flex items-center gap-2.5 pb-3 border-b border-neutral-800/80">
          <div className="h-6 w-6 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center">
            <Sparkles size={13} className="animate-spin text-blue-400" />
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <div className="h-3 w-28 bg-neutral-700/60 rounded" />
            <div className="h-2 w-44 bg-neutral-800/80 rounded" />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <div className="h-24 w-full bg-neutral-800/40 rounded-xl" />
          <div className="flex gap-2">
            <div className="h-7 w-20 bg-neutral-800/60 rounded-lg" />
            <div className="h-7 w-24 bg-neutral-800/60 rounded-lg" />
          </div>
        </div>
      </div>
    );
  }

  // If streaming finished and parsing completely failed, fall back to code view
  if (!parsedData) {
    return (
      <div className="my-2 rounded-xl border border-neutral-700/60 bg-neutral-950 p-3 font-mono text-xs text-neutral-300">
        <div className="text-[10px] text-amber-400 uppercase font-semibold mb-1">
          Custom UI (Raw Data)
        </div>
        <pre className="overflow-x-auto whitespace-pre">{code}</pre>
      </div>
    );
  }

  const titleBadge =
    parsedData?.titleBadge ||
    parsedData?.badge ||
    (resolvedType === 'chart'
      ? 'Interactive Chart'
      : resolvedType === 'card'
      ? 'Interactive Card'
      : resolvedType === 'buttons'
      ? 'Quick Actions'
      : resolvedType === 'flowchart'
      ? 'Interactive Flowchart'
      : 'Interactive Component');

  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`my-3 w-full rounded-2xl border border-neutral-700/70 bg-gradient-to-b from-neutral-900/95 to-neutral-950/95 p-4 shadow-2xl backdrop-blur-md ${className}`}
    >
      {/* Top action toolbar */}
      <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-neutral-800/80">
        <div className="flex items-center gap-1.5">
          <span className="flex h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-[10px] font-semibold tracking-wider text-neutral-400 uppercase">
            {titleBadge}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopyRaw}
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            title="Copy JSON data"
          >
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          </button>
          <button
            type="button"
            onClick={() => setShowRaw((prev) => !prev)}
            className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors flex items-center gap-1 ${
              showRaw
                ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
            }`}
            title="Toggle preview / JSON code"
          >
            {showRaw ? <Eye size={12} /> : <Code2 size={12} />}
            <span>{showRaw ? 'Preview' : 'Code'}</span>
          </button>
        </div>
      </div>

      {/* Body: Raw JSON or Live Component */}
      {showRaw ? (
        <pre className="p-3 rounded-xl bg-neutral-950 text-neutral-300 font-mono text-xs overflow-x-auto max-h-60 border border-neutral-800">
          {rawCodeString}
        </pre>
      ) : (
        <div className="w-full">
          {resolvedType === 'chart' && (
            <CustomChart data={parsedData} onSend={onSend} onAction={onAction} />
          )}

          {resolvedType === 'buttons' && (
            <CustomButtons
              buttons={Array.isArray(parsedData) ? parsedData : parsedData?.buttons || []}
              onSend={onSend}
              onAction={onAction}
            />
          )}

          {resolvedType === 'card' && (
            <CustomCard
              data={parsedData}
              onSend={onSend}
              onAction={onAction}
            />
          )}

          {resolvedType === 'flowchart' && (
            mermaidCode ? (
              <MermaidDiagram
                code={mermaidCode}
                title={parsedData?.title}
                subtitle={parsedData?.subtitle}
                isStreaming={isStreaming}
                embedded={true}
              />
            ) : (
              <SvgFlowchart data={parsedData} onSend={onSend} onAction={onAction} />
            )
          )}

          {resolvedType === 'ui' && (
            <div className="flex flex-col gap-3 w-full">
              {/* Optional top-level title / description */}
              {(parsedData.title || parsedData.description) && (
                <div className="flex flex-col gap-0.5 pb-2 border-b border-neutral-800/80">
                  {parsedData.title && (
                    <h3 className="text-sm font-bold text-white">{parsedData.title}</h3>
                  )}
                  {parsedData.description && (
                    <p className="text-xs text-neutral-300">{parsedData.description}</p>
                  )}
                </div>
              )}

              {/* Chart section if present */}
              {parsedData.chart && (
                <div className="w-full">
                  <CustomChart data={parsedData.chart} />
                </div>
              )}

              {/* Cards / Metrics section if present */}
              {(parsedData.cards || parsedData.card || parsedData.metrics || parsedData.items) && (
                <div className="w-full">
                  <CustomCard
                    data={parsedData.cards || parsedData.card || parsedData}
                    onSend={onSend}
                    onAction={onAction}
                  />
                </div>
              )}

              {/* Action buttons if present */}
              {parsedData.buttons && (
                <div className="pt-1">
                  <CustomButtons
                    buttons={parsedData.buttons}
                    onSend={onSend}
                    onAction={onAction}
                  />
                </div>
              )}
            </div>
          )}

          {/* Action buttons attached to the component (e.g. on flowcharts or charts) */}
          {resolvedType !== 'buttons' && resolvedType !== 'card' && resolvedType !== 'ui' && Array.isArray(parsedData?.buttons) && parsedData.buttons.length > 0 && (
            <div className="mt-3 pt-3 border-t border-neutral-800/80">
              <CustomButtons
                buttons={parsedData.buttons}
                onSend={onSend}
                onAction={onAction}
              />
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
});

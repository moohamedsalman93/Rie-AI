import React, { useEffect, useRef, useState, useId, useMemo } from 'react';
import { motion } from 'framer-motion';
import { GitGraph, Copy, Check, ZoomIn, ZoomOut, RotateCcw, Code2, Eye } from 'lucide-react';
import mermaid from 'mermaid';
import { SvgFlowchart } from './SvgFlowchart';

// Initialize mermaid once with dark-mode theme matching Rie-AI
if (typeof window !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    suppressErrorRendering: true,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#09090b',
      mainBkg: '#18181b',
      nodeBorder: '#3f3f46',
      nodeTextColor: '#f4f4f5',
      lineColor: '#60a5fa',
      textColor: '#f4f4f5',
      fontSize: '13px',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      primaryColor: '#2563eb',
      primaryBorderColor: '#3b82f6',
      primaryTextColor: '#ffffff',
      secondaryColor: '#10b981',
      tertiaryColor: '#8b5cf6',
    },
    flowchart: {
      useMaxWidth: true,
      htmlLabels: true,
      curve: 'basis',
    },
  });
}

/**
 * Auto-sanitizes Mermaid flowchart code to ensure valid syntax:
 * - Quotes unquoted node labels containing special chars (?, &, /, +, ≥, emojis, etc.)
 * - Normalizes unicode comparisons (≥ -> >=, ≤ -> <=)
 * - Auto-prefixes graph TD if missing
 */
export function sanitizeMermaid(code) {
  let raw = (code || '').trim();
  if (!raw) return '';

  // 1. Normalize unicode comparisons and HTML entities
  raw = raw
    .replace(/&quot;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=');

  // 2. Auto-prefix graph TD if bare node connections are provided
  if (
    !/^(?:graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|gitGraph)/m.test(raw) &&
    raw.includes('-->')
  ) {
    raw = `graph TD\n${raw}`;
  }

  // 3. Auto-quote node labels in braces { ... } if unquoted
  // e.g. C{Lint &amp; Static Analysis} -> C{"Lint & Static Analysis"}
  // e.g. E{Coverage >= Threshold?} -> E{"Coverage >= Threshold?"}
  raw = raw.replace(/([a-zA-Z0-9_-]+)\{([^"{}\n]+)\}/g, (match, id, text) => {
    const clean = text.replace(/"/g, "'").trim();
    return `${id}{"${clean}"}`;
  });

  // 4. Auto-quote node labels in brackets [ ... ] if unquoted
  // e.g. A[Developer Push / Pull Request] -> A["Developer Push / Pull Request"]
  // e.g. B[Source Checkout<br/>Git Clone + Webhook Trigger] -> B["Source Checkout<br/>Git Clone + Webhook Trigger"]
  raw = raw.replace(/([a-zA-Z0-9_-]+)\[([^"\[\]\(\)>\n]+)\]/g, (match, id, text) => {
    const clean = text.replace(/"/g, "'").trim();
    return `${id}["${clean}"]`;
  });

  // 5. Auto-quote node labels in parens ( ... ) if unquoted
  raw = raw.replace(/([a-zA-Z0-9_-]+)\(([^"\(\)\n]+)\)/g, (match, id, text) => {
    const clean = text.replace(/"/g, "'").trim();
    return `${id}("${clean}")`;
  });

  return raw;
}

/**
 * Fallback parser that converts Mermaid diagram text into a structured steps list
 * for SvgFlowchart in case Mermaid parsing encounters syntax or environment errors.
 */
export function parseMermaidToFlowchartData(code, title = '', subtitle = '') {
  if (!code || typeof code !== 'string') return null;

  const lines = code.split('\n');
  const nodeMap = new Map();
  const edges = [];

  // Match node declarations: ID["label"] or ID[label] or ID{"label"} or ID{label} etc.
  const nodeRegex = /([a-zA-Z0-9_-]+)(?:\["([^"]*)"\]|\[([^\]]*)\]|\{"([^"]*)"\}|\{([^\}]*)\}|\("([^"]*)"\)|\(([^\)]*)\))/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^(?:graph|flowchart|%%|classDef|style|subgraph|end)/.test(trimmed)) {
      continue;
    }

    // Match edge connections: A --> B or A -->|condition| B
    const edgeMatch = trimmed.match(/([a-zA-Z0-9_-]+)\s*[-.=]+(?:\s*\|([^|]*)\|\s*)?[-.=>]+\s*([a-zA-Z0-9_-]+)/);
    if (edgeMatch) {
      const from = edgeMatch[1];
      const condition = edgeMatch[2]?.trim() || null;
      const to = edgeMatch[3];
      edges.push({ from, to, condition });
    }

    // Extract node definitions
    let match;
    while ((match = nodeRegex.exec(trimmed)) !== null) {
      const id = match[1];
      const rawLabel = match[2] || match[3] || match[4] || match[5] || match[6] || match[7] || id;
      if (!nodeMap.has(id)) {
        // Handle <br/> in labels: title + description
        const parts = rawLabel.split(/<br\s*\/?>/i);
        const label = parts[0]?.trim() || id;
        const desc = parts.slice(1).join(' • ').trim();
        nodeMap.set(id, { id, label, description: desc });
      }
    }
  }

  if (nodeMap.size === 0) return null;

  // Convert node map to ordered list
  const steps = Array.from(nodeMap.values()).map((node) => {
    // Check if this node has an outgoing condition or edge
    const outgoing = edges.find((e) => e.from === node.id);
    const incoming = edges.find((e) => e.to === node.id);
    const condition = outgoing?.condition || incoming?.condition;

    // Detect status based on label
    const lower = node.label.toLowerCase();
    let status = 'ready';
    if (lower.includes('live') || lower.includes('success') || lower.includes('complete') || lower.includes('pass')) {
      status = 'completed';
    } else if (lower.includes('fail') || lower.includes('rollback') || lower.includes('error') || lower.includes('halt') || lower.includes('cancel')) {
      status = 'failed';
    } else if (lower.includes('deploy') || lower.includes('build') || lower.includes('test')) {
      status = 'active';
    }

    return {
      label: node.label,
      description: node.description,
      status,
      condition,
    };
  });

  return {
    title: title || '',
    subtitle: subtitle || '',
    steps,
  };
}

// Global SVG cache so identical Mermaid code renders instantly without re-processing or flickering
const MERMAID_SVG_CACHE = new Map();
let mermaidInstanceCounter = 0;

export const MermaidDiagram = React.memo(function MermaidDiagram({
  code,
  title,
  subtitle,
  embedded = false,
  isStreaming = false,
  className = '',
}) {
  const containerRef = useRef(null);
  const [error, setError] = useState(null);
  const [fallbackData, setFallbackData] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ startX: 0, startY: 0, originPanX: 0, originPanY: 0 });
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);

  // Normalize code and unescape entities that may break or uglify Mermaid
  const cleanCode = useMemo(() => {
    return sanitizeMermaid(code);
  }, [code]);

  // Reset zoom and pan when code changes (unless streaming)
  const prevCodeRef = useRef(cleanCode);
  useEffect(() => {
    if (prevCodeRef.current !== cleanCode && !isStreaming) {
      prevCodeRef.current = cleanCode;
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [cleanCode, isStreaming]);

  // STABLE chartId per component instance (evaluated ONCE on mount, NEVER changes on re-render)
  const chartIdRef = useRef(null);
  if (!chartIdRef.current) {
    mermaidInstanceCounter += 1;
    chartIdRef.current = `mermaid_diag_${mermaidInstanceCounter}_${Math.random().toString(36).substring(2, 7)}`;
  }
  const chartId = chartIdRef.current;

  // Initialize svgHtml directly from cache if available to avoid any blank flash
  const [svgHtml, setSvgHtml] = useState(() => {
    return cleanCode ? MERMAID_SVG_CACHE.get(cleanCode) || '' : '';
  });

  const lastRenderedRef = useRef(svgHtml ? cleanCode : '');
  const renderingRef = useRef(false);

  useEffect(() => {
    if (!cleanCode) {
      setSvgHtml('');
      setError(null);
      setFallbackData(null);
      return;
    }

    // If already rendered for this exact code, do nothing (prevents infinite loop & flicker)
    if (cleanCode === lastRenderedRef.current && svgHtml) {
      return;
    }

    // Check module cache first for instant synchronous render
    if (MERMAID_SVG_CACHE.has(cleanCode)) {
      setSvgHtml(MERMAID_SVG_CACHE.get(cleanCode));
      lastRenderedRef.current = cleanCode;
      setError(null);
      setFallbackData(null);
      return;
    }

    let isMounted = true;
    // Debounce rendering during streaming to avoid running syntax parsing on partial chunks every 30ms
    const debounceMs = isStreaming ? 250 : 20;

    const timer = setTimeout(async () => {
      if (renderingRef.current) return;
      renderingRef.current = true;

      try {
        setError(null);
        setFallbackData(null);
        const { svg } = await mermaid.render(chartId, cleanCode);
        if (isMounted) {
          MERMAID_SVG_CACHE.set(cleanCode, svg);
          lastRenderedRef.current = cleanCode;
          setSvgHtml(svg);
        }
      } catch (err) {
        if (isMounted) {
          console.warn('[MermaidDiagram] Mermaid render error, falling back to SvgFlowchart:', err);
          const fallback = parseMermaidToFlowchartData(cleanCode, title, subtitle);
          if (fallback && fallback.steps.length > 0) {
            setFallbackData(fallback);
          } else if (!isStreaming) {
            setError(err?.message || 'Invalid diagram syntax');
          }
        }
      } finally {
        renderingRef.current = false;
        // Clean up temp element injected by mermaid
        const orphan = document.getElementById(chartId);
        if (orphan) orphan.remove();
      }
    }, debounceMs);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [cleanCode, isStreaming, title, subtitle]);

  // Support Ctrl + Wheel for zooming in/out
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.15 : -0.15;
        setZoom((z) => Math.min(3, Math.max(0.4, Number((z + delta).toFixed(2)))));
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  const handlePointerDown = (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originPanX: pan.x,
      originPanY: pan.y,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {}
  };

  const handlePointerMove = (e) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    setPan({
      x: dragStartRef.current.originPanX + dx,
      y: dragStartRef.current.originPanY + dy,
    });
  };

  const handlePointerUp = (e) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
      try {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
    }
  };

  const handlePointerCancel = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      setIsDragging(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(cleanCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy diagram code:', e);
    }
  };

  const handleZoomIn = () => setZoom((z) => Math.min(3, Number((z + 0.15).toFixed(2))));
  const handleZoomOut = () => setZoom((z) => Math.max(0.4, Number((z - 0.15).toFixed(2))));
  const handleResetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const innerContent = (
    <div className={`w-full flex flex-col ${className}`}>
      {/* Title / Subtitle if provided */}
      {(title || subtitle) && (
        <div className="flex flex-col gap-0.5 border-b border-neutral-800/80 pb-2.5 mb-2.5">
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

      {/* Floating zoom controls & pan status */}
      {!showCode && !fallbackData && !error && svgHtml && (
        <div className="flex items-center justify-between gap-1 mb-1.5 px-0.5">
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-neutral-800/80 border border-neutral-700/60 text-neutral-300 select-none">
              {Math.round(zoom * 100)}%
            </span>
            {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
              <span className="text-[10px] text-neutral-500 hidden sm:inline-flex items-center gap-1 select-none">
                • Drag to pan • Double click to center
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleZoomOut}
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              title="Zoom Out"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              title="Reset Zoom & Pan"
            >
              <RotateCcw size={13} />
            </button>
            <button
              type="button"
              onClick={handleZoomIn}
              className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              title="Zoom In"
            >
              <ZoomIn size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      {showCode ? (
        <pre className="p-3 rounded-xl bg-neutral-950 text-neutral-300 font-mono text-xs overflow-x-auto max-h-72 border border-neutral-800">
          {cleanCode}
        </pre>
      ) : fallbackData ? (
        <SvgFlowchart data={fallbackData} />
      ) : error ? (
        <div className="flex flex-col gap-2 p-3 rounded-xl bg-neutral-950/80 border border-red-500/30 text-xs">
          <div className="flex items-center gap-1.5 text-red-400 font-semibold">
            <span>Flowchart Syntax Error</span>
          </div>
          <pre className="text-neutral-400 font-mono text-[11px] overflow-x-auto whitespace-pre">
            {cleanCode}
          </pre>
        </div>
      ) : !svgHtml && isStreaming ? (
        <div className="flex items-center justify-center h-32 gap-2 text-xs text-neutral-400 animate-pulse">
          <GitGraph size={16} className="animate-spin text-blue-400" />
          <span>Generating flowchart diagram...</span>
        </div>
      ) : (
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onDoubleClick={handleResetZoom}
          className={`relative w-full overflow-hidden py-4 flex justify-center items-center select-none touch-none rounded-xl border border-neutral-800/50 bg-neutral-950/40 min-h-[220px] transition-colors ${
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          }`}
          title="Drag to pan diagram • Double click to center"
        >
          <div
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isDragging ? 'none' : 'transform 0.18s cubic-bezier(0.16, 1, 0.3, 1)',
              willChange: isDragging ? 'transform' : 'auto',
            }}
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            className="mermaid-svg-container pointer-events-none flex items-center justify-center [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:rounded-lg"
          />
        </div>
      )}
    </div>
  );

  if (embedded) {
    return innerContent;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`my-3 w-full rounded-2xl border border-neutral-700/70 bg-gradient-to-b from-neutral-900/95 to-neutral-950/95 p-4 shadow-2xl backdrop-blur-md overflow-hidden ${className}`}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between pb-2.5 mb-2.5 border-b border-neutral-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-400 shrink-0">
            <GitGraph size={13} />
          </div>
          <span className="text-[10px] font-semibold tracking-wider text-neutral-300 uppercase truncate">
            Interactive Flowchart / Diagram
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
            title="Copy diagram source"
          >
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          </button>

          <button
            type="button"
            onClick={() => setShowCode((prev) => !prev)}
            className={`px-1.5 py-0.5 rounded-md text-[10px] font-medium transition-colors flex items-center gap-1 ${
              showCode
                ? 'bg-blue-600/30 text-blue-300 border border-blue-500/40'
                : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
            }`}
            title="Toggle preview / code"
          >
            {showCode ? <Eye size={12} /> : <Code2 size={12} />}
            <span>{showCode ? 'Diagram' : 'Code'}</span>
          </button>
        </div>
      </div>

      {innerContent}
    </motion.div>
  );
});

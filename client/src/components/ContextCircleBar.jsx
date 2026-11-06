import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

function formatCompact(num) {
  if (num == null || isNaN(num)) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function getModelContextLimit(provider, model) {
  const m = (model || '').toLowerCase();
  if (m.includes('gemini')) return 1000000;
  if (m.includes('deepseek')) return 64000;
  if (m.includes('claude')) return 200000;
  return 128000;
}

function getActiveModelName(provider, settings) {
  switch (provider) {
    case 'azure_foundry':
    case 'azure':
      return settings?.azure_foundry_model || 'gpt-6-luna';
    case 'openai':
      return settings?.openai_model || 'gpt-4o-mini';
    case 'gemini':
      return settings?.gemini_model || 'gemini-2.5-flash';
    case 'vertex':
      return settings?.vertex_model || 'gemini-2.5-flash';
    case 'groq':
      return settings?.groq_model || 'openai/gpt-oss-120b';
    case 'deepseek':
      return settings?.deepseek_model || 'deepseek-chat';
    case 'glm':
      return settings?.glm_model || 'glm-4.7-flash';
    case 'ollama':
      return settings?.ollama_model || 'llama3';
    case 'rie':
    default:
      return 'Rie Default';
  }
}

export function ContextCircleBar({
  threadId,
  contextData = null,
  messages = [],
  provider = 'rie',
  settings = {},
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const activeProviderKey = provider || settings?.llm_provider || 'rie';
  const modelName = getActiveModelName(activeProviderKey, settings);
  const maxContextTokens = contextData?.max_context_tokens || getModelContextLimit(activeProviderKey, modelName);

  // Compute breakdown from server contextData or fallback from client messages
  const toolTokens = contextData?.tool_tokens ?? (contextData?.tool_schema || 1200);
  const systemTokens = contextData?.system_tokens ?? (contextData?.base_system || 1850);

  const clientMsgTokens = messages.reduce((acc, msg) => {
    const txt = msg.text || (typeof msg.content === 'string' ? msg.content : '') || '';
    return acc + Math.max(1, Math.ceil(txt.length / 4));
  }, 0);
  const messageTokens = contextData?.message_tokens ?? (contextData?.messages || clientMsgTokens);

  const totalTokens = contextData?.total_tokens ?? (toolTokens + systemTokens + messageTokens);
  const percent = Math.min(100, Math.max(0.1, Number(((totalTokens / maxContextTokens) * 100).toFixed(1))));

  // Percentage color thresholds
  let strokeColor = '#10b981'; // emerald-500
  let textColor = 'text-emerald-400';
  if (percent >= 85) {
    strokeColor = '#f43f5e'; // rose-500
    textColor = 'text-rose-400';
  } else if (percent >= 65) {
    strokeColor = '#f59e0b'; // amber-500
    textColor = 'text-amber-400';
  }

  // Click outside to dismiss
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const systemPctOfUsed = totalTokens > 0 ? Math.round((systemTokens / totalTokens) * 100) : 0;
  const toolPctOfUsed = totalTokens > 0 ? Math.round((toolTokens / totalTokens) * 100) : 0;
  const msgPctOfUsed = totalTokens > 0 ? Math.round((messageTokens / totalTokens) * 100) : 0;

  return (
    <div className="relative inline-block select-none" ref={containerRef}>
      {/* Context Circle Bar Trigger Button - Pure Circle Icon */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`p-1.5 rounded-lg transition-colors flex items-center justify-center shrink-0 ${
          isOpen
            ? 'bg-neutral-800 text-white'
            : 'text-neutral-400 hover:text-white hover:bg-neutral-800/60'
        }`}
        title={`Context: ${totalTokens.toLocaleString()} / ${formatCompact(maxContextTokens)} tokens (${percent}%)`}
        aria-label="Context window usage breakdown"
      >
        <div className="relative flex items-center justify-center shrink-0 w-[18px] h-[18px]">
          <svg className="w-[18px] h-[18px] -rotate-90 transform" viewBox="0 0 36 36">
            <path
              className="text-neutral-700/60"
              strokeWidth="3.6"
              stroke="currentColor"
              fill="none"
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            />
            <path
              stroke={strokeColor}
              strokeDasharray={`${Math.max(2, Math.min(100, percent))}, 100`}
              strokeLinecap="round"
              strokeWidth="3.6"
              fill="none"
              className="transition-all duration-500 ease-out"
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            />
          </svg>
        </div>
      </button>

      {/* Popover Breakdown Dialog - Compact & Minimal */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 6 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
            className="absolute bottom-full mb-2 right-0 z-50 w-60 rounded-xl border border-neutral-800 bg-neutral-900/95 backdrop-blur-md shadow-xl p-3 text-neutral-200"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-2 border-b border-neutral-800/80">
              <span className="text-xs font-semibold text-neutral-200">Context Window</span>
              <span className={`text-[11px] font-medium font-mono ${textColor}`}>
                {percent}%
              </span>
            </div>

            {/* Compact Stacked Progress Bar */}
            <div className="h-1.5 w-full rounded-full bg-neutral-800 flex overflow-hidden my-2.5 gap-0.5">
              <div
                className="bg-purple-500 rounded-sm transition-all duration-300"
                style={{ width: `${systemPctOfUsed}%` }}
                title={`System: ${systemPctOfUsed}%`}
              />
              <div
                className="bg-sky-500 rounded-sm transition-all duration-300"
                style={{ width: `${toolPctOfUsed}%` }}
                title={`Tools: ${toolPctOfUsed}%`}
              />
              <div
                className="bg-emerald-500 rounded-sm transition-all duration-300"
                style={{ width: `${msgPctOfUsed}%` }}
                title={`Messages: ${msgPctOfUsed}%`}
              />
            </div>

            {/* 3 Main Token Rows */}
            <div className="space-y-1.5 py-1 text-xs">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-neutral-300">
                  <span className="w-2 h-2 rounded-full bg-purple-500 shrink-0" />
                  <span>System Instruction</span>
                </div>
                <span className="font-mono text-neutral-200 font-medium">{systemTokens.toLocaleString()}</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-neutral-300">
                  <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" />
                  <span>Tool Tokens</span>
                </div>
                <span className="font-mono text-neutral-200 font-medium">{toolTokens.toLocaleString()}</span>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-neutral-300">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span>Message Tokens</span>
                </div>
                <span className="font-mono text-neutral-200 font-medium">{messageTokens.toLocaleString()}</span>
              </div>
            </div>

            {/* Footer Summary */}
            <div className="pt-2 mt-2 border-t border-neutral-800/80 flex items-center justify-between text-[11px] text-neutral-400">
              <span>Total Usage</span>
              <span className="font-mono text-neutral-300 font-medium">
                {totalTokens.toLocaleString()} <span className="text-neutral-500 font-normal">/ {formatCompact(maxContextTokens)}</span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import React, { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy, ExternalLink, ArrowRight, Sparkles } from 'lucide-react';
import { CustomUiIcon } from './CustomUiIcon';

export function CustomButtons({ buttons = [], onSend, onAction, disabled = false, layout = 'auto' }) {
  const [copiedIdx, setCopiedIdx] = useState(null);
  const [clickedIdx, setClickedIdx] = useState(null);

  const buttonList = Array.isArray(buttons) ? buttons : [];

  const handleButtonClick = useCallback(async (btn, idx) => {
    if (disabled) return;

    setClickedIdx(idx);
    setTimeout(() => setClickedIdx(null), 300);

    const action = btn?.action || (btn?.url ? 'url' : 'message');
    const value = btn?.value ?? btn?.prompt ?? btn?.text ?? btn?.label;

    if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(String(value || ''));
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx(null), 2000);
      } catch (err) {
        console.error('Failed to copy button value:', err);
      }
      return;
    }

    if (action === 'url' || btn?.url) {
      const url = btn.url || value;
      if (!url) return;
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
      } catch (e) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    if (action === 'message' || action === 'prompt') {
      if (onAction) {
        onAction({ type: 'message', text: String(value || btn.label || '') });
      } else if (onSend) {
        onSend(String(value || btn.label || ''));
      }
      return;
    }

    // Generic custom action callback
    if (onAction) {
      onAction({ type: action, button: btn, value });
    } else if (onSend && value) {
      onSend(String(value));
    }
  }, [disabled, onAction, onSend]);

  if (buttonList.length === 0) return null;

  const isGrid = layout === 'grid' || (layout === 'auto' && buttonList.length >= 4);

  return (
    <div
      className={
        isGrid
          ? 'grid grid-cols-1 sm:grid-cols-2 gap-2 w-full pt-1'
          : 'flex flex-wrap items-center gap-2 w-full pt-1'
      }
    >
      {buttonList.map((btn, idx) => {
        const isCopied = copiedIdx === idx;
        const isClicked = clickedIdx === idx;
        const variant = btn?.variant || 'secondary';

        let variantStyle = 'bg-neutral-800/80 hover:bg-neutral-700/80 text-neutral-200 border-neutral-700/60';
        if (variant === 'primary') {
          variantStyle = 'bg-blue-600 hover:bg-blue-500 text-white border-blue-500/80 shadow-md shadow-blue-600/20';
        } else if (variant === 'success') {
          variantStyle = 'bg-emerald-600/90 hover:bg-emerald-500 text-white border-emerald-500/80 shadow-md shadow-emerald-600/20';
        } else if (variant === 'outline') {
          variantStyle = 'bg-transparent hover:bg-blue-600/10 text-blue-400 hover:text-blue-300 border-blue-500/40 hover:border-blue-400';
        } else if (variant === 'danger') {
          variantStyle = 'bg-red-950/40 hover:bg-red-900/60 text-red-200 border-red-800/60';
        }

        const isUrl = Boolean(btn?.url || btn?.action === 'url');

        return (
          <motion.button
            key={idx}
            type="button"
            disabled={disabled}
            whileTap={{ scale: disabled ? 1 : 0.96 }}
            onClick={() => handleButtonClick(btn, idx)}
            className={`group relative inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-all duration-150 backdrop-blur-sm select-none ${variantStyle} ${
              disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer active:scale-95'
            }`}
          >
            {isCopied ? (
              <Check size={13} className="text-emerald-400 shrink-0" />
            ) : btn?.icon ? (
              <CustomUiIcon
                name={btn.icon}
                size={13}
                className="shrink-0 transition-transform group-hover:scale-110"
              />
            ) : isUrl ? (
              <ExternalLink size={12} className="shrink-0 opacity-70 group-hover:opacity-100" />
            ) : variant === 'primary' ? (
              <Sparkles size={12} className="shrink-0 text-blue-200" />
            ) : null}

            <span className="truncate max-w-[220px]">
              {isCopied ? 'Copied!' : (btn?.label || btn?.text || 'Action')}
            </span>

            {/* Subtle action indicator on hover */}
            {!isUrl && !isCopied && variant === 'primary' && (
              <ArrowRight size={11} className="shrink-0 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

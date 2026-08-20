import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Check, Sparkles } from 'lucide-react';
import { PROVIDERS } from './settings/constants';

export function LlmProviderSelector({
  provider = 'rie',
  onSelectProvider,
  settings = {},
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  const activeProviderKey = provider || settings?.llm_provider || 'rie';
  const currentProviderInfo = PROVIDERS[activeProviderKey] || {
    label: activeProviderKey,
    icon: <Sparkles size={14} />,
  };

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

  const isConfigured = (key) => {
    switch (key) {
      case 'gemini':
        return Boolean(settings?.google_api_key);
      case 'openai':
        return Boolean(settings?.openai_api_key);
      case 'deepseek':
        return Boolean(settings?.deepseek_api_key);
      case 'glm':
        return Boolean(settings?.glm_api_key);
      case 'groq':
        return Boolean(settings?.groq_api_key);
      case 'vertex':
        return Boolean(settings?.vertex_project && settings?.vertex_credentials_path);
      case 'rie':
      case 'ollama':
      default:
        return true;
    }
  };

  const handleProviderClick = (key) => {
    onSelectProvider?.(key);
    setIsOpen(false);
  };

  const configuredProviders = Object.entries(PROVIDERS).filter(([key]) => {
    return isConfigured(key) || key === activeProviderKey;
  });

  return (
    <div className="relative inline-block select-none" ref={containerRef}>
      {/* Collapsed Provider Chip Button */}
      {!isOpen && (
        <motion.button
          layoutId="provider-chip-container"
          type="button"
          onClick={() => setIsOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 hover:text-white border-neutral-700/60 px-2 py-1 text-xs transition-colors shadow-sm shrink-0"
          title="Click to switch LLM Provider"
        >
          <span className="flex items-center justify-center shrink-0 w-3.5 h-3.5">
            {currentProviderInfo.icon}
          </span>
          <span className="font-medium text-[11px] tracking-wide max-w-[70px] sm:max-w-[110px] truncate">
            {currentProviderInfo.label || activeProviderKey}
          </span>
          <ChevronDown size={12} className="text-neutral-400 shrink-0" />
        </motion.button>
      )}

      {/* Expanded Provider Chip Card with Morphing Transition */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            layoutId="provider-chip-container"
            initial={{ opacity: 0, scale: 0.95, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 4 }}
            transition={{
              type: 'spring',
              stiffness: 450,
              damping: 30,
              mass: 0.8,
            }}
            className="absolute bottom-0 right-0 z-50 min-w-[150px] w-auto rounded-xl border border-neutral-700/80 bg-neutral-800/95 p-1 shadow-2xl backdrop-blur-xl overflow-hidden origin-bottom-right"
          >
            {/* Active Chip Header Bar */}
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="flex items-center justify-between w-full gap-2 px-2.5 py-1 text-xs text-white border-b border-white/10 mb-1"
            >
              <div className="flex items-center gap-1.5">
                <span className="flex items-center justify-center shrink-0 w-3.5 h-3.5">
                  {currentProviderInfo.icon}
                </span>
                <span className="font-semibold text-[11px] tracking-wide">
                  {currentProviderInfo.label || activeProviderKey}
                </span>
              </div>
              <ChevronDown size={12} className="text-emerald-400 rotate-180 shrink-0" />
            </button>

            {/* Expanding List of Configured Providers */}
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="space-y-0.5 max-h-48 overflow-y-auto custom-scrollbar"
            >
              {configuredProviders.map(([key, providerObj]) => {
                const isSelected = activeProviderKey === key;

                return (
                  <button
                    key={key}
                    onClick={() => handleProviderClick(key)}
                    className={`flex items-center justify-between w-full px-2.5 py-1.5 rounded-lg text-xs transition-all ${
                      isSelected
                        ? 'bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30'
                        : 'text-neutral-300 hover:bg-white/10 hover:text-white border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="flex items-center justify-center shrink-0 w-3.5 h-3.5">
                        {providerObj.icon}
                      </span>
                      <span className="truncate text-xs">{providerObj.label}</span>
                    </div>

                    {isSelected && (
                      <Check size={13} className="text-emerald-400 shrink-0 ml-2" />
                    )}
                  </button>
                );
              })}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

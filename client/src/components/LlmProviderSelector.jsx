import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
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
    icon: null,
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

  const numCols = Math.max(2, Math.ceil(configuredProviders.length / 2));

  return (
    <div className="relative inline-block select-none" ref={containerRef}>
      {/* Provider Icon-Only Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors shadow-sm shrink-0 ${
          isOpen
            ? 'bg-neutral-800 text-white border-neutral-600'
            : 'bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 hover:text-white border-neutral-700/60'
        }`}
        title={`LLM Provider: ${currentProviderInfo.label || activeProviderKey}`}
        aria-label={`LLM Provider: ${currentProviderInfo.label || activeProviderKey}`}
      >
        <span className="flex items-center justify-center shrink-0 w-4 h-4">
          {currentProviderInfo.icon}
        </span>
        <ChevronDown
          size={11}
          className={`text-neutral-400 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-emerald-400' : ''
          }`}
        />
      </button>

      {/* 2-Row Icon-Only Popover Grid */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 4 }}
            transition={{
              type: 'spring',
              stiffness: 450,
              damping: 30,
              mass: 0.8,
            }}
            className="absolute bottom-full mb-2 right-0 z-50 w-max rounded-xl border border-neutral-700/80 bg-neutral-900/95 p-2 shadow-2xl backdrop-blur-xl origin-bottom-right"
          >
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: `repeat(${numCols}, minmax(40px, 40px))`,
              }}
            >
              {configuredProviders.map(([key, providerObj]) => {
                const isSelected = activeProviderKey === key;

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleProviderClick(key)}
                    title={providerObj.label}
                    aria-label={providerObj.label}
                    className={`group relative flex items-center justify-center w-10 h-10 rounded-lg transition-all ${
                      isSelected
                        ? 'bg-neutral-800 text-white border border-white/20 shadow-sm ring-1 ring-emerald-500/40'
                        : 'bg-neutral-800/40 text-neutral-400 hover:text-white hover:bg-white/[0.08] hover:border-white/10 border border-transparent'
                    }`}
                  >
                    <span className="flex items-center justify-center shrink-0 w-5 h-5 transition-transform group-hover:scale-110">
                      {providerObj.icon}
                    </span>

                    {isSelected && (
                      <span className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-emerald-400 ring-1 ring-neutral-900" />
                    )}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

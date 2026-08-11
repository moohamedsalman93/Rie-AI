import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import logo from "../assets/logo.png";

const LOADING_STEPS = [
  {
    id: "init",
    title: "Initializing Assistant",
    description: "Setting up environment & configuration...",
  },
  {
    id: "backend",
    title: "Starting Backend Services",
    description: "Connecting to core engine at localhost:14300...",
  },
  {
    id: "context",
    title: "Loading Context",
    description: "Retrieving local SQLite history & settings...",
  },
  {
    id: "models",
    title: "Preparing AI Models",
    description: "Optimizing execution performance...",
  },
  {
    id: "ready",
    title: "System Ready",
    description: "Rie-AI is online and ready",
  },
];

export function LoadingScreen({ onMouseDown, onClose, onMinimize }) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  useEffect(() => {
    if (currentStepIndex < LOADING_STEPS.length - 1) {
      const timer = setTimeout(() => {
        setCurrentStepIndex((prev) => prev + 1);
      }, 700 + Math.random() * 800);
      return () => clearTimeout(timer);
    }
  }, [currentStepIndex]);

  const currentStep = LOADING_STEPS[currentStepIndex];
  const progressPercent = ((currentStepIndex + 1) / LOADING_STEPS.length) * 100;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      onMouseDown={onMouseDown}
      data-tauri-drag-region
      className="absolute inset-0 z-[99999] pointer-events-auto w-full h-full font-sans text-neutral-100 select-none border border-neutral-800 rounded-2xl overflow-hidden bg-neutral-950/95 shadow-2xl backdrop-blur-xl p-3.5 flex flex-col justify-between"
    >
      {/* Top Header */}
      <div className="flex items-center justify-between" data-tauri-drag-region>
        <div className="flex items-center gap-2.5" data-tauri-drag-region>
          <div className="relative flex items-center justify-center">
            <img src={logo} alt="Rie-AI" className="w-5 h-5 object-contain" />
            <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
          </div>
          <div className="flex flex-col text-left">
            <span className="text-xs font-bold text-white tracking-tight leading-none">Rie-AI</span>
            <span className="text-[10px] text-neutral-400 font-mono mt-0.5 leading-none">Initializing...</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {onMinimize && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMinimize();
              }}
              className="w-6 h-6 rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors flex items-center justify-center text-xs font-bold"
              aria-label="Minimize"
            >
              –
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              className="w-6 h-6 rounded-md text-neutral-400 hover:bg-red-500/20 hover:text-red-400 transition-colors flex items-center justify-center text-xs font-bold"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Step Status Text */}
      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep.id}
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -6 }}
          transition={{ duration: 0.15 }}
          className="space-y-0.5 text-left my-1"
        >
          <p className="text-xs font-semibold text-neutral-100 flex items-center justify-between">
            <span className="truncate pr-2">{currentStep.title}</span>
            <span className="text-[10px] font-mono text-emerald-400 font-normal shrink-0">
              {Math.round(progressPercent)}%
            </span>
          </p>
          <p className="text-[10.5px] text-neutral-400 truncate leading-tight">
            {currentStep.description}
          </p>
        </motion.div>
      </AnimatePresence>

      {/* Progress Bar */}
      <div className="h-1.5 w-full bg-neutral-900 rounded-full overflow-hidden border border-neutral-800 shrink-0">
        <motion.div
          className="h-full bg-emerald-500 rounded-full"
          animate={{ width: `${progressPercent}%` }}
          transition={{ duration: 0.35, ease: "easeOut" }}
        />
      </div>
    </motion.div>
  );
}

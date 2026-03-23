import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import logo from "../assets/logo.png";

const LOADING_STEPS = [
    {
        id: "init",
        title: "Initialize Assistant",
        description: "Setting up environment and configuration...",
    },
    {
        id: "backend",
        title: "Start Backend Services",
        description: "Connecting to neural engine and core logic...",
    },
    {
        id: "context",
        title: "Load Conversation Context",
        description: "Retrieving local memory and history...",
    },
    {
        id: "models",
        title: "Prepare AI Models",
        description: "Optimizing for performance and security...",
    },
    {
        id: "ready",
        title: "Ready",
        description: "Assistant is online and ready to help",
    }
];

export function LoadingScreen({ onMouseDown, onClose, onMinimize }) {
    const [currentStepIndex, setCurrentStepIndex] = useState(0);

    // Simulate loading progress
    useEffect(() => {
        if (currentStepIndex < LOADING_STEPS.length - 1) {
            const timer = setTimeout(() => {
                setCurrentStepIndex(prev => prev + 1);
            }, 800 + Math.random() * 1000); // Random duration per step
            return () => clearTimeout(timer);
        }
    }, [currentStepIndex]);

    const currentStep = LOADING_STEPS[currentStepIndex];

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={onMouseDown}
            data-tauri-drag-region
            className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-[#08090a] font-sans text-neutral-100 rounded-2xl overflow-hidden pointer-events-auto select-none"
        >
            {/* Subtle mesh background */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-50">
                <div className="absolute -top-[20%] -left-[10%] w-full h-full rounded-full bg-emerald-500/10 blur-[120px]" />
                <div className="absolute top-[40%] -right-[10%] w-full h-full rounded-full bg-blue-500/10 blur-[130px]" />
            </div>

            <main className="relative z-10 w-[90%] w-full bg-[#111418]/80 backdrop-blur-xl border border-white/5 rounded-xl py-2 px-4 shadow-2xl flex flex-col h-full">
                {/* Header section with window controls */}
                <header className="flex justify-between items-start shrink-0 cursor-move">
                    <div className="flex items-center gap-3" data-tauri-drag-region>
                        <img src={logo} alt="Rie-AI" className="w-8 h-8 object-contain" />
                        <div>
                            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500 mb-1 leading-none">
                                Rie AI
                            </h2>
                            <h1 className="text-lg font-semibold text-white tracking-tight leading-none">
                                Preparing Workspace
                            </h1>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <span className="text-[10px] font-medium text-neutral-600 bg-white/5 px-2 py-1 rounded border border-white/5 mr-2">
                            Desktop App
                        </span>
                        {onMinimize && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onMinimize(); }}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors"
                                title="Minimize"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                            </button>
                        )}
                        {onClose && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onClose(); }}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="p-2 rounded-lg text-neutral-400 hover:bg-red-500/20 hover:text-red-400 transition-colors"
                                title="Close"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        )}
                    </div>
                </header>

                {/* Central Cycling Status Area */}
                <div className="flex-grow flex flex-col items-center justify-center relative overflow-hidden py-8">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={currentStep.id}
                            initial={{ opacity: 0, y: 15, filter: "blur(10px)" }}
                            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                            exit={{ opacity: 0, y: -15, filter: "blur(10px)" }}
                            transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
                            className="flex flex-col items-center text-center"
                        >
                            {/* Circular Progress Indicator */}
                            <div className="relative w-14 h-14 mb-6 flex items-center justify-center">
                                <div className="absolute inset-0 rounded-full border-2 border-white/5" />
                                <motion.div
                                    className="absolute inset-0 rounded-full border-2 border-t-emerald-400 border-l-emerald-400/30 border-r-transparent border-b-transparent"
                                    animate={{ rotate: 360 }}
                                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                                />
                                {currentStepIndex === LOADING_STEPS.length - 1 ? (
                                    <motion.svg
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        className="w-6 h-6 text-emerald-400 relative z-10"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="3"
                                    >
                                        <polyline points="20 6 9 17 4 12" />
                                    </motion.svg>
                                ) : (
                                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.8)]" />
                                )}
                            </div>

                            <h3 className="text-xl font-bold tracking-tight text-white mb-2">
                                {currentStep.title}
                            </h3>
                            <p className="text-sm text-neutral-400 max-w-[360px] leading-relaxed">
                                {currentStep.description}
                            </p>
                        </motion.div>
                    </AnimatePresence>
                </div>

                {/* Progress Bar */}
                <div className="mt-6 overflow-hidden h-1 w-full bg-white/5 rounded-full relative shrink-0">
                    <motion.div
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full"
                        animate={{ width: `${((currentStepIndex + 1) / LOADING_STEPS.length) * 100}%` }}
                        transition={{ duration: 0.8, ease: "easeInOut" }}
                    />
                </div>

                {/* Footer */}
                <footer className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between opacity-40 shrink-0">
                    <span className="text-[10px] font-medium text-neutral-400 tracking-wider">
                        Backend health check at <span className="text-emerald-500 font-bold">localhost:8000</span>
                    </span>
                    <span className="text-[10px] font-medium text-neutral-600 tracking-widest uppercase">
                        Secure Neural Link
                    </span>
                </footer>
            </main>
        </motion.div>
    );
}

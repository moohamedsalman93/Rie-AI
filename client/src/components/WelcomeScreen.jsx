import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Sparkles,
    Bot,
    Terminal,
    ImagePlus,
    RefreshCw,
    Mic,
    Square,
    Settings,
    ChevronRight,
    ChevronLeft,
    CheckCircle2,
    Minus,
    X,
} from "lucide-react";
import logo from "../assets/logo.png";

export function WelcomeScreen({ onGetStarted, onMouseDown, onMinimize, onClose }) {
    const [step, setStep] = useState(0);

    const nextStep = () => setStep((s) => Math.min(s + 1, steps.length - 1));
    const prevStep = () => setStep((s) => Math.max(s - 1, 0));

    const steps = [
        {
            id: "intro",
            content: (
                <div className="flex flex-col items-center text-center space-y-6">
                    <motion.div
                        initial={{ scale: 0.9, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.4 }}
                        className="relative mb-2"
                    >
                        <div className="absolute inset-0 bg-emerald-500/20 blur-xl rounded-full" />
                        <img src={logo} alt="Rie-AI" className="relative w-28 h-28 object-contain" />
                    </motion.div>

                    <div className="space-y-3">
                        <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-blue-500">
                            Welcome to Rie-AI
                        </h1>
                        <p className="text-neutral-300 max-w-md mx-auto leading-relaxed">
                            A desktop AI copilot for chat, coding, and system tasks.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-xl">
                        <FeaturePill Icon={Bot} title="Smart Chat" />
                        <FeaturePill Icon={Terminal} title="Terminal Actions" />
                        <FeaturePill Icon={ImagePlus} title="File + Screen Context" />
                    </div>
                </div>
            ),
        },
        {
            id: "flow",
            content: (
                <div className="flex flex-col space-y-6 w-full">
                    <div className="text-center space-y-2">
                        <h2 className="text-2xl font-bold text-blue-400">How it works</h2>
                        <p className="text-neutral-400 text-sm">
                            Start in seconds with a simple setup flow.
                        </p>
                    </div>

                    <div className="max-w-lg mx-auto w-full space-y-3">
                        <FlowCard number="1" title="Open Settings" description="Pick your provider and add your API key." />
                        <FlowCard number="2" title="Choose chat style" description="Switch between Agent mode and Chat mode anytime." />
                        <FlowCard number="3" title="Start your first task" description="Ask a question, run a command, or attach context." />
                    </div>
                </div>
            ),
        },
        {
            id: "shortcuts",
            content: (
                <div className="flex flex-col space-y-6 w-full">
                    <div className="text-center space-y-2">
                        <h2 className="text-2xl font-bold text-emerald-400">Useful shortcuts</h2>
                        <p className="text-neutral-400 text-sm">
                            Control Rie-AI quickly from anywhere.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-2 mt-2 max-w-sm mx-auto">
                        <ShortcutCard keys="Alt + Shift + A" desc="Toggle Bubble and Chat" Icon={RefreshCw} />
                        <ShortcutCard keys="Alt + Shift + S" desc="Push to Talk" Icon={Mic} />
                        <ShortcutCard keys="Alt + Shift + C" desc="Stop current response" Icon={Square} />
                    </div>
                </div>
            ),
        },
        {
            id: "finish",
            content: (
                <div className="flex flex-col items-center text-center space-y-6">
                    <div className="w-20 h-20 bg-neutral-800 rounded-2xl flex items-center justify-center shadow-xl shadow-emerald-500/10 border border-neutral-700">
                        <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                    </div>

                    <div className="space-y-2">
                        <h2 className="text-2xl font-bold text-emerald-400">You are ready</h2>
                        <p className="text-neutral-400 text-sm max-w-sm mx-auto">
                            Continue to Settings to finish configuration and start chatting.
                        </p>
                    </div>
                </div>
            ),
        },
    ];

    return (
        <div
            className="absolute inset-0 bg-neutral-900 z-[60] flex flex-col font-sans text-neutral-100 border border-neutral-800 rounded-2xl overflow-hidden pointer-events-auto select-none"
        >
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-emerald-500/10 blur-[100px]" />
                <div className="absolute top-[40%] -right-[10%] w-[50%] h-[50%] rounded-full bg-blue-500/10 blur-[100px]" />
            </div>

            <div
                onMouseDown={(e) => onMouseDown?.(e)}
                data-tauri-drag-region
                className="relative z-20 h-10 px-3 border-b border-neutral-800/60 bg-neutral-950/70 backdrop-blur-md flex items-center justify-between cursor-move"
            >
                <div className="flex-1 h-full flex items-center text-xs text-neutral-500 font-medium tracking-wide">
                    Onboarding
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        data-tauri-drag-region="false"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            onMinimize?.();
                        }}
                        className="w-7 h-7 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors flex items-center justify-center"
                        aria-label="Minimize"
                    >
                        <Minus className="w-4 h-4" />
                    </button>
                    <button
                        type="button"
                        data-tauri-drag-region="false"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            onClose?.();
                        }}
                        className="w-7 h-7 rounded-md text-neutral-400 hover:text-white hover:bg-red-500/20 transition-colors flex items-center justify-center"
                        aria-label="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="relative z-10 flex flex-col h-full max-w-xl mx-auto w-full p-6">
                <div className="flex justify-center gap-2 mb-6 mt-4">
                    {steps.map((_, i) => (
                        <div
                            key={i}
                            className={`h-1 rounded-full transition-all duration-300 ${i === step ? "w-6 bg-emerald-500" : "w-1 bg-neutral-700"
                                }`}
                        />
                    ))}
                </div>

                <div className="flex-1 flex items-center justify-center overflow-y-auto custom-scrollbar px-4 border border-dashed border-neutral-800/30 rounded-xl bg-neutral-900/30 backdrop-blur-sm">
                    <AnimatePresence mode="wait">
                        <motion.div
                            key={step}
                            initial={{ x: 10, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: -10, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="w-full h-full flex items-center justify-center"
                        >
                            {steps[step].content}
                        </motion.div>
                    </AnimatePresence>
                </div>

                <div className="flex justify-between items-center mt-6 pt-5 border-t border-neutral-800/50">
                    <button
                        onClick={prevStep}
                        disabled={step === 0}
                        className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${step === 0
                            ? "text-neutral-600 cursor-not-allowed"
                            : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                            }`}
                    >
                        <ChevronLeft className="w-4 h-4" />
                        Back
                    </button>

                    {step < steps.length - 1 ? (
                        <button
                            onClick={nextStep}
                            className="flex items-center gap-2 px-7 py-2.5 bg-neutral-100 hover:bg-white text-neutral-900 text-sm font-bold rounded-lg shadow-lg hover:shadow-xl transition-all active:scale-95"
                        >
                            Next
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    ) : (
                        <button
                            onClick={onGetStarted}
                            className="px-7 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-lg shadow-lg shadow-emerald-500/20 transition-all hover:scale-105 active:scale-95 flex items-center gap-2"
                        >
                            Get Started
                            <Sparkles className="w-4 h-4" />
                        </button>
                    )}
                </div>

            </div>
        </div>
    );
}

function FeaturePill({ title, Icon }) {
    return (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neutral-800/60 border border-neutral-700/60 text-neutral-200 justify-center">
            <div className="p-1.5 rounded-md bg-neutral-900/70 text-emerald-400">
                <Icon className="w-4 h-4" />
            </div>
            <span className="text-sm font-medium">{title}</span>
        </div>
    );
}

function FlowCard({ number, title, description }) {
    return (
        <div className="rounded-xl bg-neutral-800/50 border border-neutral-700/60 px-4 py-3 flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-400 text-xs font-bold flex items-center justify-center mt-0.5">
                {number}
            </div>
            <div>
                <p className="text-sm font-semibold text-neutral-100">{title}</p>
                <p className="text-xs text-neutral-400 mt-1">{description}</p>
            </div>
        </div>
    );
}

function ShortcutCard({ keys, desc, Icon }) {
    return (
        <div className="flex items-center gap-4 p-4 rounded-xl bg-neutral-800/40 border border-neutral-700/50 hover:border-blue-500/30 transition-all group">
            <div className="p-2.5 rounded-lg bg-neutral-900/50 text-blue-400 group-hover:scale-110 transition-transform shrink-0">
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex flex-col gap-1 min-w-0">
                <span className="text-sm font-mono font-bold text-blue-400 tracking-tight">{keys}</span>
                <span className="text-xs text-neutral-400 truncate">{desc}</span>
            </div>
        </div>
    );
}

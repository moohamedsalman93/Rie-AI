import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Zap, Stars, Cloud, RefreshCw, Mic, Square, Settings, ChevronRight, ChevronLeft } from 'lucide-react';
import logo from "../assets/logo.png";

export function WelcomeScreen({ onGetStarted }) {
    const [step, setStep] = useState(0);

    const openLink = async (url) => {
        try {
            await openUrl(url);
        } catch (err) {
            console.error("Failed to open link:", err);
        }
    };

    const nextStep = () => setStep(s => s + 1);
    const prevStep = () => setStep(s => s - 1);

    const steps = [
        {
            id: "intro",
            content: (
                <div className="flex flex-col items-center text-center space-y-6">
                    <motion.div
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ duration: 0.5 }}
                        className="relative mb-4"
                    >
                        <div className="absolute inset-0 bg-emerald-500/20 blur-xl rounded-full" />
                        <img src={logo} alt="Rie-AI" className="relative w-32 h-32 object-contain" />
                    </motion.div>

                    <h1 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-blue-500">
                        Welcome to Rie-AI
                    </h1>
                    <p className="text-lg text-neutral-300 max-w-md mx-auto leading-relaxed">
                        Your intelligent floating assistant. <br />
                        <span className="text-neutral-500">Chat, control your PC, and get things done faster.</span>
                    </p>
                </div>
            )
        },
        {
            id: "choice",
            content: (
                <div className="flex flex-col space-y-6 w-full">
                    <div className="text-center space-y-2">
                        <h2 className="text-2xl font-bold text-emerald-400">Choose your Experience</h2>
                        <p className="text-neutral-400 text-sm">
                            Select how you want to power Rie-AI.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 max-w-lg mx-auto">
                        <button
                            onClick={nextStep}
                            className="flex flex-col items-center p-5 rounded-xl bg-emerald-500/5 border border-emerald-500/20 hover:border-emerald-500/50 hover:bg-emerald-500/10 transition-all group text-center"
                        >
                            <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400 mb-3 group-hover:scale-110 transition-transform">
                                <Sparkles className="w-6 h-6" />
                            </div>
                            <span className="text-base font-bold text-neutral-100">Use Rie</span>
                            <span className="text-[11px] text-neutral-400 mt-2 leading-relaxed">
                                Preconfigured & zero setup.<br />
                                <span className="font-semibold text-emerald-400">50 requests / day limit.</span>
                            </span>
                            <div className="mt-4 px-3 py-1 bg-emerald-500 text-white text-[10px] font-bold rounded-full group-hover:bg-emerald-400 transition-colors uppercase tracking-wider">
                                Recommended
                            </div>
                        </button>

                        <button
                            onClick={nextStep}
                            className="flex flex-col items-center p-5 rounded-xl bg-neutral-800/40 border border-neutral-700/50 hover:border-blue-500/30 hover:bg-neutral-800 transition-all group text-center"
                        >
                            <div className="p-3 rounded-xl bg-blue-500/10 text-blue-400 mb-3 group-hover:scale-110 transition-transform">
                                <Settings className="w-6 h-6" />
                            </div>
                            <span className="text-base font-bold text-neutral-100">BYO Keys</span>
                            <span className="text-[11px] text-neutral-400 mt-2 leading-relaxed">
                                Bring your own API keys.<br />
                                Unlimited requests per your limits.
                            </span>
                            <div className="mt-4 px-3 py-1 bg-neutral-700 text-neutral-400 text-[10px] font-bold rounded-full transition-colors uppercase tracking-wider">
                                Advanced
                            </div>
                        </button>
                    </div>
                </div>
            )
        },
        {
            id: "providers",
            content: (
                <div className="flex flex-col space-y-6 w-full">
                    <div className="text-center space-y-2">
                        <h2 className="text-2xl font-bold text-blue-400">Supported Providers</h2>
                        <p className="text-neutral-400 text-sm">
                            Rie-AI works with these top-tier platforms.
                        </p>
                    </div>

                    <div className="grid grid-cols-3 gap-3 mt-4 max-w-lg mx-auto">
                        <ProviderCard
                            title="Groq"
                            desc="Fast & Free"
                            Icon={Zap}
                            color="text-amber-400"
                            onClick={() => openLink('https://console.groq.com/keys')}
                        />
                        <ProviderCard
                            title="Gemini"
                            desc="Google's Best"
                            Icon={Stars}
                            color="text-blue-400"
                            onClick={() => openLink('https://aistudio.google.com/app/apikey')}
                        />
                        <ProviderCard
                            title="OpenAI"
                            desc="Standard"
                            Icon={Cloud}
                            color="text-emerald-400"
                            onClick={() => openLink('https://platform.openai.com/api-keys')}
                        />
                    </div>
                    <p className="text-xs text-center text-neutral-500 mt-4 leading-relaxed">
                        Need help? Click a card to open the provider's dashboard.<br />
                        You can configure these anytime in <span className="text-blue-400 font-medium">Settings</span>.
                    </p>
                </div>
            )
        },
        {
            id: "shortcuts",
            content: (
                <div className="flex flex-col space-y-6 w-full">
                    <div className="text-center space-y-2">
                        <h2 className="text-2xl font-bold text-blue-400">Master Shortcuts</h2>
                        <p className="text-neutral-400 text-sm">
                            Control Rie-AI from anywhere with these system-wide global key combinations.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 gap-2 mt-4 max-w-sm mx-auto">
                        <ShortcutCard
                            keys="Alt + Shift + A"
                            desc="Toggle Between Bubble and Chat"
                            Icon={RefreshCw}
                        />
                        <ShortcutCard
                            keys="Alt + Shift + S"
                            desc="Push to Talk"
                            Icon={Mic}
                        />
                        <ShortcutCard
                            keys="Alt + Shift + C"
                            desc="Stop Response"
                            Icon={Square}
                        />
                    </div>
                </div>
            )
        },
        {
            id: "finish",
            content: (
                <div className="flex flex-col items-center text-center space-y-6">
                    <div className="w-20 h-20 bg-neutral-800 rounded-2xl flex items-center justify-center shadow-xl shadow-blue-500/10 border border-neutral-700">
                        <Settings className="w-8 h-8 text-blue-400" />
                    </div>

                    <div className="space-y-2">
                        <h2 className="text-2xl font-bold text-emerald-400">Ready to Configure</h2>
                        <p className="text-neutral-400 text-sm max-w-xs mx-auto">
                            You're all set! On the next screen, you'll finalize your setup and choose your tools.
                        </p>
                    </div>
                </div>
            )
        }
    ];

    return (
        <div className="absolute inset-0 bg-neutral-900 z-[60] flex flex-col font-sans text-neutral-100 border border-neutral-800 rounded-2xl overflow-hidden">
            {/* Background Ambience */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-emerald-500/10 blur-[100px]" />
                <div className="absolute top-[40%] -right-[10%] w-[50%] h-[50%] rounded-full bg-blue-500/10 blur-[100px]" />
            </div>

            <div className="relative z-10 flex flex-col h-full max-w-xl mx-auto w-full p-6">

                {/* Progress Dots */}
                <div className="flex justify-center gap-2 mb-6 mt-4">
                    {steps.map((_, i) => (
                        <div
                            key={i}
                            className={`h-1 rounded-full transition-all duration-300 ${i === step ? "w-6 bg-emerald-500" : "w-1 bg-neutral-700"
                                }`}
                        />
                    ))}
                </div>

                {/* Main Content Area */}
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

                {/* Navigation Buttons */}
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

function ProviderCard({ title, desc, Icon, color, onClick }) {
    return (
        <button
            onClick={onClick}
            className="flex flex-col items-center p-4 rounded-xl bg-neutral-800/50 border border-neutral-700 hover:border-emerald-500/50 hover:bg-neutral-800 transition-all group h-full"
        >
            <div className={`p-3 rounded-lg bg-neutral-900/50 mb-3 group-hover:scale-110 transition-transform ${color}`}>
                <Icon className="w-6 h-6" />
            </div>
            <span className="font-bold text-neutral-200">{title}</span>
            <span className="text-xs text-neutral-500 mt-1">{desc}</span>
            <span className="text-[10px] text-emerald-400 mt-3 opacity-0 group-hover:opacity-100 transition-opacity uppercase tracking-wider font-semibold">Get Key ↗</span>
        </button>
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

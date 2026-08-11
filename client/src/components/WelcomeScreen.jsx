import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bot,
  Terminal,
  RefreshCw,
  Mic,
  Square,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  Minus,
  X,
  AlertTriangle,
  PlusCircle,
  Camera,
  MicOff,
  Monitor,
  Command,
  ShieldCheck,
  FileText,
  Lock,
  Check,
  BookOpen,
  Network,
  Users,
  Globe,
} from "lucide-react";
import logo from "../assets/logo.png";
import { BetaLabel } from "./BetaLabel";

export function WelcomeScreen({ onGetStarted, onMouseDown, onMinimize, onClose }) {
  const [step, setStep] = useState(0);
  const [hasAgreed, setHasAgreed] = useState(false);
  const [activeLegalTab, setActiveLegalTab] = useState("terms"); // "terms" | "privacy"

  const nextStep = () => setStep((s) => Math.min(s + 1, steps.length - 1));
  const prevStep = () => setStep((s) => Math.max(s - 1, 0));

  const steps = [
    {
      id: "intro",
      title: "Welcome",
      content: (
        <div className="flex flex-col items-center text-center space-y-5 py-2">
          <div className="my-1">
            <img src={logo} alt="Rie-AI" className="w-20 h-20 object-contain" />
          </div>

          <div className="space-y-2">
            <h1 className="flex items-center justify-center gap-2 text-2xl sm:text-3xl font-bold text-white tracking-tight">
              Welcome to Rie-AI
              <BetaLabel className="shrink-0 text-xs font-normal" />
            </h1>
            <p className="text-neutral-400 max-w-md mx-auto text-xs sm:text-sm leading-relaxed">
              An autonomous AI desktop engineer for chat, multi-file coding, and terminal execution.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 w-full max-w-xl pt-2">
            <FeaturePill Icon={Globe} title="CamoFox Browser" desc="Stealth Anti-Detect" />
            <FeaturePill Icon={BookOpen} title="Custom Knowledge" desc="Files &amp; RAG Context" />
            <FeaturePill Icon={Network} title="Planner Agents" desc="Graph Orchestration" />
            <FeaturePill Icon={Users} title="Friends AI" desc="Sub-Agent Personas" />
            <FeaturePill Icon={ShieldCheck} title="Screen Privacy" desc="OS Display Affinity" />
            <FeaturePill Icon={Terminal} title="Terminal Control" desc="Direct Execution" />
          </div>
        </div>
      ),
    },
    {
      id: "flow",
      title: "How It Works",
      content: (
        <div className="flex flex-col space-y-4 w-full">
          <div className="text-center space-y-1">
            <h2 className="text-xl font-bold text-white">How Rie-AI Works</h2>
            <p className="text-neutral-400 text-xs">
              Simple setup flow to get started in seconds.
            </p>
          </div>

          <div className="max-w-lg mx-auto w-full space-y-2.5">
            <FlowCard
              number="1"
              title="Connect AI Provider"
              description="Configure Groq, OpenAI, Vertex AI, or offline local Ollama in Settings."
            />
            <FlowCard
              number="2"
              title="Choose Window Mode"
              description="Switch between Floating mode and Normal workspace mode anytime."
            />
            <FlowCard
              number="3"
              title="Start Desktop Tasks"
              description="Ask questions, execute shell commands, attach screen context, or set reminders."
            />
          </div>
        </div>
      ),
    },
    {
      id: "shortcuts",
      title: "Shortcuts",
      content: (
        <div className="flex flex-col space-y-4 w-full">
          <div className="text-center space-y-1">
            <h2 className="text-xl font-bold text-white">Global Shortcuts</h2>
            <p className="text-neutral-400 text-xs">
              System-wide hotkeys to control Rie-AI from any window.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1 max-w-xl mx-auto text-left w-full">
            <ShortcutCard keys="Alt + Shift + Q" desc="Screen Privacy (Press On / Hold 1s Off)" Icon={ShieldCheck} highlight />
            <ShortcutCard keys="Alt + Shift + A" desc="Toggle Bubble / Window" Icon={RefreshCw} />
            <ShortcutCard keys="Alt + Shift + S" desc="Push to Talk (Hold)" Icon={Mic} />
            <ShortcutCard keys="Alt + Shift + C" desc="Cancel Response" Icon={Square} />
            <ShortcutCard keys="Alt + Shift + N" desc="Start New Chat" Icon={PlusCircle} />
            <ShortcutCard keys="Alt + Shift + V" desc="Screen Capture" Icon={Camera} />
            <ShortcutCard keys="Alt + Shift + M" desc="Toggle Mic / Mute" Icon={MicOff} />
            <ShortcutCard keys="Alt + Shift + K" desc="Toggle Kiosk Mode" Icon={Monitor} />
            <ShortcutCard keys="Alt + Shift + F" desc="Focus Chat Input" Icon={Command} />
          </div>
        </div>
      ),
    },
    {
      id: "legal",
      title: "Terms & Privacy",
      content: (
        <div className="flex flex-col space-y-3.5 w-full">
          <div className="text-center space-y-1">
            <h2 className="text-xl font-bold text-white">Terms &amp; Privacy Agreement</h2>
            <p className="text-neutral-400 text-xs">
              Please review the terms of service and privacy policy before proceeding.
            </p>
          </div>

          {/* Legal Tabs */}
          <div className="flex gap-2 border-b border-neutral-800 pb-1">
            <button
              onClick={() => setActiveLegalTab("terms")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
                activeLegalTab === "terms"
                  ? "bg-neutral-800 text-white border border-neutral-700"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Terms of Service &amp; Liability
            </button>
            <button
              onClick={() => setActiveLegalTab("privacy")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
                activeLegalTab === "privacy"
                  ? "bg-neutral-800 text-white border border-neutral-700"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              Privacy &amp; Security Policy
            </button>
          </div>

          {/* Legal Content Box */}
          <div className="h-44 overflow-y-auto custom-scrollbar p-3.5 rounded-xl bg-neutral-900 border border-neutral-800 text-xs text-neutral-300 space-y-3 text-left leading-relaxed">
            {activeLegalTab === "terms" ? (
              <>
                <div className="p-2.5 rounded-lg bg-neutral-800/80 border border-neutral-700 text-neutral-200 text-[11px] font-medium flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Important:</strong> Rie-AI has terminal and system automation permissions. All actions executed are your sole responsibility.
                  </span>
                </div>
                <p>
                  <strong>1. User Responsibility:</strong> You acknowledge that all commands, scripts, file edits, and actions performed through Rie-AI are executed under your direction and responsibility.
                </p>
                <p>
                  <strong>2. Disclaimer of Liability:</strong> Rie-AI is provided &quot;as-is&quot; without warranties. Developers and contributors accept no liability for data loss, file modifications, or system outcomes resulting from software usage.
                </p>
                <p>
                  <strong>3. Command Verification:</strong> Always verify sensitive terminal commands before confirming execution.
                </p>
              </>
            ) : (
              <>
                <div className="p-2.5 rounded-lg bg-neutral-800/80 border border-neutral-700 text-neutral-200 text-[11px] font-medium flex items-start gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Privacy Commitment:</strong> Rie-AI runs local-first. Credentials and chat history remain on your machine.
                  </span>
                </div>
                <p>
                  <strong>1. Local API Keys:</strong> Your API keys are stored locally on your PC in an isolated SQLite database (%LOCALAPPDATA%\Rie-AI\settings.db).
                </p>
                <p>
                  <strong>2. Screen Privacy:</strong> Toggle Screen Privacy with <code className="text-neutral-200 font-mono">Alt + Shift + Q</code> (Press On / Hold 1s Off) to prevent window capture during video calls or recordings.
                </p>
                <p>
                  <strong>3. No Data Selling:</strong> Personal conversation threads and project files are stored strictly on your local PC.
                </p>
              </>
            )}
          </div>

          {/* Agreement Checkbox */}
          <label className="flex items-center gap-3 p-3 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-neutral-700 transition-all cursor-pointer select-none text-left">
            <div
              className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-all ${
                hasAgreed
                  ? "bg-emerald-600 border-emerald-500 text-white"
                  : "border-neutral-600 bg-neutral-950"
              }`}
            >
              {hasAgreed && <Check className="w-3.5 h-3.5 stroke-[3]" />}
            </div>
            <input
              type="checkbox"
              checked={hasAgreed}
              onChange={(e) => setHasAgreed(e.target.checked)}
              className="sr-only"
            />
            <span className="text-xs text-neutral-300 leading-tight">
              I agree to the <span className="text-white font-semibold">Terms of Service</span> &amp; <span className="text-white font-semibold">Privacy Policy</span>. I accept responsibility for actions executed by Rie-AI.
            </span>
          </label>
        </div>
      ),
    },
    {
      id: "finish",
      title: "Complete",
      content: (
        <div className="flex flex-col items-center text-center space-y-4 py-3">
          <div className="w-16 h-16 bg-neutral-900 rounded-2xl flex items-center justify-center border border-neutral-800">
            <CheckCircle2 className="w-8 h-8 text-emerald-400" />
          </div>

          <div className="space-y-1.5 max-w-sm mx-auto">
            <h2 className="text-xl font-bold text-white">Setup Complete</h2>
            <p className="text-neutral-400 text-xs sm:text-sm leading-relaxed">
              Open chat, pick your model provider in Settings, and start delegating your tasks.
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div
      className="absolute inset-0 bg-neutral-950 z-[60] flex flex-col font-sans text-neutral-100 border border-neutral-800 rounded-2xl overflow-hidden pointer-events-auto select-none"
    >
      {/* Header bar */}
      <div
        onMouseDown={(e) => onMouseDown?.(e)}
        data-tauri-drag-region
        className="relative z-20 h-10 px-4 border-b border-neutral-800 bg-neutral-900 flex items-center justify-between"
      >
        <div className="text-xs font-medium text-neutral-400 tracking-wide">
          Rie-AI Setup Wizard
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

      {/* Main Content Area */}
      <div className="relative z-10 flex flex-col h-full max-w-2xl mx-auto w-full p-5 justify-between">
        {/* Step Indicator */}
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex gap-1.5">
            {steps.map((s, i) => (
              <div
                key={s.id}
                onClick={() => {
                  if (i <= step || hasAgreed || i < 3) setStep(i);
                }}
                className={`h-1.5 rounded-full transition-all duration-200 cursor-pointer ${
                  i === step
                    ? "w-7 bg-white"
                    : i < step
                    ? "w-3 bg-neutral-600"
                    : "w-3 bg-neutral-800"
                }`}
                title={s.title}
              />
            ))}
          </div>
          <span className="text-[11px] font-mono text-neutral-500 uppercase tracking-wider">
            Step {step + 1} of {steps.length}
          </span>
        </div>

        {/* Dynamic Step View */}
        <div className="flex-1 flex items-center justify-center overflow-y-auto custom-scrollbar px-4 py-2 border border-neutral-800 rounded-xl bg-neutral-900/60 min-h-[330px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="w-full"
            >
              {steps[step].content}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Footer Controls */}
        <div className="flex justify-between items-center mt-4 pt-3 border-t border-neutral-800">
          <button
            onClick={prevStep}
            disabled={step === 0}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
              step === 0
                ? "text-neutral-600 cursor-not-allowed opacity-50"
                : "text-neutral-400 hover:text-white hover:bg-neutral-800"
            }`}
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          {step < steps.length - 1 ? (
            <button
              onClick={() => {
                if (step === 3 && !hasAgreed) return;
                nextStep();
              }}
              disabled={step === 3 && !hasAgreed}
              className={`flex items-center gap-2 px-5 py-2 text-xs font-semibold rounded-lg transition-all ${
                step === 3 && !hasAgreed
                  ? "bg-neutral-800 text-neutral-500 cursor-not-allowed opacity-60"
                  : "bg-white hover:bg-neutral-200 text-neutral-950"
              }`}
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => {
                if (!hasAgreed) {
                  setStep(3); // Jump back to Terms step if not checked
                  return;
                }
                onGetStarted?.();
              }}
              className="px-6 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-all flex items-center gap-2"
            >
              Get Started
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FeaturePill({ title, desc, Icon }) {
  return (
    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-neutral-900 border border-neutral-800 text-neutral-200 justify-start">
      <div className="p-1.5 rounded bg-neutral-800 text-neutral-300 shrink-0">
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex flex-col text-left min-w-0">
        <span className="text-xs font-semibold text-neutral-100 truncate">{title}</span>
        <span className="text-[10px] text-neutral-400 truncate">{desc}</span>
      </div>
    </div>
  );
}

function FlowCard({ number, title, description }) {
  return (
    <div className="rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-3 flex items-start gap-3 text-left">
      <div className="w-5 h-5 rounded bg-neutral-800 text-neutral-300 text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5">
        {number}
      </div>
      <div>
        <p className="text-xs font-semibold text-neutral-100">{title}</p>
        <p className="text-[11px] text-neutral-400 mt-0.5 leading-snug">{description}</p>
      </div>
    </div>
  );
}

function ShortcutCard({ keys, desc, Icon, highlight }) {
  return (
    <div
      className={`flex items-center gap-2.5 p-2 rounded-lg border transition-all ${
        highlight
          ? "bg-neutral-900 border-neutral-700 text-neutral-200"
          : "bg-neutral-900/60 border-neutral-800 text-neutral-300"
      }`}
    >
      <div className="p-1.5 rounded bg-neutral-800 text-neutral-300 shrink-0">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-[11px] font-mono font-semibold tracking-tight text-white">{keys}</span>
        <span className="text-[10px] text-neutral-400 truncate">{desc}</span>
      </div>
    </div>
  );
}

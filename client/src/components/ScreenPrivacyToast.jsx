import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";

export function ScreenPrivacyToast({ toast, windowMode, isOpen, onDismiss }) {
  useEffect(() => {
    if (!toast?.show) return;
    const timer = setTimeout(() => {
      onDismiss?.();
    }, 2400);
    return () => clearTimeout(timer);
  }, [toast?.id, toast?.show, onDismiss]);

  // In Bubble Mode (!isOpen && windowMode === "floating"), FloatingBubble handles rendering the toast inside the bubble pill!
  if (!toast?.show || (!isOpen && windowMode === "floating")) return null;

  const isEnabled = toast.type === "enabled";
  const isHoldHint = toast.type === "hold_hint";

  return (
    <AnimatePresence>
      {toast?.show && (
        <motion.div
          key={toast.id || "privacy-toast"}
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -15, scale: 0.95 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="fixed top-4 inset-x-0 flex justify-center z-[99999] pointer-events-none"
        >
          <div
            className={`flex items-center gap-2.5 px-3.5 py-2 rounded-full border shadow-xl backdrop-blur-md text-xs font-semibold tracking-wide transition-all ${
              isEnabled
                ? "bg-neutral-900/95 border-emerald-500/40 text-emerald-300 shadow-emerald-950/30"
                : isHoldHint
                ? "bg-neutral-900/95 border-amber-500/40 text-amber-300 shadow-amber-950/30"
                : "bg-neutral-900/95 border-red-500/40 text-red-300 shadow-red-950/30"
            }`}
          >
            {isEnabled ? (
              <ShieldCheck size={16} className="text-emerald-400 shrink-0" />
            ) : isHoldHint ? (
              <ShieldAlert size={16} className="text-amber-400 shrink-0" />
            ) : (
              <ShieldOff size={16} className="text-red-400 shrink-0" />
            )}

            <span>
              {isEnabled
                ? "Screen Privacy Enabled"
                : isHoldHint
                ? "Hold Alt+Shift+Q (1s) to Disable"
                : "Screen Privacy Disabled"}
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

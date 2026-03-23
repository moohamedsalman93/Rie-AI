import { motion } from "framer-motion";
import logo from "../assets/logo.png";

export function FloatingBubble({
  currentTool,
  isLoading,
  isRecording,
  hasPendingAction, // Added prop
  isSnapping,
  onMouseDown,
  getToolDisplayName,
  bubbleRef,
}) {
  return (
    <motion.button
      key="bubble"
      initial={{ opacity: 0, scale: 0.5, rotate: -10 }}
      animate={
        currentTool || isLoading || isRecording || hasPendingAction
          ? {
            opacity: 1,
            scale: [1, 1.04, 1],
            rotate: 0,
            boxShadow: hasPendingAction
              ? [
                "0 0 0px rgba(245,158,11,0.0)",
                "0 0 25px rgba(245,158,11,0.45)",
                "0 0 0px rgba(245,158,11,0.0)"
              ]
              : [
                "0 0 0px rgba(16,185,129,0.0)",
                "0 0 25px rgba(16,185,129,0.45)",
                "0 0 0px rgba(16,185,129,0.0)"
              ],
            borderColor: hasPendingAction
              ? ["rgba(82,82,82,0.5)", "rgba(245,158,11,0.8)", "rgba(82,82,82,0.5)"]
              : ["rgba(82,82,82,0.5)", "rgba(16,185,129,0.8)", "rgba(82,82,82,0.5)"]
          }
          : { opacity: 1, scale: 1, rotate: 0, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", borderColor: "rgba(82,82,82,0.5)" }
      }
      exit={{ opacity: 0, scale: 0.5, rotate: 10, transition: { duration: 0.2 } }}
      transition={
        currentTool || isLoading || isRecording || hasPendingAction
          ? {
            boxShadow: { duration: 2, repeat: Infinity, ease: "easeInOut" },
            borderColor: { duration: 2, repeat: Infinity, ease: "easeInOut" },
            scale: { duration: 1.5, repeat: Infinity, ease: "easeInOut" },
            opacity: { duration: 0.3 }
          }
          : { type: "spring", stiffness: 260, damping: 20 }
      }
      onMouseDown={onMouseDown}
      ref={bubbleRef}
      className={`pointer-events-auto flex cursor-move items-center gap-2 rounded-full bg-neutral-800/90 backdrop-blur-md hover:bg-neutral-700 px-4 py-2 shadow-xl m-2 border transition-colors ${isSnapping ? "pointer-events-none opacity-80" : ""}`}
    >
      <div className="relative flex items-center justify-center">
        <img src={logo} alt="Rie-AI" className="h-6 w-6 object-contain z-10" />
        {(currentTool || isLoading || isRecording || hasPendingAction) && (
          <motion.div
            className={`absolute inset-0 rounded-full blur-md ${hasPendingAction ? "bg-amber-500/20" : "bg-emerald-500/20"}`}
            animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0.6, 0.3] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
        )}
      </div>
      <span className="text-sm font-medium text-neutral-100 flex items-center gap-1.5 min-w-0 overflow-hidden">
        {isRecording ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="text-emerald-500 font-bold text-[10px] uppercase tracking-wider">Live</span>
          </>
        ) : hasPendingAction ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <span className="truncate text-amber-500">Wait...</span>
          </>
        ) : currentTool ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="truncate">{getToolDisplayName(currentTool)}</span>
          </>
        ) : isLoading ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <span className="truncate">Thinking...</span>
          </>
        ) : "Rie-AI"}
      </span>
    </motion.button>
  );
}

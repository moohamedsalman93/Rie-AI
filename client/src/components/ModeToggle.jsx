import { motion } from "framer-motion";

export function ModeToggle({ chatMode, setChatMode, speedMode, setSpeedMode }) {
  return (
    <div className="flex items-center gap-1.5">
      {/* Agent / Chat Toggle */}
      <div className="relative flex items-center h-7 w-[89px] rounded-lg bg-neutral-800 border border-neutral-700/50 p-0.5 select-none">
        <motion.div
          className="absolute h-6 rounded-md"
          animate={{
            x: chatMode === "agent" ? 2 : "calc(100% + 3px)",
            width:"48%",
            backgroundColor: chatMode === "agent" ? "rgba(16, 185, 129, 0.2)" : "rgba(59, 130, 246, 0.2)",
          }}
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
          style={{ left: 0 }}
        />
        <button
          onClick={() => setChatMode("agent")}
          className={`relative z-10  w-[50%] rounded-md text-[10px] font-semibold transition-colors tracking-wide  ${
            chatMode === "agent"
              ? "text-emerald-400"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          Agent
        </button>
        <button
          onClick={() => setChatMode("chat")}
          className={`relative z-10 w-[50%] rounded-md text-[10px] font-semibold transition-colors tracking-wide  ${
            chatMode === "chat"
              ? "text-blue-400"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          Chat
        </button>
      </div>

      {/* Thinking / Flash Toggle */}
      <div className="relative w-[55px] flex items-center h-7 rounded-lg bg-neutral-800 border border-neutral-700/50 p-0.5 select-none">
        <motion.div
          className="absolute h-6 rounded-md"
          animate={{
            x: speedMode === "thinking" ? 2 : "calc(100% + 4px)",
            width:  24,
            backgroundColor: speedMode === "thinking" ? "rgba(168, 85, 247, 0.2)" : "rgba(251, 191, 36, 0.2)",
          }}
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
          style={{ left: 0 }}
        />
        <button
          onClick={() => setSpeedMode("thinking")}
          className={`relative z-10 w-[50%] rounded-md text-[10px] transition-colors ${
            speedMode === "thinking"
              ? "text-purple-400"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          title="Thinking mode (with planning)"
        >
          🧠
        </button>
        <button
          onClick={() => setSpeedMode("flash")}
          className={`relative z-10 w-[50%] rounded-md text-[10px] transition-colors ${
            speedMode === "flash"
              ? "text-amber-400"
              : "text-neutral-500 hover:text-neutral-300"
          }`}
          title="Flash mode (no planning)"
        >
          ⚡
        </button>
      </div>
    </div>
  );
}

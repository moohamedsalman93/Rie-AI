import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Bot, Code2, MessageSquare, ChevronDown, Check } from "lucide-react";

const MODES = [
  {
    id: "agent",
    label: "Agent",
    icon: Bot,
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/20",
  },
  {
    id: "coding",
    label: "Code",
    icon: Code2,
    color: "text-violet-400",
    bg: "bg-violet-500/10",
    border: "border-violet-500/20",
  },
  {
    id: "chat",
    label: "Chat",
    icon: MessageSquare,
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    border: "border-blue-500/20",
  },
];

export function ModeToggle({ chatMode, setChatMode, speedMode, setSpeedMode, provider }) {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState("top");
  const [alignRight, setAlignRight] = useState(false);

  const containerRef = useRef(null);

  const isRie = !provider || provider === "rie";
  const effectiveModeId = isRie
    ? "chat"
    : chatMode === "coding"
    ? "coding"
    : chatMode === "chat"
    ? "chat"
    : "agent";
  const activeMode = MODES.find((m) => m.id === effectiveModeId) || MODES[0];
  const ActiveIcon = activeMode.icon;

  const updatePosition = useCallback(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;

      setPlacement(spaceBelow < 170 && spaceAbove > spaceBelow ? "top" : "bottom");

      const spaceRight = window.innerWidth - rect.left;
      setAlignRight(spaceRight < 180);
    }
  }, []);

  const handleToggle = (e) => {
    e.stopPropagation();
    setIsOpen((prev) => {
      if (!prev) {
        updatePosition();
      }
      return !prev;
    });
  };

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target) &&
        (!event.composedPath || !event.composedPath().includes(containerRef.current))
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleSelectMode = (modeId) => {
    if (isRie && modeId !== "chat") return;
    setChatMode?.(modeId);
    setIsOpen(false);
  };

  return (
    <div className="flex items-center gap-1.5 select-none">
      {/* Mode Dropdown Selector */}
      <div className="relative inline-block" ref={containerRef}>
        <button
          type="button"
          onClick={handleToggle}
          onMouseDown={(e) => e.stopPropagation()}
          className={`flex items-center gap-1.5 h-7 rounded-lg border px-2.5 text-[11px] font-medium transition-all shadow-sm shrink-0 outline-none cursor-pointer ${
            isOpen
              ? "bg-neutral-800 text-white border-neutral-600 ring-1 ring-white/10"
              : "bg-neutral-800/80 hover:bg-neutral-800 text-neutral-300 hover:text-white border-neutral-700/60"
          }`}
          title={`Mode: ${activeMode.label}`}
          aria-label={`Current Mode: ${activeMode.label}`}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        >
          <ActiveIcon size={12} className={`shrink-0 pointer-events-none ${activeMode.color}`} />
          <span className="tracking-tight text-[11px] font-medium pointer-events-none">
            {activeMode.label}
          </span>
          <ChevronDown
            size={11}
            className={`text-neutral-400 shrink-0 transition-transform duration-200 pointer-events-none ${
              isOpen ? "rotate-180 text-neutral-200" : ""
            }`}
          />
        </button>

        {/* Dropdown Menu Popover */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              initial={{
                opacity: 0,
                y: placement === "top" ? 2 : -2,
              }}
              animate={{ opacity: 1, y: 0 }}
              exit={{
                opacity: 0,
                y: placement === "top" ? 2 : -2,
              }}
              transition={{
                duration: 0.1,
                ease: "easeOut",
              }}
              className={`absolute z-50 w-36 rounded-xl border border-neutral-700/80 bg-neutral-900/95 p-1 shadow-2xl backdrop-blur-xl ${
                placement === "top" ? "bottom-full mb-2" : "top-full mt-2"
              } ${alignRight ? "right-0 origin-bottom-right" : "left-0 origin-bottom-left"}`}
            >
              <div className="flex flex-col gap-0.5" role="listbox">
                {MODES.map((m) => {
                  const isSelected = effectiveModeId === m.id;
                  const isDisabled = isRie && m.id !== "chat";
                  const Icon = m.icon;

                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={isDisabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSelectMode(m.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      className={`group relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-all cursor-pointer ${
                        isSelected
                          ? "bg-neutral-800 text-white shadow-sm ring-1 ring-white/10"
                          : isDisabled
                          ? "opacity-40 cursor-not-allowed text-neutral-500"
                          : "text-neutral-300 hover:bg-neutral-800/60 hover:text-white"
                      }`}
                      title={isDisabled ? "Disabled for Rie provider" : m.label}
                    >
                      <Icon
                        size={13}
                        className={`shrink-0 pointer-events-none ${
                          isSelected ? m.color : "text-neutral-400 group-hover:text-neutral-200"
                        }`}
                      />
                      <span
                        className={`text-[11px] font-medium leading-none flex-1 pointer-events-none ${
                          isSelected ? m.color : ""
                        }`}
                      >
                        {m.label}
                      </span>
                      {isSelected && (
                        <Check size={12} className={`shrink-0 pointer-events-none ${m.color}`} />
                      )}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Thinking / Flash Speed Toggle */}
      {setSpeedMode && (
        <div className="relative w-[55px] flex items-center h-7 rounded-lg bg-neutral-800 border border-neutral-700/50 p-0.5 select-none shrink-0">
          <motion.div
            className="absolute h-6 rounded-md"
            animate={{
              x: speedMode === "thinking" ? 2 : 27,
              width: 24,
              backgroundColor:
                speedMode === "thinking"
                  ? "rgba(168, 85, 247, 0.2)"
                  : "rgba(251, 191, 36, 0.2)",
            }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            style={{ left: 0 }}
          />
          <button
            type="button"
            onClick={() => setSpeedMode("thinking")}
            className={`relative z-10 w-[50%] rounded-md text-[10px] transition-colors flex items-center justify-center cursor-pointer ${
              speedMode === "thinking"
                ? "text-purple-400"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            title="Thinking mode (with planning)"
          >
            🧠
          </button>
          <button
            type="button"
            onClick={() => setSpeedMode("flash")}
            className={`relative z-10 w-[50%] rounded-md text-[10px] transition-colors flex items-center justify-center cursor-pointer ${
              speedMode === "flash"
                ? "text-amber-400"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
            title="Flash mode (no planning)"
          >
            ⚡
          </button>
        </div>
      )}
    </div>
  );
}

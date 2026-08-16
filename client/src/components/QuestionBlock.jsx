import React, { useState, useMemo, memo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, HelpCircle, Send, SkipForward, PenLine, CheckCircle2, ChevronRight } from "lucide-react";
import { formatAnswersForAgent, formatSkipForAgent } from "../utils/questionNormalizer";

function QuestionBlockImpl({ block, onAnswer, disabled = false }) {
  const data = block?.data;
  const questions = useMemo(() => data?.questions || [], [data]);

  // Initial answer state from block (if already answered in history)
  const initialAnswered = Boolean(block?.isAnswered || block?.submittedAnswers);
  const [isAnswered, setIsAnswered] = useState(initialAnswered);
  const [submittedText, setSubmittedText] = useState(block?.submittedText || "");

  // Local selection state per question: { [qId]: { selected: string[], custom: string } }
  const [answers, setAnswers] = useState(() => {
    if (block?.submittedAnswers) {
      return block.submittedAnswers;
    }
    const initial = {};
    questions.forEach((q) => {
      initial[q.id] = { selected: [], custom: "" };
    });
    return initial;
  });

  // Toggle or set selected option
  const handleToggleOption = useCallback((qId, option, isMulti) => {
    if (isAnswered || disabled) return;
    setAnswers((prev) => {
      const curr = prev[qId] || { selected: [], custom: "" };
      let newSelected;
      if (isMulti) {
        if (curr.selected.includes(option)) {
          newSelected = curr.selected.filter((item) => item !== option);
        } else {
          newSelected = [...curr.selected, option];
        }
      } else {
        // Single select: click again to toggle off or switch
        newSelected = curr.selected.includes(option) ? [] : [option];
      }
      return {
        ...prev,
        [qId]: { ...curr, selected: newSelected },
      };
    });
  }, [isAnswered, disabled]);

  // Update custom write-in text
  const handleCustomChange = useCallback((qId, text) => {
    if (isAnswered || disabled) return;
    setAnswers((prev) => {
      const curr = prev[qId] || { selected: [], custom: "" };
      return {
        ...prev,
        [qId]: { ...curr, custom: text },
      };
    });
  }, [isAnswered, disabled]);

  // Check if at least one question has an answer or custom input
  const hasValidInput = useMemo(() => {
    return questions.some((q) => {
      const a = answers[q.id];
      if (!a) return false;
      return (a.selected && a.selected.length > 0) || (a.custom && a.custom.trim().length > 0);
    });
  }, [questions, answers]);

  // Handle final submission
  const handleSubmit = useCallback(() => {
    if (isAnswered || disabled || !hasValidInput) return;
    const formatted = formatAnswersForAgent(questions, answers);
    setIsAnswered(true);
    setSubmittedText(formatted);
    onAnswer?.(formatted, answers);
  }, [isAnswered, disabled, hasValidInput, questions, answers, onAnswer]);

  // Handle skip
  const handleSkip = useCallback(() => {
    if (isAnswered || disabled) return;
    const skipText = formatSkipForAgent(questions);
    setIsAnswered(true);
    setSubmittedText(skipText);
    onAnswer?.(skipText, { skipped: true });
  }, [isAnswered, disabled, questions, onAnswer]);

  // Quick direct submission for single-select question on option click
  const handleQuickSingleSelect = useCallback((qId, option) => {
    if (isAnswered || disabled) return;
    if (questions.length === 1 && !questions[0].is_multi_select) {
      const quickAnswers = { [qId]: { selected: [option], custom: "" } };
      const formatted = option;
      setIsAnswered(true);
      setSubmittedText(formatted);
      onAnswer?.(formatted, quickAnswers);
    } else {
      handleToggleOption(qId, option, false);
    }
  }, [isAnswered, disabled, questions, handleToggleOption, onAnswer]);

  if (!questions || questions.length === 0) return null;

  // Render Compact Answered State
  if (isAnswered) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 2 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full my-2 rounded-xl border border-emerald-500/30 bg-emerald-950/20 px-3.5 py-2.5 shadow-sm backdrop-blur-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
              {data?.header || "Clarification Response"}
            </span>
          </div>
          <span className="text-[10px] text-neutral-400 font-medium">Answered</span>
        </div>
        <div className="mt-1.5 text-xs text-neutral-200 whitespace-pre-wrap font-mono leading-relaxed bg-black/30 rounded-lg p-2 border border-emerald-500/10">
          {submittedText || "Response submitted"}
        </div>
      </motion.div>
    );
  }

  // Render Interactive State
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="w-full my-3 rounded-2xl border border-neutral-700/70 bg-gradient-to-b from-neutral-900/95 to-neutral-950/95 p-4 shadow-2xl backdrop-blur-md"
    >
      {/* Header bar */}
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-neutral-800/80">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-400 shrink-0">
            <HelpCircle size={14} />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-semibold text-neutral-200 truncate">
              {data?.header || (questions.length > 1 ? "Please answer the following questions" : "Clarification Needed")}
            </span>
            <span className="text-[10px] text-neutral-400">
              {questions.length > 1 ? `${questions.length} questions • Select or enter details below` : "Choose an option or type a response"}
            </span>
          </div>
        </div>
        <button
          onClick={handleSkip}
          disabled={disabled}
          className="px-2.5 py-1 text-[11px] font-medium text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60 rounded-lg transition-colors flex items-center gap-1 shrink-0"
          title="Skip answering"
        >
          <SkipForward size={12} />
          <span>Skip</span>
        </button>
      </div>

      {/* Questions list */}
      <div className="space-y-4">
        {questions.map((q, qIdx) => {
          const qAnswers = answers[q.id] || { selected: [], custom: "" };
          const isMulti = Boolean(q.is_multi_select);

          return (
            <div key={q.id || qIdx} className="flex flex-col gap-2">
              {/* Question label */}
              <div className="flex items-start gap-2">
                {questions.length > 1 && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-bold text-neutral-300 border border-neutral-700">
                    {qIdx + 1}
                  </span>
                )}
                <p className="text-xs font-medium text-neutral-100 leading-snug">
                  {q.question}
                  {isMulti && (
                    <span className="ml-1.5 text-[10px] font-normal text-neutral-400">(Select multiple)</span>
                  )}
                </p>
              </div>

              {/* Option cards */}
              {q.options && q.options.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                  {q.options.map((opt, optIdx) => {
                    const isSelected = qAnswers.selected.includes(opt);

                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => {
                          if (questions.length === 1 && !isMulti) {
                            handleQuickSingleSelect(q.id, opt);
                          } else {
                            handleToggleOption(q.id, opt, isMulti);
                          }
                        }}
                        disabled={disabled}
                        className={`group relative flex items-center gap-2.5 rounded-xl border p-2.5 text-left text-xs transition-all duration-150 ${
                          isSelected
                            ? "bg-blue-600/20 border-blue-500/80 text-white shadow-sm ring-1 ring-blue-500/40"
                            : "bg-neutral-800/60 border-neutral-700/50 text-neutral-300 hover:bg-neutral-800 hover:border-neutral-600/80 hover:text-white"
                        }`}
                      >
                        <div
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold transition-colors ${
                            isSelected
                              ? "bg-blue-500 border-blue-400 text-white"
                              : "bg-neutral-900/80 border-neutral-700 text-neutral-400 group-hover:border-neutral-500"
                          }`}
                        >
                          {isMulti ? (
                            isSelected ? <Check size={12} strokeWidth={3} /> : null
                          ) : (
                            <span>{optIdx + 1}</span>
                          )}
                        </div>
                        <span className="flex-1 min-w-0 break-words leading-tight">{opt}</span>
                        {isSelected && !isMulti && (
                          <ChevronRight size={13} className="text-blue-400 shrink-0 opacity-80" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Custom write-in input */}
              {q.allow_custom && (
                <div className="mt-1">
                  <div className="relative flex items-center">
                    <PenLine size={13} className="absolute left-3 text-neutral-400 pointer-events-none" />
                    <input
                      type="text"
                      value={qAnswers.custom || ""}
                      onChange={(e) => handleCustomChange(q.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmit();
                        }
                      }}
                      placeholder={q.placeholder || (q.options?.length ? "Or type custom response..." : "Type your answer here...")}
                      disabled={disabled}
                      className="w-full rounded-xl bg-neutral-950/80 border border-neutral-800 pl-8 pr-3 py-2 text-xs text-neutral-200 placeholder-neutral-500 focus:border-blue-500/60 focus:bg-neutral-900 focus:outline-none transition-colors"
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer controls for multi-question or non-instant submission */}
      <div className="mt-4 pt-3 border-t border-neutral-800/80 flex items-center justify-between gap-2">
        <span className="text-[10px] text-neutral-500">
          Or reply directly in chat below
        </span>
        <button
          onClick={handleSubmit}
          disabled={disabled || !hasValidInput}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-semibold shadow-lg transition-all ${
            hasValidInput && !disabled
              ? "bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20 active:scale-95"
              : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
          }`}
        >
          <span>Submit {questions.length > 1 ? "Answers" : "Choice"}</span>
          <Send size={12} />
        </button>
      </div>
    </motion.div>
  );
}

export const QuestionBlock = memo(QuestionBlockImpl);
QuestionBlock.displayName = "QuestionBlock";

import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Lock } from 'lucide-react';

const dismissIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const dismissIconCompact = (
  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export function KnowledgeAttachmentChips({ attachedKnowledge = [], onDetach, variant = 'default' }) {
  if (!attachedKnowledge.length) return null;

  const isCompact = variant === 'compact';

  return (
    <AnimatePresence>
      {attachedKnowledge.map((k) => (
        <motion.div
          key={k.id}
          initial={{ opacity: 0, scale: 0.9, y: isCompact ? 0 : 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: isCompact ? 0 : 10 }}
          className={isCompact ? 'self-start' : 'relative self-start'}
        >
          {isCompact ? (
            <div className="flex items-center gap-2 rounded-lg bg-violet-500/10 border border-violet-500/20 px-2 py-1">
              {k.locked ? (
                <Lock size={12} className="text-violet-400 shrink-0" />
              ) : (
                <BookOpen size={12} className="text-violet-400 shrink-0" />
              )}
              <span className="text-xs text-violet-400 max-w-[120px] truncate">@{k.name}</span>
              {!k.locked && onDetach ? (
                <button type="button" onClick={() => onDetach(k.id)} className="text-violet-400/60 hover:text-violet-400">
                  {dismissIconCompact}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg bg-violet-500/20 border border-violet-500/30 px-2.5 py-1.5 backdrop-blur-md">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-violet-500/20 text-violet-400">
                {k.locked ? <Lock size={11} /> : <BookOpen size={12} />}
              </div>
              <span className="text-xs font-semibold text-violet-400 max-w-[120px] truncate">@{k.name}</span>
              {!k.locked && onDetach ? (
                <button
                  type="button"
                  onClick={() => onDetach(k.id)}
                  className="ml-1 rounded-full p-0.5 text-violet-400/60 hover:bg-violet-500/20 hover:text-violet-400 transition-colors"
                >
                  {dismissIcon}
                </button>
              ) : (
                <span className="w-[18px] shrink-0" aria-hidden />
              )}
            </div>
          )}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

export function KnowledgeHistoryBadge({ knowledgeNames = [] }) {
  if (!knowledgeNames?.length) return null;
  const first = knowledgeNames[0];
  const extra = knowledgeNames.length - 1;
  const label = extra > 0 ? `${first} +${extra}` : first;
  const title = knowledgeNames.join(', ');

  return (
    <span
      title={title}
      className="rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[9px] uppercase text-violet-300 shrink-0 max-w-[100px] truncate"
    >
      {label}
    </span>
  );
}

export function KnowledgeChatBanner({ attachedKnowledge = [] }) {
  const locked = attachedKnowledge.filter((k) => k.locked);
  if (!locked.length) return null;
  const names = locked.map((k) => k.name).join(', ');

  return (
    <div className="rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-xs text-violet-100">
      <div className="font-semibold">Knowledge: {names}</div>
      <div className="text-violet-200/80">Custom knowledge is active for this chat and cannot be removed.</div>
    </div>
  );
}

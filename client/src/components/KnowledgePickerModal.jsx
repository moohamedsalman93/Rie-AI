import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, X, Loader2 } from 'lucide-react';
import { listKnowledge } from '../services/knowledgeApi';

function KnowledgePickerContent({ packs, loading, error, attachedIds, onSelect, onClose, showHeader = true }) {
  return (
    <>
      {showHeader && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <h3 className="text-xs font-semibold text-neutral-100">Attach Knowledge</h3>
          <button type="button" onClick={onClose} className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800">
            <X size={14} />
          </button>
        </div>
      )}
      <div className="max-h-52 overflow-y-auto p-1.5 custom-scrollbar">
        {loading && (
          <div className="flex items-center justify-center py-8 text-neutral-500 gap-2 text-xs">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}
        {error && <p className="text-xs text-red-400 px-2 py-3">{error}</p>}
        {!loading && !error && packs.length === 0 && (
          <p className="text-xs text-neutral-500 text-center py-8 px-2">No packs yet. Create one in Settings → Memory.</p>
        )}
        {!loading && packs.map((pack) => {
          const attached = attachedIds.includes(pack.id);
          return (
            <button
              key={pack.id}
              type="button"
              disabled={attached}
              onClick={() => {
                onSelect({ id: pack.id, name: pack.name });
                onClose();
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-all ${
                attached
                  ? 'opacity-50 cursor-not-allowed bg-neutral-800/30'
                  : 'hover:bg-violet-500/10 text-neutral-300 hover:text-white'
              }`}
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
                <BookOpen size={14} />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-neutral-100 truncate">{pack.name}</div>
                <div className="text-[10px] text-neutral-500">
                  {pack.asset_count || 0} file{(pack.asset_count || 0) !== 1 ? 's' : ''}
                  {attached ? ' · attached' : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function KnowledgePickerModal({
  isOpen,
  onClose,
  onSelect,
  attachedIds = [],
  variant = 'modal',
}) {
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    listKnowledge()
      .then((rows) => setPacks(rows || []))
      .catch((e) => setError(e.message || 'Failed to load knowledge'))
      .finally(() => setLoading(false));
  }, [isOpen]);

  if (!isOpen) return null;

  if (variant === 'popover') {
    return (
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -6 }}
          className="absolute bottom-full left-0 mb-2 w-56 origin-bottom-left rounded-2xl border border-white/10 bg-neutral-800/95 shadow-2xl backdrop-blur-xl z-[100] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <KnowledgePickerContent
            packs={packs}
            loading={loading}
            error={error}
            attachedIds={attachedIds}
            onSelect={onSelect}
            onClose={onClose}
          />
        </motion.div>
      </AnimatePresence>
    );
  }

  const modalNode = (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 8 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <h3 className="text-sm font-semibold text-neutral-100">Attach Knowledge</h3>
            <button type="button" onClick={onClose} className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800">
              <X size={16} />
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto p-2 custom-scrollbar">
            <KnowledgePickerContent
              packs={packs}
              loading={loading}
              error={error}
              attachedIds={attachedIds}
              onSelect={onSelect}
              onClose={onClose}
              showHeader={false}
            />
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );

  return typeof document !== 'undefined' ? createPortal(modalNode, document.body) : null;
}

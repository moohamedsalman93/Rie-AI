import { motion, AnimatePresence } from 'framer-motion';

export function ConfirmationModal({
    isOpen,
    onClose,
    onConfirm,
    title = "Are you sure?",
    message = "This action cannot be undone.",
    confirmText = "Delete",
    cancelText = "Cancel",
    type = "danger" // 'danger', 'warning', 'info'
}) {
    const isDanger = type === 'danger';

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                    />

                    {/* Modal */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 20 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 20 }}
                        transition={{ type: "spring", damping: 25, stiffness: 300 }}
                        className="relative w-full max-w-[240px] bg-neutral-900/95 border border-neutral-800 rounded-xl shadow-2xl overflow-hidden backdrop-blur-xl"
                    >
                        <div className="p-4">
                            {/* Icon / Header */}
                            <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${isDanger ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500'
                                }`}>
                                {isDanger ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 6h18"></path>
                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                                    </svg>
                                ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                                        <line x1="12" y1="9" x2="12" y2="13"></line>
                                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                                    </svg>
                                )}
                            </div>

                            <h3 className="text-sm font-semibold text-neutral-100 mb-1">{title}</h3>
                            <p className="text-xs text-neutral-500 leading-relaxed mb-4">
                                {message}
                            </p>

                            <div className="flex gap-2">
                                <button
                                    onClick={onClose}
                                    className="flex-1 px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-400 text-xs font-medium border border-neutral-700 transition-all"
                                >
                                    {cancelText}
                                </button>
                                <button
                                    onClick={() => {
                                        onConfirm();
                                        onClose();
                                    }}
                                    className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all ${isDanger
                                        ? 'bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20'
                                        : 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20'
                                        }`}
                                >
                                    {confirmText}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}

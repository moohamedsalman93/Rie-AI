import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Trash2, AlertTriangle, Info, X } from 'lucide-react';

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
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!isOpen) return;
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const isDanger = type === 'danger';
    const isWarning = type === 'warning';

    const getThemeConfig = () => {
        if (isDanger) {
            return {
                iconBg: 'bg-red-500/10 text-red-400 border border-red-500/20',
                IconComponent: Trash2,
                confirmBtn: 'bg-red-600 hover:bg-red-500 text-white',
            };
        }
        if (isWarning) {
            return {
                iconBg: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                IconComponent: AlertTriangle,
                confirmBtn: 'bg-amber-600 hover:bg-amber-500 text-white',
            };
        }
        return {
            iconBg: 'bg-neutral-800 text-neutral-200 border border-neutral-700/60',
            IconComponent: Info,
            confirmBtn: 'bg-neutral-100 hover:bg-white text-neutral-900',
        };
    };

    const config = getThemeConfig();
    const Icon = config.IconComponent;

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
                        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
                    />

                    {/* Modal Box */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.96, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 10 }}
                        transition={{ duration: 0.15, ease: "easeOut" }}
                        className="relative w-full max-w-[340px] bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl p-5 overflow-hidden"
                    >
                        {/* Close button */}
                        <button
                            type="button"
                            onClick={onClose}
                            className="absolute top-4 right-4 p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                        >
                            <X size={15} />
                        </button>

                        <div className="flex flex-col gap-4">
                            {/* Header Icon & Text */}
                            <div className="flex items-start gap-3.5">
                                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${config.iconBg}`}>
                                    <Icon size={18} />
                                </div>
                                <div className="flex-1 pr-4">
                                    <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
                                    <p className="text-xs text-neutral-400 leading-relaxed mt-1">
                                        {message}
                                    </p>
                                </div>
                            </div>

                            {/* Buttons */}
                            <div className="flex items-center gap-2.5 mt-1">
                                <button
                                    type="button"
                                    onClick={onClose}
                                    className="flex-1 px-3.5 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700/80 text-neutral-300 text-xs font-medium border border-neutral-700/50 transition-colors cursor-pointer"
                                >
                                    {cancelText}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        onConfirm();
                                        onClose();
                                    }}
                                    className={`flex-1 px-3.5 py-2 rounded-xl text-xs font-medium transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${config.confirmBtn}`}
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



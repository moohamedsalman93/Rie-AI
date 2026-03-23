import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { installAppUpdate } from "../services/updater";

export function UpdateNotification({ update, onClose }) {
    const [status, setStatus] = useState("available"); // available, downloading, installed, error
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState(null);

    const handleUpdate = async () => {
        try {
            setStatus("downloading");
            await installAppUpdate(update, (downloaded, total) => {
                const percent = total ? Math.round((downloaded / total) * 100) : 0;
                setProgress(percent);
            });
            setStatus("installed");
        } catch (err) {
            console.error("Update failed:", err);
            setError(err.message || "Failed to download update");
            setStatus("error");
        }
    };

    return (
        <div className="absolute inset-0 flex items-center justify-center z-[100] px-6">
            <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="w-full max-w-[260px] bg-neutral-900/95 backdrop-blur-xl border border-neutral-800 rounded-xl p-4 shadow-2xl relative overflow-hidden"
            >
                {/* Background Gradient Glow */}
                <div className="absolute -top-16 -left-16 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />

                <div className="relative z-10 flex flex-col items-center text-center">
                    <div className="w-10 h-10 bg-emerald-500/10 rounded-lg flex items-center justify-center mb-3 border border-emerald-500/20">
                        <svg
                            className="w-5 h-5 text-emerald-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                            />
                        </svg>
                    </div>

                    <h3 className="text-base font-medium text-neutral-100 mb-1">Update Available</h3>
                    <p className="text-xs text-neutral-500 mb-4">
                        v{update.version} is ready to install
                    </p>

                    {status === "available" && (
                        <div className="flex w-full gap-2">
                            <button
                                onClick={onClose}
                                className="flex-1 py-2 px-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 text-xs font-medium rounded-lg border border-neutral-700 transition-all active:scale-95"
                            >
                                Later
                            </button>
                            <button
                                onClick={handleUpdate}
                                className="flex-1 py-2 px-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium rounded-lg border border-emerald-500/20 transition-all active:scale-95"
                            >
                                Update
                            </button>
                        </div>
                    )}

                    {status === "downloading" && (
                        <div className="w-full">
                            <div className="flex justify-between text-[11px] text-neutral-500 mb-1.5 px-0.5">
                                <span>Downloading...</span>
                                <span>{progress}%</span>
                            </div>
                            <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden border border-neutral-700">
                                <motion.div
                                    className="h-full bg-emerald-500"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${progress}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {status === "error" && (
                        <div className="w-full">
                            <p className="text-[11px] text-red-400 mb-3">{error}</p>
                            <button
                                onClick={onClose}
                                className="w-full py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 text-xs font-medium rounded-lg border border-neutral-700 transition-all"
                            >
                                Dismiss
                            </button>
                        </div>
                    )}

                    {status === "installed" && (
                        <p className="text-xs text-emerald-400 font-medium">
                            Relaunching...
                        </p>
                    )}
                </div>
            </motion.div>
        </div>
    );
}

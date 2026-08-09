import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { downloadAppUpdate, installDownloadedUpdate } from "../services/updater";

/**
 * Non-blocking top banner that shows when an update is available.
 * Handles: available → downloading (with progress) → downloaded.
 */
export function UpdateBanner({ update, onDownloadComplete, onDismiss }) {
    const [status, setStatus] = useState("available"); // available, downloading, downloaded, error
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState(null);

    const handleDownload = async () => {
        try {
            setStatus("downloading");
            setError(null);
            await downloadAppUpdate(update, (downloaded, total) => {
                const percent = total ? Math.round((downloaded / total) * 100) : 0;
                setProgress(percent);
            });
            setStatus("downloaded");
            if (onDownloadComplete) onDownloadComplete();
        } catch (err) {
            console.error("Update download failed:", err);
            setError(err.message || "Download failed");
            setStatus("error");
        }
    };

    return (
        <motion.div
            initial={{ y: -60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -60, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed top-0 left-0 right-0 z-[90] pointer-events-auto"
        >
            <div className="mx-auto max-w-full bg-neutral-900/95 backdrop-blur-xl border-b border-neutral-800 shadow-lg shadow-black/30">
                <div className="flex items-center justify-between px-4 py-2.5 gap-3">
                    {/* Left: icon + message */}
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-6 h-6 bg-emerald-500/15 rounded-md flex items-center justify-center shrink-0 border border-emerald-500/20">
                            {status === "downloaded" ? (
                                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                </svg>
                            ) : (
                                <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                            )}
                        </div>

                        <div className="flex flex-col min-w-0">
                            {status === "available" && (
                                <span className="text-[11px] text-neutral-300 font-medium truncate">
                                    Update <span className="text-emerald-400 font-semibold">v{update.version}</span> available
                                </span>
                            )}
                            {status === "downloading" && (
                                <span className="text-[11px] text-neutral-300 font-medium">
                                    Downloading... <span className="text-emerald-400 font-semibold">{progress}%</span>
                                </span>
                            )}
                            {status === "downloaded" && (
                                <span className="text-[11px] text-emerald-400 font-medium">
                                    Update ready to install
                                </span>
                            )}
                            {status === "error" && (
                                <span className="text-[11px] text-red-400 font-medium truncate">
                                    {error}
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Progress bar (only during download) */}
                    {status === "downloading" && (
                        <div className="flex-1 max-w-[120px] h-1 bg-neutral-800 rounded-full overflow-hidden border border-neutral-700/50">
                            <motion.div
                                className="h-full bg-emerald-500 rounded-full"
                                initial={{ width: 0 }}
                                animate={{ width: `${progress}%` }}
                                transition={{ ease: "linear", duration: 0.3 }}
                            />
                        </div>
                    )}

                    {/* Right: action buttons */}
                    <div className="flex items-center gap-1.5 shrink-0">
                        {status === "available" && (
                            <>
                                <button
                                    onClick={onDismiss}
                                    className="px-2.5 py-1 text-[10px] font-medium text-neutral-500 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                                >
                                    Later
                                </button>
                                <button
                                    onClick={handleDownload}
                                    className="px-2.5 py-1 text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-md transition-all active:scale-95"
                                >
                                    Download
                                </button>
                            </>
                        )}
                        {status === "error" && (
                            <>
                                <button
                                    onClick={onDismiss}
                                    className="px-2.5 py-1 text-[10px] font-medium text-neutral-500 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                                >
                                    Dismiss
                                </button>
                                <button
                                    onClick={handleDownload}
                                    className="px-2.5 py-1 text-[10px] font-semibold text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-md transition-all active:scale-95"
                                >
                                    Retry
                                </button>
                            </>
                        )}
                        {status === "downloaded" && (
                            <button
                                onClick={onDismiss}
                                className="px-2.5 py-1 text-[10px] font-medium text-neutral-500 hover:text-neutral-300 transition-colors rounded-md hover:bg-neutral-800"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>

                {/* Subtle shimmer line at bottom during download */}
                {status === "downloading" && (
                    <div className="h-[1px] w-full bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />
                )}
            </div>
        </motion.div>
    );
}

/**
 * Modal popup shown only after the update has been downloaded.
 * Asks the user to restart now or later.
 */
export function UpdateInstallDialog({ update, onRestart, onLater }) {
    const [installing, setInstalling] = useState(false);

    const handleRestart = async () => {
        try {
            setInstalling(true);
            await installDownloadedUpdate(update);
            // relaunch happens inside installDownloadedUpdate
        } catch (err) {
            console.error("Install failed:", err);
            setInstalling(false);
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
                                d="M5 13l4 4L19 7"
                            />
                        </svg>
                    </div>

                    <h3 className="text-base font-medium text-neutral-100 mb-1">Update Ready</h3>
                    <p className="text-xs text-neutral-500 mb-4">
                        v{update.version} has been downloaded. Restart to apply.
                    </p>

                    {!installing ? (
                        <div className="flex w-full gap-2">
                            <button
                                onClick={onLater}
                                className="flex-1 py-2 px-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-400 text-xs font-medium rounded-lg border border-neutral-700 transition-all active:scale-95"
                            >
                                Later
                            </button>
                            <button
                                onClick={handleRestart}
                                className="flex-1 py-2 px-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-xs font-medium rounded-lg border border-emerald-500/20 transition-all active:scale-95"
                            >
                                Restart Now
                            </button>
                        </div>
                    ) : (
                        <p className="text-xs text-emerald-400 font-medium animate-pulse">
                            Installing & restarting...
                        </p>
                    )}
                </div>
            </motion.div>
        </div>
    );
}

// Keep old export name for backward compat (unused but safe)
export const UpdateNotification = UpdateBanner;

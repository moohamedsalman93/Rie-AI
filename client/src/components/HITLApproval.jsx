import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

const HOVER_DELAY_MS = 120;

export const HITLApproval = ({ hitl, onDecision }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [showPopup, setShowPopup] = useState(false);
    const [editedArgs, setEditedArgs] = useState({});
    const hideTimeoutRef = useRef(null);

    if (!hitl || !hitl.action_requests || hitl.action_requests.length === 0) return null;

    const action = hitl.action_requests[0];
    const config = hitl.review_configs[0];

    const show = () => {
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = null;
        }
        setShowPopup(true);
    };

    const hide = () => {
        hideTimeoutRef.current = setTimeout(() => setShowPopup(false), HOVER_DELAY_MS);
    };

    const handleApprove = (e) => {
        e.stopPropagation();
        onDecision([{ type: "approve" }]);
    };

    const handleReject = (e) => {
        e.stopPropagation();
        onDecision([{ type: "reject" }]);
    };

    const handleEditSave = (e) => {
        e.stopPropagation();
        onDecision([
            {
                type: "edit",
                edited_action: {
                    name: action.name,
                    args: { ...action.args, ...editedArgs },
                },
            },
        ]);
    };

    const handleArgChange = (key, value) => {
        setEditedArgs((prev) => ({ ...prev, [key]: value }));
    };

    const formatToolName = (name) => {
        if (!name) return "SYSTEM OPERATION";
        return name
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ')
            .toUpperCase();
    };

    return (
        <div className="relative inline-flex flex-col my-1">
            <div className="flex items-center gap-1.5 group cursor-default">
                <span
                    onMouseEnter={show}
                    onMouseLeave={hide}
                    className="inline-flex items-center gap-1.5"
                >
                    <span className="text-[10px] font-medium text-amber-500/80 tracking-wide truncate">
                        {formatToolName(action.name)}
                    </span>
                    <span className="flex shrink-0 text-amber-500/60 group-hover:text-amber-500/90 transition-colors">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="16" x2="12" y2="12"></line>
                            <line x1="12" y1="8" x2="12.01" y2="8"></line>
                        </svg>
                    </span>
                </span>

                <div className="flex items-center gap-1 ml-0.5 opacity-40 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={handleApprove}
                        title="Approve"
                        className="p-1 rounded hover:bg-amber-500/20 text-amber-500 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    </button>
                    {config.allowed_decisions.includes("edit") && (
                        <button
                            onClick={() => {
                                setIsEditing(true);
                                show();
                            }}
                            title="Edit"
                            className="p-1 rounded hover:bg-neutral-700 text-neutral-400 transition-colors"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                                <path d="m15 5 4 4" />
                            </svg>
                        </button>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDecision([{ type: "chat" }]);
                        }}
                        title="Chat"
                        className="p-1 rounded hover:bg-blue-500/20 text-blue-400 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                    </button>
                    <button
                        onClick={handleReject}
                        title="Reject"
                        className="p-1 rounded hover:bg-red-500/20 text-red-500 transition-colors"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
            </div>

            <AnimatePresence>
                {showPopup && (
                    <motion.div
                        initial={{ opacity: 0, y: -4, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                        onMouseEnter={show}
                        onMouseLeave={hide}
                        className="absolute left-0 top-full z-50 mt-1 min-w-[200px] max-w-[320px] rounded-lg bg-neutral-900 border border-neutral-700 shadow-xl p-3 text-xs text-neutral-300 custom-scrollbar max-h-64 overflow-y-auto"
                    >
                        <div className="space-y-3">
                            {action.description && (
                                <p className="text-[11px] text-neutral-400 leading-relaxed italic">
                                    {action.description}
                                </p>
                            )}

                            {isEditing ? (
                                <div className="space-y-2.5 pt-1 border-t border-neutral-800 mt-2">
                                    <span className="text-[9px] font-bold text-neutral-500 uppercase tracking-widest block font-mono">Edit Parameters</span>
                                    {Object.entries(action.args).map(([key, value]) => (
                                        <div key={key} className="flex flex-col gap-1">
                                            <label className="text-[10px] text-neutral-500 font-mono ml-0.5">{key}</label>
                                            <input
                                                type="text"
                                                defaultValue={typeof value === 'string' ? value : JSON.stringify(value)}
                                                onChange={(e) => handleArgChange(key, e.target.value)}
                                                className="w-full bg-black/40 border border-neutral-800 rounded px-2 py-1.5 text-[11px] text-neutral-200 focus:outline-none focus:border-amber-500/40"
                                            />
                                        </div>
                                    ))}
                                    <div className="flex gap-2 pt-1">
                                        <button
                                            onClick={handleEditSave}
                                            className="flex-1 bg-amber-500 hover:bg-amber-400 text-black text-[10px] font-bold py-1.5 rounded transition-all"
                                        >
                                            SAVE & APPROVE
                                        </button>
                                        <button
                                            onClick={() => setIsEditing(false)}
                                            className="px-3 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] font-bold py-1.5 rounded"
                                        >
                                            CANCEL
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="pt-1 border-t border-neutral-800 mt-2 text-[10px] text-neutral-500 font-mono">
                                    Hover over the icons to take action.
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

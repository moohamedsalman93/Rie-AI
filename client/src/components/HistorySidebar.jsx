import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    ChevronDown,
    Search,
    X,
    Plus,
    Users,
    Mail,
    CalendarClock,
    Trash2,
    PanelLeftClose,
    PanelLeftOpen,
    MessageSquare,
    RefreshCw,
    Clock,
    Laptop,
    ArrowDownLeft,
    ArrowUpRight,
} from 'lucide-react';
import { getHistory, listScheduledTasks, cancelScheduledTask, getSubchats } from '../services/chatApi';
import { ConfirmationModal } from './ConfirmationModal';
import { KnowledgeHistoryBadge } from './KnowledgeAttachmentChips';

const INTENT_LABEL = {
    reminder: 'Reminder',
    analysis_silent: 'Analysis',
    analysis_inform: 'Analysis + notify',
};

function formatRunAt(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    } catch {
        return String(iso);
    }
}

export function HistorySidebar({
    isOpen,
    isCollapsed: controlledIsCollapsed,
    onClose,
    onExpand,
    onToggleCollapse = null,
    onSelectThread,
    onDeleteThread = () => { },
    onNewChat,
    currentThreadId,
    streamingThreads = new Set(),
    windowMode,
    friends = [],
    friendThreadMeta = {},
    onStartFriendChat = () => { },
    connectionRequests = { incoming: [], outgoing: [] },
    onAcceptConnectionRequest = () => { },
    onDeclineConnectionRequest = () => { },
    sessionsByThread = {},
    apiStatus = 'online',
    activeView: controlledActiveView,
    defaultView = 'chats',
    onViewChange,
}) {
    const [internalCollapsed, setInternalCollapsed] = useState(false);
    const isCollapsed = controlledIsCollapsed !== undefined ? controlledIsCollapsed : internalCollapsed;
    const searchInputRef = useRef(null);

    // Sidebar Views: 'chats' | 'connections' | 'scheduled'
    const [internalActiveView, setInternalActiveView] = useState(() => {
        return localStorage.getItem("rie_sidebar_view") || defaultView;
    });
    const activeView = controlledActiveView !== undefined ? controlledActiveView : internalActiveView;

    const handleViewChange = useCallback((newView) => {
        setInternalActiveView(newView);
        try {
            localStorage.setItem("rie_sidebar_view", newView);
        } catch (_) { }
        if (onViewChange) onViewChange(newView);
    }, [onViewChange]);

    const [threads, setThreads] = useState([]);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(true);
    const [error, setError] = useState(null);
    const [searchTerm, setSearchTerm] = useState("");
    const [connectionSearch, setConnectionSearch] = useState("");
    const [chatsOpen, setChatsOpen] = useState(true);
    const [knowledgeOpen, setKnowledgeOpen] = useState(true);
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [threadSubchatsMap, setThreadSubchatsMap] = useState({});
    const [collapsedDevices, setCollapsedDevices] = useState({});
    const toggleDeviceCollapse = useCallback((deviceName) => {
        setCollapsedDevices((prev) => ({ ...prev, [deviceName]: !prev[deviceName] }));
    }, []);

    // Automatically load child subchats for threads that have subchats
    useEffect(() => {
        if (!threads || threads.length === 0) return;
        const threadsWithSubchats = threads.filter(
            (t) => Number(t.subchat_count || 0) > 0 && !threadSubchatsMap[t.id]
        );
        if (threadsWithSubchats.length === 0) return;

        let cancelled = false;
        threadsWithSubchats.forEach(async (t) => {
            try {
                const subs = await getSubchats(t.id);
                if (!cancelled && Array.isArray(subs)) {
                    setThreadSubchatsMap((prev) => ({ ...prev, [t.id]: subs }));
                }
            } catch (err) {
                console.debug("Failed fetching subchats for thread:", t.id, err);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [threads]);

    useEffect(() => {
        if (!currentThreadId) return;
        if (!threadSubchatsMap[currentThreadId]) {
            getSubchats(currentThreadId).then((subs) => {
                if (Array.isArray(subs) && subs.length > 0) {
                    setThreadSubchatsMap((prev) => ({ ...prev, [currentThreadId]: subs }));
                }
            }).catch(() => { });
        }
    }, [currentThreadId]);
    const [threadToDelete, setThreadToDelete] = useState(null);

    const incomingRequests = Array.isArray(connectionRequests?.incoming) ? connectionRequests.incoming : [];
    const incomingCount = incomingRequests.length;
    const onlineFriendsCount = useMemo(() => {
        return (friends || []).filter((f) => Boolean(f.is_online)).length;
    }, [friends]);

    const filteredFriends = useMemo(() => {
        if (!connectionSearch.trim()) return friends || [];
        const q = connectionSearch.toLowerCase();
        return (friends || []).filter((friend) => {
            const name = (friend.email || friend.name || "").toLowerCase();
            const device = (friend.device_name || "").toLowerCase();
            return name.includes(q) || device.includes(q);
        });
    }, [friends, connectionSearch]);

    // Scheduled tasks
    const [scheduledTasks, setScheduledTasks] = useState([]);
    const [loadingTasks, setLoadingTasks] = useState(false);

    const isPersistent = windowMode === 'normal';
    const showSidebar = isOpen || isPersistent;
    const PAGE_SIZE = 18;

    const loadScheduledTasks = useCallback(async () => {
        if (apiStatus !== 'online') return;
        setLoadingTasks(true);
        try {
            const data = await listScheduledTasks();
            setScheduledTasks(Array.isArray(data) ? data : []);
        } catch (err) {
            console.error("Failed to load scheduled tasks:", err);
        } finally {
            setLoadingTasks(false);
        }
    }, [apiStatus]);

    const loadInitialHistory = useCallback(async () => {
        if (!showSidebar) return;
        setLoading(true);
        setError(null);
        try {
            const data = await getHistory(PAGE_SIZE, 0, searchTerm);
            const loaded = Array.isArray(data) ? data : [];
            setThreads(loaded);
            setHasMore(loaded.length >= PAGE_SIZE);
        } catch (err) {
            console.error("Failed to load history:", err);
            setError("Failed to load history");
        } finally {
            setLoading(false);
        }
    }, [showSidebar, searchTerm]);

    const handleExpand = useCallback(() => {
        if (onExpand) {
            onExpand();
        } else if (onToggleCollapse) {
            onToggleCollapse();
        } else {
            setInternalCollapsed(false);
        }
    }, [onExpand, onToggleCollapse]);

    const handleCollapse = useCallback(() => {
        if (onToggleCollapse) {
            onToggleCollapse();
        } else if (onClose) {
            onClose();
        } else {
            setInternalCollapsed(true);
        }
    }, [onToggleCollapse, onClose]);

    const handleSearchClick = () => {
        handleViewChange('chats');
        handleExpand();
        setTimeout(() => {
            searchInputRef.current?.focus();
        }, 120);
    };

    const handleFriendClick = () => {
        handleViewChange('connections');
        handleExpand();
    };

    const handleScheduleClick = () => {
        handleViewChange('scheduled');
        handleExpand();
        loadScheduledTasks();
    };

    const handleNewChat = () => {
        handleViewChange('chats');
        onNewChat();
    };

    useEffect(() => {
        const handleOpenConnections = () => {
            handleViewChange('connections');
            handleExpand();
        };
        const handleOpenScheduled = () => {
            handleViewChange('scheduled');
            handleExpand();
            loadScheduledTasks();
        };
        const handleOpenChats = () => {
            handleViewChange('chats');
            handleExpand();
        };
        window.addEventListener('rie-open-connections', handleOpenConnections);
        window.addEventListener('rie-open-scheduled', handleOpenScheduled);
        window.addEventListener('rie-open-chats', handleOpenChats);
        return () => {
            window.removeEventListener('rie-open-connections', handleOpenConnections);
            window.removeEventListener('rie-open-scheduled', handleOpenScheduled);
            window.removeEventListener('rie-open-chats', handleOpenChats);
        };
    }, [handleViewChange, handleExpand, loadScheduledTasks]);

    useEffect(() => {
        loadInitialHistory();
    }, [loadInitialHistory]);

    useEffect(() => {
        const refresh = () => loadInitialHistory();
        window.addEventListener('rie-history-refresh', refresh);
        return () => window.removeEventListener('rie-history-refresh', refresh);
    }, [loadInitialHistory]);

    useEffect(() => {
        if (!showSidebar) return;
        loadScheduledTasks();
        const interval = setInterval(loadScheduledTasks, 20000);
        return () => clearInterval(interval);
    }, [showSidebar, loadScheduledTasks]);

    useEffect(() => {
        const handleRefresh = () => loadScheduledTasks();
        window.addEventListener('rie-schedule-refresh', handleRefresh);
        return () => window.removeEventListener('rie-schedule-refresh', handleRefresh);
    }, [loadScheduledTasks]);

    const handleCancelScheduledTask = async (e, jobId) => {
        e.stopPropagation();
        try {
            await cancelScheduledTask(jobId);
            await loadScheduledTasks();
        } catch (err) {
            console.error("Failed to cancel scheduled task:", err);
        }
    };

    const handleScroll = async (e) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        if (scrollHeight - scrollTop - clientHeight < 60) {
            if (loading || loadingMore || !hasMore) return;
            setLoadingMore(true);
            try {
                const nextOffset = threads.length;
                const data = await getHistory(PAGE_SIZE, nextOffset, searchTerm);
                if (Array.isArray(data)) {
                    if (data.length < PAGE_SIZE) {
                        setHasMore(false);
                    }
                    setThreads((prev) => {
                        const existingIds = new Set(prev.map((t) => String(t.id)));
                        const newItems = data.filter((t) => !existingIds.has(String(t.id)));
                        return [...prev, ...newItems];
                    });
                }
            } catch (err) {
                console.error("Failed to load more history:", err);
            } finally {
                setLoadingMore(false);
            }
        }
    };

    const formatDate = (isoString) => {
        if (!isoString) return "";
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (diffDays === 1) return 'Yesterday';
        if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const confirmDelete = async () => {
        if (!threadToDelete) return;
        try {
            await onDeleteThread(threadToDelete);
            setThreads((prev) => prev.filter((t) => t.id !== threadToDelete));
        } catch (err) {
            console.error("Failed to delete thread:", err);
        } finally {
            setThreadToDelete(null);
            setIsConfirmOpen(false);
        }
    };

    const getThreadFriendMeta = (threadId) => {
        if (!friendThreadMeta) return null;
        return friendThreadMeta[threadId] || friendThreadMeta[String(threadId)] || null;
    };

    const mergedThreads = useMemo(() => {
        const known = new Set((threads || []).map((t) => String(t.id)));
        const localOnly = Object.keys(sessionsByThread || {})
            .filter((threadId) => !known.has(String(threadId)))
            .filter((threadId) => {
                const messages = sessionsByThread[threadId] || [];
                return messages.length === 0 || messages.every((message) => message.id === undefined);
            })
            .map((threadId) => ({
                id: threadId,
                title: "Untitled Chat",
                created_at: null,
                updated_at: null,
            }));
        return [...localOnly, ...(threads || [])];
    }, [threads, sessionsByThread]);

    const getMatchedFriend = useCallback((thread, friendMeta) => {
        const friendId = thread?.friend_id || friendMeta?.friendId;
        if (!friendId) return null;
        return (friends || []).find((f) => f.id === friendId) || null;
    }, [friends]);

    const isThreadInbound = useCallback((t) => {
        if (!t) return false;
        if (t.direction === 'inbound') return true;
        const fMeta = getThreadFriendMeta(t.id);
        if (fMeta?.direction === 'inbound') return true;
        const strId = String(t.id || '');
        return strId.startsWith('cloud-peer:') || strId.includes('inbound');
    }, [getThreadFriendMeta]);

    const getThreadDisplayTitle = useCallback((thread, friendMeta) => {
        const isConn = Boolean(thread.is_friend_chat || thread.friend_id || friendMeta?.isFriendChat || friendMeta?.friendId);
        if (isConn) {
            const matchedFriend = getMatchedFriend(thread, friendMeta);
            const peerIdentifier = matchedFriend?.name || matchedFriend?.email || friendMeta?.friendEmail || thread.friend_name || friendMeta?.friendName;
            if (!thread.title || thread.title === "Untitled Chat" || thread.title.startsWith("Chat with")) {
                return peerIdentifier ? `Chat with ${peerIdentifier}` : "Connection Chat";
            }
            return thread.title;
        }
        return thread.title || "Untitled Chat";
    }, [getMatchedFriend]);

    const getThreadCategory = useCallback((thread) => {
        const friendMeta = getThreadFriendMeta(thread.id);
        const isConn = Boolean(thread.is_friend_chat || thread.friend_id || friendMeta?.isFriendChat || friendMeta?.friendId);
        if (isConn) return 'connections';

        const isKnow = Boolean(thread.is_knowledge_chat || (Array.isArray(thread.knowledge_names) && thread.knowledge_names.length > 0));
        if (isKnow) return 'knowledge';

        const titleLower = (thread.title || "").toLowerCase();
        const isSched = Boolean(thread.intent || thread.task_id || titleLower.includes("[scheduled]") || titleLower.includes("scheduled"));
        if (isSched) return 'scheduled';

        return 'chats';
    }, [friendThreadMeta]);

    const normalThreads = useMemo(() => {
        return mergedThreads.filter((t) => getThreadCategory(t) === 'chats');
    }, [mergedThreads, getThreadCategory]);

    const connectionThreads = useMemo(() => {
        return mergedThreads.filter((t) => getThreadCategory(t) === 'connections');
    }, [mergedThreads, getThreadCategory]);

    const knowledgeThreads = useMemo(() => {
        return mergedThreads.filter((t) => getThreadCategory(t) === 'knowledge');
    }, [mergedThreads, getThreadCategory]);

    const scheduledRunThreads = useMemo(() => {
        return mergedThreads.filter((t) => getThreadCategory(t) === 'scheduled');
    }, [mergedThreads, getThreadCategory]);

    const searchResults = useMemo(() => {
        if (!searchTerm) return [];
        const term = searchTerm.toLowerCase();
        return mergedThreads.filter((t) => {
            const friendMeta = getThreadFriendMeta(t.id);
            const title = getThreadDisplayTitle(t, friendMeta).toLowerCase();
            const matchedFriend = getMatchedFriend(t, friendMeta);
            const email = (matchedFriend?.email || friendMeta?.friendEmail || "").toLowerCase();
            const device = (matchedFriend?.device_name || friendMeta?.deviceName || "").toLowerCase();
            return title.includes(term) || email.includes(term) || device.includes(term);
        });
    }, [mergedThreads, searchTerm, getThreadDisplayTitle, getMatchedFriend, friendThreadMeta]);

    const handleFriendChatClick = (friend, forceNew = false) => {
        handleViewChange("chats");
        if (!forceNew) {
            const existing = mergedThreads.find((t) => {
                const fMeta = getThreadFriendMeta(t.id);
                return t.friend_id === friend.id || fMeta?.friendId === friend.id;
            });
            if (existing) {
                onSelectThread(existing.id);
                return;
            }
        }
        onStartFriendChat(friend, forceNew);
    };

    const chatViewThreads = useMemo(() => {
        return mergedThreads.filter((t) => {
            const cat = getThreadCategory(t);
            return cat === 'chats' || cat === 'connections' || cat === 'knowledge';
        });
    }, [mergedThreads, getThreadCategory]);

    const filteredThreads = useMemo(() => {
        if (!searchTerm.trim()) return chatViewThreads;
        const q = searchTerm.toLowerCase();
        return chatViewThreads.filter((t) => {
            const friendMeta = getThreadFriendMeta(t.id);
            const matchedFriend = getMatchedFriend(t, friendMeta);
            const devName = (matchedFriend?.device_name || friendMeta?.deviceName || t.device_name || "").toLowerCase();
            const title = (t.title || "Untitled Chat").toLowerCase();
            return title.includes(q) || devName.includes(q);
        });
    }, [chatViewThreads, searchTerm, getThreadFriendMeta, getMatchedFriend]);

    const getDeviceMeta = useCallback((thread) => {
        const friendMeta = getThreadFriendMeta(thread.id);
        const matchedFriend = getMatchedFriend(thread, friendMeta);
        const isConn = Boolean(thread.is_friend_chat || thread.friend_id || friendMeta?.isFriendChat || friendMeta?.friendId);
        const deviceName = matchedFriend?.device_name || friendMeta?.deviceName || thread.device_name || thread.friend_name || (matchedFriend ? (matchedFriend.name || matchedFriend.email) : (isConn ? "Peer Device" : null));
        return { isConn, deviceName, matchedFriend, friendMeta };
    }, [getThreadFriendMeta, getMatchedFriend]);

    const organizeThreadsWithDeviceGrouping = useCallback((threadList) => {
        const items = [];
        const deviceMap = new Map();

        for (const thread of threadList) {
            const meta = getDeviceMeta(thread);
            if (meta.isConn && meta.deviceName) {
                if (!deviceMap.has(meta.deviceName)) {
                    const groupObj = {
                        type: 'device_group',
                        deviceName: meta.deviceName,
                        friend: meta.matchedFriend,
                        threads: [],
                    };
                    deviceMap.set(meta.deviceName, groupObj);
                    items.push(groupObj);
                }
                deviceMap.get(meta.deviceName).threads.push(thread);
            } else {
                items.push({
                    type: 'thread',
                    thread,
                });
            }
        }
        return items;
    }, [getDeviceMeta]);

    const groupedThreads = useMemo(() => {
        const groups = {
            today: { title: "Today", threads: [] },
            yesterday: { title: "Yesterday", threads: [] },
            previous7: { title: "Previous 7 Days", threads: [] },
            older: { title: "Older", threads: [] },
        };

        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        filteredThreads.forEach((thread) => {
            const dateStr = thread.updated_at || thread.created_at;
            if (!dateStr) {
                groups.today.threads.push(thread);
                return;
            }

            const date = new Date(dateStr);
            const threadStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const diffDays = Math.round((todayStart - threadStart) / (1000 * 60 * 60 * 24));

            if (diffDays <= 0) {
                groups.today.threads.push(thread);
            } else if (diffDays === 1) {
                groups.yesterday.threads.push(thread);
            } else if (diffDays < 7) {
                groups.previous7.threads.push(thread);
            } else {
                groups.older.threads.push(thread);
            }
        });

        return Object.values(groups).filter((g) => g.threads.length > 0);
    }, [filteredThreads]);

    const groupedNormalThreads = groupedThreads;

    const renderThreadItem = (thread, closeOnSelect = false) => {
        const isActive = thread.id === currentThreadId;
        const isStreaming = streamingThreads.has(thread.id);
        const friendMeta = getThreadFriendMeta(thread.id);
        const matchedFriend = getMatchedFriend(thread, friendMeta);
        const isConn = Boolean(thread.is_friend_chat || thread.friend_id || friendMeta?.isFriendChat || friendMeta?.friendId);
        const isKnow = Boolean(thread.is_knowledge_chat || (Array.isArray(thread.knowledge_names) && thread.knowledge_names.length > 0));
        const isSched = Boolean(thread.intent || thread.task_id || (thread.title || "").toLowerCase().includes("scheduled"));
        const displayTitle = getThreadDisplayTitle(thread, friendMeta);
        const childSubchats = threadSubchatsMap[thread.id] || [];

        return (
            <div key={thread.id} className="space-y-0.5">
                <button
                    onClick={() => {
                        onSelectThread(thread.id);
                        if (closeOnSelect) onClose();
                    }}
                    className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors group relative flex items-center justify-between ${isActive
                        ? "bg-neutral-800 text-white font-medium shadow-xs"
                        : "text-neutral-400 hover:bg-neutral-800/40 hover:text-neutral-200"
                        }`}
                >
                    <div className="pr-5 min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                            {isConn ? (
                                <span className="flex items-center gap-1 shrink-0">
                                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${matchedFriend?.is_online ? "bg-emerald-400" : "bg-neutral-500"}`} />
                                    {isThreadInbound(thread) ? (
                                        <ArrowDownLeft size={11} className="text-neutral-400 shrink-0" title="Inbound" />
                                    ) : (
                                        <ArrowUpRight size={11} className="text-neutral-400 shrink-0" title="Outbound" />
                                    )}
                                </span>
                            ) : isKnow ? (
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />
                            ) : isSched ? (
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shrink-0" />
                            ) : null}
                            <span className="text-xs truncate font-medium">
                                {displayTitle}
                            </span>
                            {isConn && (matchedFriend?.device_name || friendMeta?.deviceName) && (
                                <span className="rounded bg-neutral-800 text-neutral-300 text-[9px] px-1 py-0.2 shrink-0 border border-neutral-700/60 font-mono">
                                    {matchedFriend?.device_name || friendMeta?.deviceName}
                                </span>
                            )}
                            <KnowledgeHistoryBadge knowledgeNames={thread.knowledge_names} />
                            {isStreaming && (
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                            )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-neutral-500">
                            <span className="opacity-70">
                                {formatDate(thread.updated_at || thread.created_at)}
                            </span>
                        </div>
                    </div>

                    <div
                        onClick={(e) => {
                            e.stopPropagation();
                            setThreadToDelete(thread.id);
                            setIsConfirmOpen(true);
                        }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-neutral-500 hover:text-red-400 transition-all cursor-pointer"
                        title="Delete conversation"
                    >
                        <Trash2 size={12} />
                    </div>
                </button>

                {/* Subchats */}
                {childSubchats.length > 0 && (
                    <div className="ml-3 pl-2 border-l border-neutral-800 space-y-0.5 py-0.5">
                        {childSubchats.map((sub) => {
                            const isSubActive = sub.id === currentThreadId;
                            const subClean = (sub.title || sub.subagent_type || "Subchat").replace(/_/g, " ");
                            return (
                                <button
                                    key={sub.id}
                                    onClick={() => {
                                        onSelectThread(sub.id);
                                        if (closeOnSelect) onClose();
                                    }}
                                    className={`w-full text-left px-2 py-1 rounded text-xs transition-colors flex items-center justify-between group/sub ${isSubActive
                                        ? "bg-neutral-800 text-emerald-400 font-medium"
                                        : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/40"
                                        }`}
                                >
                                    <span className="truncate flex items-center gap-1.5 min-w-0">
                                        <span className="text-[10px] text-emerald-500/70 font-mono">↳</span>
                                        <span className="truncate text-[11px]">{subClean}</span>
                                    </span>
                                    <span className="text-[9px] text-neutral-500 font-mono shrink-0 ml-1">
                                        {sub.message_count || 1} msg
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    const renderDeviceGroupItem = (deviceGroup, closeOnSelect = false) => {
        const isDeviceCollapsed = Boolean(collapsedDevices[deviceGroup.deviceName]);
        const hasActiveThread = deviceGroup.threads.some((t) => t.id === currentThreadId);
        const isOnline = Boolean(deviceGroup.friend?.is_online);

        return (
            <div key={`device-group-${deviceGroup.deviceName}`} className="space-y-0.5">
                <button
                    type="button"
                    onClick={() => toggleDeviceCollapse(deviceGroup.deviceName)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between transition-colors group cursor-pointer ${
                        hasActiveThread
                            ? "bg-neutral-800 text-white font-medium shadow-xs"
                            : "text-neutral-300 hover:text-white hover:bg-neutral-800/40"
                    }`}
                    title={`Device: ${deviceGroup.deviceName}`}
                >
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        <span className="relative flex h-2 w-2 shrink-0">
                            {isOnline && (
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            )}
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${isOnline ? "bg-emerald-500" : "bg-neutral-600"}`} />
                        </span>
                        <Laptop size={13} className="text-emerald-400 shrink-0" />
                        <span className="text-xs truncate font-medium group-hover:text-emerald-300 transition-colors">
                            {deviceGroup.deviceName}
                        </span>
                        <span className="rounded bg-emerald-500/10 text-emerald-400 text-[9px] px-1 py-0.2 shrink-0 font-mono">
                            {deviceGroup.threads.length}
                        </span>
                    </div>
                    <ChevronDown
                        size={12}
                        className={`text-neutral-500 transition-transform ${isDeviceCollapsed ? "-rotate-90" : ""}`}
                    />
                </button>

                {!isDeviceCollapsed && (
                    <div className="ml-3 pl-2.5 border-l border-white/[0.08] space-y-0.5 py-0.5">
                        {deviceGroup.threads.map((thread) => {
                            const isActive = thread.id === currentThreadId;
                            const isStreaming = streamingThreads.has(thread.id);
                            return (
                                <div key={thread.id} className="relative group/devicechat flex items-center">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onSelectThread(thread.id);
                                            if (closeOnSelect) onClose();
                                        }}
                                        className={`w-full text-left px-2 py-1.5 rounded-md text-xs transition-colors flex items-center justify-between cursor-pointer ${
                                            isActive
                                                ? "bg-neutral-800 text-emerald-400 font-medium"
                                                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/40"
                                        }`}
                                    >
                                        <span className="truncate flex items-center gap-1.5 min-w-0 pr-4">
                                            <span className="text-[10px] text-emerald-500/70 font-mono">↳</span>
                                            {isThreadInbound(thread) ? (
                                                <ArrowDownLeft size={11} className="text-neutral-400 shrink-0" title="Inbound" />
                                            ) : (
                                                <ArrowUpRight size={11} className="text-neutral-400 shrink-0" title="Outbound" />
                                            )}
                                            <span className="truncate text-[11px]">{thread.title || "Untitled Chat"}</span>
                                            {isStreaming && (
                                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                                            )}
                                        </span>
                                        <span className="text-[9px] text-neutral-500 font-mono shrink-0 ml-1">
                                            {formatDate(thread.updated_at || thread.created_at)}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setThreadToDelete(thread.id);
                                            setIsConfirmOpen(true);
                                        }}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded opacity-0 group-hover/devicechat:opacity-100 hover:bg-red-500/20 text-neutral-500 hover:text-red-400 transition-all cursor-pointer"
                                        title="Delete conversation"
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    };

    const renderCollapsedBar = () => (
        <div className="w-12 h-full flex flex-col items-center py-2.5 space-y-2 select-none bg-neutral-900 shrink-0">
            {/* 1. Expand Icon */}
            <button
                type="button"
                onClick={handleExpand}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                title="Expand Sidebar"
            >
                <PanelLeftOpen size={16} />
            </button>

            {/* 2. New Chat */}
            <button
                type="button"
                onClick={handleNewChat}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                title="New Chat (Ctrl+N)"
            >
                <Plus size={16} />
            </button>

            <div className="w-5 h-[1px] bg-neutral-800 my-0.5" />

            {/* 3. Chats View */}
            <button
                type="button"
                onClick={handleSearchClick}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 cursor-pointer ${
                    activeView === 'chats'
                        ? 'text-white bg-neutral-800 ring-1 ring-neutral-700/60'
                        : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`}
                title="Chats"
            >
                <MessageSquare size={16} />
            </button>

            {/* 4. Connections View */}
            <button
                type="button"
                onClick={handleFriendClick}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 relative cursor-pointer ${
                    activeView === 'connections'
                        ? 'text-white bg-neutral-800 ring-1 ring-neutral-700/60'
                        : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`}
                title={incomingCount > 0 ? `${incomingCount} incoming connection request${incomingCount > 1 ? 's' : ''}` : friends.length > 0 ? `Connections (${friends.length})` : "Connections"}
            >
                <Users size={16} />
                {incomingCount > 0 ? (
                    <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
                    </span>
                ) : friends.length > 0 ? (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-emerald-500 ring-2 ring-neutral-900" />
                ) : null}
            </button>

            {/* 5. Schedule View */}
            <button
                type="button"
                onClick={handleScheduleClick}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 relative cursor-pointer ${
                    activeView === 'scheduled'
                        ? 'text-white bg-neutral-800 ring-1 ring-neutral-700/60'
                        : 'text-neutral-400 hover:text-white hover:bg-neutral-800'
                }`}
                title={scheduledTasks.length > 0 ? `Scheduled Tasks (${scheduledTasks.length})` : "Scheduled Tasks"}
            >
                <CalendarClock size={16} />
                {scheduledTasks.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-cyan-500 ring-2 ring-neutral-900" />
                )}
            </button>
        </div>
    );

    const renderContent = (closeOnSelect = false) => (
        <div className="flex flex-col h-full w-full min-w-[240px] overflow-hidden select-none bg-neutral-900 text-neutral-100">
            {/* ROW 1: Search + New Chat (+) + Open/Close Icon */}
            <div className="px-3 pt-3 pb-2 shrink-0 bg-neutral-900 flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                    <Search
                        size={13}
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
                    />
                    <input
                        ref={searchInputRef}
                        type="text"
                        placeholder={
                            activeView === 'connections'
                                ? "Filter connections..."
                                : activeView === 'scheduled'
                                    ? "Search tasks..."
                                    : "Search chats..."
                        }
                        value={activeView === 'connections' ? connectionSearch : searchTerm}
                        onChange={(e) => {
                            if (activeView === 'connections') {
                                setConnectionSearch(e.target.value);
                            } else {
                                setSearchTerm(e.target.value);
                            }
                        }}
                        className="w-full bg-neutral-800/70 border border-neutral-700/50 hover:border-neutral-600 focus:border-neutral-500 rounded-lg pl-8 pr-6 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-500 outline-none transition-colors"
                    />
                    {((activeView === 'connections' && connectionSearch) || (activeView !== 'connections' && searchTerm)) && (
                        <button
                            onClick={() => {
                                if (activeView === 'connections') setConnectionSearch("");
                                else setSearchTerm("");
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
                        >
                            <X size={12} />
                        </button>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => {
                        onNewChat();
                        if (closeOnSelect) onClose();
                    }}
                    className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-750 text-neutral-300 hover:text-white border border-neutral-700/50 transition-colors shrink-0 cursor-pointer"
                    title="New Chat (Ctrl+N)"
                >
                    <Plus size={15} />
                </button>
                {isPersistent ? (
                    <button
                        onClick={handleCollapse}
                        className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                        title="Collapse Sidebar"
                    >
                        <PanelLeftClose size={15} />
                    </button>
                ) : (
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                        title="Close"
                    >
                        <X size={15} />
                    </button>
                )}
            </div>

            {/* ROW 2: View Switcher Tabs (Chats / Connections / Scheduled) */}
            <div className="px-3 pb-2.5 shrink-0 border-b border-neutral-800/80 bg-neutral-900">
                <div className="flex items-center gap-1 p-1 rounded-lg bg-neutral-950/80 border border-neutral-800/80 w-full">
                    {/* Chats Tab */}
                    <button
                        type="button"
                        onClick={() => handleViewChange('chats')}
                        className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-[11px] font-medium transition-all cursor-pointer ${activeView === 'chats'
                            ? 'bg-neutral-800 text-neutral-100 shadow-sm border border-neutral-700/60 font-semibold'
                            : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-850'
                            }`}
                        title="Chats History"
                    >
                        <MessageSquare size={13} className="shrink-0" />
                        <span className="truncate">Chats</span>
                    </button>

                    {/* Connections Tab */}
                    <button
                        type="button"
                        onClick={() => handleViewChange('connections')}
                        className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-1.5 px-2 rounded-md text-[11px] font-medium transition-all relative cursor-pointer ${activeView === 'connections'
                            ? 'bg-neutral-800 text-neutral-100 shadow-sm border border-neutral-700/60 font-semibold'
                            : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-850'
                            }`}
                        title="Connections"
                    >
                        <Users size={13} className="shrink-0" />
                        <span className="truncate">Connections</span>
                        {incomingCount > 0 ? (
                            <span className="rounded-full bg-amber-500 px-1 py-0.2 text-[9px] font-bold text-black animate-pulse leading-none">
                                {incomingCount}
                            </span>
                        ) : friends.length > 0 ? (
                            <span className="text-[9px] text-neutral-500 font-mono">
                                ({friends.length})
                            </span>
                        ) : null}
                    </button>

                    {/* Scheduled Tab */}
                    <button
                        type="button"
                        onClick={() => {
                            handleViewChange('scheduled');
                            loadScheduledTasks();
                        }}
                        className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-1.5 px-2 rounded-md text-[11px] font-medium transition-all relative cursor-pointer ${activeView === 'scheduled'
                            ? 'bg-neutral-800 text-neutral-100 shadow-sm border border-neutral-700/60 font-semibold'
                            : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-850'
                            }`}
                        title="Scheduled Tasks"
                    >
                        <CalendarClock size={13} className="shrink-0" />
                        <span className="truncate">Scheduled</span>
                        {scheduledTasks.length > 0 && (
                            <span className="text-[9px] text-neutral-500 font-mono">
                                ({scheduledTasks.length})
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* VIEW 1: CHATS VIEW */}
            {activeView === 'chats' && (
                <>
                    {/* Chat History List */}
                    <div
                        className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2"
                        onScroll={handleScroll}
                    >
                        <div className="pt-0.5">
                            {loading ? (
                                <div className="flex justify-center py-8">
                                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-500 border-t-transparent" />
                                </div>
                            ) : error ? (
                                <div className="py-6 text-center text-xs text-red-400 space-y-1">
                                    <p>{error}</p>
                                    <button
                                        onClick={loadInitialHistory}
                                        className="text-[11px] text-neutral-400 hover:text-neutral-200 underline cursor-pointer"
                                    >
                                        Retry
                                    </button>
                                </div>
                            ) : filteredThreads.length === 0 ? (
                                <div className="py-8 text-center text-xs text-neutral-500">
                                    {searchTerm ? "No chats match." : "No chats yet."}
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {groupedThreads.map((group) => {
                                        const organizedItems = organizeThreadsWithDeviceGrouping(group.threads);
                                        return (
                                            <div key={group.title} className="space-y-0.5">
                                                <div className="px-2.5 py-1 text-[10px] font-semibold text-neutral-200 tracking-wider">
                                                    {group.title}
                                                </div>
                                                <div className="space-y-1 pl-1">
                                                    {organizedItems.map((item) =>
                                                        item.type === 'device_group'
                                                            ? renderDeviceGroupItem(item, closeOnSelect)
                                                            : renderThreadItem(item.thread, closeOnSelect)
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}

                                        {loadingMore && (
                                            <div className="flex justify-center py-2">
                                                <div className="animate-spin rounded-full h-4 w-4 border-2 border-emerald-500 border-t-transparent" />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {/* VIEW 2: CONNECTIONS VIEW */}
                {activeView === 'connections' && (
                    <>
                        {/* Connections Subheader */}
                        <div className="px-3 py-2.5 shrink-0 border-b border-neutral-800/60 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold text-neutral-200">Connections</span>
                                {friends.length > 0 && (
                                    <span className="text-[10px] text-neutral-400 bg-neutral-800 px-1.5 py-0.2 rounded-full font-mono">
                                        {friends.length}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
                                <span className={`flex h-1.5 w-1.5 rounded-full ${onlineFriendsCount > 0 ? "bg-emerald-500 animate-pulse" : "bg-neutral-600"}`} />
                                <span>{onlineFriendsCount} online</span>
                            </div>
                        </div>

                        {/* Connections List */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-3">
                            {/* Pending Incoming Connection Requests */}
                            {incomingRequests.length > 0 && (
                                <div className="space-y-1.5 pb-2 border-b border-neutral-800/60">
                                    <div className="px-1 text-[10px] font-semibold text-amber-400 uppercase tracking-wider flex items-center gap-1">
                                        <Mail size={11} /> Requests ({incomingRequests.length})
                                    </div>
                                    {incomingRequests.map((req) => (
                                        <div
                                            key={req.id}
                                            className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-2 space-y-1.5 shadow-sm"
                                        >
                                            <div className="text-xs font-medium text-white truncate" title={req.sender_email}>
                                                {req.sender_email}
                                            </div>
                                            <div className="text-[10px] text-neutral-400">
                                                Wants to connect with you
                                            </div>
                                            <div className="flex items-center gap-1.5 pt-0.5">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onAcceptConnectionRequest(req.id);
                                                    }}
                                                    className="flex-1 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-[11px] font-semibold text-white transition-colors cursor-pointer text-center"
                                                >
                                                    Accept
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onDeclineConnectionRequest(req.id);
                                                    }}
                                                    className="px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-750 text-[11px] font-medium text-neutral-300 transition-colors cursor-pointer text-center border border-neutral-700/50"
                                                >
                                                    Decline
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                        {/* Connected Friends List */}
                        <div className="space-y-1">
                            {filteredFriends.length === 0 ? (
                                <div className="px-2 py-4 text-[11px] text-neutral-500 text-center">
                                    {connectionSearch ? "No connections match." : "No connections yet. Add friends in Settings > Connectivity."}
                                </div>
                            ) : (
                                filteredFriends.map((friend) => {
                                    const displayName = friend.name || friend.email || "Connection";
                                    const isOnline = Boolean(friend.is_online);
                                    return (
                                        <div
                                            key={friend.id}
                                            onClick={() => {
                                                handleFriendChatClick(friend);
                                                if (closeOnSelect) onClose();
                                            }}
                                            className="group flex items-center justify-between p-2 rounded-lg bg-neutral-800/40 hover:bg-neutral-800/80 cursor-pointer transition-colors border border-transparent hover:border-emerald-500/25"
                                            title={friend.email || displayName}
                                        >
                                            <div className="flex items-center gap-2 min-w-0 pr-1.5">
                                                <span className="relative flex h-2 w-2 shrink-0">
                                                    {isOnline && (
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                                    )}
                                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${isOnline ? "bg-emerald-500" : "bg-neutral-600"}`} />
                                                </span>
                                                <div className="min-w-0">
                                                    <p className="text-xs text-neutral-200 truncate group-hover:text-emerald-300 transition-colors font-medium">
                                                        {displayName}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-1 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleFriendChatClick(friend);
                                                        if (closeOnSelect) onClose();
                                                    }}
                                                    className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                                                    title="Inbound communication"
                                                >
                                                    <ArrowDownLeft size={13} />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleFriendChatClick(friend);
                                                        if (closeOnSelect) onClose();
                                                    }}
                                                    className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                                                    title="Outbound communication"
                                                >
                                                    <ArrowUpRight size={13} />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleFriendChatClick(friend);
                                                        if (closeOnSelect) onClose();
                                                    }}
                                                    className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors shrink-0 cursor-pointer"
                                                    title={`Chat with ${displayName}`}
                                                >
                                                    <MessageSquare size={14} />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>

                            {/* Past Peer Conversations */}
                            {connectionThreads.length > 0 && (
                                <div className="space-y-1 pt-2 border-t border-neutral-800/60">
                                    <div className="px-1 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                                        Past Peer Chats ({connectionThreads.length})
                                    </div>
                                    <div className="space-y-0.5">
                                        {organizeThreadsWithDeviceGrouping(connectionThreads).map((item) =>
                                            item.type === 'device_group'
                                                ? renderDeviceGroupItem(item, closeOnSelect)
                                                : renderThreadItem(item.thread, closeOnSelect)
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}

            {/* VIEW 3: SCHEDULED VIEW */}
            {activeView === 'scheduled' && (
                <>
                    {/* Scheduled Subheader */}
                    <div className="px-3 py-2.5 shrink-0 border-b border-neutral-800/60 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="text-xs font-semibold text-neutral-200">Scheduled Tasks</span>
                            {scheduledTasks.length > 0 && (
                                <span className="text-[10px] text-neutral-400 bg-neutral-800 px-1.5 py-0.2 rounded-full font-mono">
                                    {scheduledTasks.length}
                                </span>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={loadScheduledTasks}
                            className="p-1 rounded text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer"
                            title="Refresh tasks"
                        >
                            <RefreshCw size={13} className={loadingTasks ? "animate-spin text-emerald-400" : ""} />
                        </button>
                    </div>

                    {/* Scheduled Tasks List */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                        {loadingTasks && scheduledTasks.length === 0 ? (
                            <div className="flex justify-center py-8">
                                <div className="animate-spin rounded-full h-5 w-5 border-2 border-emerald-500 border-t-transparent" />
                            </div>
                        ) : scheduledTasks.length === 0 ? (
                            <div className="flex flex-col items-center justify-center text-center py-12 px-4 space-y-2">
                                <div className="w-10 h-10 rounded-xl bg-neutral-800/50 border border-neutral-800 flex items-center justify-center text-neutral-500">
                                    <CalendarClock size={20} />
                                </div>
                                <div className="text-xs font-medium text-neutral-300">No scheduled tasks</div>
                                <p className="text-[11px] text-neutral-500 max-w-[200px]">
                                    Ask Rie to remind you of tasks or schedule actions (e.g. &quot;Remind me at 5 PM&quot;).
                                </p>
                            </div>
                        ) : (
                            scheduledTasks.map((t) => (
                                <div
                                    key={t.id}
                                    className="group relative rounded-lg border border-neutral-800/80 bg-neutral-800/40 hover:bg-neutral-800/70 p-2.5 transition-colors space-y-1"
                                >
                                    <div className="flex items-center justify-between gap-1">
                                        <span className={`text-[9px] uppercase font-mono px-1.5 py-0.5 rounded ${t.intent === 'reminder'
                                            ? 'bg-amber-500/15 text-amber-300 border border-amber-500/20'
                                            : t.intent === 'analysis_inform'
                                                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20'
                                                : 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/20'
                                            }`}>
                                            {INTENT_LABEL[t.intent] || t.intent || "Task"}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={(e) => handleCancelScheduledTask(e, t.id)}
                                            className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 transition-opacity p-0.5 cursor-pointer"
                                            title="Cancel"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                    <div className="text-xs text-neutral-200 truncate font-medium">
                                        {t.title || t.text}
                                    </div>
                                    <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 font-mono">
                                        <Clock size={11} className="shrink-0" />
                                        <span>{formatRunAt(t.run_at)}</span>
                                    </div>
                                </div>
                            ))
                        )}

                        {/* Past Scheduled Run Conversations */}
                        {scheduledRunThreads.length > 0 && (
                            <div className="space-y-1 pt-2 border-t border-neutral-800/60">
                                <div className="px-1 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                                    Past Scheduled Chats ({scheduledRunThreads.length})
                                </div>
                                <div className="space-y-0.5">
                                    {scheduledRunThreads.map((thread) => renderThreadItem(thread, closeOnSelect))}
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}

            <ConfirmationModal
                isOpen={isConfirmOpen}
                onClose={() => setIsConfirmOpen(false)}
                onConfirm={confirmDelete}
                title="Delete Chat?"
                message="This will permanently delete this conversation."
                confirmText="Delete"
            />
        </div>
    );

    // Persistent Docked Mode
            if (isPersistent) {
        return (
            <aside className="w-full bg-neutral-900 border-r border-neutral-800 flex flex-col h-full shrink-0 relative z-20">
                {isCollapsed ? renderCollapsedBar() : renderContent(false)}
            </aside>
            );
    }

    // Floating Drawer Mode
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
                    />
                    <motion.aside
                        initial={{ x: "-100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "-100%" }}
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                        className="fixed left-0 top-0 bottom-0 w-72 bg-neutral-900 border-r border-neutral-800 z-50 flex flex-col shadow-2xl"
                    >
                        {renderContent(true)}
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    );
}

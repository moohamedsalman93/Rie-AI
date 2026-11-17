import { create } from "zustand";

export const useChatStore = create((set, get) => ({
  activeThreadId: null,
  setActiveThreadId: (id) => set({ activeThreadId: id }),

  sessions: {},
  setSessions: (updater) =>
    set((state) => ({
      sessions: typeof updater === "function" ? updater(state.sessions) : updater,
    })),

  streamingThreads: new Set(),
  addStreamingThread: (threadId) =>
    set((state) => {
      const next = new Set(state.streamingThreads);
      next.add(threadId);
      return { streamingThreads: next };
    }),
  removeStreamingThread: (threadId) =>
    set((state) => {
      const next = new Set(state.streamingThreads);
      next.delete(threadId);
      return { streamingThreads: next };
    }),

  input: "",
  setInput: (input) => set({ input }),

  chatMode: "agent", // "agent" | "chat" | "coding"
  setChatMode: (mode) => set({ chatMode: mode, codingMode: mode === "coding" }),

  codingMode: false,
  setCodingMode: (enabled) => set((state) => ({
    codingMode: enabled,
    chatMode: enabled ? "coding" : (state.chatMode === "coding" ? "agent" : state.chatMode),
  })),

  speedMode: "thinking", // "thinking" | "flash"
  setSpeedMode: (mode) => set({ speedMode: mode }),

  pendingActions: {},
  setPendingAction: (threadId, action) =>
    set((state) => ({
      pendingActions: { ...state.pendingActions, [threadId]: action },
    })),
  clearPendingAction: (threadId) =>
    set((state) => {
      const next = { ...state.pendingActions };
      delete next[threadId];
      return { pendingActions: next };
    }),

  error: null,
  setError: (error) => set({ error }),

  scheduleNotifications: [],
  setScheduleNotifications: (updater) =>
    set((state) => ({
      scheduleNotifications:
        typeof updater === "function"
          ? updater(state.scheduleNotifications)
          : updater,
    })),

  friends: [],
  setFriends: (friends) => set({ friends }),
  friendThreadMeta: {},
  setFriendThreadMeta: (updater) =>
    set((state) => ({
      friendThreadMeta:
        typeof updater === "function"
          ? updater(state.friendThreadMeta)
          : updater,
    })),

  // Subchat & Thread Drawer state
  activeSubchatId: null,
  activeSubchatParentId: null,
  activeSubchatTitle: null,
  activeSubchatType: null,
  isSubchatDrawerOpen: false,
  openSubchat: (subchatId, parentId = null, title = null, subagentType = null) =>
    set({
      activeSubchatId: subchatId,
      activeSubchatParentId: parentId,
      activeSubchatTitle: title,
      activeSubchatType: subagentType,
      isSubchatDrawerOpen: true,
    }),
  closeSubchatDrawer: () =>
    set({
      isSubchatDrawerOpen: false,
      activeSubchatId: null,
      activeSubchatParentId: null,
      activeSubchatTitle: null,
      activeSubchatType: null,
    }),
}));

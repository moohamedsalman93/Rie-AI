import { create } from "zustand";

export const useUIStore = create((set) => ({
  windowMode: "floating", // "floating" | "normal" | "kiosk"
  setWindowMode: (mode) => set({ windowMode: mode }),

  isOpen: true,
  setIsOpen: (isOpen) => set({ isOpen }),

  isSettingsOpen: false,
  setIsSettingsOpen: (isOpen) => set({ isSettingsOpen: isOpen }),

  isHistoryOpen: false,
  setIsHistoryOpen: (isOpen) => set({ isHistoryOpen: isOpen }),

  showWelcome: false,
  setShowWelcome: (show) => set({ showWelcome: show }),

  isTerminalOpen: false,
  setIsTerminalOpen: (isOpen) => set({ isTerminalOpen: isOpen }),

  terminalLogs: [],
  setTerminalLogs: (updater) =>
    set((state) => ({
      terminalLogs:
        typeof updater === "function"
          ? updater(state.terminalLogs)
          : updater,
    })),
  appendTerminalLog: (log) =>
    set((state) => ({
      terminalLogs: [...state.terminalLogs, log],
    })),

  isRecording: false,
  setIsRecording: (isRecording) => set({ isRecording }),

  privacyToast: null,
  setPrivacyToast: (toast) => set({ privacyToast: toast }),

  isMenuOpen: false,
  setIsMenuOpen: (isOpen) => set({ isMenuOpen: isOpen }),

  availableUpdate: null,
  setAvailableUpdate: (update) => set({ availableUpdate: update }),

  updateDownloaded: false,
  setUpdateDownloaded: (downloaded) => set({ updateDownloaded: downloaded }),

  updateDownloading: false,
  setUpdateDownloading: (downloading) => set({ updateDownloading: downloading }),

  updateDownloadProgress: 0,
  setUpdateDownloadProgress: (progress) => set({ updateDownloadProgress: progress }),

  showInstallDialog: false,
  setShowInstallDialog: (show) => set({ showInstallDialog: show }),
}));

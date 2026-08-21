import { create } from "zustand";
import { getSettings, updateSetting } from "../services/chatApi";

export const useSettingsStore = create((set, get) => ({
  settings: {},
  isLoaded: false,
  isLoading: false,
  error: null,

  setSettings: (settings) => set({ settings, isLoaded: true }),

  fetchSettings: async () => {
    set({ isLoading: true, error: null });
    try {
      const data = await getSettings();
      set({ settings: data || {}, isLoaded: true, isLoading: false });
      return data;
    } catch (err) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  updateSettingValue: async (key, value) => {
    try {
      await updateSetting(key, value);
      set((state) => ({
        settings: { ...state.settings, [key]: value },
      }));
    } catch (err) {
      set({ error: err.message });
      throw err;
    }
  },

  activeTab: "general",
  setActiveTab: (tab) => set({ activeTab: tab }),

  activeSubTab: null,
  setActiveSubTab: (subTab) => set({ activeSubTab: subTab }),

  searchQuery: "",
  setSearchQuery: (query) => set({ searchQuery: query }),
}));

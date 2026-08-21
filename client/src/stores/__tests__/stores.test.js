import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../useChatStore';
import { useSettingsStore } from '../useSettingsStore';
import { useUIStore } from '../useUIStore';

describe('Zustand Stores Suite', () => {
  beforeEach(() => {
    useChatStore.setState({
      activeThreadId: null,
      sessions: {},
      streamingThreads: new Set(),
      input: '',
      chatMode: 'agent',
      speedMode: 'thinking',
      pendingActions: {},
      error: null,
    });

    useSettingsStore.setState({
      settings: {},
      isLoaded: false,
      isLoading: false,
      error: null,
      activeTab: 'general',
      searchQuery: '',
    });

    useUIStore.setState({
      windowMode: 'floating',
      isOpen: true,
      isSettingsOpen: false,
      isHistoryOpen: false,
      showWelcome: false,
      isTerminalOpen: false,
      terminalLogs: [],
      isRecording: false,
      availableUpdate: null,
    });
  });

  describe('useChatStore', () => {
    it('updates activeThreadId and streaming status', () => {
      useChatStore.getState().setActiveThreadId('thread-123');
      expect(useChatStore.getState().activeThreadId).toBe('thread-123');

      useChatStore.getState().addStreamingThread('thread-123');
      expect(useChatStore.getState().streamingThreads.has('thread-123')).toBe(true);

      useChatStore.getState().removeStreamingThread('thread-123');
      expect(useChatStore.getState().streamingThreads.has('thread-123')).toBe(false);
    });

    it('manages chat input and modes', () => {
      useChatStore.getState().setInput('Hello world');
      expect(useChatStore.getState().input).toBe('Hello world');

      useChatStore.getState().setChatMode('chat');
      expect(useChatStore.getState().chatMode).toBe('chat');

      useChatStore.getState().setSpeedMode('flash');
      expect(useChatStore.getState().speedMode).toBe('flash');
    });

    it('handles HITL pending actions', () => {
      const action = { id: 'act-1', tool: 'terminal_tool', risk: 'HIGH' };
      useChatStore.getState().setPendingAction('thread-1', action);
      expect(useChatStore.getState().pendingActions['thread-1']).toEqual(action);

      useChatStore.getState().clearPendingAction('thread-1');
      expect(useChatStore.getState().pendingActions['thread-1']).toBeUndefined();
    });
  });

  describe('useSettingsStore', () => {
    it('manages settings and tabs', () => {
      useSettingsStore.getState().setSettings({ LLM_PROVIDER: 'groq' });
      expect(useSettingsStore.getState().settings.LLM_PROVIDER).toBe('groq');
      expect(useSettingsStore.getState().isLoaded).toBe(true);

      useSettingsStore.getState().setActiveTab('capabilities');
      expect(useSettingsStore.getState().activeTab).toBe('capabilities');

      useSettingsStore.getState().setSearchQuery('openai');
      expect(useSettingsStore.getState().searchQuery).toBe('openai');
    });
  });

  describe('useUIStore', () => {
    it('manages modal and window states', () => {
      useUIStore.getState().setWindowMode('normal');
      expect(useUIStore.getState().windowMode).toBe('normal');

      useUIStore.getState().setIsSettingsOpen(true);
      expect(useUIStore.getState().isSettingsOpen).toBe(true);

      useUIStore.getState().appendTerminalLog('Executing test command...');
      expect(useUIStore.getState().terminalLogs).toContain('Executing test command...');
    });
  });
});

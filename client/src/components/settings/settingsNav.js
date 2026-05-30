import {
  Cpu,
  Wrench,
  Volume2,
  Shield,
  Brain,
  Activity,
  Workflow,
} from 'lucide-react';

/** @typedef {'assistant'|'capabilities'|'voice'|'memory'|'privacy'|'diagnostics'|'advanced'} SettingsTabId */

export const LEGACY_TAB_MAP = {
  provider: 'assistant',
  tools: 'capabilities',
  general: 'privacy',
  logs: 'diagnostics',
  voice: 'voice',
  observability: 'diagnostics',
  orchestration: 'advanced',
  connectivity: 'advanced',
};

export const DEFAULT_TAB = 'assistant';

export function normalizeTabId(tab) {
  if (!tab) return DEFAULT_TAB;
  return LEGACY_TAB_MAP[tab] || tab;
}

export function normalizeSubTab(tab, subTab) {
  if (tab === 'diagnostics') {
    if (subTab === 'observability' || subTab === 'tracing') return 'tracing';
    if (subTab === 'logs') return 'logs';
    return subTab || 'logs';
  }
  if (tab === 'advanced') {
    if (subTab === 'connectivity' || subTab === 'remote') return 'remote';
    if (subTab === 'orchestration') return 'orchestration';
    return subTab || 'orchestration';
  }
  if (tab === 'capabilities') {
    if (subTab === 'builtin' || subTab === 'mcp' || subTab === 'external') return subTab;
    return subTab || 'builtin';
  }
  return subTab || null;
}

export const SETTINGS_NAV_GROUPS = [
  {
    id: 'core',
    label: 'Core',
    tabs: [
      { id: 'assistant', label: 'Assistant', icon: Cpu },
      { id: 'capabilities', label: 'Tools & APIs', icon: Wrench },
      { id: 'voice', label: 'Voice', icon: Volume2 },
      { id: 'memory', label: 'Memory', icon: Brain },
    ],
  },
  {
    id: 'system',
    label: 'System',
    tabs: [
      { id: 'privacy', label: 'Privacy & system', icon: Shield },
      { id: 'diagnostics', label: 'Diagnostics', icon: Activity },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    tabs: [{ id: 'advanced', label: 'Advanced', icon: Workflow }],
  },
];

export const DIAGNOSTICS_SUB_TABS = [
  { id: 'logs', label: 'Logs', description: 'Local backend log output' },
  { id: 'tracing', label: 'Tracing', description: 'Optional LangSmith cloud tracing' },
];

export const ADVANCED_SUB_TABS = [
  { id: 'orchestration', label: 'Orchestration' },
  { id: 'remote', label: 'Remote access' },
];

export const CAPABILITY_SUB_TABS = [
  { id: 'builtin', label: 'Built-in Tools' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'external', label: 'External APIs' },
];

/** Search index: query tokens → tab (+ optional subTab) */
export const SETTINGS_SEARCH_INDEX = [
  { terms: ['assistant', 'provider', 'llm', 'gemini', 'groq', 'openai', 'ollama', 'vertex', 'rie', 'api key', 'model'], tab: 'assistant' },
  { terms: ['tools', 'capabilities', 'builtin', 'terminal', 'mouse', 'keyboard', 'desktop', 'mcp', 'external api'], tab: 'capabilities' },
  { terms: ['tavily', 'brave', 'duckduckgo', 'internet search', 'web search', 'web search provider'], tab: 'memory' },
  { terms: ['web search tool'], tab: 'capabilities', subTab: 'builtin' },
  { terms: ['voice', 'tts', 'speech', 'edge tts', 'orpheus', 'voice reply'], tab: 'voice' },
  { terms: ['memory', 'embedding', 'ltm', 'bundled', 'nomic'], tab: 'memory' },
  { terms: ['privacy', 'security', 'hitl', 'terminal restrictions', 'location', 'share location', 'gps'], tab: 'privacy' },
  { terms: ['auto-start', 'autostart', 'launch', 'about', 'docs', 'documentation'], tab: 'privacy' },
  { terms: ['logs', 'debug', 'system logs'], tab: 'diagnostics', subTab: 'logs' },
  { terms: ['langsmith', 'tracing', 'observability', 'trace'], tab: 'diagnostics', subTab: 'tracing' },
  { terms: ['orchestration', 'planner', 'solo', 'team', 'agent mode'], tab: 'advanced', subTab: 'orchestration' },
  { terms: ['connectivity', 'ngrok', 'pairing', 'remote', 'friends', 'tunnel'], tab: 'advanced', subTab: 'remote' },
];

export function searchSettings(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const entry of SETTINGS_SEARCH_INDEX) {
    if (entry.terms.some((t) => t.includes(q) || q.includes(t))) {
      return { tab: entry.tab, subTab: entry.subTab || null };
    }
  }
  for (const group of SETTINGS_NAV_GROUPS) {
    for (const tab of group.tabs) {
      if (tab.label.toLowerCase().includes(q) || tab.id.includes(q)) {
        return { tab: tab.id, subTab: null };
      }
    }
  }
  return null;
}

export function filterNavGroups(query) {
  const q = query.trim().toLowerCase();
  if (!q) return SETTINGS_NAV_GROUPS;
  const match = searchSettings(q);
  if (match) {
    return SETTINGS_NAV_GROUPS.map((g) => ({
      ...g,
      tabs: g.tabs.filter((t) => t.id === match.tab),
    })).filter((g) => g.tabs.length > 0);
  }
  return SETTINGS_NAV_GROUPS.map((g) => ({
    ...g,
    tabs: g.tabs.filter(
      (t) => t.label.toLowerCase().includes(q) || t.id.includes(q)
    ),
  })).filter((g) => g.tabs.length > 0);
}

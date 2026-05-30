import { Sparkles, Cloud, Zap, Globe, Cpu } from 'lucide-react';

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', icon: <Sparkles className="w-5 h-5" /> },
  vertex: { label: 'Vertex AI', icon: <Cloud className="w-5 h-5" /> },
  groq: { label: 'Groq', icon: <Zap className="w-5 h-5" /> },
  openai: { label: 'OpenAI', icon: <Globe className="w-5 h-5" /> },
  rie: { label: 'Rie', icon: <Sparkles className="w-5 h-5" /> },
  ollama: { label: 'Ollama', icon: <Cpu className="w-5 h-5" /> },
};

export const AVAILABLE_TOOLS = [
  { id: 'internet_search', label: 'Internet Search', desc: 'Allows searching the web for information.' },
  { id: 'run_terminal_command', label: 'System Terminal', desc: 'Execute commands on the Windows system.' },
  { id: 'get_desktop_state', label: 'Desktop State', desc: 'Captures current desktop state and interactive elements.' },
  { id: 'app_control', label: 'App Control', desc: 'Launch, resize, or switch Windows applications.' },
  { id: 'mouse_click', label: 'Mouse Click', desc: 'Performs a mouse click at specific coordinates.' },
  { id: 'keyboard_type', label: 'Keyboard Type', desc: 'Types text at specific coordinates.' },
  { id: 'move_mouse', label: 'Move Mouse', desc: 'Moves the mouse cursor to specific coordinates.' },
  { id: 'scroll_mouse', label: 'Scroll Mouse', desc: 'Scrolls vertically or horizontally.' },
  { id: 'drag_mouse', label: 'Drag Mouse', desc: 'Drags from current position to target coordinates.' },
  { id: 'press_keys', label: 'Press Keys', desc: 'Presses keyboard shortcuts or keys.' },
  { id: 'scrape_web', label: 'Scrape Web', desc: 'Scrapes content from a URL or active browser tab.' },
  { id: 'wait', label: 'Wait', desc: 'Pauses execution for a specified duration.' },
];

export const PEER_MEMORY_TOOL_IDS = ['save_memory', 'get_memory', 'search_memory'];

export const WEB_SEARCH_PROVIDERS = {
  tavily: {
    label: 'Tavily',
    requiresKey: true,
    keyDb: 'TAVILY_API_KEY',
    keyField: 'tavily_api_key',
    placeholder: 'tvly-...',
  },
  brave: {
    label: 'Brave Search',
    requiresKey: true,
    keyDb: 'BRAVE_SEARCH_API_KEY',
    keyField: 'brave_search_api_key',
    placeholder: 'BSA...',
  },
  duckduckgo: {
    label: 'DuckDuckGo',
    requiresKey: false,
    description:
      'No API key required. Uses an unofficial client — search can be slow, fail, or rate-limit. Not recommended for daily use; prefer Tavily or Brave for stability.',
  },
};

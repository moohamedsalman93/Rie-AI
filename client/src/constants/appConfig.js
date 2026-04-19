// Window sizes (logical pixels)
export const WINDOW_SIZES = {
  CHAT: { width: 360, height: 520 },
  NORMAL: { width: 988, height: 629 },
  BUBBLE: { width: 180, height: 50 },
  SETTINGS: { width: 988, height: 629 },
  LOADING: { width: 520, height: 420 },
};

export const ANIMATION_DURATIONS = {
  SNAP: 300,
  MORPH: 600,
  DRAG_SETTLE: 100, // ms
};

export const SNAP_MARGIN = 0;
export const SNAP_THRESHOLD = 20;
export const POSITION_CHECK_INTERVAL = 50;
export const POSITION_STABLE_THRESHOLD = 3;

export const TOOL_DISPLAY_NAMES = {
  internet_search: "Searching...",
  get_ui_elements: "Reading Screen",
  mouse_move: "Moving",
  mouse_click: "Clicking",
  type_text: "Typing",
  list_windows: "Checking Windows",
  get_full_screen_ui: "Looking",
  get_taskbar_ui: "Checking Taskbar",
  run_terminal_command: "Running Shell",
};

export const getToolDisplayName = (name) => {
  if (!name) return "";
  if (TOOL_DISPLAY_NAMES[name]) return TOOL_DISPLAY_NAMES[name];

  // Fallback: convert snake_case to Title Case
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

export const initialMessages = [
  {
    id: 1,
    from: "bot",
    blocks: [{ type: "text", text: "Hey! I'm Rie-AI, your floating chat assistant. Drag me by the top bar, or minimize me to a bubble. How can I help you today?" }],
  },
];

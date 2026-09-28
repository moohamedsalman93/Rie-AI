/**
 * Rie Context — Browser Companion Background Service Worker (Manifest V3)
 * Compatible with Brave, Google Chrome, and Microsoft Edge.
 *
 * Sends active tab URL, page title, browser name, timestamp, and tab switch events
 * to the local Rie backend (POST /workstream/events).
 */

const DEFAULT_CONFIG = {
  endpoint: "http://localhost:14300/workstream/events",
  isPaused: false,
  ignoreIncognito: true,
  eventsCount: 0,
  connectionStatus: "connecting", // "connected" | "disconnected" | "paused"
};

// In-memory state for debounce and duration tracking
let cachedBrowser = null;
let currentTabState = {
  url: null,
  title: null,
  startTime: null,
  tabId: null,
};
let lastSentEvent = {
  url: null,
  title: null,
  time: 0,
};
let offlineQueue = [];
const MAX_OFFLINE_QUEUE = 30;

/**
 * Detects the browser name (Brave, Edge, Chrome, or generic Browser).
 */
async function detectBrowser() {
  if (cachedBrowser) return cachedBrowser;

  try {
    if (navigator.brave && typeof navigator.brave.isBrave === "function") {
      const isBrave = await navigator.brave.isBrave();
      if (isBrave) {
        cachedBrowser = "Brave";
        return cachedBrowser;
      }
    }
  } catch (e) {
    // navigator.brave check not supported or threw
  }

  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) {
    cachedBrowser = "Edge";
  } else if (ua.includes("OPR/") || ua.includes("Opera/")) {
    cachedBrowser = "Opera";
  } else if (ua.includes("Vivaldi/")) {
    cachedBrowser = "Vivaldi";
  } else if (ua.includes("Chrome")) {
    cachedBrowser = "Chrome";
  } else {
    cachedBrowser = "Browser";
  }

  return cachedBrowser;
}

/**
 * Retrieves configuration from chrome.storage.local with defaults.
 */
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_CONFIG, (items) => {
      resolve(items);
    });
  });
}

/**
 * Updates extension icon badge to reflect status.
 */
function updateBadge(status) {
  try {
    if (status === "paused") {
      chrome.action.setBadgeText({ text: "II" });
      chrome.action.setBadgeBackgroundColor({ color: "#6B7280" });
    } else if (status === "disconnected") {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#EF4444" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {
    // Badge might fail in some contexts, safe to ignore
  }
}

/**
 * Validates if a URL is eligible for workstream tracking.
 */
function isTrackableUrl(url) {
  if (!url || typeof url !== "string") return false;

  const lower = url.trim().toLowerCase();
  // Filter internal browser pages and sensitive protocols
  const ignoredPrefixes = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "brave://",
    "about:",
    "devtools://",
    "view-source:",
    "data:",
    "blob:",
    "javascript:",
  ];

  for (const prefix of ignoredPrefixes) {
    if (lower.startsWith(prefix)) return false;
  }

  // Filter sensitive domains (password managers, banking)
  const sensitiveKeywords = [
    "bitwarden.com",
    "1password.com",
    "lastpass.com",
    "dashlane.com",
    "keepersecurity.com",
    "login.live.com",
    "accounts.google.com",
  ];

  for (const kw of sensitiveKeywords) {
    if (lower.includes(kw)) return false;
  }

  return true;
}

let remoteConfig = {
  workstream: true,
  sensors: { browser: true },
  privacy: { track_urls: true },
};
let lastConfigSync = 0;

/**
 * Periodically syncs sensor enablement state with the local Rie backend.
 */
async function syncRemoteConfig() {
  const now = Date.now();
  if (now - lastConfigSync < 10000) {
    return remoteConfig;
  }
  try {
    const res = await fetch("http://localhost:14300/workstream/config", {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      remoteConfig = await res.json();
      lastConfigSync = now;
      chrome.storage.local.set({ remoteConfig });
    }
  } catch (e) {
    // If backend is offline, retain cached state
  }
  return remoteConfig;
}

/**
 * Sends a browser event payload to the Rie backend.
 */
async function sendToBackend(payload) {
  const config = await getConfig();
  const rConfig = await syncRemoteConfig();

  if (config.isPaused || !rConfig.workstream || (rConfig.sensors && rConfig.sensors.browser === false)) {
    updateBadge("paused");
    return false;
  }

  const endpoint = config.endpoint || DEFAULT_CONFIG.endpoint;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const data = await res.json();
      const updatedCount = (config.eventsCount || 0) + 1;
      
      chrome.storage.local.set({
        eventsCount: updatedCount,
        lastEvent: payload,
        connectionStatus: "connected",
        lastActiveTime: new Date().toISOString(),
      });
      updateBadge("connected");

      // If we had buffered events, flush them
      if (offlineQueue.length > 0) {
        flushOfflineQueue(endpoint);
      }
      return true;
    } else {
      console.warn(`[Rie Extension] Server returned error ${res.status}`);
      handleOfflineEvent(payload);
      return false;
    }
  } catch (err) {
    // Network failure (server is offline or port is closed)
    handleOfflineEvent(payload);
    return false;
  }
}

/**
 * Buffers event when backend is temporarily unreachable.
 */
function handleOfflineEvent(payload) {
  chrome.storage.local.set({ connectionStatus: "disconnected" });
  updateBadge("disconnected");

  if (offlineQueue.length >= MAX_OFFLINE_QUEUE) {
    offlineQueue.shift();
  }
  offlineQueue.push(payload);
}

/**
 * Attempts to flush offline queued events once backend is online.
 */
async function flushOfflineQueue(endpoint) {
  if (offlineQueue.length === 0) return;

  const toFlush = [...offlineQueue];
  offlineQueue = [];

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toFlush),
    });
  } catch (e) {
    // Put back items if failed
    offlineQueue = [...toFlush, ...offlineQueue].slice(-MAX_OFFLINE_QUEUE);
  }
}

/**
 * Handles active tab focus, URL navigation, or title change.
 */
async function handleTabEvent(tab, eventType = "browser_tab") {
  if (!tab || !tab.url) return;

  const config = await getConfig();
  if (config.isPaused) return;

  // Remote Jarvis Sensor Control: If workstream or browser sensor is disabled, STOP collection!
  const rConfig = await syncRemoteConfig();
  if (!rConfig.workstream || (rConfig.sensors && rConfig.sensors.browser === false)) {
    updateBadge("paused");
    return;
  }

  // Privacy control: Don't track URLs if disabled
  if (rConfig.privacy && rConfig.privacy.track_urls === false) {
    return;
  }

  // Ignore incognito if configured
  if (tab.incognito && config.ignoreIncognito) return;

  // Verify URL is trackable
  if (!isTrackableUrl(tab.url)) return;

  const now = Date.now();
  const title = (tab.title || tab.url).trim();
  const url = tab.url.trim();

  // Deduplication / Debounce: Skip if identical URL & title within 2 seconds
  if (
    lastSentEvent.url === url &&
    lastSentEvent.title === title &&
    now - lastSentEvent.time < 2000
  ) {
    return;
  }

  // Calculate duration on previous tab
  let durationSeconds = 0;
  if (currentTabState.startTime && currentTabState.url) {
    durationSeconds = Math.max(0, Math.round((now - currentTabState.startTime) / 1000));
  }

  const browserName = await detectBrowser();

  const payload = {
    event_type: eventType,
    browser: browserName,
    url: url,
    title: title,
    timestamp: new Date().toISOString(),
    duration_seconds: durationSeconds,
  };

  // Update in-memory state
  lastSentEvent = {
    url: url,
    title: title,
    time: now,
  };

  currentTabState = {
    url: url,
    title: title,
    startTime: now,
    tabId: tab.id,
  };

  // Transmit to backend
  await sendToBackend(payload);
}

/**
 * Chrome Tabs: On tab activated (user clicks or switches tab)
 */
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.active) {
      await handleTabEvent(tab, "browser_tab");
    }
  } catch (e) {
    // Tab may have closed immediately
  }
});

/**
 * Chrome Tabs: On tab updated (URL navigation, title loaded)
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only trigger when URL or title changes and page is active
  if (tab && tab.active && (changeInfo.url || changeInfo.title || changeInfo.status === "complete")) {
    await handleTabEvent(tab, "browser_tab");
  }
});

/**
 * Chrome Windows: On focus changed (user switches to/from browser window)
 */
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: windowId });
    if (activeTab) {
      await handleTabEvent(activeTab, "browser_tab");
    }
  } catch (e) {
    // Window may have closed
  }
});

/**
 * Message listener for communication with popup.js
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    (async () => {
      const config = await getConfig();
      const browser = await detectBrowser();
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      sendResponse({
        success: true,
        browser: browser,
        config: config,
        currentTab: currentTab ? { url: currentTab.url, title: currentTab.title } : null,
        queueLength: offlineQueue.length,
      });
    })();
    return true; // Keep channel open for async response
  }

  if (message.type === "TEST_CONNECTION") {
    (async () => {
      const config = await getConfig();
      const serverBase = (config.endpoint || DEFAULT_CONFIG.endpoint).replace(/\/workstream\/events\/?$/, "");
      const statusUrl = `${serverBase}/workstream/status`;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const start = Date.now();
        const res = await fetch(statusUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        const latency = Date.now() - start;

        if (res.ok) {
          const data = await res.json();
          chrome.storage.local.set({ connectionStatus: "connected" });
          updateBadge("connected");
          sendResponse({ success: true, latency: latency, data: data });
        } else {
          chrome.storage.local.set({ connectionStatus: "disconnected" });
          updateBadge("disconnected");
          sendResponse({ success: false, error: `HTTP ${res.status}` });
        }
      } catch (err) {
        chrome.storage.local.set({ connectionStatus: "disconnected" });
        updateBadge("disconnected");
        const errMsg = err.name === "AbortError" ? "Connection timed out (server not responding)" : (err.message || "Connection refused");
        sendResponse({ success: false, error: errMsg });
      }
    })();
    return true;
  }

  if (message.type === "TOGGLE_PAUSE") {
    (async () => {
      const config = await getConfig();
      const newPaused = !config.isPaused;
      await chrome.storage.local.set({
        isPaused: newPaused,
        connectionStatus: newPaused ? "paused" : "connected",
      });
      updateBadge(newPaused ? "paused" : "connected");
      sendResponse({ success: true, isPaused: newPaused });
    })();
    return true;
  }
});

// Initialization
(async () => {
  const browser = await detectBrowser();
  chrome.storage.local.set({ detectedBrowser: browser });
  console.log(`[Rie Context Extension] Initialized on ${browser}`);
})();

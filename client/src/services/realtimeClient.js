/**
 * Single WebSocket to the backend /ws endpoint: scheduler notifications, history, connectivity, optional log tail.
 */
import { getAppToken, getApiBaseUrl } from "./chatApi";

const BASE_TOPICS = [
  "scheduler_notifications",
  "scheduler_tasks",
  "history",
  "connectivity",
];

let ws = null;
let reconnectTimer = null;
let started = false;
let apiOnline = false;
let logsEnabled = false;
const handlers = new Set();
let logsHandler = null;

function buildWsUrl() {
  let origin;
  try {
    origin = new URL(getApiBaseUrl()).origin;
  } catch {
    origin = "http://localhost:14300";
  }
  const u = new URL(origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  const token = getAppToken();
  if (token) u.searchParams.set("token", token);
  return u.href;
}

function currentTopics() {
  const t = [...BASE_TOPICS];
  if (logsEnabled) t.push("logs");
  return t;
}

function syncSubscribe() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "subscribe", topics: currentTopics() }));
    } catch {
      /* ignore */
    }
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (started && apiOnline) connect();
  }, 2500);
}

function connect() {
  if (!started || !apiOnline) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  try {
    ws = new WebSocket(buildWsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    syncSubscribe();
  };

  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.type !== "event" || !data.topic) return;
    if (data.topic === "logs") {
      if (typeof logsHandler === "function") logsHandler(data.payload || {});
      return;
    }
    if (data.topic === "scheduler_tasks") {
      window.dispatchEvent(new CustomEvent("rie-scheduler-tasks-refresh"));
      return;
    }
    handlers.forEach((fn) => {
      try {
        fn(data.topic, data.payload || {});
      } catch {
        /* ignore */
      }
    });
  };

  ws.onclose = () => {
    ws = null;
    if (started && apiOnline) scheduleReconnect();
  };

  ws.onerror = () => {};
}

/**
 * @param {(topic: string, payload: object) => void} fn
 * @returns {() => void}
 */
export function registerRealtimeHandler(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

/** Enable live log tail subscription (snapshot + append). Pass null to disable. */
export function setLogsRealtimeHandler(fn) {
  logsHandler = typeof fn === "function" ? fn : null;
}

export function setRealtimeLogsEnabled(on) {
  logsEnabled = Boolean(on);
  syncSubscribe();
}

export function startRealtime(isOnline) {
  apiOnline = Boolean(isOnline);
  started = true;
  if (!apiOnline) {
    stopRealtime();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
}

export function stopRealtime() {
  started = false;
  apiOnline = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

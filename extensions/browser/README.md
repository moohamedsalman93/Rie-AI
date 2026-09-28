# 🌐 Rie Context — Browser Companion (Phase 2.1)

A lightweight browser extension for **Brave**, **Google Chrome**, and **Microsoft Edge** (Manifest V3) that continuously streams active tab context to your local Rie AI assistant.

---

## ⚡ How It Works

```text
Browser Extension (Chrome / Brave / Edge)
       ↓ (Active tab URL, title, browser name, timestamp, switch events)
POST /workstream/events
       ↓
SQLite (activity_events + FTS5 full-text index)
       ↓
search_activity() / get_activity_timeline() / get_work_summary()
       ↓
Rie (AI Agent & Live Voice Session)
```

### Event Payload Schema
Every time you switch tabs, navigate to a new page, or focus the browser, the extension sends:
```json
{
  "event_type": "browser_tab",
  "browser": "Brave",
  "url": "https://github.com/...",
  "title": "Pull Request #347",
  "timestamp": "2026-09-25T17:30:00.000Z",
  "duration_seconds": 18
}
```

---

## 🚀 Installation & Setup

You can load this unpacked extension into **Brave**, **Google Chrome**, or **Microsoft Edge** in seconds:

### In Brave:
1. Open `brave://extensions` in the address bar.
2. Turn on the **Developer mode** toggle in the top-right corner.
3. Click the **Load unpacked** button.
4. Select the folder:
   ```text
   d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\browser
   ```

### In Google Chrome:
1. Open `chrome://extensions` in the address bar.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder `app/extensions/browser`.

### In Microsoft Edge:
1. Open `edge://extensions` in the address bar.
2. Turn on **Developer mode** in the left sidebar.
3. Click **Load unpacked** and select the folder `app/extensions/browser`.

---

## 🎨 Features & Privacy Controls

1. **Auto Browser Detection**:
   - Automatically identifies whether you are running in Brave, Chrome, or Edge.
2. **Debounce & Deduplication**:
   - Filters out redundant navigation pulses within 2 seconds.
   - Computes active focus duration spent on the previous tab.
3. **Privacy First**:
   - Automatically ignores browser internal URLs (`chrome://`, `edge://`, `brave://`, `about:`, `devtools://`, `chrome-extension://`).
   - Automatically ignores sensitive domains (e.g. password managers, banking).
   - Excludes Incognito / Private tabs by default.
   - Quick one-click **Pause / Resume** toggle in popup.
4. **Offline Resilience**:
   - If the Rie backend is restarting or temporarily offline, buffers up to 30 events in memory and flushes them automatically upon reconnection.
5. **Modern Glassmorphic Popup**:
   - Real-time connection badge (Connected / Offline / Paused).
   - Live Active Tab preview.
   - Total event counter.
   - **Test Connection** button that pings the local Rie server and reports latency and SQLite event counts.
   - Configurable Rie server URL (default: `http://localhost:14300/workstream/events`).

---

## 🧪 Verification & Testing

Once loaded:
1. Click the Rie extension icon in your browser toolbar.
2. Click **Test Connection** — you will see a green checkmark showing latency and database activity.
3. Browse to a few pages (e.g. GitHub PR, docs, articles).
4. Ask Rie:
   - *"What was that GitHub PR I was looking at?"*
   - *"What articles or docs was I reading 10 minutes ago?"*
   - Or test via API:
     ```bash
     curl "http://localhost:14300/workstream/search?q=github"
     ```

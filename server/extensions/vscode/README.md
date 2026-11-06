# 💻 Rie Context — VS Code & Antigravity (Phase 2.2)

A lightweight extension for **Antigravity IDE** and **Visual Studio Code** that streams active workspace context, active file path, programming language, git branch, and save diff statistics to your local Rie AI assistant.

---

## ⚡ How It Works

```text
Antigravity / VS Code
       ↓ (Workspace, File, Language, Git Branch, File Save Diffs)
POST /workstream/events
       ↓
SQLite (activity_events table + FTS5 full-text index)
       ↓
search_activity() / get_activity_timeline() / get_work_summary()
       ↓
Rie (AI Agent & Live Voice Session)
```

---

## 📄 Event Payloads

### 1. Active File / Context Shift
Fires when switching tabs or focusing an editor:
```json
{
  "event_type": "ide_context",
  "ide": "Antigravity",
  "workspace": "Rie-AI",
  "file": "app/server/app/live_tool_dispatcher.py",
  "language": "Python",
  "git_branch": "workstream",
  "git_status": "modified",
  "timestamp": "2026-09-25T18:00:00.000Z"
}
```

### 2. Meaningful File Change on Save
Fires when a file is saved:
```json
{
  "event_type": "file_change",
  "ide": "Antigravity",
  "workspace": "Rie-AI",
  "file": "live_tool_dispatcher.py",
  "lines_added": 14,
  "lines_removed": 6,
  "timestamp": "2026-09-25T18:01:00.000Z"
}
```

---

## 🔒 Privacy & Performance Guarantees

- **No Keystroke Tracking**: Never intercepts or records individual keystrokes.
- **No Continuous Buffer Capture**: Never sends full file contents or intermediate typing buffers.
- **Save-Only Diffs**: Only computes line deltas (+lines / -lines) upon explicit file save.
- **Debounced Context**: 1-second debounce prevents spamming when quickly switching tabs or skimming files.
- **Offline Buffering**: Caches up to 30 events in memory if the backend is restarting and flushes them automatically upon reconnection.

---

## 🚀 Installation

### For Antigravity IDE:
Copy this extension folder to your Antigravity extensions directory:
```powershell
Copy-Item -Recurse "d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\vscode" "C:\Users\mooha\.antigravity-ide\extensions\rie-context" -Force
```
Then restart or reload Antigravity (`Ctrl+Shift+P` -> `Developer: Reload Window`).

### For VS Code:
Copy this extension folder to your VS Code extensions directory:
```powershell
Copy-Item -Recurse "d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\vscode" "$env:USERPROFILE\.vscode\extensions\rie-context" -Force
```
Then reload VS Code (`Ctrl+Shift+P` -> `Developer: Reload Window`).

---

## ⚙️ Extension Settings & Commands

### Status Bar:
A status item `$(zap) Rie: Active` appears in the bottom status bar:
- Click it to view quick actions, pause/resume tracking, or test connection.

### Commands (`Ctrl+Shift+P`):
- `Rie: Test Connection`: Ping local Rie Workstream API and report latency and SQLite stats.
- `Rie: Toggle Context Tracking`: Instantly pause or resume tracking.
- `Rie: Show Status`: View total events transmitted this session.

### Settings (`settings.json`):
- `rie.endpoint`: Default `http://localhost:14300/workstream/events`.
- `rie.enabled`: Enable/disable context streaming (default: `true`).
- `rie.trackFileChanges`: Send save diff stats (default: `true`).
- `rie.debounceSeconds`: Seconds to debounce rapid file switches (default: `1`).

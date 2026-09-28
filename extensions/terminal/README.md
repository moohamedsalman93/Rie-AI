# 🖥️ Rie Context — Terminal & Shell Integration (Phase 2.3)

Lightweight shell integration for **PowerShell**, **CMD**, and **Git Bash** that streams executed commands, working directories, exit codes, and durations to your local Rie AI assistant.

---

## ⚡ How It Works

```text
PowerShell (prompt hook) ──┐
CMD (doskey / clink) ─────┼──► POST /workstream/events ──► SQLite (activity_events + FTS5) ──► Rie
Git Bash (PROMPT_COMMAND) ─┘
```

Rie captures command execution context **only when a command finishes**, not while you are typing:

```text
Terminal
 ├── command            (e.g. poetry run python -m pytest tests/test_workstream.py)
 ├── shell              (PowerShell / CMD / Git Bash)
 ├── working directory  (e.g. D:\professional\code\Rie-AI\app\server)
 ├── exit code          (0 = success, non-zero = failure)
 ├── timestamp          (ISO-8601 UTC)
 └── duration           (seconds elapsed, e.g. 1.45s)
```

---

## 💬 What Rie Can Answer

Once shell tracking is active, you can ask Rie in chat or live voice:

- **“What commands did I run while working on Rie today?”**
  Rie queries `get_terminal_history(cwd="Rie-AI")` and returns the chronological list of commands you ran.
- **“What was the last test I ran?”**
  Rie inspects `get_work_summary()` or `get_terminal_history(query="test")` to find the most recent pytest/unittest/npm test command.
- **“What did I do before the tests started failing?”**
  Rie queries `get_activity_timeline()` or `get_terminal_history()` leading up to the failed exit code.
- **“What project was I working on in the terminal?”**
  Rie extracts the distinct working directories from `terminal_activity` across your sessions.

---

## 📄 Event Wire Format

```json
{
  "event_type": "terminal_command",
  "shell": "PowerShell",
  "command": "poetry run python -m pytest tests/test_workstream.py",
  "cwd": "D:\\professional\\code\\Rie-AI\\app\\server",
  "exit_code": 0,
  "duration": 5.43,
  "timestamp": "2026-09-26T22:38:38.000Z"
}
```

---

## 🔒 Privacy & Performance Guarantees

1. **Zero Keystroke Logging**: Keystrokes are NEVER recorded or intercepted. Only completed commands from the shell's command execution history are inspected.
2. **Sensitive Keyword Filtering**: Commands containing passwords, secrets, tokens, api keys, or private keys (`password`, `secret`, `api_key`, `token`, `bearer`, `credential`, `id_rsa`, `private_key`) are automatically excluded before sending.
3. **Non-Blocking Execution (0ms Prompt Delay)**:
   - **PowerShell**: Queues HTTP POST on background thread pool (`[System.Threading.ThreadPool]::QueueUserWorkItem`).
   - **Git Bash**: Dispatches HTTP POST via background subshell `(curl ... &) >/dev/null 2>&1`.
   - **CMD**: Launches detached background process `start /B "" curl.exe ...`.
   Your terminal prompt returns immediately with zero perceived latency.
4. **Resilient & Silent**: If the Rie server is restarting or offline, connection errors are silently ignored and your terminal never hangs or errors.

---

## 🚀 Installation

Run the unified installer script with PowerShell:

```powershell
# Check current installation status
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Status

# Install for PowerShell + Git Bash (Recommended)
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

# Install for PowerShell, Git Bash, and CMD AutoRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -InstallCMD

# Test submission against running Rie backend
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Test

# Uninstall integrations anytime
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

### Manual Configuration

#### PowerShell (`$PROFILE`)
Add this line to your `$PROFILE`:
```powershell
if (Test-Path "d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\terminal\rie-shell-powershell.ps1") {
    . "d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\terminal\rie-shell-powershell.ps1"
}
```

#### Git Bash (`~/.bashrc`)
Add this line to your `~/.bashrc`:
```bash
if [ -f "d:/professional/code/reactjs/reactjs/Rie-AI/app/extensions/terminal/rie-shell-bash.sh" ]; then
    source "d:/professional/code/reactjs/reactjs/Rie-AI/app/extensions/terminal/rie-shell-bash.sh"
fi
```

#### CMD
Run any command tracked on demand:
```cmd
"d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\terminal\rie-shell-cmd.bat" run pytest
```
Or start an interactive tracked session:
```cmd
"d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\terminal\rie-shell-cmd.bat" /session
```
Or initialize doskey macros in the current shell:
```cmd
"d:\professional\code\reactjs\reactjs\Rie-AI\app\extensions\terminal\rie-shell-cmd.bat" /init
```

"""
Unit tests for Terminal Context v2: PowerShell, CMD, Git Bash integration.
Verifies command tracking without keystroke logging, interrupted commands, running commands, and history search.
"""
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import uuid

from app.workstream.models import TerminalEvent, ActivityEvent
from app.workstream.store import WorkstreamStore
from app.workstream.search import WorkstreamSearch
from app.workstream.tools import (
    get_terminal_history_func,
    get_running_terminal_commands_func,
    get_terminal_history_tool,
    get_running_terminal_commands_tool,
)


class TestTerminalUniqueContext(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test_terminal_unique.db"
        self.store = WorkstreamStore(db_path=self.db_path)
        self.search = WorkstreamSearch(store=self.store)

    def tearDown(self):
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_terminal_event_model_conversion_and_privacy(self):
        """Verifies TerminalEvent converts cleanly to ActivityEvent without keystroke logging."""
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        term_evt = TerminalEvent(
            shell="PowerShell",
            command="poetry run python -m pytest tests/test_workstream.py",
            cwd="D:\\professional\\code\\Rie-AI\\app\\server",
            exit_code=0,
            duration=3.5,
            timestamp=now_iso,
            status="completed"
        )

        act = term_evt.to_activity_event()
        self.assertEqual(act.event_type, "terminal_command")
        self.assertEqual(act.app_name, "PowerShell")
        self.assertEqual(act.source, "terminal")
        self.assertEqual(act.duration_seconds, 3.5)
        self.assertEqual(act.metadata["command"], "poetry run python -m pytest tests/test_workstream.py")
        self.assertEqual(act.metadata["exit_code"], 0)
        self.assertEqual(act.metadata["status"], "completed")

    def test_interrupted_command_capture(self):
        """
        Verifies capturing interrupted terminal commands (e.g. ping google.com + Ctrl+C -> 130).
        Rie must record the command, status='interrupted', and exit_code=130.
        """
        now = datetime.now(timezone.utc)
        cmd_id = str(uuid.uuid4())
        cmd = "ping google.com"

        # 1. Command starts running
        start_evt = ActivityEvent(
            timestamp=(now - timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            event_type="terminal_command",
            app_name="PowerShell",
            process_name="powershell.exe",
            window_title="PowerShell - ping google.com (running)",
            source="terminal_ext",
            duration_seconds=0.0,
            metadata={
                "command_id": cmd_id,
                "command": cmd,
                "shell": "PowerShell",
                "cwd": "D:\\professional\\code\\Rie-AI",
                "status": "running",
                "exit_code": None
            }
        )
        self.store.insert_activity_events([start_evt])

        # Verify it shows up as currently running
        running = self.search.get_running_commands()
        self.assertTrue(any(c["command"] == cmd for c in running))

        # 2. Command is interrupted with Ctrl+C (exit_code 130)
        finish_evt = ActivityEvent(
            timestamp=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            event_type="terminal_command",
            app_name="PowerShell",
            process_name="powershell.exe",
            window_title="PowerShell",
            source="terminal_ext",
            duration_seconds=4.2,
            metadata={
                "command_id": cmd_id,
                "command": cmd,
                "shell": "PowerShell",
                "cwd": "D:\\professional\\code\\Rie-AI",
                "status": "interrupted",
                "exit_code": 130
            }
        )
        self.store.insert_activity_events([finish_evt])

        # Verify it is no longer marked as running
        running_after = self.search.get_running_commands()
        self.assertFalse(any(c.get("command_id") == cmd_id for c in running_after))

        # Verify it appears in terminal history as interrupted
        history = self.search.get_terminal_history(query="ping google.com", interrupted_only=True)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["status"], "interrupted")
        self.assertEqual(history[0]["exit_code"], 130)
        self.assertIn("interrupted after", history[0]["summary_label"])

    def test_multi_shell_support(self):
        """Verifies command tracking across PowerShell, CMD, and Git Bash."""
        now = datetime.now(timezone.utc)
        shells = [
            ("PowerShell", "Get-Process | Where-Object WorkingSet -gt 100MB", "D:\\code", 0),
            ("CMD", "dir /s /b *.py", "C:\\Users", 0),
            ("Git Bash", "git diff --stat HEAD~1", "/d/professional/code", 0),
        ]

        evts = [
            ActivityEvent(
                timestamp=(now - timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name=shell,
                source="terminal_ext",
                duration_seconds=1.5,
                metadata={
                    "command": cmd,
                    "shell": shell,
                    "cwd": cwd,
                    "exit_code": code,
                    "status": "completed"
                }
            )
            for i, (shell, cmd, cwd, code) in enumerate(shells)
        ]
        self.store.insert_activity_events(evts)

        for shell, cmd, _, _ in shells:
            cmds = self.search.get_terminal_history(shell=shell)
            self.assertEqual(len(cmds), 1)
            self.assertEqual(cmds[0]["shell"], shell)
            self.assertEqual(cmds[0]["command"], cmd)


if __name__ == "__main__":
    unittest.main()

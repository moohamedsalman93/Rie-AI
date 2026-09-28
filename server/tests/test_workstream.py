"""
Unit tests for the Rie-AI Workstream Engine.
Tests SQLite/FTS5 storage, privacy filters, deduplication, retention, search, and agent tools using unittest.
"""
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import uuid

from app.workstream.models import (
    ActivityEvent,
    ClipboardEvent,
    BatchEventsRequest,
    WorkstreamPolicy,
    WorkSession,
    AggregateSessionsRequest,
)
from app.workstream.store import WorkstreamStore
from app.workstream.search import WorkstreamSearch, parse_timeframe
from app.workstream.session_aggregator import SessionAggregator, session_aggregator
from app.workstream.tools import (
    get_work_summary_tool,
    get_activity_timeline_tool,
    search_activity_tool,
    search_activity_func,
    get_terminal_history_tool,
    get_terminal_history_func,
    get_running_terminal_commands_tool,
    get_running_terminal_commands_func,
    get_work_sessions_tool,
    get_work_sessions_func,
    get_last_work_session_tool,
    get_last_work_session_func,
)



class TestWorkstreamEngine(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test_workstream.db"
        self.store = WorkstreamStore(db_path=self.db_path)
        self.search = WorkstreamSearch(store=self.store)
        self.aggregator = SessionAggregator(store=self.store)

    def tearDown(self):
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_workstream_init_and_stats(self):
        stats = self.store.get_stats()
        self.assertEqual(stats["total_activities"], 0)
        self.assertEqual(stats["total_clipboards"], 0)
        self.assertFalse(stats["is_paused"])
        self.assertIn("policy", stats)

    def test_insert_activity_events_and_privacy_filter(self):
        events = [
            ActivityEvent(
                event_type="window_focus",
                app_name="Visual Studio Code",
                process_name="Code.exe",
                window_title="live_voice.py - Rie-AI",
                duration_seconds=120.0
            ),
            ActivityEvent(
                event_type="window_focus",
                app_name="1Password",
                process_name="1password.exe",
                window_title="1Password Vault",
                duration_seconds=45.0
            ),
            ActivityEvent(
                event_type="window_focus",
                app_name="Google Chrome",
                process_name="chrome.exe",
                window_title="FastAPI WebSockets Documentation - Google Chrome",
                duration_seconds=300.0
            ),
        ]

        count = self.store.insert_activity_events(events)
        # 1Password should be excluded by privacy policy
        self.assertEqual(count, 2)

        stats = self.store.get_stats()
        self.assertEqual(stats["total_activities"], 2)

    def test_insert_clipboard_events_dedup_and_max_length(self):
        # Set small max length for testing
        policy = self.store.get_policy()
        policy.max_clipboard_length = 50
        self.store.update_policy(policy)

        clips = [
            ClipboardEvent(
                app_name="Visual Studio Code",
                content="async def handle_tool_call(): pass",
                content_type="code"
            ),
            # Duplicate consecutive copy
            ClipboardEvent(
                app_name="Visual Studio Code",
                content="async def handle_tool_call(): pass",
                content_type="code"
            ),
            # Long content
            ClipboardEvent(
                app_name="Notepad",
                content="A" * 100,
                content_type="text"
            ),
            # Sensitive app copy
            ClipboardEvent(
                app_name="Bitwarden",
                content="my_super_secret_password",
                content_type="text"
            )
        ]

        count = self.store.insert_clipboard_events(clips)
        # First item inserted, second deduplicated, third truncated & inserted, fourth excluded
        self.assertEqual(count, 2)

        stats = self.store.get_stats()
        self.assertEqual(stats["total_clipboards"], 2)

    def test_pause_and_resume(self):
        self.store.set_paused(True)
        self.assertTrue(self.store.is_paused())

        evt = ActivityEvent(
            event_type="window_focus",
            app_name="Terminal",
            process_name="pwsh.exe",
            window_title="poetry run pytest"
        )
        count = self.store.insert_activity_events([evt])
        self.assertEqual(count, 0)

        self.store.set_paused(False)
        self.assertFalse(self.store.is_paused())

        count = self.store.insert_activity_events([evt])
        self.assertEqual(count, 1)

    def test_retention_pruning(self):
        now = datetime.now(timezone.utc)
        old_time = (now - timedelta(days=90)).isoformat()
        recent_time = (now - timedelta(days=10)).isoformat()

        old_event = ActivityEvent(
            timestamp=old_time,
            event_type="window_focus",
            app_name="OldApp",
            window_title="Old Window"
        )
        recent_event = ActivityEvent(
            timestamp=recent_time,
            event_type="window_focus",
            app_name="RecentApp",
            window_title="Recent Window"
        )

        self.store.insert_activity_events([old_event, recent_event])
        self.assertEqual(self.store.get_stats()["total_activities"], 2)

        # Prune with 60 days retention
        pruned = self.store.prune_expired_events(retention_days=60)
        self.assertEqual(pruned["pruned_activities"], 1)
        self.assertEqual(self.store.get_stats()["total_activities"], 1)

    def test_timeline_and_work_summary(self):
        now = datetime.now()
        now_iso = now.isoformat()
        earlier_iso = (now - timedelta(hours=1)).isoformat()

        events = [
            ActivityEvent(
                timestamp=earlier_iso,
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="live_voice.py - Rie-AI",
                duration_seconds=1800.0  # 30 min
            ),
            ActivityEvent(
                timestamp=now_iso,
                event_type="window_focus",
                app_name="Google Chrome",
                window_title="FastAPI WebSockets - Google Chrome",
                duration_seconds=900.0  # 15 min
            )
        ]
        self.store.insert_activity_events(events)

        clips = [
            ClipboardEvent(
                timestamp=now_iso,
                app_name="Visual Studio Code",
                content="def test_sample(): pass",
                content_type="code"
            )
        ]
        self.store.insert_clipboard_events(clips)

        start_iso, end_iso = (now - timedelta(hours=2)).isoformat(), (now + timedelta(hours=1)).isoformat()
        timeline = self.search.get_timeline(start_time=start_iso, end_time=end_iso)
        self.assertEqual(len(timeline), 2)

        summary = self.search.get_work_summary(start_time=start_iso, end_time=end_iso)
        self.assertEqual(summary["total_active_seconds"], 2700.0)
        self.assertEqual(len(summary["applications"]), 2)
        self.assertEqual(summary["applications"][0]["app_name"], "Visual Studio Code")
        self.assertEqual(len(summary["top_tasks_and_windows"]), 2)
        self.assertEqual(summary["clipboard_activity"]["count"], 1)

    def test_fts5_keyword_search(self):
        self.store.insert_activity_events([
            ActivityEvent(
                event_type="window_focus",
                app_name="Google Chrome",
                window_title="Building High Performance WebSockets in FastAPI"
            )
        ])

        self.store.insert_clipboard_events([
            ClipboardEvent(
                app_name="Visual Studio Code",
                content="async def connect_audio_stream(websocket: WebSocket): await websocket.accept()",
                content_type="code"
            )
        ])

        # Search for "WebSockets"
        res1 = self.search.search(query="WebSockets")
        self.assertGreaterEqual(res1["total_matches"], 1)
        self.assertTrue(any("WebSockets" in a["window_title"] for a in res1["activities"]))

        # Search for "connect_audio_stream"
        res2 = self.search.search(query="connect_audio_stream")
        self.assertGreaterEqual(res2["total_matches"], 1)
        self.assertTrue(any("connect_audio_stream" in c["content_preview"] for c in res2["clipboards"]))

    def test_agent_tools_execution(self):
        summary_out = get_work_summary_tool.invoke({"timeframe": "today"})
        self.assertIsInstance(summary_out, str)
        data = json.loads(summary_out)
        self.assertIn("total_active_seconds", data)
        self.assertIn("applications", data)

        timeline_out = get_activity_timeline_tool.invoke({"timeframe": "today", "limit": 10})
        self.assertIsInstance(timeline_out, str)
        tl_data = json.loads(timeline_out)
        self.assertIn("events", tl_data)

        search_out = search_activity_tool.invoke({"query": "test"})
        self.assertIsInstance(search_out, str)
        s_data = json.loads(search_out)
        self.assertIn("activities", s_data)

    def test_terminal_engine_history_and_tools(self):
        from app.workstream.models import TerminalEvent

        now = datetime.now(timezone.utc)
        t1 = (now - timedelta(seconds=25)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t2 = (now - timedelta(seconds=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t3 = (now - timedelta(seconds=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t4 = (now - timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%SZ")

        # 1. Store terminal events across shells and directories
        events = [
            TerminalEvent(
                event_type="terminal_command",
                shell="PowerShell",
                command="git checkout -b feature/shell-sensor",
                cwd="D:\\professional\\code\\Rie-AI",
                exit_code=0,
                duration=0.3,
                timestamp=t1
            ).to_activity_event(),
            TerminalEvent(
                event_type="terminal_command",
                shell="PowerShell",
                command="poetry run python -m pytest tests/test_workstream.py",
                cwd="D:\\professional\\code\\Rie-AI\\app\\server",
                exit_code=0,
                duration=5.2,
                timestamp=t2
            ).to_activity_event(),
            TerminalEvent(
                event_type="terminal_command",
                shell="CMD",
                command="cargo test --workspace",
                cwd="D:\\professional\\code\\Rie-AI\\app\\native",
                exit_code=101,
                duration=8.4,
                timestamp=t3
            ).to_activity_event(),
            TerminalEvent(
                event_type="terminal_command",
                shell="Git Bash",
                command="npm run build",
                cwd="D:\\projects\\OtherApp",
                exit_code=0,
                duration=12.1,
                timestamp=t4
            ).to_activity_event(),
        ]
        self.store.insert_activity_events(events)

        # 2. Answer: “What commands did I run while working on Rie today?”
        rie_cmds = self.search.get_terminal_history(timeframe="today", cwd="Rie-AI")
        self.assertEqual(len(rie_cmds), 3)
        self.assertTrue(all("Rie-AI" in c["cwd"] for c in rie_cmds))
        cmd_names = [c["command"] for c in rie_cmds]
        self.assertIn("git checkout -b feature/shell-sensor", cmd_names)
        self.assertIn("poetry run python -m pytest tests/test_workstream.py", cmd_names)
        self.assertIn("cargo test --workspace", cmd_names)

        # 3. Answer: “What was the last test I ran?”
        test_cmds = self.search.get_terminal_history(timeframe="today", query="test")
        self.assertEqual(len(test_cmds), 2)
        # Most recent test command is cargo test
        self.assertEqual(test_cmds[0]["command"], "cargo test --workspace")
        self.assertEqual(test_cmds[0]["exit_code"], 101)
        self.assertFalse(test_cmds[0]["success"])

        # 4. Answer: “What project was I working on in the terminal?”
        summary = self.search.get_work_summary(
            start_time=(now - timedelta(hours=1)).isoformat(),
            end_time=(now + timedelta(hours=1)).isoformat()
        )
        term_act = summary["terminal_activity"]
        self.assertIn("distinct_directories", term_act)
        dirs = term_act["distinct_directories"]
        self.assertTrue(any("Rie-AI" in d for d in dirs))
        self.assertTrue(any("OtherApp" in d for d in dirs))
        self.assertEqual(term_act["failed_count"], 1)
        self.assertIsNotNone(term_act["last_test_run"])
        self.assertEqual(term_act["last_test_run"]["command"], "cargo test --workspace")

        # 5. Answer: “What did I do before the tests started failing?”
        # Query activity timeline up to failure time
        timeline_before_fail = self.search.get_timeline(
            start_time=(now - timedelta(hours=1)).isoformat(),
            end_time=t3,
            limit=10
        )
        self.assertGreaterEqual(len(timeline_before_fail), 3)
        # The command right before cargo test was poetry run pytest
        cmd_timeline = [e.get("command") for e in timeline_before_fail if e.get("command")]
        self.assertIn("poetry run python -m pytest tests/test_workstream.py", cmd_timeline)

        # 6. Test timeline app_name="terminal" filter
        term_timeline = self.search.get_timeline(
            start_time=(now - timedelta(hours=1)).isoformat(),
            end_time=(now + timedelta(hours=1)).isoformat(),
            app_name="terminal"
        )
        self.assertEqual(len(term_timeline), 4)
        for evt in term_timeline:
            self.assertIn("command", evt)
            self.assertIn("shell", evt)
            self.assertIn("cwd", evt)
            self.assertIn("exit_code", evt)

        # 7. Test search.get_terminal_history with failed_only on isolated store
        failed_cmds = self.search.get_terminal_history(timeframe="today", failed_only=True)
        self.assertEqual(len(failed_cmds), 1)
        self.assertEqual(failed_cmds[0]["command"], "cargo test --workspace")
        self.assertEqual(failed_cmds[0]["exit_code"], 101)

        # 8. Test get_terminal_history_tool invocation schema
        tool_out = get_terminal_history_tool.invoke({"timeframe": "today"})
        self.assertIsInstance(tool_out, str)
        data = json.loads(tool_out)
        self.assertIn("count", data)
        self.assertIn("commands", data)

    def test_session_clustering_idle_gaps_and_project_shifts(self):
        """Tests that raw events are clustered by temporal inactivity gaps (>20m) and project shifts."""
        base_time = datetime(2026, 9, 26, 10, 0, 0, tzinfo=timezone.utc)
        events = [
            # Cluster 1: Rie-AI (10:00 - 10:12)
            {
                "timestamp": (base_time + timedelta(minutes=0)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "event_type": "window_focus",
                "app_name": "Antigravity",
                "window_title": "live_tool_dispatcher.py - Rie-AI",
                "source": "desktop",
                "duration_seconds": 300.0,
                "metadata": {"workspace": "Rie-AI", "file": "app/live_tool_dispatcher.py"}
            },
            {
                "timestamp": (base_time + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "event_type": "browser_tab",
                "app_name": "Google Chrome",
                "window_title": "GitHub Pull Request - Google Chrome",
                "source": "browser_ext",
                "duration_seconds": 180.0,
                "metadata": {"url": "https://github.com/Rie-AI/workstream/pull/12"}
            },
            {
                "timestamp": (base_time + timedelta(minutes=12)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "event_type": "terminal_command",
                "app_name": "PowerShell",
                "window_title": "PowerShell",
                "source": "terminal_ext",
                "duration_seconds": 60.0,
                "metadata": {"command": "poetry run pytest", "cwd": "D:\\code\\Rie-AI", "exit_code": 0}
            },
            # Gap of 33 minutes (> 20 min idle threshold) -> Cluster 2 (10:45 - 10:55)
            {
                "timestamp": (base_time + timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "event_type": "window_focus",
                "app_name": "Antigravity",
                "window_title": "router.py - Rie-AI",
                "source": "desktop",
                "duration_seconds": 240.0,
                "metadata": {"workspace": "Rie-AI", "file": "app/workstream/router.py"}
            },
            {
                "timestamp": (base_time + timedelta(minutes=55)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "event_type": "terminal_command",
                "app_name": "PowerShell",
                "window_title": "PowerShell",
                "source": "terminal_ext",
                "duration_seconds": 45.0,
                "metadata": {"command": "git status", "cwd": "D:\\code\\Rie-AI", "exit_code": 0}
            },
        ]

        clusters = self.aggregator.cluster_events(events, idle_threshold_minutes=20)
        self.assertEqual(len(clusters), 2)
        self.assertEqual(len(clusters[0]), 3)
        self.assertEqual(len(clusters[1]), 2)

    def test_cross_sensor_correlation_and_semantic_synthesis(self):
        """
        Tests multi-sensor event synthesis into a cohesive WorkSession:
        Windows + Browser + IDE + Clipboard + Terminal -> Semantic summary.
        Verifies that raw events are preserved and NOT deleted.
        """
        base_time = datetime(2026, 9, 26, 10, 2, 0, tzinfo=timezone.utc)

        # Ingest multi-sensor raw activity events
        raw_events = [
            # 1. Browser: Chrome -> GitHub
            ActivityEvent(
                timestamp=(base_time + timedelta(minutes=0)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="browser_tab",
                app_name="Google Chrome",
                process_name="chrome.exe",
                window_title="Workstream Integration PR - GitHub",
                source="browser_ext",
                duration_seconds=120.0,
                metadata={
                    "browser": "Chrome",
                    "url": "https://github.com/Rie-AI/workstream/pull/42",
                    "title": "Workstream Integration PR"
                }
            ),
            # 2. IDE: Antigravity -> live_tool_dispatcher.py
            ActivityEvent(
                timestamp=(base_time + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="ide_context",
                app_name="Antigravity",
                process_name="antigravity.exe",
                window_title="live_tool_dispatcher.py - Rie-AI",
                source="vscode_ext",
                duration_seconds=240.0,
                metadata={
                    "file": "app/server/app/live_tool_dispatcher.py",
                    "workspace": "Rie-AI",
                    "git_branch": "workstream",
                    "language": "python",
                    "lines_added": 18,
                    "lines_removed": 4
                }
            ),
            # 3. Terminal: PowerShell -> pytest
            ActivityEvent(
                timestamp=(base_time + timedelta(minutes=6)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name="PowerShell",
                process_name="powershell.exe",
                window_title="PowerShell",
                source="terminal_ext",
                duration_seconds=60.0,
                metadata={
                    "command": "poetry run pytest tests/test_workstream.py",
                    "cwd": "D:\\code\\Rie-AI\\app\\server",
                    "shell": "PowerShell",
                    "exit_code": 0,
                    "status": "completed"
                }
            ),
            # 4. IDE: VS Code -> live_tool_dispatcher.py
            ActivityEvent(
                timestamp=(base_time + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                process_name="code.exe",
                window_title="live_tool_dispatcher.py - Rie-AI",
                source="desktop",
                duration_seconds=300.0,
                metadata={
                    "file": "app/server/app/live_tool_dispatcher.py",
                    "workspace": "Rie-AI"
                }
            ),
            # 5. Terminal: Interrupted command (Ctrl+C)
            ActivityEvent(
                timestamp=(base_time + timedelta(minutes=16)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name="PowerShell",
                process_name="powershell.exe",
                window_title="PowerShell",
                source="terminal_ext",
                duration_seconds=5.0,
                metadata={
                    "command": "ping 8.8.8.8",
                    "cwd": "D:\\code\\Rie-AI",
                    "shell": "PowerShell",
                    "exit_code": 130,
                    "status": "interrupted"
                }
            )
        ]

        clip = ClipboardEvent(
            timestamp=(base_time + timedelta(minutes=7)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            app_name="Visual Studio Code",
            content="def handle_tool_call(): return True",
            content_type="code"
        )

        self.store.insert_activity_events(raw_events)
        self.store.insert_clipboard_events([clip])

        raw_count_before = self.store.get_stats()["total_activities"]
        self.assertEqual(raw_count_before, 5)

        raw_dicts = [
            {
                "id": i + 1,
                "timestamp": e.timestamp,
                "event_type": e.event_type,
                "app_name": e.app_name,
                "window_title": e.window_title,
                "source": e.source,
                "duration_seconds": e.duration_seconds,
                "metadata": e.metadata or {}
            }
            for i, e in enumerate(raw_events)
        ]

        sess = self.aggregator.synthesize_session(raw_dicts)

        # 1. Assert session attributes
        self.assertEqual(sess.project, "Rie-AI")
        self.assertIn("live_tool_dispatcher.py", [os.path.basename(f) for f in sess.files])
        self.assertIn("github.com", sess.domains)
        self.assertTrue(any("pytest" in c for c in sess.commands))
        self.assertIn("workstream", sess.topics)

        # 2. Assert Title & Narrative Summary formulation
        self.assertIn("Rie-AI", sess.title)
        self.assertIn("live_tool_dispatcher.py", sess.title)
        self.assertIn("Rie-AI", sess.summary)
        self.assertIn("Modified live_tool_dispatcher.py", sess.summary)
        self.assertIn("reviewed github.com", sess.summary)
        self.assertIn("test run", sess.summary)
        self.assertIn("interrupted ping 8.8.8.8 via Ctrl+C", sess.summary)

        # 3. Assert raw events were NOT deleted or replaced
        saved_sess = self.store.save_work_session(sess)
        self.assertIsNotNone(saved_sess.id)
        raw_count_after = self.store.get_stats()["total_activities"]
        self.assertEqual(raw_count_after, raw_count_before)
        self.assertEqual(self.store.get_stats()["total_sessions"], 1)

    def test_work_session_store_persistence_and_retrieval(self):
        """Tests saving and retrieving work sessions by timeframe, project, file, domain, topic, and FTS."""
        local_now = datetime.now().astimezone()
        yesterday_dt = (local_now - timedelta(days=1)).astimezone(timezone.utc)
        today_dt = (local_now - timedelta(seconds=10)).astimezone(timezone.utc)

        sess_yesterday = WorkSession(
            title="Worked on Rie-AI: terminal tracking feature",
            summary="14:00–14:45 — Active on project Rie-AI. Implemented terminal tracking hooks in PowerShell and verified exit codes.",
            project="Rie-AI",
            start_time=(yesterday_dt - timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=yesterday_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=2700.0,
            event_count=15,
            files=["app/server/app/workstream/router.py", "app/extensions/terminal/rie-shell-powershell.ps1"],
            domains=["learn.microsoft.com"],
            commands=["poetry run pytest tests/test_workstream.py"],
            topics=["terminal tracking", "powershell", "workstream"],
            primary_apps=["Visual Studio Code", "PowerShell"]
        )

        sess_today = WorkSession(
            title="Worked on Rie-AI: semantic memory aggregator",
            summary="10:00–10:30 — Active on project Rie-AI. Created session aggregator and temporal search.",
            project="Rie-AI",
            start_time=(today_dt - timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=today_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1800.0,
            event_count=20,
            files=["app/server/app/workstream/session_aggregator.py"],
            domains=["github.com"],
            commands=["poetry run pytest"],
            topics=["semantic memory", "session aggregator"],
            primary_apps=["Antigravity"]
        )

        self.store.save_work_session(sess_yesterday)
        self.store.save_work_session(sess_today)

        # 1. Temporal query: yesterday
        y_sessions = self.store.get_work_sessions(timeframe="yesterday")
        self.assertEqual(len(y_sessions), 1)
        self.assertIn("terminal tracking", y_sessions[0]["title"])

        # 2. Temporal query: today
        t_sessions = self.store.get_work_sessions(timeframe="today")
        self.assertEqual(len(t_sessions), 1)
        self.assertIn("semantic memory", t_sessions[0]["title"])

        # 3. Filter by project
        proj_sessions = self.store.get_work_sessions(timeframe="last_7_days", project="Rie-AI")
        self.assertEqual(len(proj_sessions), 2)

        # 4. Filter by file
        file_sessions = self.store.get_work_sessions(timeframe="last_7_days", file="session_aggregator.py")
        self.assertEqual(len(file_sessions), 1)
        self.assertEqual(file_sessions[0]["session_id"], sess_today.session_id)

        # 5. Filter by domain
        dom_sessions = self.store.get_work_sessions(timeframe="last_7_days", domain="microsoft.com")
        self.assertEqual(len(dom_sessions), 1)
        self.assertEqual(dom_sessions[0]["session_id"], sess_yesterday.session_id)

        # 6. Filter by topic
        top_sessions = self.store.get_work_sessions(timeframe="last_7_days", topic="terminal tracking")
        self.assertEqual(len(top_sessions), 1)

        # 7. FTS search query: "terminal tracking"
        fts_sessions = self.store.get_work_sessions(timeframe="last_7_days", query="terminal tracking")
        self.assertEqual(len(fts_sessions), 1)

        # 8. Latest session
        latest = self.store.get_latest_work_session(project="Rie-AI")
        self.assertIsNotNone(latest)
        self.assertEqual(latest["session_id"], sess_today.session_id)

        # 9. Get by ID
        by_id = self.store.get_session_by_id(sess_yesterday.session_id)
        self.assertIsNotNone(by_id)
        self.assertEqual(by_id["title"], sess_yesterday.title)

    def test_work_session_agent_tools(self):
        """Tests LangChain agent tools get_work_sessions and get_last_work_session."""
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI Workstream integration",
            summary="10:02–10:25 — Worked on Rie-AI Workstream integration. Modified live_tool_dispatcher.py, reviewed GitHub, and ran the Workstream test suite.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=23)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1380.0,
            event_count=12,
            files=["app/server/app/live_tool_dispatcher.py"],
            domains=["github.com"],
            commands=["poetry run pytest"],
            topics=["workstream", "live_tool_dispatcher"],
            primary_apps=["Visual Studio Code", "PowerShell"],
            metadata={"git_branch": "workstream"}
        )
        self.store.save_work_session(sess)
        from app.workstream.store import workstream_store
        workstream_store.save_work_session(sess)

        # Test get_work_sessions tool
        ws_res = get_work_sessions_func(timeframe="today", project="Rie-AI")
        self.assertIn("work session(s)", ws_res)
        self.assertIn("Worked on Rie-AI", ws_res)

        # Test get_last_work_session tool ("Continue what I was doing")
        last_res = get_last_work_session_func(project="Rie-AI")
        self.assertIn("Last Work Session", last_res)
        self.assertIn("Rie-AI", last_res)
        self.assertIn("Resume Hint", last_res)



class TestWorkstreamRouter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from main import app
        from app.workstream.store import workstream_store
        with workstream_store._get_connection() as conn:
            conn.execute("DELETE FROM activity_events")
            conn.execute("DELETE FROM clipboard_events")
            conn.execute("DELETE FROM work_sessions")
            conn.commit()
        cls.client = TestClient(app)

    def test_post_events_and_get_status(self):
        # Post batch of events
        payload = {
            "activity_events": [
                {
                    "event_type": "window_focus",
                    "app_name": "Test IDE",
                    "process_name": "test_ide.exe",
                    "window_title": "main.rs - Project",
                    "duration_seconds": 60.0
                }
            ],
            "clipboard_events": [
                {
                    "app_name": "Test IDE",
                    "content": "fn test_router() {}",
                    "content_type": "code"
                }
            ]
        }
        res = self.client.post("/workstream/events", json=payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["ingested_activities"], 1)
        self.assertEqual(data["ingested_clipboards"], 1)

        # Check status
        status_res = self.client.get("/workstream/status")
        self.assertEqual(status_res.status_code, 200)
        status_data = status_res.json()
        self.assertIn("total_activities", status_data)
        self.assertIn("total_clipboards", status_data)

    def test_summary_and_timeline_endpoints(self):
        # Timeline
        tl_res = self.client.get("/workstream/timeline?timeframe=today&limit=5")
        self.assertEqual(tl_res.status_code, 200)
        self.assertIn("events", tl_res.json())

        # Summary
        sum_res = self.client.get("/workstream/summary?timeframe=today")
        self.assertEqual(sum_res.status_code, 200)
        self.assertIn("total_active_seconds", sum_res.json())

        # Search
        search_res = self.client.get("/workstream/search?q=test")
        self.assertEqual(search_res.status_code, 200)
        self.assertIn("activities", search_res.json())

    def test_browser_extension_event_and_search(self):
        # 1. Ingest browser event in the exact format from user specification
        browser_payload = {
            "event_type": "browser_tab",
            "browser": "Brave",
            "url": "https://github.com/facebook/react/pull/347",
            "title": "Pull Request #347",
            "timestamp": "2026-09-25T17:30:00Z"
        }
        res = self.client.post("/workstream/events", json=browser_payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["ingested_activities"], 1)

        # 2. Search by title
        search_res = self.client.get("/workstream/search?q=Pull+Request")
        self.assertEqual(search_res.status_code, 200)
        sdata = search_res.json()
        self.assertGreater(len(sdata["activities"]), 0)
        matched = [a for a in sdata["activities"] if "Pull Request #347" in a["window_title"]]
        self.assertTrue(len(matched) > 0)
        self.assertEqual(matched[0]["url"], "https://github.com/facebook/react/pull/347")
        self.assertEqual(matched[0]["app_name"], "Brave")
        self.assertEqual(matched[0]["source"], "browser_ext")

        # 3. Search by URL keyword
        url_search_res = self.client.get("/workstream/search?q=facebook/react")
        self.assertEqual(url_search_res.status_code, 200)
        udata = url_search_res.json()
        self.assertGreater(len(udata["activities"]), 0)
        self.assertIn("https://github.com/facebook/react/pull/347", udata["activities"][0].get("url", ""))

        # 4. Search activity tool
        tool_output = search_activity_func("Pull Request #347")
        self.assertIn("Pull Request #347", tool_output)
        self.assertIn("https://github.com/facebook/react/pull/347", tool_output)

    def test_ide_extension_event_and_search(self):
        # 1. Ingest ide_context event
        now_ide = datetime.now(timezone.utc)
        t_ide1 = (now_ide - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_ide2 = (now_ide - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")

        ide_payload = {
            "event_type": "ide_context",
            "ide": "Antigravity",
            "workspace": "Rie-AI",
            "file": "app/server/app/live_tool_dispatcher.py",
            "language": "Python",
            "git_branch": "workstream",
            "timestamp": t_ide1
        }
        res = self.client.post("/workstream/events", json=ide_payload)
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["success"])
        self.assertEqual(res.json()["ingested_activities"], 1)

        # 2. Ingest file_change event with diff stats
        change_payload = {
            "event_type": "file_change",
            "ide": "Antigravity",
            "file": "live_tool_dispatcher.py",
            "lines_added": 14,
            "lines_removed": 6,
            "timestamp": t_ide2
        }
        res2 = self.client.post("/workstream/events", json=change_payload)
        self.assertEqual(res2.status_code, 200)
        self.assertTrue(res2.json()["success"])

        # 3. Search by file name
        s_file = self.client.get("/workstream/search?q=live_tool_dispatcher.py")
        self.assertEqual(s_file.status_code, 200)
        acts = s_file.json()["activities"]
        self.assertGreater(len(acts), 0)
        
        # Verify fields
        matched = [a for a in acts if a.get("git_branch") == "workstream"]
        self.assertTrue(len(matched) > 0)
        context_act = matched[0]
        self.assertEqual(context_act["file"], "app/server/app/live_tool_dispatcher.py")
        self.assertEqual(context_act["workspace"], "Rie-AI")
        self.assertEqual(context_act["language"], "Python")
        self.assertEqual(context_act["app_name"], "Antigravity")
        self.assertEqual(context_act["source"], "vscode_ext")

        # Verify diff stats on saved change
        change_act = [a for a in acts if a.get("lines_added") == 14][0]
        self.assertEqual(change_act["lines_removed"], 6)

        # 4. Search by branch
        s_branch = self.client.get("/workstream/search?q=workstream")
        self.assertEqual(s_branch.status_code, 200)
        self.assertGreater(len(s_branch.json()["activities"]), 0)

    def test_terminal_command_event_and_search(self):
        # 1. Ingest terminal_command event (exact user schema)
        term_payload = {
            "event_type": "terminal_command",
            "shell": "PowerShell",
            "command": "poetry run python -m pytest tests/test_terminal_unique.py",
            "cwd": "D:\\professional\\code\\Rie-AI\\app\\server",
            "exit_code": 0,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        }
        res = self.client.post("/workstream/events", json=term_payload)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["ingested_activities"], 1)

        # 2. Search by command keywords (e.g. pytest)
        s_cmd = self.client.get("/workstream/search?q=test_terminal_unique")
        self.assertEqual(s_cmd.status_code, 200)
        acts = s_cmd.json()["activities"]
        self.assertGreater(len(acts), 0)

        # Match our event
        matched = [a for a in acts if a.get("command") == "poetry run python -m pytest tests/test_terminal_unique.py"]
        self.assertTrue(len(matched) > 0)
        t_act = matched[0]
        self.assertEqual(t_act["shell"], "PowerShell")
        self.assertEqual(t_act["exit_code"], 0)
        self.assertEqual(t_act["cwd"], "D:\\professional\\code\\Rie-AI\\app\\server")
        self.assertEqual(t_act["source"], "terminal")

        # 3. Search activity tool directly
        tool_output = search_activity_func("test_terminal_unique")
        self.assertIn("pytest tests/test_terminal_unique.py", tool_output)
        self.assertIn("PowerShell", tool_output)

    def test_terminal_multi_shell_and_summary(self):
        now = datetime.now(timezone.utc)
        t_bash = (now - timedelta(minutes=4)).isoformat()
        t_cmd = (now - timedelta(minutes=2)).isoformat()

        # Ingest Git Bash failed test command
        bash_payload = {
            "event_type": "terminal_command",
            "shell": "Git Bash",
            "command": "npm run test:e2e",
            "cwd": "D:/professional/code/Rie-AI/app/client",
            "exit_code": 1,
            "duration": 4.12,
            "timestamp": t_bash
        }
        res1 = self.client.post("/workstream/events", json=bash_payload)
        self.assertEqual(res1.status_code, 200)

        # Ingest CMD build command
        cmd_payload = {
            "event_type": "terminal_command",
            "shell": "CMD",
            "command": "cargo build --release",
            "cwd": "D:\\professional\\code\\Rie-AI\\app\\native",
            "exit_code": 0,
            "duration": 12.5,
            "timestamp": t_cmd
        }
        res2 = self.client.post("/workstream/events", json=cmd_payload)
        self.assertEqual(res2.status_code, 200)

        # Search for failed command
        s_res = self.client.get("/workstream/search?q=test:e2e")
        self.assertEqual(s_res.status_code, 200)
        acts = s_res.json()["activities"]
        self.assertGreater(len(acts), 0)
        e2e_act = acts[0]
        self.assertEqual(e2e_act["shell"], "Git Bash")
        self.assertEqual(e2e_act["exit_code"], 1)
        self.assertFalse(e2e_act["success"])
        self.assertEqual(e2e_act["duration"], 4.12)

        # Verify get_work_summary includes terminal_activity
        summary_res = self.client.get("/workstream/summary?timeframe=last_24_hours")
        self.assertEqual(summary_res.status_code, 200)
        summary_data = summary_res.json()
        self.assertIn("terminal_activity", summary_data)
        term_act = summary_data["terminal_activity"]
        self.assertGreater(term_act["count"], 0)
        commands = [c["command"] for c in term_act["recent_commands"]]
        self.assertTrue(any("npm run test:e2e" in cmd or "cargo build" in cmd for cmd in commands))

    def test_terminal_endpoint_and_core_questions(self):
        now = datetime.now(timezone.utc)
        t_base = (now - timedelta(seconds=25)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_build = (now - timedelta(seconds=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_test1 = (now - timedelta(seconds=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_breakage = (now - timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_test2_fail = (now - timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ")

        session_events = [
            {
                "event_type": "terminal_command",
                "shell": "PowerShell",
                "command": "git pull origin main",
                "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI",
                "exit_code": 0,
                "duration": 1.2,
                "timestamp": t_base
            },
            {
                "event_type": "terminal_command",
                "shell": "CMD",
                "command": "poetry run pip install -r requirements.txt",
                "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI\\app\\server",
                "exit_code": 0,
                "duration": 6.8,
                "timestamp": t_build
            },
            {
                "event_type": "terminal_command",
                "shell": "PowerShell",
                "command": "poetry run python -m pytest tests/test_core_session.py",
                "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI\\app\\server",
                "exit_code": 0,
                "duration": 5.4,
                "timestamp": t_test1
            },
            {
                "event_type": "terminal_command",
                "shell": "Git Bash",
                "command": "git merge refactor/database",
                "cwd": "D:/professional/code/reactjs/reactjs/Rie-AI",
                "exit_code": 0,
                "duration": 0.8,
                "timestamp": t_breakage
            },
            {
                "event_type": "terminal_command",
                "shell": "PowerShell",
                "command": "poetry run python -m pytest tests/test_core_session.py",
                "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI\\app\\server",
                "exit_code": 1,
                "duration": 5.1,
                "timestamp": t_test2_fail
            }
        ]

        for evt in session_events:
            res = self.client.post("/workstream/events", json=evt)
            self.assertEqual(res.status_code, 200)

        # Q1: “What commands did I run while working on Rie today?”
        res_rie = self.client.get("/workstream/terminal?cwd=Rie-AI")
        self.assertEqual(res_rie.status_code, 200)
        data_rie = res_rie.json()
        self.assertGreaterEqual(data_rie["count"], 5)
        all_cmds = [c["command"] for c in data_rie["commands"]]
        self.assertIn("git pull origin main", all_cmds)
        self.assertIn("git merge refactor/database", all_cmds)

        # Q2: “What was the last test I ran?”
        res_last_test = self.client.get("/workstream/terminal?q=test_core_session&limit=1")
        self.assertEqual(res_last_test.status_code, 200)
        last_test = res_last_test.json()["commands"][0]
        self.assertEqual(last_test["command"], "poetry run python -m pytest tests/test_core_session.py")
        self.assertEqual(last_test["exit_code"], 1)

        # Q3: “What did I do before the tests started failing?”
        # Retrieve commands up to the breakage merge
        res_before_fail = self.client.get(f"/workstream/terminal?end={t_breakage}&limit=5")
        self.assertEqual(res_before_fail.status_code, 200)
        cmds_before = [c["command"] for c in res_before_fail.json()["commands"]]
        # The immediate action before test failure was the merge
        self.assertIn("git merge refactor/database", cmds_before)

        # Q4: “What project was I working on in the terminal?”
        sum_res = self.client.get("/workstream/summary?timeframe=last_24_hours")
        self.assertEqual(sum_res.status_code, 200)
        summary = sum_res.json()
        dirs = summary["terminal_activity"]["distinct_directories"]
        self.assertTrue(any("Rie-AI" in d for d in dirs))
        self.assertGreaterEqual(summary["terminal_activity"]["failed_count"], 1)

        # Test failed_only filter on /workstream/terminal
        res_fail_only = self.client.get("/workstream/terminal?failed_only=true")
        self.assertEqual(res_fail_only.status_code, 200)
        fail_cmds = res_fail_only.json()["commands"]
        self.assertTrue(all(c["exit_code"] != 0 for c in fail_cmds))
        self.assertTrue(all(not c["success"] for c in fail_cmds))

    def test_terminal_interrupted_command_ctrl_c(self):
        """
        Tests capturing 'ping google.com' at start as running, followed by Ctrl+C interruption (exit code 130).
        Validates:
        - Querying last command returns: 'ping google.com — interrupted after ~4s'
        - Summary and tools properly expose interrupted status and duration.
        """
        now = datetime.now(timezone.utc)
        cmd_id = "test-ping-ctrlc-guid-001"
        t_start = (now + timedelta(seconds=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_end = (now + timedelta(seconds=15)).strftime("%Y-%m-%dT%H:%M:%SZ")

        # 1. Command starts: dispatched with status="running", exit_code=None
        start_payload = {
            "id": cmd_id,
            "event_type": "terminal_command",
            "shell": "PowerShell",
            "command": "ping google.com",
            "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI",
            "status": "running",
            "exit_code": None,
            "duration": 0.0,
            "timestamp": t_start
        }
        res_start = self.client.post("/workstream/events", json=start_payload)
        self.assertEqual(res_start.status_code, 200)

        # Verify it appears in /workstream/terminal/running
        res_running = self.client.get("/workstream/terminal/running")
        self.assertEqual(res_running.status_code, 200)
        running_list = res_running.json()["running_commands"]
        matched_running = [c for c in running_list if c["command"] == "ping google.com"]
        self.assertEqual(len(matched_running), 1)
        self.assertTrue(matched_running[0]["running"])
        self.assertIn("running for", matched_running[0]["summary_label"])

        # 2. User presses Ctrl+C -> dispatched with status="interrupted", exit_code=130, duration=4.1
        interrupt_payload = {
            "id": cmd_id,
            "event_type": "terminal_command",
            "shell": "PowerShell",
            "command": "ping google.com",
            "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI",
            "status": "interrupted",
            "exit_code": 130,
            "duration": 4.1,
            "timestamp": t_end
        }
        res_interrupt = self.client.post("/workstream/events", json=interrupt_payload)
        self.assertEqual(res_interrupt.status_code, 200)

        # 3. Query: “What was the last terminal command I ran?”
        res_last = self.client.get("/workstream/terminal?limit=1")
        self.assertEqual(res_last.status_code, 200)
        last_cmd = res_last.json()["commands"][0]
        self.assertEqual(last_cmd["command"], "ping google.com")
        self.assertEqual(last_cmd["status"], "interrupted")
        self.assertTrue(last_cmd["interrupted"])
        self.assertFalse(last_cmd["running"])
        self.assertEqual(last_cmd["exit_code"], 130)
        self.assertEqual(last_cmd["duration_seconds"], 4.1)
        self.assertIn("ping google.com — interrupted after", last_cmd["summary_label"])
        self.assertIn("4", last_cmd["summary_label"])

        # 4. Check /workstream/summary
        sum_res = self.client.get("/workstream/summary?timeframe=today")
        self.assertEqual(sum_res.status_code, 200)
        sum_data = sum_res.json()["terminal_activity"]
        self.assertGreaterEqual(sum_data["interrupted_count"], 1)
        self.assertIsNotNone(sum_data["last_command"])
        self.assertEqual(sum_data["last_command"]["command"], "ping google.com")
        self.assertIn("interrupted", sum_data["last_command"]["summary_label"])
        self.assertEqual(sum_data["last_interrupted_command"]["command"], "ping google.com")

        # 5. Check Agent Tools directly
        tool_output = get_terminal_history_func(timeframe="today", limit=1)
        tool_json = json.loads(tool_output)
        self.assertEqual(tool_json["commands"][0]["command"], "ping google.com")
        self.assertEqual(tool_json["commands"][0]["status"], "interrupted")

    def test_terminal_long_running_command(self):
        """
        Tests a long-running terminal process (e.g. dev server) transitioning from running to completed.
        """
        now = datetime.now(timezone.utc)
        cmd_id = "test-long-running-dev-server-002"
        t_start = (now - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_end = now.strftime("%Y-%m-%dT%H:%M:%SZ")

        # 1. Long-running command starts
        start_payload = {
            "id": cmd_id,
            "event_type": "terminal_command",
            "shell": "CMD",
            "command": "npm run tauri:dev",
            "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI\\app\\client",
            "status": "running",
            "exit_code": None,
            "duration": 0.0,
            "timestamp": t_start
        }
        res1 = self.client.post("/workstream/events", json=start_payload)
        self.assertEqual(res1.status_code, 200)

        # 2. Check running endpoint and running tool
        running_res = self.client.get("/workstream/terminal/running")
        self.assertEqual(running_res.status_code, 200)
        running_cmds = running_res.json()["running_commands"]
        matched = [c for c in running_cmds if c["command"] == "npm run tauri:dev"]
        self.assertEqual(len(matched), 1)
        self.assertTrue(matched[0]["running"])
        self.assertIn("running for", matched[0]["summary_label"])

        # Test running tool function
        running_tool_out = get_running_terminal_commands_func(limit=10)
        running_tool_json = json.loads(running_tool_out)
        self.assertTrue(any(c["command"] == "npm run tauri:dev" for c in running_tool_json["running_commands"]))

        # 3. Complete the long-running process successfully
        complete_payload = {
            "id": cmd_id,
            "event_type": "terminal_command",
            "shell": "CMD",
            "command": "npm run tauri:dev",
            "cwd": "D:\\professional\\code\\reactjs\\reactjs\\Rie-AI\\app\\client",
            "status": "completed",
            "exit_code": 0,
            "duration": 900.0,
            "timestamp": t_end
        }
        res2 = self.client.post("/workstream/events", json=complete_payload)
        self.assertEqual(res2.status_code, 200)

        # 4. Verify it is no longer running
        running_res_after = self.client.get("/workstream/terminal/running")
        running_cmds_after = running_res_after.json()["running_commands"]
        self.assertFalse(any(c["id"] == cmd_id for c in running_cmds_after))

        # 5. Verify it appears as completed
        history_res = self.client.get("/workstream/terminal?q=tauri:dev")
        completed_cmd = history_res.json()["commands"][0]
        self.assertEqual(completed_cmd["status"], "completed")
        self.assertTrue(completed_cmd["success"])
        self.assertIn("completed in 15m", completed_cmd["summary_label"])

    def test_terminal_interrupted_fallback_without_id(self):
        """
        Tests fallback matching where a completion/interruption event arrives without explicit ID.
        """
        now = datetime.now(timezone.utc)
        unique_token = uuid.uuid4().hex[:6]
        stream_cmd = f"curl -v https://example.com/stream-{unique_token}"
        t_start = (now + timedelta(seconds=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
        t_end = (now + timedelta(seconds=25)).strftime("%Y-%m-%dT%H:%M:%SZ")

        # 1. Start event without explicit ID
        self.client.post("/workstream/events", json={
            "event_type": "terminal_command",
            "shell": "Git Bash",
            "command": stream_cmd,
            "cwd": "/d/code",
            "status": "running",
            "exit_code": None,
            "timestamp": t_start
        })

        # 2. Interruption event without explicit ID
        self.client.post("/workstream/events", json={
            "event_type": "terminal_command",
            "shell": "Git Bash",
            "command": stream_cmd,
            "cwd": "/d/code",
            "status": "interrupted",
            "exit_code": 130,
            "duration": 2.5,
            "timestamp": t_end
        })

        # Query history
        res = self.client.get(f"/workstream/terminal?q={unique_token}")
        self.assertEqual(res.status_code, 200)
        cmds = res.json()["commands"]
        self.assertEqual(len(cmds), 1)
        self.assertEqual(cmds[0]["command"], stream_cmd)
        self.assertEqual(cmds[0]["status"], "interrupted")
        self.assertEqual(cmds[0]["exit_code"], 130)
        self.assertIn("interrupted after", cmds[0]["summary_label"])

    def test_workstream_sessions_api_endpoints(self):
        """Tests REST endpoints: /workstream/sessions/aggregate, /workstream/sessions, /latest, and /{id}."""
        now = datetime.now(timezone.utc)
        t_base = (now - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ")

        # 1. Ingest cross-sensor events via API
        self.client.post("/workstream/events", json={
            "activity_events": [
                {
                    "event_type": "browser_tab",
                    "app_name": "Google Chrome",
                    "window_title": "Workstream Integration - GitHub",
                    "source": "browser_ext",
                    "duration_seconds": 120.0,
                    "timestamp": t_base,
                    "metadata": {"url": "https://github.com/Rie-AI/workstream"}
                },
                {
                    "event_type": "ide_context",
                    "app_name": "Antigravity",
                    "window_title": "live_tool_dispatcher.py - Rie-AI",
                    "source": "vscode_ext",
                    "duration_seconds": 300.0,
                    "timestamp": t_base,
                    "metadata": {
                        "file": "app/server/app/live_tool_dispatcher.py",
                        "workspace": "Rie-AI",
                        "git_branch": "workstream"
                    }
                },
                {
                    "event_type": "terminal_command",
                    "app_name": "PowerShell",
                    "window_title": "PowerShell",
                    "source": "terminal_ext",
                    "duration_seconds": 30.0,
                    "timestamp": t_base,
                    "metadata": {
                        "command": "poetry run pytest tests/test_workstream.py",
                        "cwd": "D:\\code\\Rie-AI",
                        "exit_code": 0
                    }
                }
            ]
        })

        # 2. Trigger aggregation
        agg_res = self.client.post("/workstream/sessions/aggregate", json={
            "timeframe": "today",
            "force": True
        })
        self.assertEqual(agg_res.status_code, 200)
        agg_data = agg_res.json()
        self.assertTrue(agg_data["success"])
        self.assertGreaterEqual(agg_data["count"], 1)
        matching_sessions = [s for s in agg_data["sessions"] if s["project"] == "Rie-AI"]
        self.assertGreaterEqual(len(matching_sessions), 1)
        created_session = matching_sessions[0]
        sess_id = created_session["session_id"]
        self.assertEqual(created_session["project"], "Rie-AI")

        # 3. Retrieve sessions list
        list_res = self.client.get("/workstream/sessions?timeframe=today")
        self.assertEqual(list_res.status_code, 200)
        sessions = list_res.json()["sessions"]
        self.assertGreaterEqual(len(sessions), 1)

        # 4. Filter by project
        proj_res = self.client.get("/workstream/sessions?project=Rie-AI")
        self.assertEqual(proj_res.status_code, 200)
        self.assertTrue(any(s["project"] == "Rie-AI" for s in proj_res.json()["sessions"]))

        # 5. Retrieve latest session
        latest_res = self.client.get("/workstream/sessions/latest?project=Rie-AI&finalized_only=false")
        self.assertEqual(latest_res.status_code, 200)
        latest_data = latest_res.json()
        self.assertIsNotNone(latest_data["session"])
        self.assertEqual(latest_data["session"]["project"], "Rie-AI")

        # 6. Retrieve session by ID
        id_res = self.client.get(f"/workstream/sessions/{sess_id}")
        self.assertEqual(id_res.status_code, 200)
        self.assertEqual(id_res.json()["session"]["session_id"], sess_id)

        # 7. Test POST /workstream/sessions/auto-aggregate
        auto_res = self.client.post("/workstream/sessions/auto-aggregate")
        self.assertEqual(auto_res.status_code, 200)
        auto_data = auto_res.json()
        self.assertTrue(auto_data["success"])
        self.assertIn("count", auto_data)
        self.assertIn("sessions", auto_data)

        # 8. Test finalized_only filtering
        fin_res = self.client.get("/workstream/sessions?finalized_only=true")
        self.assertEqual(fin_res.status_code, 200)
        self.assertIn("sessions", fin_res.json())



if __name__ == "__main__":
    unittest.main()


"""
Unit tests for Core Session lifecycle and Jarvis resume-context workflows.
Tests work session aggregation, 'Where did I leave off?', and 'Continue what I was doing'.
"""
from datetime import datetime, timezone, timedelta
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from app.workstream.models import ActivityEvent, ClipboardEvent, WorkSession
from app.workstream.store import WorkstreamStore
from app.workstream.session_aggregator import SessionAggregator
from app.workstream.tools import (
    get_work_sessions_func,
    get_last_work_session_func,
    get_work_sessions_tool,
    get_last_work_session_tool,
)


class TestCoreSessionWorkflow(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test_core_session.db"
        self.store = WorkstreamStore(db_path=self.db_path)
        self.aggregator = SessionAggregator(store=self.store)
        self.created_global_session_ids = []

    def tearDown(self):
        for sid in getattr(self, "created_global_session_ids", []):
            try:
                from app.workstream.store import workstream_store
                workstream_store.delete_work_session(sid)
            except Exception:
                pass
        try:
            shutil.rmtree(self.tmpdir)
        except Exception:
            pass

    def test_core_session_creation_and_attributes(self):
        """Verifies that a work session can be created, stored, and indexed with all core attributes."""
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI Workstream integration",
            summary="10:02–10:25 (23m) — Active on project Rie-AI (branch: workstream). Modified live_tool_dispatcher.py (+18/-4 lines); reviewed github.com; ran pytest.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=23)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1380.0,
            event_count=18,
            files=["app/server/app/live_tool_dispatcher.py", "app/server/app/workstream/router.py"],
            domains=["github.com"],
            commands=["poetry run pytest tests/test_workstream.py"],
            topics=["workstream", "live_tool_dispatcher"],
            primary_apps=["Antigravity", "Google Chrome", "PowerShell"],
            metadata={
                "git_branch": "workstream",
                "lines_added": 18,
                "lines_removed": 4
            }
        )

        saved = self.store.save_work_session(sess)
        self.assertIsNotNone(saved.id)
        self.assertEqual(saved.session_id, sess.session_id)

        # Retrieve by session ID
        fetched = self.store.get_session_by_id(sess.session_id)
        self.assertIsNotNone(fetched)
        self.assertEqual(fetched["project"], "Rie-AI")
        self.assertIn("live_tool_dispatcher.py", fetched["files"][0])
        self.assertIn("github.com", fetched["domains"])

    def test_where_did_i_leave_off_resume_context(self):
        """
        Verifies the Jarvis 'Where did I leave off?' / 'Continue what I was doing' flow.
        Rie extracts the active project, git branch, modified files, and recent terminal commands.
        """
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI: Terminal Context v2 & Semantic Memory",
            summary="16:00–16:45 — Active on project Rie-AI (branch: workstream). Implemented interrupted command tracking and session aggregator.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=2700.0,
            event_count=35,
            files=[
                "app/server/app/workstream/session_aggregator.py",
                "app/server/app/workstream/router.py",
                "app/extensions/terminal/rie-shell-powershell.ps1"
            ],
            domains=["github.com"],
            commands=[
                "poetry run pytest tests/test_workstream.py",
                "git status",
                "ping google.com"
            ],
            topics=["workstream", "terminal", "session_aggregator"],
            primary_apps=["Visual Studio Code", "PowerShell"],
            metadata={
                "git_branch": "workstream",
                "interrupted_commands": ["ping google.com"]
            }
        )

        # Save to isolated store and global store so agent tool invocation succeeds
        self.store.save_work_session(sess)
        from app.workstream.store import workstream_store
        with workstream_store._get_connection() as conn:
            conn.execute("DELETE FROM work_sessions WHERE project = 'Rie-AI'")
            conn.commit()
        workstream_store.save_work_session(sess)
        self.created_global_session_ids.append(sess.session_id)

        # 1. Test get_last_work_session function
        resume_summary = get_last_work_session_func(project="Rie-AI")
        self.assertIn("Last Work Session", resume_summary)
        self.assertIn("Rie-AI", resume_summary)
        self.assertIn("`workstream`", resume_summary)
        self.assertIn("session_aggregator.py", resume_summary)
        self.assertIn("Resume Hint", resume_summary)

        # 2. Test get_last_work_session tool
        tool_res = get_last_work_session_tool.invoke({"project": "Rie-AI"})
        self.assertIn("Rie-AI", tool_res)
        self.assertIn("session_aggregator.py", tool_res)

    def test_live_dispatcher_integration(self):
        """Verifies that the live voice/chat dispatcher routes get_last_work_session directly."""
        import asyncio
        from app.live_tool_dispatcher import RieLiveToolDispatcher
        from app.workstream.store import workstream_store

        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI Workstream integration",
            summary="10:02–10:25 (23m) — Active on project Rie-AI (branch: workstream). Modified router.py.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=23)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1380.0,
            event_count=18,
            files=["app/server/app/workstream/router.py"],
            domains=["github.com"],
            commands=["poetry run pytest tests/test_workstream.py"],
            topics=["workstream"],
            primary_apps=["Antigravity"],
            metadata={"git_branch": "workstream"}
        )
        workstream_store.save_work_session(sess)
        self.created_global_session_ids.append(sess.session_id)

        dispatcher = RieLiveToolDispatcher()
        decls = [d["name"] for d in dispatcher.get_tool_declarations()]
        self.assertIn("get_last_work_session", decls)
        self.assertIn("get_work_sessions", decls)

        loop = asyncio.new_event_loop()
        try:
            res = loop.run_until_complete(
                dispatcher.dispatch("get_last_work_session", {"project": "Rie-AI"})
            )
            self.assertIn("Rie-AI", res)
            self.assertIn("Resume Hint", res)
        finally:
            loop.close()

    def test_auto_finalization_on_inactivity(self):
        """
        Verifies that an inactivity gap >= 20 minutes automatically finalizes the session.
        If current time is > 20 min after the last event, tail cluster is finalized.
        If current time is < 20 min after the last event, tail cluster is active/unfinalized.
        """
        now = datetime.now(timezone.utc)
        # Event cluster from 50 minutes ago to 25 minutes ago (inactive for 25 min > 20 min)
        events_past = [
            ActivityEvent(
                timestamp=(now - timedelta(minutes=50)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="auth.py - Rie-AI",
                metadata={"workspace": "Rie-AI", "file": "auth.py"},
                duration_seconds=300.0
            ),
            ActivityEvent(
                timestamp=(now - timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name="PowerShell",
                window_title="pytest tests/test_auth.py",
                metadata={"workspace": "Rie-AI", "command": "pytest tests/test_auth.py"},
                duration_seconds=120.0
            ),
            ActivityEvent(
                timestamp=(now - timedelta(minutes=25)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="auth.py - Rie-AI",
                metadata={"workspace": "Rie-AI", "file": "auth.py"},
                duration_seconds=60.0
            )
        ]
        self.store.insert_activity_events(events_past)

        sessions = self.aggregator.aggregate_events(timeframe="last_24_hours", idle_threshold_minutes=20)
        self.assertEqual(len(sessions), 1)
        # Inactive for 25 min > 20 min idle threshold -> finalized!
        self.assertTrue(sessions[0].is_finalized)
        self.assertEqual(sessions[0].metadata.get("status"), "finalized")

        # Now add an ongoing event from 2 minutes ago
        recent_event = ActivityEvent(
            timestamp=(now - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            event_type="window_focus",
            app_name="Visual Studio Code",
            window_title="router.py - Rie-AI",
            metadata={"workspace": "Rie-AI", "file": "router.py"},
            duration_seconds=60.0
        )
        self.store.insert_activity_events([recent_event])

        # Aggregation now produces 2 clusters (23 min gap between 25m ago and 2m ago > 20m)
        sessions_after = self.aggregator.aggregate_events(timeframe="last_24_hours", idle_threshold_minutes=20)
        self.assertEqual(len(sessions_after), 2)
        # Cluster 1 (old) is finalized
        self.assertTrue(sessions_after[0].is_finalized)
        # Cluster 2 (ongoing, 2 min ago) is active/unfinalized!
        self.assertFalse(sessions_after[1].is_finalized)
        self.assertEqual(sessions_after[1].metadata.get("status"), "in_progress")

    def test_auto_finalization_on_project_switch(self):
        """
        Verifies that switching to a different project workspace automatically finalizes
        the previous session and starts a new session for the new project.
        """
        now = datetime.now(timezone.utc)
        events = [
            ActivityEvent(
                timestamp=(now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="main.py - Rie-AI",
                metadata={"workspace": "Rie-AI", "file": "main.py"},
                duration_seconds=300.0
            ),
            # Meaningful project change 2 minutes later to 'React-Dashboard'
            ActivityEvent(
                timestamp=(now - timedelta(minutes=28)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="App.tsx - React-Dashboard",
                metadata={"workspace": "React-Dashboard", "file": "App.tsx"},
                duration_seconds=300.0
            ),
            ActivityEvent(
                timestamp=(now - timedelta(minutes=25)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name="PowerShell",
                window_title="npm run build",
                metadata={"workspace": "React-Dashboard", "command": "npm run build"},
                duration_seconds=60.0
            )
        ]
        self.store.insert_activity_events(events)
        sessions = self.aggregator.aggregate_events(timeframe="last_24_hours")
        self.assertEqual(len(sessions), 2)
        # First session was for Rie-AI and is finalized because of project shift
        self.assertEqual(sessions[0].project, "Rie-AI")
        self.assertTrue(sessions[0].is_finalized)
        # Second session is for React-Dashboard
        self.assertEqual(sessions[1].project, "React-Dashboard")

    def test_closing_and_reopening_session_flow(self):
        """
        Tests the complete closing and reopening lifecycle:
        1. User works on Rie-AI, then steps away (> 20 min).
        2. Session 1 closes and is finalized.
        3. User returns and resumes work.
        4. Session 2 opens as the active session.
        5. get_last_work_session reliably retrieves the closed, finalized Session 1.
        """
        now = datetime.now(timezone.utc)
        # Morning session: 60 min ago to 50 min ago (inactivity 50 min > 20 min)
        morning_events = [
            ActivityEvent(
                timestamp=(now - timedelta(minutes=60)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="auth.py - Rie-AI",
                metadata={"workspace": "Rie-AI", "file": "auth.py", "git_branch": "feature/auth"},
                duration_seconds=600.0
            ),
            ActivityEvent(
                timestamp=(now - timedelta(minutes=50)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name="PowerShell",
                window_title="poetry run pytest tests/test_auth.py",
                metadata={"workspace": "Rie-AI", "command": "poetry run pytest tests/test_auth.py"},
                duration_seconds=30.0
            )
        ]
        self.store.insert_activity_events(morning_events)
        first_sessions = self.aggregator.aggregate_events(timeframe="last_24_hours", idle_threshold_minutes=20)
        self.assertEqual(len(first_sessions), 1)
        self.assertTrue(first_sessions[0].is_finalized)
        closed_session_id = first_sessions[0].session_id

        # User steps away for 45 minutes, then returns 5 minutes ago and resumes
        resumed_events = [
            ActivityEvent(
                timestamp=(now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="auth.py - Rie-AI",
                metadata={"workspace": "Rie-AI", "file": "auth.py", "git_branch": "feature/auth"},
                duration_seconds=120.0
            )
        ]
        self.store.insert_activity_events(resumed_events)

        # Second aggregation
        second_sessions = self.aggregator.aggregate_events(timeframe="last_24_hours", idle_threshold_minutes=20)
        self.assertEqual(len(second_sessions), 2)
        # Old session is still finalized with same ID
        self.assertEqual(second_sessions[0].session_id, closed_session_id)
        self.assertTrue(second_sessions[0].is_finalized)
        # New session is currently active
        self.assertFalse(second_sessions[1].is_finalized)

        # Query latest work session with finalized_only=True
        latest_finalized = self.store.get_latest_work_session(project="Rie-AI", finalized_only=True)
        self.assertIsNotNone(latest_finalized)
        self.assertEqual(latest_finalized["session_id"], closed_session_id)
        self.assertTrue(latest_finalized["is_finalized"])

    def test_active_session_deduplication(self):
        """
        Verifies that repeated periodic aggregation runs on an ongoing session update
        the session in place rather than creating duplicate rows in the database.
        """
        now = datetime.now(timezone.utc)
        # Event 1
        self.store.insert_activity_events([
            ActivityEvent(
                timestamp=(now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="engine.py - Rie-AI",
                metadata={"workspace": "Rie-AI", "file": "engine.py"},
                duration_seconds=60.0
            )
        ])
        s1 = self.aggregator.aggregate_events(timeframe="last_24_hours", idle_threshold_minutes=20)
        self.assertEqual(len(s1), 1)
        orig_id = s1[0].id
        orig_uuid = s1[0].session_id

        # 2 minutes later, more events on same continuous session
        self.store.insert_activity_events([
            ActivityEvent(
                timestamp=(now - timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                event_type="terminal_command",
                app_name="PowerShell",
                window_title="git status",
                metadata={"workspace": "Rie-AI", "command": "git status"},
                duration_seconds=10.0
            )
        ])
        s2 = self.aggregator.aggregate_events(timeframe="last_24_hours", idle_threshold_minutes=20)
        self.assertEqual(len(s2), 1)
        # Must retain the same row ID and session UUID!
        self.assertEqual(s2[0].id, orig_id)
        self.assertEqual(s2[0].session_id, orig_uuid)
        self.assertEqual(s2[0].event_count, 2)

    def test_background_loop_lifecycle(self):
        """Verifies start_background_loop and stop_background_loop execute cleanly."""
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self.aggregator.start_background_loop(interval_seconds=60))
            self.assertTrue(self.aggregator._running)
            self.assertIsNotNone(self.aggregator._bg_task)

            # Stopping the background loop
            loop.run_until_complete(self.aggregator.stop_background_loop())
            self.assertFalse(self.aggregator._running)
        finally:
            loop.close()
            asyncio.set_event_loop(None)


if __name__ == "__main__":
    unittest.main()

"""
Unit tests for Phase 4.1: Deep Semantic Understanding (Task & Goal Extraction).
Tests intent inference, problem identification, technology detection, Chroma LTM enrichment,
and upgraded Jarvis 'Where did I leave off?' resume intelligence.
"""
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.workstream.models import ActivityEvent, WorkSession, SessionUnderstanding
from app.workstream.store import WorkstreamStore
from app.workstream.session_aggregator import SessionAggregator
from app.workstream.semantic_understanding import (
    SemanticUnderstandingEngine,
    semantic_understanding_engine,
    _detect_technologies,
    _identify_component,
)
from app.workstream.tools import get_last_work_session_func, get_last_work_session_tool
from app.workstream.router import router as workstream_router


class TestSemanticUnderstanding(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = Path(self.tmpdir) / "test_semantic_understanding.db"
        self.store = WorkstreamStore(db_path=self.db_path)
        self.aggregator = SessionAggregator(store=self.store)
        self.engine = SemanticUnderstandingEngine()
        test_app = FastAPI()
        test_app.include_router(workstream_router)
        self.client = TestClient(test_app)
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

    def test_infer_debugging_session_understanding(self):
        """
        Verifies task and goal extraction for a debugging session:
        detects error/failure signals, problem being solved, interrupted commands, and unresolved status.
        """
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI: Live Voice Dispatcher",
            summary="10:00–10:30 (30m) — Active on project Rie-AI (branch: bugfix/voice-tool-dispatch). Modified live_tool_dispatcher.py (+15/-8 lines); executed failing test.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1800.0,
            event_count=20,
            files=[
                "app/server/app/live_tool_dispatcher.py",
                "app/server/app/live_voice.py"
            ],
            domains=["github.com"],
            commands=[
                {"command": "poetry run pytest tests/test_live_tool_dispatcher.py", "exit_code": 1, "status": "failed"},
                {"command": "ping google.com", "exit_code": 130, "status": "interrupted"}
            ],
            topics=["live_voice", "terminal", "tool_dispatcher"],
            primary_apps=["Visual Studio Code", "PowerShell"],
            metadata={
                "git_branch": "bugfix/voice-tool-dispatch",
                "lines_added": 15,
                "lines_removed": 8,
                "interrupted_commands": ["ping google.com"]
            },
            is_finalized=True
        )

        und = self.engine.infer_session_understanding(sess)
        self.assertIsInstance(und, SessionUnderstanding)
        self.assertIn("Debugging", und.task)
        self.assertIn("Live Voice Tool Dispatcher", und.task)
        self.assertIsNotNone(und.problem)
        self.assertIn("ping google.com", und.problem)
        self.assertIn(und.status, ("interrupted", "in_progress"))

        # Technology detection
        self.assertIn("Python", und.technologies)
        self.assertIn("Live Voice", und.technologies)
        self.assertIn("pytest", und.technologies)
        self.assertIn("PowerShell", und.technologies)

        # Unresolved issues
        self.assertTrue(len(und.unresolved_issues) >= 1)
        self.assertTrue(any("ping google.com" in issue for issue in und.unresolved_issues))

    def test_infer_feature_development_understanding(self):
        """
        Verifies task and goal extraction for a feature development session:
        detects feature branch, files modified, passing tests, and completed status.
        """
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI: Semantic Memory Engine",
            summary="14:00–14:45 (45m) — Active on project Rie-AI (branch: feature/workstream-semantic-memory). Modified store.py, semantic_understanding.py (+120/-5 lines); ran all tests passing.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=45)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=2700.0,
            event_count=32,
            files=[
                "app/server/app/workstream/semantic_understanding.py",
                "app/server/app/workstream/store.py",
                "app/server/app/workstream/models.py"
            ],
            domains=["docs.python.org"],
            commands=[
                {"command": "poetry run pytest tests/test_workstream.py", "exit_code": 0, "status": "completed"}
            ],
            topics=["workstream", "semantic_memory"],
            primary_apps=["Antigravity", "PowerShell"],
            metadata={
                "git_branch": "feature/workstream-semantic-memory",
                "lines_added": 120,
                "lines_removed": 5
            },
            is_finalized=True
        )

        und = self.engine.infer_session_understanding(sess)
        self.assertIn("Implementing core features", und.task)
        self.assertIn("Workstream Session Engine", und.task)
        self.assertEqual(und.status, "completed")
        self.assertIn("+120/-5 lines", und.progress)
        self.assertIn("Python", und.technologies)
        self.assertIn("Workstream Engine", und.technologies)

    def test_infer_research_investigation_understanding(self):
        """
        Verifies task and goal extraction for a research-oriented session:
        detects web domains without code diffs and marks goal as architecture research.
        """
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Researched on chroma-core/chroma and stackoverflow.com",
            summary="11:00–11:20 (20m) — Researched on chroma-core/chroma and stackoverflow.com using Google Chrome.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1200.0,
            event_count=14,
            files=[],
            domains=["github.com", "stackoverflow.com"],
            commands=[],
            topics=["chromadb", "vector_embeddings"],
            primary_apps=["Google Chrome"],
            metadata={},
            is_finalized=True
        )

        und = self.engine.infer_session_understanding(sess)
        self.assertIn("Technical research", und.task)
        self.assertIn("github.com", und.task)
        self.assertIn("architectural approaches", und.goal)
        self.assertEqual(und.status, "completed")

    def test_chroma_ltm_rich_semantic_storage(self):
        """
        Verifies that when a session is finalized, its deep semantic understanding
        (task, goal, problem, progress, status, unresolved issues) is synced to Chroma LTM.
        """
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI: Live Voice Dispatcher",
            summary="Investigated tool calls and fixed routing logic.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=25)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=1500.0,
            files=["app/server/app/live_tool_dispatcher.py"],
            commands=[{"command": "pytest tests/test_core_session.py", "exit_code": 0}],
            is_finalized=True
        )

        # Enrich session with understanding
        self.engine.enrich_work_session(sess)
        self.assertIsNotNone(sess.understanding)

        # Save to store and verify persistence in SQLite
        saved = self.store.save_work_session(sess)
        fetched = self.store.get_session_by_id(saved.session_id)
        self.assertIsNotNone(fetched)
        self.assertIsNotNone(fetched.get("understanding"))
        self.assertEqual(fetched["understanding"]["task"], sess.understanding.task)
        self.assertEqual(fetched["understanding"]["status"], sess.understanding.status)

    def test_upgraded_jarvis_where_did_i_leave_off_flow(self):
        """
        Verifies the upgraded Jarvis 'Where did I leave off?' resume intelligence:
        returns task, objective, problem investigated, status, progress, unresolved issues, and resume hint.
        """
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI: Live Voice Dispatcher",
            summary="Debugging interrupted command tracking and tool dispatcher routing.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=40)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            duration_seconds=2400.0,
            files=["app/server/app/live_tool_dispatcher.py"],
            commands=[
                {"command": "poetry run pytest tests/test_core_session.py", "exit_code": 0},
                {"command": "ping google.com", "exit_code": 130, "status": "interrupted"}
            ],
            topics=["live_voice", "dispatcher"],
            primary_apps=["Visual Studio Code", "PowerShell"],
            metadata={
                "git_branch": "bugfix/voice-dispatcher",
                "interrupted_commands": ["ping google.com"]
            },
            is_finalized=True
        )
        self.engine.enrich_work_session(sess)
        self.store.save_work_session(sess)

        # Also save to the global store so agent tools can access it directly
        from app.workstream.store import workstream_store
        with workstream_store._get_connection() as conn:
            conn.execute("DELETE FROM work_sessions WHERE project = 'Rie-AI'")
            conn.commit()
        workstream_store.save_work_session(sess)
        self.created_global_session_ids.append(sess.session_id)

        resume_text = get_last_work_session_func(project="Rie-AI")
        self.assertIn("Last Work Session", resume_text)
        self.assertIn("Objective / Goal", resume_text)
        self.assertIn("Problem Investigated", resume_text)
        self.assertIn("Status", resume_text)
        self.assertIn("Technologies", resume_text)
        self.assertIn("Unresolved Issues & Next Steps", resume_text)
        self.assertIn("ping google.com", resume_text)
        self.assertIn("Resume Hint", resume_text)

        # Also test via StructuredTool invoke
        tool_res = get_last_work_session_tool.invoke({"project": "Rie-AI"})
        self.assertIn("Objective / Goal", tool_res)
        self.assertIn("Resume Hint", tool_res)

    def test_router_understand_endpoint(self):
        """Tests the POST /workstream/sessions/{session_id}/understand API endpoint."""
        now = datetime.now(timezone.utc)
        sess = WorkSession(
            title="Worked on Rie-AI Workstream API",
            summary="Added understanding endpoint to router.",
            project="Rie-AI",
            start_time=(now - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            end_time=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            files=["app/server/app/workstream/router.py"],
            is_finalized=True
        )
        from app.workstream.store import workstream_store
        saved = workstream_store.save_work_session(sess)
        self.created_global_session_ids.append(saved.session_id)

        res = self.client.post(f"/workstream/sessions/{saved.session_id}/understand")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertEqual(data["session_id"], saved.session_id)
        self.assertIsNotNone(data["understanding"])
        self.assertIn("task", data["understanding"])
        self.assertIn("goal", data["understanding"])


if __name__ == "__main__":
    unittest.main()

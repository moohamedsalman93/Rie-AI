"""
Unit and integration tests for Workstream Sensor Config Toggles (Phase 3.5).
Verifies that turning each individual sensor or the master Workstream switch OFF
guarantees ZERO events are generated, accepted, or stored.
Also verifies real-time sensor status reporting, privacy masks, and config caching.
"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone

from fastapi.testclient import TestClient
from main import app
from app.workstream.models import (
    WorkstreamConfig,
    SensorConfig,
    PrivacyConfig,
    MemoryConfig,
    ActivityEvent,
    ClipboardEvent,
    BrowserEvent,
    IDEEvent,
    TerminalEvent,
)
from app.workstream.store import workstream_store, WorkstreamStore
from app.workstream.session_aggregator import session_aggregator


class TestSensorConfigToggles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def setUp(self):
        # Reset tables to clean slate for each test
        with workstream_store._get_connection() as conn:
            conn.execute("DELETE FROM activity_events")
            conn.execute("DELETE FROM clipboard_events")
            conn.execute("DELETE FROM work_sessions")
            conn.commit()

        # Reset default enabled config
        self.default_cfg = WorkstreamConfig(
            workstream=True,
            sensors=SensorConfig(
                windows=True,
                idle=True,
                clipboard=True,
                browser=True,
                ide=True,
                terminal=True,
            ),
            privacy=PrivacyConfig(
                track_clipboard_content=True,
                track_file_changes=True,
                track_urls=True,
            ),
            memory=MemoryConfig(
                sessions=True,
                semantic=True,
                ltm=True,
            ),
            retention_days=60,
            is_paused=False,
        )
        workstream_store.update_config(self.default_cfg)

    def tearDown(self):
        # Restore default config after test
        workstream_store.update_config(self.default_cfg)

    def test_01_master_workstream_toggle_off_drops_all_events(self):
        """When master workstream toggle is OFF, zero events are ingested."""
        # 1. Turn master Workstream OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.workstream = False
        res = self.client.post("/workstream/config", json=cfg.model_dump())
        self.assertEqual(res.status_code, 200)

        # 2. Try to post multiple sensor events
        batch = {
            "activity_events": [
                {
                    "event_type": "window_focus",
                    "app_name": "Visual Studio Code",
                    "window_title": "app.py - project",
                    "duration_seconds": 15.0,
                },
                {
                    "event_type": "browser_tab",
                    "browser": "Brave",
                    "url": "https://github.com",
                    "title": "GitHub",
                },
                {
                    "event_type": "terminal_command",
                    "shell": "PowerShell",
                    "command": "git status",
                    "exit_code": 0,
                }
            ],
            "clipboard_events": [
                {
                    "app_name": "Visual Studio Code",
                    "content": "def test_master_off(): pass",
                    "content_type": "code",
                }
            ]
        }
        res_post = self.client.post("/workstream/events", json=batch)
        self.assertEqual(res_post.status_code, 200)
        data = res_post.json()
        self.assertEqual(data["ingested_activities"], 0)
        self.assertEqual(data["ingested_clipboards"], 0)

        # 3. Verify zero events in SQLite
        with workstream_store._get_connection() as conn:
            act_count = conn.execute("SELECT COUNT(*) FROM activity_events").fetchone()[0]
            clip_count = conn.execute("SELECT COUNT(*) FROM clipboard_events").fetchone()[0]
        self.assertEqual(act_count, 0)
        self.assertEqual(clip_count, 0)

    def test_02_windows_focus_sensor_toggle(self):
        """When Windows focus sensor is OFF, window_focus events are dropped."""
        # 1. Turn Windows focus sensor OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.windows = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        # 2. Post window focus event
        win_payload = {
            "event_type": "window_focus",
            "app_name": "Google Chrome",
            "window_title": "Google Search",
            "duration_seconds": 45.0,
        }
        res = self.client.post("/workstream/events", json=win_payload)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["ingested_activities"], 0)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM activity_events WHERE event_type = 'window_focus'").fetchone()[0]
        self.assertEqual(count, 0)

        # 3. Turn Windows focus sensor back ON -> verify ingested
        cfg.sensors.windows = True
        self.client.post("/workstream/config", json=cfg.model_dump())
        res_on = self.client.post("/workstream/events", json=win_payload)
        self.assertEqual(res_on.json()["ingested_activities"], 1)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM activity_events WHERE event_type = 'window_focus'").fetchone()[0]
        self.assertEqual(count, 1)

    def test_03_idle_detection_sensor_toggle(self):
        """When idle sensor is OFF, idle_start and idle_end events are dropped."""
        # 1. Turn idle sensor OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.idle = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        # 2. Post idle events
        idle_payload = {
            "activity_events": [
                {"event_type": "idle_start", "app_name": "System", "duration_seconds": 0.0},
                {"event_type": "idle_end", "app_name": "System", "duration_seconds": 180.0},
            ]
        }
        res = self.client.post("/workstream/events", json=idle_payload)
        self.assertEqual(res.json()["ingested_activities"], 0)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM activity_events WHERE event_type IN ('idle_start', 'idle_end')").fetchone()[0]
        self.assertEqual(count, 0)

        # 3. Turn idle sensor ON -> verify accepted
        cfg.sensors.idle = True
        self.client.post("/workstream/config", json=cfg.model_dump())
        res_on = self.client.post("/workstream/events", json=idle_payload)
        self.assertEqual(res_on.json()["ingested_activities"], 2)

    def test_04_clipboard_sensor_toggle(self):
        """When clipboard sensor is OFF, clipboard copies are dropped."""
        # 1. Turn clipboard sensor OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.clipboard = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        # 2. Post clipboard event
        clip_payload = {
            "clipboard_events": [
                {
                    "app_name": "Notepad",
                    "content": "Secret Token: 12345678",
                    "content_type": "text",
                }
            ]
        }
        res = self.client.post("/workstream/events", json=clip_payload)
        self.assertEqual(res.json()["ingested_clipboards"], 0)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM clipboard_events").fetchone()[0]
        self.assertEqual(count, 0)

        # 3. Turn clipboard sensor ON -> verify ingested
        cfg.sensors.clipboard = True
        self.client.post("/workstream/config", json=cfg.model_dump())
        res_on = self.client.post("/workstream/events", json=clip_payload)
        self.assertEqual(res_on.json()["ingested_clipboards"], 1)

    def test_05_browser_sensor_toggle(self):
        """When browser sensor is OFF, browser tab events are dropped."""
        # 1. Turn browser sensor OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.browser = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        # 2. Post browser tab event
        b_payload = {
            "event_type": "browser_tab",
            "browser": "Brave",
            "url": "https://news.ycombinator.com",
            "title": "Hacker News",
        }
        res = self.client.post("/workstream/events", json=b_payload)
        self.assertEqual(res.json()["ingested_activities"], 0)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM activity_events WHERE app_name = 'Brave'").fetchone()[0]
        self.assertEqual(count, 0)

        # 3. Turn browser sensor ON -> verify ingested
        cfg.sensors.browser = True
        self.client.post("/workstream/config", json=cfg.model_dump())
        res_on = self.client.post("/workstream/events", json=b_payload)
        self.assertEqual(res_on.json()["ingested_activities"], 1)

    def test_06_ide_sensor_toggle(self):
        """When IDE sensor is OFF, editor context and file change events are dropped."""
        # 1. Turn IDE sensor OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.ide = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        # 2. Post IDE context event
        ide_payload = {
            "event_type": "ide_context",
            "ide": "Antigravity",
            "workspace": "Rie-AI",
            "file": "server/main.py",
            "language": "Python",
        }
        res = self.client.post("/workstream/events", json=ide_payload)
        self.assertEqual(res.json()["ingested_activities"], 0)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM activity_events WHERE source IN ('vscode_ext', 'ide')").fetchone()[0]
        self.assertEqual(count, 0)

        # 3. Turn IDE sensor ON -> verify ingested
        cfg.sensors.ide = True
        self.client.post("/workstream/config", json=cfg.model_dump())
        res_on = self.client.post("/workstream/events", json=ide_payload)
        self.assertEqual(res_on.json()["ingested_activities"], 1)

    def test_07_terminal_sensor_toggle(self):
        """When terminal sensor is OFF, terminal commands are dropped."""
        # 1. Turn terminal sensor OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.terminal = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        # 2. Post terminal command event
        term_payload = {
            "event_type": "terminal_command",
            "shell": "PowerShell",
            "command": "poetry run pytest",
            "cwd": "D:/projects/Rie-AI",
            "status": "completed",
            "exit_code": 0,
        }
        res = self.client.post("/workstream/events", json=term_payload)
        self.assertEqual(res.json()["ingested_activities"], 0)

        with workstream_store._get_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM activity_events WHERE event_type = 'terminal_command'").fetchone()[0]
        self.assertEqual(count, 0)

        # 3. Turn terminal sensor ON -> verify ingested
        cfg.sensors.terminal = True
        self.client.post("/workstream/config", json=cfg.model_dump())
        res_on = self.client.post("/workstream/events", json=term_payload)
        self.assertEqual(res_on.json()["ingested_activities"], 1)

    def test_08_privacy_toggles_urls_and_clipboard_content(self):
        """Verifies track_urls and track_clipboard_content privacy enforcement."""
        # 1. track_urls = False -> URL should be stripped from stored event metadata
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.privacy.track_urls = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        res_url = self.client.post("/workstream/events", json={
            "event_type": "browser_tab",
            "browser": "Edge",
            "url": "https://internal-docs.company.com/finance",
            "title": "Confidential Finance Report",
        })
        self.assertEqual(res_url.json()["ingested_activities"], 1)

        with workstream_store._get_connection() as conn:
            row = conn.execute("SELECT window_title, metadata_json FROM activity_events ORDER BY id DESC LIMIT 1").fetchone()
            meta = json.loads(row["metadata_json"])
            self.assertNotIn("url", meta)
            self.assertNotIn("https://", row["window_title"])

        # 2. track_clipboard_content = False -> content must be masked
        cfg.privacy.track_clipboard_content = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        res_clip = self.client.post("/workstream/events", json={
            "clipboard_events": [{
                "app_name": "Slack",
                "content": "api_key_secret_value_xyz",
                "content_type": "text",
            }]
        })
        self.assertEqual(res_clip.json()["ingested_clipboards"], 1)

        with workstream_store._get_connection() as conn:
            row = conn.execute("SELECT content, content_hash FROM clipboard_events ORDER BY id DESC LIMIT 1").fetchone()
            self.assertEqual(row["content"], "[Content Hidden by Privacy Policy]")
            self.assertTrue(len(row["content_hash"]) > 0)

    def test_09_memory_sessions_toggle_disables_aggregation(self):
        """When memory.sessions = False, session aggregation synthesizes zero sessions."""
        # Insert raw activity events
        workstream_store.insert_activity_events([
            ActivityEvent(
                event_type="window_focus",
                app_name="Visual Studio Code",
                window_title="router.py - Rie-AI",
                duration_seconds=120.0,
            )
        ])

        # 1. Turn sessions OFF
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.memory.sessions = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        sessions = session_aggregator.aggregate_events(timeframe="today")
        self.assertEqual(len(sessions), 0)

        # 2. Turn sessions ON
        cfg.memory.sessions = True
        self.client.post("/workstream/config", json=cfg.model_dump())

        sessions_on = session_aggregator.aggregate_events(timeframe="today")
        self.assertGreater(len(sessions_on), 0)

    def test_10_sensors_status_endpoint_contract(self):
        """Verifies GET /workstream/sensors/status reports health and detected tools."""
        res = self.client.get("/workstream/sensors/status")
        self.assertEqual(res.status_code, 200)
        data = res.json()

        self.assertIn("workstream", data)
        self.assertIn("sensors", data)
        self.assertIn("privacy", data)
        self.assertIn("memory", data)

        for sensor_name in ["windows", "idle", "clipboard", "browser", "ide", "terminal"]:
            self.assertIn(sensor_name, data["sensors"])
            self.assertIn("enabled", data["sensors"][sensor_name])
            self.assertIn("status", data["sensors"][sensor_name])

    def test_11_config_cache_file_created(self):
        """Verifies that updating config writes to shared temp cache file for shell hooks."""
        cfg = self.default_cfg.model_copy(deep=True)
        cfg.sensors.terminal = False
        self.client.post("/workstream/config", json=cfg.model_dump())

        cache_path = Path(tempfile.gettempdir()) / "rie_workstream_config.json"
        self.assertTrue(cache_path.exists())
        cached_json = json.loads(cache_path.read_text(encoding="utf-8"))
        self.assertFalse(cached_json["sensors"]["terminal"])

"""
SQLite and FTS5 storage engine for Rie-AI Workstream.
Provides local, zero-leak persistence, privacy filtering, deduplication, and retention management.
"""
from datetime import datetime, timezone, timedelta
import json
import logging
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
from typing import Any, Dict, List, Optional, Tuple
import uuid

from app.database import get_db_path
from app.workstream.models import (
    ActivityEvent,
    ClipboardEvent,
    WorkstreamPolicy,
    WorkstreamConfig,
    SensorConfig,
    PrivacyConfig,
    MemoryConfig,
    WorkSession,
)

logger = logging.getLogger("workstream.store")

_lock = threading.RLock()


def get_workstream_db_path() -> Path:
    """Returns the path to workstream.db alongside settings.db."""
    settings_path = get_db_path()
    workstream_path = settings_path.parent / "workstream.db"
    workstream_path.parent.mkdir(parents=True, exist_ok=True)
    return workstream_path


class WorkstreamStore:
    """
    Manages SQLite tables and FTS5 full-text indexes for workstream activity and clipboard events.
    Thread-safe and optimized with SQLite WAL mode.
    """

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or get_workstream_db_path()
        self._policy_cache: Optional[WorkstreamPolicy] = None
        self._last_clipboard_hash: Optional[str] = None
        self._last_clipboard_time: Optional[datetime] = None
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        """Creates an SQLite connection configured with WAL and busy timeout."""
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        return conn

    def _init_db(self) -> None:
        """Initializes tables, indexes, and FTS5 virtual tables."""
        with _lock, self._get_connection() as conn:
            # 1. Activity Events Table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS activity_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE,
                    timestamp TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    app_name TEXT NOT NULL,
                    process_name TEXT,
                    window_title TEXT,
                    source TEXT,
                    metadata_json TEXT,
                    duration_seconds REAL DEFAULT 0.0,
                    created_at TEXT NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_events(timestamp);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_app ON activity_events(app_name);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_events(event_type);")

            # 2. Clipboard Events Table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS clipboard_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT UNIQUE,
                    timestamp TEXT NOT NULL,
                    app_name TEXT,
                    content TEXT NOT NULL,
                    content_hash TEXT,
                    content_type TEXT,
                    created_at TEXT NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_clipboard_timestamp ON clipboard_events(timestamp);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_clipboard_hash ON clipboard_events(content_hash);")

            # 3. Policy Table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS workstream_policy (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            """)

            # 4. Semantic Work Sessions Table
            conn.execute("""
                CREATE TABLE IF NOT EXISTS work_sessions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT UNIQUE NOT NULL,
                    start_time TEXT NOT NULL,
                    end_time TEXT NOT NULL,
                    duration_seconds REAL DEFAULT 0.0,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    project TEXT,
                    files_json TEXT DEFAULT '[]',
                    domains_json TEXT DEFAULT '[]',
                    commands_json TEXT DEFAULT '[]',
                    topics_json TEXT DEFAULT '[]',
                    apps_json TEXT DEFAULT '[]',
                    event_count INTEGER DEFAULT 0,
                    metadata_json TEXT DEFAULT '{}',
                    is_finalized INTEGER DEFAULT 1,
                    understanding_json TEXT DEFAULT NULL,
                    created_at TEXT NOT NULL
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_session_start ON work_sessions(start_time);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_session_end ON work_sessions(end_time);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_session_project ON work_sessions(project);")
            try:
                conn.execute("ALTER TABLE work_sessions ADD COLUMN is_finalized INTEGER DEFAULT 1;")
            except Exception:
                pass
            try:
                conn.execute("ALTER TABLE work_sessions ADD COLUMN understanding_json TEXT DEFAULT NULL;")
            except Exception:
                pass
            conn.execute("CREATE INDEX IF NOT EXISTS idx_session_finalized ON work_sessions(is_finalized);")

            # 5. FTS5 Virtual Tables & Triggers
            try:
                conn.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS activity_fts USING fts5(
                        window_title,
                        app_name,
                        content='activity_events',
                        content_rowid='id'
                    );
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_activity_ai AFTER INSERT ON activity_events BEGIN
                        INSERT INTO activity_fts(rowid, window_title, app_name) VALUES (new.id, new.window_title, new.app_name);
                    END;
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_activity_ad AFTER DELETE ON activity_events BEGIN
                        INSERT INTO activity_fts(activity_fts, rowid, window_title, app_name) VALUES('delete', old.id, old.window_title, old.app_name);
                    END;
                """)

                conn.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS clipboard_fts USING fts5(
                        content,
                        app_name,
                        content='clipboard_events',
                        content_rowid='id'
                    );
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_clipboard_ai AFTER INSERT ON clipboard_events BEGIN
                        INSERT INTO clipboard_fts(rowid, content, app_name) VALUES (new.id, new.content, new.app_name);
                    END;
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_clipboard_ad AFTER DELETE ON clipboard_events BEGIN
                        INSERT INTO clipboard_fts(clipboard_fts, rowid, content, app_name) VALUES('delete', old.id, old.content, old.app_name);
                    END;
                """)

                # FTS5 for Semantic Work Sessions
                conn.execute("""
                    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
                        title,
                        summary,
                        project,
                        topics,
                        files,
                        domains,
                        apps,
                        content='work_sessions',
                        content_rowid='id'
                    );
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_session_ai AFTER INSERT ON work_sessions BEGIN
                        INSERT INTO session_fts(rowid, title, summary, project, topics, files, domains, apps)
                        VALUES (new.id, new.title, new.summary, new.project, new.topics_json, new.files_json, new.domains_json, new.apps_json);
                    END;
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_session_ad AFTER DELETE ON work_sessions BEGIN
                        INSERT INTO session_fts(session_fts, rowid, title, summary, project, topics, files, domains, apps)
                        VALUES ('delete', old.id, old.title, old.summary, old.project, old.topics_json, old.files_json, old.domains_json, old.apps_json);
                    END;
                """)
                conn.execute("""
                    CREATE TRIGGER IF NOT EXISTS trg_session_au AFTER UPDATE ON work_sessions BEGIN
                        INSERT INTO session_fts(session_fts, rowid, title, summary, project, topics, files, domains, apps)
                        VALUES ('delete', old.id, old.title, old.summary, old.project, old.topics_json, old.files_json, old.domains_json, old.apps_json);
                        INSERT INTO session_fts(rowid, title, summary, project, topics, files, domains, apps)
                        VALUES (new.id, new.title, new.summary, new.project, new.topics_json, new.files_json, new.domains_json, new.apps_json);
                    END;
                """)
            except Exception as e:
                logger.warning(f"Failed to initialize SQLite FTS5 tables: {e}. Keyword search will fallback to LIKE.")

            conn.commit()

        # Load persisted policy
        self._load_policy()

    def _load_policy(self) -> WorkstreamPolicy:
        """Loads policy from DB or defaults."""
        with _lock, self._get_connection() as conn:
            cursor = conn.execute("SELECT value FROM workstream_policy WHERE key = 'active_policy'")
            row = cursor.fetchone()
            if row:
                try:
                    data = json.loads(row["value"])
                    self._policy_cache = WorkstreamPolicy(**data)
                except Exception as e:
                    logger.warning(f"Failed to parse stored workstream policy: {e}")
                    self._policy_cache = WorkstreamPolicy()
            else:
                self._policy_cache = WorkstreamPolicy()
                conn.execute(
                    "INSERT INTO workstream_policy (key, value) VALUES ('active_policy', ?)",
                    (self._policy_cache.model_dump_json(),)
                )
                conn.commit()
        if self._policy_cache:
            self._write_config_cache(self._policy_cache.to_config())
        return self._policy_cache

    def get_policy(self) -> WorkstreamPolicy:
        """Returns the current policy."""
        if self._policy_cache is None:
            return self._load_policy()
        return self._policy_cache

    def _write_config_cache(self, config: WorkstreamConfig) -> None:
        """Writes current config to a shared JSON cache in temp directory for zero-latency shell/extension access."""
        try:
            cache_file = Path(tempfile.gettempdir()) / "rie_workstream_config.json"
            cache_file.write_text(config.model_dump_json(), encoding="utf-8")
        except Exception as e:
            logger.debug(f"Could not write workstream config cache: {e}")

    def update_policy(self, policy: WorkstreamPolicy) -> None:
        """Updates and persists the policy."""
        with _lock, self._get_connection() as conn:
            self._policy_cache = policy
            conn.execute(
                "INSERT OR REPLACE INTO workstream_policy (key, value) VALUES ('active_policy', ?)",
                (policy.model_dump_json(),)
            )
            conn.commit()
        self._write_config_cache(policy.to_config())

    def get_config(self) -> WorkstreamConfig:
        """Returns the unified WorkstreamConfig."""
        return self.get_policy().to_config()

    def update_config(self, config: WorkstreamConfig) -> WorkstreamConfig:
        """Updates and persists unified WorkstreamConfig."""
        policy = WorkstreamPolicy.from_config(config)
        self.update_policy(policy)
        return config

    def get_sensor_status(self) -> Dict[str, Any]:
        """Returns live connection and health status for all sensors."""
        cfg = self.get_config()
        now_dt = datetime.now(timezone.utc)

        with self._get_connection() as conn:
            def _get_latest_ts(where_clause: str, params: tuple = ()) -> Optional[str]:
                row = conn.execute(
                    f"SELECT timestamp FROM activity_events WHERE {where_clause} ORDER BY timestamp DESC LIMIT 1",
                    params
                ).fetchone()
                return row[0] if row else None

            def _get_count(table: str, where_clause: str = "1=1", params: tuple = ()) -> int:
                row = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where_clause}", params).fetchone()
                return row[0] if row else 0

            latest_win = _get_latest_ts("event_type = 'window_focus'")
            latest_idle = _get_latest_ts("event_type IN ('idle_start', 'idle_end')")
            latest_browser = _get_latest_ts("source = 'browser_ext' OR event_type IN ('browser_tab', 'tab_activated', 'tab_updated')")
            latest_ide = _get_latest_ts("source = 'vscode_ext' OR event_type IN ('ide_context', 'file_change')")
            latest_term = _get_latest_ts("source = 'terminal' OR event_type = 'terminal_command'")

            clip_row = conn.execute("SELECT timestamp FROM clipboard_events ORDER BY timestamp DESC LIMIT 1").fetchone()
            latest_clip = clip_row[0] if clip_row else None

            browser_rows = conn.execute(
                "SELECT DISTINCT app_name FROM activity_events WHERE source = 'browser_ext' OR event_type IN ('browser_tab', 'tab_activated', 'tab_updated') LIMIT 5"
            ).fetchall()
            detected_browsers = [r[0] for r in browser_rows if r[0]]

            ide_rows = conn.execute(
                "SELECT DISTINCT app_name FROM activity_events WHERE source = 'vscode_ext' OR event_type IN ('ide_context', 'file_change') LIMIT 5"
            ).fetchall()
            detected_ides = [r[0] for r in ide_rows if r[0]]

            shell_rows = conn.execute(
                "SELECT DISTINCT app_name FROM activity_events WHERE source = 'terminal' OR event_type = 'terminal_command' LIMIT 5"
            ).fetchall()
            detected_shells = [r[0] for r in shell_rows if r[0]]

            total_activities = _get_count("activity_events")
            total_clipboards = _get_count("clipboard_events")
            total_sessions = _get_count("work_sessions")
            latest_sess = conn.execute("SELECT title, start_time, project FROM work_sessions ORDER BY start_time DESC LIMIT 1").fetchone()

        def _compute_status(is_enabled: bool, latest_ts: Optional[str], recent_threshold_mins: int = 15) -> str:
            if not cfg.workstream or not is_enabled:
                return "disabled"
            if not latest_ts:
                return "offline"
            try:
                clean = latest_ts.replace("Z", "+00:00")
                evt_dt = datetime.fromisoformat(clean)
                if evt_dt.tzinfo is None:
                    evt_dt = evt_dt.replace(tzinfo=timezone.utc)
                if (now_dt - evt_dt).total_seconds() <= recent_threshold_mins * 60:
                    return "connected"
                return "idle"
            except Exception:
                return "connected" if latest_ts else "offline"

        return {
            "workstream": cfg.workstream,
            "is_paused": cfg.is_paused,
            "total_activities": total_activities,
            "total_clipboards": total_clipboards,
            "sensors": {
                "windows": {
                    "enabled": cfg.sensors.windows,
                    "status": _compute_status(cfg.sensors.windows, latest_win),
                    "last_event": latest_win,
                },
                "idle": {
                    "enabled": cfg.sensors.idle,
                    "status": _compute_status(cfg.sensors.idle, latest_idle),
                    "last_event": latest_idle,
                },
                "clipboard": {
                    "enabled": cfg.sensors.clipboard,
                    "status": _compute_status(cfg.sensors.clipboard, latest_clip),
                    "last_event": latest_clip,
                },
                "browser": {
                    "enabled": cfg.sensors.browser,
                    "status": _compute_status(cfg.sensors.browser, latest_browser),
                    "last_event": latest_browser,
                    "detected_browsers": detected_browsers or ["Brave / Chrome / Edge"],
                },
                "ide": {
                    "enabled": cfg.sensors.ide,
                    "status": _compute_status(cfg.sensors.ide, latest_ide),
                    "last_event": latest_ide,
                    "detected_ides": detected_ides or ["Antigravity / VS Code"],
                },
                "terminal": {
                    "enabled": cfg.sensors.terminal,
                    "status": _compute_status(cfg.sensors.terminal, latest_term),
                    "last_event": latest_term,
                    "detected_shells": detected_shells or ["PowerShell / Bash / CMD"],
                }
            },
            "privacy": {
                "track_clipboard_content": cfg.privacy.track_clipboard_content,
                "track_file_changes": cfg.privacy.track_file_changes,
                "track_urls": cfg.privacy.track_urls,
                "exclude_apps_count": len(cfg.privacy.exclude_apps),
                "exclude_apps": cfg.privacy.exclude_apps,
            },
            "memory": {
                "sessions": {
                    "enabled": cfg.memory.sessions,
                    "status": "active" if (cfg.workstream and cfg.memory.sessions) else "disabled",
                    "total_sessions": total_sessions,
                    "latest_session": dict(latest_sess) if latest_sess else None,
                },
                "semantic": {
                    "enabled": cfg.memory.semantic,
                    "status": "active" if (cfg.workstream and cfg.memory.semantic) else "disabled",
                },
                "ltm": {
                    "enabled": cfg.memory.ltm,
                    "status": "active" if (cfg.workstream and cfg.memory.ltm) else "disabled",
                }
            }
        }

    def set_paused(self, paused: bool) -> None:
        """Pauses or resumes workstream ingestion."""
        policy = self.get_policy()
        policy.is_paused = paused
        self.update_policy(policy)
        logger.info(f"Workstream collection paused state set to: {paused}")

    def is_paused(self) -> bool:
        """Returns True if collection is paused."""
        return self.get_policy().is_paused

    def _is_app_excluded(self, app_name: str, process_name: Optional[str] = None) -> bool:
        """Checks if the application matches any exclusion keywords (e.g. password managers)."""
        policy = self.get_policy()
        name_lower = (app_name or "").lower()
        proc_lower = (process_name or "").lower()

        for excluded in policy.exclude_apps:
            exc = excluded.strip().lower()
            if not exc:
                continue
            if exc in name_lower or exc in proc_lower:
                return True
        return False

    def insert_activity_events(self, events: List[ActivityEvent]) -> int:
        """
        Inserts a batch of activity events, respecting privacy and exclusions.
        Returns the number of events actually written.
        """
        if not events:
            return 0
        policy = self.get_policy()
        if not policy.enabled or policy.is_paused:
            logger.debug("Workstream is paused or disabled; dropping activity events batch.")
            return 0

        now_str = datetime.now(timezone.utc).isoformat()
        written_count = 0

        with _lock, self._get_connection() as conn:
            for evt in events:
                if self._is_app_excluded(evt.app_name, evt.process_name):
                    logger.debug(f"Excluding activity event for sensitive app: {evt.app_name} ({evt.process_name})")
                    continue

                # Sensor-specific enablement checks
                if evt.event_type in ("idle_start", "idle_end") and not getattr(policy.sensors, "idle", True):
                    continue
                if evt.event_type == "window_focus" and not getattr(policy.sensors, "windows", True):
                    continue
                if (evt.source == "browser_ext" or evt.event_type in ("browser_tab", "tab_activated", "tab_updated")) and not getattr(policy.sensors, "browser", True):
                    continue
                if (evt.source in ("vscode_ext", "ide") or evt.event_type in ("ide_context", "file_change")) and not getattr(policy.sensors, "ide", True):
                    continue
                if (evt.source == "terminal" or evt.event_type == "terminal_command") and not getattr(policy.sensors, "terminal", True):
                    continue

                # Privacy filtering
                if not getattr(policy.privacy, "track_urls", True):
                    if evt.metadata and "url" in evt.metadata:
                        evt.metadata.pop("url", None)
                    if evt.window_title and ("http://" in evt.window_title or "https://" in evt.window_title):
                        evt.window_title = evt.app_name or "Web Browser"
                if not getattr(policy.privacy, "track_file_changes", True) and evt.event_type == "file_change":
                    continue

                event_id = evt.id or str(uuid.uuid4())
                metadata_str = json.dumps(evt.metadata or {})

                # 1. If explicit event_id exists (e.g. updating a running command to completed or interrupted)
                existing = conn.execute("SELECT id FROM activity_events WHERE event_id = ?", (event_id,)).fetchone()
                if existing:
                    conn.execute("""
                        UPDATE activity_events SET
                            timestamp = ?,
                            event_type = ?,
                            app_name = ?,
                            process_name = ?,
                            window_title = ?,
                            source = ?,
                            metadata_json = ?,
                            duration_seconds = ?
                        WHERE event_id = ?
                    """, (
                        evt.timestamp,
                        evt.event_type,
                        evt.app_name,
                        evt.process_name,
                        evt.window_title,
                        evt.source,
                        metadata_str,
                        float(evt.duration_seconds),
                        event_id
                    ))
                    try:
                        conn.execute("UPDATE activity_fts SET window_title = ?, app_name = ? WHERE rowid = ?", (evt.window_title, evt.app_name, existing[0]))
                    except Exception:
                        pass
                    written_count += 1
                    continue

                # 2. If terminal completion/interruption without explicit id matches recent "running" event
                matched_running = None
                if evt.event_type == "terminal_command" and evt.metadata.get("status") in ("completed", "interrupted", "failed"):
                    cmd = evt.metadata.get("command") or evt.window_title
                    shell = evt.metadata.get("shell") or evt.app_name
                    matched_running = conn.execute("""
                        SELECT id, event_id, timestamp FROM activity_events
                        WHERE event_type = 'terminal_command' AND app_name = ?
                          AND (window_title LIKE ? OR metadata_json LIKE ?)
                          AND (metadata_json LIKE '%"status": "running"%' OR window_title LIKE '%running%')
                        ORDER BY timestamp DESC LIMIT 1
                    """, (shell, f"{cmd}%", f'%"{cmd}"%')).fetchone()

                if matched_running:
                    dur = float(evt.duration_seconds)
                    if dur <= 0:
                        try:
                            start_dt = datetime.fromisoformat(matched_running["timestamp"].replace("Z", "+00:00"))
                            end_dt = datetime.fromisoformat(evt.timestamp.replace("Z", "+00:00"))
                            dur = max(0.0, (end_dt - start_dt).total_seconds())
                            meta_dict = dict(evt.metadata or {})
                            meta_dict["duration"] = round(dur, 3)
                            metadata_str = json.dumps(meta_dict)
                        except Exception:
                            pass

                    conn.execute("""
                        UPDATE activity_events SET
                            timestamp = ?,
                            window_title = ?,
                            metadata_json = ?,
                            duration_seconds = ?
                        WHERE id = ?
                    """, (
                        evt.timestamp,
                        evt.window_title,
                        metadata_str,
                        dur,
                        matched_running["id"]
                    ))
                    try:
                        conn.execute("UPDATE activity_fts SET window_title = ?, app_name = ? WHERE rowid = ?", (evt.window_title, evt.app_name, matched_running["id"]))
                    except Exception:
                        pass
                    written_count += 1
                    continue

                # 3. New event insertion
                conn.execute("""
                    INSERT INTO activity_events (
                        event_id, timestamp, event_type, app_name, process_name,
                        window_title, source, metadata_json, duration_seconds, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    event_id,
                    evt.timestamp,
                    evt.event_type,
                    evt.app_name,
                    evt.process_name,
                    evt.window_title,
                    evt.source,
                    metadata_str,
                    float(evt.duration_seconds),
                    now_str
                ))
                written_count += 1

            conn.commit()

        return written_count

    def insert_clipboard_events(self, events: List[ClipboardEvent]) -> int:
        """
        Inserts clipboard events with deduplication and size limiting.
        Returns the number of events written.
        """
        if not events:
            return 0
        policy = self.get_policy()
        if (
            not policy.enabled
            or not policy.clipboard_enabled
            or not getattr(policy.sensors, "clipboard", True)
            or policy.is_paused
        ):
            return 0

        valid_rows: List[Tuple[Any, ...]] = []
        now = datetime.now(timezone.utc)
        now_str = now.isoformat()

        for evt in events:
            if evt.app_name and self._is_app_excluded(evt.app_name):
                logger.debug(f"Excluding clipboard event from sensitive app: {evt.app_name}")
                continue

            # Privacy filter: suppress raw clipboard content if track_clipboard_content is disabled
            content = evt.content or ""
            if not getattr(policy.privacy, "track_clipboard_content", False):
                content = "[Content Hidden by Privacy Policy]"

            # Length limitation to avoid bloating database with massive binary or large copies
            if len(content) > policy.max_clipboard_length:
                content = content[:policy.max_clipboard_length] + "\n...[truncated by Workstream policy]"

            # Deduplication: compute hash and prevent consecutive duplicate copies within 60s
            content_hash = evt.compute_hash()
            if (
                self._last_clipboard_hash == content_hash
                and self._last_clipboard_time
                and (now - self._last_clipboard_time).total_seconds() < 60
            ):
                continue

            self._last_clipboard_hash = content_hash
            self._last_clipboard_time = now

            event_id = evt.id or str(uuid.uuid4())
            valid_rows.append((
                event_id,
                evt.timestamp,
                evt.app_name,
                content,
                content_hash,
                evt.content_type,
                now_str
            ))

        if not valid_rows:
            return 0

        with _lock, self._get_connection() as conn:
            conn.executemany("""
                INSERT OR IGNORE INTO clipboard_events (
                    event_id, timestamp, app_name, content, content_hash, content_type, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, valid_rows)
            conn.commit()

        return len(valid_rows)

    def save_work_session(self, session: WorkSession) -> WorkSession:
        """Inserts or updates a semantic work session in SQLite and optionally syncs to Chroma LTM."""
        now_str = datetime.now(timezone.utc).isoformat()
        with _lock, self._get_connection() as conn:
            files_str = json.dumps(session.files or [])
            domains_str = json.dumps(session.domains or [])
            commands_str = json.dumps(session.commands or [])
            topics_str = json.dumps(session.topics or [])
            apps_str = json.dumps(session.primary_apps or [])
            meta_str = json.dumps(session.metadata or {})
            und_str = session.understanding.model_dump_json() if getattr(session, "understanding", None) else None

            existing = conn.execute("SELECT id, session_id FROM work_sessions WHERE session_id = ?", (session.session_id,)).fetchone()
            if not existing and session.start_time and session.project:
                existing = conn.execute(
                    "SELECT id, session_id FROM work_sessions WHERE start_time = ? AND project = ?",
                    (session.start_time, session.project)
                ).fetchone()
                if existing:
                    session.session_id = existing["session_id"] if isinstance(existing, sqlite3.Row) else existing[1]

            if existing:
                conn.execute("""
                    UPDATE work_sessions SET
                        start_time = ?,
                        end_time = ?,
                        duration_seconds = ?,
                        title = ?,
                        summary = ?,
                        project = ?,
                        files_json = ?,
                        domains_json = ?,
                        commands_json = ?,
                        topics_json = ?,
                        apps_json = ?,
                        event_count = ?,
                        metadata_json = ?,
                        is_finalized = ?,
                        understanding_json = ?
                    WHERE session_id = ?
                """, (
                    session.start_time,
                    session.end_time,
                    float(session.duration_seconds),
                    session.title,
                    session.summary,
                    session.project,
                    files_str,
                    domains_str,
                    commands_str,
                    topics_str,
                    apps_str,
                    int(session.event_count),
                    meta_str,
                    1 if session.is_finalized else 0,
                    und_str,
                    session.session_id
                ))
                session.id = existing["id"] if isinstance(existing, sqlite3.Row) else existing[0]
            else:
                cursor = conn.execute("""
                    INSERT INTO work_sessions (
                        session_id, start_time, end_time, duration_seconds,
                        title, summary, project, files_json, domains_json,
                        commands_json, topics_json, apps_json, event_count,
                        metadata_json, is_finalized, understanding_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    session.session_id,
                    session.start_time,
                    session.end_time,
                    float(session.duration_seconds),
                    session.title,
                    session.summary,
                    session.project,
                    files_str,
                    domains_str,
                    commands_str,
                    topics_str,
                    apps_str,
                    int(session.event_count),
                    meta_str,
                    1 if session.is_finalized else 0,
                    und_str,
                    now_str
                ))
                session.id = cursor.lastrowid
            session.created_at = now_str
            conn.commit()

        # Sync session summary to Chroma LTM store ONLY when finalized and enabled
        policy = self.get_policy()
        if session.is_finalized and getattr(policy.memory, "ltm", True):
            try:
                from app.memory import memory_store
                store = memory_store.get_store_sync()
                u = getattr(session, "understanding", None)
                if u:
                    content = (
                        f"Task: {u.task}\n"
                        f"Goal: {u.goal}\n"
                        f"Problem: {u.problem or 'None'}\n"
                        f"Progress: {u.progress or 'None'}\n"
                        f"Status: {u.status}\n"
                        f"Technologies: {', '.join(u.technologies)}\n"
                        f"Unresolved Issues: {', '.join(u.unresolved_issues) if u.unresolved_issues else 'None'}\n"
                        f"Project: {session.project or 'General'}\n"
                        f"Files: {', '.join(session.files)}"
                    )
                else:
                    content = f"{session.title}\n{session.summary}\nProject: {session.project or 'General'}\nFiles: {', '.join(session.files)}\nTopics: {', '.join(session.topics)}"

                store.put(
                    namespace=("workstream", "sessions"),
                    key=session.session_id,
                    value={
                        "content": content,
                        "category": "work_session",
                        "task": u.task if u else session.title,
                        "goal": u.goal if u else session.summary,
                        "problem": (u.problem or "") if u else "",
                        "status": u.status if u else "finalized",
                        "project": session.project or "",
                        "start_time": session.start_time,
                        "end_time": session.end_time,
                    }
                )
            except Exception as e:
                logger.debug(f"Optional Chroma LTM sync skipped: {e}")

        return session

    def save_work_sessions(self, sessions: List[WorkSession]) -> int:
        """Batch saves a list of semantic work sessions."""
        saved = 0
        for s in sessions:
            self.save_work_session(s)
            saved += 1
        return saved

    def delete_work_session(self, session_id: str) -> bool:
        """Deletes a work session from SQLite by session_id."""
        with _lock, self._get_connection() as conn:
            cursor = conn.execute("DELETE FROM work_sessions WHERE session_id = ?", (session_id,))
            conn.commit()
            return cursor.rowcount > 0

    def get_work_sessions(
        self,
        timeframe: Optional[str] = "today",
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        project: Optional[str] = None,
        file: Optional[str] = None,
        domain: Optional[str] = None,
        topic: Optional[str] = None,
        query: Optional[str] = None,
        finalized_only: Optional[bool] = None,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Retrieves semantic work sessions matching time, project, file, domain, topic, or search query.
        """
        from app.workstream.search import parse_timeframe, format_duration

        if start_time or end_time:
            start_iso = start_time or "1970-01-01T00:00:00Z"
            end_iso = end_time or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            start_iso, end_iso = parse_timeframe(timeframe)

        sql = """
            SELECT id, session_id, start_time, end_time, duration_seconds,
                   title, summary, project, files_json, domains_json,
                   commands_json, topics_json, apps_json, event_count,
                   metadata_json, is_finalized, understanding_json, created_at
            FROM work_sessions
            WHERE start_time >= ? AND start_time <= ?
        """
        params: List[Any] = [start_iso, end_iso]

        if finalized_only is True:
            sql += " AND is_finalized = 1"
        elif finalized_only is False:
            sql += " AND is_finalized = 0"

        if project:
            sql += " AND project LIKE ?"
            params.append(f"%{project}%")

        if file:
            sql += " AND files_json LIKE ?"
            params.append(f"%{file}%")

        if domain:
            sql += " AND domains_json LIKE ?"
            params.append(f"%{domain}%")

        if topic:
            sql += " AND (topics_json LIKE ? OR title LIKE ? OR summary LIKE ?)"
            params.extend([f"%{topic}%", f"%{topic}%", f"%{topic}%"])

        if query:
            clean_q = query.strip()
            sql += " AND (id IN (SELECT rowid FROM session_fts WHERE session_fts MATCH ?) OR title LIKE ? OR summary LIKE ?)"
            params.extend([f'"{clean_q}"', f"%{clean_q}%", f"%{clean_q}%"])

        sql += " ORDER BY start_time DESC LIMIT ?"
        params.append(limit)

        results = []
        with _lock, self._get_connection() as conn:
            try:
                cursor = conn.execute(sql, params)
            except Exception:
                # Fallback if FTS MATCH failed on special characters
                if query:
                    clean_q = query.strip()
                    fallback_sql = """
                        SELECT id, session_id, start_time, end_time, duration_seconds,
                               title, summary, project, files_json, domains_json,
                               commands_json, topics_json, apps_json, event_count,
                               metadata_json, is_finalized, understanding_json, created_at
                        FROM work_sessions
                        WHERE start_time >= ? AND start_time <= ?
                          AND (title LIKE ? OR summary LIKE ? OR files_json LIKE ? OR topics_json LIKE ?)
                    """
                    f_params: List[Any] = [start_iso, end_iso, f"%{clean_q}%", f"%{clean_q}%", f"%{clean_q}%", f"%{clean_q}%"]
                    if finalized_only is True:
                        fallback_sql += " AND is_finalized = 1"
                    elif finalized_only is False:
                        fallback_sql += " AND is_finalized = 0"
                    fallback_sql += " ORDER BY start_time DESC LIMIT ?"
                    f_params.append(limit)
                    cursor = conn.execute(fallback_sql, f_params)
                else:
                    raise

            for row in cursor.fetchall():
                try:
                    files = json.loads(row["files_json"]) if row["files_json"] else []
                except Exception:
                    files = []
                try:
                    domains = json.loads(row["domains_json"]) if row["domains_json"] else []
                except Exception:
                    domains = []
                try:
                    commands = json.loads(row["commands_json"]) if row["commands_json"] else []
                except Exception:
                    commands = []
                try:
                    topics = json.loads(row["topics_json"]) if row["topics_json"] else []
                except Exception:
                    topics = []
                try:
                    apps = json.loads(row["apps_json"]) if row["apps_json"] else []
                except Exception:
                    apps = []
                try:
                    metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
                except Exception:
                    metadata = {}
                try:
                    und = json.loads(row["understanding_json"]) if ("understanding_json" in row.keys() and row["understanding_json"]) else None
                except Exception:
                    und = None

                dur = float(row["duration_seconds"] or 0.0)
                is_fin = bool(row["is_finalized"]) if "is_finalized" in row.keys() else True
                results.append({
                    "id": row["id"],
                    "session_id": row["session_id"],
                    "start_time": row["start_time"],
                    "end_time": row["end_time"],
                    "duration_seconds": dur,
                    "duration_formatted": format_duration(dur),
                    "title": row["title"],
                    "summary": row["summary"],
                    "project": row["project"],
                    "files": files,
                    "domains": domains,
                    "commands": commands,
                    "topics": topics,
                    "primary_apps": apps,
                    "event_count": row["event_count"],
                    "metadata": metadata,
                    "is_finalized": is_fin,
                    "understanding": und,
                    "created_at": row["created_at"]
                })

        return results

    def get_latest_work_session(
        self,
        project: Optional[str] = None,
        finalized_only: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        Returns the most recent work session for 'continue where I left off' workflows.
        Prioritizes finalized sessions, falling back to active sessions if no finalized session exists.
        """
        from app.workstream.search import format_duration
        with _lock, self._get_connection() as conn:
            row = None
            if finalized_only:
                sql = """
                    SELECT id, session_id, start_time, end_time, duration_seconds,
                           title, summary, project, files_json, domains_json,
                           commands_json, topics_json, apps_json, event_count,
                           metadata_json, is_finalized, understanding_json, created_at
                    FROM work_sessions
                    WHERE is_finalized = 1
                """
                params: List[Any] = []
                if project:
                    sql += " AND project LIKE ?"
                    params.append(f"%{project}%")

                sql += " ORDER BY end_time DESC LIMIT 1"
                row = conn.execute(sql, params).fetchone()

            if not row:
                sql = """
                    SELECT id, session_id, start_time, end_time, duration_seconds,
                           title, summary, project, files_json, domains_json,
                           commands_json, topics_json, apps_json, event_count,
                           metadata_json, is_finalized, understanding_json, created_at
                    FROM work_sessions
                """
                params = []
                if project:
                    sql += " WHERE project LIKE ?"
                    params.append(f"%{project}%")

                sql += " ORDER BY end_time DESC LIMIT 1"
                row = conn.execute(sql, params).fetchone()

            if not row:
                return None

            try:
                files = json.loads(row["files_json"]) if row["files_json"] else []
            except Exception:
                files = []
            try:
                domains = json.loads(row["domains_json"]) if row["domains_json"] else []
            except Exception:
                domains = []
            try:
                commands = json.loads(row["commands_json"]) if row["commands_json"] else []
            except Exception:
                commands = []
            try:
                topics = json.loads(row["topics_json"]) if row["topics_json"] else []
            except Exception:
                topics = []
            try:
                apps = json.loads(row["apps_json"]) if row["apps_json"] else []
            except Exception:
                apps = []
            try:
                metadata = json.loads(row["metadata_json"]) if row["metadata_json"] else {}
            except Exception:
                metadata = {}
            try:
                und = json.loads(row["understanding_json"]) if ("understanding_json" in row.keys() and row["understanding_json"]) else None
            except Exception:
                und = None

            dur = float(row["duration_seconds"] or 0.0)
            is_fin = bool(row["is_finalized"]) if "is_finalized" in row.keys() else True
            return {
                "id": row["id"],
                "session_id": row["session_id"],
                "start_time": row["start_time"],
                "end_time": row["end_time"],
                "duration_seconds": dur,
                "duration_formatted": format_duration(dur),
                "title": row["title"],
                "summary": row["summary"],
                "project": row["project"],
                "files": files,
                "domains": domains,
                "commands": commands,
                "topics": topics,
                "primary_apps": apps,
                "event_count": row["event_count"],
                "metadata": metadata,
                "is_finalized": is_fin,
                "understanding": und,
                "created_at": row["created_at"]
            }

    def get_session_by_id(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Returns details for a single session by session_id."""
        from app.workstream.search import format_duration
        with _lock, self._get_connection() as conn:
            row = conn.execute("""
                SELECT id, session_id, start_time, end_time, duration_seconds,
                       title, summary, project, files_json, domains_json,
                       commands_json, topics_json, apps_json, event_count,
                       metadata_json, is_finalized, understanding_json, created_at
                FROM work_sessions
                WHERE session_id = ?
            """, (session_id,)).fetchone()
            if not row:
                return None

            dur = float(row["duration_seconds"] or 0.0)
            is_fin = bool(row["is_finalized"]) if "is_finalized" in row.keys() else True
            try:
                und = json.loads(row["understanding_json"]) if ("understanding_json" in row.keys() and row["understanding_json"]) else None
            except Exception:
                und = None
            return {
                "id": row["id"],
                "session_id": row["session_id"],
                "start_time": row["start_time"],
                "end_time": row["end_time"],
                "duration_seconds": dur,
                "duration_formatted": format_duration(dur),
                "title": row["title"],
                "summary": row["summary"],
                "project": row["project"],
                "files": json.loads(row["files_json"]) if row["files_json"] else [],
                "domains": json.loads(row["domains_json"]) if row["domains_json"] else [],
                "commands": json.loads(row["commands_json"]) if row["commands_json"] else [],
                "topics": json.loads(row["topics_json"]) if row["topics_json"] else [],
                "primary_apps": json.loads(row["apps_json"]) if row["apps_json"] else [],
                "event_count": row["event_count"],
                "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else {},
                "is_finalized": is_fin,
                "understanding": und,
                "created_at": row["created_at"]
            }

    def prune_expired_events(self, retention_days: Optional[int] = None) -> Dict[str, int]:
        """
        Deletes raw events and sessions older than the retention period (default 60 days).
        Keeps database compact and privacy-compliant.
        """
        policy = self.get_policy()
        days = retention_days if retention_days is not None else policy.retention_days
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")

        with _lock, self._get_connection() as conn:
            cursor_act = conn.execute("DELETE FROM activity_events WHERE timestamp < ?", (cutoff,))
            pruned_activities = cursor_act.rowcount

            cursor_clip = conn.execute("DELETE FROM clipboard_events WHERE timestamp < ?", (cutoff,))
            pruned_clipboards = cursor_clip.rowcount

            cursor_sess = conn.execute("DELETE FROM work_sessions WHERE end_time < ?", (cutoff,))
            pruned_sessions = cursor_sess.rowcount

            conn.commit()

        logger.info(f"Pruned {pruned_activities} activity events, {pruned_clipboards} clipboard events, and {pruned_sessions} sessions older than {days} days.")
        return {
            "pruned_activities": pruned_activities,
            "pruned_clipboards": pruned_clipboards,
            "pruned_sessions": pruned_sessions,
            "cutoff_timestamp": cutoff,
        }

    def get_stats(self) -> Dict[str, Any]:
        """Returns statistics about stored workstream data."""
        with _lock, self._get_connection() as conn:
            act_count = conn.execute("SELECT COUNT(*) FROM activity_events").fetchone()[0]
            clip_count = conn.execute("SELECT COUNT(*) FROM clipboard_events").fetchone()[0]
            sess_count = conn.execute("SELECT COUNT(*) FROM work_sessions").fetchone()[0]

            earliest_row = conn.execute("SELECT MIN(timestamp) FROM activity_events").fetchone()
            earliest = earliest_row[0] if earliest_row and earliest_row[0] else None

            latest_row = conn.execute("SELECT MAX(timestamp) FROM activity_events").fetchone()
            latest = latest_row[0] if latest_row and latest_row[0] else None

        size_bytes = 0
        if self.db_path.exists():
            size_bytes = self.db_path.stat().st_size

        return {
            "db_path": str(self.db_path),
            "size_bytes": size_bytes,
            "size_mb": round(size_bytes / (1024 * 1024), 2),
            "total_activities": act_count,
            "total_clipboards": clip_count,
            "total_sessions": sess_count,
            "earliest_timestamp": earliest,
            "latest_timestamp": latest,
            "is_paused": self.is_paused(),
            "policy": self.get_policy().model_dump()
        }

# Global singleton instance
workstream_store = WorkstreamStore()


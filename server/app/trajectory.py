"""
Trajectory and Event Store module for Rie Agent Runtime.

Records an observable, immutable event ledger of all task executions,
model calls, tool invocations, error decisions, and approval gates.
Enforces strict secret and credential redaction before persistence.
"""
import os
import re
import json
import uuid
import sqlite3
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, List, Dict

_logger = logging.getLogger(__name__)

# --- Sensitive Data Sanitization Patterns ---
REDACTION_PATTERNS = [
    # Bearer and Auth tokens
    (re.compile(r'(?i)(bearer\s+)[a-zA-Z0-9_\-\.]{15,}'), r'\1[REDACTED_TOKEN]'),
    (re.compile(r'(?i)(authorization["\']?\s*:\s*["\'])([^"\']+)'), r'\1[REDACTED_AUTH]'),
    # API Keys (Groq, OpenAI, Google, Anthropic, AWS, Generic)
    (re.compile(r'gsk_[a-zA-Z0-9]{30,}'), '[REDACTED_GROQ_KEY]'),
    (re.compile(r'sk-[a-zA-Z0-9_\-]{20,}'), '[REDACTED_OPENAI_KEY]'),
    (re.compile(r'AIza[0-9A-Za-z-_]{35}'), '[REDACTED_GOOGLE_KEY]'),
    (re.compile(r'AKIA[0-9A-Z]{16}'), '[REDACTED_AWS_KEY]'),
    # Passwords & secrets in key-value pairs
    (re.compile(r'(?i)(["\']?(?:password|passwd|secret|api_key|token|access_token|refresh_token)["\']?\s*[:=]\s*["\'])([^"\']+)'), r'\1[REDACTED_SECRET]'),
    # Wi-Fi / Network Passwords in command output (e.g., Key Content : password)
    (re.compile(r'(?i)(Key Content\s*:\s*)(.+)'), r'\1[REDACTED_WIFI_KEY]'),
    # Private keys
    (re.compile(r'-----BEGIN [A-Z ]+ PRIVATE KEY-----[^-]+-----END [A-Z ]+ PRIVATE KEY-----', re.DOTALL), '[REDACTED_PRIVATE_KEY]'),
]


def sanitize_text(text: str) -> str:
    """Apply deterministic regex sanitization to string text."""
    if not isinstance(text, str):
        return text
    sanitized = text
    for pattern, replacement in REDACTION_PATTERNS:
        sanitized = pattern.sub(replacement, sanitized)
    return sanitized


def sanitize_payload(payload: Any) -> Any:
    """Recursively scrub sensitive keys and token values from payloads."""
    if payload is None:
        return None
    if isinstance(payload, str):
        return sanitize_text(payload)
    elif isinstance(payload, (int, float, bool)):
        return payload
    elif isinstance(payload, bytes):
        return sanitize_text(payload.decode("utf-8", errors="replace"))
    elif isinstance(payload, Exception):
        return sanitize_text(str(payload))
    elif isinstance(payload, (datetime, Path)):
        return str(payload)
    elif isinstance(payload, dict):
        sanitized_dict = {}
        for k, v in payload.items():
            k_lower = str(k).lower()
            if any(secret_kw in k_lower for secret_kw in ("password", "passwd", "secret", "token", "api_key", "auth", "private_key")):
                sanitized_dict[k] = "[REDACTED_SECRET]"
            else:
                sanitized_dict[k] = sanitize_payload(v)
        return sanitized_dict
    elif isinstance(payload, (list, tuple, set)):
        return [sanitize_payload(item) for item in payload]
    elif hasattr(payload, "content"):  # LangChain BaseMessage (ToolMessage, AIMessage, HumanMessage, etc.)
        return sanitize_payload(payload.content)
    elif hasattr(payload, "model_dump") and callable(payload.model_dump):  # Pydantic v2
        return sanitize_payload(payload.model_dump())
    elif hasattr(payload, "dict") and callable(payload.dict):  # Pydantic v1
        return sanitize_payload(payload.dict())
    elif hasattr(payload, "to_dict") and callable(payload.to_dict):
        return sanitize_payload(payload.to_dict())
    elif hasattr(payload, "__dict__"):
        return sanitize_payload(payload.__dict__)
    return sanitize_text(str(payload))


def _json_default(obj: Any) -> Any:
    """Fallback JSON encoder for custom or unhandled objects."""
    if hasattr(obj, "content"):
        return obj.content
    if hasattr(obj, "model_dump") and callable(obj.model_dump):
        return obj.model_dump()
    if hasattr(obj, "dict") and callable(obj.dict):
        return obj.dict()
    if hasattr(obj, "to_dict") and callable(obj.to_dict):
        return obj.to_dict()
    if hasattr(obj, "__dict__"):
        return obj.__dict__
    if isinstance(obj, (datetime, Path)):
        return str(obj)
    if isinstance(obj, bytes):
        return obj.decode("utf-8", errors="replace")
    if isinstance(obj, Exception):
        return str(obj)
    return str(obj)


def safe_json_dumps(data: Any) -> Optional[str]:
    """Serialize payload to JSON string safely without raising TypeError."""
    if data is None:
        return None
    try:
        return json.dumps(data, ensure_ascii=False, default=_json_default)
    except Exception as e:
        _logger.warning("safe_json_dumps fallback on %s: %s", type(data), e)
        try:
            return json.dumps(str(data), ensure_ascii=False)
        except Exception:
            return str(data)


@dataclass
class TaskEvent:
    """Structured event record representing a state transition in task execution."""
    task_id: str
    thread_id: str
    event_type: str  # task.started, model.started, model.completed, tool.started, tool.completed, tool.failed, retry.decided, approval.requested, approval.granted, task.completed, task.budget_exhausted
    step_number: int = 1
    event_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    model: Optional[str] = None
    tool_name: Optional[str] = None
    tool_args: Optional[Dict[str, Any]] = None
    tool_result: Optional[Any] = None
    duration: Optional[float] = None
    status: str = "ok"  # ok, error, running, completed, budget_exhausted, retrying, awaiting_approval, rejected
    error: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "event_id": self.event_id,
            "task_id": self.task_id,
            "thread_id": self.thread_id,
            "step_number": self.step_number,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "model": self.model,
            "tool_name": self.tool_name,
            "tool_args": sanitize_payload(self.tool_args) if self.tool_args is not None else None,
            "tool_result": sanitize_payload(self.tool_result) if self.tool_result is not None else None,
            "duration": self.duration,
            "status": self.status,
            "error": sanitize_text(str(self.error)) if self.error is not None else None,
            "metadata": sanitize_payload(self.metadata) if self.metadata is not None else None,
        }
        return d


class TrajectoryStore:
    """
    Persistent SQLite Event & Trajectory Ledger.
    Records every agent lifecycle transition and allows complete execution replay.
    """
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            from app.database import get_db_path
            db_file = get_db_path().parent / "trajectory_events.db"
            self.db_path = str(db_file)
        else:
            self.db_path = db_path
            
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=15.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS task_events (
                    event_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    step_number INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    model TEXT,
                    tool_name TEXT,
                    tool_args TEXT,
                    tool_result TEXT,
                    duration REAL,
                    status TEXT NOT NULL,
                    error TEXT,
                    metadata TEXT
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_task_events_thread_id ON task_events(thread_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_task_events_timestamp ON task_events(timestamp)")
            conn.commit()

    def record_event(self, event: TaskEvent) -> None:
        """Persist a sanitized task event to the SQLite ledger."""
        data = event.to_dict()
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO task_events (
                    event_id, task_id, thread_id, step_number, event_type,
                    timestamp, model, tool_name, tool_args, tool_result,
                    duration, status, error, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data["event_id"],
                    data["task_id"],
                    data["thread_id"],
                    data["step_number"],
                    data["event_type"],
                    data["timestamp"],
                    data.get("model"),
                    data.get("tool_name"),
                    safe_json_dumps(data.get("tool_args")),
                    safe_json_dumps(data.get("tool_result")),
                    data.get("duration"),
                    data["status"],
                    data.get("error"),
                    safe_json_dumps(data.get("metadata")),
                )
            )
            conn.commit()

    def get_task_trajectory(self, task_id: str) -> List[Dict[str, Any]]:
        """Fetch chronological sequence of events for a specific task."""
        with self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC, step_number ASC",
                (task_id,)
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]

    def get_thread_events(self, thread_id: str) -> List[Dict[str, Any]]:
        """Fetch all events across all tasks on a thread."""
        with self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM task_events WHERE thread_id = ? ORDER BY timestamp ASC",
                (thread_id,)
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]


# Global default instance
trajectory_store = TrajectoryStore()

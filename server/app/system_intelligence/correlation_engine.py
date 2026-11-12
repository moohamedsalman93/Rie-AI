"""
Correlation Engine for Rie System Intelligence.
Stitches task trajectory events, tool calls, user turns, and backend debug logs
to deliver holistic root-cause diagnostics and self-healing recommendations.
"""
import re
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any

from app.trajectory import TrajectoryStore, sanitize_text
from app.system_intelligence.models import CorrelatedDiagnostic
from app.system_intelligence.log_diagnostics import log_diagnostics_engine

logger = logging.getLogger(__name__)


class CorrelationEngine:
    """Correlates trajectory event ledger entries with raw backend logs"""

    def __init__(self, trajectory_store: Optional[TrajectoryStore] = None):
        self._trajectory_store = trajectory_store or TrajectoryStore()

    def get_recent_task_events(self, thread_id: Optional[str] = None, limit: int = 20) -> List[Dict[str, Any]]:
        """Retrieve recent trajectory events from the database"""
        try:
            if thread_id:
                events = self._trajectory_store.get_thread_events(thread_id)
                return events[-limit:]
            else:
                # Query recent events directly from trajectory table
                conn = self._trajectory_store._get_connection()
                conn.row_factory = None
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT event_id, task_id, thread_id, event_type, status, error_category, error_message, timestamp, payload
                    FROM task_events
                    ORDER BY timestamp DESC
                    LIMIT ?
                    """,
                    (limit,)
                )
                rows = cursor.fetchall()
                conn.close()
                results = []
                for r in rows:
                    results.append({
                        "event_id": r[0],
                        "task_id": r[1],
                        "thread_id": r[2],
                        "event_type": r[3],
                        "status": r[4],
                        "error_category": r[5],
                        "error_message": r[6],
                        "timestamp": r[7],
                    })
                return results
        except Exception as exc:
            logger.warning("Failed to retrieve trajectory events: %s", exc)
            return []

    def correlate_turn_diagnostics(
        self,
        thread_id: Optional[str] = None,
        tool_name: Optional[str] = None,
        window_seconds: int = 10,
    ) -> List[CorrelatedDiagnostic]:
        """
        Cross-reference trajectory events with log lines around the same timestamp (+/- window_seconds).
        """
        events = self.get_recent_task_events(thread_id=thread_id, limit=30)
        diagnostics: List[CorrelatedDiagnostic] = []

        # Find events with errors or failed status
        failing_events = [
            e for e in events
            if e.get("status") in ("failed", "error") or e.get("error_message") or e.get("error_category")
        ]

        # If a specific tool was requested, filter for it
        if tool_name:
            failing_events = [e for e in failing_events if tool_name.lower() in str(e).lower()]

        for ev in failing_events:
            ev_ts_str = ev.get("timestamp")
            ev_error = ev.get("error_message") or "Unknown execution failure"
            ev_cat = ev.get("error_category") or "EXECUTION_ERROR"
            ev_tool = ev.get("payload", {}).get("tool_name") if isinstance(ev.get("payload"), dict) else None

            # Search logs in the surrounding time window
            matched_logs = []
            if ev_ts_str:
                try:
                    # Clean ISO format to YYYY-MM-DD HH:MM:SS
                    clean_ts = ev_ts_str.replace("T", " ").split(".")[0].split("+")[0]
                    log_result = log_diagnostics_engine.read_logs(lines=60, level="ALL", search_query=ev_tool or ev_cat)
                    if log_result.get("status") == "success":
                        content = log_result.get("content", "")
                        for line in content.splitlines():
                            if ev_cat.lower() in line.lower() or (ev_tool and ev_tool.lower() in line.lower()):
                                matched_logs.append(line)
                except Exception:
                    pass

            # Formulate root-cause and actionable recommendation
            root_cause, rec_action, can_heal = self._analyze_cause_and_remedy(ev_cat, ev_error, ev_tool)

            diagnostics.append(
                CorrelatedDiagnostic(
                    turn_id=ev.get("thread_id"),
                    tool_call_id=ev.get("event_id"),
                    tool_name=ev_tool,
                    error_category=ev_cat,
                    timestamp=ev_ts_str or datetime.now(timezone.utc).isoformat(),
                    matched_logs=matched_logs[:10],
                    root_cause=root_cause,
                    recommended_action=rec_action,
                    can_auto_heal=can_heal,
                )
            )

        return diagnostics

    def _analyze_cause_and_remedy(
        self,
        error_category: str,
        error_message: str,
        tool_name: Optional[str] = None,
    ) -> tuple[str, str, bool]:
        """Categorize failure and determine if Rie can self-heal autonomously"""
        cat_upper = str(error_category).upper()
        msg_lower = str(error_message).lower()

        # Quota / Rate Limit
        if "429" in msg_lower or "quota" in msg_lower or "rate limit" in msg_lower:
            if tool_name == "internet_search" or "tavily" in msg_lower:
                return (
                    "Search provider hit rate limit / quota exhaustion.",
                    "Switch WEB_SEARCH_PROVIDER to 'duckduckgo' using modify_system_setting.",
                    True,
                )
            return (
                "LLM provider rate limit exceeded.",
                "Trigger fallback LLM provider or switch to another configured provider.",
                False,
            )

        # Timeout
        if "timeout" in msg_lower or "timed out" in msg_lower:
            if tool_name and "browser" in tool_name:
                return (
                    "Browser automation action timed out waiting for DOM element.",
                    "Switch CAMOFOX_HEADLESS_MODE to 'normal' or inspect desktop state using get_desktop_state.",
                    True,
                )
            return (
                f"Tool '{tool_name}' timed out during execution.",
                "Verify host connectivity and try reducing batch size or query complexity.",
                False,
            )

        # Missing credential / Auth
        if "401" in msg_lower or "403" in msg_lower or "auth" in msg_lower or "unauthorized" in msg_lower:
            return (
                f"Authentication failed for {tool_name or 'service'}.",
                "Check and update API keys or re-authenticate integration in Settings.",
                False,
            )

        # Connection Refused
        if "connection refused" in msg_lower or "11434" in msg_lower:
            return (
                "Local service daemon (such as Ollama on port 11434) is offline or unreachable.",
                "Start Ollama service on host OS, or switch primary provider to a cloud API.",
                False,
            )

        # Generic Execution Error
        return (
            f"Execution error in {tool_name or 'runtime'}: {error_message}",
            "Check recent backend logs with read_system_logs for complete stack trace.",
            False,
        )


# Global instance
correlation_engine = CorrelationEngine()


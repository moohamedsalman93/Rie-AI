"""
Browser Subsystem Telemetry & Benchmark Tracer for Rie.
Tracks tool calls, snapshot token overhead, latency, error frequencies, and session environment metadata.
"""
import sys
import time
import logging
from datetime import datetime, timezone
from typing import Dict, List, Any, Optional
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SessionEnvironmentTrace(BaseModel):
    """Traceable environment record for a browser session."""
    session_id: str
    provider: str = "camofox"
    profile: Optional[str] = None
    camoufox_version: Optional[str] = None
    playwright_version: Optional[str] = None
    platform: str = Field(default_factory=lambda: sys.platform)
    python_version: str = Field(default_factory=lambda: f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")
    started_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    ended_at: Optional[str] = None
    reason_closed: Optional[str] = None


class TaskTrace(BaseModel):
    """Telemetry trace for a multi-step agent browser task."""
    task_id: str
    description: str
    start_time: float = Field(default_factory=time.time)
    end_time: Optional[float] = None
    success: bool = False
    total_tool_calls: int = 0
    total_snapshots: int = 0
    snapshot_characters: int = 0
    estimated_snapshot_tokens: int = 0
    stale_target_errors: int = 0
    target_not_found_errors: int = 0
    navigation_timeout_errors: int = 0
    session_lost_errors: int = 0
    duration_seconds: float = 0.0


class BrowserTelemetryTracer:
    """Collects and aggregates performance metrics, benchmark traces, and environment telemetry for browser sessions."""

    def __init__(self):
        self.active_traces: Dict[str, TaskTrace] = {}
        self.completed_traces: List[TaskTrace] = []
        self.session_environment_traces: Dict[str, SessionEnvironmentTrace] = {}

    def record_session_start(self, session_id: str, profile: Optional[str] = None, provider: str = "camofox") -> SessionEnvironmentTrace:
        """Record environment telemetry when a browser session starts."""
        cam_ver = None
        pw_ver = None
        try:
            from camoufox.__version__ import __version__ as cam_ver
        except Exception:
            cam_ver = "installed"
        try:
            import playwright
            pw_ver = getattr(playwright, "__version__", "installed")
        except Exception:
            pw_ver = "installed"

        env_trace = SessionEnvironmentTrace(
            session_id=session_id,
            provider=provider,
            profile=profile,
            camoufox_version=cam_ver,
            playwright_version=pw_ver,
        )
        self.session_environment_traces[session_id] = env_trace
        logger.info(
            f"[Telemetry] Browser Session Started: {session_id} "
            f"(provider={provider}, profile={profile}, python={env_trace.python_version}, "
            f"camoufox={cam_ver}, playwright={pw_ver})"
        )
        return env_trace

    def record_session_close(self, session_id: str, reason: str = "user_closed") -> Optional[SessionEnvironmentTrace]:
        """Record session teardown timestamp and reason."""
        env_trace = self.session_environment_traces.get(session_id)
        if env_trace:
            env_trace.ended_at = datetime.now(timezone.utc).isoformat()
            env_trace.reason_closed = reason
            logger.info(f"[Telemetry] Browser Session Closed: {session_id} (reason={reason})")
        return env_trace

    def start_task(self, task_id: str, description: str) -> TaskTrace:
        """Start tracking a new browser agent task."""
        trace = TaskTrace(task_id=task_id, description=description, start_time=time.time())
        self.active_traces[task_id] = trace
        return trace

    def record_tool_call(self, task_id: str, tool_name: str, snapshot_len: int = 0) -> None:
        """Record an executed browser tool call."""
        trace = self.active_traces.get(task_id)
        if trace:
            trace.total_tool_calls += 1
            if tool_name == "browser_snapshot":
                trace.total_snapshots += 1
                trace.snapshot_characters += snapshot_len
                # Approximate 4 characters per LLM token
                trace.estimated_snapshot_tokens += snapshot_len // 4

    def record_error(self, task_id: str, error_type: str) -> None:
        """Record error occurrences for diagnostic metrics."""
        trace = self.active_traces.get(task_id)
        if trace:
            if error_type == "StaleTargetError":
                trace.stale_target_errors += 1
            elif error_type == "TargetNotFoundError":
                trace.target_not_found_errors += 1
            elif error_type == "NavigationTimeoutError":
                trace.navigation_timeout_errors += 1
            elif error_type == "SessionLostError":
                trace.session_lost_errors += 1

    def complete_task(self, task_id: str, success: bool = True) -> Optional[TaskTrace]:
        """Finalize task trace and calculate summary metrics."""
        trace = self.active_traces.pop(task_id, None)
        if trace:
            trace.end_time = time.time()
            trace.duration_seconds = round(trace.end_time - trace.start_time, 2)
            trace.success = success
            self.completed_traces.append(trace)
            logger.info(
                f"[Telemetry] Task '{task_id}' finished (success={success}): "
                f"{trace.total_tool_calls} tool calls, {trace.total_snapshots} snapshots "
                f"(~{trace.estimated_snapshot_tokens} tokens), duration={trace.duration_seconds}s"
            )
        return trace

    def get_aggregate_metrics(self) -> Dict[str, Any]:
        """Compute aggregate performance benchmarks across all completed task traces."""
        if not self.completed_traces:
            return {
                "total_tasks": 0,
                "success_rate": 0.0,
                "avg_tool_calls": 0.0,
                "avg_snapshots": 0.0,
                "avg_snapshot_tokens": 0,
                "avg_duration_seconds": 0.0,
            }

        total = len(self.completed_traces)
        successful = sum(1 for t in self.completed_traces if t.success)
        avg_calls = sum(t.total_tool_calls for t in self.completed_traces) / total
        avg_snaps = sum(t.total_snapshots for t in self.completed_traces) / total
        avg_tokens = sum(t.estimated_snapshot_tokens for t in self.completed_traces) // total
        avg_duration = sum(t.duration_seconds for t in self.completed_traces) / total

        return {
            "total_tasks": total,
            "success_rate": round(successful / total, 2),
            "avg_tool_calls": round(avg_calls, 1),
            "avg_snapshots": round(avg_snaps, 1),
            "avg_snapshot_tokens": avg_tokens,
            "avg_duration_seconds": round(avg_duration, 2),
            "total_stale_errors": sum(t.stale_target_errors for t in self.completed_traces),
            "total_session_lost_errors": sum(t.session_lost_errors for t in self.completed_traces),
        }


# Global telemetry tracer singleton
telemetry_tracer = BrowserTelemetryTracer()

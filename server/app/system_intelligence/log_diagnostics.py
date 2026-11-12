"""
Log Diagnostics Engine for Rie System Intelligence.
Features bounded reverse-reading, secret redaction, severity filtering, and timestamp-aware error aggregation.
"""
import os
import re
import logging
from collections import deque
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple

from app.config import settings
from app.trajectory import sanitize_text
from app.system_intelligence.models import LogDiagnosticSummary

logger = logging.getLogger(__name__)

# Standard Python logging timestamp regex: e.g. 2026-11-12 13:14:02,123 or 2026-11-12 13:14:02
LOG_LINE_REGEX = re.compile(
    r'^(?P<timestamp>\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:,\d+)?)\s*-\s*(?P<logger>[^\s-]+)\s*-\s*(?P<level>[A-Z]+)\s*-\s*(?P<message>.*)$'
)

LEVEL_HIERARCHY = {
    "DEBUG": 10,
    "INFO": 20,
    "WARNING": 30,
    "ERROR": 40,
    "CRITICAL": 50,
}


class LogDiagnosticsEngine:
    """Bounded, token-safe log introspection engine"""

    def __init__(self, log_path: Optional[Path] = None):
        self._log_path = log_path

    @property
    def log_path(self) -> Path:
        return self._log_path or settings.LOG_FILE

    def read_logs(
        self,
        lines: int = 80,
        level: str = "ALL",
        search_query: Optional[str] = None,
        tail: bool = True,
    ) -> Dict[str, Any]:
        """
        Bounded reader for backend debug logs.
        Applies secret redaction, level filtering, and search query.
        """
        file_path = self.log_path
        if not file_path.exists():
            return {
                "status": "not_found",
                "log_file": str(file_path),
                "lines_returned": 0,
                "content": f"Log file '{file_path}' does not exist yet.",
            }

        max_lines = max(5, min(lines, 300))  # Bounds: 5 to 300 lines
        target_level = level.upper().strip()
        min_level_num = LEVEL_HIERARCHY.get(target_level, 0) if target_level != "ALL" else 0

        query_regex = None
        if search_query and search_query.strip():
            try:
                query_regex = re.compile(search_query.strip(), re.IGNORECASE)
            except re.error:
                query_regex = None

        matched_lines: deque = deque(maxlen=max_lines) if tail else deque()
        total_scanned = 0

        try:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                # Read line by line with memory bounding
                for raw_line in f:
                    total_scanned += 1
                    line = raw_line.rstrip("\r\n")
                    if not line:
                        continue

                    # Parse log line metadata if available
                    m = LOG_LINE_REGEX.match(line)
                    if m:
                        line_level = m.group("level").upper()
                        if min_level_num > 0 and LEVEL_HIERARCHY.get(line_level, 0) < min_level_num:
                            continue

                    # Search query filter
                    if query_regex:
                        if not query_regex.search(line):
                            continue
                    elif search_query and search_query.strip():
                        if search_query.lower() not in line.lower():
                            continue

                    # Apply deterministic secret/token sanitization
                    sanitized_line = sanitize_text(line)

                    if tail:
                        matched_lines.append(sanitized_line)
                    else:
                        matched_lines.append(sanitized_line)
                        if len(matched_lines) >= max_lines:
                            break

            result_lines = list(matched_lines)

            # Enforce max character limit (15,000 characters)
            joined_content = "\n".join(result_lines)
            truncated = False
            if len(joined_content) > 15000:
                joined_content = joined_content[-15000:]
                truncated = True

            return {
                "status": "success",
                "log_file": str(file_path),
                "total_scanned": total_scanned,
                "lines_returned": len(result_lines),
                "truncated": truncated,
                "content": joined_content,
            }

        except Exception as exc:
            logger.error("Error reading backend log file %s: %s", file_path, exc)
            return {
                "status": "error",
                "log_file": str(file_path),
                "content": f"Failed to read log file: {exc}",
            }

    def diagnose_errors(self, window_minutes: int = 15) -> LogDiagnosticSummary:
        """
        Timestamp-aware error aggregation.
        Scans recent logs within the last N minutes and aggregates errors and failing components.
        """
        file_path = self.log_path
        if not file_path.exists():
            return LogDiagnosticSummary(
                log_file_path=str(file_path),
                total_lines_scanned=0,
                error_count=0,
                warning_count=0,
                time_window_minutes=window_minutes,
                top_failing_components={},
                recent_errors=["Log file does not exist."],
            )

        cutoff_time = datetime.now() - timedelta(minutes=window_minutes)
        total_scanned = 0
        error_count = 0
        warning_count = 0
        component_counts: Dict[str, int] = {}
        recent_errors: deque = deque(maxlen=20)

        try:
            # We scan the last 1500 lines
            last_lines = deque(maxlen=1500)
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    total_scanned += 1
                    last_lines.append(line)

            for raw_line in last_lines:
                line = raw_line.rstrip("\r\n")
                m = LOG_LINE_REGEX.match(line)
                if not m:
                    continue

                ts_str = m.group("timestamp")
                logger_name = m.group("logger")
                level = m.group("level").upper()
                msg = m.group("message")

                # Parse timestamp
                try:
                    # Normalize timestamp format (e.g. 2026-11-12 13:14:02)
                    clean_ts = ts_str.split(",")[0]
                    log_dt = datetime.strptime(clean_ts, "%Y-%m-%d %H:%M:%S")
                    if log_dt < cutoff_time:
                        continue
                except Exception:
                    pass

                if level in ("ERROR", "CRITICAL"):
                    error_count += 1
                    component_counts[logger_name] = component_counts.get(logger_name, 0) + 1
                    recent_errors.append(sanitize_text(f"[{ts_str}] [{logger_name}] {msg}"))
                elif level == "WARNING":
                    warning_count += 1

            return LogDiagnosticSummary(
                log_file_path=str(file_path),
                total_lines_scanned=total_scanned,
                error_count=error_count,
                warning_count=warning_count,
                time_window_minutes=window_minutes,
                top_failing_components=component_counts,
                recent_errors=list(recent_errors),
            )

        except Exception as exc:
            logger.error("Error diagnosing system errors from %s: %s", file_path, exc)
            return LogDiagnosticSummary(
                log_file_path=str(file_path),
                total_lines_scanned=total_scanned,
                error_count=error_count,
                warning_count=warning_count,
                time_window_minutes=window_minutes,
                top_failing_components={},
                recent_errors=[f"Diagnostic error: {exc}"],
            )


# Global instance
log_diagnostics_engine = LogDiagnosticsEngine()


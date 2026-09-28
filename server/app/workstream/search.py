"""
Search, aggregation, and timeline retrieval for the Rie-AI Workstream Engine.
Supports temporal range queries, application breakdown, and FTS5 keyword search.
"""
from datetime import datetime, timezone, timedelta
import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from app.workstream.store import workstream_store, WorkstreamStore

logger = logging.getLogger("workstream.search")


import re

def parse_timeframe(timeframe: Optional[str] = None) -> Tuple[str, str]:
    """
    Parses natural language timeframe keywords into ISO-8601 UTC start and end bounds.
    Supported: 'today', 'yesterday', 'this_morning', 'this_afternoon', 'last_hour',
               'last_2_hours', 'last_24_hours', 'last_7_days', 'last 10 minutes', 'all', or 'YYYY-MM-DD'.
    All returned bounds are formatted in UTC ISO-8601 ending with 'Z' for consistent SQLite collation.
    """
    local_now = datetime.now().astimezone()
    tf = (timeframe or "today").strip().lower()

    def _to_utc_z(dt: datetime) -> str:
        utc_dt = dt.astimezone(timezone.utc)
        return utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Check for relative minutes: e.g. "last 10 minutes", "10m", "15 minutes"
    m_min = re.search(r"(\d+)\s*(?:m|min|minute|minutes)\b", tf)
    if m_min:
        mins = int(m_min.group(1))
        start = local_now - timedelta(minutes=mins)
        end = local_now + timedelta(minutes=5)
        return _to_utc_z(start), _to_utc_z(end)

    # Check for relative hours: e.g. "last 3 hours", "2h", "4 hours"
    m_hr = re.search(r"(\d+)\s*(?:h|hr|hour|hours)\b", tf)
    if m_hr and tf != "today" and tf != "yesterday":
        hrs = int(m_hr.group(1))
        start = local_now - timedelta(hours=hrs)
        end = local_now + timedelta(minutes=5)
        return _to_utc_z(start), _to_utc_z(end)

    if tf == "today":
        start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = local_now.replace(hour=23, minute=59, second=59, microsecond=999999)
    elif tf == "yesterday":
        yesterday = local_now - timedelta(days=1)
        start = yesterday.replace(hour=0, minute=0, second=0, microsecond=0)
        end = yesterday.replace(hour=23, minute=59, second=59, microsecond=999999)
    elif tf in ("this_morning", "morning"):
        start = local_now.replace(hour=6, minute=0, second=0, microsecond=0)
        end = local_now.replace(hour=12, minute=0, second=0, microsecond=0)
    elif tf in ("this_afternoon", "afternoon"):
        start = local_now.replace(hour=12, minute=0, second=0, microsecond=0)
        end = local_now.replace(hour=18, minute=0, second=0, microsecond=0)
    elif tf in ("last_24_hours", "24h"):
        start = local_now - timedelta(hours=24)
        end = local_now + timedelta(minutes=5)
    elif tf in ("last_7_days", "7d", "week"):
        start = local_now - timedelta(days=7)
        end = local_now + timedelta(minutes=5)
    elif tf in ("all", "any", "ever", "*"):
        start = datetime(1970, 1, 1, tzinfo=timezone.utc)
        end = datetime(2099, 1, 1, tzinfo=timezone.utc)
    else:
        # Check if it's a specific date: YYYY-MM-DD
        try:
            parsed_date = datetime.strptime(tf, "%Y-%m-%d").replace(tzinfo=local_now.tzinfo)
            start = parsed_date.replace(hour=0, minute=0, second=0, microsecond=0)
            end = parsed_date.replace(hour=23, minute=59, second=59, microsecond=999999)
        except ValueError:
            # Fallback to today
            start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
            end = local_now.replace(hour=23, minute=59, second=59, microsecond=999999)

    return _to_utc_z(start), _to_utc_z(end)


def format_duration(seconds: float) -> str:
    """Formats seconds into human readable duration (e.g. 1h 45m)."""
    secs = int(max(0, seconds))
    hours = secs // 3600
    minutes = (secs % 3600) // 60
    if hours > 0:
        return f"{hours}h {minutes}m"
    if minutes > 0:
        return f"{minutes}m"
    return f"{secs}s"


class WorkstreamSearch:
    """Search and analytics queries over workstream data."""

    def __init__(self, store: Optional[WorkstreamStore] = None):
        self.store = store or workstream_store

    def get_timeline(
        self,
        start_time: str,
        end_time: str,
        app_name: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Retrieves a chronological list of activity events within a time range.
        """
        query = """
            SELECT id, event_id, timestamp, event_type, app_name, process_name,
                   window_title, source, metadata_json, duration_seconds
            FROM activity_events
            WHERE timestamp >= ? AND timestamp <= ?
        """
        params: List[Any] = [start_time, end_time]

        if app_name:
            clean_app = app_name.strip().lower()
            if clean_app in ("terminal", "shell", "console", "cmd", "bash", "cli"):
                query += " AND (event_type = 'terminal_command' OR source = 'terminal' OR app_name LIKE ? OR process_name LIKE ?)"
                params.extend([f"%{app_name}%", f"%{app_name}%"])
            else:
                query += " AND (app_name LIKE ? OR process_name LIKE ?)"
                params.extend([f"%{app_name}%", f"%{app_name}%"])

        query += " ORDER BY timestamp ASC LIMIT ?"
        params.append(limit)

        results = []
        with self.store._get_connection() as conn:
            cursor = conn.execute(query, params)
            for row in cursor.fetchall():
                metadata = {}
                if row["metadata_json"]:
                    try:
                        metadata = json.loads(row["metadata_json"])
                    except Exception:
                        pass
                item = {
                    "id": row["id"],
                    "timestamp": row["timestamp"],
                    "event_type": row["event_type"],
                    "app_name": row["app_name"],
                    "process_name": row["process_name"],
                    "window_title": row["window_title"],
                    "source": row["source"],
                    "duration_seconds": row["duration_seconds"],
                    "duration_formatted": format_duration(row["duration_seconds"]),
                    "metadata": metadata
                }
                if metadata.get("command"):
                    item["command"] = metadata["command"]
                if metadata.get("shell"):
                    item["shell"] = metadata["shell"]
                if metadata.get("cwd"):
                    item["cwd"] = metadata["cwd"]
                if metadata.get("exit_code") is not None:
                    item["exit_code"] = metadata["exit_code"]
                    item["success"] = metadata.get("success", metadata["exit_code"] == 0)
                if metadata.get("duration") is not None:
                    item["duration"] = metadata["duration"]
                results.append(item)
        return results

    def get_work_summary(self, start_time: str, end_time: str) -> Dict[str, Any]:
        """
        Aggregates activity within a time range:
        - Total active time
        - App duration breakdown
        - Key files / window titles
        - Clipboard activity summary
        """
        with self.store._get_connection() as conn:
            # 1. Total duration and app breakdown
            app_cursor = conn.execute("""
                SELECT app_name, SUM(duration_seconds) as total_dur, COUNT(*) as event_count
                FROM activity_events
                WHERE timestamp >= ? AND timestamp <= ?
                GROUP BY app_name
                ORDER BY total_dur DESC
            """, (start_time, end_time))

            apps_summary = []
            total_active_seconds = 0.0

            for row in app_cursor.fetchall():
                dur = float(row["total_dur"] or 0.0)
                total_active_seconds += dur
                apps_summary.append({
                    "app_name": row["app_name"],
                    "duration_seconds": dur,
                    "duration_formatted": format_duration(dur),
                    "event_count": row["event_count"]
                })

            # Calculate percentages
            if total_active_seconds > 0:
                for app in apps_summary:
                    app["percentage"] = round((app["duration_seconds"] / total_active_seconds) * 100, 1)

            # 2. Top window titles (most time spent)
            title_cursor = conn.execute("""
                SELECT app_name, window_title, SUM(duration_seconds) as total_dur, COUNT(*) as switches
                FROM activity_events
                WHERE timestamp >= ? AND timestamp <= ? AND window_title IS NOT NULL AND window_title != ''
                GROUP BY app_name, window_title
                ORDER BY total_dur DESC
                LIMIT 15
            """, (start_time, end_time))

            top_windows = []
            for row in title_cursor.fetchall():
                dur = float(row["total_dur"] or 0.0)
                top_windows.append({
                    "app_name": row["app_name"],
                    "window_title": row["window_title"],
                    "duration_seconds": dur,
                    "duration_formatted": format_duration(dur),
                    "switches": row["switches"]
                })

            # 3. Clipboard events in timeframe
            clip_cursor = conn.execute("""
                SELECT app_name, content, content_type, timestamp
                FROM clipboard_events
                WHERE timestamp >= ? AND timestamp <= ?
                ORDER BY timestamp DESC
                LIMIT 10
            """, (start_time, end_time))

            recent_clips = []
            for row in clip_cursor.fetchall():
                content_preview = row["content"]
                if len(content_preview) > 150:
                    content_preview = content_preview[:150] + "..."
                recent_clips.append({
                    "timestamp": row["timestamp"],
                    "app_name": row["app_name"],
                    "content_preview": content_preview,
                    "content_type": row["content_type"]
                })

            # 4. Terminal commands executed in timeframe
            term_cursor = conn.execute("""
                SELECT timestamp, app_name, window_title, metadata_json, duration_seconds
                FROM activity_events
                WHERE timestamp >= ? AND timestamp <= ? AND event_type = 'terminal_command'
                ORDER BY timestamp DESC
                LIMIT 50
            """, (start_time, end_time))

            recent_terms = []
            running_terms = []
            distinct_cwds = set()
            shells_used = set()
            failed_commands_count = 0
            interrupted_commands_count = 0
            last_test_command = None
            last_interrupted_command = None

            for row in term_cursor.fetchall():
                meta = {}
                if row["metadata_json"]:
                    try:
                        meta = json.loads(row["metadata_json"])
                    except Exception:
                        pass

                cmd = meta.get("command") or row["window_title"]
                shell = meta.get("shell") or row["app_name"]
                cwd = meta.get("cwd")
                ec = meta.get("exit_code")
                
                # Determine normalized status
                st = (meta.get("status") or "").lower()
                if not st:
                    if ec is None:
                        st = "running"
                    elif ec in (130, -1073741510, 3221225786):
                        st = "interrupted"
                    elif ec == 0:
                        st = "completed"
                    else:
                        st = "failed"
                elif st in ("sigint", "cancelled", "canceled", "ctrl+c"):
                    st = "interrupted"

                is_running = (st == "running")
                is_interrupted = (st == "interrupted")
                success = meta.get("success", (st == "completed" or (not is_running and ec == 0)))
                dur = meta.get("duration", row["duration_seconds"])

                if is_running:
                    try:
                        t_str = row["timestamp"].replace("Z", "+00:00")
                        start_dt = datetime.fromisoformat(t_str)
                        elapsed = max(0.0, (datetime.now(timezone.utc) - start_dt).total_seconds())
                        dur = round(elapsed, 1)
                    except Exception:
                        dur = float(dur or 0.0)

                if is_interrupted:
                    summary_label = f"{cmd} — interrupted after {format_duration(dur)}"
                    interrupted_commands_count += 1
                elif is_running:
                    summary_label = f"{cmd} — running for {format_duration(dur)}"
                elif success:
                    summary_label = f"{cmd} — completed in {format_duration(dur)}"
                else:
                    summary_label = f"{cmd} — failed (exit code {ec}) after {format_duration(dur)}"

                if not success and not is_running and not is_interrupted:
                    failed_commands_count += 1
                if cwd:
                    distinct_cwds.add(cwd)
                if shell:
                    shells_used.add(shell)

                term_item = {
                    "timestamp": row["timestamp"],
                    "shell": shell,
                    "command": cmd,
                    "cwd": cwd,
                    "status": st,
                    "running": is_running,
                    "interrupted": is_interrupted,
                    "exit_code": ec,
                    "success": success,
                    "duration_seconds": dur,
                    "duration_formatted": format_duration(dur),
                    "summary_label": summary_label
                }

                if is_running:
                    running_terms.append(term_item)
                if is_interrupted and not last_interrupted_command:
                    last_interrupted_command = term_item

                if not last_test_command and cmd:
                    lower_cmd = cmd.lower()
                    if any(t in lower_cmd for t in ("test", "pytest", "unittest", "cargo test", "npm test", "vitest", "jest")):
                        last_test_command = {
                            "command": cmd,
                            "shell": shell,
                            "cwd": cwd,
                            "status": st,
                            "exit_code": ec,
                            "success": success,
                            "timestamp": row["timestamp"],
                            "summary_label": summary_label
                        }

                recent_terms.append(term_item)

        return {
            "timeframe": {
                "start": start_time,
                "end": end_time
            },
            "total_active_seconds": total_active_seconds,
            "total_active_formatted": format_duration(total_active_seconds),
            "applications": apps_summary,
            "top_tasks_and_windows": top_windows,
            "clipboard_activity": {
                "count": len(recent_clips),
                "recent_samples": recent_clips
            },
            "terminal_activity": {
                "count": len(recent_terms),
                "failed_count": failed_commands_count,
                "interrupted_count": interrupted_commands_count,
                "running_count": len(running_terms),
                "running_commands": running_terms,
                "last_command": recent_terms[0] if recent_terms else None,
                "last_interrupted_command": last_interrupted_command,
                "last_test_run": last_test_command,
                "distinct_directories": sorted(list(distinct_cwds)),
                "shells_used": sorted(list(shells_used)),
                "recent_commands": recent_terms[:20]
            }
        }

    def get_terminal_history(
        self,
        timeframe: Optional[str] = "today",
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        query: Optional[str] = None,
        cwd: Optional[str] = None,
        shell: Optional[str] = None,
        status: Optional[str] = None,
        running_only: bool = False,
        interrupted_only: bool = False,
        failed_only: bool = False,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Retrieves executed terminal commands filtered by timeframe, query keyword, directory, status, or exit code.
        Supports tracking running processes and interrupted (Ctrl+C) commands.
        """
        if start_time or end_time:
            start_iso = start_time or "1970-01-01T00:00:00Z"
            end_iso = end_time or datetime.now(timezone.utc).isoformat()
        else:
            start_iso, end_iso = parse_timeframe(timeframe)

        sql = """
            SELECT id, timestamp, app_name, window_title, metadata_json, duration_seconds
            FROM activity_events
            WHERE timestamp >= ? AND timestamp <= ? AND event_type = 'terminal_command'
        """
        params: List[Any] = [start_iso, end_iso]

        if query:
            sql += " AND (window_title LIKE ? OR metadata_json LIKE ?)"
            params.extend([f"%{query}%", f"%{query}%"])

        if cwd:
            sql += " AND metadata_json LIKE ?"
            params.append(f"%{cwd}%")

        if shell:
            sql += " AND (app_name LIKE ? OR metadata_json LIKE ?)"
            params.extend([f"%{shell}%", f"%{shell}%"])

        is_failed = failed_only is True or str(failed_only).strip().lower() in ("true", "1", "yes")
        is_running_only = running_only is True or str(running_only).strip().lower() in ("true", "1", "yes")
        is_interrupted_only = interrupted_only is True or str(interrupted_only).strip().lower() in ("true", "1", "yes")
        target_status = status.strip().lower() if status else None

        if is_running_only:
            sql += " AND (metadata_json LIKE '%\"status\": \"running\"%' OR window_title LIKE '%(running%')"
        elif is_interrupted_only:
            sql += " AND (metadata_json LIKE '%\"status\": \"interrupted\"%' OR window_title LIKE '%(interrupted%)')"
        elif target_status:
            sql += " AND metadata_json LIKE ?"
            params.append(f'%"{target_status}"%')

        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit * 3 if is_failed else limit)

        results = []
        with self.store._get_connection() as conn:
            cursor = conn.execute(sql, params)
            for row in cursor.fetchall():
                meta = {}
                if row["metadata_json"]:
                    try:
                        meta = json.loads(row["metadata_json"])
                    except Exception:
                        pass
                cmd = meta.get("command") or row["window_title"]
                sh = meta.get("shell") or row["app_name"]
                dir_path = meta.get("cwd")
                ec = meta.get("exit_code")

                # Normalize status
                st = (meta.get("status") or "").lower()
                if not st:
                    if ec is None:
                        st = "running"
                    elif ec in (130, -1073741510, 3221225786):
                        st = "interrupted"
                    elif ec == 0:
                        st = "completed"
                    else:
                        st = "failed"
                elif st in ("sigint", "cancelled", "canceled", "ctrl+c"):
                    st = "interrupted"

                is_running = (st == "running")
                is_interrupted = (st == "interrupted")
                success = meta.get("success", (st == "completed" or (not is_running and ec == 0)))
                dur = meta.get("duration", row["duration_seconds"])

                if is_running:
                    try:
                        t_str = row["timestamp"].replace("Z", "+00:00")
                        start_dt = datetime.fromisoformat(t_str)
                        elapsed = max(0.0, (datetime.now(timezone.utc) - start_dt).total_seconds())
                        dur = round(elapsed, 1)
                    except Exception:
                        dur = float(dur or 0.0)

                if is_interrupted:
                    summary_label = f"{cmd} — interrupted after {format_duration(dur)}"
                elif is_running:
                    summary_label = f"{cmd} — running for {format_duration(dur)}"
                elif success:
                    summary_label = f"{cmd} — completed in {format_duration(dur)}"
                else:
                    summary_label = f"{cmd} — failed (exit code {ec}) after {format_duration(dur)}"

                # Apply filters
                if is_running_only and not is_running:
                    continue
                if is_interrupted_only and not is_interrupted:
                    continue
                if is_failed and (success or is_running):
                    continue
                if target_status and st != target_status:
                    continue

                results.append({
                    "id": row["id"],
                    "timestamp": row["timestamp"],
                    "shell": sh,
                    "command": cmd,
                    "cwd": dir_path,
                    "status": st,
                    "running": is_running,
                    "interrupted": is_interrupted,
                    "exit_code": ec,
                    "success": success,
                    "duration_seconds": dur,
                    "duration_formatted": format_duration(dur),
                    "summary_label": summary_label
                })

                if len(results) >= limit:
                    break

        return results

    def get_running_commands(self, limit: int = 50) -> List[Dict[str, Any]]:
        """
        Retrieves all currently active or in-progress terminal commands.
        """
        return self.get_terminal_history(
            timeframe="all",
            running_only=True,
            limit=limit
        )

    def search(
        self,
        query: str,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        limit: int = 20
    ) -> Dict[str, Any]:
        """
        Executes full-text search across activity window titles and clipboard content.
        Uses FTS5 when available, falling back to LIKE.
        """
        clean_q = query.strip()
        if not clean_q:
            return {"query": query, "activities": [], "clipboards": []}

        activities = []
        clipboards = []
        seen_ids = set()

        def _extract_activity(row: Any) -> Dict[str, Any]:
            meta = {}
            if "metadata_json" in row.keys() and row["metadata_json"]:
                try:
                    meta = json.loads(row["metadata_json"])
                except Exception:
                    pass
            item = {
                "id": row["id"],
                "timestamp": row["timestamp"],
                "app_name": row["app_name"],
                "window_title": row["window_title"],
                "duration_seconds": row["duration_seconds"],
                "duration_formatted": format_duration(row["duration_seconds"]),
            }
            if "source" in row.keys() and row["source"]:
                item["source"] = row["source"]
            if meta.get("url"):
                item["url"] = meta["url"]
            if meta.get("file"):
                item["file"] = meta["file"]
            if meta.get("workspace"):
                item["workspace"] = meta["workspace"]
            if meta.get("language"):
                item["language"] = meta["language"]
            if meta.get("git_branch"):
                item["git_branch"] = meta["git_branch"]
            if meta.get("lines_added") is not None and meta.get("lines_added") > 0:
                item["lines_added"] = meta["lines_added"]
            if meta.get("lines_removed") is not None and meta.get("lines_removed") > 0:
                item["lines_removed"] = meta["lines_removed"]
            if meta.get("command"):
                item["command"] = meta["command"]
            if meta.get("shell"):
                item["shell"] = meta["shell"]
            if meta.get("cwd"):
                item["cwd"] = meta["cwd"]
            if meta.get("exit_code") is not None:
                item["exit_code"] = meta["exit_code"]
                item["success"] = meta.get("success", meta["exit_code"] == 0)
            if meta.get("status"):
                st = meta["status"].lower()
                item["status"] = st
                item["running"] = (st == "running")
                item["interrupted"] = (st == "interrupted")
            if meta.get("duration") is not None:
                item["duration"] = meta["duration"]
            if meta.get("command"):
                dur_str = format_duration(float(meta.get("duration") or 0.0))
                st = meta.get("status", "completed")
                if st == "interrupted":
                    item["summary_label"] = f"{meta['command']} — interrupted after {dur_str}"
                elif st == "running":
                    item["summary_label"] = f"{meta['command']} — running for {dur_str}"
                elif meta.get("exit_code") == 0 or st == "completed":
                    item["summary_label"] = f"{meta['command']} — completed in {dur_str}"
                else:
                    item["summary_label"] = f"{meta['command']} — failed (exit code {meta.get('exit_code')}) after {dur_str}"
            if meta:
                item["metadata"] = meta
            return item

        with self.store._get_connection() as conn:
            # 1. Search Activities (FTS5 or fallback)
            try:
                fts_query = """
                    SELECT a.id, a.timestamp, a.app_name, a.window_title, a.duration_seconds, a.source, a.metadata_json
                    FROM activity_fts f
                    JOIN activity_events a ON f.rowid = a.id
                    WHERE activity_fts MATCH ?
                """
                params = [f'"{clean_q}"']
                if start_time and end_time:
                    fts_query += " AND a.timestamp >= ? AND a.timestamp <= ?"
                    params.extend([start_time, end_time])
                fts_query += " ORDER BY a.timestamp DESC LIMIT ?"
                params.append(limit)

                cursor = conn.execute(fts_query, params)
                for row in cursor.fetchall():
                    seen_ids.add(row["id"])
                    activities.append(_extract_activity(row))
            except Exception:
                # Fallback to standard LIKE
                like_query = """
                    SELECT id, timestamp, app_name, window_title, duration_seconds, source, metadata_json
                    FROM activity_events
                    WHERE (window_title LIKE ? OR app_name LIKE ?)
                """
                like_params = [f"%{clean_q}%", f"%{clean_q}%"]
                if start_time and end_time:
                    like_query += " AND timestamp >= ? AND timestamp <= ?"
                    like_params.extend([start_time, end_time])
                like_query += " ORDER BY timestamp DESC LIMIT ?"
                like_params.append(limit)

                cursor = conn.execute(like_query, like_params)
                for row in cursor.fetchall():
                    seen_ids.add(row["id"])
                    activities.append(_extract_activity(row))

            # Also search metadata_json for URL or domain matches if limit not reached
            if len(activities) < limit:
                remaining = limit - len(activities)
                meta_query = """
                    SELECT id, timestamp, app_name, window_title, duration_seconds, source, metadata_json
                    FROM activity_events
                    WHERE metadata_json LIKE ?
                """
                meta_params = [f"%{clean_q}%"]
                if start_time and end_time:
                    meta_query += " AND timestamp >= ? AND timestamp <= ?"
                    meta_params.extend([start_time, end_time])
                meta_query += " ORDER BY timestamp DESC LIMIT ?"
                meta_params.append(remaining)

                cursor = conn.execute(meta_query, meta_params)
                for row in cursor.fetchall():
                    if row["id"] not in seen_ids:
                        seen_ids.add(row["id"])
                        activities.append(_extract_activity(row))

            # 2. Search Clipboard Events
            try:
                fts_clip = """
                    SELECT c.id, c.timestamp, c.app_name, c.content, c.content_type
                    FROM clipboard_fts f
                    JOIN clipboard_events c ON f.rowid = c.id
                    WHERE clipboard_fts MATCH ?
                """
                clip_params = [f'"{clean_q}"']
                if start_time and end_time:
                    fts_clip += " AND c.timestamp >= ? AND c.timestamp <= ?"
                    clip_params.extend([start_time, end_time])
                fts_clip += " ORDER BY c.timestamp DESC LIMIT ?"
                clip_params.append(limit)

                cursor = conn.execute(fts_clip, clip_params)
                for row in cursor.fetchall():
                    content = row["content"]
                    if len(content) > 300:
                        content = content[:300] + "..."
                    clipboards.append({
                        "id": row["id"],
                        "timestamp": row["timestamp"],
                        "app_name": row["app_name"],
                        "content_preview": content,
                        "content_type": row["content_type"]
                    })
            except Exception:
                # Fallback to LIKE
                like_clip = """
                    SELECT id, timestamp, app_name, content, content_type
                    FROM clipboard_events
                    WHERE content LIKE ?
                """
                clip_params = [f"%{clean_q}%"]
                if start_time and end_time:
                    like_clip += " AND timestamp >= ? AND timestamp <= ?"
                    clip_params.extend([start_time, end_time])
                like_clip += " ORDER BY timestamp DESC LIMIT ?"
                clip_params.append(limit)

                cursor = conn.execute(like_clip, clip_params)
                for row in cursor.fetchall():
                    content = row["content"]
                    if len(content) > 300:
                        content = content[:300] + "..."
                    clipboards.append({
                        "id": row["id"],
                        "timestamp": row["timestamp"],
                        "app_name": row["app_name"],
                        "content_preview": content,
                        "content_type": row["content_type"]
                    })

        return {
            "query": query,
            "total_matches": len(activities) + len(clipboards),
            "activities": activities,
            "clipboards": clipboards
        }


# Global search instance
workstream_search = WorkstreamSearch()

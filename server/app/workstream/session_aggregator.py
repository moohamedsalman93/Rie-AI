"""
Session Aggregator for Rie-AI Workstream Engine (Phase 3 Semantic Memory).
Aggregates granular, multi-sensor raw activity events (Windows, Browser, IDE, Clipboard, Terminal)
into coherent, human-meaningful semantic work sessions with high-level titles, narratives, and entities.
"""
import asyncio
from datetime import datetime, timezone, timedelta
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

from app.workstream.models import WorkSession
from app.workstream.store import workstream_store, WorkstreamStore
from app.workstream.search import parse_timeframe, format_duration

logger = logging.getLogger("workstream.session_aggregator")


def _parse_ts(ts_str: str) -> datetime:
    """Safely parses ISO-8601 string to UTC datetime."""
    try:
        clean = ts_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def _extract_domain(url: str) -> Optional[str]:
    """Extracts base domain from a URL (e.g. github.com from https://github.com/facebook/react)."""
    try:
        parsed = urlparse(url)
        netloc = parsed.netloc.lower()
        if netloc.startswith("www."):
            netloc = netloc[4:]
        return netloc if netloc else None
    except Exception:
        return None


class SessionAggregator:
    """
    Groups raw activity events into semantic work sessions and synthesizes narrative summaries.
    """

    def __init__(self, store: Optional[WorkstreamStore] = None):
        self.store = store or workstream_store
        self._bg_task: Optional[asyncio.Task] = None
        self._running: bool = False

    def cluster_events(
        self,
        events: List[Dict[str, Any]],
        idle_threshold_minutes: int = 20
    ) -> List[List[Dict[str, Any]]]:
        """
        Clusters raw activity events into distinct work session groups based on:
        1. Inactivity gap between consecutive events exceeding idle_threshold_minutes.
        2. Substantial workspace/project context shift with a gap > 5 minutes.
        """
        if not events:
            return []

        # Sort chronologically
        sorted_events = sorted(events, key=lambda e: e.get("timestamp", ""))
        clusters: List[List[Dict[str, Any]]] = []
        current_cluster: List[Dict[str, Any]] = [sorted_events[0]]

        threshold_seconds = idle_threshold_minutes * 60

        for i in range(1, len(sorted_events)):
            prev_evt = sorted_events[i - 1]
            curr_evt = sorted_events[i]

            prev_ts = _parse_ts(prev_evt.get("timestamp", ""))
            curr_ts = _parse_ts(curr_evt.get("timestamp", ""))

            gap_seconds = (curr_ts - prev_ts).total_seconds()

            # Rule 1: Inactivity break
            is_break = gap_seconds > threshold_seconds

            # Rule 2: Distinct project/workspace shift (meaningful project change with gap >= 60 seconds)
            if not is_break and gap_seconds >= 60:
                prev_meta = prev_evt.get("metadata") or {}
                curr_meta = curr_evt.get("metadata") or {}
                prev_proj = prev_meta.get("workspace") or prev_meta.get("project") or prev_meta.get("git_repo")
                curr_proj = curr_meta.get("workspace") or curr_meta.get("project") or curr_meta.get("git_repo")
                if prev_proj and curr_proj and prev_proj != curr_proj:
                    is_break = True

            if is_break:
                clusters.append(current_cluster)
                current_cluster = [curr_evt]
            else:
                current_cluster.append(curr_evt)

        if current_cluster:
            clusters.append(current_cluster)

        return clusters

    def synthesize_session(
        self,
        cluster: List[Dict[str, Any]],
        is_finalized: bool = True
    ) -> WorkSession:
        """
        Synthesizes a coherent, high-level semantic WorkSession from a cluster of correlated events.
        Combines cross-sensor data from Windows, Browser, IDE, Clipboard, and Terminal.
        """
        if not cluster:
            raise ValueError("Cannot synthesize session from empty cluster")

        start_time = cluster[0]["timestamp"]
        end_time = cluster[-1]["timestamp"]

        start_dt = _parse_ts(start_time)
        end_dt = _parse_ts(end_time)
        total_span_seconds = max(0.0, (end_dt - start_dt).total_seconds())

        # Collect metrics and entities
        sum_duration = 0.0
        apps_time: Dict[str, float] = {}
        projects_count: Dict[str, int] = {}
        files_seen: Set[str] = set()
        domains_seen: Set[str] = set()
        commands_seen: List[str] = []
        branches_seen: Set[str] = set()
        topics_seen: Set[str] = set()

        lines_added = 0
        lines_removed = 0
        tests_run: List[Dict[str, Any]] = []
        interrupted_commands: List[str] = []
        clipboard_count = 0

        for evt in cluster:
            dur = float(evt.get("duration_seconds") or 0.0)
            sum_duration += dur

            app = evt.get("app_name") or "Unknown"
            apps_time[app] = apps_time.get(app, 0.0) + max(1.0, dur)

            meta = evt.get("metadata") or {}

            # Workspace / Project
            ws = meta.get("workspace")
            if not ws and evt.get("event_type") == "terminal_command" and meta.get("cwd"):
                norm_cwd = meta["cwd"].replace("\\", "/").rstrip("/")
                parts = [p for p in norm_cwd.split("/") if p]
                proj_name = None
                for i in range(len(parts) - 1, -1, -1):
                    p = parts[i]
                    if p.lower() in ("server", "client", "app", "src", "tests", "test", "frontend", "backend", "web"):
                        continue
                    if p.lower() not in ("desktop", "users", "code", "c:", "d:", "reactjs", ""):
                        proj_name = p
                        break
                ws = proj_name or (parts[-1] if parts else None)
            if ws:
                projects_count[ws] = projects_count.get(ws, 0) + 1
                topics_seen.add(ws.lower())

            # Git branch
            if meta.get("git_branch"):
                branches_seen.add(meta["git_branch"])
                topics_seen.add(meta["git_branch"].lower())

            # IDE files & diffs
            if meta.get("file"):
                files_seen.add(meta["file"])
                # Extract file basename as topic
                base_file = os.path.basename(meta["file"])
                name_part = os.path.splitext(base_file)[0]
                if len(name_part) > 2:
                    topics_seen.add(name_part.lower())

            if meta.get("lines_added"):
                lines_added += int(meta["lines_added"])
            if meta.get("lines_removed"):
                lines_removed += int(meta["lines_removed"])

            # Browser URLs & domains
            url = meta.get("url")
            if url:
                dom = _extract_domain(url)
                if dom:
                    domains_seen.add(dom)
                    dom_core = dom.split(".")[0]
                    if len(dom_core) > 2:
                        topics_seen.add(dom_core)

            # Terminal commands
            if evt.get("event_type") == "terminal_command" or meta.get("command"):
                cmd = meta.get("command") or evt.get("window_title")
                if cmd:
                    clean_cmd = cmd.split("(")[0].strip()
                    if clean_cmd and clean_cmd not in commands_seen:
                        commands_seen.append(clean_cmd)

                    # Extract topics from command arguments (e.g. pytest, git, npm, tauri)
                    lower_cmd = clean_cmd.lower()
                    for kw in ("pytest", "unittest", "cargo", "tauri", "docker", "npm", "git", "python", "workstream"):
                        if kw in lower_cmd:
                            topics_seen.add(kw)

                    # Check for test execution
                    if any(t in lower_cmd for t in ("test", "pytest", "unittest", "cargo test", "npm test")):
                        tests_run.append({
                            "command": clean_cmd,
                            "success": meta.get("success", meta.get("exit_code") == 0),
                            "exit_code": meta.get("exit_code")
                        })

                    # Check for interrupted command
                    if meta.get("status") == "interrupted" or meta.get("interrupted"):
                        interrupted_commands.append(clean_cmd)

            # Clipboard
            if evt.get("event_type") == "clipboard_copy" or "clipboard" in evt.get("source", ""):
                clipboard_count += 1

        # Determine Primary Project
        primary_project = None
        if projects_count:
            primary_project = max(projects_count.items(), key=lambda x: x[1])[0]

        # Primary Apps (sorted by active time)
        sorted_apps = sorted(apps_time.keys(), key=lambda a: apps_time[a], reverse=True)
        primary_apps = sorted_apps[:4]

        # Formulate Title
        title_parts = []
        if primary_project:
            title_parts.append(f"Worked on {primary_project}")
        else:
            title_parts.append("Work Session")

        action_details = []
        if files_seen:
            top_file = os.path.basename(next(iter(files_seen)))
            if len(files_seen) > 1:
                action_details.append(f"Modified {top_file} and {len(files_seen) - 1} other file(s)")
            else:
                action_details.append(f"Modified {top_file}")

        if tests_run:
            action_details.append("ran test suite")
        elif commands_seen:
            top_cmd = commands_seen[0].split()[0]
            action_details.append(f"executed {top_cmd} commands")

        if domains_seen and not files_seen and not commands_seen:
            top_dom = next(iter(domains_seen))
            action_details.append(f"researched on {top_dom}")

        if action_details:
            title = f"{title_parts[0]}: {', '.join(action_details)}"
        else:
            title = f"{title_parts[0]} ({format_duration(total_span_seconds)})"

        # Formulate Narrative Summary
        start_hm = start_dt.strftime("%H:%M")
        end_hm = end_dt.strftime("%H:%M")
        dur_str = format_duration(max(total_span_seconds, sum_duration))

        summary_segments = [f"{start_hm}–{end_hm} ({dur_str})"]

        context_segment = []
        if primary_project:
            context_segment.append(f"on project {primary_project}")
        if branches_seen:
            context_segment.append(f"(branch: {', '.join(sorted(list(branches_seen)))})")
        if primary_apps:
            context_segment.append(f"using {', '.join(primary_apps)}")

        if context_segment:
            summary_segments.append(f"— Active {' '.join(context_segment)}.")

        narrative_body = []
        if files_seen:
            file_names = [os.path.basename(f) for f in sorted(list(files_seen))]
            diff_note = ""
            if lines_added > 0 or lines_removed > 0:
                diff_note = f" (+{lines_added}/-{lines_removed} lines)"
            narrative_body.append(f"Modified {', '.join(file_names[:3])}{diff_note}")

        if domains_seen:
            dom_list = sorted(list(domains_seen))
            narrative_body.append(f"reviewed {', '.join(dom_list[:3])}")

        if tests_run:
            passed_tests = sum(1 for t in tests_run if t["success"])
            if passed_tests == len(tests_run):
                narrative_body.append(f"executed {len(tests_run)} test run(s) (all passing)")
            else:
                narrative_body.append(f"ran tests ({passed_tests}/{len(tests_run)} passed)")
        elif commands_seen:
            narrative_body.append(f"executed terminal commands ({', '.join(commands_seen[:2])})")

        if interrupted_commands:
            narrative_body.append(f"interrupted {interrupted_commands[0]} via Ctrl+C")

        if clipboard_count > 0:
            narrative_body.append(f"copied {clipboard_count} snippet(s)")

        if narrative_body:
            full_summary = f"{' '.join(summary_segments)} {'; '.join(narrative_body)}."
        else:
            full_summary = f"{' '.join(summary_segments)} General desktop activity in {', '.join(primary_apps)}."

        # Compute effective duration (use span or sum)
        effective_duration = max(sum_duration, total_span_seconds)

        sess = WorkSession(
            title=title,
            summary=full_summary,
            project=primary_project,
            start_time=start_time,
            end_time=end_time,
            duration_seconds=round(effective_duration, 1),
            event_count=len(cluster),
            files=sorted(list(files_seen)),
            domains=sorted(list(domains_seen)),
            commands=commands_seen[:10],
            topics=sorted(list(topics_seen)),
            primary_apps=primary_apps,
            metadata={
                "git_branches": sorted(list(branches_seen)),
                "lines_added": lines_added,
                "lines_removed": lines_removed,
                "tests_run_count": len(tests_run),
                "clipboard_count": clipboard_count,
                "interrupted_commands": interrupted_commands,
                "is_finalized": is_finalized,
                "status": "finalized" if is_finalized else "in_progress",
            },
            is_finalized=is_finalized
        )

        policy = self.store.get_policy()
        if getattr(policy.memory, "semantic", True):
            try:
                from app.workstream.semantic_understanding import semantic_understanding_engine
                sess = semantic_understanding_engine.enrich_work_session(sess)
            except Exception as e:
                logger.debug("Failed to enrich work session with semantic understanding: %s", e)

        return sess

    def aggregate_events(
        self,
        timeframe: Optional[str] = "today",
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
        idle_threshold_minutes: int = 20,
        force: bool = False
    ) -> List[WorkSession]:
        """
        Queries raw events in the given timeframe, clusters them into sessions,
        synthesizes WorkSession objects, and saves them to SQLite and LTM.
        """
        # Check Workstream policy / config
        policy = self.store.get_policy()
        if not policy.enabled or policy.is_paused or not getattr(policy.memory, "sessions", True):
            logger.debug("Workstream session aggregation is disabled in policy.")
            return []

        if start_time or end_time:
            start_iso = start_time or "1970-01-01T00:00:00Z"
            end_iso = end_time or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            start_iso, end_iso = parse_timeframe(timeframe)

        # 1. Fetch raw activity events
        raw_events: List[Dict[str, Any]] = []
        with self.store._get_connection() as conn:
            cursor = conn.execute("""
                SELECT id, event_id, timestamp, event_type, app_name, process_name,
                       window_title, source, metadata_json, duration_seconds
                FROM activity_events
                WHERE timestamp >= ? AND timestamp <= ?
                ORDER BY timestamp ASC
            """, (start_iso, end_iso))

            for row in cursor.fetchall():
                meta = {}
                if row["metadata_json"]:
                    try:
                        meta = json.loads(row["metadata_json"])
                    except Exception:
                        pass
                raw_events.append({
                    "id": row["id"],
                    "timestamp": row["timestamp"],
                    "event_type": row["event_type"],
                    "app_name": row["app_name"],
                    "window_title": row["window_title"],
                    "source": row["source"],
                    "duration_seconds": row["duration_seconds"],
                    "metadata": meta
                })

        if not raw_events:
            return []

        # 2. Cluster events
        clusters = self.cluster_events(raw_events, idle_threshold_minutes=idle_threshold_minutes)

        # 3. Synthesize and save sessions
        now = datetime.now(timezone.utc)
        sessions: List[WorkSession] = []
        num_clusters = len(clusters)
        for idx, cluster in enumerate(clusters):
            if not cluster:
                continue
            is_last = (idx == num_clusters - 1)
            if not is_last:
                # Preceding clusters ended because another cluster started -> finalized
                cluster_is_finalized = True
            else:
                # Tail cluster: check time gap between latest event and now
                last_evt_ts = _parse_ts(cluster[-1].get("timestamp", ""))
                inactivity_sec = (now - last_evt_ts).total_seconds()
                # If inactivity >= idle threshold, session has closed and finalized!
                cluster_is_finalized = inactivity_sec >= (idle_threshold_minutes * 60)

            sess = self.synthesize_session(cluster, is_finalized=cluster_is_finalized)
            saved_sess = self.store.save_work_session(sess)
            sessions.append(saved_sess)

        logger.info(f"Aggregated {len(raw_events)} events into {len(sessions)} work session(s) for timeframe={timeframe}")
        return sessions

    async def start_background_loop(self, interval_seconds: int = 180) -> None:
        """Starts the periodic background aggregation loop."""
        if self._running:
            return
        self._running = True
        self._bg_task = asyncio.create_task(self._run_loop(interval_seconds))
        logger.info(f"Background session aggregation loop started (interval={interval_seconds}s).")

    async def stop_background_loop(self) -> None:
        """Stops the background aggregation loop cleanly."""
        self._running = False
        if self._bg_task and not self._bg_task.done():
            self._bg_task.cancel()
            try:
                await self._bg_task
            except asyncio.CancelledError:
                pass
        logger.info("Background session aggregation loop stopped.")

    async def _run_loop(self, interval_seconds: int) -> None:
        """Periodically triggers aggregate_events for 'today'."""
        while self._running:
            try:
                await asyncio.sleep(interval_seconds)
                if not self._running:
                    break
                await asyncio.to_thread(self.aggregate_events, timeframe="today", idle_threshold_minutes=20)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Error in background session aggregation loop: {e}")
                await asyncio.sleep(5)


# Global singleton instance
session_aggregator = SessionAggregator()

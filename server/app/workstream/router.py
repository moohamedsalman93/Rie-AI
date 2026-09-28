"""
FastAPI HTTP routes for the Rie-AI Workstream Engine.
Receives batched event streams from the native Tauri/Rust collector and serves query endpoints.
"""
from datetime import datetime, timezone
import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.workstream.models import (
    ActivityEvent,
    BrowserEvent,
    IDEEvent,
    TerminalEvent,
    ClipboardEvent,
    BatchEventsRequest,
    WorkstreamPolicy,
    WorkstreamConfig,
    SensorConfig,
    PrivacyConfig,
    MemoryConfig,
    WorkSession,
    AggregateSessionsRequest,
    SessionFilterRequest,
)
from app.workstream.store import workstream_store
from app.workstream.search import workstream_search, parse_timeframe
from app.workstream.session_aggregator import session_aggregator
from app.workstream.plugin_manager import plugin_manager

logger = logging.getLogger("workstream.router")

router = APIRouter(prefix="/workstream", tags=["Workstream"])


class PauseRequest(BaseModel):
    paused: bool


class PruneRequest(BaseModel):
    retention_days: Optional[int] = None


@router.post("/events", status_code=status.HTTP_200_OK)
async def receive_events(request: Request) -> Dict[str, Any]:
    """
    Ingests batched or single activity, browser, IDE, terminal, and clipboard events.
    Supports:
    1. BatchEventsRequest (Tauri native collector): {"activity_events": [...], "clipboard_events": [...]}
    2. Browser extension event: {"event_type": "browser_tab", "browser": "Brave", "url": "...", "title": "..."}
    3. IDE context / change event: {"event_type": "ide_context", "ide": "Antigravity", "file": "...", ...}
    4. Terminal command event: {"event_type": "terminal_command", "shell": "PowerShell", "command": "...", "cwd": "...", ...}
    Performs privacy filtering, deduplication, and persists to SQLite.
    """
    try:
        body = await request.json()
    except Exception as e:
        logger.warning(f"Invalid JSON payload in /workstream/events: {e}")
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    cfg = workstream_store.get_config()
    if not cfg.workstream or cfg.is_paused:
        logger.debug("Workstream is disabled or paused; dropping incoming events immediately.")
        return {
            "success": True,
            "ingested_activities": 0,
            "ingested_clipboards": 0,
            "paused": cfg.is_paused,
            "disabled": not cfg.workstream
        }

    activities: List[ActivityEvent] = []
    clipboards: List[ClipboardEvent] = []

    def _process_item(item: Any):
        if not isinstance(item, dict):
            return

        # Clipboard event
        if "content" in item and "url" not in item and "file" not in item and "command" not in item:
            try:
                clipboards.append(ClipboardEvent(**item))
            except Exception as e:
                logger.debug(f"Failed to parse clipboard event: {e}")
            return

        # Terminal command event (PowerShell, CMD, Git Bash)
        if item.get("event_type") == "terminal_command" or ("command" in item and ("shell" in item or "exit_code" in item or "cwd" in item)):
            try:
                term_evt = TerminalEvent(**item)
                activities.append(term_evt.to_activity_event())
                return
            except Exception as e:
                logger.debug(f"Failed to parse Terminal event: {e}")

        # IDE event (VS Code / Antigravity)
        if item.get("event_type") in ("ide_context", "file_change") or "ide" in item or ("file" in item and ("workspace" in item or "lines_added" in item)):
            try:
                ide_evt = IDEEvent(**item)
                activities.append(ide_evt.to_activity_event())
                return
            except Exception as e:
                logger.debug(f"Failed to parse IDE event: {e}")

        # Browser event (matches browser extension schema: url, browser, title, etc.)
        if "url" in item or item.get("event_type") in ("browser_tab", "tab_activated", "tab_updated") or item.get("source") == "browser_ext":
            try:
                b_evt = BrowserEvent(**item)
                activities.append(b_evt.to_activity_event())
                return
            except Exception as e:
                logger.debug(f"Failed to parse browser event: {e}")

        # Standard ActivityEvent
        try:
            activities.append(ActivityEvent(**item))
        except Exception as e:
            logger.debug(f"Failed to parse activity event: {e}")

    if isinstance(body, list):
        for item in body:
            _process_item(item)
    elif isinstance(body, dict):
        if "activity_events" in body or "clipboard_events" in body:
            batch = BatchEventsRequest(**body)
            activities.extend(batch.activity_events)
            clipboards.extend(batch.clipboard_events)
        else:
            _process_item(body)

    try:
        act_count = workstream_store.insert_activity_events(activities)
        clip_count = workstream_store.insert_clipboard_events(clipboards)
        return {
            "success": True,
            "ingested_activities": act_count,
            "ingested_clipboards": clip_count,
            "paused": workstream_store.is_paused()
        }
    except Exception as e:
        logger.exception("Failed to ingest workstream events: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/status")
async def get_status() -> Dict[str, Any]:
    """Returns database size, event counts, privacy settings, and pause state."""
    try:
        return workstream_store.get_stats()
    except Exception as e:
        logger.exception("Failed to fetch workstream stats: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/pause")
async def set_pause_state(req: PauseRequest) -> Dict[str, Any]:
    """Pauses or resumes workstream ingestion."""
    try:
        workstream_store.set_paused(req.paused)
        return {"paused": workstream_store.is_paused()}
    except Exception as e:
        logger.exception("Failed to update workstream pause state: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/timeline")
async def get_timeline(
    timeframe: Optional[str] = Query(None, description="e.g. 'today', 'yesterday', 'last_hour'"),
    start: Optional[str] = Query(None, description="ISO-8601 start timestamp"),
    end: Optional[str] = Query(None, description="ISO-8601 end timestamp"),
    app: Optional[str] = Query(None, description="Filter by app name"),
    limit: int = Query(100, ge=1, le=1000)
) -> Dict[str, Any]:
    """Retrieves chronological activity timeline."""
    try:
        if not start or not end:
            start_iso, end_iso = parse_timeframe(timeframe)
        else:
            start_iso, end_iso = start, end

        events = workstream_search.get_timeline(
            start_time=start_iso,
            end_time=end_iso,
            app_name=app,
            limit=limit
        )
        return {
            "start": start_iso,
            "end": end_iso,
            "count": len(events),
            "events": events
        }
    except Exception as e:
        logger.exception("Failed to query workstream timeline: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/summary")
async def get_summary(
    timeframe: Optional[str] = Query("today", description="e.g. 'today', 'yesterday', 'this_morning'"),
    start: Optional[str] = Query(None, description="ISO start"),
    end: Optional[str] = Query(None, description="ISO end")
) -> Dict[str, Any]:
    """Aggregates active time, top apps, files worked on, and clipboard snippets."""
    try:
        if not start or not end:
            start_iso, end_iso = parse_timeframe(timeframe)
        else:
            start_iso, end_iso = start, end

        summary = workstream_search.get_work_summary(start_time=start_iso, end_time=end_iso)
        return summary
    except Exception as e:
        logger.exception("Failed to generate work summary: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/search")
async def search(
    q: str = Query(..., min_length=1, description="Keywords to search"),
    timeframe: Optional[str] = Query(None, description="Optional timeframe filter"),
    limit: int = Query(20, ge=1, le=100)
) -> Dict[str, Any]:
    """Full-text search across past window titles, URLs, and copied clipboard snippets."""
    try:
        start_iso, end_iso = None, None
        if timeframe:
            start_iso, end_iso = parse_timeframe(timeframe)

        results = workstream_search.search(
            query=q,
            start_time=start_iso,
            end_time=end_iso,
            limit=limit
        )
        return results
    except Exception as e:
        logger.exception("Workstream search failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/terminal")
async def get_terminal_history(
    timeframe: Optional[str] = Query("today", description="e.g. 'today', 'yesterday', 'last_hour', 'last_7_days', 'all'"),
    start: Optional[str] = Query(None, description="ISO start"),
    end: Optional[str] = Query(None, description="ISO end"),
    q: Optional[str] = Query(None, description="Keyword search in command or title"),
    cwd: Optional[str] = Query(None, description="Filter by working directory"),
    shell: Optional[str] = Query(None, description="Filter by shell name"),
    status: Optional[str] = Query(None, description="Filter by status: 'running', 'interrupted', 'completed', 'failed'"),
    running_only: bool = Query(False, description="Filter only commands currently executing"),
    interrupted_only: bool = Query(False, description="Filter only commands interrupted with Ctrl+C"),
    failed_only: bool = Query(False, description="Filter only non-zero exit codes"),
    limit: int = Query(50, ge=1, le=500)
) -> Dict[str, Any]:
    """Retrieves executed, running, and interrupted terminal commands from PowerShell, CMD, and Git Bash."""
    try:
        start_iso, end_iso = None, None
        if start or end:
            start_iso = start or "1970-01-01T00:00:00Z"
            end_iso = end or datetime.now(timezone.utc).isoformat()
        elif timeframe:
            start_iso, end_iso = parse_timeframe(timeframe)

        commands = workstream_search.get_terminal_history(
            timeframe=timeframe,
            start_time=start_iso,
            end_time=end_iso,
            query=q,
            cwd=cwd,
            shell=shell,
            status=status,
            running_only=running_only,
            interrupted_only=interrupted_only,
            failed_only=failed_only,
            limit=limit
        )
        return {
            "timeframe": timeframe,
            "count": len(commands),
            "commands": commands
        }
    except Exception as e:
        logger.exception("Failed to query terminal history: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/terminal/running")
async def get_running_terminal_commands(
    limit: int = Query(50, ge=1, le=200)
) -> Dict[str, Any]:
    """Retrieves terminal commands that are currently in progress / running."""
    try:
        commands = workstream_search.get_running_commands(limit=limit)
        return {
            "count": len(commands),
            "running_commands": commands
        }
    except Exception as e:
        logger.exception("Failed to query running terminal commands: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/sessions/aggregate")
async def aggregate_work_sessions(req: AggregateSessionsRequest) -> Dict[str, Any]:
    """
    Triggers session clustering and semantic summary generation over raw events.
    Groups related Windows, Browser, IDE, Clipboard, and Terminal events into work sessions.
    """
    try:
        sessions = session_aggregator.aggregate_events(
            timeframe=req.timeframe,
            start_time=req.start_time,
            end_time=req.end_time,
            idle_threshold_minutes=req.idle_threshold_minutes,
            force=req.force,
        )
        return {
            "success": True,
            "count": len(sessions),
            "sessions": [s.model_dump() for s in sessions],
        }
    except Exception as e:
        logger.exception("Failed to aggregate work sessions: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions")
async def get_work_sessions(
    timeframe: Optional[str] = Query("today"),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    project: Optional[str] = Query(None),
    file: Optional[str] = Query(None),
    domain: Optional[str] = Query(None),
    topic: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    finalized_only: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    auto_aggregate: bool = Query(True),
) -> Dict[str, Any]:
    """
    Retrieves semantic work sessions matching time, project, file, domain, topic, or search query.
    If no sessions exist yet for the requested timeframe and auto_aggregate=True, runs aggregation on demand.
    """
    try:
        sessions = workstream_store.get_work_sessions(
            timeframe=timeframe,
            start_time=start,
            end_time=end,
            project=project,
            file=file,
            domain=domain,
            topic=topic,
            query=q,
            finalized_only=finalized_only,
            limit=limit,
        )
        if not sessions and auto_aggregate and (timeframe or (start and end)):
            agg_sessions = session_aggregator.aggregate_events(
                timeframe=timeframe,
                start_time=start,
                end_time=end,
            )
            if agg_sessions:
                sessions = workstream_store.get_work_sessions(
                    timeframe=timeframe,
                    start_time=start,
                    end_time=end,
                    project=project,
                    file=file,
                    domain=domain,
                    topic=topic,
                    query=q,
                    finalized_only=finalized_only,
                    limit=limit,
                )

        return {
            "timeframe": timeframe,
            "count": len(sessions),
            "sessions": sessions,
        }
    except Exception as e:
        logger.exception("Failed to retrieve work sessions: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/latest")
async def get_latest_work_session(
    project: Optional[str] = Query(None),
    finalized_only: bool = Query(True),
) -> Dict[str, Any]:
    """
    Retrieves the most recent work session for resuming work ('continue where I left off').
    By default returns the latest finalized session.
    """
    try:
        sess = workstream_store.get_latest_work_session(project=project, finalized_only=finalized_only)
        if not sess:
            session_aggregator.aggregate_events(timeframe="today")
            sess = workstream_store.get_latest_work_session(project=project, finalized_only=finalized_only)

        return {
            "session": sess
        }
    except Exception as e:
        logger.exception("Failed to get latest work session: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions/auto-aggregate")
async def auto_aggregate_sessions() -> Dict[str, Any]:
    """Triggers an immediate automatic aggregation pass for today's sessions."""
    try:
        sessions = session_aggregator.aggregate_events(timeframe="today")
        return {
            "success": True,
            "count": len(sessions),
            "sessions": [s.model_dump() for s in sessions],
        }
    except Exception as e:
        logger.exception("Failed to auto-aggregate work sessions: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sessions/{session_id}")
async def get_session_by_id(session_id: str) -> Dict[str, Any]:
    """Retrieves full details for a single work session by session_id."""
    try:
        sess = workstream_store.get_session_by_id(session_id)
        if not sess:
            raise HTTPException(status_code=404, detail="Work session not found")
        return {"session": sess}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to retrieve work session by ID: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/sessions/{session_id}/understand")
async def extract_session_understanding(session_id: str) -> Dict[str, Any]:
    """
    Phase 4.1: Infers or refreshes deep semantic understanding (task, goal, problem, progress, next steps)
    for a work session and updates it in SQLite + Chroma LTM.
    """
    try:
        from app.workstream.semantic_understanding import semantic_understanding_engine
        sess = workstream_store.get_session_by_id(session_id)
        if not sess:
            raise HTTPException(status_code=404, detail="Work session not found")

        ws = WorkSession(**sess)
        enriched = semantic_understanding_engine.enrich_work_session(ws)
        workstream_store.save_work_session(enriched)

        return {
            "success": True,
            "session_id": session_id,
            "understanding": enriched.understanding.model_dump() if enriched.understanding else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to extract session understanding: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/prune")
async def prune_events(req: PruneRequest) -> Dict[str, Any]:
    """Triggers retention pruning of events older than retention cutoff."""
    try:
        res = workstream_store.prune_expired_events(req.retention_days)
        return {"success": True, **res}
    except Exception as e:
        logger.exception("Workstream prune failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config")
async def get_workstream_config() -> Dict[str, Any]:
    """Returns the central Workstream and sensor configuration."""
    try:
        return workstream_store.get_config().model_dump()
    except Exception as e:
        logger.exception("Failed to get workstream config: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/config")
async def update_workstream_config(config: WorkstreamConfig) -> Dict[str, Any]:
    """Updates and persists the central Workstream and sensor configuration."""
    try:
        updated = workstream_store.update_config(config)
        return {"success": True, "config": updated.model_dump()}
    except Exception as e:
        logger.exception("Failed to update workstream config: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/sensors/status")
async def get_sensors_status() -> Dict[str, Any]:
    """Returns live connection and health status for all sensors."""
    try:
        return workstream_store.get_sensor_status()
    except Exception as e:
        logger.exception("Failed to get sensor status: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/policy")
async def get_policy() -> Dict[str, Any]:
    """Returns the current policy."""
    try:
        return {"policy": workstream_store.get_policy().model_dump()}
    except Exception as e:
        logger.exception("Failed to get workstream policy: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/policy")
async def update_policy(policy: WorkstreamPolicy) -> Dict[str, Any]:
    """Updates privacy rules, excluded apps list, and retention policy."""
    try:
        workstream_store.update_policy(policy)
        return {"success": True, "policy": workstream_store.get_policy().model_dump()}
    except Exception as e:
        logger.exception("Failed to update workstream policy: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/plugins/status")
async def get_plugins_status() -> Dict[str, Any]:
    """Returns installation status for IDE, Terminal, and Browser companion plugins."""
    try:
        return plugin_manager.get_status()
    except Exception as e:
        logger.exception("Failed to get plugins status: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/plugins/install-ide")
async def install_ide_plugin() -> Dict[str, Any]:
    """Auto-injects the IDE companion extension into user's editor directories."""
    try:
        return plugin_manager.install_ide()
    except Exception as e:
        logger.exception("Failed to install IDE companion: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/plugins/uninstall-ide")
async def uninstall_ide_plugin() -> Dict[str, Any]:
    """Removes the IDE companion extension."""
    try:
        return plugin_manager.uninstall_ide()
    except Exception as e:
        logger.exception("Failed to uninstall IDE companion: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/plugins/install-terminal")
async def install_terminal_plugin() -> Dict[str, Any]:
    """Auto-injects non-intrusive shell hooks into PowerShell and Git Bash."""
    try:
        return plugin_manager.install_terminal()
    except Exception as e:
        logger.exception("Failed to inject terminal hooks: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/plugins/uninstall-terminal")
async def uninstall_terminal_plugin() -> Dict[str, Any]:
    """Removes shell hooks from PowerShell and Git Bash."""
    try:
        return plugin_manager.uninstall_terminal()
    except Exception as e:
        logger.exception("Failed to remove terminal hooks: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/plugins/open-browser-folder")
async def open_browser_folder() -> Dict[str, Any]:
    """Prepares the browser extension files and reveals the folder in Windows Explorer."""
    try:
        return plugin_manager.open_browser_folder()
    except Exception as e:
        logger.exception("Failed to open browser folder: %s", e)
        raise HTTPException(status_code=500, detail=str(e))



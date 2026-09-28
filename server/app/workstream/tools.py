"""
LangChain tools for the Rie-AI Agent and Live Voice session.
Enables queries like:
- "What changes or work did I do yesterday?"
- "What was that webpage I was looking at 20 minutes ago?"
- "Explain the code I copied 5 minutes ago."
"""
from datetime import datetime, timezone
import json
import logging
from typing import Any, Dict, Optional
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.workstream.search import workstream_search, parse_timeframe
from app.workstream.store import workstream_store
from app.workstream.session_aggregator import session_aggregator

logger = logging.getLogger("workstream.tools")


# --- Input Schemas ---

class GetWorkSummaryInput(BaseModel):
    timeframe: str = Field(
        default="today",
        description=(
            "Timeframe to summarize. Supported values: 'today', 'yesterday', "
            "'this_morning', 'this_afternoon', 'last_hour', 'last_2_hours', "
            "'last_7_days', or a specific date 'YYYY-MM-DD'."
        )
    )


class GetActivityTimelineInput(BaseModel):
    timeframe: str = Field(
        default="today",
        description="Timeframe to retrieve timeline for: 'today', 'yesterday', 'last_hour', 'last_2_hours', etc."
    )
    app_name: Optional[str] = Field(
        default=None,
        description="Optional filter for specific application (e.g. 'Code', 'PowerShell', 'Git Bash', 'CMD', 'Chrome', 'Slack', 'Terminal')."
    )
    limit: int = Field(
        default=50,
        description="Maximum number of chronological events to return (default: 50)."
    )


class SearchActivityInput(BaseModel):
    query: str = Field(
        ...,
        description="Keywords or phrases to search for across past window titles, files, web pages, terminal commands, or copied clipboard content."
    )
    timeframe: Optional[str] = Field(
        default=None,
        description="Optional timeframe constraint (e.g. 'yesterday', 'today', 'last_7_days')."
    )
    limit: int = Field(
        default=15,
        description="Maximum search matches to return (default: 15)."
    )


class GetTerminalHistoryInput(BaseModel):
    timeframe: str = Field(
        default="today",
        description="Timeframe to query commands: 'today', 'yesterday', 'last_hour', 'last_2_hours', 'last_7_days', 'all', etc."
    )
    query: Optional[str] = Field(
        default=None,
        description="Optional command keyword to filter by (e.g. 'pytest', 'ping', 'git', 'npm', 'poetry', 'build')."
    )
    cwd: Optional[str] = Field(
        default=None,
        description="Optional filter for working directory path or project folder name (e.g. 'Rie-AI', 'server', 'client')."
    )
    status: Optional[str] = Field(
        default=None,
        description="Optional filter for command execution status: 'running', 'interrupted', 'completed', 'failed'."
    )
    running_only: bool = Field(
        default=False,
        description="If True, only returns commands that are currently executing in the terminal."
    )
    interrupted_only: bool = Field(
        default=False,
        description="If True, only returns commands that were cancelled / aborted with Ctrl+C (interrupted)."
    )
    failed_only: bool = Field(
        default=False,
        description="If True, only returns commands that exited with a non-zero status code (failures)."
    )
    limit: int = Field(
        default=30,
        description="Maximum number of commands to return (default: 30)."
    )


class GetRunningTerminalCommandsInput(BaseModel):
    limit: int = Field(
        default=20,
        description="Maximum number of currently running terminal commands to return (default: 20)."
    )



# --- Tool Implementations ---

def get_work_summary_func(timeframe: str = "today") -> str:
    """Returns an aggregated summary of active time, applications used, top files/windows, and clipboard count."""
    try:
        start_iso, end_iso = parse_timeframe(timeframe)
        summary = workstream_search.get_work_summary(start_time=start_iso, end_time=end_iso)
        return json.dumps(summary, indent=2)
    except Exception as e:
        logger.exception("Failed to execute get_work_summary: %s", e)
        return f"Error retrieving work summary: {e}"


def get_activity_timeline_func(timeframe: str = "today", app_name: Optional[str] = None, limit: int = 50) -> str:
    """Returns a chronological timeline of desktop window switches and tasks."""
    try:
        start_iso, end_iso = parse_timeframe(timeframe)
        events = workstream_search.get_timeline(
            start_time=start_iso,
            end_time=end_iso,
            app_name=app_name,
            limit=limit
        )
        return json.dumps({
            "timeframe": timeframe,
            "count": len(events),
            "events": events
        }, indent=2)
    except Exception as e:
        logger.exception("Failed to execute get_activity_timeline: %s", e)
        return f"Error retrieving activity timeline: {e}"


def search_activity_func(query: str, timeframe: Optional[str] = None, limit: int = 15) -> str:
    """Performs full-text search across past window titles, documents, web pages, and clipboard history."""
    try:
        start_iso, end_iso = None, None
        if timeframe:
            start_iso, end_iso = parse_timeframe(timeframe)

        results = workstream_search.search(
            query=query,
            start_time=start_iso,
            end_time=end_iso,
            limit=limit
        )
        return json.dumps(results, indent=2)
    except Exception as e:
        logger.exception("Failed to execute search_activity: %s", e)
        return f"Error searching activity: {e}"


def get_terminal_history_func(
    timeframe: str = "today",
    query: Optional[str] = None,
    cwd: Optional[str] = None,
    status: Optional[str] = None,
    running_only: bool = False,
    interrupted_only: bool = False,
    failed_only: bool = False,
    limit: int = 30
) -> str:
    """Returns executed shell commands from PowerShell, CMD, and Git Bash, including interrupted commands and running processes."""
    try:
        commands = workstream_search.get_terminal_history(
            timeframe=timeframe,
            query=query,
            cwd=cwd,
            status=status,
            running_only=running_only,
            interrupted_only=interrupted_only,
            failed_only=failed_only,
            limit=limit
        )
        return json.dumps({
            "timeframe": timeframe,
            "count": len(commands),
            "commands": commands
        }, indent=2)
    except Exception as e:
        logger.exception("Failed to execute get_terminal_history: %s", e)
        return f"Error retrieving terminal history: {e}"


def get_running_terminal_commands_func(limit: int = 20) -> str:
    """Returns terminal commands that are currently executing / in-progress."""
    try:
        commands = workstream_search.get_running_commands(limit=limit)
        return json.dumps({
            "count": len(commands),
            "running_commands": commands
        }, indent=2)
    except Exception as e:
        logger.exception("Failed to execute get_running_terminal_commands: %s", e)
        return f"Error retrieving running terminal commands: {e}"


class GetWorkSessionsInput(BaseModel):
    timeframe: Optional[str] = Field(
        default="today",
        description=(
            "Timeframe to retrieve work sessions for: 'yesterday', 'today', 'this_morning', "
            "'last_24_hours', 'last_7_days', or a specific date 'YYYY-MM-DD'."
        )
    )
    project: Optional[str] = Field(
        default=None,
        description="Filter sessions by project name (e.g. 'Rie-AI', 'workstream')."
    )
    topic: Optional[str] = Field(
        default=None,
        description="Filter sessions by topic, feature, or keywords (e.g. 'terminal tracking', 'live_tool_dispatcher', 'auth')."
    )
    file: Optional[str] = Field(
        default=None,
        description="Filter sessions where a specific file was edited or opened."
    )
    domain: Optional[str] = Field(
        default=None,
        description="Filter sessions where a specific web domain was researched (e.g. 'github.com', 'stackoverflow.com')."
    )
    limit: int = Field(
        default=10,
        description="Maximum number of work sessions to return."
    )


class GetLastWorkSessionInput(BaseModel):
    project: Optional[str] = Field(
        default=None,
        description="Optional project name filter (e.g. 'Rie-AI') to find the last session for that specific project."
    )


def get_work_sessions_func(
    timeframe: Optional[str] = "today",
    project: Optional[str] = None,
    topic: Optional[str] = None,
    file: Optional[str] = None,
    domain: Optional[str] = None,
    limit: int = 10,
) -> str:
    """Retrieves semantic work sessions clustered and synthesized from raw activity."""
    try:
        sessions = workstream_store.get_work_sessions(
            timeframe=timeframe,
            project=project,
            file=file,
            domain=domain,
            topic=topic,
            limit=limit,
        )
        if not sessions and timeframe:
            session_aggregator.aggregate_events(timeframe=timeframe)
            sessions = workstream_store.get_work_sessions(
                timeframe=timeframe,
                project=project,
                file=file,
                domain=domain,
                topic=topic,
                limit=limit,
            )

        if not sessions:
            filter_desc = []
            if timeframe: filter_desc.append(f"timeframe='{timeframe}'")
            if project: filter_desc.append(f"project='{project}'")
            if topic: filter_desc.append(f"topic='{topic}'")
            desc_str = ", ".join(filter_desc) if filter_desc else "given criteria"
            return f"No work sessions found for {desc_str}."

        lines = [f"Found {len(sessions)} work session(s) ({timeframe or 'recent'}):"]
        for s in sessions:
            title = s.get("title", "Untitled Session")
            start = s.get("start_time", "")
            end = s.get("end_time", "")
            dur_fmt = s.get("duration_formatted", "")
            proj = s.get("project") or "General"
            summary = s.get("summary", "")

            try:
                dt_start = datetime.fromisoformat(start.replace("Z", "+00:00"))
                dt_end = datetime.fromisoformat(end.replace("Z", "+00:00"))
                time_range = f"{dt_start.strftime('%H:%M')}–{dt_end.strftime('%H:%M')}"
            except Exception:
                time_range = f"{start} to {end}"

            lines.append(f"\n### {time_range} — {title}")
            lines.append(f"- **Project**: {proj} | **Duration**: {dur_fmt} | **Events**: {s.get('event_count', 0)}")
            lines.append(f"- **Summary**: {summary}")

            files = s.get("files", [])
            if files:
                lines.append(f"- **Files**: {', '.join(files[:6])}")

            domains = s.get("domains", [])
            if domains:
                lines.append(f"- **Domains**: {', '.join(domains[:5])}")

            cmds = s.get("commands", [])
            if cmds:
                clean_cmds = [c if isinstance(c, str) else c.get("command", "") for c in cmds if c]
                clean_cmds = [c for c in clean_cmds if c]
                if clean_cmds:
                    lines.append(f"- **Commands**: {', '.join(clean_cmds[:4])}")

        return "\n".join(lines)
    except Exception as e:
        logger.exception("Failed to execute get_work_sessions: %s", e)
        return f"Error retrieving work sessions: {e}"


def get_last_work_session_func(project: Optional[str] = None) -> str:
    """Retrieves the latest work session for continuing work or answering 'what was I doing?'."""
    try:
        # Always prefer the latest finalized session
        sess = workstream_store.get_latest_work_session(project=project, finalized_only=True)
        if not sess:
            session_aggregator.aggregate_events(timeframe="today")
            sess = workstream_store.get_latest_work_session(project=project, finalized_only=True)

        if not sess:
            # Fallback to any session if no finalized session exists yet
            sess = workstream_store.get_latest_work_session(project=project, finalized_only=False)

        if not sess:
            return f"No previous work sessions recorded{' for project ' + project if project else ''}."

        title = sess.get("title", "Untitled Session")
        start = sess.get("start_time", "")
        end = sess.get("end_time", "")
        dur_fmt = sess.get("duration_formatted", "")
        proj = sess.get("project") or "General"
        summary = sess.get("summary", "")

        try:
            dt_start = datetime.fromisoformat(start.replace("Z", "+00:00"))
            dt_end = datetime.fromisoformat(end.replace("Z", "+00:00"))
            time_range = f"{dt_start.strftime('%Y-%m-%d %H:%M')}–{dt_end.strftime('%H:%M')}"
        except Exception:
            time_range = f"{start} to {end}"

        # Check for deep semantic understanding (Phase 4.1)
        und = sess.get("understanding")
        meta = sess.get("metadata", {})
        if not und:
            try:
                from app.workstream.models import WorkSession
                from app.workstream.semantic_understanding import semantic_understanding_engine
                dummy_ws = WorkSession(
                    title=title,
                    summary=summary,
                    project=proj,
                    start_time=start or datetime.now(timezone.utc).isoformat(),
                    end_time=end or datetime.now(timezone.utc).isoformat(),
                    duration_seconds=float(sess.get("duration_seconds") or 0.0),
                    files=sess.get("files", []),
                    domains=sess.get("domains", []),
                    commands=sess.get("commands", []),
                    topics=sess.get("topics", []),
                    primary_apps=sess.get("primary_apps", []),
                    metadata=meta,
                )
                extracted_und = semantic_understanding_engine.infer_session_understanding(dummy_ws)
                und = extracted_und.model_dump()
            except Exception:
                und = None

        if und:
            task = und.get("task", title)
            goal = und.get("goal")
            problem = und.get("problem")
            status_desc = und.get("status", "completed").capitalize()
            progress_desc = und.get("progress")
            techs = und.get("technologies", [])
            unresolved = und.get("unresolved_issues", [])

            lines = [
                f"### Last Work Session: {task}",
                f"- **Time**: {time_range} ({dur_fmt}) | **Project**: {proj} | **Status**: {status_desc}",
                f"- **Summary**: {summary}",
            ]
            if goal:
                lines.append(f"- **Objective / Goal**: {goal}")
            if problem:
                lines.append(f"- **Problem Investigated**: {problem}")
            if progress_desc:
                lines.append(f"- **Recent Progress**: {progress_desc}")
            if techs:
                lines.append(f"- **Technologies**: {', '.join(techs[:6])}")
        else:
            lines = [
                f"### Last Work Session: {title}",
                f"- **Time**: {time_range} ({dur_fmt})",
                f"- **Project**: {proj}",
                f"- **Summary**: {summary}",
            ]

        branch = meta.get("git_branch") or (meta.get("git_branches", [None])[0] if meta.get("git_branches") else None)
        if branch:
            lines.append(f"- **Git Branch**: `{branch}`")

        files = sess.get("files", [])
        if files:
            lines.append(f"- **Key Files**: {', '.join(files[:8])}")

        cmds = sess.get("commands", [])
        if cmds:
            cmd_strs = []
            for c in cmds[-4:]:
                if isinstance(c, str):
                    cmd_strs.append(f"`{c}`")
                elif isinstance(c, dict):
                    cmd_line = c.get("command", "")
                    st = c.get("status", "")
                    if st == "interrupted":
                        cmd_line += " (interrupted)"
                    elif c.get("exit_code") and c.get("exit_code") != 0:
                        cmd_line += f" (failed code {c.get('exit_code')})"
                    if cmd_line:
                        cmd_strs.append(f"`{cmd_line}`")
            if cmd_strs:
                lines.append(f"- **Recent Terminal Commands**: {', '.join(cmd_strs)}")

        if und and und.get("unresolved_issues"):
            lines.append("\n**Unresolved Issues & Next Steps**:")
            for issue in und["unresolved_issues"][:3]:
                lines.append(f"- {issue}")

        if und and und.get("problem"):
            lines.append(f"\n**Resume Hint**: You were working on {und['problem']}. Check the key files and unresolved issues above to continue.")
        else:
            lines.append("\n**Resume Hint**: You can resume this session by opening these files and checking the recent commands above.")
        return "\n".join(lines)
    except Exception as e:
        logger.exception("Failed to execute get_last_work_session: %s", e)
        return f"Error retrieving last work session: {e}"


# --- Structured Tools Export ---

get_work_summary_tool = StructuredTool.from_function(
    func=get_work_summary_func,
    name="get_work_summary",
    description=(
        "Summarize what the user worked on or what activities took place during a specific timeframe "
        "(e.g., 'yesterday', 'today', 'this morning', 'last 2 hours', 'last 7 days', or 'YYYY-MM-DD'). "
        "Provides total active time, application usage breakdown, top window titles/files edited, terminal activity (commands executed, running commands, interrupted commands, last test run), and clipboard snippets."
    ),
    args_schema=GetWorkSummaryInput,
)

get_activity_timeline_tool = StructuredTool.from_function(
    func=get_activity_timeline_func,
    name="get_activity_timeline",
    description=(
        "Retrieve a detailed chronological sequence of desktop window switches, terminal commands, and tasks over a given timeframe. "
        "Useful for understanding the step-by-step order of what the user was doing (e.g. 'what did I do before tests started failing?'), "
        "or finding when a file, app, or command was active."
    ),
    args_schema=GetActivityTimelineInput,
)

search_activity_tool = StructuredTool.from_function(
    func=search_activity_func,
    name="search_activity",
    description=(
        "Search through past desktop activity, window titles, documents, web pages visited, executed terminal commands, and copied clipboard snippets. "
        "Use this when the user asks 'what commands did I run?', 'what was the last test I ran?', 'what project was I working on in the terminal?', "
        "'what was that article I read?', 'find the function I was editing earlier', or 'explain the code I just copied'."
    ),
    args_schema=SearchActivityInput,
)

get_terminal_history_tool = StructuredTool.from_function(
    func=get_terminal_history_func,
    name="get_terminal_history",
    description=(
        "Retrieve executed terminal and shell commands from PowerShell, CMD, and Git Bash, including interrupted commands (e.g., Ctrl+C) and currently running processes. "
        "Use this tool when the user asks: "
        "'what was the last terminal command I ran?', 'what commands did I run while working on Rie today?', 'what was the last test I ran?', "
        "'what did I do before the tests started failing?', 'what project was I working on in the terminal?', "
        "or asks to inspect executed shell commands and their exit codes/durations."
    ),
    args_schema=GetTerminalHistoryInput,
)

get_running_terminal_commands_tool = StructuredTool.from_function(
    func=get_running_terminal_commands_func,
    name="get_running_terminal_commands",
    description=(
        "Retrieve terminal commands and processes that are currently running / executing in PowerShell, CMD, or Git Bash. "
        "Use this tool when the user asks: 'what command is running in the terminal right now?', 'are any tests or servers running?', "
        "or 'what processes are currently running in my shells?'."
    ),
    args_schema=GetRunningTerminalCommandsInput,
)

get_work_sessions_tool = StructuredTool.from_function(
    func=get_work_sessions_func,
    name="get_work_sessions",
    description=(
        "Retrieve high-level semantic work sessions clustered from raw desktop, browser, IDE, clipboard, and terminal events. "
        "Use this tool when the user asks: "
        "'what was I working on yesterday?', 'what was I doing when I worked on Workstream?', "
        "'what did I do this morning?', or 'when did I last work on the terminal tracking feature?'."
    ),
    args_schema=GetWorkSessionsInput,
)

get_last_work_session_tool = StructuredTool.from_function(
    func=get_last_work_session_func,
    name="get_last_work_session",
    description=(
        "Retrieve the user's most recent work session, including active project, git branch, modified files, terminal commands, and narrative summary. "
        "Use this tool when the user asks: "
        "'continue what I was doing yesterday', 'where did I leave off?', 'continue my work', "
        "or asks what they were doing just before they stepped away."
    ),
    args_schema=GetLastWorkSessionInput,
)

WORKSTREAM_TOOLS = {
    "get_work_summary": get_work_summary_tool,
    "get_activity_timeline": get_activity_timeline_tool,
    "search_activity": search_activity_tool,
    "get_terminal_history": get_terminal_history_tool,
    "get_running_terminal_commands": get_running_terminal_commands_tool,
    "get_work_sessions": get_work_sessions_tool,
    "get_last_work_session": get_last_work_session_tool,
}

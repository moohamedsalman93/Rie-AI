"""
Rie-AI Workstream Engine
Native desktop activity collector, SQLite+FTS5 store, and agent tools.
"""
from app.workstream.models import (
    ActivityEvent,
    BrowserEvent,
    IDEEvent,
    TerminalEvent,
    ClipboardEvent,
    BatchEventsRequest,
    WorkstreamPolicy,
    SensorConfig,
    PrivacyConfig,
    MemoryConfig,
    WorkstreamConfig,
    WorkSession,
    AggregateSessionsRequest,
    SessionFilterRequest,
)
from app.workstream.store import workstream_store, WorkstreamStore
from app.workstream.search import workstream_search, WorkstreamSearch, parse_timeframe
from app.workstream.session_aggregator import session_aggregator, SessionAggregator
from app.workstream.tools import (
    WORKSTREAM_TOOLS,
    get_work_summary_tool,
    get_activity_timeline_tool,
    search_activity_tool,
    get_terminal_history_tool,
    get_running_terminal_commands_tool,
    get_work_sessions_tool,
    get_last_work_session_tool,
)

__all__ = [
    "ActivityEvent",
    "BrowserEvent",
    "IDEEvent",
    "TerminalEvent",
    "ClipboardEvent",
    "BatchEventsRequest",
    "WorkstreamPolicy",
    "SensorConfig",
    "PrivacyConfig",
    "MemoryConfig",
    "WorkstreamConfig",
    "WorkSession",
    "AggregateSessionsRequest",
    "SessionFilterRequest",
    "workstream_store",
    "WorkstreamStore",
    "workstream_search",
    "WorkstreamSearch",
    "parse_timeframe",
    "session_aggregator",
    "SessionAggregator",
    "WORKSTREAM_TOOLS",
    "get_work_summary_tool",
    "get_activity_timeline_tool",
    "search_activity_tool",
    "get_terminal_history_tool",
    "get_running_terminal_commands_tool",
    "get_work_sessions_tool",
    "get_last_work_session_tool",
]


"""
LangChain StructuredTools for the Rie System Intelligence Subsystem.
Exposes capability inspection, safe self-configuration, rollback, and correlated diagnostics.
"""
import json
from typing import Optional, Literal, Dict, Any
from langchain_core.tools import tool, StructuredTool
from pydantic import BaseModel, Field

from app.system_intelligence.capability_registry import capability_registry
from app.system_intelligence.config_manager import config_manager
from app.system_intelligence.log_diagnostics import log_diagnostics_engine
from app.system_intelligence.correlation_engine import correlation_engine


# --- Tool Input Schemas ---

class SystemStatusInput(BaseModel):
    category: Optional[Literal["all", "builtin", "tools", "search", "browser", "plugins", "mcp"]] = Field(
        default="all",
        description="Filter capabilities by category: 'all', 'tools', 'search', 'browser', 'plugins', or 'mcp'."
    )


class ModifySettingInput(BaseModel):
    key: str = Field(
        ...,
        description=(
            "The setting key to modify. Tier 1 autonomous keys include: "
            "'SPEED_MODE' ('thinking'|'flash'), 'CHAT_MODE' ('agent'|'chat'), "
            "'AGENT_ORCHESTRATION_MODE' ('solo'|'team'), 'CAMOFOX_HEADLESS_MODE' ('headless'|'normal'|'auto'), "
            "'WEB_SEARCH_PROVIDER' ('tavily'|'brave'|'duckduckgo'), 'FLOATING_CHAT_OPACITY' (0.1-1.0), "
            "'SHOW_BUBBLE' ('true'|'false'), 'WINDOW_MODE' ('floating'|'normal'). "
            "Tier 2 keys ('HITL_MODE', API keys, etc.) require prior user confirmation via ask_question."
        ),
    )
    value: Any = Field(..., description="The new value for the setting.")
    reason: Optional[str] = Field(None, description="Brief justification for why this setting is being modified.")
    confirmed_by_user: bool = Field(
        default=False,
        description="Set to True only if the user explicitly confirmed a Tier 2 security-sensitive change via ask_question.",
    )


class RollbackSettingInput(BaseModel):
    key: Optional[str] = Field(None, description="The setting key to revert to its previous value (e.g. 'SPEED_MODE').")
    transaction_id: Optional[str] = Field(None, description="Specific transaction ID to rollback from the transaction journal.")


class ToggleToolInput(BaseModel):
    tool_name: str = Field(..., description="Name of the tool to enable or disable (e.g. 'run_terminal_command', 'mouse_click').")
    enabled: bool = Field(..., description="True to enable the tool, False to disable it.")


class ReadLogsInput(BaseModel):
    lines: int = Field(default=80, ge=5, le=300, description="Number of recent log lines to retrieve (between 5 and 300).")
    level: Optional[Literal["ALL", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]] = Field(
        default="ALL",
        description="Filter lines by minimum severity level. Default is 'ALL'."
    )
    search_query: Optional[str] = Field(None, description="Optional case-insensitive substring or regex to filter log lines.")
    tail: bool = Field(default=True, description="True to return the newest lines; False for earliest lines.")


class DiagnoseErrorsInput(BaseModel):
    window_minutes: int = Field(default=15, ge=1, le=120, description="Time window in minutes to scan for recent error spikes (default 15).")


class GetRecentEventsInput(BaseModel):
    thread_id: Optional[str] = Field(None, description="Optional chat thread ID to filter task events.")
    limit: int = Field(default=20, ge=1, le=50, description="Maximum number of events to retrieve (default 20).")


# --- Tool Implementation Functions ---

def _get_system_status(category: str = "all") -> str:
    """Inspects modes, 5-state capabilities, active providers, and diagnostics."""
    report = capability_registry.get_system_status(category=category)
    
    # Format a clean, human-readable summary for the LLM
    output = [
        f"### Rie System Status ({report.timestamp})",
        "",
        "**Active Operational Modes:**",
        f"- Chat Mode: `{report.active_modes.get('chat_mode')}`",
        f"- Speed Mode: `{report.active_modes.get('speed_mode')}`",
        f"- Orchestration Mode: `{report.active_modes.get('orchestration_mode')}`",
        f"- HITL Mode: `{report.active_modes.get('hitl_mode')}`",
        f"- Window Mode: `{report.active_modes.get('window_mode')}`",
        "",
        "**LLM & Search Providers:**",
        f"- Primary Provider: `{report.providers.get('primary_provider')}` ({report.providers.get('primary_model')}) -> **{report.providers.get('primary_state')}**",
    ]
    if report.providers.get("primary_hint"):
        output.append(f"  *Hint: {report.providers.get('primary_hint')}*")
    output.append(f"- Fallback Provider: `{report.providers.get('fallback_provider')}`")
    
    output.extend([
        "",
        f"**Capabilities ({len(report.capabilities)} registered):**",
    ])
    
    for cap in report.capabilities:
        status_marker = "🟢" if cap.state == "ENABLED" else ("🟡" if cap.state in ("DISABLED", "NOT_CONFIGURED") else "🔴")
        line = f"- {status_marker} **`{cap.name}`** [{cap.category}] -> `{cap.state}`: {cap.description}"
        if cap.resolution_hint:
            line += f" *(Hint: {cap.resolution_hint})*"
        output.append(line)
        
    output.extend([
        "",
        "**Diagnostics:**",
        f"- Log File: `{report.diagnostic_summary.get('log_file')}` (Exists: {report.diagnostic_summary.get('log_file_exists')}, Size: {report.diagnostic_summary.get('log_size_bytes')} bytes)",
    ])
    return "\n".join(output)


def _modify_system_setting(
    key: str,
    value: Any,
    reason: Optional[str] = None,
    confirmed_by_user: bool = False,
) -> str:
    """Modifies an operational setting with permission validation and auto-rollback."""
    res = config_manager.modify_setting(
        key=key,
        value=value,
        reason=reason,
        author="rie",
        confirmed_by_user=confirmed_by_user,
    )
    if res.get("status") == "success":
        return f"Successfully modified setting '{res.get('key')}' to '{res.get('new_value')}'. (Tx: {res.get('transaction_id')})"
    elif res.get("status") == "approval_required":
        return f"APPROVAL REQUIRED: {res.get('message')}"
    elif res.get("status") == "rolled_back":
        return f"WARNING: Change was rolled back! {res.get('message')}"
    else:
        return f"Error modifying setting '{key}': {res.get('message')}"


def _rollback_system_setting(
    key: Optional[str] = None,
    transaction_id: Optional[str] = None,
) -> str:
    """Reverts a setting to its previous value from the transaction journal."""
    res = config_manager.rollback_setting(transaction_id=transaction_id, key=key)
    if res.get("status") == "success":
        return f"Successfully rolled back '{res.get('key')}' to previous value '{res.get('restored_value')}'. (Tx: {res.get('transaction_id')})"
    else:
        return f"Rollback failed: {res.get('message')}"


def _toggle_tool(tool_name: str, enabled: bool) -> str:
    """Enables or disables a specific tool with safety protections."""
    res = config_manager.toggle_tool(tool_name=tool_name, enabled=enabled)
    if res.get("status") == "success":
        return res.get("message")
    else:
        return f"Failed to toggle tool: {res.get('message')}"


def _read_system_logs(
    lines: int = 80,
    level: str = "ALL",
    search_query: Optional[str] = None,
    tail: bool = True,
) -> str:
    """Reads backend logs with secret redaction and level filtering."""
    res = log_diagnostics_engine.read_logs(
        lines=lines,
        level=level,
        search_query=search_query,
        tail=tail,
    )
    if res.get("status") != "success":
        return res.get("content", "Error reading logs.")
    
    header = f"=== Backend Logs ({res.get('lines_returned')} lines returned, total scanned: {res.get('total_scanned')}) ==="
    trunc_note = " *(Output truncated to max size ceiling)*" if res.get("truncated") else ""
    return f"{header}{trunc_note}\n\n{res.get('content')}"


def _diagnose_system_errors(window_minutes: int = 15) -> str:
    """Aggregates recent error spikes and failing components."""
    summary = log_diagnostics_engine.diagnose_errors(window_minutes=window_minutes)
    
    output = [
        f"### System Diagnostic Summary (Past {window_minutes} Minutes)",
        f"- Log File: `{summary.log_file_path}`",
        f"- Total Lines Evaluated: {summary.total_lines_scanned}",
        f"- Errors Detected: **{summary.error_count}**",
        f"- Warnings Detected: **{summary.warning_count}**",
    ]
    if summary.top_failing_components:
        output.append("\n**Top Failing Components:**")
        for comp, count in summary.top_failing_components.items():
            output.append(f"- `{comp}`: {count} errors")
            
    if summary.recent_errors:
        output.append("\n**Recent Error Entries:**")
        for err in summary.recent_errors[-10:]:
            output.append(f"- {err}")
    else:
        output.append("\n*No recent errors recorded in this time window.*")
        
    return "\n".join(output)


def _get_recent_task_events(
    thread_id: Optional[str] = None,
    limit: int = 20,
) -> str:
    """Inspects recent task executions and tool calls from trajectory database."""
    events = correlation_engine.get_recent_task_events(thread_id=thread_id, limit=limit)
    if not events:
        return "No recent task events found in trajectory database."
    
    output = [f"### Recent Task Events ({len(events)} events):"]
    for ev in events:
        status_icon = "❌" if ev.get("status") in ("failed", "error") else "✅"
        line = f"- {status_icon} [{ev.get('timestamp')}] Turn: `{ev.get('thread_id')}` | Event: `{ev.get('event_type')}` | Status: `{ev.get('status')}`"
        if ev.get("error_message"):
            line += f" | Error: {ev.get('error_message')}"
        output.append(line)
        
    return "\n".join(output)


# --- Structured Tools Construction ---

get_system_status = StructuredTool.from_function(
    func=_get_system_status,
    name="get_system_status",
    description="Inspect operational modes, health states of all capabilities (ENABLED, DISABLED, NOT_CONFIGURED, UNAVAILABLE, ERROR), and diagnostic summaries.",
    args_schema=SystemStatusInput,
)

modify_system_setting = StructuredTool.from_function(
    func=_modify_system_setting,
    name="modify_system_setting",
    description="Autonomously update operational settings (SPEED_MODE, CHAT_MODE, WEB_SEARCH_PROVIDER, CAMOFOX_HEADLESS_MODE, etc.) with pre-flight checks and rollback.",
    args_schema=ModifySettingInput,
)

rollback_system_setting = StructuredTool.from_function(
    func=_rollback_system_setting,
    name="rollback_system_setting",
    description="Revert a setting to its previous value using the transaction journal if an error occurred.",
    args_schema=RollbackSettingInput,
)

toggle_tool = StructuredTool.from_function(
    func=_toggle_tool,
    name="toggle_tool",
    description="Enable or disable a specific tool dynamically (immutable core tools cannot be disabled).",
    args_schema=ToggleToolInput,
)

read_system_logs = StructuredTool.from_function(
    func=_read_system_logs,
    name="read_system_logs",
    description="Read recent backend logs with severity filtering, keyword search, and secret redaction.",
    args_schema=ReadLogsInput,
)

diagnose_system_errors = StructuredTool.from_function(
    func=_diagnose_system_errors,
    name="diagnose_system_errors",
    description="Timestamp-aware error aggregation and diagnostic summary for recent system failures.",
    args_schema=DiagnoseErrorsInput,
)

get_recent_task_events = StructuredTool.from_function(
    func=_get_recent_task_events,
    name="get_recent_task_events",
    description="Retrieve recent task execution events, tool calls, and error categories from trajectory ledger.",
    args_schema=GetRecentEventsInput,
)

SYSTEM_INTELLIGENCE_TOOLS = [
    get_system_status,
    modify_system_setting,
    rollback_system_setting,
    toggle_tool,
    read_system_logs,
    diagnose_system_errors,
    get_recent_task_events,
]


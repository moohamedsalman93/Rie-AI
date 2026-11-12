"""
Data models and Enums for the Rie System Intelligence Subsystem.
"""
from enum import Enum
from datetime import datetime
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field


class CapabilityState(str, Enum):
    """5-State capability health assessment"""
    ENABLED = "ENABLED"                   # Healthy, configured, credentials valid, ready to execute
    DISABLED = "DISABLED"                 # Explicitly toggled off by user or policy
    NOT_CONFIGURED = "NOT_CONFIGURED"     # Feature available, but required API key/token missing
    UNAVAILABLE = "UNAVAILABLE"           # Host dependency missing (binary missing, service offline)
    ERROR = "ERROR"                       # Subprocess crashed or runtime initialization failed


class SettingTier(str, Enum):
    """Two-tier permission classification for self-configuration"""
    TIER_1_AUTONOMOUS = "autonomous"      # Safe to change autonomously (modes, speeds, UI, search provider)
    TIER_2_APPROVAL = "approval_required" # Sensitive: API keys, HITL downgrade, network tunnels, security


class CapabilityReport(BaseModel):
    """Status report for a single tool, provider, or integration capability"""
    name: str
    category: str                         # builtin, browser, desktop, mcp, plugin, provider, sensor
    state: CapabilityState
    description: str = ""
    resolution_hint: Optional[str] = None # Actionable guide to fix non-ENABLED state
    metadata: Dict[str, Any] = Field(default_factory=dict)


class SystemStatusReport(BaseModel):
    """Comprehensive system capability and health report"""
    timestamp: str
    active_modes: Dict[str, str]          # chat_mode, speed_mode, orchestration_mode, hitl_mode
    capabilities: List[CapabilityReport]
    providers: Dict[str, Any]             # primary, fallback, model names, readiness
    diagnostic_summary: Dict[str, Any]    # log path, recent error count, log size


class SettingTransaction(BaseModel):
    """Audit record for a configuration change with rollback support"""
    transaction_id: str
    timestamp: str
    key: str
    old_value: Optional[str] = None
    new_value: str
    reason: Optional[str] = None
    author: Literal["rie", "user"] = "rie"
    tier: SettingTier = SettingTier.TIER_1_AUTONOMOUS
    status: Literal["committed", "rolled_back", "failed"] = "committed"


class CorrelatedDiagnostic(BaseModel):
    """Diagnostic correlation connecting turns, tools, trajectory events, and backend logs"""
    turn_id: Optional[str] = None
    tool_call_id: Optional[str] = None
    tool_name: Optional[str] = None
    error_category: Optional[str] = None
    timestamp: str
    matched_logs: List[str] = Field(default_factory=list)
    root_cause: str
    recommended_action: str
    can_auto_heal: bool = False
    remediation_applied: Optional[str] = None


class LogDiagnosticSummary(BaseModel):
    """Summary of recent log activity, error counts, and failing components"""
    log_file_path: str
    total_lines_scanned: int
    error_count: int
    warning_count: int
    time_window_minutes: int
    top_failing_components: Dict[str, int] = Field(default_factory=dict)
    recent_errors: List[str] = Field(default_factory=list)


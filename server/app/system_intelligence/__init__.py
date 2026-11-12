"""
Rie System Intelligence Subsystem.
Provides capability awareness, safe self-configuration, transactional rollback,
and correlated log diagnostics.
"""
from app.system_intelligence.models import (
    CapabilityState,
    SettingTier,
    CapabilityReport,
    SystemStatusReport,
    SettingTransaction,
    CorrelatedDiagnostic,
    LogDiagnosticSummary,
)
from app.system_intelligence.capability_registry import capability_registry, CapabilityRegistry
from app.system_intelligence.config_manager import config_manager, ConfigManager
from app.system_intelligence.log_diagnostics import log_diagnostics_engine, LogDiagnosticsEngine
from app.system_intelligence.correlation_engine import correlation_engine, CorrelationEngine
from app.system_intelligence.tools import (
    SYSTEM_INTELLIGENCE_TOOLS,
    get_system_status,
    modify_system_setting,
    rollback_system_setting,
    toggle_tool,
    read_system_logs,
    diagnose_system_errors,
    get_recent_task_events,
)

__all__ = [
    "CapabilityState",
    "SettingTier",
    "CapabilityReport",
    "SystemStatusReport",
    "SettingTransaction",
    "CorrelatedDiagnostic",
    "LogDiagnosticSummary",
    "capability_registry",
    "CapabilityRegistry",
    "config_manager",
    "ConfigManager",
    "log_diagnostics_engine",
    "LogDiagnosticsEngine",
    "correlation_engine",
    "CorrelationEngine",
    "SYSTEM_INTELLIGENCE_TOOLS",
    "get_system_status",
    "modify_system_setting",
    "rollback_system_setting",
    "toggle_tool",
    "read_system_logs",
    "diagnose_system_errors",
    "get_recent_task_events",
]


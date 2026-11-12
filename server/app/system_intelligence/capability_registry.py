"""
Capability Registry and 5-State Health Engine for Rie System Intelligence.
Evaluates: ENABLED, DISABLED, NOT_CONFIGURED, UNAVAILABLE, and ERROR.
"""
import os
import sys
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, List, Dict, Any, Set

from app.config import settings
from app.database import list_plugin_integrations, get_setting
from app.system_intelligence.models import (
    CapabilityState,
    CapabilityReport,
    SystemStatusReport,
)

logger = logging.getLogger(__name__)

# Core tools that can never be disabled (immutable safety and diagnostics)
IMMUTABLE_CORE_TOOLS: Set[str] = {
    "get_system_status",
    "modify_system_setting",
    "rollback_system_setting",
    "toggle_tool",
    "read_system_logs",
    "diagnose_system_errors",
    "get_recent_task_events",
    "ask_question",
}

# Standard catalog of built-in tools in Rie
KNOWN_BUILTIN_TOOLS: Dict[str, Dict[str, str]] = {
    "get_system_status": {
        "category": "system",
        "description": "Inspects operational modes, health states of all capabilities, and diagnostics.",
    },
    "modify_system_setting": {
        "category": "system",
        "description": "Autonomously updates operational settings with validation and rollback.",
    },
    "rollback_system_setting": {
        "category": "system",
        "description": "Reverts a setting to its previous value from the transaction journal.",
    },
    "toggle_tool": {
        "category": "system",
        "description": "Enables or disables a specific tool dynamically.",
    },
    "read_system_logs": {
        "category": "diagnostics",
        "description": "Bounded reader for backend logs with severity and regex filtering.",
    },
    "diagnose_system_errors": {
        "category": "diagnostics",
        "description": "Timestamp-aware error aggregation and root-cause analysis.",
    },
    "get_recent_task_events": {
        "category": "diagnostics",
        "description": "Inspects recent task executions and tool calls from trajectory database.",
    },
    "internet_search": {
        "category": "search",
        "description": "Searches the web via Tavily, Brave, or DuckDuckGo.",
    },
    "ask_question": {
        "category": "interaction",
        "description": "Prompts user with structured multiple-choice questions or confirmations.",
    },
    "render_ui": {
        "category": "interaction",
        "description": "Renders interactive UI widgets in the chat view.",
    },
    "read_knowledge_asset": {
        "category": "knowledge",
        "description": "Reads uploaded or pre-loaded reference assets.",
    },
    "load_skill": {
        "category": "skills",
        "description": "Dynamically activates on-demand specialized procedural skills.",
    },
    "run_terminal_command": {
        "category": "system",
        "description": "Runs native PowerShell or host terminal commands.",
    },
    "schedule_chat_task": {
        "category": "scheduler",
        "description": "Schedules reminders and automated recurring chat tasks.",
    },
    "list_scheduled_tasks": {
        "category": "scheduler",
        "description": "Lists all scheduled cron or one-shot background tasks.",
    },
    "update_scheduled_task": {
        "category": "scheduler",
        "description": "Modifies an existing scheduled task trigger.",
    },
    "cancel_scheduled_task": {
        "category": "scheduler",
        "description": "Cancels an active scheduled task.",
    },
    "save_memory": {
        "category": "memory",
        "description": "Stores facts, preferences, and knowledge in Long-Term Memory.",
    },
    "search_memory": {
        "category": "memory",
        "description": "Semantic search across stored long-term memories.",
    },
    "get_memory": {
        "category": "memory",
        "description": "Retrieves specific memory by key or ID.",
    },
    "delete_memory": {
        "category": "memory",
        "description": "Removes a specific memory entry.",
    },
    "get_work_summary": {
        "category": "workstream",
        "description": "Generates summary of user work activity and context timeline.",
    },
    "get_activity_timeline": {
        "category": "workstream",
        "description": "Queries historical user interactions and application switches.",
    },
    "search_activity": {
        "category": "workstream",
        "description": "Searches past screen, clipboard, and window activity events.",
    },
    "get_terminal_history": {
        "category": "workstream",
        "description": "Queries terminal commands and session outputs.",
    },
    "browser_open": {
        "category": "browser",
        "description": "Opens a URL in the automated Camoufox browser session.",
    },
    "browser_snapshot": {
        "category": "browser",
        "description": "Captures DOM tree and interactive element refs of current web page.",
    },
    "browser_click": {
        "category": "browser",
        "description": "Simulates click on web page element.",
    },
    "browser_type": {
        "category": "browser",
        "description": "Types text into web form input.",
    },
    "browser_navigate": {
        "category": "browser",
        "description": "Navigates browser forward, back, or reloads.",
    },
    "browser_scroll": {
        "category": "browser",
        "description": "Scrolls active web page up or down.",
    },
    "browser_tabs": {
        "category": "browser",
        "description": "Lists or switches browser tabs.",
    },
    "browser_extract": {
        "category": "browser",
        "description": "Extracts text content or markdown from web page.",
    },
    "browser_close": {
        "category": "browser",
        "description": "Closes the automated browser session.",
    },
    "get_desktop_state": {
        "category": "desktop",
        "description": "Inspects native Windows active window and UI accessibility tree.",
    },
    "app_control": {
        "category": "desktop",
        "description": "Launches, focuses, or closes desktop applications.",
    },
    "mouse_click": {
        "category": "desktop",
        "description": "Simulates native desktop mouse clicks.",
    },
    "keyboard_type": {
        "category": "desktop",
        "description": "Types text or sends hotkeys to active desktop window.",
    },
}


class CapabilityRegistry:
    """Evaluates real-time 5-state health of all system capabilities"""

    def evaluate_builtin_tools(self) -> List[CapabilityReport]:
        """Evaluate built-in tools based on ENABLED_TOOLS toggle list"""
        enabled_tools = settings.ENABLED_TOOLS
        reports: List[CapabilityReport] = []

        for name, meta in KNOWN_BUILTIN_TOOLS.items():
            if name in IMMUTABLE_CORE_TOOLS:
                state = CapabilityState.ENABLED
                hint = "Core diagnostic/safety tool (immutable)."
            elif enabled_tools is not None and name not in enabled_tools:
                state = CapabilityState.DISABLED
                hint = f"Tool is disabled in ENABLED_TOOLS. Enable via toggle_tool('{name}', True)."
            else:
                state = CapabilityState.ENABLED
                hint = None

            reports.append(
                CapabilityReport(
                    name=name,
                    category=meta["category"],
                    state=state,
                    description=meta["description"],
                    resolution_hint=hint,
                )
            )
        return reports

    def evaluate_web_search(self) -> List[CapabilityReport]:
        """Evaluate web search providers (Tavily, Brave, DuckDuckGo)"""
        active_provider = settings.WEB_SEARCH_PROVIDER
        reports: List[CapabilityReport] = []

        # Tavily
        tavily_has_key = bool(settings.TAVILY_API_KEY)
        t_state = CapabilityState.ENABLED if tavily_has_key else CapabilityState.NOT_CONFIGURED
        reports.append(
            CapabilityReport(
                name="search_tavily",
                category="search_provider",
                state=t_state,
                description="Tavily AI Search Engine (optimized for LLM agent research).",
                resolution_hint=None if tavily_has_key else "Set TAVILY_API_KEY in settings to enable Tavily search.",
                metadata={"is_active": active_provider == "tavily", "has_key": tavily_has_key},
            )
        )

        # Brave
        brave_has_key = bool(settings.BRAVE_SEARCH_API_KEY)
        b_state = CapabilityState.ENABLED if brave_has_key else CapabilityState.NOT_CONFIGURED
        reports.append(
            CapabilityReport(
                name="search_brave",
                category="search_provider",
                state=b_state,
                description="Brave Search API for independent web indexing.",
                resolution_hint=None if brave_has_key else "Set BRAVE_SEARCH_API_KEY in settings to enable Brave search.",
                metadata={"is_active": active_provider == "brave", "has_key": brave_has_key},
            )
        )

        # DuckDuckGo
        reports.append(
            CapabilityReport(
                name="search_duckduckgo",
                category="search_provider",
                state=CapabilityState.ENABLED,
                description="DuckDuckGo Search (no API key required, rate-limited fallback).",
                resolution_hint=None,
                metadata={"is_active": active_provider == "duckduckgo", "has_key": True},
            )
        )
        return reports

    def evaluate_browser_engine(self) -> CapabilityReport:
        """Evaluate Camoufox anti-detect browser capability"""
        headless_mode = settings.CAMOFOX_HEADLESS_MODE
        
        # Check if browser binary directory or archive exists
        browser_dir = Path(__file__).parent.parent.parent / "camoufox_browser"
        archive_path = Path(__file__).parent.parent.parent / "camoufox.zip"
        
        if browser_dir.exists() or archive_path.exists():
            state = CapabilityState.ENABLED
            hint = None
        else:
            state = CapabilityState.UNAVAILABLE
            hint = "Camoufox browser binary not found in server root. Extract or download camoufox."

        return CapabilityReport(
            name="browser_engine_camoufox",
            category="browser",
            state=state,
            description="Anti-detect Firefox-based browser automation engine.",
            resolution_hint=hint,
            metadata={"headless_mode": headless_mode, "binary_dir_exists": browser_dir.exists()},
        )

    def evaluate_plugin_integrations(self) -> List[CapabilityReport]:
        """Evaluate 3rd-party connectors (Gmail, GitHub, Jira)"""
        reports: List[CapabilityReport] = []
        try:
            records = list_plugin_integrations()
            known_plugins = {"gmail": "Gmail Integration", "github": "GitHub Integration", "jira": "Jira Integration"}
            found_ids = set()

            for rec in records:
                p_id = rec.get("plugin_id")
                found_ids.add(p_id)
                status = rec.get("status", "disconnected")
                has_creds = bool(rec.get("encrypted_credentials"))

                if status == "connected" and has_creds:
                    state = CapabilityState.ENABLED
                    hint = None
                else:
                    state = CapabilityState.NOT_CONFIGURED
                    hint = f"Connect {p_id} via Settings -> Connectors."

                reports.append(
                    CapabilityReport(
                        name=f"plugin_{p_id}",
                        category="plugin",
                        state=state,
                        description=known_plugins.get(p_id, f"Plugin {p_id}"),
                        resolution_hint=hint,
                        metadata={"status": status, "plugin_id": p_id},
                    )
                )

            for missing_id, desc in known_plugins.items():
                if missing_id not in found_ids:
                    reports.append(
                        CapabilityReport(
                            name=f"plugin_{missing_id}",
                            category="plugin",
                            state=CapabilityState.NOT_CONFIGURED,
                            description=desc,
                            resolution_hint=f"Connect {missing_id} in Settings -> Connectors.",
                            metadata={"status": "not_installed", "plugin_id": missing_id},
                        )
                    )
        except Exception as exc:
            logger.warning("Failed to evaluate plugin integrations: %s", exc)
            reports.append(
                CapabilityReport(
                    name="plugins_catalog",
                    category="plugin",
                    state=CapabilityState.ERROR,
                    description="Plugin integrations catalog",
                    resolution_hint="Check database connection or plugin encryption keys.",
                )
            )
        return reports

    def evaluate_mcp_servers(self) -> List[CapabilityReport]:
        """Evaluate Model Context Protocol server configurations"""
        reports: List[CapabilityReport] = []
        servers = settings.MCP_SERVERS or []

        if not servers:
            reports.append(
                CapabilityReport(
                    name="mcp_servers_registry",
                    category="mcp",
                    state=CapabilityState.DISABLED,
                    description="No MCP servers currently configured.",
                    resolution_hint="Add MCP servers via add_mcp_server tool or Settings -> MCP.",
                )
            )
            return reports

        for s in servers:
            s_name = s.get("name", "unnamed_mcp")
            has_url = bool(s.get("url"))
            has_cmd = bool(s.get("command"))

            if has_url or has_cmd:
                state = CapabilityState.ENABLED
                hint = None
            else:
                state = CapabilityState.NOT_CONFIGURED
                hint = f"MCP server '{s_name}' is missing command or SSE url."

            reports.append(
                CapabilityReport(
                    name=f"mcp_{s_name}",
                    category="mcp",
                    state=state,
                    description=f"MCP Server: {s_name} ({'SSE' if has_url else 'Stdio'})",
                    resolution_hint=hint,
                    metadata=s,
                )
            )
        return reports

    def evaluate_llm_providers(self) -> Dict[str, Any]:
        """Evaluate primary and fallback LLM provider readiness"""
        provider = settings.LLM_PROVIDER or "groq"
        fallback = settings.FALLBACK_LLM_PROVIDER
        has_primary_key = settings.has_llm_api_key

        model_name = "unknown"
        if provider == "groq":
            model_name = settings.GROQ_MODEL
        elif provider == "gemini":
            model_name = settings.GEMINI_MODEL
        elif provider == "openai":
            model_name = settings.OPENAI_MODEL
        elif provider in ("azure_foundry", "azure"):
            model_name = settings.AZURE_FOUNDRY_MODEL
        elif provider == "deepseek":
            model_name = settings.DEEPSEEK_MODEL
        elif provider == "glm":
            model_name = settings.GLM_MODEL
        elif provider == "ollama":
            model_name = settings.OLLAMA_MODEL or "none"
        elif provider == "rie":
            model_name = settings.RIE_MODEL

        primary_state = CapabilityState.ENABLED if has_primary_key else CapabilityState.NOT_CONFIGURED
        hint = None if has_primary_key else f"Set API key for provider '{provider}' in Settings."

        return {
            "primary_provider": provider,
            "primary_model": model_name,
            "primary_state": primary_state,
            "primary_hint": hint,
            "fallback_provider": fallback or "none",
            "has_llm_api_key": has_primary_key,
        }

    def get_system_status(self, category: Optional[str] = "all") -> SystemStatusReport:
        """Aggregate full system capability and health report"""
        capabilities: List[CapabilityReport] = []

        if category in ("all", "builtin", "tools"):
            capabilities.extend(self.evaluate_builtin_tools())

        if category in ("all", "search"):
            capabilities.extend(self.evaluate_web_search())

        if category in ("all", "browser"):
            capabilities.append(self.evaluate_browser_engine())

        if category in ("all", "plugins"):
            capabilities.extend(self.evaluate_plugin_integrations())

        if category in ("all", "mcp"):
            capabilities.extend(self.evaluate_mcp_servers())

        # Collect log summary metrics
        log_file = settings.LOG_FILE
        log_size = log_file.stat().st_size if log_file.exists() else 0

        modes = {
            "chat_mode": settings.CHAT_MODE,
            "speed_mode": settings.SPEED_MODE,
            "orchestration_mode": settings.AGENT_ORCHESTRATION_MODE,
            "hitl_mode": settings.HITL_MODE,
            "window_mode": settings.WINDOW_MODE,
        }

        providers_info = self.evaluate_llm_providers()

        return SystemStatusReport(
            timestamp=datetime.now(timezone.utc).isoformat(),
            active_modes=modes,
            capabilities=capabilities,
            providers=providers_info,
            diagnostic_summary={
                "log_file": str(log_file),
                "log_file_exists": log_file.exists(),
                "log_size_bytes": log_size,
            },
        )


# Global instance
capability_registry = CapabilityRegistry()


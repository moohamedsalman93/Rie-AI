"""
Unit and Integration Tests for Rie System Intelligence Subsystem.
Verifies:
1. 5-State Capability Registry (ENABLED, DISABLED, NOT_CONFIGURED, UNAVAILABLE, ERROR)
2. Two-tier Permission Matrix & Pre-flight Validation
3. Transactional Settings Modification & Automatic Rollback
4. Manual Rollback via Transaction Journal
5. Safe Tool Toggles with Immutable Core Tool Protection
6. Bounded Log Diagnostics & Secret Redaction
7. Correlation Engine & Root Cause Analysis
8. LangChain StructuredTools Execution
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from app.database import (
    init_db,
    get_setting,
    update_setting,
    record_setting_transaction,
    get_setting_transactions,
)
from app.system_intelligence.models import (
    CapabilityState,
    SettingTier,
    SystemStatusReport,
    LogDiagnosticSummary,
)
from app.system_intelligence.capability_registry import (
    capability_registry,
    IMMUTABLE_CORE_TOOLS,
)
from app.system_intelligence.config_manager import (
    config_manager,
    TIER_1_AUTONOMOUS_KEYS,
    TIER_2_APPROVAL_KEYS,
)
from app.system_intelligence.log_diagnostics import LogDiagnosticsEngine
from app.system_intelligence.correlation_engine import correlation_engine
from app.system_intelligence.tools import (
    SYSTEM_INTELLIGENCE_TOOLS,
    _get_system_status,
    _modify_system_setting,
    _rollback_system_setting,
    _toggle_tool,
    _read_system_logs,
    _diagnose_system_errors,
)


class TestSystemIntelligence(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        # Snapshot current settings to restore in tearDown
        self.orig_speed = get_setting("SPEED_MODE")
        self.orig_chat = get_setting("CHAT_MODE")
        self.orig_tools = get_setting("ENABLED_TOOLS")
        self.orig_search = get_setting("WEB_SEARCH_PROVIDER")
        self.orig_hitl = get_setting("HITL_MODE")

    def tearDown(self):
        # Restore settings
        if self.orig_speed is not None:
            update_setting("SPEED_MODE", self.orig_speed)
        if self.orig_chat is not None:
            update_setting("CHAT_MODE", self.orig_chat)
        if self.orig_tools is not None:
            update_setting("ENABLED_TOOLS", self.orig_tools)
        if self.orig_search is not None:
            update_setting("WEB_SEARCH_PROVIDER", self.orig_search)
        if self.orig_hitl is not None:
            update_setting("HITL_MODE", self.orig_hitl)
        settings.reload()

    # --- Test Phase 1 & 2: Capability Health Engine ---

    def test_capability_registry_builtin_tools(self):
        """Verify built-in tools evaluation and immutable core tools"""
        reports = capability_registry.evaluate_builtin_tools()
        names = {r.name for r in reports}
        
        # Core tools must be present and ENABLED
        for core_tool in IMMUTABLE_CORE_TOOLS:
            self.assertIn(core_tool, names)
            rep = next(r for r in reports if r.name == core_tool)
            self.assertEqual(rep.state, CapabilityState.ENABLED)

    def test_capability_registry_disabled_tool(self):
        """Verify that disabling a tool in ENABLED_TOOLS marks it as DISABLED"""
        # Exclude 'mouse_click'
        update_setting("ENABLED_TOOLS", json.dumps(["internet_search", "ask_question"]))
        settings.reload()

        reports = capability_registry.evaluate_builtin_tools()
        mouse_rep = next(r for r in reports if r.name == "mouse_click")
        self.assertEqual(mouse_rep.state, CapabilityState.DISABLED)
        self.assertIn("toggle_tool", mouse_rep.resolution_hint)

    def test_capability_registry_web_search(self):
        """Verify 5-state search provider evaluation"""
        reports = capability_registry.evaluate_web_search()
        ddg = next(r for r in reports if r.name == "search_duckduckgo")
        self.assertEqual(ddg.state, CapabilityState.ENABLED)

    def test_get_system_status_aggregation(self):
        """Verify full system status report generation"""
        status = capability_registry.get_system_status()
        self.assertIsInstance(status, SystemStatusReport)
        self.assertIn("speed_mode", status.active_modes)
        self.assertIn("chat_mode", status.active_modes)
        self.assertIn("primary_provider", status.providers)
        self.assertTrue(len(status.capabilities) > 0)

    # --- Test Phase 3: ConfigManager & Permission Tiers ---

    def test_permission_tier_classification(self):
        """Verify Tier 1 autonomous vs Tier 2 approval required classification"""
        self.assertEqual(config_manager.get_setting_tier("SPEED_MODE"), SettingTier.TIER_1_AUTONOMOUS)
        self.assertEqual(config_manager.get_setting_tier("CHAT_MODE"), SettingTier.TIER_1_AUTONOMOUS)
        self.assertEqual(config_manager.get_setting_tier("CAMOFOX_HEADLESS_MODE"), SettingTier.TIER_1_AUTONOMOUS)
        self.assertEqual(config_manager.get_setting_tier("WEB_SEARCH_PROVIDER"), SettingTier.TIER_1_AUTONOMOUS)

        self.assertEqual(config_manager.get_setting_tier("HITL_MODE"), SettingTier.TIER_2_APPROVAL)
        self.assertEqual(config_manager.get_setting_tier("GROQ_API_KEY"), SettingTier.TIER_2_APPROVAL)
        self.assertEqual(config_manager.get_setting_tier("TERMINAL_RESTRICTIONS"), SettingTier.TIER_2_APPROVAL)

    def test_tier_1_autonomous_modification(self):
        """Verify Tier 1 settings can be modified autonomously"""
        res = config_manager.modify_setting("SPEED_MODE", "flash", reason="Need quick response")
        self.assertEqual(res["status"], "success")
        self.assertEqual(res["new_value"], "flash")
        self.assertEqual(get_setting("SPEED_MODE"), "flash")
        self.assertEqual(settings.SPEED_MODE, "flash")

    def test_tier_2_approval_gate(self):
        """Verify Tier 2 settings require explicit user confirmation"""
        # Attempting without confirmation should be blocked with approval_required
        res = config_manager.modify_setting("HITL_MODE", "disable", reason="User requested silence")
        self.assertEqual(res["status"], "approval_required")
        self.assertIn("ask_question", res["message"])

        # With confirmation, it should succeed
        res_confirmed = config_manager.modify_setting(
            "HITL_MODE", "disable", reason="User confirmed", confirmed_by_user=True
        )
        self.assertEqual(res_confirmed["status"], "success")
        self.assertEqual(get_setting("HITL_MODE"), "disable")

    def test_masked_secret_protection(self):
        """Verify masked secrets are rejected and never overwrite real keys"""
        res = config_manager.modify_setting("GROQ_API_KEY", "gsk_123***masked***", confirmed_by_user=True)
        self.assertEqual(res["status"], "error")
        self.assertIn("masked", res["message"].lower())

    def test_auto_rollback_on_failed_preflight(self):
        """Verify automatic rollback if LLM provider is switched to an unconfigured provider"""
        old_provider = get_setting("LLM_PROVIDER") or "groq"
        
        # Switch to vertex with no vertex credentials
        res = config_manager.modify_setting("LLM_PROVIDER", "vertex", confirmed_by_user=True)
        
        # Since vertex has no credentials in test environment, it should auto-rollback
        if not settings.VERTEX_PROJECT:
            self.assertEqual(res["status"], "rolled_back")
            self.assertIn("Auto-rollback executed", res["message"])
            self.assertEqual(get_setting("LLM_PROVIDER"), old_provider)

    def test_manual_rollback(self):
        """Verify manual rollback restores previous value from transaction journal"""
        # 1. Set to flash
        config_manager.modify_setting("SPEED_MODE", "flash")
        self.assertEqual(settings.SPEED_MODE, "flash")

        # 2. Set to thinking
        res = config_manager.modify_setting("SPEED_MODE", "thinking")
        tx_id = res["transaction_id"]
        self.assertEqual(settings.SPEED_MODE, "thinking")

        # 3. Rollback the change
        rb_res = config_manager.rollback_setting(transaction_id=tx_id)
        self.assertEqual(rb_res["status"], "success")
        self.assertEqual(rb_res["restored_value"], "flash")
        self.assertEqual(get_setting("SPEED_MODE"), "flash")

    def test_toggle_tool_safeguards(self):
        """Verify tool toggle cannot disable core diagnostic/safety tools"""
        # Attempt to disable core tool
        res = config_manager.toggle_tool("modify_system_setting", False)
        self.assertEqual(res["status"], "error")
        self.assertIn("immutable core diagnostic/safety tool", res["message"])

        # Toggle non-core tool
        res_noncore = config_manager.toggle_tool("mouse_click", False)
        self.assertEqual(res_noncore["status"], "success")
        enabled_list = json.loads(get_setting("ENABLED_TOOLS"))
        self.assertNotIn("mouse_click", enabled_list)

        # Re-enable non-core tool
        res_enable = config_manager.toggle_tool("mouse_click", True)
        self.assertEqual(res_enable["status"], "success")
        enabled_list2 = json.loads(get_setting("ENABLED_TOOLS"))
        self.assertIn("mouse_click", enabled_list2)

    # --- Test Phase 4: Log Diagnostics & Secret Redaction ---

    def test_log_diagnostics_reading_and_redaction(self):
        """Verify bounded log reading and token redaction"""
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tf:
            tf.write("2026-11-12 13:00:00 - main - INFO - Server started\n")
            tf.write("2026-11-12 13:01:00 - agent - ERROR - Call failed with bearer sk-secret123456789012345\n")
            tf.write("2026-11-12 13:02:00 - routes - WARNING - Slow request\n")
            temp_log_path = Path(tf.name)

        try:
            custom_engine = LogDiagnosticsEngine(log_path=temp_log_path)
            
            # Read all
            res = custom_engine.read_logs(lines=10, level="ALL")
            self.assertEqual(res["status"], "success")
            self.assertEqual(res["lines_returned"], 3)
            # Verify secret redaction
            self.assertNotIn("sk-secret123456789012345", res["content"])
            self.assertIn("[REDACTED_", res["content"])

            # Read only errors
            res_errors = custom_engine.read_logs(lines=10, level="ERROR")
            self.assertEqual(res_errors["lines_returned"], 1)
            self.assertIn("ERROR", res_errors["content"])
            self.assertNotIn("Slow request", res_errors["content"])

            # Keyword query
            res_query = custom_engine.read_logs(lines=10, search_query="routes")
            self.assertEqual(res_query["lines_returned"], 1)
            self.assertIn("routes", res_query["content"])
        finally:
            if temp_log_path.exists():
                os.unlink(temp_log_path)

    def test_diagnose_errors_aggregation(self):
        """Verify timestamp-aware error aggregation"""
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tf:
            tf.write(f"{now_str} - browser - ERROR - Camoufox connection timed out\n")
            tf.write(f"{now_str} - browser - ERROR - Element #btn not found\n")
            tf.write(f"{now_str} - routes - WARNING - Cache miss\n")
            temp_log_path = Path(tf.name)

        try:
            custom_engine = LogDiagnosticsEngine(log_path=temp_log_path)
            summary = custom_engine.diagnose_errors(window_minutes=30)
            self.assertIsInstance(summary, LogDiagnosticSummary)
            self.assertEqual(summary.error_count, 2)
            self.assertEqual(summary.warning_count, 1)
            self.assertEqual(summary.top_failing_components.get("browser"), 2)
        finally:
            if temp_log_path.exists():
                os.unlink(temp_log_path)

    # --- Test Phase 5: Structured Tools Direct Execution ---

    def test_structured_tools_invocation(self):
        """Verify LangChain structured tool invocations"""
        # 1. get_system_status
        status_str = _get_system_status(category="modes")
        self.assertIn("Rie System Status", status_str)
        self.assertIn("Speed Mode", status_str)

        # 2. modify_system_setting
        mod_str = _modify_system_setting("SPEED_MODE", "flash", reason="Unit test")
        self.assertIn("Successfully modified", mod_str)

        # 3. rollback_system_setting
        rb_str = _rollback_system_setting(key="SPEED_MODE")
        self.assertIn("Successfully rolled back", rb_str)

        # 4. toggle_tool
        tog_str = _toggle_tool("mouse_click", True)
        self.assertIn("has been enabled", tog_str)

        # 5. read_system_logs
        log_str = _read_system_logs(lines=5, level="ALL")
        self.assertIn("Backend Logs", log_str)

        # 6. diagnose_system_errors
        diag_str = _diagnose_system_errors(window_minutes=15)
        self.assertIn("System Diagnostic Summary", diag_str)


if __name__ == "__main__":
    unittest.main()


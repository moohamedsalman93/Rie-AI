"""
Configuration Manager for Rie System Intelligence.
Enforces permission tiers, pre-flight validation, transactional persistence, and automatic rollback.
"""
import json
import logging
import uuid
from typing import Optional, Dict, Any, Tuple, Set

from app.config import settings
from app.database import (
    get_setting,
    update_setting,
    record_setting_transaction,
    get_setting_transactions,
    get_setting_transaction,
    update_setting_transaction_status,
)
from app.system_intelligence.models import SettingTier
from app.system_intelligence.capability_registry import IMMUTABLE_CORE_TOOLS, KNOWN_BUILTIN_TOOLS

logger = logging.getLogger(__name__)

# Tier 1: Autonomous operational and non-destructive settings
TIER_1_AUTONOMOUS_KEYS: Dict[str, Any] = {
    "SPEED_MODE": {"thinking", "flash"},
    "CHAT_MODE": {"agent", "chat"},
    "AGENT_ORCHESTRATION_MODE": {"solo", "team"},
    "CAMOFOX_HEADLESS_MODE": {"headless", "normal", "auto"},
    "BROWSER_HEADLESS_MODE": {"headless", "normal", "auto"},
    "WEB_SEARCH_PROVIDER": {"tavily", "brave", "duckduckgo"},
    "FLOATING_CHAT_OPACITY": lambda v: 0.1 <= float(v) <= 1.0,
    "SHOW_BUBBLE": {"true", "false", True, False},
    "BUBBLE_SIZE": {"small", "medium", "large"},
    "BUBBLE_SHOW_LABEL": {"true", "false", True, False},
    "BUBBLE_SNAP_EDGE": {"true", "false", True, False},
    "BUBBLE_TRANSPARENT_BG": {"true", "false", True, False},
    "BUBBLE_SHOW_TOOLS": {"true", "false", True, False},
    "WINDOW_MODE": {"floating", "normal"},
    "CAPTURE_SCREEN_AS_TEXT": {"true", "false", True, False},
    "EXCLUDE_FROM_CAPTURE": {"true", "false", True, False},
    "SHARE_LOCATION": {"true", "false", True, False},
    "WAKE_WORD_ENABLED": {"true", "false", True, False},
    "GEMINI_LIVE_VOICE": {"Aoede", "Kore", "Puck", "Charon", "Fenrir"},
    "GROQ_MODEL": lambda v: bool(str(v).strip()),
    "GEMINI_MODEL": lambda v: bool(str(v).strip()),
    "OPENAI_MODEL": lambda v: bool(str(v).strip()),
    "DEEPSEEK_MODEL": lambda v: bool(str(v).strip()),
    "GLM_MODEL": lambda v: bool(str(v).strip()),
    "AZURE_FOUNDRY_MODEL": lambda v: bool(str(v).strip()),
    "OLLAMA_MODEL": lambda v: bool(str(v).strip()),
}

# Tier 2: Approval required before modification
TIER_2_APPROVAL_KEYS: Set[str] = {
    "HITL_MODE",
    "TERMINAL_RESTRICTIONS",
    "GROQ_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_FOUNDRY_API_KEY",
    "AZURE_API_KEY",
    "DEEPSEEK_API_KEY",
    "GLM_API_KEY",
    "ANTHROPIC_API_KEY",
    "TAVILY_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "RIE_ACCESS_TOKEN",
    "CONNECTIVITY_NGROK_ENABLED",
    "CONNECTIVITY_NGROK_AUTH_TOKEN",
    "CONNECTIVITY_NGROK_DOMAIN",
    "SUBAGENTS_CONFIG",
    "SUBAGENT_PLANNER_GRAPH",
    "LLM_PROVIDER",
    "FALLBACK_LLM_PROVIDER",
}


def _looks_like_masked_secret(val: str) -> bool:
    """Detect if a string is a masked UI secret like sk-*** or ****"""
    s = str(val).strip()
    return "..." in s or "***" in s or (len(s) > 4 and s.count("*") >= 3)


class ConfigManager:
    """Manages transactional setting changes, permission verification, and rollbacks"""

    def get_setting_tier(self, key: str) -> SettingTier:
        """Classify key into Tier 1 (autonomous) or Tier 2 (approval required)"""
        if key in TIER_1_AUTONOMOUS_KEYS:
            return SettingTier.TIER_1_AUTONOMOUS
        return SettingTier.TIER_2_APPROVAL

    def validate_setting_value(self, key: str, value: Any) -> Tuple[bool, str, str]:
        """Validate key and value format. Returns (is_valid, normalized_str_value, error_message)."""
        key_upper = key.strip().upper()

        if key_upper not in TIER_1_AUTONOMOUS_KEYS and key_upper not in TIER_2_APPROVAL_KEYS:
            return False, "", f"Unknown setting key: '{key}'"

        if _looks_like_masked_secret(str(value)):
            return False, "", f"Value for '{key}' appears to be a masked display secret. Cannot overwrite with masked value."

        val_str = str(value).strip()

        # Tier 1 validators
        if key_upper in TIER_1_AUTONOMOUS_KEYS:
            rule = TIER_1_AUTONOMOUS_KEYS[key_upper]
            if isinstance(rule, set):
                val_lower = val_str.lower()
                allowed_lower = {str(x).lower() for x in rule}
                if val_lower not in allowed_lower:
                    return False, "", f"Invalid value '{value}' for {key_upper}. Allowed: {sorted(list(allowed_lower))}"
                return True, val_lower, ""
            elif callable(rule):
                try:
                    if not rule(value):
                        return False, "", f"Value '{value}' failed validation for {key_upper}."
                except Exception as exc:
                    return False, "", f"Value '{value}' invalid for {key_upper}: {exc}"

        # Tier 2 specific validators
        if key_upper == "HITL_MODE":
            val_lower = val_str.lower()
            if val_lower not in {"disable", "always", "let_decide"}:
                return False, "", "HITL_MODE must be 'disable', 'always', or 'let_decide'."
            return True, val_lower, ""

        if key_upper == "LLM_PROVIDER":
            val_lower = val_str.lower()
            allowed_providers = {"groq", "gemini", "vertex", "openai", "azure_foundry", "azure", "deepseek", "glm", "ollama", "rie"}
            if val_lower not in allowed_providers:
                return False, "", f"Invalid LLM provider: {val_lower}. Allowed: {sorted(list(allowed_providers))}"
            return True, val_lower, ""

        return True, val_str, ""

    def modify_setting(
        self,
        key: str,
        value: Any,
        reason: Optional[str] = None,
        author: str = "rie",
        confirmed_by_user: bool = False,
    ) -> Dict[str, Any]:
        """
        Execute a transactional setting modification.
        Enforces permission tiers, performs pre-flight checks, and rolls back if pre-flight fails.
        """
        key_upper = key.strip().upper()
        tier = self.get_setting_tier(key_upper)

        # 1. Permission Gate
        if tier == SettingTier.TIER_2_APPROVAL and not confirmed_by_user:
            return {
                "status": "approval_required",
                "tier": "approval_required",
                "key": key_upper,
                "proposed_value": value,
                "message": (
                    f"Modifying '{key_upper}' is security-sensitive or configuration-critical (Tier 2). "
                    "You must ask the user for explicit confirmation using the ask_question tool before applying this change."
                ),
            }

        # 2. Validation
        is_valid, validated_value, err_msg = self.validate_setting_value(key_upper, value)
        if not is_valid:
            return {
                "status": "error",
                "key": key_upper,
                "message": f"Validation failed: {err_msg}",
            }

        # 3. Snapshot previous value
        old_value = get_setting(key_upper)
        tx_id = str(uuid.uuid4())

        record_setting_transaction(
            key=key_upper,
            old_value=old_value,
            new_value=validated_value,
            reason=reason,
            author=author,
            tier=tier.value,
            status="pending",
            transaction_id=tx_id,
        )

        try:
            # 4. Commit to database
            update_setting(key_upper, validated_value)

            # Sync legacy or dual keys if applicable
            if key_upper in ("CAMOFOX_HEADLESS_MODE", "BROWSER_HEADLESS_MODE"):
                update_setting("CAMOUFOX_HEADLESS", "1" if validated_value == "headless" else "0")

            # 5. Reload in-memory settings
            settings.reload()

            # 6. Pre-flight health check
            if key_upper == "LLM_PROVIDER":
                if not settings.has_llm_api_key:
                    # Auto-rollback: user switched to provider with no API key
                    logger.warning("Pre-flight check failed for %s: missing API key. Initiating auto-rollback.", validated_value)
                    self._execute_rollback(key_upper, old_value, tx_id)
                    return {
                        "status": "rolled_back",
                        "transaction_id": tx_id,
                        "key": key_upper,
                        "message": (
                            f"Auto-rollback executed: Provider '{validated_value}' has no API key configured. "
                            f"Restored previous setting '{old_value}' to avoid agent crash."
                        ),
                    }

            # 7. Invalidate cached agent graph so next turn re-initializes
            self._invalidate_agent_runtime()

            # 8. Mark transaction committed
            update_setting_transaction_status(tx_id, "committed")

            logger.info("Setting %s successfully modified to %s (Tx: %s, Author: %s)", key_upper, validated_value, tx_id, author)

            return {
                "status": "success",
                "transaction_id": tx_id,
                "key": key_upper,
                "old_value": old_value,
                "new_value": validated_value,
                "tier": tier.value,
                "message": f"Successfully updated '{key_upper}' to '{validated_value}'.",
            }

        except Exception as exc:
            logger.exception("Error modifying setting %s: %s. Initiating auto-rollback.", key_upper, exc)
            self._execute_rollback(key_upper, old_value, tx_id)
            return {
                "status": "rolled_back",
                "transaction_id": tx_id,
                "key": key_upper,
                "message": f"Exception occurred while applying setting: {exc}. Automatically rolled back to previous value.",
            }

    def _execute_rollback(self, key: str, old_value: Optional[str], tx_id: str):
        """Internal helper to restore old value and update transaction status"""
        if old_value is not None:
            update_setting(key, old_value)
        settings.reload()
        self._invalidate_agent_runtime()
        update_setting_transaction_status(tx_id, "rolled_back")

    def rollback_setting(
        self,
        transaction_id: Optional[str] = None,
        key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Revert a setting modification using the rollback journal"""
        tx = None
        if transaction_id:
            tx = get_setting_transaction(transaction_id)
        elif key:
            history = get_setting_transactions(limit=1, key=key.strip().upper())
            if history:
                tx = history[0]

        if not tx:
            return {
                "status": "error",
                "message": f"No rollback transaction found for key='{key}' or transaction_id='{transaction_id}'.",
            }

        if tx.get("status") == "rolled_back":
            return {
                "status": "error",
                "message": f"Transaction {tx.get('id')} has already been rolled back.",
            }

        target_key = tx["key"]
        old_val = tx.get("old_value")

        if old_val is not None:
            update_setting(target_key, old_val)
        settings.reload()
        self._invalidate_agent_runtime()
        update_setting_transaction_status(tx["id"], "rolled_back")

        logger.info("Rolled back setting %s to '%s' (Tx: %s)", target_key, old_val, tx["id"])

        return {
            "status": "success",
            "transaction_id": tx["id"],
            "key": target_key,
            "restored_value": old_val,
            "message": f"Successfully rolled back '{target_key}' to '{old_val}'.",
        }

    def toggle_tool(self, tool_name: str, enabled: bool) -> Dict[str, Any]:
        """Enable or disable a specific tool with safety blacklist protections"""
        name_clean = tool_name.strip()

        # Safety Check: Immutable core tools can never be disabled
        if name_clean in IMMUTABLE_CORE_TOOLS and not enabled:
            return {
                "status": "error",
                "tool_name": name_clean,
                "message": f"Tool '{name_clean}' is an immutable core diagnostic/safety tool and cannot be disabled.",
            }

        # Get current enabled tools list
        raw_tools = settings.ENABLED_TOOLS
        if raw_tools is None:
            # None implies all known tools are enabled
            current_tools = set(KNOWN_BUILTIN_TOOLS.keys())
        else:
            current_tools = set(raw_tools)

        if enabled:
            current_tools.add(name_clean)
        else:
            current_tools.discard(name_clean)

        # Always ensure immutable core tools remain in set
        current_tools.update(IMMUTABLE_CORE_TOOLS)

        new_tools_json = json.dumps(sorted(list(current_tools)))

        # Snapshot and update
        old_val = get_setting("ENABLED_TOOLS")
        tx_id = str(uuid.uuid4())
        record_setting_transaction(
            key="ENABLED_TOOLS",
            old_value=old_val,
            new_value=new_tools_json,
            reason=f"{'Enabled' if enabled else 'Disabled'} tool '{name_clean}'",
            author="rie",
            tier=SettingTier.TIER_1_AUTONOMOUS.value,
            status="committed",
            transaction_id=tx_id,
        )

        update_setting("ENABLED_TOOLS", new_tools_json)
        settings.reload()
        self._invalidate_agent_runtime()

        action = "enabled" if enabled else "disabled"
        logger.info("Tool %s was %s by Rie", name_clean, action)

        return {
            "status": "success",
            "tool_name": name_clean,
            "enabled": enabled,
            "message": f"Tool '{name_clean}' has been {action}. Agent graph will re-bind tools on next turn.",
        }

    def _invalidate_agent_runtime(self):
        """Invalidate the LangGraph agent graph so it recompiles on next request"""
        try:
            from app.agent import agent_manager
            agent_manager.invalidate_agent()
        except Exception as exc:
            logger.warning("Could not invalidate agent runtime immediately: %s", exc)


# Global instance
config_manager = ConfigManager()


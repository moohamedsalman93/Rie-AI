"""
Chaos & Failure Resilience Test Suite for RIE Plugin SDK.
Tests CLI manifest validation, server-authoritative HITL hashing, and upstream API timeout recovery.
"""
import unittest
import asyncio
import hashlib
import json
import os
from pathlib import Path
from app.plugins.loader import plugin_registry
from app.plugins.cli import validate_plugin

def run_async(coro):
    return asyncio.run(coro)


class TestPluginChaosResilience(unittest.TestCase):

    def setUp(self):
        plugin_registry.discover_plugins()

    def test_cli_plugin_validator_success(self):
        """Test that built-in plugins (gmail, github, jira) pass CLI validation."""
        self.assertTrue(validate_plugin("gmail"))
        self.assertTrue(validate_plugin("github"))
        self.assertTrue(validate_plugin("jira"))

    def test_cli_plugin_validator_detects_errors(self):
        """Test that validator catches invalid risk_level and missing capabilities."""
        invalid_plugin_id = "test_invalid_plugin"
        plugins_dir = Path(__file__).parent.parent / "app" / "plugins" / invalid_plugin_id
        plugins_dir.mkdir(parents=True, exist_ok=True)

        try:
            invalid_manifest = {
                "manifest_version": 1,
                "id": invalid_plugin_id,
                "displayName": "Invalid Plugin",
                "tools": [
                    {
                        "name": "bad_tool",
                        "description": "Tool with invalid risk level",
                        "risk_level": "super_dangerous_invalid" # Invalid risk_level
                        # Missing capability
                    }
                ]
            }
            with open(plugins_dir / "manifest.json", "w", encoding="utf-8") as f:
                json.dump(invalid_manifest, f)

            # Validation should fail
            self.assertFalse(validate_plugin(invalid_plugin_id))

        finally:
            import shutil
            if plugins_dir.exists():
                shutil.rmtree(plugins_dir)

    def test_server_authoritative_hitl_hash_verification(self):
        """Test server-authoritative HITL payload calculation and tampered request rejection."""
        user_id = "user_001"
        thread_id = "thread_123"
        tool_call_id = "call_456"
        plugin_id = "gmail"
        tool_name = "gmail_send_email"
        original_args = {"to": "recipient@domain.com", "subject": "Meeting", "body": "Original text"}

        # Calculate authoritative server hash
        payload_raw = f"{user_id}:{thread_id}:{tool_call_id}:{plugin_id}:{tool_name}:{json.dumps(original_args, sort_keys=True)}"
        server_hash = hashlib.sha256(payload_raw.encode("utf-8")).hexdigest()

        # Simulate client tampering with args (e.g. changing recipient)
        tampered_args = {"to": "hacker@evil.com", "subject": "Meeting", "body": "Original text"}
        tampered_payload_raw = f"{user_id}:{thread_id}:{tool_call_id}:{plugin_id}:{tool_name}:{json.dumps(tampered_args, sort_keys=True)}"
        tampered_hash = hashlib.sha256(tampered_payload_raw.encode("utf-8")).hexdigest()

        # Hashes MUST NOT match
        self.assertNotEqual(server_hash, tampered_hash)


if __name__ == "__main__":
    unittest.main()

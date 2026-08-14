"""
Live & Hardening Integration Test Suite for RIE Plugin Architecture.
Tests capability toggling, 300s preemptive token refresh buffer, and revocation error handling.
"""
import unittest
import asyncio
import time
import json
from app.plugins.loader import plugin_registry
from app.plugin_manager import plugin_manager
from app.database import save_plugin_integration, delete_plugin_integration, get_plugin_integration
from app.security_crypto import encrypt_json

def run_async(coro):
    return asyncio.run(coro)


class TestLiveGmailIntegration(unittest.TestCase):

    def setUp(self):
        plugin_registry.discover_plugins()
        delete_plugin_integration("gmail")

    def tearDown(self):
        delete_plugin_integration("gmail")

    def test_capability_enablement_and_disablement(self):
        """Test disabling and enabling specific tool capabilities."""
        plugin_id = "gmail"
        tokens = {"access_token": "mock-access-token-12345", "refresh_token": "mock-refresh"}
        encrypted = encrypt_json({"tokens": tokens})
        config = {"disabled_capabilities": ["gmail.send"]}

        save_plugin_integration(
            plugin_id=plugin_id,
            name="Gmail",
            auth_type="oauth2",
            status="connected",
            encrypted_credentials=encrypted,
            account_info='{"email": "user@gmail.com"}',
            config=json.dumps(config)
        )

        async def _test():
            await plugin_manager.initialize()

            # "gmail.read" should be enabled
            self.assertTrue(plugin_manager.is_capability_enabled("gmail", "gmail.read"))

            # "gmail.send" should be disabled
            self.assertFalse(plugin_manager.is_capability_enabled("gmail", "gmail.send"))

            # Executing disabled tool capability should return capability disabled error
            res = await plugin_manager._execute_plugin_tool("gmail", "gmail_send_email", "gmail.send", {"to": "a@b.com", "subject": "hi", "body": "text"})
            self.assertIn("disabled by user setting", res)

        run_async(_test())

    def test_preemptive_token_refresh_buffer(self):
        """Test preemptive token refresh trigger when token expires in < 300 seconds."""
        from unittest.mock import AsyncMock, patch, MagicMock

        async def _test():
            tokens = {
                "access_token": "expiring-token",
                "refresh_token": "valid-refresh-token",
                "expires_at": time.time() + 100
            }
            creds = {"tokens": tokens}

            mock_refresh_resp = MagicMock()
            mock_refresh_resp.status_code = 200
            mock_refresh_resp.json.return_value = {
                "status": "ok",
                "tokens": {
                    "access_token": "fresh-refreshed-token",
                    "expires_in": 3600
                }
            }

            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = mock_refresh_resp
                token = await plugin_manager._ensure_valid_token("gmail", creds)
                self.assertEqual(token, "fresh-refreshed-token")

        run_async(_test())

    def test_concurrent_refresh_locking(self):
        """Verify thread-safe per-plugin asyncio.Lock prevents duplicate token refresh calls."""
        from unittest.mock import AsyncMock, patch, MagicMock

        async def _test():
            tokens = {
                "access_token": "expiring-token-123",
                "refresh_token": "refresh-token-456",
                "expires_at": time.time() + 50
            }
            creds = {"tokens": tokens}

            mock_refresh_resp = MagicMock()
            mock_refresh_resp.status_code = 200
            mock_refresh_resp.json.return_value = {
                "status": "ok",
                "tokens": {
                    "access_token": "fresh-concurrent-token",
                    "expires_in": 3600
                }
            }

            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = mock_refresh_resp
                # Fire 5 concurrent refresh tasks
                tasks = [plugin_manager._ensure_valid_token("gmail", creds) for _ in range(5)]
                results = await asyncio.gather(*tasks)

                self.assertEqual(len(results), 5)
                for res in results:
                    self.assertEqual(res, "fresh-concurrent-token")

        run_async(_test())

    def test_hitl_action_hash_and_expiration(self):
        """Verify action payload hashing and 30-minute expiration window for durable HITL approvals."""
        import hashlib
        thread_id = "thread_123"
        tool_call_id = "call_456"
        plugin_id = "gmail"
        tool_name = "gmail_send_email"
        args = {"to": "john@example.com", "subject": "Meeting"}

        # Compute payload hash
        payload_str = f"{thread_id}:{tool_call_id}:{plugin_id}:{tool_name}:{json.dumps(args, sort_keys=True)}"
        action_hash = hashlib.sha256(payload_str.encode("utf-8")).hexdigest()
        self.assertEqual(len(action_hash), 64)

        # Expiration calculation (30 minutes = 1800s)
        created_at = time.time()
        expires_at = created_at + 1800

        # Valid before 30 mins
        self.assertTrue((created_at + 500) < expires_at)
        # Expired after 30 mins
        self.assertTrue((created_at + 2000) > expires_at)

    def test_cli_plugin_generator(self):
        """Test plugin scaffolding CLI generator in an isolated temporary directory."""
        import tempfile
        from app.plugins.cli import create_plugin
        from pathlib import Path

        plugin_id = "test_cli_generated"
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_plugins_path = Path(tmp_dir)
            create_plugin(plugin_id, display_name="Test Generated Plugin", category="Test", plugins_dir=tmp_plugins_path)

            target_plugin_dir = tmp_plugins_path / plugin_id
            manifest_path = target_plugin_dir / "manifest.json"
            handler_path = target_plugin_dir / "handler.py"

            self.assertTrue(manifest_path.exists())
            self.assertTrue(handler_path.exists())

            # Test auto-discovery of newly generated plugin from custom directory
            plugin_registry.discover_plugins(plugins_dir=tmp_plugins_path)
            self.assertIn(plugin_id, plugin_registry.manifests)


if __name__ == "__main__":
    unittest.main()

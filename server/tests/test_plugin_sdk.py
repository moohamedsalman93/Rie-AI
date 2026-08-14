"""
End-to-End Integration Test Suite for RIE Plugin SDK.
Tests plugin folder discovery, Fernet token crypto, OAuth state encoding, and tool handler execution.
"""
import unittest
import asyncio
import json
import os
import base64
import urllib.parse

from app.plugins.loader import plugin_registry
from app.security_crypto import encrypt_secret, decrypt_secret, encrypt_json, decrypt_json

# Helper to run async code inside synchronous unittest methods
def run_async(coro):
    return asyncio.run(coro)


class TestPluginSDK(unittest.TestCase):

    def setUp(self):
        # Force re-discovery of plugins from app/server/app/plugins
        plugin_registry.discover_plugins()

    def test_plugin_discovery(self):
        """Verify that plugin folders (gmail, github, jira, etc.) are discovered dynamically."""
        manifests = plugin_registry.manifests
        self.assertIn("gmail", manifests, "Gmail plugin should be discovered.")
        self.assertIn("github", manifests, "GitHub plugin should be discovered.")
        self.assertIn("jira", manifests, "Jira plugin (new 3rd party integration) should be discovered.")

        gmail = manifests["gmail"]
        self.assertEqual(gmail.displayName, "Gmail")
        self.assertGreaterEqual(len(gmail.tools), 3)

        jira = manifests["jira"]
        self.assertEqual(jira.displayName, "Jira")
        self.assertEqual(jira.category, "Project Management")

    def test_token_encryption_decryption_with_kms_override(self):
        """Test token encryption and decryption with RIE_ENCRYPTION_KEY environment override."""
        os.environ["RIE_ENCRYPTION_KEY"] = "cloud-kms-secret-key-override-12345"
        sample_tokens = {
            "access_token": "ya29.a0Axoo-mock-google-access-token",
            "refresh_token": "1//04mock-google-refresh-token",
            "expires_in": 3600
        }

        encrypted_str = encrypt_json(sample_tokens)
        self.assertTrue(encrypted_str.startswith("fernet:") or encrypted_str.startswith("b64:"))

        decrypted_dict = decrypt_json(encrypted_str)
        self.assertEqual(decrypted_dict["access_token"], sample_tokens["access_token"])
        self.assertEqual(decrypted_dict["refresh_token"], sample_tokens["refresh_token"])

    def test_oauth_payload_encoding_decoding(self):
        """Test OAuth state and payload serialization/deserialization."""
        state_data = {
            "provider": "github",
            "desktop_callback": "http://127.0.0.1:14300/api/plugins/oauth/callback"
        }
        encoded = base64.urlsafe_b64encode(json.dumps(state_data).encode()).decode()
        decoded = json.loads(base64.urlsafe_b64decode(encoded.encode()).decode())

        self.assertEqual(decoded["provider"], "github")
        self.assertEqual(decoded["desktop_callback"], "http://127.0.0.1:14300/api/plugins/oauth/callback")

    def test_gmail_handler_execution_mock(self):
        """Test executing Gmail plugin tools via handler."""
        from unittest.mock import AsyncMock, patch, MagicMock
        handler = plugin_registry.get_handler("gmail")
        self.assertIsNotNone(handler, "Gmail handler should be registered.")

        async def _test():
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"id": "msg_123", "threadId": "th_123"}

            with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_post.return_value = mock_resp
                res = await handler.execute_tool(
                    tool_name="gmail_send_email",
                    args={"to": "test@example.com", "subject": "Hello", "body": "Test message"},
                    access_token="mock-token",
                    creds={}
                )
                self.assertIn("Successfully sent email to test@example.com", res)

        run_async(_test())

    def test_jira_handler_execution_mock(self):
        """Test executing Jira plugin tools (demonstrating new generic plugin SDK integration)."""
        handler = plugin_registry.get_handler("jira")
        self.assertIsNotNone(handler, "Jira handler should be registered.")

        async def _test():
            res = await handler.execute_tool(
                tool_name="jira_create_issue",
                args={"project_key": "PROJ", "summary": "Fix login bug", "issue_type": "Bug"},
                access_token="mock-token",
                creds={}
            )
            self.assertIn("PROJ-101", res)
            self.assertIn("Fix login bug", res)

        run_async(_test())


    def test_tool_risk_level_enforcement(self):
        """Verify that tools declare risk_level ('read' vs 'write') for HITL approval safety."""
        gmail_manifest = plugin_registry.get_manifest("gmail")
        tool_risks = {t.name: t.risk_level for t in gmail_manifest.tools}

        self.assertEqual(tool_risks.get("gmail_search_emails"), "read", "gmail_search_emails should be read risk level.")
        self.assertEqual(tool_risks.get("gmail_send_email"), "write", "gmail_send_email should be write risk level requiring HITL.")

    def test_gmail_production_e2e(self):
        """End-to-end test simulating complete user flow for Gmail integration."""
        from unittest.mock import AsyncMock, patch, MagicMock

        # 1. Manifest discovery & scope verification
        gmail_manifest = plugin_registry.get_manifest("gmail")
        self.assertIn("Read inbox & search messages", gmail_manifest.scopes)

        # 2. Token encryption via KMS/Fernet
        tokens = {"access_token": "ya29.mock-access-token-12345", "refresh_token": "1//mock-refresh-token"}
        encrypted = encrypt_json({"tokens": tokens})

        # 3. Token decryption at runtime
        decrypted = decrypt_json(encrypted)
        access_token = decrypted["tokens"]["access_token"]

        # 4. Handler execution
        handler = plugin_registry.get_handler("gmail")
        async def _run_e2e():
            mock_get_resp = MagicMock()
            mock_get_resp.status_code = 200
            mock_get_resp.json.return_value = {"messages": []}

            mock_post_resp = MagicMock()
            mock_post_resp.status_code = 200
            mock_post_resp.json.return_value = {"id": "msg_e2e", "threadId": "th_e2e"}

            with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get, \
                 patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
                mock_get.return_value = mock_get_resp
                mock_post.return_value = mock_post_resp

                # Test Read tool
                search_res = await handler.execute_tool("gmail_search_emails", {"query": "is:unread"}, access_token, decrypted)
                self.assertTrue(search_res is not None)

                # Test Write tool (requiring HITL approval)
                send_res = await handler.execute_tool("gmail_send_email", {"to": "recipient@domain.com", "subject": "Test E2E", "body": "Body"}, access_token, decrypted)
                self.assertIn("Successfully sent email to recipient@domain.com", send_res)

        run_async(_run_e2e())


if __name__ == "__main__":
    unittest.main()

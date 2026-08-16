"""
Regression Test Suite for Plugin Lifecycle & Agent Graph Invalidation.

Tests the complete flow:
1. Agent starts without Gmail (0 Gmail tools in active set).
2. Gmail plugin is connected.
3. Invalidation triggers on plugin connection.
4. Next agent request re-initializes and collects Gmail tools into graph.
5. DynamicToolRoutingMiddleware correctly routes gmail_* tools on "can you read gmail".
6. Disconnecting Gmail and invalidating graph cleans up tools.
"""
import unittest
import asyncio
import json
from unittest.mock import patch, MagicMock

from app.plugins.loader import plugin_registry
from app.plugin_manager import plugin_manager
from app.database import save_plugin_integration, delete_plugin_integration
from app.security_crypto import encrypt_json
from app.agent import agent_manager, DynamicToolRoutingMiddleware


def run_async(coro):
    return asyncio.run(coro)


class TestPluginGraphInvalidation(unittest.TestCase):

    def setUp(self):
        plugin_registry.discover_plugins()
        delete_plugin_integration("gmail")
        delete_plugin_integration("google")
        agent_manager.invalidate_agent()

    def tearDown(self):
        delete_plugin_integration("gmail")
        delete_plugin_integration("google")
        agent_manager.invalidate_agent()

    def test_agent_graph_invalidation_lifecycle(self):
        """Verify that connecting a plugin invalidates the agent graph and equips it with new tools."""
        async def _run_flow():
            # Step 1: Initialize plugin manager and agent without Gmail
            await plugin_manager.initialize()
            plugin_tools_before = [t.name for t in plugin_manager.tools]
            self.assertEqual(len(plugin_tools_before), 0, "No plugin tools should exist initially.")

            # Build initial agent (mock create_agent & LLM so no real network requests occur)
            with patch("app.agent.create_agent") as mock_create_agent, \
                 patch.object(agent_manager, "_resolve_provider", return_value="gemini"), \
                 patch.object(agent_manager, "_create_llm_by_provider", return_value=MagicMock()):
                
                mock_agent_instance = MagicMock()
                mock_create_agent.return_value = mock_agent_instance

                # Initial Agent Mode initialization
                await agent_manager._initialize_agent_async(chat_mode="agent")
                self.assertIsNotNone(agent_manager.agent, "Agent graph should be initialized.")

                # Check tools passed to create_agent call
                _, kwargs = mock_create_agent.call_args
                tools_passed_init = [getattr(t, "name", str(t)) for t in kwargs.get("tools", [])]
                self.assertFalse(any(t.startswith("gmail_") for t in tools_passed_init), "Initial agent must not have gmail tools.")

                # Step 2: User connects Gmail via OAuth
                creds = encrypt_json({"tokens": {"access_token": "mock-token", "refresh_token": "mock-refresh"}})
                save_plugin_integration(
                    plugin_id="gmail",
                    name="Gmail",
                    auth_type="oauth2",
                    status="connected",
                    encrypted_credentials=creds,
                    account_info='{"email": "user@gmail.com"}',
                    config="{}"
                )

                # Step 3: Plugin manager initializes & invalidates agent graph
                await plugin_manager.initialize()
                agent_manager.invalidate_agent()
                self.assertIsNone(agent_manager.agent, "Agent graph must be None after invalidation.")

                # Verify plugin_manager now has 10 Gmail tools
                self.assertGreaterEqual(len(plugin_manager.tools), 5)
                self.assertTrue(any(t.name == "gmail_search_emails" for t in plugin_manager.tools))

                # Step 4: Next user request re-initializes agent
                await agent_manager._initialize_agent_async(chat_mode="agent")
                self.assertIsNotNone(agent_manager.agent, "Agent graph must be re-compiled.")

                _, new_kwargs = mock_create_agent.call_args
                tools_passed_after = [getattr(t, "name", str(t)) for t in new_kwargs.get("tools", [])]
                
                self.assertIn("gmail_search_emails", tools_passed_after)
                self.assertIn("gmail_get_email", tools_passed_after)
                self.assertIn("gmail_send_email", tools_passed_after)

                # Step 5: Verify DynamicToolRoutingMiddleware exposes gmail tools for email queries
                active_domains = DynamicToolRoutingMiddleware._classify_domains("can you read gmail", set())
                self.assertIn("email", active_domains)

                filtered = DynamicToolRoutingMiddleware._filter_tools(
                    kwargs.get("tools", []) + plugin_manager.tools,
                    active_domains,
                    query="can you read gmail"
                )
                filtered_names = [getattr(t, "name", str(t)) for t in filtered]
                self.assertIn("gmail_search_emails", filtered_names)
                self.assertIn("gmail_get_email", filtered_names)

                # Step 6: Disconnect Gmail -> invalidate -> next request has no Gmail tools
                delete_plugin_integration("gmail")
                await plugin_manager.initialize()
                agent_manager.invalidate_agent()
                self.assertIsNone(agent_manager.agent)

                await agent_manager._initialize_agent_async(chat_mode="agent")
                _, final_kwargs = mock_create_agent.call_args
                tools_passed_final = [getattr(t, "name", str(t)) for t in final_kwargs.get("tools", [])]
                self.assertFalse(any(t.startswith("gmail_") for t in tools_passed_final))

        run_async(_run_flow())


if __name__ == "__main__":
    unittest.main()

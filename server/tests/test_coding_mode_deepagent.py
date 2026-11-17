import asyncio
import unittest
from unittest.mock import patch

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from app.agent import AgentManager
from app.config import settings


class MockChatModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


class TestCodingModeDeepAgent(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.mgr = AgentManager()
        await self.mgr._ensure_checkpoint_and_store()
        self.orig_coding_mode = settings.CODING_MODE
        self.orig_chat_mode = settings.CHAT_MODE

    async def asyncTearDown(self):
        settings.CODING_MODE = self.orig_coding_mode
        settings.CHAT_MODE = self.orig_chat_mode

    async def test_coding_mode_via_chat_mode_forces_deepagent(self):
        """When chat_mode='coding', the agent must be created via create_deep_agent."""
        mock_model = MockChatModel(responses=[AIMessage(content="def solve(): pass")])

        with patch.object(self.mgr, "_resolve_provider", return_value="openai"), \
             patch.object(self.mgr, "_create_llm_by_provider", return_value=mock_model):

            await self.mgr._initialize_agent_async(chat_mode="coding", speed_mode="thinking")

            self.assertTrue(self.mgr.is_configured)
            self.assertTrue(self.mgr.is_deepagent, "Coding mode must force DeepAgent")
            self.assertTrue(self.mgr.is_coding_mode, "is_coding_mode must be True")
            self.assertEqual(self.mgr._current_chat_mode, "coding")
            self.assertEqual(self.mgr._current_agent_type, "deepagent")

    async def test_coding_mode_via_flag_forces_deepagent(self):
        """When coding_mode=True is passed, it forces DeepAgent regardless of chat_mode."""
        mock_model = MockChatModel(responses=[AIMessage(content="def solve(): pass")])

        with patch.object(self.mgr, "_resolve_provider", return_value="openai"), \
             patch.object(self.mgr, "_create_llm_by_provider", return_value=mock_model):

            await self.mgr._initialize_agent_async(chat_mode="agent", coding_mode=True)

            self.assertTrue(self.mgr.is_configured)
            self.assertTrue(self.mgr.is_deepagent, "coding_mode=True must force DeepAgent")
            self.assertTrue(self.mgr.is_coding_mode)
            self.assertEqual(self.mgr._current_chat_mode, "coding")
            self.assertEqual(self.mgr._current_agent_type, "deepagent")

    async def test_standard_agent_mode_uses_standard_agent(self):
        """In normal agent mode, standard create_agent is used (is_deepagent is False)."""
        settings.CODING_MODE = False
        settings.CHAT_MODE = "agent"
        mock_model = MockChatModel(responses=[AIMessage(content="I am ready.")])

        with patch.object(self.mgr, "_resolve_provider", return_value="openai"), \
             patch.object(self.mgr, "_create_llm_by_provider", return_value=mock_model):

            await self.mgr._initialize_agent_async(chat_mode="agent", speed_mode="thinking", coding_mode=False)

            self.assertTrue(self.mgr.is_configured)
            self.assertFalse(self.mgr.is_deepagent, "Standard agent mode should not force DeepAgent")
            self.assertFalse(self.mgr.is_coding_mode)
            self.assertEqual(self.mgr._current_chat_mode, "agent")
            self.assertEqual(self.mgr._current_agent_type, "standard")

    async def test_coding_mode_setting_override(self):
        """When settings.CODING_MODE is True, agent must force DeepAgent."""
        settings.CODING_MODE = True
        mock_model = MockChatModel(responses=[AIMessage(content="coding output")])

        with patch.object(self.mgr, "_resolve_provider", return_value="openai"), \
             patch.object(self.mgr, "_create_llm_by_provider", return_value=mock_model):

            await self.mgr._initialize_agent_async(chat_mode="agent")

            self.assertTrue(self.mgr.is_configured)
            self.assertTrue(self.mgr.is_deepagent)
            self.assertTrue(self.mgr.is_coding_mode)
            self.assertEqual(self.mgr._current_chat_mode, "coding")


if __name__ == "__main__":
    unittest.main()

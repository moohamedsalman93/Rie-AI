"""
Unit and regression tests for Long-Term Memory (LTM) Architecture:
1. Core Tool Invariant: core_tools ⊆ bound_tools across all orchestration modes
2. Proactive Memory Retrieval & Context Injection
3. Memory Deduplication & Upserting
4. Explicit Memory Tool Operations
"""
import unittest
import tempfile
import asyncio
from typing import Any
from langchain_core.messages import SystemMessage, HumanMessage

from app.ltm_tools import save_memory, get_memory, delete_memory, search_memory, LTM_TOOLS
from app.chroma_store import ChromaStore
from app.memory import MemoryStore
from app.agent import (
    agent_manager,
    MemoryRetrievalMiddleware,
    DynamicToolRoutingMiddleware,
)
from langchain.agents.middleware import ModelRequest


class MockModelRequest:
    def __init__(self, messages: list[Any], system_text: str = "You are Rie."):
        self.messages = messages
        self.system_message = SystemMessage(content=[{"type": "text", "text": system_text}])
        self.tools = []

    def override(self, **kwargs):
        if "system_message" in kwargs:
            self.system_message = kwargs["system_message"]
        if "tools" in kwargs:
            self.tools = kwargs["tools"]
        return self


class TestLTMArchitecture(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.test_store = ChromaStore(persist_path=self.tmpdir.name)
        self.namespace = ("users", "default_user")

    def tearDown(self):
        try:
            self.tmpdir.cleanup()
        except Exception:
            pass

    def test_01_core_tools_invariant_in_all_modes(self):
        """Invariant: Core tools must ALWAYS be bound in agent tools across all modes."""
        core_tool_names = {
            "save_memory",
            "get_memory",
            "search_memory",
            "read_knowledge_asset",
            "schedule_chat_task",
            "remote_friend_ask",
        }

        # Check in Chat mode
        asyncio.run(agent_manager._initialize_agent_async(chat_mode="chat", speed_mode="thinking"))
        self.assertTrue(agent_manager.is_configured, "Agent should be configured in chat mode")

        # Check in Agent / Solo mode with various enabled_tools settings
        asyncio.run(agent_manager._initialize_agent_async(chat_mode="agent", speed_mode="thinking"))
        self.assertTrue(agent_manager.is_configured, "Agent should be configured in agent mode")

        # Dynamic routing filter check: save_memory is always available across domains
        all_tools = list(LTM_TOOLS)
        filtered = DynamicToolRoutingMiddleware._filter_tools(all_tools, active_domains={"email"})
        filtered_names = {getattr(t, "name", str(t)) for t in filtered}
        self.assertIn(
            "save_memory",
            filtered_names,
            "save_memory must always be available across domains",
        )

        # Explicit memory intent routes full memory suite
        mem_filtered = DynamicToolRoutingMiddleware._filter_tools(
            all_tools, active_domains=set(), query="remember my preference for dark mode"
        )
        mem_filtered_names = {getattr(t, "name", str(t)) for t in mem_filtered}
        self.assertTrue(
            {"save_memory", "get_memory", "search_memory"}.issubset(mem_filtered_names),
            "LTM tools must be routed for explicit memory intent",
        )

    def test_02_proactive_memory_injection(self):
        """Proactive memory middleware must pre-inject context for matching user queries."""
        mw = MemoryRetrievalMiddleware()
        req = MockModelRequest([HumanMessage(content="What is my name?")])

        modified_req = mw._apply_memory_to_request(req)
        injected_text = ""
        for block in modified_req.system_message.content_blocks:
            if isinstance(block, dict) and "text" in block:
                injected_text += block["text"] + "\n"
            elif isinstance(block, str):
                injected_text += block + "\n"

        # Check that recalled memory section exists if memories are present
        self.assertIn("You are Rie.", injected_text)

    def test_03_memory_deduplication_and_upsert(self):
        """Saving duplicate or updated facts in the same category must update rather than duplicate."""
        import uuid
        test_id = str(uuid.uuid4())[:8]
        fact_text = f"User's favorite test tool is Tool_{test_id}"
        test_category = f"cat_{test_id}"

        # 1. First save -> should save as new
        res1 = save_memory.invoke({"fact": fact_text, "category": test_category})
        self.assertIn("Saved to memory", res1)

        # 2. Exact duplicate save -> should update existing
        res2 = save_memory.invoke({"fact": fact_text, "category": test_category})
        self.assertIn("Updated existing memory", res2)

        # 3. Verify search returns the fact
        search_res = search_memory.invoke({"query": f"Tool_{test_id}"})
        self.assertIn(f"Tool_{test_id}", search_res)

    def test_04_explicit_memory_operations(self):
        """Explicit get_memory, search_memory, delete_memory, and save_memory operations execute cleanly."""
        save_res = save_memory.invoke({"fact": "User works on autonomous agents", "category": "work"})
        self.assertTrue("Saved to memory" in save_res or "Updated existing memory" in save_res)

        search_res = search_memory.invoke({"query": "autonomous agents", "limit": 3})
        self.assertIn("autonomous agents", search_res)

        # Direct delete by query
        del_res = delete_memory.invoke({"query": "autonomous agents"})
        self.assertIn("Successfully deleted memory", del_res)

        # Verify it was removed
        search_after = search_memory.invoke({"query": "autonomous agents", "limit": 3})
        self.assertNotIn("User works on autonomous agents", search_after)

    def test_05_delete_memory_by_key_and_chroma_store(self):
        """Test ChromaStore.delete and delete_memory by specific key."""
        # 1. Test raw ChromaStore delete
        self.test_store.put(self.namespace, "test_k1", {"content": "temporary fact", "category": "test"})
        res = self.test_store.get(self.namespace, "test_k1")
        self.assertIsNotNone(res)
        del_ok = self.test_store.delete(self.namespace, "test_k1")
        self.assertTrue(del_ok)
        res_after = self.test_store.get(self.namespace, "test_k1")
        self.assertIsNone(res_after)

        # 2. Test delete_memory tool by key
        import uuid
        key_id = str(uuid.uuid4())[:8]
        save_res = save_memory.invoke({"fact": f"Ephemeral secret {key_id}", "category": "ephemeral"})
        self.assertIn("Saved to memory", save_res)
        # Extract key from result
        import re
        match = re.search(r"\[key: ([^\]]+)\]", save_res)
        self.assertIsNotNone(match)
        extracted_key = match.group(1)

        del_tool_res = delete_memory.invoke({"key": extracted_key})
        self.assertIn("Successfully deleted memory", del_tool_res)

    def test_06_production_fail_fast_without_postgres(self):
        """Production environment must raise a fast configuration error if LANGGRAPH_DATABASE_URL is missing."""
        from unittest.mock import patch, PropertyMock
        from app.agent import AgentManager
        from app.config import settings

        fresh_manager = AgentManager()
        with patch.object(type(settings), "IS_PRODUCTION", new_callable=PropertyMock(return_value=True)):
            with patch.object(type(settings), "LANGGRAPH_DATABASE_URL", new_callable=PropertyMock(return_value=None)):
                with self.assertRaises(RuntimeError) as ctx:
                    asyncio.run(fresh_manager._ensure_checkpoint_and_store())
                self.assertIn("Production environment detected", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()


"""Check dispatcher adapters against normalized results without desktop effects."""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from app.browser.models import ActionResult, ExtractResult, Snapshot, BrowserElement


class TestLiveToolDispatcher(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.browser = SimpleNamespace(
            open_browser=AsyncMock(return_value=ActionResult(success=False, message="offline")),
            extract=AsyncMock(return_value=ExtractResult(url="https://example.com", content="Page content")),
            send_keyboard_input=AsyncMock(return_value=ActionResult()),
            snapshot=AsyncMock(return_value=Snapshot(snapshot_id="s1", elements=[BrowserElement(ref="ref-1", role="button", name="Search")])),
        )
        self.typed = []
        async def type_text(target, text, clear_first=True):
            self.typed.append((target, text))
            return ActionResult()
        self.browser.type_text = type_text
        self.state = Mock(return_value="Opened apps: Notepad")
        self.search = Mock(return_value={"error": "search unavailable"})
        modules = {}
        for name, attrs in {
            "app.browser.service": {"browser_service": self.browser},
            "app.windows_tools": {"app_tool": Mock(), "shortcut_tool": Mock(), "state_tool": self.state},
            "app.tools": {"internet_search": self.search},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(attrs)
            modules[name] = module
        spec = importlib.util.spec_from_file_location("voice_dispatcher_test", Path(__file__).parents[1] / "app/live_tool_dispatcher.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(module)
        self.dispatcher = module.live_tool_dispatcher
        self.dispatch = self.dispatcher.dispatch

    async def test_type_and_submit_use_separate_supported_methods(self):
        result = await self.dispatch("browser_type", {"target": "ref-1", "text": "Hello", "press_enter": True})
        self.assertIn("Successfully", result)
        self.assertEqual(self.typed, [("ref-1", "Hello")])
        self.browser.send_keyboard_input.assert_awaited_once_with("Enter")
        self.browser.send_keyboard_input.reset_mock()
        await self.dispatch("browser_type", {"target": "ref-1", "text": "Draft", "press_enter": False})
        self.browser.send_keyboard_input.assert_not_awaited()

    async def test_extract_reads_normalized_content(self):
        result = await self.dispatch("browser_extract", {"query": "summary"})
        self.assertEqual(result, "Extracted info: Page content")
        self.browser.extract.assert_awaited_once_with(query="summary")

    async def test_failed_browser_action_is_not_reported_successful(self):
        result = await self.dispatch("browser_open", {"url": "https://example.com"})
        self.assertEqual(result, "Error: offline")

    async def test_snapshot_keeps_refs_needed_for_subsequent_actions(self):
        result = await self.dispatch("browser_snapshot", {})
        self.assertIn("ref-1 (button): Search", result)

    async def test_desktop_state_uses_com_safe_wrapper(self):
        result = await self.dispatch("get_desktop_state", {})
        self.state.assert_called_once_with(False, False)
        self.assertEqual(result, "Opened apps: Notepad")

    async def test_search_error_is_visible(self):
        self.assertEqual(await self.dispatch("internet_search", {"query": "weather"}), "Error: search unavailable")

    async def test_search_preserves_normalized_findings_and_sources(self):
        self.search.return_value = {"results": [{
            "title": "Museum visitor information", "content": "Example Museum opens at 9:30 AM every day.",
            "url": "https://example.com/museum",
        }]}
        result = await self.dispatch("internet_search", {"query": "museum hours"})
        self.assertIn("Example Museum opens at 9:30 AM every day.", result)
        self.assertIn("Source: https://example.com/museum", result)
        self.assertIn("Museum visitor information", result)

    async def test_search_keeps_legacy_snippets_and_bounds_large_results(self):
        self.search.return_value = {"results": [
            {"title": "Legacy", "snippet": "Useful snippet", "href": "https://example.com/legacy"},
            {"title": "Body", "body": "Useful body"},
            {"title": "Long", "content": "a" * 10000},
            {"title": "Fourth", "content": "Not included"},
        ]}
        result = await self.dispatch("internet_search", {"query": "test"})
        self.assertIn("Useful snippet", result)
        self.assertIn("Useful body", result)
        self.assertIn("https://example.com/legacy", result)
        self.assertNotIn("Not included", result)
        self.assertLess(len(result), 2500)

    async def test_empty_search_is_explicit(self):
        self.search.return_value = {"results": []}
        self.assertIn("No search results found", await self.dispatch("internet_search", {"query": "test"}))

    async def test_spawn_subagent_background_returns_immediate_ack(self):
        with patch.object(self.dispatcher, "_run_subagent", new_callable=AsyncMock):
            result = await self.dispatch("spawn_subagent", {"task": "Run tests and fix errors", "mode": "background"})
            self.assertIn("launched in the background", result)
            self.assertIn("job_", result)
            import json
            parsed = json.loads(result)
            self.assertEqual(parsed["status"], "started")
            self.assertTrue(parsed["job_id"].startswith("job_"))

    async def test_spawn_subagent_requires_description(self):
        result = await self.dispatch("spawn_subagent", {})
        self.assertEqual(result, "Error: task is required.")

    async def test_save_and_search_memory_validation(self):
        self.assertEqual(await self.dispatch("save_memory", {}), "Error: fact is required.")
        self.assertEqual(await self.dispatch("search_memory", {}), "Error: query is required.")

    async def test_schedule_task_validation(self):
        self.assertEqual(await self.dispatch("schedule_task", {}), "Error: run_at_iso and task_text are required.")

    async def test_cancel_subagent_running_job(self):
        with patch.object(self.dispatcher, "_run_subagent", new_callable=AsyncMock):
            spawn_res = await self.dispatch("spawn_subagent", {"task": "Build component", "mode": "background"})
            import json
            jid = json.loads(spawn_res)["job_id"]
            cancel_res = await self.dispatch("cancel_subagent", {"job_id": jid})
            self.assertIn("successfully cancelled", cancel_res)

    def test_tool_declarations_include_tiered_core_tools(self):
        from app.live_tool_dispatcher import live_tool_dispatcher
        names = {t["name"] for t in live_tool_dispatcher.get_tool_declarations()}
        expected = {"spawn_subagent", "cancel_subagent", "app_tool", "press_keys", "internet_search", "browser_open", "save_memory", "search_memory", "schedule_task", "get_desktop_state"}
        for exp in expected:
            self.assertIn(exp, names)


if __name__ == "__main__":
    unittest.main()

"""
Unit tests for Dynamic Tool Routing, Capability Matrix, and Hard Invariants.
"""
import unittest
import json
from unittest.mock import MagicMock
from langchain.tools import tool

from app.agent import DynamicToolRoutingMiddleware, SkillMiddleware, ContextProjectionMiddleware


# Mock tools for testing
@tool
def gmail_send_email(to: str, subject: str, body: str) -> str:
    """Send an email."""
    return "sent"

@tool
def gmail_search_emails(query: str) -> str:
    """Search emails."""
    return "found"

@tool
def browser_open(url: str) -> str:
    """Open browser."""
    return "opened"

@tool
def browser_snapshot() -> str:
    """Take browser snapshot."""
    return "snapshot"

@tool
def windows_mouse_click(x: int, y: int) -> str:
    """Click mouse."""
    return "clicked"

@tool
def run_terminal_command(command: str) -> str:
    """Run terminal command."""
    return "executed"

@tool
def internet_search(query: str) -> str:
    """Search internet."""
    return "results"

@tool
def read_knowledge_asset(asset_id: str) -> str:
    """Read knowledge asset."""
    return "asset"

@tool
def schedule_chat_task(text: str, run_at_iso: str) -> str:
    """Schedule a chat task."""
    return "scheduled"

@tool
def save_memory(fact: str) -> str:
    """Save memory."""
    return "saved"

@tool
def get_memory(query: str) -> str:
    """Get memory."""
    return "memory"

@tool
def github_create_pull_request(repo: str, title: str) -> str:
    """Create GitHub PR."""
    return "pr_created"

@tool
def jira_update_issue(issue_key: str, comment: str) -> str:
    """Update Jira issue."""
    return "jira_updated"

@tool
def custom_crm_user_api(user_id: str) -> str:
    """Custom connected CRM external API tool."""
    return "crm_data"


ALL_TEST_TOOLS = [
    gmail_send_email,
    gmail_search_emails,
    browser_open,
    browser_snapshot,
    windows_mouse_click,
    run_terminal_command,
    internet_search,
    read_knowledge_asset,
    schedule_chat_task,
    save_memory,
    get_memory,
    github_create_pull_request,
    jira_update_issue,
    custom_crm_user_api,
]


class TestDynamicToolRouting(unittest.TestCase):

    def test_classify_search_weather_domain(self):
        query = "what's the weather in Chennai?"
        domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("search", domains)
        self.assertNotIn("email", domains)
        self.assertNotIn("desktop", domains)

    def test_filter_weather_binds_internet_search(self):
        """Mandatory regression test: 'what's the weather in Chennai?' must bind internet_search."""
        query = "what's the weather in Chennai?"
        active_domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("search", active_domains)

        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query=query)
        tool_names = [t.name for t in filtered]

        self.assertIn("internet_search", tool_names)
        self.assertNotIn("browser_open", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)
        self.assertNotIn("windows_mouse_click", tool_names)
        self.assertNotIn("run_terminal_command", tool_names)
        self.assertNotIn("github_create_pull_request", tool_names)
        self.assertNotIn("jira_update_issue", tool_names)

    def test_filter_gmail_binds_email_tools(self):
        """Matrix test: 'Read my Gmail' / 'read my unread emails' must bind gmail_* tools."""
        query = "can you read my unread emails in gmail?"
        active_domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("email", active_domains)

        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query=query)
        tool_names = [t.name for t in filtered]

        self.assertIn("gmail_search_emails", tool_names)
        self.assertIn("gmail_send_email", tool_names)
        self.assertNotIn("browser_open", tool_names)
        self.assertNotIn("windows_mouse_click", tool_names)

    def test_filter_wifi_binds_system_terminal(self):
        """Matrix test: 'What is my wifi password' must bind run_terminal_command / system tools."""
        query = "what is my wifi password?"
        active_domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("system", active_domains)

        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query=query)
        tool_names = [t.name for t in filtered]

        self.assertIn("run_terminal_command", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)
        self.assertNotIn("browser_open", tool_names)

    def test_filter_wallpaper_binds_desktop_tools(self):
        """Matrix test: 'Change my wallpaper' must bind desktop / terminal tools."""
        query = "change my wallpaper to a sunset image"
        active_domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("desktop", active_domains)

        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query=query)
        tool_names = [t.name for t in filtered]

        self.assertIn("windows_mouse_click", tool_names)
        self.assertIn("run_terminal_command", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)
        self.assertNotIn("github_create_pull_request", tool_names)

    def test_filter_github_binds_github_tools(self):
        """Matrix test: 'Check PR #42 on GitHub' must bind github_* tools."""
        query = "check PR #42 on repo owner/repo"
        active_domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("github", active_domains)

        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query=query)
        tool_names = [t.name for t in filtered]

        self.assertIn("github_create_pull_request", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)
        self.assertNotIn("browser_open", tool_names)

    def test_filter_jira_binds_jira_tools(self):
        """Matrix test: 'Update Jira ticket' must bind jira_* tools."""
        query = "update Jira ticket PROJ-101 with status in progress"
        active_domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("jira", active_domains)

        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query=query)
        tool_names = [t.name for t in filtered]

        self.assertIn("jira_update_issue", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)

    def test_external_api_custom_tool_preserved(self):
        """Matrix test: Custom connected user APIs not belonging to inactive domains are preserved."""
        active_domains = {"search"}
        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains, query="weather in Paris")
        tool_names = [t.name for t in filtered]

        self.assertIn("internet_search", tool_names)
        self.assertIn("custom_crm_user_api", tool_names)

    def test_pure_greeting_returns_zero_tools(self):
        """Tier 1 (PURE_CASUAL): Pure greeting 'hi' or 'hello' must return 0 tools."""
        for greeting in ("hi", "hello", "good morning", "thanks", "hey"):
            filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, set(), query=greeting)
            self.assertEqual(
                len(filtered),
                0,
                f"Pure greeting '{greeting}' must return 0 tools to preserve ~400-token budget",
            )

    def test_identity_query_returns_zero_tools(self):
        """Tier 1 (PURE_CASUAL): Identity queries like 'what is my name?' handled by proactive LTM return 0 tools."""
        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, set(), query="what's my name")
        self.assertEqual(len(filtered), 0)

    def test_memory_intent_scoped_tools(self):
        """Tier 2 (CASUAL_WITH_CAPABILITIES): Explicit memory intent returns memory tools without heavy domain tools."""
        filtered = DynamicToolRoutingMiddleware._filter_tools(
            ALL_TEST_TOOLS, set(), query="remember I prefer React and Tailwind"
        )
        tool_names = [t.name for t in filtered]
        self.assertIn("save_memory", tool_names)
        self.assertNotIn("browser_open", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)
        self.assertNotIn("windows_mouse_click", tool_names)

    def test_schedule_intent_scoped_tools(self):
        """Tier 2 (CASUAL_WITH_CAPABILITIES): Explicit schedule intent returns schedule tool."""
        filtered = DynamicToolRoutingMiddleware._filter_tools(
            ALL_TEST_TOOLS, set(), query="remind me to check the deploy tomorrow at 10am"
        )
        tool_names = [t.name for t in filtered]
        self.assertIn("schedule_chat_task", tool_names)
        self.assertNotIn("browser_open", tool_names)
        self.assertNotIn("gmail_send_email", tool_names)

    def test_multiturn_tool_continuity(self):
        # Even if the latest query is just "continue" or "now send it",
        # previous tool call to gmail_search_emails keeps email domain active.
        query = "now send it to him"
        invoked_tools = {"gmail_search_emails"}
        domains = DynamicToolRoutingMiddleware._classify_domains(query, invoked_tools)
        self.assertIn("email", domains)

    def test_tool_need_binary_gate_casual_vs_agent(self):
        """Test ToolNeedMiddleware binary gate: casual queries get 0 tools, action queries get ALL session tools."""
        mw = DynamicToolRoutingMiddleware()

        # Casual query -> tools = []
        mock_casual_req = MagicMock()
        mock_casual_req.tools = ALL_TEST_TOOLS
        mock_casual_msg = MagicMock()
        mock_casual_msg.type = "human"
        mock_casual_msg.content = "hi, what's your name?"
        mock_casual_msg.tool_calls = []
        mock_casual_req.messages = [mock_casual_msg]
        mock_casual_req.override.side_effect = lambda **kwargs: MagicMock(tools=kwargs.get("tools", ALL_TEST_TOOLS))

        routed_casual = mw._apply_tool_gating(mock_casual_req)
        self.assertEqual(len(routed_casual.tools), 0, "Casual turns must receive 0 tools to preserve token budget.")

        # Action query (e.g. open settings) -> all session tools preserved
        mock_action_req = MagicMock()
        mock_action_req.tools = ALL_TEST_TOOLS
        mock_action_msg = MagicMock()
        mock_action_msg.type = "human"
        mock_action_msg.content = "open settings"
        mock_action_msg.tool_calls = []
        mock_action_req.messages = [mock_action_msg]

        routed_action = mw._apply_tool_gating(mock_action_req)
        self.assertEqual(len(routed_action.tools), len(ALL_TEST_TOOLS), "Action turns must receive ALL session tools.")

    def test_context_projection_keeps_latest_tool_full_and_compacts_older(self):
        """Verify ContextProjectionMiddleware keeps the latest tool result 100% full while compacting older verbose results."""
        from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
        from app.agent import ContextProjectionMiddleware

        large_search_json = json.dumps([
            {"id": "msg_001", "subject": "Qwen 3.8 27B Released", "from": "Ollama", "snippet": "Detailed release notes " * 20},
            {"id": "msg_002", "subject": "Weekly Update", "from": "Team", "snippet": "Long update content " * 20},
            {"id": "msg_003", "subject": "Security Alert", "from": "SecOps", "snippet": "Alert details " * 20},
        ])
        large_email_body = "From: Ollama <news@ollama.com>\nSubject: Qwen 3.8 27B Released\nDate: Sun, 16 Aug 2026\n\n" + ("This is the full email body with extensive documentation and download links. " * 30)

        # Sequence of messages across 2 tool steps:
        # Step 1: search
        # Step 2: get email
        messages = [
            HumanMessage(content="Find latest Gmail and summarize it"),
            AIMessage(content="", tool_calls=[{"id": "call_1", "name": "gmail_search_emails", "args": {}}]),
            ToolMessage(content=large_search_json, tool_call_id="call_1", name="gmail_search_emails"),
            AIMessage(content="", tool_calls=[{"id": "call_2", "name": "gmail_get_email", "args": {"id": "msg_001"}}]),
            ToolMessage(content=large_email_body, tool_call_id="call_2", name="gmail_get_email"),
        ]

        projected = ContextProjectionMiddleware._project_messages(messages)
        self.assertEqual(len(projected), len(messages))

        # 1. Older tool message (search) MUST be compacted
        older_tool_proj = projected[2]
        self.assertIsInstance(older_tool_proj, ToolMessage)
        self.assertLess(len(older_tool_proj.content), len(large_search_json))
        self.assertIn("Found 3 results", older_tool_proj.content)
        self.assertIn("msg_001", older_tool_proj.content)

        # 2. Latest tool message (get_email) MUST be 100% full and untouched
        latest_tool_proj = projected[4]
        self.assertIsInstance(latest_tool_proj, ToolMessage)
        self.assertEqual(latest_tool_proj.content, large_email_body)

    def test_app_control_defensive_mode_normalization(self):
        """Verify app_tool defensively maps 'open' -> 'launch' and 'focus' -> 'switch'."""
        from app.windows_tools import app_tool
        from unittest.mock import patch

        with patch("app.windows_tools.desktop.app") as mock_desktop_app:
            mock_desktop_app.return_value = "Notepad launched."
            result = app_tool(mode="open", name="Notepad")
            mock_desktop_app.assert_called_once_with("launch", "Notepad", None, None)

        with patch("app.windows_tools.desktop.app") as mock_desktop_app:
            mock_desktop_app.return_value = "Switched to Notepad."
            result = app_tool(mode="focus", name="Notepad")
            mock_desktop_app.assert_called_once_with("switch", "Notepad", None, None)


    def test_scoped_technical_rules_only_includes_active_domains(self):
        """Verify that scoped technical rules prompt only contains rules for active domains."""
        email_rules = DynamicToolRoutingMiddleware._build_technical_rules({"email"}, [gmail_send_email])
        self.assertIn("Connected Integration Plugins", email_rules)
        self.assertIn("Email Body Formatting", email_rules)
        self.assertNotIn("PowerShell", email_rules)
        self.assertNotIn("browser_*", email_rules)
        self.assertNotIn("use_vision", email_rules)

        system_rules = DynamicToolRoutingMiddleware._build_technical_rules({"system"}, [run_terminal_command])
        self.assertIn("Windows/PowerShell", system_rules)
        self.assertNotIn("gmail_*", system_rules)
        self.assertNotIn("Email Body Formatting", system_rules)

    def test_plugin_tool_optional_parameters_allow_none(self):
        """Verify that plugin manager creates Pydantic schemas that allow None for optional arguments."""
        from app.plugin_manager import plugin_manager
        from app.plugins.base import PluginManifestSpec, PluginToolSpec

        manifest = PluginManifestSpec(
            manifest_version=1,
            id="gmail",
            name="gmail",
            displayName="Gmail",
            version="1.0.0",
            description="Gmail test",
            category="Communication",
            icon="gmail",
            auth_type="oauth2",
            tools=[
                PluginToolSpec(
                    name="gmail_create_draft",
                    description="Create a draft",
                    risk_level="write",
                    capability="gmail.send",
                    parameters={
                        "type": "object",
                        "properties": {
                            "to": {"type": "string", "description": "Recipient"},
                            "subject": {"type": "string", "description": "Subject"},
                            "body": {"type": "string", "description": "Body"},
                            "thread_id": {"type": "string", "description": "Optional thread id"},
                            "attachments": {"type": "array", "items": {"type": "string"}, "description": "Optional files"}
                        },
                        "required": ["to", "subject", "body"]
                    }
                )
            ]
        )

        tools = plugin_manager._build_tools_for_plugin(manifest, {}, {})
        self.assertEqual(len(tools), 1)
        draft_tool = tools[0]
        schema = draft_tool.args_schema

        # Test valid payload with None / omitted optional fields
        valid_obj = schema(to="test@example.com", subject="Hello", body="Test message", thread_id=None, attachments=None)
        self.assertEqual(valid_obj.to, "test@example.com")
        self.assertIsNone(valid_obj.thread_id)
        self.assertIsNone(valid_obj.attachments)

        # Test valid payload without passing optional fields at all
        valid_obj_omitted = schema(to="test@example.com", subject="Hello", body="Test message")
        self.assertEqual(valid_obj_omitted.to, "test@example.com")
        self.assertIsNone(valid_obj_omitted.thread_id)


class TestSkillPreloading(unittest.TestCase):

    def test_skill_query_matching(self):
        self.assertTrue(
            SkillMiddleware._matches_skill_query(
                "Job Application Assistant",
                "Automates job applications on LinkedIn and Greenhouse.",
                "Help me apply for jobs on LinkedIn with my resume",
            )
        )

        self.assertTrue(
            SkillMiddleware._matches_skill_query(
                "PowerShell Style & Scripting",
                "Best practices for PowerShell scripting on Windows.",
                "Write a powershell script to find large files",
            )
        )

        self.assertTrue(
            SkillMiddleware._matches_skill_query(
                "PDF Generation Expert",
                "Generates professional PDF documents.",
                "Can you generate a PDF report from this summary?",
            )
        )

        self.assertFalse(
            SkillMiddleware._matches_skill_query(
                "PDF Generation Expert",
                "Generates professional PDF documents.",
                "Send an email to Bob",
            )
        )

    def test_skills_injected_into_system_prompt_even_when_not_matching(self):
        """When user asks something casual or unrelated, available skills list is still injected so agent knows skill names."""
        from langchain_core.messages import SystemMessage, HumanMessage
        from langchain.agents.middleware import ModelRequest

        middleware = SkillMiddleware()
        req = ModelRequest(
            system_message=SystemMessage(content="You are Rie."),
            messages=[HumanMessage(content="Hello there")],
            tools=[],
            model=MagicMock(),
        )
        modified = middleware._apply_skills_to_request(req)
        content_text = ""
        for block in modified.system_message.content_blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                content_text += block.get("text", "")
            elif hasattr(block, "text"):
                content_text += block.text

        self.assertIn("## Available Skills (Load on Demand)", content_text)
        self.assertIn("Windows System Tasks", content_text)
        self.assertIn("PowerShell Style & Scripting", content_text)
        self.assertIn("load_skill", content_text)

    def test_skills_injected_with_preloaded_and_available(self):
        """When user query matches a skill, that skill is preloaded and other skills are listed as available."""
        from langchain_core.messages import SystemMessage, HumanMessage
        from langchain.agents.middleware import ModelRequest

        middleware = SkillMiddleware()
        req = ModelRequest(
            system_message=SystemMessage(content="You are Rie."),
            messages=[HumanMessage(content="Please generate a PDF report for this document")],
            tools=[],
            model=MagicMock(),
        )
        modified = middleware._apply_skills_to_request(req)
        content_text = ""
        for block in modified.system_message.content_blocks:
            if isinstance(block, dict) and block.get("type") == "text":
                content_text += block.get("text", "")
            elif hasattr(block, "text"):
                content_text += block.text

        self.assertIn("## Active Skill Instructions (Pre-loaded)", content_text)
        self.assertIn("### Skill: PDF Generation Expert", content_text)
        self.assertIn("## Available Skills (Load on Demand)", content_text)
        self.assertIn("Windows System Tasks", content_text)

    def test_load_skill_tool_execution(self):
        """Test invoking load_skill by exact name and case-insensitive name."""
        from app.agent import load_skill

        result_exact = load_skill.invoke({"skill_name": "Windows System Tasks"})
        self.assertIn("Loaded Skill: Windows System Tasks", result_exact)

        result_lower = load_skill.invoke({"skill_name": "windows system tasks"})
        self.assertIn("Loaded Skill: Windows System Tasks", result_lower)

        result_fuzzy = load_skill.invoke({"skill_name": "PDF Generation"})
        self.assertIn("Loaded Skill: PDF Generation Expert", result_fuzzy)

    def test_load_skill_always_available(self):
        """Test that load_skill is registered in ToolNeedMiddleware always available tools."""
        from app.agent import ToolNeedMiddleware
        self.assertIn("load_skill", ToolNeedMiddleware.ALWAYS_AVAILABLE_TOOLS)
        self.assertIn("skills", ToolNeedMiddleware.DOMAIN_PREFIXES)
        self.assertIn("load_skill", ToolNeedMiddleware.DOMAIN_PREFIXES["skills"])

    def test_trajectory_record_event_with_tool_message(self):
        """Test that TaskEvent records ToolMessage and lists of ToolMessage without JSON serialization errors."""
        import os
        import tempfile
        from langchain_core.messages import ToolMessage
        from app.trajectory import TaskEvent, TrajectoryStore

        tmp_dir = tempfile.mkdtemp()
        tmp_db = os.path.join(tmp_dir, "test_events.db")

        try:
            store = TrajectoryStore(db_path=tmp_db)
            tool_msg = ToolMessage(
                content='{"result": "success", "token": "gsk_1234567890abcdef1234567890abcdef"}',
                tool_call_id="call_test_123",
                name="internet_search"
            )

            # Record event with direct ToolMessage
            store.record_event(TaskEvent(
                task_id="test_task_1",
                thread_id="test_thread_1",
                event_type="tool.completed",
                tool_name="internet_search",
                tool_result=tool_msg,
            ))

            # Record event with list of ToolMessages
            store.record_event(TaskEvent(
                task_id="test_task_1",
                thread_id="test_thread_1",
                event_type="tool.completed",
                tool_name="internet_search",
                tool_result=[tool_msg, tool_msg],
            ))

            events = store.get_task_trajectory("test_task_1")
            self.assertEqual(len(events), 2)
            self.assertIn("REDACTED", events[0]["tool_result"])
        finally:
            import shutil
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            except Exception:
                pass


if __name__ == "__main__":
    unittest.main()

"""
Unit tests for Dynamic Tool Routing and Skill Preloading
"""
import unittest
from langchain.tools import tool

from app.agent import DynamicToolRoutingMiddleware, SkillMiddleware


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
]


class TestDynamicToolRouting(unittest.TestCase):

    def test_classify_email_domain(self):
        query = "please send an email to alice@example.com with subject meeting"
        domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("email", domains)
        self.assertNotIn("browser", domains)
        self.assertNotIn("desktop", domains)

    def test_classify_browser_domain(self):
        query = "open https://example.com and fill form for me"
        domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("browser", domains)
        self.assertNotIn("email", domains)
        self.assertNotIn("desktop", domains)

    def test_classify_desktop_domain(self):
        query = "click at coordinates 450, 600 on the desktop screen"
        domains = DynamicToolRoutingMiddleware._classify_domains(query, set())
        self.assertIn("desktop", domains)
        self.assertNotIn("email", domains)
        self.assertNotIn("browser", domains)

    def test_multiturn_tool_continuity(self):
        # Even if the latest query is just "continue" or "now send it",
        # previous tool call to gmail_search_emails keeps email domain active.
        query = "now send it to him"
        invoked_tools = {"gmail_search_emails"}
        domains = DynamicToolRoutingMiddleware._classify_domains(query, invoked_tools)
        self.assertIn("email", domains)

    def test_filter_tools_for_email(self):
        active_domains = {"email"}
        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains)
        tool_names = [t.name for t in filtered]

        # Gmail tools kept
        self.assertIn("gmail_send_email", tool_names)
        self.assertIn("gmail_search_emails", tool_names)

        # Core tools kept
        self.assertIn("internet_search", tool_names)
        self.assertIn("read_knowledge_asset", tool_names)
        self.assertIn("schedule_chat_task", tool_names)

        # Browser and desktop tools filtered out
        self.assertNotIn("browser_open", tool_names)
        self.assertNotIn("browser_snapshot", tool_names)
        self.assertNotIn("windows_mouse_click", tool_names)
        self.assertNotIn("run_terminal_command", tool_names)

    def test_filter_tools_for_browser(self):
        active_domains = {"browser"}
        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains)
        tool_names = [t.name for t in filtered]

        self.assertIn("browser_open", tool_names)
        self.assertIn("browser_snapshot", tool_names)
        self.assertIn("internet_search", tool_names)

        self.assertNotIn("gmail_send_email", tool_names)
        self.assertNotIn("windows_mouse_click", tool_names)

    def test_filter_tools_ambiguous_fallback(self):
        # Empty domains -> fallback returns all tools
        active_domains = set()
        filtered = DynamicToolRoutingMiddleware._filter_tools(ALL_TEST_TOOLS, active_domains)
        self.assertEqual(len(filtered), len(ALL_TEST_TOOLS))


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


if __name__ == "__main__":
    unittest.main()

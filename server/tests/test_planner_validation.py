import json
import unittest
from fastapi.testclient import TestClient
from main import app
from app.routes import _get_runtime_tool_catalog_ids, _validate_planner_graph

class TestPlannerValidation(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_runtime_tool_catalog_includes_browser_and_core_tools(self):
        catalog = _get_runtime_tool_catalog_ids()
        # Check browser tools
        self.assertIn("browser_open", catalog)
        self.assertIn("browser_snapshot", catalog)
        self.assertIn("browser_click", catalog)
        self.assertIn("browser_navigate", catalog)
        self.assertIn("browser_close", catalog)
        # Check core tools
        self.assertIn("internet_search", catalog)
        self.assertIn("ask_question", catalog)
        self.assertIn("read_knowledge_asset", catalog)
        self.assertIn("load_skill", catalog)
        self.assertIn("execute_batched_plan", catalog)
        self.assertIn("run_terminal_command", catalog)

    def test_planner_tools_endpoint(self):
        response = self.client.get("/planner/tools")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("tools", data)
        self.assertGreater(len(data["tools"]), 0)

        tool_ids = {t["id"] for t in data["tools"]}
        self.assertIn("browser_open", tool_ids)
        self.assertIn("internet_search", tool_ids)
        self.assertIn("ask_question", tool_ids)
        self.assertIn("run_terminal_command", tool_ids)

    def test_validate_planner_graph_with_browser_tools(self):
        valid_graph = {
            "main_node_id": "main_agent",
            "main_label": "Rie",
            "main_tool_ids": ["internet_search", "browser_open"],
            "main_instruction": "Delegate tasks efficiently.",
            "nodes": [
                {
                    "id": "sub_1",
                    "name": "coding_specialist",
                    "description": "Code specialist",
                    "system_prompt": "You write code.",
                    "tool_ids": ["run_terminal_command"],
                    "enabled": True,
                    "position": {"x": 360, "y": 120}
                },
                {
                    "id": "sub_2",
                    "name": "mcp_registry",
                    "description": "MCP agent",
                    "system_prompt": "You handle MCP.",
                    "tool_ids": ["list_mcp_servers"],
                    "enabled": True,
                    "position": {"x": 360, "y": 300}
                },
                {
                    "id": "sub_3",
                    "name": "web_researcher",
                    "description": "Web browsing agent",
                    "system_prompt": "You browse and scrape sites.",
                    "tool_ids": ["browser_open", "browser_snapshot", "browser_click"],
                    "enabled": True,
                    "position": {"x": 360, "y": 480}
                }
            ],
            "edges": [
                {"source": "main_agent", "target": "sub_1"},
                {"source": "main_agent", "target": "sub_2"},
                {"source": "main_agent", "target": "sub_3"}
            ]
        }

        validated = _validate_planner_graph(json.dumps(valid_graph))
        self.assertEqual(validated["main_node_id"], "main_agent")
        self.assertEqual(len(validated["nodes"]), 3)
        researcher = next(n for n in validated["nodes"] if n["name"] == "web_researcher")
        self.assertIn("browser_open", researcher["tool_ids"])
        self.assertIn("browser_snapshot", researcher["tool_ids"])

if __name__ == "__main__":
    unittest.main()

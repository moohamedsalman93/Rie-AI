import unittest
from app.custom_ui_tools import render_ui, normalize_custom_ui_payload
from app.tools import render_ui as exported_render_ui


class TestCustomUiTool(unittest.TestCase):
    def test_normalize_chart_payload(self):
        result = normalize_custom_ui_payload(
            ui_type="chart",
            data={
                "type": "bar",
                "title": "Monthly Revenue",
                "data": [
                    {"label": "Jan", "value": 10},
                    {"label": "Feb", "value": 20},
                ],
            },
        )
        self.assertEqual(result["status"], "rendered")
        self.assertEqual(result["type"], "bar")
        self.assertEqual(result["title"], "Monthly Revenue")
        self.assertEqual(len(result["data"]), 2)

    def test_normalize_card_payload(self):
        result = normalize_custom_ui_payload(
            ui_type="card",
            title="System Status",
            data={
                "description": "All systems operational",
                "badge": "Active",
                "metrics": [{"label": "CPU", "value": "12%"}],
            },
            buttons=[{"label": "Refresh", "action": "message", "value": "Check system status"}],
        )
        self.assertEqual(result["status"], "rendered")
        self.assertEqual(result["type"], "card")
        self.assertEqual(result["title"], "System Status")
        self.assertEqual(result["badge"], "Active")
        self.assertEqual(len(result["buttons"]), 1)

    def test_normalize_buttons_payload(self):
        buttons = [
            {"label": "Explain Code", "action": "message", "value": "Explain"},
            {"label": "Open Docs", "action": "url", "value": "https://docs.example.com"},
        ]
        result = normalize_custom_ui_payload(
            ui_type="buttons",
            data=buttons,
        )
        self.assertEqual(result["status"], "rendered")
        self.assertEqual(result["type"], "buttons")
        self.assertEqual(result["data"], buttons)

    def test_render_ui_json_string(self):
        json_str = '{"type": "pie", "data": [{"label": "A", "value": 60}, {"label": "B", "value": 40}]}'
        result = render_ui(type="chart", data=json_str)
        self.assertEqual(result["status"], "rendered")
        self.assertEqual(result["type"], "pie")
        self.assertEqual(len(result["data"]), 2)

    def test_exported_render_ui(self):
        result = exported_render_ui(
            type="card",
            title="Deployment",
            data={"badge": "Success"},
        )
        self.assertEqual(result["status"], "rendered")
        self.assertEqual(result["title"], "Deployment")
        self.assertEqual(result["badge"], "Success")

    def test_render_ui_mermaid_flowchart(self):
        mermaid_code = "graph TD\n    A[Start] --> B[Deploy]"
        result = render_ui(
            type="flowchart",
            title="CI/CD",
            data=mermaid_code,
            buttons=[{"label": "Retry", "action": "message", "value": "retry"}],
        )
        self.assertEqual(result["status"], "rendered")
        self.assertEqual(result["type"], "flowchart")
        self.assertEqual(result["title"], "CI/CD")
        self.assertIn("mermaid", result)
        self.assertEqual(result["mermaid"], mermaid_code)
        self.assertEqual(len(result["buttons"]), 1)


if __name__ == "__main__":
    unittest.main()

"""
Custom Generative UI Tool for Rie-AI.
Allows the agent to render rich interactive custom UI in chat,
including interactive cards, buttons, and responsive charts (like ChatGPT).
"""
from typing import Any, Dict, List, Optional, Union
import json


def normalize_custom_ui_payload(
    ui_type: str = "ui",
    data: Optional[Union[Dict[str, Any], List[Any]]] = None,
    title: Optional[str] = None,
    subtitle: Optional[str] = None,
    buttons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Normalizes a custom UI payload into canonical shape:
    {
        "status": "rendered",
        "type": str,
        "title": Optional[str],
        "subtitle": Optional[str],
        "data": dict/list,
        "buttons": Optional[list]
    }
    """
    normalized_type = str(ui_type or "ui").strip().lower()

    # Parse JSON if data is passed as a string
    parsed_data = data
    if isinstance(data, str) and data.strip():
        try:
            parsed_data = json.loads(data)
        except Exception:
            stripped = data.strip()
            is_mermaid = any(
                stripped.startswith(prefix)
                for prefix in (
                    "graph ", "graph\n", "graph\r\n",
                    "flowchart ", "flowchart\n", "flowchart\r\n",
                    "sequenceDiagram", "stateDiagram", "classDiagram",
                    "erDiagram", "journey", "gantt", "pie", "gitGraph"
                )
            ) or ("-->" in stripped and ("[" in stripped or "{" in stripped))
            parsed_data = {"text": data}
            if is_mermaid or normalized_type in ("flowchart", "mermaid"):
                parsed_data["mermaid"] = data

    if parsed_data is None:
        parsed_data = {}

    payload: Dict[str, Any] = {
        "status": "rendered",
        "type": normalized_type,
    }

    if title:
        payload["title"] = str(title).strip()
    if subtitle:
        payload["subtitle"] = str(subtitle).strip()

    if isinstance(parsed_data, dict):
        payload.update(parsed_data)
        if "type" not in payload or not payload["type"]:
            payload["type"] = normalized_type
        if title and not payload.get("title"):
            payload["title"] = str(title).strip()
        if subtitle and not payload.get("subtitle"):
            payload["subtitle"] = str(subtitle).strip()
        # Ensure mermaid property is populated if text contains Mermaid definition
        if "mermaid" not in payload and isinstance(payload.get("text"), str):
            text_str = payload["text"].strip()
            if any(
                text_str.startswith(prefix)
                for prefix in (
                    "graph ", "graph\n", "graph\r\n",
                    "flowchart ", "flowchart\n", "flowchart\r\n",
                    "sequenceDiagram", "stateDiagram", "classDiagram",
                    "erDiagram", "journey", "gantt", "pie", "gitGraph"
                )
            ) or ("-->" in text_str and ("[" in text_str or "{" in text_str)):
                payload["mermaid"] = payload["text"]
    else:
        payload["data"] = parsed_data

    if buttons and isinstance(buttons, list):
        payload["buttons"] = buttons

    return payload


def render_ui(
    type: str = "card",
    data: Optional[Union[Dict[str, Any], List[Any], str]] = None,
    title: Optional[str] = None,
    subtitle: Optional[str] = None,
    buttons: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Render custom interactive UI in chat, such as cards, action buttons, or charts.

    Use this tool whenever you want to present structured analytics, metric summaries,
    status cards, comparisons, or recommended next-step buttons to the user.

    Parameters:
    - type: UI component type:
        * 'chart': for bar, line, area, pie, donut, or progress charts.
        * 'flowchart': for step-by-step workflow pipelines, decision trees, or Mermaid diagrams.
        * 'card': for status cards, metric cards, or info cards.
        * 'buttons': for interactive action button rows or quick replies.
        * 'ui': for composite components combining cards, charts, and buttons.
    - data: Component data dictionary or list.
        * For chart: { 'type': 'bar'|'line'|'area'|'pie'|'donut'|'progress', 'title': '...', 'data': [{'label': 'Jan', 'value': 40}, ...] }
        * For card: { 'title': '...', 'description': '...', 'badge': 'Healthy', 'metrics': [{'label': 'Uptime', 'value': '99.9%'}], 'buttons': [...] }
        * For buttons: [{'label': 'Run Tests', 'action': 'message', 'value': 'Run the tests'}]
    - title: Optional title of the UI component.
    - subtitle: Optional subtitle or category label.
    - buttons: Optional action buttons attached to the component.
    """
    return normalize_custom_ui_payload(
        ui_type=type,
        data=data,
        title=title,
        subtitle=subtitle,
        buttons=buttons,
    )

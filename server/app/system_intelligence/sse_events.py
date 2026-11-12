"""
SSE Event Formatter for Rie System Intelligence.
Enables real-time event streaming for configuration updates and diagnostic alerts.
"""
import json
from datetime import datetime, timezone
from typing import Any, Optional


def format_settings_updated_sse(
    key: str,
    value: Any,
    author: str = "rie",
    transaction_id: Optional[str] = None,
) -> str:
    """Format a settings_updated SSE message payload"""
    payload = {
        "type": "settings_updated",
        "key": key,
        "value": value,
        "author": author,
        "transaction_id": transaction_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    return f"event: settings_updated\ndata: {json.dumps(payload)}\n\n"


from typing import Optional

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.config import settings
from app.database import (
    get_friend_by_id,
    list_friends,
    has_friend_thread_approval,
    append_peer_query_event,
)
from app.runtime_context import get_current_thread_id, get_current_friend_target_id


class RemoteConnectionAskInput(BaseModel):
    question: str = Field(..., description="Question to send to connection's Rie.")
    connection_id: Optional[str] = Field(default=None, description="Optional connection id. If omitted, current chat target is used.")


def _resolve_connection(connection_id: Optional[str]):
    if connection_id:
        return get_friend_by_id(connection_id)
    current = get_current_friend_target_id()
    if current:
        return get_friend_by_id(current)
    friends = list_friends()
    return friends[0] if friends else None


def _remote_connection_ask(question: str, connection_id: Optional[str] = None) -> str:
    connection = _resolve_connection(connection_id)
    if not connection:
        return "No connection target selected. Select a connection first."
    thread_id = get_current_thread_id()
    if not thread_id or not has_friend_thread_approval(thread_id, connection["id"]):
        return f"Permission required before asking {connection['name']} in this chat. Confirm once and retry."
    qlog = question.strip() or "(empty)"

    token = settings.RIE_ACCESS_TOKEN
    if not token:
        return "Cannot reach connection: not signed in to Rie Cloud. Please sign in to connect."

    headers = {"Authorization": f"Bearer {token}"}
    payload = {"query": question.strip(), "thread_id": thread_id}
    url = f"{settings.RIE_API_URL}/connections/{connection['id']}/ask"

    try:
        with httpx.Client(timeout=130.0) as client:
            res = client.post(url, json=payload, headers=headers)
            if res.status_code >= 400:
                err_msg = res.json().get("detail", res.text) if "application/json" in res.headers.get("content-type", "") else res.text
                append_peer_query_event("outbound", connection["id"], connection["name"], qlog, "error", None, err_msg)
                return f"Failed to ask connection: {err_msg}"
            body = res.json()
            msg = body.get("message", "")
            preview = msg if isinstance(msg, str) else str(msg)
            append_peer_query_event("outbound", connection["id"], connection["name"], qlog, "ok", preview, None)
            return f"{body.get('status', 'online')}: {preview}"
    except Exception as exc:
        append_peer_query_event("outbound", connection["id"], connection["name"], qlog, "error", None, str(exc))
        return f"Failed to reach connection: {exc}"


remote_connection_ask_tool = StructuredTool.from_function(
    func=_remote_connection_ask,
    name="remote_connection_ask",
    description="Ask a connected peer's Rie agent via Central Cloud Gateway and return the response.",
    args_schema=RemoteConnectionAskInput,
)

# Backwards compatibility alias
remote_friend_ask_tool = remote_connection_ask_tool

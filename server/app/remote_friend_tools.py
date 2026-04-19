from typing import Optional

import httpx
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.connectivity.constants import PEER_HTTP_ASK_TIMEOUT
from app.connectivity.manager import connectivity_manager
from app.database import (
    get_friend_by_id,
    list_friends,
    has_friend_thread_approval,
    get_or_create_device_identity,
)
from app.runtime_context import get_current_thread_id, get_current_friend_target_id


class RemoteFriendAskInput(BaseModel):
    question: str = Field(..., description="Question to send to friend's Rie.")
    friend_id: Optional[str] = Field(default=None, description="Optional friend id. If omitted, current chat target is used.")


def _resolve_friend(friend_id: Optional[str]):
    if friend_id:
        return get_friend_by_id(friend_id)
    current = get_current_friend_target_id()
    if current:
        return get_friend_by_id(current)
    friends = list_friends()
    return friends[0] if friends else None


def _remote_friend_ask(question: str, friend_id: Optional[str] = None) -> str:
    friend = _resolve_friend(friend_id)
    if not friend:
        return "No friend target selected. Use /friendname in chat first."
    thread_id = get_current_thread_id()
    if not thread_id or not has_friend_thread_approval(thread_id, friend["id"]):
        return f"Permission required before asking {friend['name']} in this chat. Confirm once and retry."
    try:
        target_url = connectivity_manager.resolve_peer(friend)
    except Exception as exc:
        return f"Friend is not reachable: {exc}"

    identity = get_or_create_device_identity()
    payload = {
        "from_device_id": identity["device_id"],
        "from_fingerprint": identity["fingerprint"],
        "query": question.strip(),
    }
    endpoint = f"{target_url.rstrip('/')}/connectivity/peer/receive"
    try:
        with httpx.Client(timeout=PEER_HTTP_ASK_TIMEOUT) as client:
            response = client.post(endpoint, json=payload)
            response.raise_for_status()
            body = response.json()
            return f"{body.get('status', 'online')}: {body.get('message', '')}"
    except Exception as exc:
        return f"Failed to ask friend: {exc}"


remote_friend_ask_tool = StructuredTool.from_function(
    func=_remote_friend_ask,
    name="remote_friend_ask",
    description="Ask another paired friend's Rie and return the response.",
    args_schema=RemoteFriendAskInput,
)

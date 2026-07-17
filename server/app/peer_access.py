"""
Per-friend inbound peer access: parse DB JSON, merge defaults, resolve tool allowlists.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Set, Tuple

from app.models import FriendPeerAccessPolicy, FriendPeerAccessPatch

MEMORY_TOOL_IDS: frozenset[str] = frozenset({"save_memory", "get_memory", "search_memory"})

# Matches chat-mode tool composition in agent.AgentManager._initialize_agent_async
CHAT_PROFILE_TOOL_IDS: Tuple[str, ...] = (
    "internet_search",
    "schedule_chat_task",
    "remote_friend_ask",
    "save_memory",
    "get_memory",
    "search_memory",
)


def parse_peer_access_json(raw: Optional[str]) -> Optional[Dict[str, Any]]:
    if raw is None or str(raw).strip() == "":
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        return data
    except json.JSONDecodeError:
        return None


def patch_to_policy_dict(patch: FriendPeerAccessPatch) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "receive_profile": patch.receive_profile,
        "memory_enabled": patch.memory_enabled,
    }
    if patch.allowed_tool_ids is not None:
        out["allowed_tool_ids"] = list(patch.allowed_tool_ids)
    return out


def merge_peer_access_policy(data: Optional[Dict[str, Any]]) -> FriendPeerAccessPolicy:
    """Merge stored JSON with defaults."""
    if not data:
        return FriendPeerAccessPolicy()
    rp = data.get("receive_profile") or "chat"
    if rp not in ("chat", "agent"):
        rp = "chat"
    mem = data.get("memory_enabled")
    if mem is None:
        memory_enabled = True
    else:
        memory_enabled = bool(mem)
    allowed = data.get("allowed_tool_ids")
    allowed_tool_ids: Optional[List[str]]
    if allowed is None:
        allowed_tool_ids = None
    elif isinstance(allowed, list):
        allowed_tool_ids = [str(x).strip() for x in allowed if isinstance(x, str) and str(x).strip()]
        if not allowed_tool_ids:
            allowed_tool_ids = []
    else:
        allowed_tool_ids = None
    return FriendPeerAccessPolicy(
        receive_profile=rp,  # type: ignore[arg-type]
        allowed_tool_ids=allowed_tool_ids,
        memory_enabled=memory_enabled,
    )


def friend_row_peer_policy(row: Dict[str, Any]) -> FriendPeerAccessPolicy:
    raw = row.get("peer_access_json")
    parsed = parse_peer_access_json(raw if isinstance(raw, str) else None)
    return merge_peer_access_policy(parsed)


def split_catalog_for_profiles(full_catalog: Set[str]) -> Tuple[List[str], List[str]]:
    """Split runtime tool IDs into chat- vs agent-eligible lists (sorted)."""
    chat_ids = [t for t in CHAT_PROFILE_TOOL_IDS if t in full_catalog]
    agent_ids = sorted(full_catalog)
    return chat_ids, agent_ids


def compute_effective_tool_ids(
    policy: FriendPeerAccessPolicy,
    full_catalog: Set[str],
) -> List[str]:
    """
    Resolve final ordered tool id list for inbound /connectivity/peer/receive.
    """
    chat_eligible = {t for t in CHAT_PROFILE_TOOL_IDS if t in full_catalog}
    if policy.receive_profile == "chat":
        base = set(chat_eligible)
    else:
        base = set(full_catalog)

    if not policy.memory_enabled:
        base -= MEMORY_TOOL_IDS

    if policy.allowed_tool_ids is not None:
        selected: Set[str] = set()
        for tid in policy.allowed_tool_ids:
            if tid in full_catalog and tid in base:
                selected.add(tid)
        # Preserve deterministic order: chat order first for chat profile, else alphabetical
        if policy.receive_profile == "chat":
            ordered = [t for t in CHAT_PROFILE_TOOL_IDS if t in selected]
        else:
            ordered = sorted(selected)
        return ordered

    if policy.receive_profile == "chat":
        return [t for t in CHAT_PROFILE_TOOL_IDS if t in base]
    return sorted(base)


def validate_patch_tool_ids(patch: FriendPeerAccessPatch, full_catalog: Set[str]) -> None:
    """Raise ValueError with message if any tool id is unknown."""
    if patch.allowed_tool_ids is None:
        return
    unknown = [t for t in patch.allowed_tool_ids if t not in full_catalog]
    if unknown:
        raise ValueError(f"Unknown tool IDs: {', '.join(sorted(unknown))}")

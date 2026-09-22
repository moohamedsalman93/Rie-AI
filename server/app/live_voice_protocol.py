"""Wire-format helpers shared by the voice bridge and its protocol tests."""
import json
from uuid import uuid4


class VoiceTranscripts:
    """Convert independent transcription deltas into stable, replaceable snapshots."""

    def __init__(self):
        self.pending = {}

    def append(self, role, text):
        if not text:
            return None
        item = self.pending.setdefault(role, {
            "type": "transcript", "id": f"voice-{uuid4().hex}",
            "role": role, "text": "", "isPartial": True,
        })
        item["text"] += text
        return dict(item)

    def finish(self, role, interrupted=False):
        item = self.pending.pop(role, None)
        if not item:
            return None
        item.update(isPartial=False, interrupted=interrupted)
        return item


def tool_result_status(result):
    """The existing dispatcher returns both plain strings and JSON error strings."""
    if isinstance(result, str):
        try:
            payload = json.loads(result)
        except (ValueError, TypeError):
            payload = result
    else:
        payload = result
    if isinstance(payload, dict):
        if payload.get("error") or payload.get("success") is False or payload.get("status") in ("error", "failed"):
            return "failed"
    if isinstance(payload, str) and payload.lower().startswith(("error", "failed", "could not")):
        return "failed"
    return "completed"

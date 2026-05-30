"""Shared helpers for web search providers."""
import re
from typing import Any

IMAGE_INTENT_RE = re.compile(
    r"\b(images?|photos?|pictures?|wallpapers?|pics?|gif|meme|illustration|thumbnail)\b",
    re.IGNORECASE,
)

IMAGE_SEARCH_HINT = (
    "Show the user images inline using markdown, e.g. ![description](url). "
    "Prefer the top-level 'images' URLs; do not reply with only a link table."
)


def wants_images(query: str, include_images: bool) -> bool:
    return include_images or bool(IMAGE_INTENT_RE.search(query))


def attach_image_hint(payload: dict[str, Any]) -> dict[str, Any]:
    images = payload.get("images") or []
    if images:
        payload["image_search_hint"] = IMAGE_SEARCH_HINT
    return payload

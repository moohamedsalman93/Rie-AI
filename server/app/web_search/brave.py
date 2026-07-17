"""Brave Search API provider."""
from typing import Any

import httpx

from app.config import settings
from app.web_search.base import SearchTopic, WebSearchProvider
from app.web_search.utils import attach_image_hint, wants_images

BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"


class BraveProvider(WebSearchProvider):
    name = "brave"

    def search(
        self,
        query: str,
        max_results: int = 5,
        topic: SearchTopic = "general",
        include_raw_content: bool = False,
        include_images: bool = False,
    ) -> dict:
        api_key = settings.BRAVE_SEARCH_API_KEY
        if not api_key:
            return {"error": "BRAVE_SEARCH_API_KEY not configured"}

        params: dict[str, Any] = {
            "q": query,
            "count": max(1, min(max_results, 20)),
        }
        if topic == "news":
            params["freshness"] = "pd"

        headers = {
            "Accept": "application/json",
            "X-Subscription-Token": api_key,
        }

        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.get(
                    BRAVE_WEB_SEARCH_URL,
                    params=params,
                    headers=headers,
                )
                response.raise_for_status()
                raw = response.json()
        except httpx.HTTPStatusError as e:
            detail = ""
            try:
                detail = e.response.text[:200]
            except Exception:
                pass
            return {"error": f"Brave search failed: HTTP {e.response.status_code} {detail}".strip()}
        except Exception as e:
            return {"error": f"Search failed: {str(e)}"}

        web = raw.get("web") or {}
        results = []
        for item in web.get("results") or []:
            if not isinstance(item, dict):
                continue
            entry: dict[str, Any] = {
                "title": item.get("title") or "",
                "url": item.get("url") or "",
                "content": item.get("description") or "",
            }
            if include_raw_content and item.get("extra_snippets"):
                entry["raw_content"] = "\n".join(item["extra_snippets"])
            results.append(entry)

        images: list[str] = []
        include_img = wants_images(query, include_images)
        if include_img:
            try:
                with httpx.Client(timeout=30.0) as client:
                    img_resp = client.get(
                        "https://api.search.brave.com/res/v1/images/search",
                        params={"q": query, "count": max(1, min(max_results, 20))},
                        headers=headers,
                    )
                    if img_resp.is_success:
                        for img in (img_resp.json().get("results") or []):
                            if isinstance(img, dict) and img.get("thumbnail", {}).get("src"):
                                images.append(img["thumbnail"]["src"])
                            elif isinstance(img, dict) and img.get("url"):
                                images.append(img["url"])
            except Exception:
                pass

        payload: dict = {
            "query": query,
            "provider": self.name,
            "results": results,
            "images": images,
        }
        if include_img:
            attach_image_hint(payload)
        return payload

"""DuckDuckGo web search provider (no API key required).

Uses the unofficial duckduckgo-search client; expect intermittent failures,
rate limits, and slower responses compared to Tavily or Brave.
"""
from duckduckgo_search import DDGS

from app.web_search.base import SearchTopic, WebSearchProvider
from app.web_search.utils import attach_image_hint, wants_images


class DuckDuckGoProvider(WebSearchProvider):
    name = "duckduckgo"

    def search(
        self,
        query: str,
        max_results: int = 5,
        topic: SearchTopic = "general",
        include_raw_content: bool = False,
        include_images: bool = False,
    ) -> dict:
        # topic is best-effort; DDGS text search does not expose news/finance filters.
        _ = topic
        count = max(1, min(max_results, 20))
        include_img = wants_images(query, include_images)

        try:
            with DDGS() as ddgs:
                raw_results = list(
                    ddgs.text(query, max_results=count)
                )
                images: list[str] = []
                if include_img:
                    for img in ddgs.images(query, max_results=count):
                        if isinstance(img, dict):
                            url = img.get("image") or img.get("url") or img.get("thumbnail")
                            if url:
                                images.append(url)
        except Exception as e:
            return {"error": f"Search failed: {str(e)}"}

        results = []
        for item in raw_results:
            if not isinstance(item, dict):
                continue
            entry = {
                "title": item.get("title") or "",
                "url": item.get("href") or item.get("url") or "",
                "content": item.get("body") or item.get("snippet") or "",
            }
            if include_raw_content and entry["content"]:
                entry["raw_content"] = entry["content"]
            results.append(entry)

        payload: dict = {
            "query": query,
            "provider": self.name,
            "results": results,
            "images": images,
        }
        if include_img:
            attach_image_hint(payload)
        return payload

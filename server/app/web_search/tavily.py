"""Tavily web search provider."""
from tavily import TavilyClient

from app.config import settings
from app.web_search.base import SearchTopic, WebSearchProvider
from app.web_search.utils import attach_image_hint, wants_images


class TavilyProvider(WebSearchProvider):
    name = "tavily"

    def __init__(self) -> None:
        self.client: TavilyClient | None = None
        self._api_key: str | None = None
        self._sync_client()

    def _sync_client(self) -> None:
        api_key = settings.TAVILY_API_KEY if settings.has_tavily_key else None
        if api_key == self._api_key and (api_key is None or self.client is not None):
            return
        self._api_key = api_key
        self.client = TavilyClient(api_key=api_key) if api_key else None

    def search(
        self,
        query: str,
        max_results: int = 5,
        topic: SearchTopic = "general",
        include_raw_content: bool = False,
        include_images: bool = False,
    ) -> dict:
        self._sync_client()
        if not self.client:
            return {"error": "TAVILY_API_KEY not configured"}

        include_img = wants_images(query, include_images)

        try:
            raw = self.client.search(
                query,
                max_results=max_results,
                include_raw_content=include_raw_content,
                include_images=include_img,
                topic=topic,
            )
        except Exception as e:
            return {"error": f"Search failed: {str(e)}"}

        if not isinstance(raw, dict):
            return {"error": "Unexpected Tavily response"}

        results = []
        for item in raw.get("results") or []:
            if not isinstance(item, dict):
                continue
            entry = {
                "title": item.get("title") or "",
                "url": item.get("url") or "",
                "content": item.get("content") or item.get("snippet") or "",
            }
            if include_raw_content and item.get("raw_content"):
                entry["raw_content"] = item["raw_content"]
            results.append(entry)

        images = list(raw.get("images") or [])
        payload: dict = {
            "query": query,
            "provider": self.name,
            "results": results,
            "images": images,
        }
        if include_img:
            attach_image_hint(payload)
        return payload

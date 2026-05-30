"""Web search provider interface."""
from abc import ABC, abstractmethod
from typing import Literal

SearchTopic = Literal["general", "news", "finance"]


class WebSearchProvider(ABC):
    """Abstract web search backend."""

    name: str

    @abstractmethod
    def search(
        self,
        query: str,
        max_results: int = 5,
        topic: SearchTopic = "general",
        include_raw_content: bool = False,
        include_images: bool = False,
    ) -> dict:
        """Run a search and return a normalized result dict or {"error": "..."}."""

"""Route internet_search to the configured web search provider."""
from app.config import settings
from app.web_search.base import SearchTopic
from app.web_search.brave import BraveProvider
from app.web_search.duckduckgo import DuckDuckGoProvider
from app.web_search.tavily import TavilyProvider

_PROVIDERS = {
    "tavily": TavilyProvider(),
    "brave": BraveProvider(),
    "duckduckgo": DuckDuckGoProvider(),
}

def get_active_provider_name() -> str:
    name = (settings.WEB_SEARCH_PROVIDER or "tavily").strip().lower()
    if name not in _PROVIDERS:
        return "tavily"
    return name


def search(
    query: str,
    max_results: int = 5,
    topic: str = "general",
    include_raw_content: bool = False,
    include_images: bool = False,
) -> dict:
    """Run a web search using the user's selected provider."""
    valid_topics = ("general", "news", "finance")
    safe_topic = topic if topic in valid_topics else "general"
    provider_name = get_active_provider_name()
    provider = _PROVIDERS[provider_name]
    return provider.search(
        query=query,
        max_results=max_results,
        topic=safe_topic,
        include_raw_content=include_raw_content,
        include_images=include_images,
    )


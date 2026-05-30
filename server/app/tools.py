"""
Tools available for the Deep Agent
"""
from app.web_search import search as web_search
from app.web_search.base import SearchTopic


def internet_search(
    query: str,
    max_results: int = 5,
    topic: SearchTopic = "general",
    include_raw_content: bool = False,
    include_images: bool = False,
) -> dict:
    """Run a web search. Set include_images=True when the user asks for photos or pictures."""
    return web_search(
        query=query,
        max_results=max_results,
        topic=topic,
        include_raw_content=include_raw_content,
        include_images=include_images,
    )

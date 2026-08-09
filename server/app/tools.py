"""
Tools available for the Deep Agent
"""
from app.web_search import search as web_search


def internet_search(
    query: str,
    max_results: int = 5,
    topic: str = "general",
    include_raw_content: bool = False,
    include_images: bool = False,
) -> dict:
    """Run a web search. Set include_images=True when the user asks for photos or pictures. topic must be 'general', 'news', or 'finance'."""
    valid_topics = ("general", "news", "finance")
    safe_topic = topic if topic in valid_topics else "general"
    return web_search(
        query=query,
        max_results=max_results,
        topic=safe_topic,
        include_raw_content=include_raw_content,
        include_images=include_images,
    )

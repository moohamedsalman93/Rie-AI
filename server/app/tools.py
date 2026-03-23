"""
Tools available for the Deep Agent
"""
from typing import Literal
from tavily import TavilyClient
from app.config import settings
import os




class TavilySearchTool:
    """Internet search tool using Tavily"""
    
    def __init__(self):
        self.client: TavilyClient | None = None
        if settings.has_tavily_key:
            self.client = TavilyClient(api_key=settings.TAVILY_API_KEY)
    
    def internet_search(
        self,
        query: str,
        max_results: int = 5,
        topic: Literal["general", "news", "finance"] = "general",
        include_raw_content: bool = False,
    ) -> dict:
        """
        Run a web search using Tavily
        
        Args:
            query: Search query string
            max_results: Maximum number of results to return (default: 5)
            topic: Topic category - general, news, or finance (default: general)
            include_raw_content: Whether to include raw content in results (default: False)
            
        Returns:
            Search results dictionary or error message
        """
        if not self.client:
            return {"error": "TAVILY_API_KEY not configured"}
        
        try:
            return self.client.search(
                query,
                max_results=max_results,
                include_raw_content=include_raw_content,
                topic=topic,
            )
        except Exception as e:
            return {"error": f"Search failed: {str(e)}"}


# Global tool instance
tavily_tool = TavilySearchTool()

# Export the search function for the agent
def internet_search(
    query: str,
    max_results: int = 5,
    topic: Literal["general", "news", "finance"] = "general",
    include_raw_content: bool = False,
) -> dict:
    """Run a web search - wrapper for agent compatibility"""
    return tavily_tool.internet_search(
        query=query,
        max_results=max_results,
        topic=topic,
        include_raw_content=include_raw_content,
    )



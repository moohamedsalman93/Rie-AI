"""
Long-Term Memory tools for the agent
"""
import logging
import uuid
from dataclasses import dataclass
from typing import Optional
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.memory import memory_store

logger = logging.getLogger(__name__)


@dataclass
class Context:
    user_id: str = "default_user"


class SaveMemoryInput(BaseModel):
    fact: str = Field(
        ...,
        description="The fact, preference, user information, or context to remember across conversations.",
    )
    category: str = Field(
        default="general",
        description="Category for the memory (e.g., 'profile', 'preferences', 'personal', 'work', 'general').",
    )


class SearchMemoryInput(BaseModel):
    query: str = Field(
        ...,
        description="The search query to find relevant memories (e.g., user's name, preferences, past topics).",
    )
    limit: int = Field(
        default=5,
        description="Maximum number of memories to return (default: 5).",
    )


class GetMemoryInput(BaseModel):
    key: str = Field(
        ...,
        description="The unique key of the memory to retrieve.",
    )


def _save_memory(fact: str, category: str = "general") -> str:
    """
    Save a fact to the user's long-term memory.
    Use this to remember user preferences, important facts, identity, or context.
    Automatically updates existing matching facts to prevent duplicates.
    """
    try:
        store = memory_store.get_store_sync()
        user_id = "default_user"
        namespace = ("users", user_id)
        
        # Deduplication: search for existing matching or conflicting facts
        existing = list(store.search(namespace, query=fact.strip(), limit=5))
        target_key = None
        for item in existing:
            key = item.metadata.get("key")
            content = (item.value.get("content") or "").strip().lower()
            score = item.metadata.get("score", 0.0)
            item_cat = item.value.get("category", "")
            
            # Exact match or high semantic similarity in the same category
            if content == fact.strip().lower() or (score >= 0.70 and item_cat == category):
                target_key = key
                break

        key = target_key or str(uuid.uuid4())
        store.put(namespace, key, {"content": fact.strip(), "category": category.strip()})
        action = "Updated existing memory" if target_key else "Saved to memory"
        return f"{action}: '{fact.strip()}' [category: {category.strip()}]."
    except Exception as e:
        logger.exception("Failed to save memory: %s", e)
        return f"Failed to save memory: {e}"


def _get_memory(key: str) -> str:
    """
    Retrieve a specific memory by its key.
    """
    try:
        store = memory_store.get_store_sync()
        user_id = "default_user"
        namespace = ("users", user_id)
        item = store.get(namespace, key.strip())
        if item:
            return f"Memory [{key}] ({item.value.get('category')}): {item.value.get('content')}"
        return f"No memory found for key '{key}'."
    except Exception as e:
        logger.exception("Failed to get memory: %s", e)
        return f"Failed to retrieve memory: {e}"


def _search_memory(query: str, limit: int = 5) -> str:
    """
    Semantic search: Find relevant user facts/preferences based on a natural language query.
    """
    try:
        store = memory_store.get_store_sync()
        user_id = "default_user"
        namespace = ("users", user_id)
        items = list(store.search(namespace, query=query.strip(), limit=limit))
        if not items:
            return "No relevant memories found."

        results = []
        for item in items:
            score_info = (
                f" (relevance: {item.metadata['score']:.1%})"
                if hasattr(item, "metadata") and "score" in item.metadata
                else ""
            )
            results.append(
                f"- {item.value.get('content')} [category: {item.value.get('category')}]{score_info}"
            )
        return "Found the following relevant memories:\n" + "\n".join(results)
    except Exception as e:
        logger.exception("Failed to search memory: %s", e)
        return f"Failed to search memories: {e}"


save_memory = StructuredTool.from_function(
    func=_save_memory,
    name="save_memory",
    description=(
        "Save a fact, preference, user detail, or context to long-term memory so it persists across conversations. "
        "Use this whenever the user shares personal info (like their name, preferences, projects) or asks you to remember something."
    ),
    args_schema=SaveMemoryInput,
)

get_memory = StructuredTool.from_function(
    func=_get_memory,
    name="get_memory",
    description="Retrieve a specific memory by its key.",
    args_schema=GetMemoryInput,
)

search_memory = StructuredTool.from_function(
    func=_search_memory,
    name="search_memory",
    description=(
        "Search long-term memory for previously remembered facts, preferences, user information, or context. "
        "ALWAYS use this when the user asks about themselves (e.g. 'What is my name?', 'What do you know about me?', 'What are my preferences?') or when past context is needed."
    ),
    args_schema=SearchMemoryInput,
)

LTM_TOOLS = [save_memory, get_memory, search_memory]

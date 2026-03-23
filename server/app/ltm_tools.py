"""
Long-Term Memory tools for the agent
"""
import uuid
from dataclasses import dataclass
from typing_extensions import TypedDict
from langchain.tools import tool, ToolRuntime

@dataclass
class Context:
    user_id: str

class MemoryData(TypedDict):
    """Schema for saving memories."""
    fact: str
    category: str # e.g., "preferences", "history"

@tool
def save_memory(data: MemoryData, runtime: ToolRuntime[Context]) -> str:
    """
    Save a fact to the user's long-term memory.
    Use this to remember user preferences, important facts, or context.
    
    Args:
        data: A dictionary containing 'fact' and 'category'.
    """
    store = runtime.store
    user_id = runtime.context.user_id
    namespace = ("users", user_id)
    
    # Generate a unique key for this memory entry
    key = str(uuid.uuid4())
    
    store.put(namespace, key, {"content": data["fact"], "category": data["category"]})
    
    return f"Saved '{data['fact']}' in category '{data['category']}'."

@tool
def get_memory(key: str, runtime: ToolRuntime[Context]) -> str:
    """
    Retrieve a specific memory by its key.
    
    Args:
        key: The key of the memory to retrieve.
    """
    store = runtime.store
    user_id = runtime.context.user_id
    namespace = ("users", user_id)
    
    item = store.get(namespace, key)
    if item:
        return f"Memory [{key}] ({item.value.get('category')}): {item.value.get('content')}"
    else:
        return f"No memory found for key '{key}'."

@tool
def search_memory(query: str, runtime: ToolRuntime[Context]) -> str:
    """
    Semantic search: Find relevant user facts/preferences based on a natural language query.
    
    Args:
        query: The search query to find related memories.
    """
    store = runtime.store
    user_id = runtime.context.user_id
    namespace = ("users", user_id)
    
    # search returns semantic matches (Chroma or other store)
    items = list(store.search(namespace, query=query, limit=5))
    
    if not items:
        return "No relevant memories found."
    
    results = []
    for item in items:
        # Check if score is available (semantic search)
        score_info = f" (relevance: {item.metadata['score']:.1%})" if hasattr(item, 'metadata') and 'score' in item.metadata else ""
        results.append(f"- {item.value.get('content')} [cat: {item.value.get('category')}]{score_info}")
        
    return "Found the following relevant memories:\n" + "\n".join(results)

LTM_TOOLS = [save_memory, get_memory, search_memory]

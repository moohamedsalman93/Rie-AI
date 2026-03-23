"""
Long-Term Memory (LTM) Store management using Chroma.
Supports preferences, emails, notes, and other user data with semantic search.
"""
import logging

from app.database import get_db_path
from app.chroma_store import ChromaStore

logger = logging.getLogger(__name__)


class MemoryStore:
    """Manages the persistent Chroma store for long-term memories."""

    def __init__(self):
        self._store: ChromaStore | None = None

    async def get_store(self) -> ChromaStore:
        """Get or initialize the persistent Chroma store."""
        if self._store is not None:
            return self._store

        persist_path = str(get_db_path().parent / "chroma_ltm")
        logger.info("Initializing LTM Chroma store at %s", persist_path)
        self._store = ChromaStore(persist_path=persist_path)
        return self._store

    def close(self) -> None:
        """Release store reference (Chroma PersistentClient has no explicit close)."""
        self._store = None


memory_store = MemoryStore()

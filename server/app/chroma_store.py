"""
Chroma-backed store adapter matching LangGraph store interface (put/get/search).
Used for LTM to support preferences, emails, notes, etc. with semantic search.
Bundled mode uses Chroma's ONNX MiniLM (same 384-dim vectors as all-MiniLM-L6-v2; no PyTorch).
"""
import logging
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence, Tuple

import chromadb
from chromadb.api.types import Documents, EmbeddingFunction, Embeddings
from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2

from app.config import settings

logger = logging.getLogger(__name__)


class _StoreResult:
    """Minimal result type compatible with LangGraph store items (value + metadata)."""

    __slots__ = ("value", "metadata")

    def __init__(self, value: dict, metadata: Optional[dict] = None):
        self.value = value
        self.metadata = metadata or {}


def _get_embedding_function() -> EmbeddingFunction[Documents]:
    """Return the configured embedding function (bundled ONNX or Ollama)."""
    source = (settings.EMBEDDING_SOURCE or "bundled").strip().lower()
    if source == "ollama":
        from langchain_ollama import OllamaEmbeddings

        class _OllamaChromaEmbeddingFunction(EmbeddingFunction[Documents]):
            def __init__(self):
                self._embed = OllamaEmbeddings(
                    model="nomic-embed-text",
                    base_url=settings.OLLAMA_API_URL,
                )

            def __call__(self, input: Documents) -> Embeddings:
                if not input:
                    return []
                return self._embed.embed_documents(list(input))

        return _OllamaChromaEmbeddingFunction()
    # Default: bundled Chroma ONNX MiniLM (no sentence-transformers / torch)
    model_root = (settings.EMBEDDING_MODEL_PATH or "").strip()
    if model_root:
        root = Path(model_root)
        if not (root / "onnx" / "model.onnx").is_file():
            logger.warning(
                "EMBEDDING_MODEL_PATH %s is not a Chroma ONNX bundle; using default cache",
                root,
            )
            return ONNXMiniLM_L6_V2()
        logger.info("Using bundled ONNX embeddings from %s", root)

        class _LocalONNXMiniLM(ONNXMiniLM_L6_V2):
            DOWNLOAD_PATH = root

        return _LocalONNXMiniLM()
    logger.info("Using bundled ONNX embeddings (default cache path)")
    return ONNXMiniLM_L6_V2()


def _namespace_to_collection_name(namespace: Sequence[str]) -> str:
    """Convert (users, user_id) -> ltm_users_<user_id> for Chroma collection name."""
    return "ltm_" + "_".join(str(n) for n in namespace)


class ChromaStore:
    """
    Store adapter that uses Chroma for put/get/search.
    Implements the same interface as LangGraph's BaseStore used by LTM tools.
    """

    def __init__(self, persist_path: str):
        self._client = chromadb.PersistentClient(path=persist_path)
        self._embed_fn = _get_embedding_function()
        self._collection_cache: dict[str, Any] = {}

    def _collection(self, namespace: Sequence[str]):
        name = _namespace_to_collection_name(namespace)
        if name not in self._collection_cache:
            # Use metadata (legacy) instead of configuration to avoid Chroma type mismatch
            # when loading existing collections (CollectionConfigurationInterface vs Internal)
            self._collection_cache[name] = self._client.get_or_create_collection(
                name=name,
                embedding_function=self._embed_fn,
                metadata={"hnsw:space": "cosine"},
            )
        return self._collection_cache[name]

    def put(self, namespace: Tuple[str, ...], key: str, value: dict) -> None:
        """Store an item. value must contain 'content' and 'category'."""
        coll = self._collection(namespace)
        content = value.get("content", "")
        category = value.get("category", "")
        # Chroma upserts by id; same id replaces previous
        coll.upsert(
            ids=[key],
            documents=[content],
            metadatas=[{"category": category, "key": key}],
        )

    def get(self, namespace: Tuple[str, ...], key: str) -> Optional[_StoreResult]:
        """Retrieve an item by key."""
        coll = self._collection(namespace)
        try:
            out = coll.get(ids=[key], include=["documents", "metadatas"])
        except Exception:
            return None
        if not out["ids"]:
            return None
        doc = (out["documents"] or [None])[0]
        meta = (out["metadatas"] or [{}])[0]
        return _StoreResult(
            value={"content": doc or "", "category": meta.get("category", "")},
            metadata={},
        )

    def search(
        self,
        namespace: Tuple[str, ...],
        query: str,
        limit: int = 5,
        **kwargs: Any,
    ) -> Iterator[_StoreResult]:
        """Semantic search over stored items. Yields results with .value and .metadata['score']."""
        coll = self._collection(namespace)
        try:
            out = coll.query(
                query_texts=[query],
                n_results=limit,
                include=["documents", "metadatas", "distances"],
            )
        except Exception as e:
            logger.warning("Chroma search failed: %s", e)
            return
        ids_list = out.get("ids")
        docs_list = out.get("documents")
        metas_list = out.get("metadatas")
        dists_list = out.get("distances")
        if not ids_list or not ids_list[0]:
            return
        for i, doc_id in enumerate(ids_list[0]):
            doc = (docs_list[0][i] if docs_list and docs_list[0] and i < len(docs_list[0]) else "") or ""
            meta = (metas_list[0][i] if metas_list and metas_list[0] and i < len(metas_list[0]) else {}) or {}
            dist = (dists_list[0][i] if dists_list and dists_list[0] and i < len(dists_list[0]) else 0) or 0
            # Cosine distance in [0, 2]; convert to similarity score in [0, 1]
            score = max(0.0, min(1.0, 1.0 - (float(dist) / 2.0)))
            yield _StoreResult(
                value={"content": doc, "category": meta.get("category", "")},
                metadata={"score": score},
            )

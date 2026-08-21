"""
Thread-safe API key rotator with usage tracking for LLM providers.
"""
import logging
import threading
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple

_logger = logging.getLogger(__name__)

class KeyRotator:
    """Thread-safe round-robin API key rotator with per-key usage tracking."""

    def __init__(self, keys: List[str], provider: str) -> None:
        if not keys:
            raise ValueError(f"KeyRotator({provider}): at least one key is required")
        self._keys = list(keys)
        self._provider = provider
        self._index = 0
        self._lock = threading.Lock()
        # Per-key stats: {index: {count, errors, last_used}}
        self._usage: Dict[int, Dict[str, Any]] = {
            i: {"count": 0, "last_used": None, "errors": 0}
            for i in range(len(keys))
        }

    @staticmethod
    def _mask_key(key: str) -> str:
        """Mask an API key for safe logging, e.g. 'gsk_abc...xyzQ'."""
        if len(key) <= 8:
            return key[:2] + "..." + key[-2:]
        return key[:4] + "..." + key[-4:]

    @property
    def total_keys(self) -> int:
        return len(self._keys)

    def next_key(self) -> Tuple[str, int]:
        """Return (key, key_index) in a thread-safe round-robin."""
        with self._lock:
            idx = self._index
            key = self._keys[idx]
            self._index = (idx + 1) % len(self._keys)
            self._usage[idx]["count"] += 1
            self._usage[idx]["last_used"] = datetime.now(timezone.utc).isoformat()
        _logger.debug(
            "[KeyRotator/%s] Using key #%d/%d (%s) — total calls: %d",
            self._provider,
            idx + 1,
            len(self._keys),
            self._mask_key(key),
            self._usage[idx]["count"],
        )
        return key, idx

    def record_error(self, key_index: int) -> None:
        """Increment the error count for a specific key index."""
        with self._lock:
            if key_index in self._usage:
                self._usage[key_index]["errors"] += 1

    def stats(self) -> List[Dict[str, Any]]:
        """Return per-key stats with masked key identifiers."""
        with self._lock:
            result = []
            for i, key in enumerate(self._keys):
                entry = self._usage[i]
                result.append({
                    "index": i,
                    "masked": self._mask_key(key),
                    "calls": entry["count"],
                    "errors": entry["errors"],
                    "last_used": entry["last_used"],
                })
            return result

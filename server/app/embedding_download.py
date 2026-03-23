"""
Download embedding model with progress reporting for the bundled LTM store.
"""
import logging
import queue
import threading
from typing import Callable, Optional

logger = logging.getLogger(__name__)

EMBEDDING_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"


def _download_with_progress(progress_queue: "queue.Queue[dict]") -> Optional[str]:
    """
    Download the embedding model using huggingface_hub.
    Puts progress dicts into progress_queue: {"progress": 0-100, "message": str, "done": bool, "error": str}
    Returns the local path on success, None on failure.
    """
    try:
        from huggingface_hub import snapshot_download
        from tqdm import tqdm
    except ImportError as e:
        progress_queue.put({"progress": 0, "message": "Missing dependency", "done": True, "error": str(e)})
        return None

    class ProgressTqdm(tqdm):
        """Tqdm that reports progress to a queue."""

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._last_pct = -1

        def update(self, n=1):
            ret = super().update(n)
            if self.total and self.total > 0:
                pct = min(100, int(100 * self.n / self.total))
                if pct != self._last_pct:  # Avoid duplicate updates
                    self._last_pct = pct
                    try:
                        progress_queue.put_nowait({
                            "progress": pct,
                            "message": (self.desc or "Downloading...").strip() or f"{pct}%",
                            "done": False,
                        })
                    except queue.Full:
                        pass
            return ret

    try:
        progress_queue.put({"progress": 0, "message": "Starting download...", "done": False})
        path = snapshot_download(
            repo_id=EMBEDDING_MODEL_ID,
            local_files_only=False,
            tqdm_class=ProgressTqdm,
        )
        progress_queue.put({
            "progress": 100,
            "message": "Download complete",
            "done": True,
            "path": path,
        })
        return path
    except Exception as e:
        logger.exception("Embedding model download failed")
        progress_queue.put({"progress": 0, "message": str(e), "done": True, "error": str(e)})
        return None


def run_download_async(progress_callback: Callable[[dict], None]) -> Optional[str]:
    """
    Run download in a thread and call progress_callback with progress dicts.
    Blocks until download completes. Returns local path or None.
    """
    q: "queue.Queue[dict]" = queue.Queue()
    result = [None]  # Mutable to capture from thread

    def worker():
        result[0] = _download_with_progress(q)
        q.put(None)  # Sentinel

    t = threading.Thread(target=worker, daemon=True)
    t.start()

    while True:
        try:
            msg = q.get(timeout=0.5)
        except queue.Empty:
            continue
        if msg is None:
            break
        progress_callback(msg)
    return result[0]

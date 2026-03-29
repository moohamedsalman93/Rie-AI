"""
Download Chroma's ONNX all-MiniLM-L6-v2 bundle with progress (LTM bundled embeddings).
Same archive as chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2.
"""
import hashlib
import logging
import os
import queue
import tarfile
import threading
from pathlib import Path
from typing import Callable, Optional

import httpx
from tqdm import tqdm

logger = logging.getLogger(__name__)

MODEL_NAME = "all-MiniLM-L6-v2"
MODEL_DOWNLOAD_URL = (
    "https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz"
)
_MODEL_SHA256 = (
    "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3"
)
ARCHIVE_FILENAME = "onnx.tar.gz"
EXTRACTED_FOLDER_NAME = "onnx"


def default_onnx_model_root() -> Path:
    """Directory where Chroma stores the ONNX MiniLM files (contains onnx/ subfolder)."""
    return Path.home() / ".cache" / "chroma" / "onnx_models" / MODEL_NAME


def _verify_sha256(fname: str, expected_sha256: str) -> bool:
    sha256_hash = hashlib.sha256()
    with open(fname, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest() == expected_sha256


def _onnx_files_ready(model_root: Path) -> bool:
    extracted = model_root / EXTRACTED_FOLDER_NAME
    for name in (
        "config.json",
        "model.onnx",
        "special_tokens_map.json",
        "tokenizer_config.json",
        "tokenizer.json",
        "vocab.txt",
    ):
        if not (extracted / name).is_file():
            return False
    return True


def _download_with_progress(progress_queue: "queue.Queue[dict]") -> Optional[str]:
    """
    Download and extract the ONNX model. Puts progress dicts on progress_queue.
    Returns model root path string on success (for EMBEDDING_MODEL_PATH).
    """
    model_root = default_onnx_model_root()
    try:
        model_root.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        progress_queue.put(
            {
                "progress": 0,
                "message": str(e),
                "done": True,
                "error": str(e),
            }
        )
        return None

    if _onnx_files_ready(model_root):
        progress_queue.put(
            {
                "progress": 100,
                "message": "Model already present",
                "done": True,
                "path": str(model_root),
            }
        )
        return str(model_root)

    archive_path = model_root / ARCHIVE_FILENAME
    need_download = True
    if archive_path.is_file() and _verify_sha256(str(archive_path), _MODEL_SHA256):
        need_download = False

    if need_download:
        progress_queue.put(
            {"progress": 0, "message": "Starting download...", "done": False}
        )
        try:
            last_pct = [-1]

            with httpx.stream("GET", MODEL_DOWNLOAD_URL, timeout=120.0) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("content-length") or 0)
                with open(archive_path, "wb") as file, tqdm(
                    desc="onnx.tar.gz",
                    total=total or None,
                    unit="iB",
                    unit_scale=True,
                    unit_divisor=1024,
                ) as bar:
                    downloaded = 0
                    for data in resp.iter_bytes(chunk_size=1024 * 64):
                        file.write(data)
                        bar.update(len(data))
                        downloaded += len(data)
                        if total > 0:
                            pct = min(99, int(100 * downloaded / total))
                            if pct != last_pct[0]:
                                last_pct[0] = pct
                                progress_queue.put_nowait(
                                    {
                                        "progress": pct,
                                        "message": f"Downloading… {pct}%",
                                        "done": False,
                                    }
                                )
        except Exception as e:
            logger.exception("ONNX embedding download failed")
            if archive_path.is_file():
                try:
                    os.remove(archive_path)
                except OSError:
                    pass
            progress_queue.put(
                {
                    "progress": 0,
                    "message": str(e),
                    "done": True,
                    "error": str(e),
                }
            )
            return None

        if not _verify_sha256(str(archive_path), _MODEL_SHA256):
            try:
                os.remove(archive_path)
            except OSError:
                pass
            err = "Downloaded archive failed integrity check"
            progress_queue.put(
                {"progress": 0, "message": err, "done": True, "error": err}
            )
            return None

    progress_queue.put(
        {"progress": 99, "message": "Extracting…", "done": False}
    )
    try:
        with tarfile.open(name=str(archive_path), mode="r:gz") as tar:
            tar.extractall(path=str(model_root))
    except Exception as e:
        logger.exception("ONNX extract failed")
        progress_queue.put(
            {"progress": 0, "message": str(e), "done": True, "error": str(e)}
        )
        return None

    if not _onnx_files_ready(model_root):
        err = "Extracted files incomplete"
        progress_queue.put(
            {"progress": 0, "message": err, "done": True, "error": err}
        )
        return None

    progress_queue.put(
        {
            "progress": 100,
            "message": "Download complete",
            "done": True,
            "path": str(model_root),
        }
    )
    return str(model_root)


def run_download_async(progress_callback: Callable[[dict], None]) -> Optional[str]:
    """
    Run download in a thread and call progress_callback with progress dicts.
    Blocks until download completes. Returns model root path or None.
    """
    q: "queue.Queue[Optional[dict]]" = queue.Queue()
    result: list[Optional[str]] = [None]

    def worker():
        result[0] = _download_with_progress(q)
        q.put(None)

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

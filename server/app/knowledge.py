"""
Custom knowledge packs: file storage, summarization, and context compilation.
"""
import base64
import mimetypes
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from langchain_core.messages import HumanMessage, SystemMessage

from app.database import (
    create_knowledge_asset,
    delete_knowledge_asset,
    get_knowledge_assets,
    get_knowledge_pack,
    get_knowledge_storage_dir,
    get_thread_knowledge,
    list_knowledge_packs,
    lock_thread_knowledge,
    upsert_thread_knowledge,
    update_knowledge_asset_summary,
)
from app.agent import agent_manager

TEXT_EXTENSIONS = {
    ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".xml", ".html", ".htm",
    ".js", ".ts", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp",
    ".h", ".css", ".scss", ".sql", ".sh", ".bat", ".ps1", ".toml", ".ini",
    ".cfg", ".log", ".rst", ".tex",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
MAX_TEXT_BYTES = 512 * 1024
SUMMARY_MAX_CHARS = 2000


def _asset_type_for_filename(filename: str) -> Optional[str]:
    ext = Path(filename).suffix.lower()
    if ext in TEXT_EXTENSIONS:
        return "text"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return None


def _resolve_storage_path(relative_path: str) -> Path:
    return get_knowledge_storage_dir() / relative_path


async def _ensure_llm():
    if not agent_manager._llm:
        await agent_manager._initialize_agent_async(chat_mode="chat", speed_mode="flash")
    if not agent_manager._llm:
        raise RuntimeError("LLM is not initialized. Please verify provider settings.")


def _extract_text_content(response: Any) -> str:
    content = getattr(response, "content", "")
    if isinstance(content, list):
        text_parts = [part.get("text", "") for part in content if isinstance(part, dict)]
        content = "\n".join([p for p in text_parts if p])
    return (content or "").strip()


async def summarize_text_content(text: str, filename: str) -> str:
    await _ensure_llm()
    truncated = text[:8000]
    system_text = (
        "Summarize this document concisely for use as AI context. "
        "Capture key facts, definitions, and actionable details. "
        "Return plain text only, no markdown headers."
    )
    user_text = f"Filename: {filename}\n\nDocument:\n{truncated}"
    response = await agent_manager._llm.ainvoke(
        [SystemMessage(content=system_text), HumanMessage(content=user_text)]
    )
    summary = _extract_text_content(response)
    if not summary:
        raise RuntimeError("Model returned empty summary for text asset.")
    return summary[:SUMMARY_MAX_CHARS]


async def summarize_image_file(storage_path: Path, filename: str) -> str:
    await _ensure_llm()
    if not storage_path.exists():
        raise RuntimeError(f"Image file not found: {storage_path}")
    raw = storage_path.read_bytes()
    mime, _ = mimetypes.guess_type(filename)
    if not mime or not mime.startswith("image/"):
        mime = "image/png"
    b64 = base64.b64encode(raw).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"
    system_text = (
        "Describe this image in detail for use as AI context. "
        "Include visible text, objects, layout, and any relevant information."
    )
    content = [
        {"type": "text", "text": f"Filename: {filename}"},
        {"type": "image_url", "image_url": {"url": data_url}},
    ]
    response = await agent_manager._llm.ainvoke(
        [SystemMessage(content=system_text), HumanMessage(content=content)]
    )
    summary = _extract_text_content(response)
    if not summary:
        raise RuntimeError("Model returned empty summary for image asset.")
    return summary[:SUMMARY_MAX_CHARS]


def compile_pack_context(pack_id: str) -> str:
    pack = get_knowledge_pack(pack_id)
    if not pack:
        return ""
    assets = get_knowledge_assets(pack_id)
    lines = [f"[Custom Knowledge: {pack['name']}]"]
    instructions = (pack.get("instructions") or "").strip()
    if instructions:
        lines.append("Instructions:")
        lines.append(instructions)
    for asset in assets:
        summary = (asset.get("summary") or "").strip()
        if not summary:
            continue
        lines.append("")
        lines.append(f"--- {asset['filename']} ---")
        lines.append(summary)
    return "\n".join(lines).strip()


def build_thread_knowledge_context(
    thread_id: str,
    new_knowledge_ids: Optional[List[str]] = None,
) -> Tuple[str, List[str]]:
    """
    Merge thread knowledge rows with newly attached ids.
    Returns combined context string and ordered list of knowledge ids included.
    """
    existing = get_thread_knowledge(thread_id)
    existing_ids = {row["knowledge_id"] for row in existing}
    all_ids: List[str] = [row["knowledge_id"] for row in existing]

    for kid in new_knowledge_ids or []:
        if kid and kid not in existing_ids:
            all_ids.append(kid)
            existing_ids.add(kid)

    blocks: List[str] = []
    included_ids: List[str] = []

    existing_by_id = {row["knowledge_id"]: row for row in existing}

    for kid in all_ids:
        row = existing_by_id.get(kid)
        if row and row.get("is_locked") and (row.get("context_snapshot") or "").strip():
            blocks.append(row["context_snapshot"].strip())
            included_ids.append(kid)
            continue
        pack = get_knowledge_pack(kid)
        if not pack:
            continue
        compiled = compile_pack_context(kid)
        if compiled:
            blocks.append(compiled)
            included_ids.append(kid)

    combined = "\n\n".join(blocks).strip()
    return combined, included_ids


def prepare_thread_knowledge_for_stream(
    thread_id: str,
    new_knowledge_ids: Optional[List[str]] = None,
) -> Tuple[str, Dict[str, str]]:
    """
    Upsert new knowledge attachments and return combined context + snapshots for locking.
    """
    new_ids = [k for k in (new_knowledge_ids or []) if k]
    combined, included_ids = build_thread_knowledge_context(thread_id, new_ids)

    snapshots: Dict[str, str] = {}
    for kid in included_ids:
        pack = get_knowledge_pack(kid)
        if not pack:
            continue
        name = pack["name"]
        compiled = compile_pack_context(kid)
        upsert_thread_knowledge(thread_id, kid, name, context_snapshot=compiled or None)
        if compiled:
            snapshots[kid] = compiled

    return combined, snapshots


def lock_thread_knowledge_after_stream(thread_id: str, snapshots: Dict[str, str]) -> None:
    lock_thread_knowledge(thread_id, snapshots)


async def save_and_summarize_asset(
    pack_id: str,
    filename: str,
    file_bytes: bytes,
) -> Dict[str, Any]:
    pack = get_knowledge_pack(pack_id)
    if not pack:
        raise ValueError("Knowledge pack not found")

    asset_type = _asset_type_for_filename(filename)
    if not asset_type:
        raise ValueError(
            "Unsupported file type. Upload text files (.txt, .md, code) or images (.png, .jpg, .webp)."
        )

    if asset_type == "text" and len(file_bytes) > MAX_TEXT_BYTES:
        raise ValueError(f"Text file exceeds {MAX_TEXT_BYTES // 1024} KB limit.")

    pack_dir = get_knowledge_storage_dir() / pack_id
    pack_dir.mkdir(parents=True, exist_ok=True)

    from uuid import uuid4
    asset_id = str(uuid4())
    safe_name = Path(filename).name
    rel_path = f"{pack_id}/{asset_id}_{safe_name}"
    abs_path = get_knowledge_storage_dir() / rel_path
    abs_path.write_bytes(file_bytes)

    asset = create_knowledge_asset(
        pack_id=pack_id,
        filename=safe_name,
        asset_type=asset_type,
        storage_path=rel_path,
        summary=None,
    )

    try:
        if asset_type == "text":
            text = file_bytes.decode("utf-8", errors="replace")
            summary = await summarize_text_content(text, safe_name)
        else:
            summary = await summarize_image_file(abs_path, safe_name)
        update_knowledge_asset_summary(asset["id"], summary)
        asset["summary"] = summary
    except Exception:
        delete_knowledge_asset(asset["id"])
        if abs_path.exists():
            abs_path.unlink(missing_ok=True)
        raise

    return asset


def get_pack_detail(pack_id: str) -> Optional[Dict[str, Any]]:
    pack = get_knowledge_pack(pack_id)
    if not pack:
        return None
    assets = get_knowledge_assets(pack_id)
    return {
        **pack,
        "assets": assets,
        "asset_count": len(assets),
    }


def list_packs_summary() -> List[Dict[str, Any]]:
    return list_knowledge_packs()


def remove_asset_file(asset_row: Dict[str, Any]) -> None:
    rel = asset_row.get("storage_path")
    if rel:
        path = _resolve_storage_path(rel)
        if path.exists():
            path.unlink(missing_ok=True)

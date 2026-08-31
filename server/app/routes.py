"""  """"""
API routes/endpoints
"""
import asyncio
import json
import queue
import threading
import time
import uuid
from typing import Any, Dict, List, Optional, AsyncIterator
import logging
import httpx

from fastapi import APIRouter, HTTPException, Query, File, UploadFile
from fastapi.responses import StreamingResponse

from app.models import (
    ChatMessage, HealthResponse, SettingsUpdate, SettingsResponse, 
    CancelRequest, ForkThreadRequest, SpeakRequest, ResumeChatRequest, HITLRequestModel,
    ScheduleTaskRequest, ScheduledTaskResponse, ScheduleNotificationItem,
    SubAgentConfig, PlannerGraphConfig, PlannerInstructionGenerateRequest, PlannerInstructionGenerateResponse,
    PlannerToolItem, PlannerToolCatalogResponse,
    DeviceIdentity, FriendRecord, PairingRequest, PairingInitResponse, PairingConfirmRequest, PairingConfirmResponse, PeerAskRequest, PeerReceiveRequest, PeerAskResponse,
    PairingFinalizeRequest,
    FriendStatusResponse,
    NgrokInstallRequest, NgrokInstallResponse, NgrokStatusResponse,
    FriendApprovalRequest, FriendEndpointUpdateRequest,
    FriendPeerAccessPatch, PeerAccessCatalogResponse,
    PeerQueryEventItem,
    PeerStreamCancelRequest,
    KnowledgePackCreate, KnowledgePackUpdate, KnowledgePackResponse, UpdateKnowledgeAssetRequest, ThreadKnowledgeItem, RawTextAssetCreate,
    SkillCreate, SkillUpdate, SkillResponse,
    ImportBackupRequest,
    UpdateScheduledTaskRequest,
)
from app.agent import agent_manager
from app.url_preview import (
    extract_urls,
    fetch_url_previews,
    format_previews_for_agent,
)
from app.scheduler import scheduler_manager, SCHEDULE_INTENTS
from app.scheduler_tools import SCHEDULER_TOOLS
from app.config import settings
from app.windows_tools import WINDOWS_TOOLS
from app.browser import LANGGRAPH_BROWSER_TOOLS
from app.ltm_tools import LTM_TOOLS
from app.mcp_registry_tools import MCP_REGISTRY_TOOLS

from app.mcp_client import mcp_manager
from app.plugins.loader import plugin_registry
from app.plugin_manager import plugin_manager
from app.security_crypto import encrypt_json, decrypt_json
from app.database import (
    save_plugin_integration,
    get_plugin_integration,
    list_plugin_integrations,
    delete_plugin_integration,
    update_setting,
    get_setting,

    create_thread,
    update_thread_title,
    count_user_messages,
    save_message,
    get_threads,
    get_thread_messages,
    fork_thread_messages,
    delete_thread,
    clear_all_history,
    delete_last_message,
    vacuum_checkpoint_db,
    get_unread_schedule_notifications,
    mark_schedule_notification_read,
    mark_all_schedule_notifications_read,
    get_or_create_device_identity,
    update_device_identity_name,
    create_pairing_token,
    consume_pairing_token,
    upsert_friend,
    list_friends,
    get_friend_by_id,
    get_friend_by_device_id,
    delete_friend,
    has_friend_thread_approval,
    approve_friend_for_thread,
    upsert_friend_thread,
    update_friend_public_url,
    update_friend_peer_access,
    append_peer_query_event,
    list_peer_query_events,
    clear_peer_query_events,
    create_knowledge_pack,
    update_knowledge_pack,
    get_knowledge_pack,
    delete_knowledge_pack,
    delete_knowledge_asset,
    update_knowledge_asset,
    get_thread_knowledge,
    create_skill,
    update_skill,
    get_skill,
    list_skills,
    list_thread_skills,
    delete_skill,
    export_backup_data,
    import_backup_data,
)
from app.knowledge import (
    list_packs_summary,
    get_pack_detail,
    save_and_summarize_asset,
    save_raw_text_asset,
    remove_asset_file,
    prepare_thread_knowledge_for_stream,
    lock_thread_knowledge_after_stream,
)
from app.peer_access import (
    compute_effective_tool_ids,
    friend_row_peer_policy,
    patch_to_policy_dict,
    split_catalog_for_profiles,
    validate_patch_tool_ids,
)
from app.connectivity.manager import connectivity_manager
from app.connectivity.constants import PEER_HTTP_ASK_TIMEOUT
from app.connectivity.ngrok_installer import (
    detect_existing_ngrok,
    install_ngrok_windows,
    start_tunnel,
    stop_tunnel,
    get_tunnel_runtime_status,
)
from app.connectivity.ngrok_setup import persist_ngrok_setup
from fastapi.concurrency import run_in_threadpool
import io
import base64

router = APIRouter()
logger = logging.getLogger(__name__)

_friend_stream_lock = asyncio.Lock()
_friend_stream_registry: Dict[str, Dict[str, Any]] = {}


def _friend_record_from_row(row: Dict[str, Any]) -> FriendRecord:
    pa = friend_row_peer_policy(row)
    return FriendRecord(
        id=str(row["id"]),
        name=str(row["name"]),
        device_id=str(row["device_id"]),
        fingerprint=str(row["fingerprint"]),
        public_key=str(row["public_key"]),
        public_url=row.get("public_url"),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        peer_access=pa,
    )


def _get_runtime_tool_catalog_ids() -> set[str]:
    """Best-effort runtime tool ID catalog for validating planner assignments."""
    tool_ids: set[str] = {
        "internet_search",
        "remote_friend_ask",
        "ask_question",
        "read_knowledge_asset",
        "load_skill",
        "execute_batched_plan",
        *[t.name for t in SCHEDULER_TOOLS],
        *WINDOWS_TOOLS.keys(),
        *[t.name for t in LANGGRAPH_BROWSER_TOOLS],
        *[t.name for t in LTM_TOOLS],
        *[t.name for t in MCP_REGISTRY_TOOLS],
    }

    # Dynamic Plugin tools
    try:
        loaded_plugins = getattr(plugin_manager, "tools", []) or []
        for tool in loaded_plugins:
            t_name = getattr(tool, "name", None)
            if t_name and isinstance(t_name, str) and t_name.strip():
                tool_ids.add(t_name.strip())
    except Exception:
        pass

    # External APIs configured by the user.
    for api in settings.EXTERNAL_APIS or []:
        if not isinstance(api, dict):
            continue
        if api.get("enabled", True) is False:
            continue
        name = str(api.get("name", "")).strip()
        if name:
            tool_ids.add(name)
    # MCP tools currently loaded by the MCP manager.
    for tool in getattr(mcp_manager, "tools", []) or []:
        name = getattr(tool, "name", None)
        if isinstance(name, str) and name.strip():
            tool_ids.add(name.strip())
    return tool_ids


def _runtime_catalog_help_text() -> str:
    return (
        "Tool IDs must exist in the current runtime catalog (built-in tools, configured EXTERNAL_APIS names, "
        "or currently loaded MCP tools)."
    )


def _build_skill_context(skill_ids: List[str], project_root: Optional[str] = None) -> str:
    """Build a concatenated skill instructions block for system message injection, including workspace auto-discovered skills."""
    if not skill_ids:
        return ""
    
    parts = []
    import os
    
    # Pre-fetch database skills to look up by ID
    db_skills_dict = {}
    try:
        db_skills = list_skills()
        for item in db_skills:
            db_skills_dict[item["id"]] = item
    except Exception as exc:
        logging.warning("Failed to list skills in _build_skill_context: %s", exc)

    home_dir = os.path.expanduser("~")
    global_rie_dir = os.path.join(home_dir, ".rie")

    for sid in skill_ids:
        content = ""
        title = sid
        
        # 1. DB skill check
        if sid in db_skills_dict:
            skill = db_skills_dict[sid]
            title = skill.get("name", sid)
            content = skill.get("content") or ""
        
        # 2. Workspace skill check
        elif sid.startswith("ws_") and project_root and os.path.isdir(project_root):
            sub_id = sid[3:]
            if sub_id == "claude":
                path = os.path.join(project_root, "CLAUDE.md")
                title = "Workspace CLAUDE.md"
            elif sub_id == "rie":
                path = os.path.join(project_root, "RIE.md")
                title = "Workspace RIE.md"
            else:
                path = os.path.join(project_root, ".rie", "skills", sub_id)
                title = f"Workspace Skill ({sub_id})"
                
            if os.path.isfile(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                except Exception as exc:
                    logging.warning("Failed to read workspace skill file %s: %s", path, exc)
                    
        # 3. Global skill check
        elif sid.startswith("global_"):
            sub_id = sid[7:]
            if sub_id == "claude":
                path = os.path.join(global_rie_dir, "CLAUDE.md")
                title = "Global CLAUDE.md"
            elif sub_id == "rie":
                path = os.path.join(global_rie_dir, "RIE.md")
                title = "Global RIE.md"
            else:
                path = os.path.join(global_rie_dir, "skills", sub_id)
                title = f"Global Skill ({sub_id})"
                
            if os.path.isfile(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        content = f.read()
                except Exception as exc:
                    logging.warning("Failed to read global skill file %s: %s", path, exc)
                    
        if content.strip():
            parts.append(f"--- START SKILL: {title} ---\n{content.strip()}\n--- END SKILL: {title} ---")
            
    return "\n\n".join(parts)


def _validate_subagents_config(raw_value: str) -> list[dict]:
    """Validate SUBAGENTS_CONFIG payload and return normalized objects."""
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid SUBAGENTS_CONFIG JSON: {exc}") from exc

    if not isinstance(parsed, list):
        raise HTTPException(status_code=400, detail="SUBAGENTS_CONFIG must be a JSON array")

    validated: list[dict] = []
    names_seen: set[str] = set()
    for item in parsed:
        try:
            config = SubAgentConfig(**item)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid sub-agent config: {exc}") from exc

        normalized_name = config.name.strip().lower()
        if not normalized_name:
            raise HTTPException(status_code=400, detail="Sub-agent name cannot be empty")
        if normalized_name in names_seen:
            raise HTTPException(status_code=400, detail=f"Duplicate sub-agent name: {config.name}")
        names_seen.add(normalized_name)

        if not config.system_prompt.strip():
            raise HTTPException(
                status_code=400,
                detail=f"Sub-agent '{config.name}' must have a non-empty system_prompt",
            )

        validated.append(config.model_dump())
    required_members = {"coding_specialist", "mcp_registry"}
    missing_required = [name for name in required_members if name not in names_seen]
    if missing_required:
        raise HTTPException(
            status_code=400,
            detail=f"SUBAGENTS_CONFIG must include protected members: {', '.join(sorted(required_members))}",
        )

    return validated


CANONICAL_PROTECTED_SUBAGENTS = {
    "coding_specialist": {
        "description": "Expert at reading, modifying, creating, and debugging code in the workspace and running system terminal commands.",
        "system_prompt": "You are an expert coding specialist. You have direct access to project files and terminal tools. Always select the most specific dedicated tools for viewing, editing, or searching files over writing raw scripts. When running terminal commands on the host OS (Windows), you MUST use native PowerShell/Windows commands rather than Linux commands (e.g. use type/Get-Content instead of cat, echo/New-Item instead of touch, and proper path formats). Write clean, bug-free, well-documented code adhering to the project's existing conventions and run tests to verify your work.",
        "tool_ids": ["run_terminal_command"],
    },
    "web_researcher": {
        "description": "Expert at web research, searching the internet, scraping websites, extracting documentation, and browser automation.",
        "system_prompt": "You are a web research and browser automation specialist. Use your internet search and browser tools to navigate websites, extract accurate information, scrape articles, and synthesize research findings concisely for the user.",
        "tool_ids": [
            "internet_search",
            "browser_open",
            "browser_snapshot",
            "browser_click",
            "browser_type",
            "browser_navigate",
            "browser_scroll",
            "browser_tabs",
            "browser_extract",
            "browser_close",
        ],
    },
    "desktop_controller": {
        "description": "Expert at automating Windows desktop applications, inspecting active GUI states, and simulating mouse and keyboard actions.",
        "system_prompt": "You are a Windows desktop automation specialist. Use your desktop inspection, application control, mouse, and keyboard tools to interact with native Windows software, manage active windows, and automate user interface workflows.",
        "tool_ids": [
            "get_desktop_state",
            "app_control",
            "mouse_click",
            "keyboard_type",
            "move_mouse",
            "scroll_mouse",
            "drag_mouse",
            "press_keys",
            "wait",
        ],
    },
    "mcp_registry": {
        "description": "Expert at managing MCP (Model Context Protocol) server connections, configurations, and registry.",
        "system_prompt": "You are an MCP registry specialist. You can list, add, update, and delete MCP server configurations and inspect MCP capabilities. Use your dedicated MCP tools to manage external server connections, tools, and integrations for Rie.",
        "tool_ids": ["list_mcp_servers", "add_mcp_server", "update_mcp_server", "delete_mcp_server"],
    },
}


def _derive_subagents_from_planner_graph(graph_payload: dict) -> list[dict]:
    """Derive runtime SUBAGENTS_CONFIG list from validated planner graph payload."""
    nodes = graph_payload.get("nodes", []) if isinstance(graph_payload, dict) else []
    runtime_subagents: list[dict] = []
    for node in nodes:
        node_name = (node.get("name") or "").strip().lower()
        if node_name in CANONICAL_PROTECTED_SUBAGENTS:
            canonical = CANONICAL_PROTECTED_SUBAGENTS[node_name]
            runtime_subagents.append(
                {
                    "name": node_name,
                    "description": canonical["description"],
                    "system_prompt": canonical["system_prompt"],
                    "tool_ids": list(set((node.get("tool_ids") or []) + canonical["tool_ids"])),
                    "enabled": bool(node.get("enabled", True)),
                }
            )
        else:
            runtime_subagents.append(
                {
                    "name": (node.get("name") or "").strip(),
                    "description": node.get("description") or "",
                    "system_prompt": (node.get("system_prompt") or "").strip(),
                    "tool_ids": node.get("tool_ids") or [],
                    "enabled": bool(node.get("enabled", True)),
                }
            )
    return runtime_subagents

def _validate_planner_graph(raw_value: str) -> dict:
    """Validate SUBAGENT_PLANNER_GRAPH payload and enforce single-level graph rules."""
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid SUBAGENT_PLANNER_GRAPH JSON: {exc}") from exc

    try:
        graph = PlannerGraphConfig(**parsed)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid planner graph: {exc}") from exc

    main_node_id = (graph.main_node_id or "").strip() or "main_agent"
    main_instruction = (graph.main_instruction or "").strip()
    if not main_instruction:
        raise HTTPException(status_code=400, detail="main_instruction cannot be empty")
    main_tool_ids: list[str] = []
    for tool_id in graph.main_tool_ids or []:
        if not isinstance(tool_id, str):
            continue
        normalized = tool_id.strip()
        if normalized and normalized not in main_tool_ids:
            main_tool_ids.append(normalized)
    runtime_tool_ids = _get_runtime_tool_catalog_ids()
    unknown_main_tool_ids = [tool_id for tool_id in main_tool_ids if tool_id not in runtime_tool_ids]
    if unknown_main_tool_ids:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown main tool IDs: {', '.join(sorted(unknown_main_tool_ids))}. {_runtime_catalog_help_text()}",
        )
    node_ids = set()
    node_names = set()
    normalized_nodes = []
    for node in graph.nodes:
        node_id = node.id.strip()
        if not node_id:
            raise HTTPException(status_code=400, detail="Planner node id cannot be empty")
        if node_id in node_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate planner node id: {node_id}")
        node_ids.add(node_id)

        node_name = node.name.strip().lower()
        if not node_name:
            raise HTTPException(status_code=400, detail="Planner node name cannot be empty")
        if node_name in node_names:
            raise HTTPException(status_code=400, detail=f"Duplicate planner node name: {node.name}")
        node_names.add(node_name)

        if node_name in CANONICAL_PROTECTED_SUBAGENTS:
            canonical = CANONICAL_PROTECTED_SUBAGENTS[node_name]
            node_desc = canonical["description"]
            node_prompt = canonical["system_prompt"]
            required_tools = canonical["tool_ids"]
        else:
            node_desc = node.description
            node_prompt = node.system_prompt.strip()
            required_tools = []

        if not node_prompt:
            raise HTTPException(status_code=400, detail=f"Planner node '{node.name}' must include system_prompt")

        normalized_tool_ids: list[str] = []
        for tool_id in (node.tool_ids or []) + required_tools:
            if not isinstance(tool_id, str):
                continue
            normalized = tool_id.strip()
            if normalized and normalized not in normalized_tool_ids:
                normalized_tool_ids.append(normalized)
        unknown_node_tool_ids = [tool_id for tool_id in normalized_tool_ids if tool_id not in runtime_tool_ids]
        if unknown_node_tool_ids:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Planner node '{node.name}' references unknown tool IDs: "
                    f"{', '.join(sorted(unknown_node_tool_ids))}. {_runtime_catalog_help_text()}"
                ),
            )
        normalized_nodes.append(
            node.model_copy(
                update={
                    "name": node_name,
                    "description": node_desc,
                    "system_prompt": node_prompt,
                    "tool_ids": normalized_tool_ids,
                }
            )
        )

    required_members = {"coding_specialist", "mcp_registry"}
    missing_required = [name for name in required_members if name not in node_names]
    if missing_required:
        raise HTTPException(
            status_code=400,
            detail=f"Planner must include protected members: {', '.join(sorted(required_members))}",
        )

    for edge in graph.edges:
        if edge.source != main_node_id:
            raise HTTPException(
                status_code=400,
                detail=f"Only single-level edges from '{main_node_id}' are allowed",
            )
        if edge.target not in node_ids:
            raise HTTPException(status_code=400, detail=f"Edge target '{edge.target}' does not exist")

    return PlannerGraphConfig(
        main_node_id=main_node_id,
        main_label=(graph.main_label or "").strip() or "Rie",
        main_logo_url=graph.main_logo_url,
        main_tool_ids=main_tool_ids,
        main_instruction=main_instruction,
        nodes=normalized_nodes,
        edges=graph.edges,
    ).model_dump()


@router.post("/chat/cancel")
async def chat_cancel(data: CancelRequest):
    """
    Cancel a running LangChain stream for a specific thread_id
    """
    success = await agent_manager.cancel_run(data.thread_id)
    
    # Also delete the last user message from history
    try:
        await run_in_threadpool(delete_last_message, data.thread_id, "user")
    except Exception as e:
        logging.error(f"Failed to delete last message on cancel: {e}")

    if success:
        return {"status": "success", "message": f"Cancelled run for thread {data.thread_id}"}
    else:
        return {"status": "ignored", "message": f"No active run found for thread {data.thread_id}"}


@router.post("/audio/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribe audio file using Groq's Whisper API
    """
    if not settings.GROQ_API_KEY:
        raise HTTPException(status_code=400, detail="Groq API key not configured")

    try:
        from openai import AsyncOpenAI
        
        # Groq's Whisper API is OpenAI compatible
        client = AsyncOpenAI(
            api_key=settings.GROQ_API_KEY,
            base_url="https://api.groq.com/openai/v1"
        )

        # Read file content
        content = await file.read()
        
        # Call Groq Whisper API
        # We need to pass the file as a tuple (filename, content, content_type)
        transcription = await client.audio.transcriptions.create(
            model="whisper-large-v3",
            file=(file.filename, content, file.content_type),
            response_format="json"
        )
        
        return {"text": transcription.text}
    except Exception as e:
        logging.error(f"Transcription failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")


@router.post("/audio/speak")
async def speak_text(data: SpeakRequest):
    """
    Convert text to speech using edge-tts or Groq and stream the audio back.
    """
    provider = data.provider or settings.TTS_PROVIDER
    voice = data.voice or settings.TTS_VOICE
    
    try:
        if provider == "groq":
            if not settings.GROQ_API_KEY:
                raise HTTPException(status_code=400, detail="Groq API key not configured")
            
            from openai import AsyncOpenAI
            client = AsyncOpenAI(
                api_key=settings.GROQ_API_KEY,
                base_url="https://api.groq.com/openai/v1"
            )
            
            # Groq Orpheus has a 200 char limit
            text_to_speak = data.text[:200]
            
            response = await client.audio.speech.create(
                model="canopylabs/orpheus-v1-english",
                voice=voice,
                input=text_to_speak,
                response_format="wav"
            )
            
            # OpenAI speech response.content is the audio data
            # For AsyncOpenAI, it might be a stream or a full response
            # According to Groq docs, it returns the binary audio
            return StreamingResponse(
                io.BytesIO(response.content),
                media_type="audio/wav"
            )
            
        else: # Default/edge-tts
            import edge_tts
            
            # Ensure valid Edge TTS voice, fallback to default if invalid/mismatched (e.g. 'hannah')
            if not voice or "Neural" not in str(voice):
                voice = "en-US-EmmaNeural"

            try:
                communicate = edge_tts.Communicate(data.text, voice)
            except Exception as init_err:
                logging.warning(f"Edge TTS init failed for voice '{voice}', falling back to 'en-US-EmmaNeural': {init_err}")
                voice = "en-US-EmmaNeural"
                communicate = edge_tts.Communicate(data.text, voice)

            async def audio_generator():
                try:
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            yield chunk["data"]
                except Exception as stream_err:
                    logging.error(f"Edge TTS streaming error: {stream_err}")

            return StreamingResponse(
                audio_generator(),
                media_type="audio/mpeg"
            )
    except Exception as e:
        logging.error(f"TTS failed ({provider}): {str(e)}")
        raise HTTPException(status_code=500, detail=f"TTS failed: {str(e)}")


@router.post("/planner/generate-instruction", response_model=PlannerInstructionGenerateResponse)
async def planner_generate_instruction(data: PlannerInstructionGenerateRequest):
    """Generate a member instruction prompt using configured backend LLM."""
    if not data.member_name.strip():
        raise HTTPException(status_code=400, detail="member_name is required")

    try:
        instruction = await agent_manager.generate_planner_instruction(
            boss_name=data.boss_name,
            member_name=data.member_name,
            member_description=data.member_description or "",
            selected_tools=data.selected_tools or [],
            style=data.style,
            tone=data.tone,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.error(f"Failed to generate planner instruction: {exc}")
        raise HTTPException(status_code=500, detail="Instruction generation failed") from exc

    return PlannerInstructionGenerateResponse(
        instruction_text=instruction,
        reasoning_summary=f"Generated for {data.member_name.strip()} with {len(data.selected_tools or [])} tools.",
    )


@router.get("/planner/tools", response_model=PlannerToolCatalogResponse)
async def get_planner_tools():
    """Returns the full categorized runtime tool catalog for planner assignment."""
    tools: list[PlannerToolItem] = []
    seen_ids: set[str] = set()

    def _add(tid: str, label: str, desc: str, src: str, enabled: bool = True):
        if not tid or tid in seen_ids:
            return
        seen_ids.add(tid)
        tools.append(PlannerToolItem(id=tid, label=label, description=desc, source=src, enabled=enabled))

    # Built-in system tools
    _add("internet_search", "Internet Search", "Search the web for current facts, articles, and documentation.", "built-in")
    _add("ask_question", "Ask Question", "Ask the user an interactive clarifying question with multiple choices.", "built-in")
    _add("run_terminal_command", "System Terminal", "Execute a terminal command on the Windows system.", "built-in")
    _add("get_desktop_state", "Desktop State", "Capture current desktop state, active apps, and interactive elements.", "built-in")
    _add("app_control", "App Control", "Launch, switch, or resize Windows desktop applications.", "built-in")
    _add("mouse_click", "Mouse Click", "Perform a mouse click at specific coordinates.", "built-in")
    _add("keyboard_type", "Keyboard Type", "Type text into an application or active window.", "built-in")
    _add("move_mouse", "Move Mouse", "Move mouse cursor to specific coordinates.", "built-in")
    _add("scroll_mouse", "Scroll Mouse", "Scroll vertically or horizontally.", "built-in")
    _add("drag_mouse", "Drag Mouse", "Drag from current position to target coordinates.", "built-in")
    _add("press_keys", "Press Keys", "Press keyboard shortcuts or key combinations.", "built-in")
    _add("wait", "Wait", "Pause execution for a specified duration.", "built-in")

    # Browser tools
    for bt in LANGGRAPH_BROWSER_TOOLS:
        tname = bt.name
        tlabel = tname.replace("_", " ").title()
        tdesc = getattr(bt, "description", "") or "Browser automation tool"
        _add(tname, tlabel, tdesc, "browser")

    # Memory / LTM tools
    for lt in LTM_TOOLS:
        tname = lt.name
        tlabel = tname.replace("_", " ").title()
        _add(tname, tlabel, getattr(lt, "description", "") or "Memory retrieval and persistence tool", "built-in")

    # Knowledge & Skills & Task tools
    _add("read_knowledge_asset", "Read Knowledge Asset", "Read repository knowledge documents or indexed assets.", "built-in")
    _add("load_skill", "Load Skill", "Load specialized skill instructions on demand.", "built-in")
    for st in SCHEDULER_TOOLS:
        tname = st.name
        _add(tname, tname.replace("_", " ").title(), getattr(st, "description", "") or "Task scheduler tool", "built-in")
    _add("remote_friend_ask", "Remote Friend Ask", "Query paired peer Rie instances on the local network.", "built-in")
    _add("execute_batched_plan", "Execute Batched Plan", "Execute a multi-step deterministic tool chain in a single turn.", "built-in")

    # MCP Registry Tools
    for mt in MCP_REGISTRY_TOOLS:
        tname = mt.name
        _add(tname, tname.replace("_", " ").title(), getattr(mt, "description", "") or "MCP registry tool", "mcp")

    # Plugin tools
    try:
        plugin_tools = getattr(plugin_manager, "tools", []) or []
        for pt in plugin_tools:
            tname = getattr(pt, "name", None)
            if tname:
                _add(tname, tname.replace("_", " ").title(), getattr(pt, "description", "") or "Plugin tool", "plugin")
    except Exception:
        pass

    # External APIs configured by user
    for api in settings.EXTERNAL_APIS or []:
        if isinstance(api, dict):
            name = str(api.get("name", "")).strip()
            if name:
                desc = api.get("description") or f"External API: {name}"
                _add(name, name, desc, "external", enabled=bool(api.get("enabled", True)))

    # Dynamically loaded MCP tools
    for mcp_tool in getattr(mcp_manager, "tools", []) or []:
        name = getattr(mcp_tool, "name", None)
        if name and isinstance(name, str) and name.strip():
            _add(name.strip(), name.strip(), getattr(mcp_tool, "description", "") or "Dynamic MCP tool", "mcp")

    return PlannerToolCatalogResponse(tools=tools)


@router.get("/rie/usage")
async def get_rie_usage():
    """
    Proxy request to Rie SaaS usage endpoint using stored token
    """
    if not settings.RIE_ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.RIE_API_URL}/usage",
                headers={"Authorization": f"Bearer {settings.RIE_ACCESS_TOKEN}"},
                timeout=10.0
            )
            
            if response.status_code == 401:
                # Token expired or invalid
                raise HTTPException(status_code=401, detail="Session expired")
                
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail=response.text)
                
            return response.json()
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch usage: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


GEMINI_MODEL_FALLBACK = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
]


@router.get("/gemini/models")
async def get_gemini_models():
    """
    Fetch available Gemini models from the Generative Language API (uses configured Google API key).
    """
    api_key = settings.GOOGLE_API_KEY
    if not api_key or api_key == "your_gemini_api_key_here":
        return {"models": GEMINI_MODEL_FALLBACK}

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key},
                timeout=10.0,
            )
            if response.status_code != 200:
                logging.error("Failed to fetch Gemini models: %s", response.text)
                return {"models": GEMINI_MODEL_FALLBACK}

            data = response.json()
            models: List[str] = []
            for model in data.get("models", []):
                methods = model.get("supportedGenerationMethods") or []
                if "generateContent" not in methods:
                    continue
                name = model.get("name", "")
                if name.startswith("models/"):
                    name = name[len("models/") :]
                if name:
                    models.append(name)

            models.sort()
            return {"models": models if models else GEMINI_MODEL_FALLBACK}
    except Exception as e:
        logging.error("Failed to fetch Gemini models: %s", e)
        return {"models": GEMINI_MODEL_FALLBACK}


@router.get("/ollama/models")
async def get_ollama_models():
    """
    Fetch list of downloaded models from Ollama instance (uses configured endpoint and optional API key).
    """
    try:
        headers = {}
        if settings.OLLAMA_API_KEY:
            headers["Authorization"] = f"Bearer {settings.OLLAMA_API_KEY}"
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{settings.OLLAMA_API_URL.rstrip('/')}/api/tags",
                headers=headers,
                timeout=5.0,
            )
            if response.status_code != 200:
                return {"models": []}
            
            data = response.json()
            models = [model["name"] for model in data.get("models", [])]
            return {"models": models}
    except Exception as e:
        logging.error(f"Failed to fetch Ollama models: {e}")
        return {"models": []}


@router.get("/key-rotation-stats")
async def get_key_rotation_stats():
    """
    Get per-key rotation usage statistics for the active LLM provider.
    Returns null/empty if only a single key is configured or provider is not rotating.
    """
    stats = agent_manager.get_key_rotation_stats()
    if stats is None:
        return {
            "rotating": False,
            "provider": settings.LLM_PROVIDER or "unknown",
            "total_keys": 0,
            "keys": [],
        }
    return {"rotating": True, **stats}


@router.get("/settings", response_model=SettingsResponse)
async def get_settings():
    """
    Get current settings (always masked)
    """
    settings.reload()
    
    def mask_key(key: Optional[str]) -> Optional[str]:
        return key

    return SettingsResponse(
        groq_api_key=mask_key(settings.GROQ_API_KEY_STRING),
        google_api_key=mask_key(settings.GOOGLE_API_KEY_STRING),
        openai_api_key=mask_key(settings.OPENAI_API_KEY_STRING),
        deepseek_api_key=mask_key(settings.DEEPSEEK_API_KEY_STRING),
        glm_api_key=mask_key(settings.GLM_API_KEY_STRING),
        anthropic_api_key=mask_key(settings.ANTHROPIC_API_KEY),
        tavily_api_key=mask_key(settings.TAVILY_API_KEY),
        brave_search_api_key=mask_key(settings.BRAVE_SEARCH_API_KEY),
        web_search_provider=settings.WEB_SEARCH_PROVIDER,
        camofox_headless_mode=settings.CAMOFOX_HEADLESS_MODE,

        llm_provider=settings.LLM_PROVIDER,
        fallback_llm_provider=settings.FALLBACK_LLM_PROVIDER,
        vertex_project=settings.VERTEX_PROJECT,
        vertex_location=settings.VERTEX_LOCATION,
        vertex_credentials_path=settings.VERTEX_CREDENTIALS_PATH,
        
        groq_model=settings.GROQ_MODEL,
        gemini_model=settings.GEMINI_MODEL,
        vertex_model=settings.VERTEX_MODEL,
        openai_model=settings.OPENAI_MODEL,
        openai_base_url=settings.OPENAI_BASE_URL,
        deepseek_model=settings.DEEPSEEK_MODEL,
        deepseek_base_url=settings.DEEPSEEK_BASE_URL,
        glm_model=settings.GLM_MODEL,
        glm_base_url=settings.GLM_BASE_URL,
        
        enabled_tools=settings.ENABLED_TOOLS,
        terminal_restrictions=settings.TERMINAL_RESTRICTIONS,
        mcp_servers=settings.MCP_SERVERS,
        window_mode=settings.WINDOW_MODE,
        chat_mode=settings.CHAT_MODE,
        speed_mode=settings.SPEED_MODE,
        agent_orchestration_mode=settings.AGENT_ORCHESTRATION_MODE,
        hitl_enabled=settings.HITL_ENABLED,
        hitl_mode=settings.HITL_MODE,
        
        langsmith_tracing=settings.LANGSMITH_TRACING,
        langsmith_api_key=mask_key(settings.LANGSMITH_API_KEY),
        langsmith_project=settings.LANGSMITH_PROJECT,
        langsmith_endpoint=settings.LANGSMITH_ENDPOINT,
        voice_reply=settings.VOICE_REPLY,
        share_location=settings.SHARE_LOCATION,
        exclude_from_capture=settings.EXCLUDE_FROM_CAPTURE,
        capture_screen_as_text=settings.CAPTURE_SCREEN_AS_TEXT,
        floating_chat_opacity=settings.FLOATING_CHAT_OPACITY,
        show_bubble=settings.SHOW_BUBBLE,
        bubble_show_label=settings.BUBBLE_SHOW_LABEL,
        bubble_size=settings.BUBBLE_SIZE,
        bubble_transparent_bg=settings.BUBBLE_TRANSPARENT_BG,
        bubble_snap_edge=settings.BUBBLE_SNAP_EDGE,
        bubble_show_tools=settings.BUBBLE_SHOW_TOOLS,
        rie_access_token=mask_key(settings.RIE_ACCESS_TOKEN),
        tts_provider=settings.TTS_PROVIDER,
        tts_voice=settings.TTS_VOICE,
        ollama_model=settings.OLLAMA_MODEL,
        ollama_api_url=(get_setting("OLLAMA_API_URL") or "").strip(),
        ollama_api_key=mask_key(settings.OLLAMA_API_KEY) if settings.OLLAMA_API_KEY else None,
        embedding_source=settings.EMBEDDING_SOURCE,
        embedding_model_path=settings.EMBEDDING_MODEL_PATH,
        external_apis=settings.EXTERNAL_APIS,
        subagents_config=settings.SUBAGENTS_CONFIG,
        subagent_planner_graph=settings.SUBAGENT_PLANNER_GRAPH,
        connectivity_ngrok_enabled=settings.CONNECTIVITY_NGROK_ENABLED,
        connectivity_public_url=settings.CONNECTIVITY_PUBLIC_URL,
        connectivity_device_name=settings.CONNECTIVITY_DEVICE_NAME,
        connectivity_ngrok_install_path=settings.CONNECTIVITY_NGROK_INSTALL_PATH,
        connectivity_ngrok_domain=settings.CONNECTIVITY_NGROK_DOMAIN,
    )


def _looks_like_masked_secret(value: str) -> bool:
    """Detect masked API keys returned by GET /settings (e.g. tvly****abcd)."""
    if not value:
        return False
    
    # Split by comma or newline for multi-key support
    parts = [p.strip() for p in value.replace('\n', ',').split(',') if p.strip()]
    if not parts:
        return False
        
    def _is_single_masked(val: str) -> bool:
        if len(val) <= 8:
            return set(val) == {"*"}
        middle = val[4:-4]
        return bool(middle) and all(ch == "*" for ch in middle)
        
    return any(_is_single_masked(p) for p in parts)


_SECRET_SETTING_KEYS = frozenset({
    "GROQ_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY",
    "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "LANGSMITH_API_KEY",
    "RIE_ACCESS_TOKEN", "OLLAMA_API_KEY", "CONNECTIVITY_NGROK_AUTH_TOKEN",
})


@router.post("/settings")
async def update_settings(data: SettingsUpdate):
    """
    Update a specific setting
    """
    # Allowed keys to prevent arbitrary DB writes
    ALLOWED_KEYS = {
        "GROQ_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY",
        "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY",
        "WEB_SEARCH_PROVIDER",
        "VERTEX_PROJECT", "VERTEX_LOCATION", "VERTEX_CREDENTIALS_PATH",
        "LLM_PROVIDER", "FALLBACK_LLM_PROVIDER", "ENABLED_TOOLS", "TERMINAL_RESTRICTIONS",
        "GROQ_MODEL", "GEMINI_MODEL", "VERTEX_MODEL", "OPENAI_MODEL", "OPENAI_BASE_URL",
        "DEEPSEEK_MODEL", "DEEPSEEK_BASE_URL", "GLM_MODEL", "GLM_BASE_URL",
        "MCP_SERVERS", "WINDOW_MODE", "CHAT_MODE", "SPEED_MODE", "AGENT_ORCHESTRATION_MODE", "HITL_ENABLED", "HITL_MODE",
        "LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_ENDPOINT",
        "VOICE_REPLY", "SHARE_LOCATION", "EXCLUDE_FROM_CAPTURE", "CAPTURE_SCREEN_AS_TEXT", "FLOATING_CHAT_OPACITY", "SHOW_BUBBLE", "RIE_ACCESS_TOKEN", "TTS_PROVIDER", "TTS_VOICE",
        "BUBBLE_SHOW_LABEL", "BUBBLE_SIZE", "BUBBLE_TRANSPARENT_BG", "BUBBLE_SNAP_EDGE", "BUBBLE_SHOW_TOOLS",
        "OLLAMA_MODEL", "OLLAMA_API_URL", "OLLAMA_API_KEY", "EXTERNAL_APIS",
        "EMBEDDING_SOURCE", "EMBEDDING_MODEL_PATH",
        "SUBAGENTS_CONFIG",
        "SUBAGENT_PLANNER_GRAPH",
        "CONNECTIVITY_NGROK_ENABLED",
        "CONNECTIVITY_PUBLIC_URL",
        "CONNECTIVITY_DEVICE_NAME",
        "CONNECTIVITY_NGROK_INSTALL_PATH",
        "CONNECTIVITY_NGROK_AUTH_TOKEN",
        "CONNECTIVITY_NGROK_DOMAIN",
    }
    
    if data.key not in ALLOWED_KEYS:
        raise HTTPException(status_code=400, detail=f"Invalid setting key: {data.key}")
    if data.key == "AGENT_ORCHESTRATION_MODE":
        mode = (data.value or "").strip().lower()
        if mode not in {"solo", "team"}:
            raise HTTPException(status_code=400, detail="AGENT_ORCHESTRATION_MODE must be 'solo' or 'team'")
        value_to_store = mode
    elif data.key == "HITL_MODE":
        mode = (data.value or "").strip().lower()
        if mode not in {"disable", "always", "let_decide"}:
            raise HTTPException(status_code=400, detail="HITL_MODE must be 'disable', 'always' or 'let_decide'")
        value_to_store = mode
    elif data.key == "WEB_SEARCH_PROVIDER":
        provider = (data.value or "").strip().lower()
        if provider not in {"tavily", "brave", "duckduckgo"}:
            raise HTTPException(
                status_code=400,
                detail="WEB_SEARCH_PROVIDER must be 'tavily', 'brave', or 'duckduckgo'",
            )
        value_to_store = provider
    elif data.key == "FLOATING_CHAT_OPACITY":
        try:
            val = float(data.value)
            if not (0.1 <= val <= 1.0):
                raise ValueError()
            value_to_store = str(val)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="FLOATING_CHAT_OPACITY must be a float between 0.1 and 1.0",
            )
    else:
        value_to_store = data.value

    if data.key in _SECRET_SETTING_KEYS and _looks_like_masked_secret(str(value_to_store or "")):
        return {
            "status": "success",
            "message": f"{data.key} unchanged (masked display value was not saved)",
        }

    derived_subagents_value: Optional[str] = None
    if data.key == "SUBAGENTS_CONFIG":
        validated = _validate_subagents_config(data.value)
        value_to_store = json.dumps(validated)
    elif data.key == "SUBAGENT_PLANNER_GRAPH":
        validated_graph = _validate_planner_graph(data.value)
        value_to_store = json.dumps(validated_graph)
        derived_subagents = _derive_subagents_from_planner_graph(validated_graph)
        validated_subagents = _validate_subagents_config(json.dumps(derived_subagents))
        derived_subagents_value = json.dumps(validated_subagents)

    ngrok_toggle_message: Optional[str] = None

    # Update DB
    update_setting(data.key, value_to_store)
    if data.key == "CONNECTIVITY_NGROK_ENABLED":
        enabled = str(value_to_store).strip().lower() == "true"
        if not enabled:
            pid_raw = (get_setting("CONNECTIVITY_NGROK_TUNNEL_PID") or "").strip()
            pid_hint = int(pid_raw) if pid_raw.isdigit() else None
            stop_result = await run_in_threadpool(stop_tunnel, pid_hint)
            update_setting("CONNECTIVITY_PUBLIC_URL", "")
            update_setting("CONNECTIVITY_NGROK_TUNNEL_PID", "")
            ngrok_toggle_message = stop_result.get("message") or "ngrok stopped"
        else:
            token = (get_setting("CONNECTIVITY_NGROK_AUTH_TOKEN") or "").strip()
            domain = (get_setting("CONNECTIVITY_NGROK_DOMAIN") or "").strip() or None
            install_path = (get_setting("CONNECTIVITY_NGROK_INSTALL_PATH") or "").strip()
            if not install_path:
                detected = await run_in_threadpool(detect_existing_ngrok)
                install_path = (detected.get("path") or "").strip()
            if token and install_path:
                try:
                    start_result = await run_in_threadpool(start_tunnel, install_path, token, domain)
                except Exception as exc:
                    start_result = {
                        "ok": False,
                        "running": False,
                        "pid": None,
                        "public_url": None,
                        "message": f"ngrok start failed: {exc}",
                    }
                if start_result.get("ok"):
                    await run_in_threadpool(
                        persist_ngrok_setup,
                        install_path,
                        start_result.get("public_url"),
                        start_result.get("pid"),
                        domain,
                    )
                    ngrok_toggle_message = "ngrok tunnel started from saved settings"
                else:
                    update_setting("CONNECTIVITY_PUBLIC_URL", "")
                    update_setting("CONNECTIVITY_NGROK_TUNNEL_PID", "")
                    ngrok_toggle_message = start_result.get("message") or "ngrok tunnel failed to start"
            else:
                update_setting("CONNECTIVITY_PUBLIC_URL", "")
                update_setting("CONNECTIVITY_NGROK_TUNNEL_PID", "")
                ngrok_toggle_message = "ngrok enabled; complete setup by saving auth token and install path"
    if derived_subagents_value is not None:
        update_setting("SUBAGENTS_CONFIG", derived_subagents_value)
    
    # Reload settings in memory
    settings.reload()
    
    # Re-initialize agent if possible (Async)
    # This might fail if other keys are missing, but that's expected
    try:
        # We don't want to block the request on re-init, 
        # but we can trigger it or just let the next request do it.
        # Since initialize_agent is now async, we'll let the next request handle it
        # or we could use loop.create_task if we wanted to be proactive.
        agent_manager._agent = None # Force re-init on next request
    except Exception as e:
        # Don't crash the request if agent re-init fails
        logging.error(f"Failed to reset agent after settings update: {e}")
    
    if data.key == "SUBAGENT_PLANNER_GRAPH":
        return {
            "status": "success",
            "message": "Updated SUBAGENT_PLANNER_GRAPH and auto-synced SUBAGENTS_CONFIG",
        }
    if data.key == "CONNECTIVITY_NGROK_ENABLED" and ngrok_toggle_message:
        return {
            "status": "success",
            "message": f"Updated {data.key}: {ngrok_toggle_message}",
        }
    return {"status": "success", "message": f"Updated {data.key}"}


@router.get("/settings/export-backup")
async def export_backup(
    settings: bool = Query(False),
    apis: bool = Query(False),
    tools: bool = Query(False),
    conversations: bool = Query(False),
    knowledge: bool = Query(False)
):
    """
    Export database configuration and history selectively
    """
    sections = []
    if settings:
        sections.append("settings")
    if apis:
        sections.append("apis")
    if tools:
        sections.append("tools")
    if conversations:
        sections.append("conversations")
    if knowledge:
        sections.append("knowledge")
        
    try:
        backup_data = await run_in_threadpool(export_backup_data, sections)
        return backup_data
    except Exception as e:
        logging.error(f"Failed to export backup data: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@router.post("/settings/import-backup")
async def import_backup(req: ImportBackupRequest):
    """
    Import database configuration and history selectively
    """
    try:
        result = await run_in_threadpool(import_backup_data, req.import_sections, req.data)
        if not result.get("success"):
            raise HTTPException(status_code=500, detail="\n".join(result.get("messages", [])))
        
        # Reload settings in memory
        settings.reload()
        
        # Re-initialize the agent since API keys or settings might have changed!
        try:
            agent_manager._agent = None # Force re-init on next request
        except Exception as agent_err:
            logging.error(f"Failed to reset agent after import: {agent_err}")
            
        return result
    except Exception as e:
        logging.error(f"Failed to import backup data: {e}")
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")


def _identity_payload() -> Dict[str, Any]:
    identity = get_or_create_device_identity()
    configured_name = settings.CONNECTIVITY_DEVICE_NAME
    if configured_name and configured_name != identity["name"]:
        identity = update_device_identity_name(configured_name)
    public_url = settings.CONNECTIVITY_PUBLIC_URL if settings.CONNECTIVITY_NGROK_ENABLED else None
    return {
        "device_id": identity["device_id"],
        "name": identity["name"],
        "public_key": identity["public_key"],
        "fingerprint": identity["fingerprint"],
        "public_url": public_url,
    }


def _normalize_public_url(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip()
    return normalized or None


def _peer_error_code(status_code: int) -> str:
    if status_code in (401, 403):
        return "auth_failed"
    if status_code == 404:
        return "endpoint_not_found"
    if status_code == 422:
        return "invalid_payload"
    if status_code >= 500:
        return "peer_server_error"
    return "peer_rejected"


def _extract_peer_http_error_detail(response: httpx.Response, max_len: int = 800) -> Optional[str]:
    """Best-effort parse of FastAPI / JSON error bodies from peer responses."""
    try:
        data = response.json()
    except Exception:
        body = response.text.strip()
        return body[:max_len] + ("..." if len(body) > max_len else "") if body else None
    detail = data.get("detail") if isinstance(data, dict) else None
    if isinstance(detail, str) and detail.strip():
        text = detail.strip()
    elif isinstance(detail, list) and detail:
        parts: list[str] = []
        for item in detail:
            if isinstance(item, dict):
                msg = item.get("msg") or item.get("message")
                if isinstance(msg, str) and msg.strip():
                    parts.append(msg.strip())
        text = "; ".join(parts[:5]) if parts else ""
    else:
        message = data.get("message") if isinstance(data, dict) else None
        text = message.strip() if isinstance(message, str) and message.strip() else ""

    if not text:
        return None
    return text[:max_len] + ("..." if len(text) > max_len else "")


def _peer_log_http_exception_detail(exc: HTTPException) -> str:
    d = exc.detail
    if isinstance(d, str):
        return d
    return str(d)


async def _friend_stream_register(stream_id: str, info: Dict[str, Any]) -> None:
    async with _friend_stream_lock:
        _friend_stream_registry[stream_id] = info


async def _friend_stream_unregister(stream_id: str) -> None:
    async with _friend_stream_lock:
        _friend_stream_registry.pop(stream_id, None)


async def _friend_stream_lookup(
    *,
    stream_id: Optional[str] = None,
    thread_id: Optional[str] = None,
    friend_id: Optional[str] = None,
) -> Optional[tuple[str, Dict[str, Any]]]:
    async with _friend_stream_lock:
        if stream_id:
            info = _friend_stream_registry.get(stream_id)
            if info:
                return stream_id, info
            return None
        for sid, info in _friend_stream_registry.items():
            if thread_id and info.get("thread_id") != thread_id:
                continue
            if friend_id and info.get("friend_id") != friend_id:
                continue
            return sid, info
    return None


def _peer_flatten_message_content(msg: Any) -> str:
    """Plain text from a LangChain message object or dict."""
    if isinstance(msg, dict):
        content: Any = msg.get("content", "")
    elif hasattr(msg, "content"):
        content = getattr(msg, "content")
    else:
        return ""

    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str) and part.strip():
                parts.append(part.strip())
            elif isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts)
    return ""


def _peer_message_is_assistant_reply(msg: Any) -> bool:
    """True for model/user-facing assistant output; false for tools, human, system."""
    if isinstance(msg, dict):
        mt = str(msg.get("type", "")).lower()
        role = str(msg.get("role", "")).lower()
        if mt == "tool" or role == "tool":
            return False
        if mt in {"ai", "assistant"} or role in {"assistant", "ai"}:
            return True
        return False
    cls = getattr(msg.__class__, "__name__", "")
    if "ToolMessage" in cls or "HumanMessage" in cls or "SystemMessage" in cls:
        return False
    if "AIMessage" in cls:
        return True
    if hasattr(msg, "type"):
        t = str(getattr(msg, "type", "")).lower()
        if t in {"tool", "human", "system"}:
            return False
        if t in {"ai", "assistant"}:
            return True
    return False


def _extract_peer_assistant_text(agent_result: Any) -> str:
    """
    Best-effort extraction of assistant text from agent invoke output.
    LangGraph returns LangChain message objects (not dicts); we must duck-type them.
    """
    if isinstance(agent_result, str):
        return agent_result.strip()
    if not isinstance(agent_result, dict):
        return ""

    messages = agent_result.get("messages")
    if not isinstance(messages, list):
        return ""

    for msg in reversed(messages):
        if not _peer_message_is_assistant_reply(msg):
            continue
        text = _peer_flatten_message_content(msg)
        if text:
            return text

    return ""


@router.get("/connectivity/identity", response_model=DeviceIdentity)
async def get_connectivity_identity():
    return DeviceIdentity(**_identity_payload())


@router.post("/connectivity/pair/init", response_model=PairingInitResponse)
async def connectivity_pair_init(data: PairingRequest):
    if data.name and data.name.strip():
        update_setting("CONNECTIVITY_DEVICE_NAME", data.name.strip())
        settings.reload()
    token = create_pairing_token()
    return PairingInitResponse(
        pairing_token=token,
        identity=DeviceIdentity(**_identity_payload()),
    )


@router.post("/connectivity/pair/confirm", response_model=PairingConfirmResponse)
async def connectivity_pair_confirm(data: PairingConfirmRequest):
    if not consume_pairing_token(data.pairing_token):
        raise HTTPException(status_code=400, detail="Invalid or expired pairing token")
    peer_public_url = _normalize_public_url(data.peer_public_url)
    friend = upsert_friend(
        name=data.peer_name.strip(),
        device_id=data.peer_device_id.strip(),
        fingerprint=data.peer_fingerprint.strip(),
        public_key=data.peer_public_key.strip(),
        public_url=peer_public_url,
    )
    local_identity = _identity_payload()
    finalize_payload = PairingFinalizeRequest(
        peer_name=local_identity["name"],
        peer_device_id=local_identity["device_id"],
        peer_fingerprint=local_identity["fingerprint"],
        peer_public_key=local_identity["public_key"],
        peer_public_url=local_identity.get("public_url"),
    )
    finalize_endpoint = f"{peer_public_url.rstrip('/')}/connectivity/pair/finalize" if peer_public_url else None

    reciprocal_synced = False
    reciprocal_status = "not_attempted"
    reciprocal_code: Optional[str] = None
    reciprocal_message: Optional[str] = None

    if not peer_public_url:
        reciprocal_status = "skipped"
        reciprocal_code = "missing_peer_public_url"
        reciprocal_message = "Peer public URL is missing; open Receiver and import finalize payload manually."
    else:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.post(
                    finalize_endpoint,
                    json=finalize_payload.model_dump(),
                )
            if response.status_code >= 400:
                reciprocal_status = "failed"
                reciprocal_code = _peer_error_code(response.status_code)
                reciprocal_message = f"Peer finalize failed ({response.status_code})"
            else:
                reciprocal_synced = True
                reciprocal_status = "synced"
                reciprocal_message = "Friend saved on both devices."
        except httpx.TimeoutException:
            reciprocal_status = "failed"
            reciprocal_code = "timeout"
            reciprocal_message = "Timed out reaching peer finalize endpoint."
        except httpx.ConnectError:
            reciprocal_status = "failed"
            reciprocal_code = "unreachable"
            reciprocal_message = "Could not connect to peer finalize endpoint."
        except Exception as exc:
            reciprocal_status = "failed"
            reciprocal_code = "network_error"
            reciprocal_message = f"Peer finalize failed: {exc}"

    return PairingConfirmResponse(
        friend=_friend_record_from_row(friend),
        reciprocal_synced=reciprocal_synced,
        reciprocal_status=reciprocal_status,
        reciprocal_code=reciprocal_code,
        reciprocal_message=reciprocal_message,
        finalize_endpoint=finalize_endpoint,
        finalize_payload=finalize_payload,
    )


@router.post("/connectivity/pair/finalize", response_model=FriendRecord)
async def connectivity_pair_finalize(data: PairingFinalizeRequest):
    friend = upsert_friend(
        name=data.peer_name.strip(),
        device_id=data.peer_device_id.strip(),
        fingerprint=data.peer_fingerprint.strip(),
        public_key=data.peer_public_key.strip(),
        public_url=(data.peer_public_url or "").strip() or None,
    )
    return _friend_record_from_row(friend)


@router.get("/connectivity/peer-access/catalog", response_model=PeerAccessCatalogResponse)
async def connectivity_peer_access_catalog():
    full = _get_runtime_tool_catalog_ids()
    chat_eligible, agent_eligible = split_catalog_for_profiles(full)
    return PeerAccessCatalogResponse(chat_eligible=chat_eligible, agent_eligible=agent_eligible)


@router.patch("/connectivity/friends/{friend_id}/access", response_model=FriendRecord)
async def connectivity_friend_access_patch(friend_id: str, data: FriendPeerAccessPatch):
    friend = get_friend_by_id(friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="Friend not found")
    full = _get_runtime_tool_catalog_ids()
    try:
        validate_patch_tool_ids(data, full)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    payload = patch_to_policy_dict(data)
    updated = update_friend_peer_access(friend_id, json.dumps(payload))
    if not updated:
        raise HTTPException(status_code=404, detail="Friend not found")
    return _friend_record_from_row(updated)


@router.get("/connectivity/friends", response_model=List[FriendRecord])
async def connectivity_friends():
    return [_friend_record_from_row(item) for item in list_friends()]


@router.delete("/connectivity/friends/{friend_id}")
async def connectivity_friend_delete(friend_id: str):
    friend = get_friend_by_id(friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="Friend not found")
    deleted = delete_friend(friend_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Friend not found")
    return {"status": "success", "friend_id": friend_id}


@router.post("/connectivity/friends/{friend_id}/ask", response_model=PeerAskResponse)
async def connectivity_ask_friend(friend_id: str, data: PeerAskRequest):
    if friend_id != data.friend_id:
        raise HTTPException(status_code=400, detail="Friend ID mismatch")
    friend = get_friend_by_id(friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="Friend not found")

    q_log = (data.query or "").strip()
    thread_id = (data.thread_id or "").strip() or str(uuid.uuid4())
    fid = friend["id"]
    fname = friend["name"]
    await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)
    await run_in_threadpool(save_message, thread_id, "user", q_log or "(empty)")

    try:
        target_url = connectivity_manager.resolve_peer(friend)
    except RuntimeError as exc:
        await run_in_threadpool(
            append_peer_query_event,
            "outbound",
            fid,
            fname,
            q_log or "(empty)",
            "error",
            None,
            str(exc),
        )
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    source_identity = _identity_payload()
    endpoint = f"{target_url.rstrip('/')}/connectivity/peer/receive"
    payload = {
        "from_device_id": source_identity["device_id"],
        "from_fingerprint": source_identity["fingerprint"],
        "query": data.query,
        "thread_id": thread_id,
    }

    try:
        async with httpx.AsyncClient(timeout=PEER_HTTP_ASK_TIMEOUT) as client:
            response = await client.post(endpoint, json=payload)
            if response.status_code >= 400:
                base = f"Peer ask failed ({response.status_code}) [{_peer_error_code(response.status_code)}]"
                peer_snippet = _extract_peer_http_error_detail(response)
                detail = f"{base}: {peer_snippet}" if peer_snippet else base
                await run_in_threadpool(
                    append_peer_query_event,
                    "outbound",
                    fid,
                    fname,
                    q_log or "(empty)",
                    "error",
                    None,
                    detail,
                )
                raise HTTPException(status_code=502, detail=detail)
            body = response.json()
    except HTTPException:
        raise
    except httpx.TimeoutException as exc:
        await run_in_threadpool(
            append_peer_query_event,
            "outbound",
            fid,
            fname,
            q_log or "(empty)",
            "error",
            None,
            "Peer ask timed out [timeout]",
        )
        raise HTTPException(status_code=502, detail="Peer ask timed out [timeout]") from exc
    except httpx.ConnectError as exc:
        await run_in_threadpool(
            append_peer_query_event,
            "outbound",
            fid,
            fname,
            q_log or "(empty)",
            "error",
            None,
            "Peer ask endpoint unreachable [unreachable]",
        )
        raise HTTPException(status_code=502, detail="Peer ask endpoint unreachable [unreachable]") from exc
    except Exception as exc:
        await run_in_threadpool(
            append_peer_query_event,
            "outbound",
            fid,
            fname,
            q_log or "(empty)",
            "error",
            None,
            f"Failed to reach peer [network_error]: {exc}",
        )
        raise HTTPException(status_code=502, detail=f"Failed to reach peer [network_error]: {exc}") from exc

    responder_url = _normalize_public_url(str(body.get("responder_public_url") or ""))
    if responder_url and responder_url != friend.get("public_url"):
        update_friend_public_url(friend_id, responder_url)

    msg_preview = str(body.get("message", ""))
    responder_thread_id = str(body.get("thread_id") or thread_id)
    await run_in_threadpool(upsert_friend_thread, responder_thread_id, fid, fname)
    await run_in_threadpool(save_message, responder_thread_id, "assistant", msg_preview)
    await run_in_threadpool(
        append_peer_query_event,
        "outbound",
        fid,
        fname,
        q_log or "(empty)",
        "ok",
        msg_preview,
        None,
    )

    return PeerAskResponse(
        status=str(body.get("status", "online")),
        message=msg_preview,
        thread_id=responder_thread_id,
        responder_device_id=str(body.get("responder_device_id", friend["device_id"])),
    )


@router.post("/connectivity/friends/{friend_id}/ask/stream")
async def connectivity_ask_friend_stream(friend_id: str, data: PeerAskRequest):
    if friend_id != data.friend_id:
        raise HTTPException(status_code=400, detail="Friend ID mismatch")

    q_log = (data.query or "").strip()
    thread_id = (data.thread_id or "").strip() or str(uuid.uuid4())
    stream_id = str(uuid.uuid4())

    async def event_generator():
        full_response: List[str] = []
        stream_error: Optional[str] = None
        forwarded_events = 0
        payload: Dict[str, Any] = {}
        peer_stream_endpoint = ""
        peer_legacy_endpoint = ""
        peer_cancel_endpoint = ""
        fid = friend_id
        fname = "Friend"

        async def _fallback_legacy_once(client: httpx.AsyncClient) -> None:
            nonlocal stream_error
            nonlocal forwarded_events
            yield f"data: {json.dumps({'step': 'meta', 'peer_mode': 'fallback'})}\n\n"
            forwarded_events += 1
            response = await client.post(peer_legacy_endpoint, json=payload)
            if response.status_code >= 400:
                base = f"Peer ask fallback failed ({response.status_code}) [{_peer_error_code(response.status_code)}]"
                peer_snippet = _extract_peer_http_error_detail(response)
                detail = f"{base}: {peer_snippet}" if peer_snippet else base
                stream_error = detail
                yield_payload = {"error": "peer_stream_failed", "details": detail}
                yield f"data: {json.dumps(yield_payload)}\n\n"
                return
            body = response.json()
            text = str(body.get("message", "")).strip()
            if text:
                full_response.append(text)
                forwarded_events += 1
                yield f"data: {json.dumps({'step': 'model', 'message': {'type': 'assistant', 'content': text}}, default=str)}\n\n"
            yield f"data: {json.dumps({'step': 'end', 'done': True}, default=str)}\n\n"

        try:
            start_payload = {
                "step": "start",
                "stream_id": stream_id,
                "thread_id": thread_id,
                "friend_id": fid,
                "friend_name": fname,
            }
            yield f"data: {json.dumps(start_payload)}\n\n"
            forwarded_events += 1

            friend = await run_in_threadpool(get_friend_by_id, friend_id)
            if not friend:
                stream_error = "Friend not found"
                yield f"data: {json.dumps({'error': 'friend_not_found', 'details': stream_error})}\n\n"
                return

            fid = friend["id"]
            fname = friend["name"]
            await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)
            await run_in_threadpool(save_message, thread_id, "user", q_log or "(empty)")
            try:
                target_url = connectivity_manager.resolve_peer(friend)
            except RuntimeError as exc:
                stream_error = str(exc)
                await run_in_threadpool(
                    append_peer_query_event,
                    "outbound",
                    fid,
                    fname,
                    q_log or "(empty)",
                    "error",
                    None,
                    stream_error,
                )
                yield f"data: {json.dumps({'error': 'resolve_peer_failed', 'details': stream_error})}\n\n"
                return

            source_identity = _identity_payload()
            peer_stream_endpoint = f"{target_url.rstrip('/')}/connectivity/peer/receive/stream"
            peer_legacy_endpoint = f"{target_url.rstrip('/')}/connectivity/peer/receive"
            peer_cancel_endpoint = f"{target_url.rstrip('/')}/connectivity/peer/receive/stream/cancel"
            payload = {
                "from_device_id": source_identity["device_id"],
                "from_fingerprint": source_identity["fingerprint"],
                "query": data.query,
                "thread_id": thread_id,
            }
            await _friend_stream_register(
                stream_id,
                {
                    "stream_id": stream_id,
                    "thread_id": thread_id,
                    "friend_id": fid,
                    "friend_name": fname,
                    "peer_cancel_endpoint": peer_cancel_endpoint,
                    "peer_cancel_payload": {"thread_id": thread_id, "stream_id": stream_id},
                    "task": asyncio.current_task(),
                },
            )

            async with httpx.AsyncClient(timeout=PEER_HTTP_ASK_TIMEOUT) as client:
                async with client.stream("POST", peer_stream_endpoint, json=payload) as response:
                    if response.status_code < 400:
                        yield f"data: {json.dumps({'step': 'meta', 'peer_mode': 'stream'})}\n\n"
                        forwarded_events += 1
                    if response.status_code >= 400:
                        # Backward compatibility: remote peer may not have stream endpoint yet.
                        if response.status_code in (404, 405):
                            async for item in _fallback_legacy_once(client):
                                yield item
                            return
                        base = f"Peer ask stream failed ({response.status_code}) [{_peer_error_code(response.status_code)}]"
                        peer_snippet = _extract_peer_http_error_detail(response)
                        detail = f"{base}: {peer_snippet}" if peer_snippet else base
                        stream_error = detail
                        yield f"data: {json.dumps({'error': 'peer_stream_failed', 'details': detail})}\n\n"
                        return
                    async for line in response.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data_str = line[6:].strip()
                        if not data_str:
                            continue
                        try:
                            evt = json.loads(data_str)
                        except Exception:
                            continue
                        msg = evt.get("message", {}) if isinstance(evt, dict) else {}
                        if evt.get("step") == "model" and isinstance(msg, dict):
                            content = msg.get("content")
                            if isinstance(content, str) and content:
                                full_response.append(content)
                        if evt.get("error"):
                            details = str(evt.get("details") or evt.get("error"))
                            stream_error = details
                        forwarded_events += 1
                        yield f"data: {json.dumps(evt, default=str)}\n\n"
                    # If the peer returned 200 but emitted nothing parseable as SSE, fallback once.
                    if forwarded_events <= 2:
                        async for item in _fallback_legacy_once(client):
                            yield item
                        return
        except asyncio.CancelledError:
            stream_error = "Friend stream cancelled"
            raise
        except httpx.TimeoutException:
            try:
                async with httpx.AsyncClient(timeout=PEER_HTTP_ASK_TIMEOUT) as fallback_client:
                    async for item in _fallback_legacy_once(fallback_client):
                        yield item
                return
            except Exception:
                stream_error = "Peer ask stream timed out [timeout]"
                yield f"data: {json.dumps({'error': 'timeout', 'details': stream_error})}\n\n"
        except httpx.ConnectError:
            try:
                async with httpx.AsyncClient(timeout=PEER_HTTP_ASK_TIMEOUT) as fallback_client:
                    async for item in _fallback_legacy_once(fallback_client):
                        yield item
                return
            except Exception:
                stream_error = "Peer ask stream endpoint unreachable [unreachable]"
                yield f"data: {json.dumps({'error': 'unreachable', 'details': stream_error})}\n\n"
        except Exception as exc:
            try:
                async with httpx.AsyncClient(timeout=PEER_HTTP_ASK_TIMEOUT) as fallback_client:
                    async for item in _fallback_legacy_once(fallback_client):
                        yield item
                return
            except Exception:
                detail = str(exc).strip() or exc.__class__.__name__
                stream_error = f"Failed to reach peer stream [network_error]: {detail}"
                yield f"data: {json.dumps({'error': 'network_error', 'details': stream_error})}\n\n"
        finally:
            final_text = "".join(full_response).strip()
            if final_text:
                await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)
                await run_in_threadpool(save_message, thread_id, "assistant", final_text)
                await run_in_threadpool(
                    append_peer_query_event,
                    "outbound",
                    fid,
                    fname,
                    q_log or "(empty)",
                    "ok",
                    final_text,
                    None,
                )
            elif stream_error:
                await run_in_threadpool(
                    append_peer_query_event,
                    "outbound",
                    fid,
                    fname,
                    q_log or "(empty)",
                    "error",
                    None,
                    stream_error,
                )
            await _friend_stream_unregister(stream_id)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers=_SSE_CHAT_HEADERS,
    )


@router.get("/connectivity/friends/{friend_id}/status", response_model=FriendStatusResponse)
async def connectivity_friend_status(friend_id: str):
    friend = get_friend_by_id(friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="Friend not found")
    checked_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        target_url = connectivity_manager.resolve_peer(friend)
    except RuntimeError as exc:
        return FriendStatusResponse(
            friend_id=friend_id,
            reachable=False,
            status="offline",
            latency_ms=None,
            message=str(exc),
            checked_at=checked_at,
            failure_code="resolve_failed",
            failure_stage="resolve_peer",
        )

    source_identity = _identity_payload()
    endpoint = f"{target_url.rstrip('/')}/connectivity/peer/receive"
    payload = {
        "from_device_id": source_identity["device_id"],
        "from_fingerprint": source_identity["fingerprint"],
        "query": "status_ping",
    }
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(endpoint, json=payload)
            if response.status_code >= 400:
                code = _peer_error_code(response.status_code)
                return FriendStatusResponse(
                    friend_id=friend_id,
                    reachable=False,
                    status="offline",
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    message=f"Peer call failed ({response.status_code}) [{code}]",
                    checked_at=checked_at,
                    failure_code=code,
                    failure_stage="peer_receive",
                )
            body = response.json()
        peer_status = str(body.get("status", "online")).strip().lower()
        responder_url = _normalize_public_url(str(body.get("responder_public_url") or ""))
        failure_code = str(body.get("failure_code") or "").strip().lower() or None
        if responder_url and responder_url != friend.get("public_url"):
            update_friend_public_url(friend_id, responder_url)
        elif failure_code == "connectivity_disabled":
            update_friend_public_url(friend_id, None)
        reachable = peer_status == "online"
        return FriendStatusResponse(
            friend_id=friend_id,
            reachable=reachable,
            status=peer_status if peer_status else "offline",
            latency_ms=int((time.perf_counter() - started) * 1000),
            message=str(body.get("message", "reachable")),
            checked_at=checked_at,
            failure_code=failure_code,
            failure_stage=None,
        )
    except httpx.TimeoutException:
        return FriendStatusResponse(
            friend_id=friend_id,
            reachable=False,
            status="offline",
            latency_ms=int((time.perf_counter() - started) * 1000),
            message="Peer call timed out",
            checked_at=checked_at,
            failure_code="timeout",
            failure_stage="network",
        )
    except httpx.ConnectError:
        return FriendStatusResponse(
            friend_id=friend_id,
            reachable=False,
            status="offline",
            latency_ms=int((time.perf_counter() - started) * 1000),
            message="Peer endpoint unreachable",
            checked_at=checked_at,
            failure_code="unreachable",
            failure_stage="network",
        )
    except Exception as exc:
        return FriendStatusResponse(
            friend_id=friend_id,
            reachable=False,
            status="offline",
            latency_ms=int((time.perf_counter() - started) * 1000),
            message=f"Failed to reach peer: {exc}",
            checked_at=checked_at,
            failure_code="network_error",
            failure_stage="network",
        )


@router.post("/connectivity/peer/receive", response_model=PeerAskResponse)
async def connectivity_peer_receive(data: PeerReceiveRequest):
    friend = get_friend_by_device_id(data.from_device_id)
    identity = _identity_payload()
    query = (data.query or "").strip()
    peer_query = query if query else "Hello"
    thread_id = (data.thread_id or "").strip() or f"peer:{data.from_device_id}"
    fid: Optional[str] = friend["id"] if friend else None
    fname: Optional[str] = friend["name"] if friend else None
    if fid and fname:
        await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)

    if not friend:
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            None,
            None,
            peer_query,
            "error",
            None,
            "Unknown peer",
        )
        raise HTTPException(status_code=403, detail="Unknown peer")
    if friend["fingerprint"] != data.from_fingerprint:
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            fid,
            fname,
            peer_query,
            "error",
            None,
            "Fingerprint mismatch",
        )
        raise HTTPException(status_code=403, detail="Fingerprint mismatch")

    if not settings.CONNECTIVITY_NGROK_ENABLED:
        return PeerAskResponse(
            status="offline",
            message="Connectivity is disabled on this device",
            thread_id=thread_id,
            responder_device_id=identity["device_id"],
            responder_public_url=None,
            failure_code="connectivity_disabled",
        )

    # Keep status checks lightweight: do not route health probes through model inference.
    if query == "status_ping":
        return PeerAskResponse(
            status="online",
            message="reachable",
            thread_id=thread_id,
            responder_device_id=identity["device_id"],
            responder_public_url=identity.get("public_url"),
        )

    # Run a local generation respecting per-friend inbound access policy.
    await run_in_threadpool(save_message, thread_id, "user", peer_query)

    policy = friend_row_peer_policy(friend)
    full_catalog = _get_runtime_tool_catalog_ids()
    effective_ids = compute_effective_tool_ids(policy, full_catalog)
    memory_user_id = (
        f"peer:{data.from_device_id}" if policy.memory_enabled else "default_user"
    )

    try:
        if not agent_manager.is_configured:
            raise HTTPException(status_code=503, detail="Receiver agent is not configured")

        agent_result = await agent_manager.invoke_peer_inbound(
            messages=[{"role": "user", "content": peer_query}],
            thread_id=thread_id,
            receive_profile=policy.receive_profile,
            effective_tool_ids=effective_ids,
            memory_user_id=memory_user_id,
        )
        reply_text = _extract_peer_assistant_text(agent_result) or "I received your message but could not generate a reply."
        if fid and fname:
            await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)
        await run_in_threadpool(save_message, thread_id, "assistant", reply_text)
    except HTTPException as exc:
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            fid,
            fname,
            peer_query,
            "error",
            None,
            _peer_log_http_exception_detail(exc),
        )
        raise
    except httpx.ConnectError as exc:
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            fid,
            fname,
            peer_query,
            "error",
            None,
            f"Receiver model provider is unreachable [unreachable]: {exc}",
        )
        raise HTTPException(status_code=503, detail=f"Receiver model provider is unreachable [unreachable]: {exc}") from exc
    except RuntimeError as exc:
        msg = str(exc).lower()
        if "peer policy" in msg or "no usable tools" in msg:
            detail = "Peer access policy blocks all tools for this friend. Update Connectivity settings."
            await run_in_threadpool(
                append_peer_query_event,
                "inbound",
                fid,
                fname,
                peer_query,
                "error",
                None,
                detail,
            )
            raise HTTPException(status_code=403, detail=detail) from exc
        if "not configured" in msg:
            detail = "Receiver agent is not configured"
            await run_in_threadpool(
                append_peer_query_event,
                "inbound",
                fid,
                fname,
                peer_query,
                "error",
                None,
                detail,
            )
            raise HTTPException(status_code=503, detail=detail) from exc
        raise
    except Exception as exc:
        detail_low = str(exc).lower()
        if "upstream_connection_error" in detail_low or "connection error" in detail_low:
            d = "Receiver model provider is unreachable [unreachable]"
            await run_in_threadpool(
                append_peer_query_event,
                "inbound",
                fid,
                fname,
                peer_query,
                "error",
                None,
                d,
            )
            raise HTTPException(status_code=503, detail=d) from exc
        if "agent not configured" in detail_low:
            d = "Receiver agent is not configured"
            await run_in_threadpool(
                append_peer_query_event,
                "inbound",
                fid,
                fname,
                peer_query,
                "error",
                None,
                d,
            )
            raise HTTPException(status_code=503, detail=d) from exc
        logging.error(f"Peer receive generation failed: {exc}", exc_info=True)
        d = f"Receiver failed to generate response [peer_server_error]: {exc}"
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            fid,
            fname,
            peer_query,
            "error",
            None,
            d,
        )
        raise HTTPException(status_code=502, detail=d) from exc

    await run_in_threadpool(
        append_peer_query_event,
        "inbound",
        fid,
        fname,
        peer_query,
        "ok",
        reply_text,
        None,
    )

    return PeerAskResponse(
        status="online",
        message=reply_text,
        thread_id=thread_id,
        responder_device_id=identity["device_id"],
        responder_public_url=identity.get("public_url"),
    )


@router.post("/connectivity/peer/receive/stream")
async def connectivity_peer_receive_stream(data: PeerReceiveRequest):
    friend = get_friend_by_device_id(data.from_device_id)
    identity = _identity_payload()
    query = (data.query or "").strip()
    peer_query = query if query else "Hello"
    thread_id = (data.thread_id or "").strip() or f"peer:{data.from_device_id}"
    stream_id = str(uuid.uuid4())
    fid: Optional[str] = friend["id"] if friend else None
    fname: Optional[str] = friend["name"] if friend else None
    if fid and fname:
        await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)

    if not friend:
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            None,
            None,
            peer_query,
            "error",
            None,
            "Unknown peer",
        )
        raise HTTPException(status_code=403, detail="Unknown peer")
    if friend["fingerprint"] != data.from_fingerprint:
        await run_in_threadpool(
            append_peer_query_event,
            "inbound",
            fid,
            fname,
            peer_query,
            "error",
            None,
            "Fingerprint mismatch",
        )
        raise HTTPException(status_code=403, detail="Fingerprint mismatch")
    if not settings.CONNECTIVITY_NGROK_ENABLED:
        payload = {
            "step": "end",
            "done": True,
            "status": "offline",
            "message": "Connectivity is disabled on this device",
            "thread_id": thread_id,
            "responder_device_id": identity["device_id"],
            "responder_public_url": None,
            "failure_code": "connectivity_disabled",
        }
        return StreamingResponse(
            iter([f"data: {json.dumps(payload)}\n\n"]),
            media_type="text/event-stream",
            headers=_SSE_CHAT_HEADERS,
        )
    if query == "status_ping":
        payload = {
            "step": "end",
            "done": True,
            "status": "online",
            "message": "reachable",
            "thread_id": thread_id,
            "responder_device_id": identity["device_id"],
            "responder_public_url": identity.get("public_url"),
        }
        return StreamingResponse(
            iter([f"data: {json.dumps(payload)}\n\n"]),
            media_type="text/event-stream",
            headers=_SSE_CHAT_HEADERS,
        )

    await run_in_threadpool(save_message, thread_id, "user", peer_query)
    policy = friend_row_peer_policy(friend)
    full_catalog = _get_runtime_tool_catalog_ids()
    effective_ids = compute_effective_tool_ids(policy, full_catalog)
    memory_user_id = f"peer:{data.from_device_id}" if policy.memory_enabled else "default_user"

    async def peer_event_generator():
        full_response: List[str] = []
        stream_error: Optional[str] = None
        try:
            start_payload = {
                "step": "start",
                "stream_id": stream_id,
                "thread_id": thread_id,
                "friend_id": fid,
                "friend_name": fname,
            }
            yield f"data: {json.dumps(start_payload)}\n\n"
            async for chunk in agent_manager.stream_peer_inbound(
                messages=[{"role": "user", "content": peer_query}],
                thread_id=thread_id,
                receive_profile=policy.receive_profile,
                effective_tool_ids=effective_ids,
                memory_user_id=memory_user_id,
            ):
                if "__lg_messages__" in chunk:
                    pair = chunk["__lg_messages__"]
                    llm_chunk = pair[0] if isinstance(pair, tuple) and len(pair) >= 1 else pair
                    serialized = _serialize_message(llm_chunk)
                    if not serialized:
                        continue
                    if serialized.get("type") not in ("ai", "assistant"):
                        continue
                    content = serialized.get("content")
                    if isinstance(content, str) and content:
                        full_response.append(content)
                    yield f"data: {json.dumps({'step': 'model', 'message': serialized}, default=str)}\n\n"
                    continue

                if "__interrupt__" in chunk:
                    continue
            yield f"data: {json.dumps({'step': 'end', 'done': True})}\n\n"
        except asyncio.CancelledError:
            stream_error = "Peer stream cancelled"
            raise
        except RuntimeError as exc:
            msg = str(exc).lower()
            if "peer policy" in msg or "no usable tools" in msg:
                stream_error = "Peer access policy blocks all tools for this friend. Update Connectivity settings."
                yield f"data: {json.dumps({'error': 'peer_policy_blocked', 'details': stream_error})}\n\n"
            elif "not configured" in msg:
                stream_error = "Receiver agent is not configured"
                yield f"data: {json.dumps({'error': 'agent_not_configured', 'details': stream_error})}\n\n"
            elif "upstream_connection_error" in msg:
                stream_error = "Receiver model provider is unreachable [unreachable]"
                yield f"data: {json.dumps({'error': 'upstream_connection_error', 'details': stream_error})}\n\n"
            else:
                stream_error = str(exc)
                yield f"data: {json.dumps({'error': 'peer_stream_error', 'details': stream_error})}\n\n"
        except Exception as exc:
            stream_error = f"Receiver failed to generate response [peer_server_error]: {exc}"
            yield f"data: {json.dumps({'error': 'peer_server_error', 'details': stream_error})}\n\n"
        finally:
            reply_text = "".join(full_response).strip()
            if reply_text:
                if fid and fname:
                    await run_in_threadpool(upsert_friend_thread, thread_id, fid, fname)
                await run_in_threadpool(save_message, thread_id, "assistant", reply_text)
                await run_in_threadpool(
                    append_peer_query_event,
                    "inbound",
                    fid,
                    fname,
                    peer_query,
                    "ok",
                    reply_text,
                    None,
                )
            elif stream_error:
                await run_in_threadpool(
                    append_peer_query_event,
                    "inbound",
                    fid,
                    fname,
                    peer_query,
                    "error",
                    None,
                    stream_error,
                )

    return StreamingResponse(
        peer_event_generator(),
        media_type="text/event-stream",
        headers=_SSE_CHAT_HEADERS,
    )


@router.post("/connectivity/peer/receive/stream/cancel")
async def connectivity_peer_receive_stream_cancel(data: PeerStreamCancelRequest):
    cancelled = await agent_manager.cancel_run(data.thread_id)
    return {"status": "success" if cancelled else "ignored", "cancelled": cancelled}


@router.post("/connectivity/friends/{friend_id}/ask/stream/cancel")
async def connectivity_friend_ask_stream_cancel(friend_id: str, data: PeerStreamCancelRequest):
    matched = await _friend_stream_lookup(
        stream_id=data.stream_id,
        thread_id=data.thread_id,
        friend_id=friend_id,
    )
    if not matched:
        return {"status": "ignored", "cancelled": False}

    stream_id, info = matched
    task = info.get("task")
    if task and not task.done():
        task.cancel()

    peer_cancel_endpoint = info.get("peer_cancel_endpoint")
    peer_cancel_payload = info.get("peer_cancel_payload") or {"thread_id": data.thread_id, "stream_id": stream_id}
    peer_cancelled = False
    if isinstance(peer_cancel_endpoint, str) and peer_cancel_endpoint.strip():
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(peer_cancel_endpoint, json=peer_cancel_payload)
                peer_cancelled = resp.status_code < 400
        except Exception:
            peer_cancelled = False

    await _friend_stream_unregister(stream_id)
    return {"status": "success", "cancelled": True, "peer_cancelled": peer_cancelled}


@router.get("/connectivity/peer-query-history", response_model=List[PeerQueryEventItem])
async def connectivity_peer_query_history(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    rows = await run_in_threadpool(list_peer_query_events, limit, offset)
    return [PeerQueryEventItem(**r) for r in rows]


@router.delete("/connectivity/peer-query-history")
async def connectivity_peer_query_history_clear():
    deleted = await run_in_threadpool(clear_peer_query_events)
    return {"status": "success", "deleted": deleted}


@router.post("/connectivity/friends/{friend_id}/endpoint", response_model=FriendRecord)
async def connectivity_friend_endpoint_update(friend_id: str, data: FriendEndpointUpdateRequest):
    friend = get_friend_by_id(friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="Friend not found")
    updated = update_friend_public_url(friend_id, data.public_url)
    if not updated:
        raise HTTPException(status_code=404, detail="Friend not found")
    return _friend_record_from_row(updated)


@router.get("/connectivity/friends/{friend_id}/approval")
async def connectivity_friend_approval(friend_id: str, thread_id: str):
    return {"approved": has_friend_thread_approval(thread_id, friend_id)}


@router.post("/connectivity/friends/{friend_id}/approval")
async def connectivity_friend_approval_set(friend_id: str, data: FriendApprovalRequest):
    approve_friend_for_thread(data.thread_id, friend_id)
    return {"status": "success", "approved": True}


@router.get("/connectivity/ngrok/status", response_model=NgrokStatusResponse)
async def connectivity_ngrok_status():
    detected = detect_existing_ngrok()
    runtime = get_tunnel_runtime_status()
    is_enabled = settings.CONNECTIVITY_NGROK_ENABLED
    runtime_running = bool(runtime.get("running"))
    runtime_url = runtime.get("public_url")
    public_url = runtime_url if (is_enabled and runtime_running) else None
    ready_state = "ready" if (detected.get("installed") and is_enabled and runtime_running and public_url) else "not_ready"
    return NgrokStatusResponse(
        installed=bool(detected.get("installed")),
        path=detected.get("path") or settings.CONNECTIVITY_NGROK_INSTALL_PATH,
        version=detected.get("version"),
        enabled=is_enabled,
        public_url=public_url,
        tunnel_running=runtime_running,
        tunnel_pid=runtime.get("pid"),
        domain=settings.CONNECTIVITY_NGROK_DOMAIN,
        ready_state=ready_state,
    )


@router.post("/connectivity/ngrok/install", response_model=NgrokInstallResponse)
async def connectivity_ngrok_install(data: NgrokInstallRequest):
    if not data.confirmed:
        raise HTTPException(status_code=400, detail="Installation confirmation required")
    token_value = (data.auth_token or settings.CONNECTIVITY_NGROK_AUTH_TOKEN or "").strip()
    if not token_value:
        raise HTTPException(status_code=400, detail="ngrok auth token is required")
    domain_value = (data.domain or settings.CONNECTIVITY_NGROK_DOMAIN or "").strip() or None
    update_setting("CONNECTIVITY_NGROK_AUTH_TOKEN", token_value)
    update_setting("CONNECTIVITY_NGROK_DOMAIN", domain_value or "")
    settings.reload()
    result = await run_in_threadpool(install_ngrok_windows)
    if not result.get("ok"):
        return NgrokInstallResponse(
            ok=False,
            installed=False,
            path=result.get("path"),
            version=result.get("version"),
            enabled=settings.CONNECTIVITY_NGROK_ENABLED,
            public_url=settings.CONNECTIVITY_PUBLIC_URL,
            tunnel_running=False,
            tunnel_pid=None,
            domain=settings.CONNECTIVITY_NGROK_DOMAIN,
            ready_state="failed",
            steps=result.get("steps") or [],
        )

    tunnel = await run_in_threadpool(start_tunnel, result.get("path") or "", token_value, domain_value)
    all_steps = list(result.get("steps") or [])
    all_steps.append(
        {
            "step": "launch_tunnel",
            "ok": bool(tunnel.get("ok")),
            "message": tunnel.get("public_url") or tunnel.get("message") or "ngrok tunnel launched",
        }
    )
    if not tunnel.get("ok"):
        return NgrokInstallResponse(
            ok=False,
            installed=True,
            path=result.get("path"),
            version=result.get("version"),
            enabled=settings.CONNECTIVITY_NGROK_ENABLED,
            public_url=settings.CONNECTIVITY_PUBLIC_URL,
            tunnel_running=bool(tunnel.get("running")),
            tunnel_pid=tunnel.get("pid"),
            domain=settings.CONNECTIVITY_NGROK_DOMAIN,
            ready_state="failed",
            steps=all_steps,
        )

    persisted = await run_in_threadpool(
        persist_ngrok_setup,
        result.get("path") or "",
        tunnel.get("public_url"),
        tunnel.get("pid"),
        domain_value,
    )
    return NgrokInstallResponse(
        ok=True,
        installed=True,
        path=result.get("path"),
        version=result.get("version"),
        enabled=bool(persisted.get("enabled")),
        public_url=persisted.get("public_url"),
        tunnel_running=bool(tunnel.get("running")),
        tunnel_pid=tunnel.get("pid"),
        domain=persisted.get("domain"),
        ready_state="ready" if persisted.get("public_url") else "failed",
        steps=all_steps,
    )


@router.post("/embedding/download")
async def download_embedding_model():
    """
    Download Chroma's ONNX all-MiniLM-L6-v2 bundle with progress.
    Streams SSE events: {"progress": 0-100, "message": str, "done": bool, "error": str?}
    """
    from app.embedding_download import _download_with_progress

    progress_queue: queue.Queue = queue.Queue()

    def run_download():
        _download_with_progress(progress_queue)
        progress_queue.put(None)  # Sentinel

    thread = threading.Thread(target=run_download, daemon=True)
    thread.start()

    async def event_generator():
        loop = asyncio.get_event_loop()
        while True:
            try:
                msg = await loop.run_in_executor(None, lambda: progress_queue.get(timeout=30))
            except queue.Empty:
                yield f"data: {json.dumps({'progress': -1, 'message': 'waiting...', 'done': False})}\n\n"
                continue
            if msg is None:
                break
            # Persist model path when download completes successfully
            if msg.get("done") and not msg.get("error") and msg.get("path"):
                try:
                    await run_in_threadpool(update_setting, "EMBEDDING_MODEL_PATH", msg["path"])
                    settings.reload()
                except Exception as e:
                    logging.error(f"Failed to persist embedding model path: {e}")

            yield f"data: {json.dumps(msg)}\n\n"
            if msg.get("done"):
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/", response_model=HealthResponse)
async def root():
    """
    Root endpoint - health check and configuration status
    """
    agent_ready = agent_manager.agent is not None
    agent_configured = agent_manager.is_configured

    # Keep health checks fast/non-blocking so uvicorn reload is never held up
    # by expensive agent initialization under heavy frontend polling.
    if agent_configured and not agent_ready:
        asyncio.create_task(agent_manager.ensure_initialized())

    return HealthResponse(
        message="Welcome to Rie BE Chat API",
        agent_configured=agent_configured,
        tavily_configured=settings.has_tavily_key,
        web_search_configured=settings.has_web_search_configured,
        web_search_provider=settings.WEB_SEARCH_PROVIDER,
    )





@router.get("/debug")
async def debug():
    """
    Debug endpoint to check configuration status
    """
    return {
        "groq_api_key_present": bool(settings.GROQ_API_KEY),
        "groq_api_key_length": len(settings.GROQ_API_KEY) if settings.GROQ_API_KEY else 0,
        "google_api_key_present": bool(settings.GOOGLE_API_KEY and settings.GOOGLE_API_KEY != "your_gemini_api_key_here"),
        "gemini_model": settings.GEMINI_MODEL,
        "anthropic_api_key_present": bool(settings.ANTHROPIC_API_KEY),
        "openai_api_key_present": bool(settings.OPENAI_API_KEY),
        "tavily_api_key_present": bool(settings.TAVILY_API_KEY),
        "brave_search_api_key_present": bool(settings.BRAVE_SEARCH_API_KEY),
        "web_search_provider": settings.WEB_SEARCH_PROVIDER,
        "web_search_configured": settings.has_web_search_configured,
        "has_llm_api_key": settings.has_llm_api_key,
        "agent_configured": agent_manager.is_configured,
        "groq_model": settings.GROQ_MODEL,
    }


@router.get("/mcp/status")
async def mcp_status():
    """
    MCP diagnostic endpoint to show connection status and available tools
    """
    from app.mcp_client import mcp_manager
    
    # Get configured servers
    mcp_servers = settings.MCP_SERVERS
    
    # Get currently loaded tools (don't refresh - that would break active sessions)
    current_tools = mcp_manager.tools
    
    # Extract tool info from currently loaded tools
    try:
        tool_info = [
            {
                "name": tool.name if hasattr(tool, 'name') else str(tool),
                "description": tool.description if hasattr(tool, 'description') else "No description available",
            }
            for tool in current_tools
        ]
        status_error = None
    except Exception as e:
        tool_info = []
        status_error = str(e)
    
    return {
        "configured_servers": mcp_servers,
        "server_count": len(mcp_servers),
        "loaded_tools_count": len(current_tools),
        "available_tools": tool_info,
        "refresh_error": status_error,
        "status": "connected" if len(tool_info) > 0 else "error" if status_error else "no_servers"
    }


@router.get("/logs")
async def get_logs():
    """
    Get the last 1000 lines of the backend log file.
    """
    log_file = settings.LOG_FILE
    if not log_file.exists():
        return {"logs": "Log file not found."}
    
    try:
        with open(log_file, "r", encoding="utf-8", errors="replace") as f:
            # Read all lines and take last 1000
            lines = f.readlines()
            last_lines = lines[-1000:] if len(lines) > 1000 else lines
            return {"logs": "".join(last_lines)}
    except Exception as e:
        return {"logs": f"Error reading log file: {str(e)}"}


@router.get("/screenshot")
async def get_screenshot():
    """
    Capture a screenshot of the current screen.
    """
    from app.windows_tools import desktop
    try:
        # Use run_in_threadpool because pg.screenshot is blocking
        screenshot = await run_in_threadpool(desktop.get_screenshot)
        
        # Convert to base64
        buffered = io.BytesIO()
        screenshot.save(buffered, format="JPEG", quality=80)
        img_str = base64.b64encode(buffered.getvalue()).decode()
        
        return {"image": f"data:image/jpeg;base64,{img_str}"}
    except Exception as e:
        logging.error(f"Screenshot failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/desktop-text")
async def get_desktop_text():
    """
    Get the text/UIA representation of the current screen/desktop
    """
    from app.windows_tools import state_tool
    try:
        text = await run_in_threadpool(state_tool, use_vision=False, use_dom=False)
        return {"text": text}
    except Exception as e:
        logging.error(f"Desktop text capture failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/history")
async def get_history_threads(
    limit: Optional[int] = Query(None, ge=1),
    offset: int = Query(0, ge=0),
    search: Optional[str] = Query(None),
):
    """Get list of chat history threads with pagination and search support"""
    threads = await run_in_threadpool(get_threads, limit, offset, search)
    return threads

@router.get("/history/{thread_id}")
async def get_history_messages(thread_id: str):
    """Get messages for a specific thread"""
    messages = await run_in_threadpool(get_thread_messages, thread_id)
    return messages


@router.post("/history/fork")
async def fork_history_thread(data: ForkThreadRequest):
    """Fork a thread with conversation history through a user message."""
    forked = await run_in_threadpool(
        fork_thread_messages,
        data.new_thread_id,
        data.source_thread_id,
        data.until_message_id,
        data.messages,
    )
    if agent_manager.is_configured and forked:
        await agent_manager.seed_thread_history(data.new_thread_id, forked)
    return {
        "status": "success",
        "thread_id": data.new_thread_id,
        "message_count": len(forked),
    }


@router.delete("/history")
async def delete_all_history():
    """Delete all chat threads, messages, and cancel all active runs/tasks"""
    await agent_manager.cancel_all_runs()
    try:
        scheduler_manager.cancel_all_tasks()
    except Exception as e:
        logging.error(f"Failed to cancel scheduler tasks: {e}")
    await run_in_threadpool(clear_all_history)
    return {"status": "success"}


@router.delete("/history/{thread_id}")
async def delete_history_thread(thread_id: str):
    """Delete a thread"""
    await run_in_threadpool(delete_thread, thread_id)
    return {"status": "success"}


# --- Custom knowledge packs ---


@router.get("/knowledge", response_model=List[KnowledgePackResponse])
async def list_knowledge_packs():
    rows = await run_in_threadpool(list_packs_summary)
    return [
        KnowledgePackResponse(
            id=r["id"],
            name=r["name"],
            instructions=r.get("instructions"),
            created_at=r["created_at"],
            updated_at=r["updated_at"],
            asset_count=int(r.get("asset_count") or 0),
        )
        for r in rows
    ]


@router.post("/knowledge", response_model=KnowledgePackResponse)
async def create_knowledge_pack_route(body: KnowledgePackCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    row = await run_in_threadpool(create_knowledge_pack, name, body.instructions or "")
    return KnowledgePackResponse(
        id=row["id"],
        name=row["name"],
        instructions=row.get("instructions"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        asset_count=0,
    )


@router.get("/knowledge/{pack_id}", response_model=KnowledgePackResponse)
async def get_knowledge_pack_route(pack_id: str):
    detail = await run_in_threadpool(get_pack_detail, pack_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Knowledge pack not found")
    return KnowledgePackResponse(
        id=detail["id"],
        name=detail["name"],
        instructions=detail.get("instructions"),
        created_at=detail["created_at"],
        updated_at=detail["updated_at"],
        asset_count=detail.get("asset_count", 0),
        assets=detail.get("assets"),
    )


@router.put("/knowledge/{pack_id}", response_model=KnowledgePackResponse)
async def update_knowledge_pack_route(pack_id: str, body: KnowledgePackUpdate):
    row = await run_in_threadpool(
        update_knowledge_pack, pack_id, body.name, body.instructions
    )
    if not row:
        raise HTTPException(status_code=404, detail="Knowledge pack not found")
    assets = await run_in_threadpool(get_pack_detail, pack_id)
    return KnowledgePackResponse(
        id=row["id"],
        name=row["name"],
        instructions=row.get("instructions"),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        asset_count=assets.get("asset_count", 0) if assets else 0,
    )


@router.delete("/knowledge/{pack_id}")
async def delete_knowledge_pack_route(pack_id: str):
    ok = await run_in_threadpool(delete_knowledge_pack, pack_id)
    if not ok:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete knowledge pack referenced by locked conversations",
        )
    return {"status": "success"}


@router.post("/knowledge/{pack_id}/assets")
async def upload_knowledge_asset(pack_id: str, file: UploadFile = File(...)):
    pack = await run_in_threadpool(get_knowledge_pack, pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Knowledge pack not found")
    filename = file.filename or "upload"
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file")
    try:
        asset = await save_and_summarize_asset(pack_id, filename, file_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return asset


@router.post("/knowledge/{pack_id}/raw-text")
async def create_raw_text_asset_route(pack_id: str, payload: RawTextAssetCreate):
    pack = await run_in_threadpool(get_knowledge_pack, pack_id)
    if not pack:
        raise HTTPException(status_code=404, detail="Knowledge pack not found")
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text content cannot be empty")
    try:
        asset = await save_raw_text_asset(
            pack_id,
            payload.filename,
            payload.text,
            description=payload.description,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return asset



@router.delete("/knowledge/{pack_id}/assets/{asset_id}")
async def delete_knowledge_asset_route(pack_id: str, asset_id: str):
    asset = await run_in_threadpool(delete_knowledge_asset, asset_id)
    if not asset or asset.get("pack_id") != pack_id:
        raise HTTPException(status_code=404, detail="Asset not found")
    await run_in_threadpool(remove_asset_file, asset)
    return {"status": "success"}


@router.patch("/knowledge/{pack_id}/assets/{asset_id}")
async def update_knowledge_asset_route(pack_id: str, asset_id: str, payload: UpdateKnowledgeAssetRequest):
    asset = await run_in_threadpool(update_knowledge_asset, asset_id, payload.summary, payload.filename)
    if not asset or asset.get("pack_id") != pack_id:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.get("/threads/{thread_id}/knowledge", response_model=List[ThreadKnowledgeItem])
async def get_thread_knowledge_route(thread_id: str):
    rows = await run_in_threadpool(get_thread_knowledge, thread_id)
    return [
        ThreadKnowledgeItem(
            thread_id=r["thread_id"],
            knowledge_id=r["knowledge_id"],
            knowledge_name=r["knowledge_name"],
            is_locked=bool(r.get("is_locked")),
            attached_at=r["attached_at"],
        )
        for r in rows
    ]


@router.post("/maintenance/prune-checkpoints")
async def prune_checkpoints():
    """
    Vacuum the checkpoint database to reclaim disk space.
    Safe to call while agent is running (uses a separate connection).
    """
    try:
        result = await run_in_threadpool(vacuum_checkpoint_db)
        return result
    except Exception as e:
        logging.error(f"Checkpoint pruning failed: {e}")
        raise HTTPException(status_code=500, detail=f"Pruning failed: {str(e)}")


@router.post("/scheduler/schedule", response_model=ScheduledTaskResponse)
async def schedule_task(data: ScheduleTaskRequest):
    """
    Schedule a chat message to be executed by the LLM at a specific time.
    """
    if not data.thread_id:
        raise HTTPException(status_code=400, detail="thread_id is required")
    if data.intent not in SCHEDULE_INTENTS:
        raise HTTPException(
            status_code=400,
            detail=f"intent must be one of: {', '.join(SCHEDULE_INTENTS)}",
        )
    try:
        job_id = scheduler_manager.add_task(
            text=data.text,
            run_at=data.run_at,
            thread_id=data.thread_id,
            chat_mode=data.chat_mode or "agent",
            speed_mode=data.speed_mode or "thinking",
            intent=data.intent,
            title=data.title,
        )
        return ScheduledTaskResponse(
            id=job_id,
            text=data.text,
            run_at=data.run_at,
            thread_id=data.thread_id,
            status="scheduled",
            intent=data.intent,
            title=data.title,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logging.error(f"Failed to schedule task: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/scheduler/tasks", response_model=List[ScheduledTaskResponse])
async def list_scheduled_tasks():
    """
    List all pending scheduled tasks.
    """
    return scheduler_manager.list_tasks()

@router.get("/scheduler/tasks/{job_id}", response_model=ScheduledTaskResponse)
async def get_scheduled_task(job_id: str):
    """
    Get a scheduled task by ID.
    """
    task = scheduler_manager.get_task(job_id)
    if not task:
        raise HTTPException(status_code=404, detail=f"Task {job_id} not found")
    return task

@router.patch("/scheduler/tasks/{job_id}", response_model=ScheduledTaskResponse)
async def update_scheduled_task(job_id: str, data: UpdateScheduledTaskRequest):
    """
    Update a scheduled task's execution time, text, intent, or title.
    """
    try:
        updated = scheduler_manager.update_task(
            job_id=job_id,
            text=data.text,
            run_at=data.run_at,
            intent=data.intent,
            title=data.title,
        )
        if not updated:
            raise HTTPException(status_code=404, detail=f"Task {job_id} not found")
        return updated
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logging.error(f"Failed to update task {job_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/scheduler/tasks/{job_id}")
async def cancel_scheduled_task(job_id: str):
    """
    Cancel a scheduled task.
    """
    success = scheduler_manager.cancel_task(job_id)
    if success:
        return {"status": "success", "message": f"Cancelled task {job_id}"}
    else:
        raise HTTPException(status_code=404, detail=f"Task {job_id} not found")



@router.get("/scheduler/notifications", response_model=List[ScheduleNotificationItem])
async def list_schedule_notifications():
    """Unread notifications produced when a scheduled reminder or analysis_inform completes."""
    rows = get_unread_schedule_notifications()
    return [
        ScheduleNotificationItem(
            id=r["id"],
            thread_id=r.get("thread_id"),
            task_id=r.get("task_id"),
            intent=r["intent"],
            title=r["title"],
            body=r["body"],
            created_at=r["created_at"],
        )
        for r in rows
    ]


@router.post("/scheduler/notifications/read-all")
async def mark_all_notifications_read():
    mark_all_schedule_notifications_read()
    return {"status": "success"}


@router.post("/scheduler/notifications/{notif_id}/read")
async def mark_notification_read(notif_id: str):
    mark_schedule_notification_read(notif_id)
    return {"status": "success"}


@router.get("/chat/pending/{thread_id}", response_model=Optional[HITLRequestModel])
async def get_pending_action(thread_id: str):
    """
    Get pending HITL action for a thread
    """
    interrupt = await agent_manager.get_pending_interrupt(thread_id)
    return interrupt


@router.post("/chat/resume")
async def chat_resume(data: ResumeChatRequest):
    """
    Resume a paused agent stream with human decisions
    """
    if not agent_manager.is_configured:
        raise HTTPException(
            status_code=500,
            detail="Agent not configured."
        )

    thread_id = data.thread_id
    decisions = data.decisions
    project_root = data.project_root
    is_voice = data.is_voice
    token = data.token
    chat_mode = data.chat_mode
    speed_mode = data.speed_mode

    return StreamingResponse(
        _agent_stream_generator_with_save(
            messages=None, 
            thread_id=thread_id, 
            is_voice=is_voice, 
            project_root=project_root, 
            token=token, 
            decisions=decisions,
            chat_mode=chat_mode,
            speed_mode=speed_mode,
            client_timezone=data.client_timezone,
            client_local_datetime_iso=data.client_local_datetime_iso,
            client_latitude=data.client_latitude,
            client_longitude=data.client_longitude,
            client_location_accuracy_m=data.client_location_accuracy_m,
        ),
        media_type="text/event-stream",
        headers=_SSE_CHAT_HEADERS,
    )





LTM_TOOL_NAMES = ["save_memory", "get_memory", "search_memory"]

_SSE_CHAT_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _serialize_message(msg: Any) -> Optional[Dict[str, Any]]:
    """
    Best‑effort serialization of a LangChain / LangGraph message object into JSON‑safe data.

    This is intentionally shallow – the goal is to surface enough structure so the UI
    can understand when tools are being called (tool name, args, etc.) and stream LLM thoughts.
    """
    # Fall back to string if it's already a simple type
    if isinstance(msg, (str, int, float, bool)) or msg is None:
        return {"type": "text", "content": str(msg)}

    data: Dict[str, Any] = {}

    # Common attributes on LangChain message classes
    for attr in ("type", "role", "name", "id", "tool_call_id"):
        if hasattr(msg, attr):
            data[attr] = getattr(msg, attr)

    # Content / text / thought extraction
    reasoning_content = None
    add_kwargs = getattr(msg, "additional_kwargs", None)
    if isinstance(add_kwargs, dict):
        reasoning_content = (
            add_kwargs.get("reasoning_content")
            or add_kwargs.get("reasoning")
            or add_kwargs.get("thought")
            or add_kwargs.get("thinking")
        )
    if not reasoning_content:
        resp_meta = getattr(msg, "response_metadata", None)
        if isinstance(resp_meta, dict):
            reasoning_content = (
                resp_meta.get("reasoning_content")
                or resp_meta.get("reasoning")
                or resp_meta.get("thought")
                or resp_meta.get("thinking")
            )

    raw_content = getattr(msg, "content", None) if hasattr(msg, "content") else getattr(msg, "text", None)
    if isinstance(raw_content, list):
        thought_parts = []
        text_parts = []
        for part in raw_content:
            if isinstance(part, dict):
                p_type = str(part.get("type", "")).lower()
                if p_type in ("thought", "thinking", "reasoning", "reasoning_content") or part.get("thought") is True:
                    t_val = part.get("thought") or part.get("thinking") or part.get("text") or ""
                    if isinstance(t_val, str) and t_val:
                        thought_parts.append(t_val)
                elif p_type == "text" or "text" in part:
                    text_parts.append(part.get("text", ""))
                else:
                    text_parts.append(str(part))
            elif isinstance(part, str):
                text_parts.append(part)
        if thought_parts:
            reasoning_content = (reasoning_content or "") + "".join(thought_parts)
        data["content"] = "".join(text_parts)
    else:
        data["content"] = raw_content if raw_content is not None else ""

    if reasoning_content:
        data["reasoning_content"] = reasoning_content

    # Streaming chunks report AIMessageChunk — normalize so the UI treats them like "ai"
    if data.get("type") == "AIMessageChunk":
        data["type"] = "ai"

    # Tool calls for AIMessage
    if hasattr(msg, "tool_calls") and getattr(msg, "tool_calls"):
        serialized_calls = []
        for tc in getattr(msg, "tool_calls", []):
            tc_name = ""
            tc_data = {}
            if isinstance(tc, dict):
                tc_name = tc.get("name", "")
                tc_data = tc
            else:
                for attr in ("name", "args", "id", "type"):
                    if hasattr(tc, attr):
                        tc_data[attr] = getattr(tc, attr)
                tc_name = tc_data.get("name", "")
            
            if tc_name not in LTM_TOOL_NAMES:
                if tc_name == "task" and isinstance(tc_data, dict):
                    args = tc_data.get("args") or {}
                    subagent_type = str(args.get("subagent_type", "")).strip()
                    graph = settings.SUBAGENT_PLANNER_GRAPH or {}
                    nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
                    node = next(
                        (
                            item for item in nodes
                            if isinstance(item, dict)
                            and str(item.get("name", "")).strip().lower() == subagent_type.lower()
                        ),
                        None,
                    )
                    tc_data["subagent_meta"] = {
                        "name": (node or {}).get("name") or subagent_type or "subagent",
                        "description": (node or {}).get("description") or "",
                        "logo_url": (node or {}).get("logo_url"),
                    }
                serialized_calls.append(tc_data or str(tc))
        
        if not serialized_calls and not data.get("content") and not data.get("reasoning_content"):
             # If it's an AI message with no non-LTM tool calls, no content, and no reasoning, hide it
             return None
             
        data["tool_calls"] = serialized_calls

    # Content blocks (LangGraph / streaming structures) – keep shallow
    # If it's a tool response for an LTM tool, hide it
    if data.get("type") == "tool" and data.get("name") in LTM_TOOL_NAMES:
        return None

    return data


async def _agent_stream_generator(
    messages: Optional[list[Dict[str, Any]]],
    thread_id: str,
    is_voice: bool = False,
    project_root: Optional[str] = None,
    token: Optional[str] = None,
    decisions: Optional[list[Dict[str, Any]]] = None,
    chat_mode: Optional[str] = None,
    speed_mode: Optional[str] = None,
    client_timezone: Optional[str] = None,
    client_local_datetime_iso: Optional[str] = None,
    client_latitude: Optional[float] = None,
    client_longitude: Optional[float] = None,
    client_location_accuracy_m: Optional[float] = None,
    friend_target_id: Optional[str] = None,
    friend_target_name: Optional[str] = None,
    knowledge_context: Optional[str] = None,
    skill_ids: Optional[List[str]] = None,
) -> AsyncIterator[str]:
    """
    Wrap the Deep Agent `.stream()` generator into Server‑Sent Events (SSE) lines.

    Each yielded item is a single SSE event containing:
    - step: which node produced this update (e.g. "model", "tools")
    - message: serialized LangChain message (including tool_calls when present)
    """
    logger = logging.getLogger(__name__)
    logger.info(f"Stream generator started for thread_id={thread_id}")

    def _classify_stream_error(exc: Exception) -> tuple[str, str]:
        message = str(exc) or "unknown_error"
        lowered = message.lower()
        if "upstream_connection_error" in lowered:
            return (
                "upstream_connection_error",
                "Cannot reach the configured model provider. Check internet, base URL, and provider service status.",
            )
        if "connect" in lowered and "error" in lowered:
            return (
                "upstream_connection_error",
                "Network connection to the model provider failed. Please retry.",
            )
        return ("internal_stream_error", message)

    try:
        from app.terminal_stream import streamer
        term_queue = streamer.get_queue(thread_id)
        sse_queue: asyncio.Queue[Optional[str]] = asyncio.Queue()

        async def consume_agent():
            try:
                # Check for initial interrupt if resuming
                if decisions is None:
                    pending = await agent_manager.get_pending_interrupt(thread_id)
                    if pending:
                        logger.info(f"Found existing interrupt for thread_id={thread_id}")
                        await sse_queue.put(f"data: {json.dumps({'step': 'interrupt', 'hitl': pending}, default=str)}\n\n")
                        return

                seen_token_stream = False

                async for chunk in agent_manager.stream(
                    messages=messages, 
                    thread_id=thread_id, 
                    is_voice=is_voice, 
                    project_root=project_root, 
                    token=token,
                    decisions=decisions,
                    chat_mode=chat_mode,
                    speed_mode=speed_mode,
                    client_timezone=client_timezone,
                    client_local_datetime_iso=client_local_datetime_iso,
                    client_latitude=client_latitude,
                    client_longitude=client_longitude,
                    client_location_accuracy_m=client_location_accuracy_m,
                    friend_target_id=friend_target_id,
                    friend_target_name=friend_target_name,
                    knowledge_context=knowledge_context,
                    skill_ids=skill_ids,
                ):
                    # Token-level LLM chunks (LangGraph stream_mode includes "messages")
                    if "__lg_messages__" in chunk:
                        pair = chunk["__lg_messages__"]
                        llm_chunk = pair[0] if isinstance(pair, tuple) and len(pair) >= 1 else pair
                        serialized = _serialize_message(llm_chunk)
                        if serialized is None:
                            continue
                        # Flash mode promises an immediate final answer without
                        # exposing provider reasoning. Some models (notably
                        # gpt-oss) return reasoning_content even for trivial turns.
                        if speed_mode == "flash":
                            serialized.pop("reasoning_content", None)
                        # UI "model" channel is assistant tokens only (not tool/human messages)
                        if serialized.get("type") not in ("ai", "assistant"):
                            continue
                        seen_token_stream = True
                        payload = {"step": "model", "message": serialized}
                        await sse_queue.put(f"data: {json.dumps(payload, default=str)}\n\n")
                        continue

                    # Check for interrupt in the chunk
                    if "__interrupt__" in chunk:
                        interrupt_data = chunk["__interrupt__"]
                        if isinstance(interrupt_data, tuple) and len(interrupt_data) > 0:
                             interrupt_request = interrupt_data[0].value
                        else:
                             interrupt_request = interrupt_data
                        
                        logger.info(f"Agent interrupted for thread_id={thread_id}")
                        await sse_queue.put(f"data: {json.dumps({'step': 'interrupt', 'hitl': interrupt_request}, default=str)}\n\n")
                        return

                    for step, data in chunk.items():
                        try:
                            # Some middlewares emit Overwrite(...) wrappers instead of raw lists.
                            # We duck‑type here instead of importing internal classes.
                            raw_messages = None
                            if isinstance(data, dict):
                                raw_messages = data.get("messages")
                            else:
                                # Sometimes the whole data object can be an Overwrite-like object
                                if hasattr(data, "value"):
                                    raw_messages = getattr(data, "value")

                            if raw_messages is None:
                                continue

                            # Unwrap Overwrite(value=[...]) if present
                            if hasattr(raw_messages, "value"):
                                raw_messages = getattr(raw_messages, "value")

                            # We only handle list-like messages here
                            if not isinstance(raw_messages, list) or not raw_messages:
                                continue

                            last_msg = raw_messages[-1]

                            serialized = _serialize_message(last_msg)
                            if serialized is None:
                                continue
                            if speed_mode == "flash":
                                serialized.pop("reasoning_content", None)

                            # Avoid sending the full assistant reply again after token streaming
                            # (LangGraph emits both "messages" tokens and an "updates" node completion).
                            # Apply for any graph node name — sub-agents may use steps other than "model".
                            if (
                                seen_token_stream
                                and serialized.get("type") in ("ai", "assistant")
                            ):
                                has_tools = bool(serialized.get("tool_calls"))
                                # The token stream already delivered both answer
                                # text and provider reasoning. The later node update
                                # is useful only for its completed tool-call payload.
                                serialized.pop("reasoning_content", None)
                                if has_tools:
                                    serialized["content"] = ""
                                else:
                                    continue

                            payload = {
                                "step": step,
                                "message": serialized,
                            }

                            # Downgraded to debug to avoid hot-path overhead
                            if logger.isEnabledFor(logging.DEBUG):
                                has_tc = "tool_calls" in serialized and serialized["tool_calls"]
                                logger.debug(f"Yielding payload for step={step}. Tool calls: {has_tc}")

                            # SSE format: "data: <json>\n\n"
                            await sse_queue.put(f"data: {json.dumps(payload, default=str)}\n\n")

                        except Exception as e:
                            logger.error(f"Error processing chunk step={step}: {e}", exc_info=True)
                            # Surface errors as a special SSE event so the UI can react
                            err_payload = {
                                "step": step,
                                "error": str(e),
                            }
                            await sse_queue.put(f"data: {json.dumps(err_payload, default=str)}\n\n")


                # Signal completion so the client can close the SSE cleanly
                logger.info("Stream generator finished normally")
                await sse_queue.put(f"data: {json.dumps({'step': 'end', 'done': True})}\n\n")
            
            except asyncio.CancelledError:
                logger.info("Agent consumption cancelled")
            except Exception as e:
                code, details = _classify_stream_error(e)
                if code == "upstream_connection_error":
                    logger.warning(f"Stream generator upstream connection issue: {e}")
                else:
                    logger.error(f"Stream generator crashed: {e}", exc_info=True)
                # Attempt to yield error to client if possible
                err_payload = {"error": code, "details": details}
                await sse_queue.put(f"data: {json.dumps(err_payload, default=str)}\n\n")
            finally:
                await sse_queue.put(None) # Signal completion

        async def consume_terminal():
            try:
                while True:
                    chunk = await term_queue.get()
                    if chunk is None:
                        break
                    await sse_queue.put(f"data: {chunk}\n\n")
                    term_queue.task_done()
            except asyncio.CancelledError:
                pass

        agent_task = asyncio.create_task(consume_agent())
        term_task = asyncio.create_task(consume_terminal())

        while True:
            item = await sse_queue.get()
            if item is None:
                break
            yield item

    except asyncio.CancelledError:
        logger.info("Stream generator cancelled by client")
        raise
    except Exception as e:
        code, details = _classify_stream_error(e)
        if code == "upstream_connection_error":
            logger.warning(f"Outer stream generator upstream connection issue: {e}")
        else:
            logger.error(f"Outer stream generator crashed: {e}", exc_info=True)
        err_payload = {"error": code, "details": details}
        yield f"data: {json.dumps(err_payload, default=str)}\n\n"
    finally:
        agent_task.cancel()
        term_task.cancel()
        streamer.cleanup(thread_id)
        logger.info("Stream generator exiting (finally block)")

async def _agent_stream_generator_with_save(
    messages: Optional[list[Dict[str, Any]]],
    thread_id: str,
    is_voice: bool = False,
    project_root: Optional[str] = None,
    token: Optional[str] = None,
    decisions: Optional[list[Dict[str, Any]]] = None,
    chat_mode: Optional[str] = None,
    speed_mode: Optional[str] = None,
    client_timezone: Optional[str] = None,
    client_local_datetime_iso: Optional[str] = None,
    client_latitude: Optional[float] = None,
    client_longitude: Optional[float] = None,
    client_location_accuracy_m: Optional[float] = None,
    friend_target_id: Optional[str] = None,
    friend_target_name: Optional[str] = None,
    knowledge_context: Optional[str] = None,
    skill_ids: Optional[List[str]] = None,
    knowledge_lock_thread_id: Optional[str] = None,
    knowledge_snapshots: Optional[Dict[str, str]] = None,
) -> AsyncIterator[str]:
    """
    Wraps the stream generator to accumulate and save the assistant's response.
    """
    full_response = []
    
    async for chunk in _agent_stream_generator(
        messages,
        thread_id,
        is_voice,
        project_root,
        token,
        decisions,
        chat_mode,
        speed_mode,
        client_timezone,
        client_local_datetime_iso,
        client_latitude,
        client_longitude,
        client_location_accuracy_m,
        friend_target_id,
        friend_target_name,
        knowledge_context,
        skill_ids,
    ):
        yield chunk
        # Parse chunk to extract content
        # Chunk is "data: <json>\n\n"
        if chunk.startswith("data: "):
            try:
                data_str = chunk[6:].strip()
                data = json.loads(data_str)
                
                # Check for model message
                if data.get("step") == "model":
                    msg = data.get("message", {})
                    if msg.get("type", "") in ["ai", "assistant"]:
                        content = msg.get("content", "")
                        if content and isinstance(content, str):
                            full_response.append(content)
            except Exception:
                pass

    # Save the full response if we got any
    if full_response:
        final_text = "".join(full_response)
        await run_in_threadpool(save_message, thread_id, "assistant", final_text)

    if knowledge_lock_thread_id and knowledge_snapshots is not None and full_response:
        await run_in_threadpool(
            lock_thread_knowledge_after_stream,
            knowledge_lock_thread_id,
            knowledge_snapshots,
        )





DEFAULT_THREAD_TITLE = "Untitled Chat"


def _strip_clipboard_from_message(text: str) -> str:
    if "\n\n[Clipboard Content]:" in text:
        return text.split("\n\n[Clipboard Content]:")[0].strip()
    return text.strip()


async def _update_thread_title_after_second_message(thread_id: str) -> None:
    """Generate an LLM title once the user has sent two messages."""
    try:
        messages = await run_in_threadpool(get_thread_messages, thread_id)
        user_texts = [
            _strip_clipboard_from_message(m["content"])
            for m in messages
            if m.get("role") == "user" and (m.get("content") or "").strip()
        ]
        if len(user_texts) < 2:
            return
        title = await agent_manager.generate_chat_thread_title(user_texts[:2])
        await run_in_threadpool(update_thread_title, thread_id, title)
        logging.info("Updated thread %s title to: %s", thread_id, title)
    except Exception as exc:
        logging.warning("Failed to generate thread title for %s: %s", thread_id, exc)


async def _chat_stream_with_url_previews(
    message: str,
    *,
    thread_id: str,
    image_url: Optional[str],
    is_voice: bool,
    project_root: Optional[str],
    token: Optional[str],
    chat_mode: Optional[str],
    speed_mode: Optional[str],
    client_timezone: Optional[str],
    client_local_datetime_iso: Optional[str],
    client_latitude: Optional[float],
    client_longitude: Optional[float],
    client_location_accuracy_m: Optional[float],
    friend_target_id: Optional[str],
    friend_target_name: Optional[str],
    knowledge_context: Optional[str] = None,
    knowledge_lock_thread_id: Optional[str] = None,
    knowledge_snapshots: Optional[Dict[str, str]] = None,
    skill_ids: Optional[List[str]] = None,
) -> AsyncIterator[str]:
    """Emit URL preview SSE events, enrich the user message, then stream the agent."""
    agent_message = message
    urls = extract_urls(message)
    if urls:
        previews = await fetch_url_previews(urls)
        if previews:
            yield f"data: {json.dumps({'step': 'url_preview', 'previews': previews}, default=str)}\n\n"
            preview_context = format_previews_for_agent(previews)
            if preview_context:
                agent_message = f"{message}{preview_context}"
 
    messages = [{"role": "user", "content": agent_message, "image_url": image_url}]
    async for chunk in _agent_stream_generator_with_save(
        messages,
        thread_id=thread_id,
        is_voice=is_voice,
        project_root=project_root,
        token=token,
        chat_mode=chat_mode,
        speed_mode=speed_mode,
        client_timezone=client_timezone,
        client_local_datetime_iso=client_local_datetime_iso,
        client_latitude=client_latitude,
        client_longitude=client_longitude,
        client_location_accuracy_m=client_location_accuracy_m,
        friend_target_id=friend_target_id,
        friend_target_name=friend_target_name,
        knowledge_context=knowledge_context,
        knowledge_lock_thread_id=knowledge_lock_thread_id,
        knowledge_snapshots=knowledge_snapshots,
        skill_ids=skill_ids,
    ):
        yield chunk


@router.post("/chat/stream")
async def chat_stream_post(
    chat_message: ChatMessage
):
    """
    POST‑based streaming chat endpoint to support large payloads (like images).
    """
    if not agent_manager.is_configured:
        raise HTTPException(
            status_code=500,
            detail="Agent not configured."
        )

    message = chat_message.message
    thread_id = chat_message.thread_id
    image_url = chat_message.image_url
    is_voice = chat_message.is_voice
    project_root = chat_message.project_root
    token = chat_message.token
    clipboard_text = chat_message.clipboard_text
    chat_mode = chat_message.chat_mode
    speed_mode = chat_message.speed_mode
    friend_target_id = chat_message.friend_target_id
    friend_target_name = chat_message.friend_target_name
    knowledge_ids = chat_message.knowledge_ids or []
    skill_ids = chat_message.skill_ids or []

    # If clipboard text is provided, append it to the message
    if clipboard_text:
        logging.info(f"Attaching clipboard content (len: {len(clipboard_text)}) to message")
        message = f"{message}\n\n[Clipboard Content]:\n{clipboard_text}"
    else:
        logging.info("No clipboard content attached")

    # If files are attached, append their contents to the message
    attached_files = chat_message.attached_files or []
    if attached_files:
        logging.info(f"Attaching {len(attached_files)} file(s) to message")
        file_blocks = []
        for f in attached_files:
            fname = f.get("name", "unknown")
            fcontent = f.get("content", "")
            # Truncate very large files to avoid exceeding context limits
            max_chars = 100_000
            if len(fcontent) > max_chars:
                fcontent = fcontent[:max_chars] + f"\n\n... (truncated, file was {len(f.get('content', ''))} chars)"
            file_blocks.append(f"[Attached File: {fname}]:\n```\n{fcontent}\n```")
        message = f"{message}\n\n" + "\n\n".join(file_blocks)

    # 1. Ensure thread exists (title stays generic until 2nd user message)
    real_thread_id = await run_in_threadpool(create_thread, DEFAULT_THREAD_TITLE, thread_id)

    knowledge_context = ""
    knowledge_snapshots: Dict[str, str] = {}
    try:
        knowledge_context, knowledge_snapshots = await run_in_threadpool(
            prepare_thread_knowledge_for_stream,
            real_thread_id,
            knowledge_ids if knowledge_ids else None,
        )
    except Exception as exc:
        logging.warning("Failed to prepare thread knowledge: %s", exc)

    # 2. Save User Message (original text only; previews are injected for the agent at stream time)
    await run_in_threadpool(save_message, real_thread_id, "user", message, image_url)

    user_count = await run_in_threadpool(count_user_messages, real_thread_id)
    if user_count == 2:
        asyncio.create_task(_update_thread_title_after_second_message(real_thread_id))

    # 3. Stream URL previews (if any), then agent response
    return StreamingResponse(
        _chat_stream_with_url_previews(
            message,
            thread_id=real_thread_id,
            image_url=image_url,
            is_voice=is_voice,
            project_root=project_root,
            token=token,
            chat_mode=chat_mode,
            speed_mode=speed_mode,
            client_timezone=chat_message.client_timezone,
            client_local_datetime_iso=chat_message.client_local_datetime_iso,
            client_latitude=chat_message.client_latitude,
            client_longitude=chat_message.client_longitude,
            client_location_accuracy_m=chat_message.client_location_accuracy_m,
            friend_target_id=friend_target_id,
            friend_target_name=friend_target_name,
            knowledge_context=knowledge_context or None,
            knowledge_lock_thread_id=real_thread_id if knowledge_context else None,
            knowledge_snapshots=knowledge_snapshots if knowledge_context else None,
            skill_ids=skill_ids or None,
        ),
        media_type="text/event-stream",
        headers=_SSE_CHAT_HEADERS,
    )


# ---------------------------------------------------------------------------
# Skills CRUD endpoints
# ---------------------------------------------------------------------------

@router.get("/skills", response_model=List[SkillResponse])
async def get_skills():
    """List all skills."""
    rows = await run_in_threadpool(list_skills)
    return [
        SkillResponse(
            id=r["id"],
            name=r["name"],
            description=r.get("description", ""),
            content=r.get("content", ""),
            icon=r.get("icon", "🧠"),
            tool_ids=r.get("tool_ids", []),
            enabled=r.get("enabled", True),
            created_at=r["created_at"],
            updated_at=r["updated_at"],
        )
        for r in rows
    ]


@router.post("/skills", response_model=SkillResponse, status_code=201)
async def create_skill_endpoint(body: SkillCreate):
    """Create a new skill."""
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Skill name cannot be empty")
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="Skill content cannot be empty")
    row = await run_in_threadpool(
        create_skill,
        body.name,
        body.description,
        body.content,
        body.icon,
        body.tool_ids,
    )
    return SkillResponse(
        id=row["id"],
        name=row["name"],
        description=row.get("description", ""),
        content=row.get("content", ""),
        icon=row.get("icon", "🧠"),
        tool_ids=row.get("tool_ids", []),
        enabled=row.get("enabled", True),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.get("/skills/active")
async def get_active_skills_endpoint(
    thread_id: Optional[str] = None,
    project_root: Optional[str] = None
):
    """
    Return instructions explicitly attached to this thread.

    Globally enabled and workspace-discovered skills are merely available for
    query-time matching; they are not necessarily injected and must not be
    presented by the UI as active instructions.
    """
    active = []
    
    # Explicit thread attachments are the only instructions that can be
    # truthfully represented as persistently active by this endpoint.
    try:
        db_skills = await run_in_threadpool(list_thread_skills, thread_id) if thread_id else []
        for item in db_skills:
            active.append({
                "id": item["id"],
                "name": item["name"],
                "icon": item.get("icon", "🧠"),
                "source": "db_thread",
                "description": item.get("description", "")
            })
    except Exception:
        pass

    return active


@router.get("/skills/{skill_id}", response_model=SkillResponse)
async def get_skill_endpoint(skill_id: str):
    """Get a single skill by ID."""
    row = await run_in_threadpool(get_skill, skill_id)
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    return SkillResponse(
        id=row["id"],
        name=row["name"],
        description=row.get("description", ""),
        content=row.get("content", ""),
        icon=row.get("icon", "🧠"),
        tool_ids=row.get("tool_ids", []),
        enabled=row.get("enabled", True),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.put("/skills/{skill_id}", response_model=SkillResponse)
async def update_skill_endpoint(skill_id: str, body: SkillUpdate):
    """Update a skill by ID."""
    if body.name is not None and not body.name.strip():
        raise HTTPException(status_code=400, detail="Skill name cannot be empty")
    if body.content is not None and not body.content.strip():
        raise HTTPException(status_code=400, detail="Skill content cannot be empty")
    row = await run_in_threadpool(
        update_skill,
        skill_id,
        body.name,
        body.description,
        body.content,
        body.icon,
        body.tool_ids,
        body.enabled,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Skill not found")
    return SkillResponse(
        id=row["id"],
        name=row["name"],
        description=row.get("description", ""),
        content=row.get("content", ""),
        icon=row.get("icon", "🧠"),
        tool_ids=row.get("tool_ids", []),
        enabled=row.get("enabled", True),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.delete("/skills/{skill_id}")
async def delete_skill_endpoint(skill_id: str):
    """Delete a skill by ID."""
    try:
        deleted = await run_in_threadpool(delete_skill, skill_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Skill not found")
        return {"ok": True, "id": skill_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))





# ── Plugin & Connector Layer API Endpoints ─────────────────────────────────────

@router.get("/api/plugins/catalog")
async def get_plugin_catalog():
    """
    Get all available connector plugins in catalog with their status,
    account info, and exposed tools.
    """
    plugin_registry.discover_plugins()
    db_records = list_plugin_integrations()
    installed_map = {r["plugin_id"]: r for r in db_records}
    if "google" in installed_map and "gmail" not in installed_map:
        installed_map["gmail"] = installed_map["google"]

    catalog = []
    for plugin_id, manifest in plugin_registry.manifests.items():
        installed = installed_map.get(plugin_id)
        status = installed["status"] if installed else "disconnected"
        account_info = installed["account_info"] if installed else {}
        updated_at = installed["updated_at"] if installed else None

        tools_info = [
            {
                "name": t.name,
                "description": t.description,
                "risk_level": getattr(t, "risk_level", "read")
            }
            for t in manifest.tools
        ]

        catalog.append({
            "id": manifest.id,
            "name": manifest.name,
            "displayName": manifest.displayName,
            "version": getattr(manifest, "version", "1.0.0"),
            "description": manifest.description,
            "category": manifest.category,
            "icon": manifest.icon,
            "auth_type": manifest.auth_type,
            "scopes": getattr(manifest, "scopes", []),
            "status": status,
            "account_info": account_info,
            "config": installed.get("config", {}) if installed else {},
            "updated_at": updated_at,
            "tools": tools_info
        })

    return {"status": "ok", "plugins": catalog}


@router.post("/api/plugins/{plugin_id}/capabilities")
async def toggle_plugin_capability(plugin_id: str, capability: str, enabled: bool):
    """Toggle a plugin tool capability (enable or disable)."""
    record = get_plugin_integration(plugin_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' is not installed.")

    config = record.get("config", {})
    disabled_caps = set(config.get("disabled_capabilities", []))

    if enabled:
        disabled_caps.discard(capability)
    else:
        disabled_caps.add(capability)

    config["disabled_capabilities"] = list(disabled_caps)

    save_plugin_integration(
        plugin_id=plugin_id,
        name=record["name"],
        auth_type=record["auth_type"],
        status=record["status"],
        encrypted_credentials=record.get("encrypted_credentials", ""),
        account_info=json.dumps(record.get("account_info", {})),
        config=json.dumps(config)
    )

    await plugin_manager.initialize()
    agent_manager.invalidate_agent()
    return {"status": "ok", "plugin_id": plugin_id, "disabled_capabilities": list(disabled_caps)}


@router.post("/api/plugins/{plugin_id}/connect")
async def connect_plugin(plugin_id: str, custom_client_id: Optional[str] = None):
    """
    Initiate OAuth authorization flow via cloud middleware proxy or direct custom client ID.
    Returns auth_url for user browser redirection.
    """
    manifest = plugin_registry.get_manifest(plugin_id)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' not found in catalog.")

    callback_url = "http://127.0.0.1:14300/api/plugins/oauth/callback"

    # If custom_client_id is provided, construct direct OAuth URL immediately
    if custom_client_id and custom_client_id.strip():
        cid = custom_client_id.strip()
        scopes_str = " ".join(manifest.scopes or [])
        if plugin_id == "github":
            auth_url = f"https://github.com/login/oauth/authorize?client_id={cid}&redirect_uri={callback_url}&scope={scopes_str}&state=github"
        elif plugin_id in ("gmail", "calendar"):
            auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?client_id={cid}&redirect_uri={callback_url}&response_type=code&scope={scopes_str}&access_type=offline&prompt=consent"
        elif plugin_id == "jira":
            auth_url = f"https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id={cid}&scope={scopes_str}&redirect_uri={callback_url}&response_type=code&prompt=consent"
        else:
            auth_url = f"https://oauth.provider.com/authorize?client_id={cid}&redirect_uri={callback_url}&response_type=code"

        return {
            "status": "ok",
            "plugin_id": plugin_id,
            "auth_url": auth_url
        }

    # Otherwise call rie-be-main cloud server to generate OAuth URL
    cloud_base = settings.RIE_API_URL.rstrip('/')
    cloud_url = f"{cloud_base}/integrations/oauth/{plugin_id}/authorize"
    params = {"desktop_callback": callback_url}

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            res = await client.get(cloud_url, params=params)
            if res.status_code == 200:
                data = res.json()
                if data.get("status") == "ok" and data.get("auth_url"):
                    return {
                        "status": "ok",
                        "plugin_id": plugin_id,
                        "auth_url": data["auth_url"]
                    }
                else:
                    return {
                        "status": "error",
                        "message": data.get("message", "Cloud middleware failed to construct authorization URL.")
                    }
            else:
                return {
                    "status": "error",
                    "message": f"OAuth middleware error ({res.status_code}): {res.text}"
                }
    except Exception as e:
        logger.error(f"Error calling cloud OAuth authorization endpoint: {e}")
        return {
            "status": "error",
            "message": f"OAuth server ({cloud_base}) is offline or unreachable. Open 'Manage' on the plugin card to enter your OAuth Client ID under Custom Client ID (Self-Host)."
        }


@router.get("/api/plugins/oauth/callback")
async def plugin_oauth_callback(
    provider: str = Query(...),
    payload: str = Query(...)
):
    """
    OAuth Callback destination hit after user authorizes.
    Decodes payload from cloud middleware, encrypts tokens, saves to SQLite, and updates agent tool router.
    """
    import urllib.parse
    import base64
    import json
    from fastapi.responses import HTMLResponse
    from app.oauth_templates import render_oauth_success_html, render_oauth_error_html

    try:
        unquoted = urllib.parse.unquote(payload)
        raw_json = base64.urlsafe_b64decode(unquoted.encode("utf-8")).decode("utf-8")
        data = json.loads(raw_json)

        status = data.get("status")
        target_plugin_id = provider
        if target_plugin_id == "google":
            target_plugin_id = "gmail"

        manifest = plugin_registry.get_manifest(target_plugin_id)
        name = manifest.displayName if manifest else target_plugin_id.capitalize()

        if status != "success":
            err_detail = data.get("message") or "Authorization was rejected or cancelled by provider."
            return HTMLResponse(
                content=render_oauth_error_html(err_detail, name),
                status_code=400
            )

        tokens = data.get("tokens", {})
        account_info = data.get("account_info", {})

        # Encrypt token payload with Fernet security crypto module
        encrypted_creds = encrypt_json({"tokens": tokens})

        # Save record in database
        save_plugin_integration(
            plugin_id=target_plugin_id,
            name=name,
            auth_type="oauth2",
            status="connected",
            encrypted_credentials=encrypted_creds,
            account_info=json.dumps(account_info),
            config="{}"
        )

        # Re-initialize plugin manager tools and invalidate cached agent graph
        await plugin_manager.initialize()
        agent_manager.invalidate_agent()

        # Render ultra-premium glassmorphic landing page
        html_content = render_oauth_success_html(
            provider_id=target_plugin_id,
            provider_name=name,
            account_info=account_info
        )
        return HTMLResponse(content=html_content)

    except Exception as e:
        logger.error(f"Failed to process plugin OAuth callback: {e}", exc_info=True)
        from fastapi.responses import HTMLResponse
        from app.oauth_templates import render_oauth_error_html
        return HTMLResponse(
            content=render_oauth_error_html(str(e), provider.capitalize()),
            status_code=400
        )


@router.post("/api/plugins/{plugin_id}/disconnect")
async def disconnect_plugin(plugin_id: str):
    """Disconnect plugin integration and delete credentials."""
    success = delete_plugin_integration(plugin_id)
    if success:
        await plugin_manager.initialize()
        agent_manager.invalidate_agent()
        return {"status": "ok", "message": f"Plugin '{plugin_id}' disconnected."}
    return {"status": "error", "message": f"Failed to disconnect plugin '{plugin_id}'."}


@router.post("/api/plugins/{plugin_id}/sync")
async def sync_plugin(plugin_id: str):
    """Test/sync active plugin integration."""
    record = get_plugin_integration(plugin_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_id}' is not installed.")

    # Re-initialize plugin tools and invalidate cached agent grap
    await plugin_manager.initialize()
    agent_manager.invalidate_agent()
    return {"status": "ok", "plugin": record}


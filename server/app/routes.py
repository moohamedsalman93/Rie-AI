"""
API routes/endpoints
"""
import asyncio
import json
import queue
import threading
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, AsyncIterator
import logging
import httpx

from fastapi import APIRouter, HTTPException, Query, File, UploadFile
from fastapi.responses import StreamingResponse

from app.models import (
    ChatMessage, HealthResponse, SettingsUpdate, SettingsResponse, 
    CancelRequest, SpeakRequest, ResumeChatRequest, HITLRequestModel,
    ScheduleTaskRequest, ScheduledTaskResponse, ScheduleNotificationItem,
    SubAgentConfig, PlannerGraphConfig, PlannerInstructionGenerateRequest, PlannerInstructionGenerateResponse,
    DeviceIdentity, FriendRecord, PairingRequest, PairingInitResponse, PairingConfirmRequest, PairingConfirmResponse, PeerAskRequest, PeerReceiveRequest, PeerAskResponse,
    PairingFinalizeRequest,
    FriendStatusResponse,
    NgrokInstallRequest, NgrokInstallResponse, NgrokStatusResponse,
    FriendApprovalRequest, FriendEndpointUpdateRequest,
    FriendPeerAccessPatch, PeerAccessCatalogResponse,
    PeerQueryEventItem,
)
from app.agent import agent_manager
from app.scheduler import scheduler_manager, SCHEDULE_INTENTS
from app.config import settings
from app.windows_tools import WINDOWS_TOOLS
from app.ltm_tools import LTM_TOOLS
from app.mcp_registry_tools import MCP_REGISTRY_TOOLS
from app.mcp_client import mcp_manager
from app.database import (
    update_setting,
    get_setting,
    create_thread,
    save_message,
    get_threads,
    get_thread_messages,
    delete_thread,
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
    get_tunnel_runtime_status,
)
from app.connectivity.ngrok_setup import persist_ngrok_setup
from fastapi.concurrency import run_in_threadpool
import io
import base64

router = APIRouter()


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
        "schedule_chat_task",
        "remote_friend_ask",
        *WINDOWS_TOOLS.keys(),
        *[t.name for t in LTM_TOOLS],
        *[t.name for t in MCP_REGISTRY_TOOLS],
    }
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


def _derive_subagents_from_planner_graph(graph_payload: dict) -> list[dict]:
    """Derive runtime SUBAGENTS_CONFIG list from validated planner graph payload."""
    nodes = graph_payload.get("nodes", []) if isinstance(graph_payload, dict) else []
    runtime_subagents: list[dict] = []
    for node in nodes:
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

        if not node.system_prompt.strip():
            raise HTTPException(status_code=400, detail=f"Planner node '{node.name}' must include system_prompt")

        normalized_tool_ids: list[str] = []
        for tool_id in node.tool_ids or []:
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
        normalized_nodes.append(node.model_copy(update={"tool_ids": normalized_tool_ids}))

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
            
            async def audio_generator():
                communicate = edge_tts.Communicate(data.text, voice)
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        yield chunk["data"]

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


@router.get("/rie/usage")
async def get_rie_usage():
    """
    Proxy request to Rie SaaS usage endpoint using stored token
    """
    if not settings.RIE_ACCESS_TOKEN:
        raise HTTPException(status_code=401, detail="Not authenticated")

    import httpx
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


@router.get("/ollama/models")
async def get_ollama_models():
    """
    Fetch list of downloaded models from Ollama instance (uses configured endpoint and optional API key).
    """
    import httpx
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


@router.get("/settings", response_model=SettingsResponse)
async def get_settings():
    """
    Get current settings (always masked)
    """
    settings.reload()
    
    def mask_key(key: Optional[str]) -> Optional[str]:
        if not key:
            return key
        
        # Support multiple keys (comma or newline separated)
        if ',' in key or '\n' in key:
            keys = [k.strip() for k in key.replace('\n', ',').split(',') if k.strip()]
            masked_keys = []
            for k in keys:
                if len(k) <= 8:
                    masked_keys.append("*" * len(k))
                else:
                    masked_keys.append(f"{k[:4]}{'*' * (len(k) - 8)}{k[-4:]}")
            return ", ".join(masked_keys)

        if len(key) <= 8:
            return "*" * len(key)
        return f"{key[:4]}{'*' * (len(key) - 8)}{key[-4:]}"

    return SettingsResponse(
        groq_api_key=mask_key(settings.GROQ_API_KEY_STRING),
        google_api_key=mask_key(settings.GOOGLE_API_KEY),
        openai_api_key=mask_key(settings.OPENAI_API_KEY),
        anthropic_api_key=mask_key(settings.ANTHROPIC_API_KEY),
        tavily_api_key=mask_key(settings.TAVILY_API_KEY),
        
        llm_provider=settings.LLM_PROVIDER,
        vertex_project=settings.VERTEX_PROJECT,
        vertex_location=settings.VERTEX_LOCATION,
        vertex_credentials_path=settings.VERTEX_CREDENTIALS_PATH,
        
        groq_model=settings.GROQ_MODEL,
        gemini_model=settings.GEMINI_MODEL,
        vertex_model=settings.VERTEX_MODEL,
        openai_model=settings.OPENAI_MODEL,
        openai_base_url=settings.OPENAI_BASE_URL,
        
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


@router.post("/settings")
async def update_settings(data: SettingsUpdate):
    """
    Update a specific setting
    """
    # Allowed keys to prevent arbitrary DB writes
    ALLOWED_KEYS = {
        "GROQ_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", 
        "ANTHROPIC_API_KEY", "TAVILY_API_KEY", 
        "VERTEX_PROJECT", "VERTEX_LOCATION", "VERTEX_CREDENTIALS_PATH",
        "LLM_PROVIDER", "ENABLED_TOOLS", "TERMINAL_RESTRICTIONS",
        "GROQ_MODEL", "GEMINI_MODEL", "VERTEX_MODEL", "OPENAI_MODEL", "OPENAI_BASE_URL",
        "MCP_SERVERS", "WINDOW_MODE", "CHAT_MODE", "SPEED_MODE", "AGENT_ORCHESTRATION_MODE", "HITL_ENABLED", "HITL_MODE",
        "LANGSMITH_TRACING", "LANGSMITH_API_KEY", "LANGSMITH_PROJECT", "LANGSMITH_ENDPOINT",
        "VOICE_REPLY", "RIE_ACCESS_TOKEN", "TTS_PROVIDER", "TTS_VOICE",
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
    else:
        value_to_store = data.value
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

    # Update DB
    update_setting(data.key, value_to_store)
    if derived_subagents_value is not None:
        update_setting("SUBAGENTS_CONFIG", derived_subagents_value)
    
    # Reload settings in memory
    settings.reload()
    
    # Re-initialize agent if possible (Async)
    # This might fail if other keys are missing, but that's expected
    try:
        import asyncio
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
    return {"status": "success", "message": f"Updated {data.key}"}


def _identity_payload() -> Dict[str, Any]:
    identity = get_or_create_device_identity()
    configured_name = settings.CONNECTIVITY_DEVICE_NAME
    if configured_name and configured_name != identity["name"]:
        identity = update_device_identity_name(configured_name)
    return {
        "device_id": identity["device_id"],
        "name": identity["name"],
        "public_key": identity["public_key"],
        "fingerprint": identity["fingerprint"],
        "public_url": settings.CONNECTIVITY_PUBLIC_URL,
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
        responder_url = _normalize_public_url(str(body.get("responder_public_url") or ""))
        if responder_url and responder_url != friend.get("public_url"):
            update_friend_public_url(friend_id, responder_url)
        return FriendStatusResponse(
            friend_id=friend_id,
            reachable=True,
            status=str(body.get("status", "online")),
            latency_ms=int((time.perf_counter() - started) * 1000),
            message=str(body.get("message", "reachable")),
            checked_at=checked_at,
            failure_code=None,
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
    public_url = runtime.get("public_url") or settings.CONNECTIVITY_PUBLIC_URL
    ready_state = "ready" if (detected.get("installed") and settings.CONNECTIVITY_NGROK_ENABLED and runtime.get("running") and public_url) else "not_ready"
    return NgrokStatusResponse(
        installed=bool(detected.get("installed")),
        path=detected.get("path") or settings.CONNECTIVITY_NGROK_INSTALL_PATH,
        version=detected.get("version"),
        enabled=settings.CONNECTIVITY_NGROK_ENABLED,
        public_url=public_url,
        tunnel_running=bool(runtime.get("running")),
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
        tavily_configured=settings.has_tavily_key
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


@router.get("/history")
async def get_history_threads():
    """Get list of chat history threads"""
    threads = await run_in_threadpool(get_threads)
    return threads

@router.get("/history/{thread_id}")
async def get_history_messages(thread_id: str):
    """Get messages for a specific thread"""
    messages = await run_in_threadpool(get_thread_messages, thread_id)
    return messages

@router.delete("/history/{thread_id}")
async def delete_history_thread(thread_id: str):
    """Delete a thread"""
    await run_in_threadpool(delete_thread, thread_id)
    return {"status": "success"}


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
    can understand when tools are being called (tool name, args, etc.).
    """
    # Fall back to string if it's already a simple type
    if isinstance(msg, (str, int, float, bool)) or msg is None:
        return {"type": "text", "content": str(msg)}

    data: Dict[str, Any] = {}

    # Common attributes on LangChain message classes
    for attr in ("type", "role", "name", "id"):
        if hasattr(msg, attr):
            data[attr] = getattr(msg, attr)

    # Content / text
    if hasattr(msg, "content"):
        content = getattr(msg, "content")
        if isinstance(content, list):
            # Pass through the list of content blocks
            data["content"] = content
        else:
            data["content"] = content
    elif hasattr(msg, "text"):
        data["content"] = getattr(msg, "text")

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
                serialized_calls.append(tc_data or str(tc))
        
        if not serialized_calls and not data.get("content"):
             # If it's an AI message with no non-LTM tool calls and no content, hide it
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
    friend_target_id: Optional[str] = None,
    friend_target_name: Optional[str] = None,
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
                    friend_target_id=friend_target_id,
                    friend_target_name=friend_target_name,
                ):
                    # Token-level LLM chunks (LangGraph stream_mode includes "messages")
                    if "__lg_messages__" in chunk:
                        pair = chunk["__lg_messages__"]
                        llm_chunk = pair[0] if isinstance(pair, tuple) and len(pair) >= 1 else pair
                        serialized = _serialize_message(llm_chunk)
                        if serialized is None:
                            continue
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

                            # Avoid sending the full assistant reply again after token streaming
                            # (LangGraph emits both "messages" tokens and an "updates" node completion).
                            # Apply for any graph node name — sub-agents may use steps other than "model".
                            if (
                                seen_token_stream
                                and serialized.get("type") in ("ai", "assistant")
                            ):
                                content = serialized.get("content", "")
                                has_text = isinstance(content, str) and bool(content.strip())
                                has_tools = bool(serialized.get("tool_calls"))
                                if has_tools and isinstance(content, str) and content.strip():
                                    serialized = {**serialized, "content": ""}
                                elif not has_tools and has_text:
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
    friend_target_id: Optional[str] = None,
    friend_target_name: Optional[str] = None,
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
        friend_target_id,
        friend_target_name,
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

    # If clipboard text is provided, append it to the message
    if clipboard_text:
        logging.info(f"Attaching clipboard content (len: {len(clipboard_text)}) to message")
        message = f"{message}\n\n[Clipboard Content]:\n{clipboard_text}"
    else:
        logging.info("No clipboard content attached")

    # 1. Ensure thread exists
    title = message[:30] + "..." if len(message) > 30 else message
    real_thread_id = await run_in_threadpool(create_thread, title, thread_id)

    # 2. Save User Message
    await run_in_threadpool(save_message, real_thread_id, "user", message, image_url)

    # 3. Stream and Save Assistant Message
    messages = [{"role": "user", "content": message, "image_url": image_url}]

    return StreamingResponse(
        _agent_stream_generator_with_save(
            messages,
            thread_id=real_thread_id,
            is_voice=is_voice,
            project_root=project_root,
            token=token,
            chat_mode=chat_mode,
            speed_mode=speed_mode,
            client_timezone=chat_message.client_timezone,
            client_local_datetime_iso=chat_message.client_local_datetime_iso,
            friend_target_id=friend_target_id,
            friend_target_name=friend_target_name,
        ),
        media_type="text/event-stream",
        headers=_SSE_CHAT_HEADERS,
    )


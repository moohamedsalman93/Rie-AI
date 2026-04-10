"""
API routes/endpoints
"""
import asyncio
import json
import queue
import threading
from typing import Any, Dict, Iterable, List, Optional, AsyncIterator
import logging

from fastapi import APIRouter, HTTPException, Query, File, UploadFile
from fastapi.responses import StreamingResponse

from app.models import (
    ChatMessage, HealthResponse, SettingsUpdate, SettingsResponse, 
    CancelRequest, SpeakRequest, ResumeChatRequest, HITLRequestModel,
    ScheduleTaskRequest, ScheduledTaskResponse, ScheduleNotificationItem,
    SubAgentConfig, PlannerGraphConfig, PlannerInstructionGenerateRequest, PlannerInstructionGenerateResponse,
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
)
from fastapi.concurrency import run_in_threadpool
import io
import base64

router = APIRouter()


def _get_runtime_tool_catalog_ids() -> set[str]:
    """Best-effort runtime tool ID catalog for validating planner assignments."""
    tool_ids: set[str] = {
        "internet_search",
        "schedule_chat_task",
        *WINDOWS_TOOLS.keys(),
        *[t.name for t in LTM_TOOLS],
        *[t.name for t in MCP_REGISTRY_TOOLS],
    }
    # External APIs configured by the user.
    for api in settings.EXTERNAL_APIS or []:
        name = str(api.get("name", "")).strip() if isinstance(api, dict) else ""
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
    agent_ready = False

    # Eagerly initialize the agent when the backend is probed for health.
    # This avoids the situation where the very first /chat/stream call in
    # a fresh process has to pay the full initialization cost (and may
    # appear to "do nothing" on the client) even though the health check
    # has already succeeded.
    try:
        if agent_manager.is_configured:
            agent_ready = await agent_manager.ensure_initialized()
    except Exception as e:
        logging.error(f"Agent initialization during health check failed: {e}")
        agent_ready = False

    return HealthResponse(
        message="Welcome to Rie BE Chat API",
        agent_configured=agent_ready,
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
    )





LTM_TOOL_NAMES = ["save_memory", "get_memory", "search_memory"]

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
) -> AsyncIterator[str]:
    """
    Wrap the Deep Agent `.stream()` generator into Server‑Sent Events (SSE) lines.

    Each yielded item is a single SSE event containing:
    - step: which node produced this update (e.g. "model", "tools")
    - message: serialized LangChain message (including tool_calls when present)
    """
    logger = logging.getLogger(__name__)
    logger.info(f"Stream generator started for thread_id={thread_id}")
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
                ):
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
                logger.error(f"Stream generator crashed: {e}", exc_info=True)
                # Attempt to yield error to client if possible
                err_payload = {"error": "Internal stream error", "details": str(e)}
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
        logger.error(f"Outer stream generator crashed: {e}", exc_info=True)
        err_payload = {"error": "Internal stream error", "details": str(e)}
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
        ),
        media_type="text/event-stream",
    )


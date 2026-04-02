"""
Deep Agent setup and configuration
"""
import asyncio
import logging
import os
import re
from itertools import cycle
from typing import Any, List, Optional, Iterator, AsyncIterator
from collections.abc import Generator


from langchain.agents import create_agent
from langchain_groq import ChatGroq
from langchain_google_vertexai import ChatVertexAI
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI
from langchain_ollama import ChatOllama
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.outputs import ChatResult, ChatGenerationChunk
from langchain.agents.middleware import TodoListMiddleware, SummarizationMiddleware, HumanInTheLoopMiddleware, InterruptOnConfig
from deepagents.middleware.subagents import SubAgentMiddleware
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.backends import FilesystemBackend
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from app.database import get_checkpoint_db_path

from app.config import settings
from app.tools import (
    internet_search,
)
from app.windows_tools import WINDOWS_TOOLS
from app.mcp_client import mcp_manager
from app.memory import memory_store
from app.ltm_tools import LTM_TOOLS, Context
from app.custom_tools import get_external_tools
from app.mcp_registry_tools import MCP_REGISTRY_TOOLS
from app.scheduler_tools import schedule_chat_task_tool
from app.runtime_context import set_agent_context, reset_agent_context


def _client_clock_system_content(
    client_timezone: Optional[str],
    client_local_datetime_iso: Optional[str],
) -> Optional[str]:
    """Ephemeral system text so the model uses the user's real local clock (scheduling, relative dates)."""
    if not client_timezone and not client_local_datetime_iso:
        return None
    parts = []
    if client_local_datetime_iso:
        parts.append(
            f"User device local date and time (authoritative 'now'): {client_local_datetime_iso}"
        )
    if client_timezone:
        parts.append(f"User device IANA timezone: {client_timezone}")
    parts.append(
        "Use this when interpreting relative dates (tomorrow, next Monday, etc.) and when calling "
        "schedule_chat_task; pass run_at_iso in ISO 8601 consistent with this timezone."
    )
    return "\n".join(parts)


# System prompt to steer the agent to be an expert researcher
SYSTEM_PROMPT = """
You are Rie, an autonomous AI assistant specialized in technical tasks.

Priorities: accuracy first, efficiency second.

Rules:
- Prefer verified information and reasoning over assumptions.
- Use tools when needed.
- If unsure or information is unavailable, say so clearly.
- Use the coding_specialist sub agent for any code-related tasks and do not use the your tool for coding tasks, like codebase analysis, code review, etc.
- Reminders and timed tasks inside Rie (anything that should appear in the app's "Scheduled" sidebar or notify through Rie): you MUST call the tool schedule_chat_task with run_at_iso in ISO 8601 and the correct intent. Do not use run_terminal_command, schtasks, PowerShell, or Windows Task Scheduler for user reminders — those will NOT register in Rie and the user will see "Nothing scheduled".
- Only tell the user you scheduled or set a reminder after schedule_chat_task returns successfully (or the tool output confirms it). Never invent a fake task name or claim a PowerShell popup was created for this.
- When a system message states the user's device local date and time, treat it as the true current moment for that conversation (do not assume a different year or day).

Style:
- Be friendly in general interactions; use emojis when appropriate 🙂
- Stay serious and precise for technical or critical tasks.
"""

SUBAGENT_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{2,64}$")


class RotatingChatGroq(BaseChatModel):
    """A wrapper for ChatGroq that rotates through multiple API keys to bypass rate limits."""
    api_keys: List[str]
    model_name: str
    temperature: float
    _key_cycle: Any = None

    def __init__(self, api_keys: List[str], model: str, temperature: float = 0, **kwargs: Any):
        # We need to call the Pydantic init properly
        super().__init__(api_keys=api_keys, model_name=model, temperature=temperature, **kwargs)
        # Store cycle in a private attribute using object.__setattr__ to bypass Pydantic validation if needed
        object.__setattr__(self, '_key_cycle', cycle(api_keys))

    def _get_model(self) -> ChatGroq:
        """Get a ChatGroq instance with the next API key in the cycle"""
        return ChatGroq(
            api_key=next(self._key_cycle),
            model=self.model_name,
            temperature=self.temperature
        )

    def bind_tools(self, tools: List[Any], **kwargs: Any) -> BaseChatModel:
        """Required for agents that use tools"""
        # Create a dummy ChatGroq to handle tool formatting correctly
        dummy = ChatGroq(
            api_key=self.api_keys[0],
            model=self.model_name,
            temperature=self.temperature
        )
        bound = dummy.bind_tools(tools, **kwargs)
        
        # Extract formatted tools and tool_choice from the RunnableBinding
        # We use getattr to safely access bound.kwargs if available
        new_kwargs = getattr(bound, "kwargs", {})
        
        # Groq API is picky about tool_choice: it only allows "none", "auto", or "required"
        # LangChain often converts specific tool names to a dict like {"type": "function", ...}
        # which Groq currently rejects with a 400 Bad Request error.
        if "tool_choice" in new_kwargs and isinstance(new_kwargs["tool_choice"], dict):
            # If a specific tool was requested (the dict case), we fallback to "required"
            # which is the closest allowed string value for Groq.
            new_kwargs["tool_choice"] = "required"

        return self.bind(**new_kwargs)

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return self._get_model()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return await self._get_model()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        yield from self._get_model()._stream(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        async for chunk in self._get_model()._astream(messages, stop=stop, run_manager=run_manager, **kwargs):
            yield chunk

    @property
    def _llm_type(self) -> str:
        return "rotating-groq"


class RotatingChatOpenAI(BaseChatModel):
    """A wrapper for ChatOpenAI that rotates through multiple API keys to bypass rate limits."""
    api_keys: List[str]
    model_name: str
    base_url: str
    temperature: float
    _key_cycle: Any = None

    def __init__(self, api_keys: List[str], model: str, base_url: str, temperature: float = 0.7, **kwargs: Any):
        super().__init__(api_keys=api_keys, model_name=model, base_url=base_url, temperature=temperature, **kwargs)
        object.__setattr__(self, '_key_cycle', cycle(api_keys))

    def _get_model(self) -> ChatOpenAI:
        """Get a ChatOpenAI instance with the next API key in the cycle"""
        return ChatOpenAI(
            openai_api_key=next(self._key_cycle),
            model_name=self.model_name,
            base_url=self.base_url,
            temperature=self.temperature
        )

    def bind_tools(self, tools: List[Any], **kwargs: Any) -> BaseChatModel:
        """Required for agents that use tools"""
        # Create a dummy ChatOpenAI to handle tool formatting correctly
        dummy = ChatOpenAI(
            openai_api_key=self.api_keys[0],
            model_name=self.model_name,
            base_url=self.base_url,
            temperature=self.temperature
        )
        bound = dummy.bind_tools(tools, **kwargs)
        
        # Extract formatted tools and tool_choice from the RunnableBinding
        new_kwargs = getattr(bound, "kwargs", {})
        
        return self.bind(**new_kwargs)

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return self._get_model()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        return await self._get_model()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        yield from self._get_model()._stream(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        async for chunk in self._get_model()._astream(messages, stop=stop, run_manager=run_manager, **kwargs):
            yield chunk

    @property
    def _llm_type(self) -> str:
        return "rotating-openai"


class AgentManager:
    """Manages the Deep Agent instance"""
    
    def __init__(self):
        self._agent: Optional[object] = None
        self._llm: Optional[object] = None
        self._current_stream: Optional[Generator] = None
        self._checkpointer: Optional[AsyncSqliteSaver] = None
        self._checkpointer_cm : Optional[Any] = None
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._store: Optional[Any] = None
        self._current_chat_mode: Optional[str] = None
        self._current_speed_mode: Optional[str] = None
    
    def _create_llm(self) -> Optional[BaseChatModel]:
        """Create and return a Groq LLM instance (potentially rotating)"""
        keys = settings.GROQ_API_KEYS
        if not keys:
            print("ERROR: No Groq API keys configured")
            return None
        
        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatGroq with {len(keys)} keys")
                llm = RotatingChatGroq(
                    api_keys=keys,
                    model=settings.GROQ_MODEL,
                    temperature=0,
                )
            else:
                # Fallback to standard ChatGroq for single key
                llm = ChatGroq(
                    api_key=keys[0],
                    model=settings.GROQ_MODEL,
                    temperature=0,
                )
            print(f"DEBUG: Groq LLM created successfully with model: {settings.GROQ_MODEL}")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Groq LLM: {e}")
            import traceback
            traceback.print_exc()
            return None

    def _create_gemini_llm(self) -> Optional[ChatGoogleGenerativeAI]:
        """Create and return a direct Gemini LLM instance (Generative AI API)"""
        if not settings.GOOGLE_API_KEY:
            print("ERROR: GOOGLE_API_KEY is not set")
            return None

        # Ensure the API key is in the environment
        import os

        if "GOOGLE_API_KEY" not in os.environ:
            os.environ["GOOGLE_API_KEY"] = settings.GOOGLE_API_KEY

        try:
            llm = ChatGoogleGenerativeAI(
                model="gemini-1.5-pro",
                temperature=0,
            )
            print("DEBUG: Gemini LLM (Generative AI API) created successfully")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Gemini LLM: {e}")
            return None

    def _create_vertex_llm(self) -> Optional[ChatVertexAI]:
        """Create and return a Vertex AI (Gemini) LLM instance"""
        if settings.VERTEX_CREDENTIALS_PATH:
             import os
             os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = settings.VERTEX_CREDENTIALS_PATH
             
        if not settings.VERTEX_PROJECT:
            print("ERROR: VERTEX_PROJECT is not set")
            # If credentials path is set, we might not strictly need project if it's in the key file,
            # but ChatVertexAI usually expects it or infers it.
            if not settings.VERTEX_CREDENTIALS_PATH:
                return None

        try:
            llm = ChatVertexAI(
                model=settings.VERTEX_MODEL,
                project=settings.VERTEX_PROJECT,
                location=settings.VERTEX_LOCATION,
                temperature=0,
            )
            print(
                f"DEBUG: Vertex AI LLM created successfully with model: {settings.VERTEX_MODEL}, "
                f"project: {settings.VERTEX_PROJECT}, location: {settings.VERTEX_LOCATION}"
            )
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Vertex AI LLM: {e}")
            return None

    def _create_openai_llm(self) -> Optional[BaseChatModel]:
        """Create and return an OpenAI LLM instance (compatible with Z.ai, potentially rotating)"""
        keys = settings.OPENAI_API_KEYS
        if not keys:
            print("ERROR: No OpenAI API keys configured")
            return None

        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatOpenAI with {len(keys)} keys")
                llm = RotatingChatOpenAI(
                    api_keys=keys,
                    model=settings.OPENAI_MODEL,
                    base_url=settings.OPENAI_BASE_URL,
                    temperature=0.7,
                )
            else:
                llm = ChatOpenAI(
                    model_name=settings.OPENAI_MODEL,
                    openai_api_key=keys[0],
                    base_url=settings.OPENAI_BASE_URL,
                    temperature=0.7,
                )
            print(f"DEBUG: OpenAI LLM created successfully with model: {settings.OPENAI_MODEL} and base_url: {settings.OPENAI_BASE_URL}")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create OpenAI LLM: {e}")
            return None

    def _create_rie_llm(self) -> Optional[BaseChatModel]:
        """Create and return a Rie LLM instance (OpenAI compatible)"""
        # Rie is hardcoded - no API key validation needed
        try:
            llm = ChatOpenAI(
                model_name=settings.RIE_MODEL,
                openai_api_key=settings.RIE_ACCESS_TOKEN,
                base_url=settings.RIE_API_URL,
                temperature=0.7,
            )
            print(f"DEBUG: Rie LLM created successfully with model: {settings.RIE_MODEL} at {settings.RIE_API_URL}")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Rie LLM: {e}")
            return None

    def _create_ollama_llm(self) -> Optional[BaseChatModel]:
        """Create and return an Ollama LLM instance (via OpenAI-compatible bridge for stability)"""
        if not settings.OLLAMA_MODEL:
            print("ERROR: No Ollama model selected")
            return None
        try:
            # We use ChatOpenAI because it handles tool calling and streaming 
            # more robustly with Ollama's /v1 endpoint than ChatOllama's native API.
            api_key = settings.OLLAMA_API_KEY or "ollama"
            llm = ChatOpenAI(
                model_name=settings.OLLAMA_MODEL,
                openai_api_key=api_key,
                base_url=f"{settings.OLLAMA_API_URL.rstrip('/')}/v1",
                temperature=0.7,
            )
            print(f"DEBUG: Ollama LLM created successfully using OpenAI bridge with model: {settings.OLLAMA_MODEL} at {settings.OLLAMA_API_URL}/v1")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Ollama LLM: {e}")
            return None

    def dynamic_backend(self, runtime):
        """Factory used by FilesystemMiddleware to resolve paths at runtime."""
        # Access the config through the context attribute
        # In many versions of the SDK, config is stored inside the context
        config = getattr(runtime, "config", getattr(runtime, "context", {}))
        
        # Retrieve the configurable dict
        # Note: Depending on your specific version, it might be in runtime.context
        # or you can try runtime.context.get("config", {})
        configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    
        project_root = configurable.get(
            "project_root", 
            "D:/professional/code/reactjs/reactjs/vms" # Default fallback
        )
    
        return FilesystemBackend(root_dir=project_root, virtual_mode=True)

    def _default_subagents_config(self) -> list[dict]:
        return [
            {
                "name": "coding_specialist",
                "description": "Expert at modifying and understanding code in the local filesystem.",
                "system_prompt": "You are a coding specialist. You have direct access to the files.",
                "tool_ids": [],
                "enabled": True,
            },
            {
                "name": "mcp_registry",
                "description": "Expert at managing MCP server connections and registry. Use this to add, update, list, or delete MCP servers.",
                "system_prompt": "You are an MCP registry specialist. You can list, add, update, and delete MCP server configurations. Use your tools to manage the external capabilities of the Rie agent.",
                "tool_ids": [],
                "enabled": True,
            },
        ]

    def _build_subagents(
        self,
        all_tools_map: dict[str, Any],
    ) -> list[dict[str, Any]]:
        raw_subagents = settings.SUBAGENTS_CONFIG or self._default_subagents_config()
        built_subagents: list[dict[str, Any]] = []
        seen_names: set[str] = set()

        for item in raw_subagents:
            if not isinstance(item, dict):
                continue

            name = str(item.get("name", "")).strip()
            if not name or not SUBAGENT_NAME_PATTERN.match(name):
                logging.warning("Skipping sub-agent with invalid name: %s", name)
                continue
            lowered = name.lower()
            if lowered in seen_names:
                logging.warning("Skipping duplicate sub-agent name: %s", name)
                continue
            seen_names.add(lowered)

            if not bool(item.get("enabled", True)):
                continue

            description = str(item.get("description", "")).strip() or f"{name} sub-agent"
            system_prompt = str(item.get("system_prompt", "")).strip()
            if not system_prompt:
                logging.warning("Skipping sub-agent '%s' with empty system_prompt", name)
                continue

            configured_tool_ids = item.get("tool_ids", [])
            if not isinstance(configured_tool_ids, list):
                configured_tool_ids = []

            resolved_tools = []
            for tool_id in configured_tool_ids:
                if not isinstance(tool_id, str):
                    continue
                tool = all_tools_map.get(tool_id)
                if tool is None:
                    logging.warning("Sub-agent '%s' references unavailable tool '%s'", name, tool_id)
                    continue
                resolved_tools.append(tool)

            subagent_middleware = []
            if name == "coding_specialist":
                subagent_middleware.append(FilesystemMiddleware(backend=self.dynamic_backend))

            built_subagents.append(
                {
                    "name": name,
                    "description": description,
                    "system_prompt": system_prompt,
                    "model": self._llm,
                    "tools": resolved_tools,
                    "middleware": subagent_middleware,
                }
            )

        return built_subagents


    async def _initialize_agent_async(self, chat_mode: Optional[str] = None, speed_mode: Optional[str] = None) -> None:
        """Initialize the Deep Agent if API keys are configured (Async)"""
        
        # Initialize AsyncSqliteSaver for persistence across restarts
        if not self._checkpointer:
            # Monkeypatch aiosqlite Connection to add missing is_alive method
            # This is a workaround for a compatibility issue with aiosqlite 0.22.0+
            import aiosqlite
            if not hasattr(aiosqlite.Connection, "is_alive"):
                def is_alive(self):
                    return True
                aiosqlite.Connection.is_alive = is_alive

            self._checkpointer_cm = AsyncSqliteSaver.from_conn_string(get_checkpoint_db_path())
            self._checkpointer = await self._checkpointer_cm.__aenter__()

        # Initialize LTM Store
        if not self._store:
            self._store = await memory_store.get_store()

        # LangSmith Tracing Configuration
        if settings.LANGSMITH_TRACING and settings.LANGSMITH_API_KEY:
            print("DEBUG: Enabling LangSmith tracing")
            os.environ["LANGCHAIN_TRACING_V2"] = "true"
            os.environ["LANGCHAIN_API_KEY"] = settings.LANGSMITH_API_KEY
            os.environ["LANGCHAIN_PROJECT"] = settings.LANGSMITH_PROJECT
            os.environ["LANGCHAIN_ENDPOINT"] = settings.LANGSMITH_ENDPOINT
        else:
            # Explicitly disable if not configured to prevent accidental tracing
            os.environ["LANGCHAIN_TRACING_V2"] = "false"

        # Define baseline available tools
        all_tools_map = {
            "internet_search": internet_search,
            "schedule_chat_task": schedule_chat_task_tool,
            **WINDOWS_TOOLS,
            **{t.name: t for t in LTM_TOOLS},
            **{t.name: t for t in MCP_REGISTRY_TOOLS},
        }
        loaded_mcp_tools: list[Any] = []
        loaded_external_tools: list[Any] = []

        # Resolve effective modes early (used by prompt construction and tool policy).
        effective_chat_mode = chat_mode or "agent"
        effective_speed_mode = speed_mode or "thinking"
        orchestration_mode = settings.AGENT_ORCHESTRATION_MODE
        self._current_chat_mode = effective_chat_mode
        self._current_speed_mode = effective_speed_mode


        # Select LLM based on provider setting
        provider = settings.LLM_PROVIDER
        
        # Auto-detect if not set (backward compatibility)
        # Rie is always available and is the default
        if not provider:
            provider = "rie"  # Default to Rie (hardcoded, always available)
            # Fallback to other providers if explicitly needed
            if settings.GROQ_API_KEY:
                provider = "groq"
            elif settings.VERTEX_PROJECT:
                provider = "vertex"
            elif settings.GOOGLE_API_KEY:
                provider = "gemini"
            elif settings.OPENAI_API_KEY:
                provider = "openai"
        
        print(f"DEBUG: Selected LLM Provider: {provider}")

        # Build context-aware system prompt
        mode_instructions = ""
        if effective_chat_mode == "chat":
            mode_instructions += "\n- CURRENT MODE: Chat Mode. You are acting as a conversational assistant. Keep answers concise. Do not attempt complex multi-step technical workflows unless requested."
        else:
            mode_instructions += "\n- CURRENT MODE: Agent Mode. You are acting as an autonomous technical agent. Use your tools extensively to accomplish the user's goal."
            
        if effective_speed_mode == "flash":
            mode_instructions += "\n- SPEED: Flash. Provide immediate answers. Do not output internal thinking or plans."
        else:
            mode_instructions += "\n- SPEED: Thinking. Please think step-by-step and write down your plan before executing."

        planner_graph = settings.SUBAGENT_PLANNER_GRAPH or {}
        planner_main_instruction = str(planner_graph.get("main_instruction", "")).strip()
        planner_main_section = ""
        if planner_main_instruction:
            planner_main_section = (
                "\n\n[Planner Main Instruction]\n"
                f"{planner_main_instruction}\n"
                "[End Planner Main Instruction]"
            )

        final_system_prompt = SYSTEM_PROMPT + mode_instructions + planner_main_section

        if provider == "vertex":
            self._llm = self._create_vertex_llm()
            system_prompt = final_system_prompt
        elif provider == "gemini":
            self._llm = self._create_gemini_llm()
            system_prompt = final_system_prompt
        elif provider == "groq":
            self._llm = self._create_llm()
            system_prompt = final_system_prompt
        elif provider == "openai":
            self._llm = self._create_openai_llm()
            system_prompt = final_system_prompt
        elif provider == "rie":
            self._llm = self._create_rie_llm()
            system_prompt = final_system_prompt
        elif provider == "ollama":
            self._llm = self._create_ollama_llm()
            system_prompt = final_system_prompt
        else:
            print("ERROR: No valid LLM provider selected or configured.")
            self._agent = None
            return

        if not self._llm:
            print(f"ERROR: Failed to create LLM for provider {provider}")
            self._agent = None
            return

        # Load MCP Tools
        try:
            loaded_mcp_tools = await mcp_manager.refresh_tools()
            print(f"DEBUG: Integrated {len(loaded_mcp_tools)} MCP tools")
        except Exception as e:
            print(f"ERROR: Failed to load MCP tools: {e}")

        # Load Custom External Tools
        try:
            loaded_external_tools = get_external_tools(settings.EXTERNAL_APIS) or []
            if loaded_external_tools:
                print(f"DEBUG: Integrated {len(loaded_external_tools)} external tools")
        except Exception as e:
            print(f"ERROR: Failed to load external tools: {e}")

        for tool in loaded_mcp_tools + loaded_external_tools:
            tool_name = getattr(tool, "name", None)
            if tool_name:
                all_tools_map[tool_name] = tool

        def _resolve_tools_from_ids(tool_ids: list[str]) -> list[Any]:
            resolved: list[Any] = []
            seen: set[str] = set()
            for tool_id in tool_ids:
                if not isinstance(tool_id, str):
                    continue
                normalized = tool_id.strip()
                if not normalized or normalized in seen:
                    continue
                tool = all_tools_map.get(normalized)
                if tool is None:
                    continue
                seen.add(normalized)
                resolved.append(tool)
            return resolved

        # Filter tools based on chat_mode + orchestration mode.
        if effective_chat_mode == "chat":
            # Chat mode: internet_search + LTM + scheduling (reminders / timed tasks)
            tools_to_use = []
            if "internet_search" in all_tools_map:
                tools_to_use.append(all_tools_map["internet_search"])
            if "schedule_chat_task" in all_tools_map:
                tools_to_use.append(all_tools_map["schedule_chat_task"])
            tools_to_use.extend(LTM_TOOLS)
            print(f"DEBUG: Chat mode active - using limited tools: {[getattr(t, 'name', getattr(t, '__name__', str(t))) for t in tools_to_use]}")
        elif orchestration_mode == "team":
            planner_graph = settings.SUBAGENT_PLANNER_GRAPH or {}
            main_tool_ids = planner_graph.get("main_tool_ids") if isinstance(planner_graph, dict) else []
            if not isinstance(main_tool_ids, list):
                main_tool_ids = []
            tools_to_use = _resolve_tools_from_ids(main_tool_ids)
        else:
            # Solo mode: full catalog by default, with user-controlled disable list.
            enabled_tool_names = settings.ENABLED_TOOLS
            if enabled_tool_names is None:
                tools_to_use = list(all_tools_map.values())
            else:
                tools_to_use = _resolve_tools_from_ids(enabled_tool_names)

        print(
            "DEBUG: Initializing agent with orchestration_mode=%s and tools=%s"
            % (
                orchestration_mode,
                [getattr(t, "name", getattr(t, "__name__", str(t))) for t in tools_to_use],
            )
        )

        try:
            print(f"DEBUG: Creating deep agent with {provider}...")

            # Core middleware stack
            middleware_stack = []
            
            # Only add TodoListMiddleware in thinking mode (skip for flash)
            if effective_speed_mode != "flash":
                middleware_stack.append(
                    TodoListMiddleware(
                        system_prompt="Use the write_todos tool to plan your tasks"
                    )
                )
                print(f"DEBUG: Thinking mode - TodoListMiddleware enabled")
            else:
                print(f"DEBUG: Flash mode - TodoListMiddleware skipped")
            
            # Only add SubAgentMiddleware in agent mode
            if effective_chat_mode != "chat" and orchestration_mode == "team":
                subagents = self._build_subagents(
                    all_tools_map=all_tools_map,
                )
                middleware_stack.append(
                    SubAgentMiddleware(
                        default_model=self._llm,
                        default_tools=tools_to_use,
                        subagents=subagents,
                    )
                )
            
            middleware_stack.append(
                SummarizationMiddleware(
                    # Use a small model like gpt-4o-mini or haiku for the summary
                    model=self._llm,
                    trigger=("tokens", 8000),
                    keep=("messages", 20),
                    summary_prompt="""Summarize the conversation history. 
                            1. EXPLICITLY preserve all file paths (e.g., /src/main.py).
                            2. EXPLICITLY preserve class names and function names.
                            3. Maintain a bulleted list of 'Tasks Completed' and 'Remaining Work'.
                            4. Do not include actual code blocks in the summary, just describe what was modified.
                            
                            Messages to summarize:
                            {messages}"""
                )
            )

            # Optionally add Human‑in‑the‑Loop middleware based on settings
            from app.config import settings as _settings
            if _settings.HITL_ENABLED:
                # Only require human approval for terminal commands.
                # Other tools (app control, mouse/keyboard, etc.) will run without HITL prompts.
                middleware_stack.append(
                    HumanInTheLoopMiddleware(
                        interrupt_on={
                            "run_terminal_command": True,
                        }
                    )
                )

            self._agent = create_agent(
                model=self._llm,
                tools=tools_to_use,
                system_prompt=system_prompt,
                debug=True,
                checkpointer=self._checkpointer,
                store=self._store,
                context_schema=Context,
                middleware=middleware_stack,
            )
            print(f"DEBUG: Deep agent created successfully with {provider}")
        except Exception as e:
            print(f"ERROR: Failed to initialize agent with {provider}: {e}")
            import traceback
            traceback.print_exc()
            self._agent = None
            self._llm = None



    
    @property
    def agent(self):
        """Get the agent instance"""
        return self._agent
    
    @property
    def is_configured(self) -> bool:
        """Check if agent can be configured (required keys are present)"""
        configured = settings.has_llm_api_key
        print(f"DEBUG: agent_manager.is_configured check: {configured}")
        print(f"DEBUG: settings keys: {settings.GROQ_API_KEYS}")
        return configured

    async def ensure_initialized(self) -> bool:
        """
        Ensure the underlying agent is initialized if configuration allows.

        This is safe to call multiple times and is intended for use by
        lightweight endpoints (like health checks) that want to "warm up"
        the agent so that the first chat request in a fresh process does
        not pay the full initialization cost or fail unexpectedly.

        Returns True when an agent instance is available; False otherwise.
        """
        # Fast path: already initialized
        if self._agent is not None:
            return True

        # If we don't even have the necessary configuration, do not attempt
        # a full init here – callers can still inspect is_configured.
        if not self.is_configured:
            return False

        # Attempt initialization; any internal failures are handled by the
        # existing _initialize_agent_async logic.
        await self._initialize_agent_async()
        return self._agent is not None
    
    async def get_pending_interrupt(self, thread_id: str) -> Optional[dict]:
        """Fetch pending interrupt for a thread if it exists"""
        if not self._agent:
            await self._initialize_agent_async()
            if not self._agent:
                return None
        
        config = {"configurable": {"thread_id": thread_id}}
        state = await self._agent.aget_state(config)
        
        # Check task for interrupts (LangGraph standard way)
        if state.tasks:
            for task in state.tasks:
                if task.interrupts:
                    # Return the first interrupt data
                    # LangChain HITL middleware puts HITLRequest here
                    return task.interrupts[0].value
        return None

    async def generate_planner_instruction(
        self,
        boss_name: str,
        member_name: str,
        member_description: str,
        selected_tools: Optional[list[str]] = None,
        style: Optional[str] = None,
        tone: Optional[str] = None,
    ) -> str:
        """Generate member instruction text for planner using the configured LLM."""
        if not self._llm:
            await self._initialize_agent_async(chat_mode="agent", speed_mode="thinking")
        if not self._llm:
            raise RuntimeError("LLM is not initialized. Please verify provider settings.")

        tools_text = ", ".join(selected_tools or []) or "No specific tools assigned"
        style_text = style.strip() if style else "clear and practical"
        tone_text = tone.strip() if tone else "professional"

        system_text = (
            "You write instruction prompts for AI team members. "
            "Return plain text only. Do not use markdown fences. "
            "Keep it specific, actionable, and under 1400 characters."
        )
        user_text = (
            f"Boss name: {boss_name.strip() or 'Boss'}\n"
            f"Member name: {member_name.strip()}\n"
            f"Member description: {member_description.strip() or 'N/A'}\n"
            f"Assigned tools: {tools_text}\n"
            f"Style: {style_text}\n"
            f"Tone: {tone_text}\n\n"
            "Write a final instruction prompt the member should follow."
        )

        response = await self._llm.ainvoke(
            [
                SystemMessage(content=system_text),
                HumanMessage(content=user_text),
            ]
        )
        content = getattr(response, "content", "")
        if isinstance(content, list):
            text_parts = [part.get("text", "") for part in content if isinstance(part, dict)]
            content = "\n".join([p for p in text_parts if p])
        instruction = (content or "").strip()
        if not instruction:
            raise RuntimeError("Model returned empty instruction.")
        return instruction[:1400]

    async def invoke(
        self,
        messages: Optional[list] = None,
        thread_id: Optional[str] = None,
        project_root: Optional[str] = None,
        token: Optional[str] = None,
        decisions: Optional[list] = None,
        chat_mode: Optional[str] = None,
        speed_mode: Optional[str] = None,
        client_timezone: Optional[str] = None,
        client_local_datetime_iso: Optional[str] = None,
    ) -> dict:
        """
        Invoke the agent (Async)
        """
        # Check if modes changed and re-initialize if needed
        effective_chat_mode = chat_mode or "agent"
        effective_speed_mode = speed_mode or "thinking"
        if (self._agent is None or 
            self._current_chat_mode != effective_chat_mode or 
            self._current_speed_mode != effective_speed_mode):
            self._agent = None
            await self._initialize_agent_async(chat_mode=chat_mode, speed_mode=speed_mode)
            if not self._agent:
                raise RuntimeError(
                    "Agent not configured. Please check your API keys and try again."
                )

        config = {"configurable": {}}
        if thread_id:
            config["configurable"]["thread_id"] = thread_id
        if project_root:
            config["configurable"]["project_root"] = project_root
        
        user_id = "default_user" 
        context = Context(user_id=user_id)

        input_data = None
        if decisions is not None:
            input_data = Command(resume={"decisions": decisions})
        elif messages is not None:
            clock = _client_clock_system_content(client_timezone, client_local_datetime_iso)
            if clock:
                input_data = {"messages": [{"role": "system", "content": clock}, *messages]}
            else:
                input_data = {"messages": messages}

        tokens = set_agent_context(thread_id, effective_chat_mode, effective_speed_mode)
        try:
            return await self._agent.ainvoke(input_data, config=config, context=context)
        finally:
            reset_agent_context(tokens)

    async def stream(
        self,
        messages: Optional[list] = None,
        thread_id: Optional[str] = None,
        is_voice: bool = False,
        project_root: Optional[str] = None,
        token: Optional[str] = None,
        decisions: Optional[list] = None,
        chat_mode: Optional[str] = None,
        speed_mode: Optional[str] = None,
        client_timezone: Optional[str] = None,
        client_local_datetime_iso: Optional[str] = None,
    ) -> AsyncIterator[dict]:
        """Stream the agent with messages or resume with decisions (Async/thread-aware)."""
        # Check if modes changed and re-initialize if needed
        effective_chat_mode = chat_mode or "agent"
        effective_speed_mode = speed_mode or "thinking"
        if (self._agent is None or 
            self._current_chat_mode != effective_chat_mode or 
            self._current_speed_mode != effective_speed_mode):
            self._agent = None
            await self._initialize_agent_async(chat_mode=chat_mode, speed_mode=speed_mode)
            if not self._agent:
                raise RuntimeError(
                    "Agent not configured. Please check your API keys and try again."
                )

        provider = settings.LLM_PROVIDER or "rie"
        if provider == "rie":
             # Ensure key is present if provider is Rie
              if not settings.RIE_ACCESS_TOKEN:
                 raise RuntimeError("Rie login required. Please sign in via the Settings page to use this provider.")
        elif provider == "ollama":
             # Ensure model is selected
             if not settings.OLLAMA_MODEL:
                 raise RuntimeError("Ollama model required. Please select a model in the Settings page.")

        # Handle multi-modal content and inject voice-specific instructions
        processed_messages = []
        
        input_data = None
        if decisions is not None:
             input_data = Command(resume={"decisions": decisions})
        elif messages is not None:
            clock_content = _client_clock_system_content(client_timezone, client_local_datetime_iso)
            if clock_content:
                processed_messages.append({"role": "system", "content": clock_content})
            if is_voice:
                # Inject hidden instructions for human-like voice response
                processed_messages.append({
                    "role": "system", 
                    "content": "You are responding via voice. Use natural human fillers like 'hmm', 'uh', 'well', and expressive punctuation like '!' and '?' to sound more conversational. Keep responses relatively concise and engaging. Do not use markdown like bold or code blocks unless requested."
                })

            for msg in messages:
                if isinstance(msg, dict) and msg.get("image_url") and msg.get("role") == "user":
                    content = [
                        {"type": "text", "text": msg.get("content", "")},
                        {
                            "type": "image_url",
                            "image_url": {"url": msg.get("image_url")}
                        }
                    ]
                    processed_messages.append({"role": "user", "content": content})
                elif isinstance(msg, dict):
                    # Sanitize: only include 'role' and 'content' for text messages
                    role = msg.get("role", "user")
                    content = msg.get("content", "")
                    processed_messages.append({"role": role, "content": content})
                else:
                    processed_messages.append(msg)
            input_data = {"messages": processed_messages}

        config = {"configurable": {}}
        if thread_id:
            config["configurable"]["thread_id"] = thread_id
        if project_root:
            config["configurable"]["project_root"] = project_root

        logger = logging.getLogger(__name__)
        
        # Skip expensive state fetch in flash mode (queries 50MB+ checkpoint DB)
        if thread_id and self._current_speed_mode != "flash" and logger.isEnabledFor(logging.DEBUG):
            try:
                state = await self._agent.aget_state(config)
                logger.debug(f"Resuming thread_id={thread_id}. State messages: {len(state.values.get('messages', [])) if state.values else 0}")
                if state.next:
                    logger.debug(f"Thread interrupted at: {state.next}")
            except Exception as e:
                logger.debug(f"Could not fetch initial state for thread_id={thread_id}: {e}")

        # Determine user_id
        user_id = "default_user"
        context = Context(user_id=user_id)

        if config:
            stream_gen = self._agent.astream(
                input_data,
                config=config,
                context=context,
                stream_mode="updates",
            )
        else:
            stream_gen = self._agent.astream(
                input_data,
                context=context,
                stream_mode="updates",
            )

        # Track this stream if a thread_id is provided
        current_task = asyncio.current_task()
        if thread_id and current_task:
            self._active_tasks[thread_id] = current_task
            logger.info(f"Registered task for thread_id={thread_id}")

        tokens = set_agent_context(thread_id, effective_chat_mode, effective_speed_mode)
        try:
            async for chunk in stream_gen:
                logger.debug(f"Agent stream chunk keys: {list(chunk.keys())}")
                if "__interrupt__" in chunk:
                    logger.debug(f"Chunk contains interrupt: {chunk['__interrupt__']}")
                yield chunk
        except asyncio.CancelledError:
            logger.info(f"Stream for thread_id={thread_id} was cancelled")
            raise
        except Exception as e:
            logger.error(f"Error in agent stream: {e}", exc_info=True)
            raise
        finally:
            if thread_id in self._active_tasks:
                del self._active_tasks[thread_id]
                logger.debug(f"De-registered task for thread_id={thread_id}")
            reset_agent_context(tokens)

    async def cancel_run(self, thread_id: str) -> bool:
        """Cancel an active agent run for a specific thread_id"""
        task = self._active_tasks.get(thread_id)
        if task and not task.done():
            task.cancel()
            logging.getLogger(__name__).info(f"Requested cancellation for thread_id={thread_id}")
            return True
        return False
# Global agent manager instance
agent_manager = AgentManager()

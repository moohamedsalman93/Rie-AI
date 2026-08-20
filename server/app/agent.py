"""
Deep Agent setup and configuration
"""
import asyncio
import logging
import os
import re
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, List, Optional, Iterator, AsyncIterator, Annotated, Callable, Awaitable, Generator

import httpx
from openai import APIConnectionError
from pydantic import BaseModel, Field

from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage, ToolMessage
from langchain_core.outputs import ChatResult, ChatGenerationChunk
from langchain.agents.middleware import (
    TodoListMiddleware,
    SummarizationMiddleware,
    HumanInTheLoopMiddleware,
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
    ToolCallRequest,
)
from langchain.tools import tool, ToolRuntime
from langchain_core.tools import InjectedToolArg
from deepagents.middleware.subagents import SubAgentMiddleware
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.backends import FilesystemBackend
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from app.database import get_checkpoint_db_path

from app.config import settings
from app.tools import (
    internet_search,
    ask_question,
)
from app.windows_tools import WINDOWS_TOOLS
from app.mcp_client import mcp_manager
from app.plugin_manager import plugin_manager
from app.memory import memory_store
from app.ltm_tools import LTM_TOOLS, Context
from app.custom_tools import get_external_tools
from app.mcp_registry_tools import MCP_REGISTRY_TOOLS
from app.scheduler_tools import schedule_chat_task_tool
from app.remote_friend_tools import remote_friend_ask_tool
from app.browser import LANGGRAPH_BROWSER_TOOLS, browser_service, InteractionMode
from app.runtime_context import set_agent_context, reset_agent_context
from app.knowledge import read_knowledge_asset
from app.trajectory import trajectory_store, TaskEvent
from app.error_classifier import classify_tool_error, ErrorCategory
from app.hitl import hitl_manager, ActionRiskLevel
from app.capability_resolver import capability_resolver, capability_catalog, CapabilitySource
from app.batched_executor import execute_batched_plan, batched_tool_registry



# ---------------------------------------------------------------------------
# Thread-safe API key rotator with usage tracking
# ---------------------------------------------------------------------------

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
        self._usage: dict[int, dict] = {
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

    def next_key(self) -> tuple[str, int]:
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

    def stats(self) -> list[dict]:
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

    def __repr__(self) -> str:
        return f"KeyRotator(provider={self._provider!r}, keys={self.total_keys})"


def _client_device_system_content(
    client_timezone: Optional[str],
    client_local_datetime_iso: Optional[str],
    client_latitude: Optional[float] = None,
    client_longitude: Optional[float] = None,
    client_location_accuracy_m: Optional[float] = None,
) -> Optional[str]:
    """Ephemeral system text: local clock and/or GPS for scheduling and location-aware answers."""
    parts: list[str] = []
    if client_local_datetime_iso:
        parts.append(
            f"User device local date and time (authoritative 'now'): {client_local_datetime_iso}"
        )
    if client_timezone:
        parts.append(f"User device IANA timezone: {client_timezone}")
    if client_timezone or client_local_datetime_iso:
        parts.append(
            "Use this when interpreting relative dates (tomorrow, next Monday, etc.) and when calling "
            "schedule_chat_task; pass run_at_iso in ISO 8601 consistent with this timezone."
        )
    if client_latitude is not None and client_longitude is not None:
        loc = (
            f"User approximate geographic position (WGS84): "
            f"latitude {client_latitude:.6f}, longitude {client_longitude:.6f}"
        )
        if client_location_accuracy_m is not None:
            loc += f" (accuracy ~{int(client_location_accuracy_m)} m)"
        parts.append(loc)
        parts.append(
            "Use for nearby places, local weather, travel context, and 'where am I' questions. "
            "Do not share exact coordinates with other people unless the user explicitly asks."
        )
    if not parts:
        return None
    return "\n".join(parts)


# System prompt definitions: Base conversational prompt vs technical execution rules
BASE_SYSTEM_PROMPT = """
You are Rie, an autonomous AI assistant specialized in technical tasks and conversation.

Priorities: accuracy and adherence to specific instructions first, direct efficient execution second.

Core Rules:
- Prefer verified information and reasoning over assumptions.
- Long-Term Memory (LTM):
  * Proactive Context: Relevant user facts, preferences, and background are automatically recalled from memory by middleware and injected into your system prompt under "Recalled Long-Term Memories (Proactive Context)". When relevant user facts are already present there, use them directly in your answer. Do NOT call `search_memory` for information that is already provided in the system prompt.
  * Storing Memory: Whenever the user shares new personal details (e.g. their name, preferences, background, or explicitly asks you to remember something), invoke `save_memory` to persist it across conversations.
  * Explicit Retrieval: Invoke `search_memory` or `get_memory` ONLY when the required context is not already present in the proactive memory section, is insufficient, or when the user explicitly asks to search their past conversation records or notes.
- Select and invoke the most specific and efficient tools for the task rather than chaining generic tools or writing scripts needlessly.
- Parallel Execution: When multiple independent information-gathering or tool actions are needed, invoke all relevant tools in parallel within a single turn rather than executing them one-by-one sequentially.
- When a system message states the user's device local date and time, treat it as the true current moment for that conversation.

Style:
- Be friendly in general interactions; use emojis when appropriate 🙂
- Stay serious and precise for technical or critical tasks.
"""

DOMAIN_RULES: dict[str, str] = {
    "email": (
        "- Connected Integration Plugins: Prioritize native plugin tools (`gmail_*`) for reading, searching, drafting, replying, or sending emails.\n"
        "- Email Body Formatting: When displaying email body text or email content to the user, render it as normal plain text paragraphs and bullet points. Do NOT wrap email body text inside code blocks or backticks."
    ),
    "system": (
        "- When executing terminal commands on Windows, you MUST write correct and native Windows/PowerShell commands (e.g. Get-Content/type, New-Item/echo, Remove-Item, Copy-Item, Move-Item, and backslashes for file paths).\n"
        "- NEVER wrap PowerShell commands inside `powershell -Command \"...\"`. Always run commands directly as bare statements. If complex, write to a temp .ps1 script and execute with `& \"$env:TEMP\\script.ps1\"`.\n"
        "- When running a script file (.py, .sh, .bash), use run_terminal_command with the appropriate interpreter (Python via `python \"path\\to\\script.py\"`; shell via `bash \"path/to/script.sh\"`)."
    ),
    "desktop": (
        "- Desktop & App Automation: When interacting with desktop windows and apps, prioritize app_control and desktop state inspection before sending mouse/keyboard events.\n"
        "- Only use `use_vision=True` when standard textual state info is insufficient or for complex UI interactions."
    ),
    "browser": (
        "- Web & Browser Tasks: When performing web browsing, page navigation, web searching, or web interactions, prioritize browser tools (`browser_*`) over desktop GUI tools."
    ),
    "search": (
        "- When the user asks for an image, photo, picture, or wallpaper: call internet_search with include_images=True, then show results inline using markdown images `![short description](direct_image_url)` from the search images field."
    ),
    "scheduler": (
        "- Reminders and timed tasks inside Rie: you MUST call the tool schedule_chat_task with run_at_iso in ISO 8601 and the correct intent. Only tell the user after schedule_chat_task returns successfully."
    ),
    "mcp": (
        "- MCP Registry: Use MCP registry tools (`list_mcp_servers`, `add_mcp_server`, `update_mcp_server`, `delete_mcp_server`) to configure and manage external MCP server configurations."
    ),
    "github": (
        "- GitHub Integration: Use `github_*` tools directly for managing repositories, issues, and pull requests."
    ),
    "jira": (
        "- Jira Integration: Use `jira_*` tools directly for tracking sprints, stories, epics, and issues."
    ),
    "question": (
        "- Interactive Questions & Clarifications: Whenever you need user preferences, choices (e.g. tailoring options, configuration choices, technology stack preferences), or clarifying answers before proceeding, ALWAYS invoke the `ask_question` tool. Pass selectable options in `options` or a list of questions in `questions`. Do NOT ask multiple choice questions in raw plain text when you can use `ask_question`."
    ),
    "skills": (
        "- Skills & Specialized Domain Knowledge: You have access to specialized procedural skills in your library. "
        "When a task requires specialized domain guidelines or procedures from your Available Skills list, invoke `load_skill` with the exact skill name to load the complete instructions."
    ),
}

TECHNICAL_RULES_PROMPT = "Technical & Tool Execution Rules:\n" + "\n\n".join(DOMAIN_RULES.values())

SYSTEM_PROMPT = BASE_SYSTEM_PROMPT.strip() + "\n\n" + TECHNICAL_RULES_PROMPT.strip()

SUBAGENT_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{2,64}$")


def _is_rate_limit_or_recoverable_error(e: Exception) -> bool:
    """Check if an exception is due to rate limits, quota limits, or temporary upstream failures."""
    err_str = str(e).lower()
    type_str = type(e).__name__.lower()
    recoverable_terms = [
        "429", "rate_limit", "ratelimit", "rate limit", "resourceexhausted", "resource_exhausted",
        "resource exhausted", "quota", "too many requests", "overloaded", "503", "service unavailable",
        "high demand", "temporarily unavailable", "deadline_exceeded", "504", "exceeded",
        "gateway timeout", "internal server error", "500", "try again"
    ]
    return any(term in err_str or term in type_str for term in recoverable_terms)


def _dispatch_stream_payload(payload: dict) -> None:
    try:
        from app.runtime_context import get_current_thread_id
        from app.terminal_stream import streamer
        import json
        thread_id = get_current_thread_id()
        msg = json.dumps(payload)

        queues = [streamer.get_queue(thread_id)] if (thread_id and thread_id in streamer.queues) else list(streamer.queues.values())
        if not queues and thread_id:
            queues = [streamer.get_queue(thread_id)]

        for q in queues:
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(q.put(msg))
            except RuntimeError:
                try:
                    q.put_nowait(msg)
                except Exception:
                    pass
    except Exception as e:
        _logger.warning("Failed to dispatch stream payload: %s", e)


def _emit_retry_event(provider: str, next_key_idx: int, total_keys: int, exc: Exception):
    """Notify the frontend stream that key rotation / retry is occurring."""
    payload = {
        "step": "key_retry",
        "provider": provider,
        "key_index": next_key_idx + 1,
        "total_keys": total_keys,
        "message": f"Rate limit on key #{next_key_idx}. Retrying with key #{next_key_idx + 1} of {total_keys}...",
    }
    _logger.info("[KeyRetry] Emitting retry event to client stream: %s", payload["message"])
    _dispatch_stream_payload(payload)


def _emit_fallback_event(fallback_provider_name: str = "Fallback Model"):
    """Notify the frontend stream that model fallback is occurring."""
    payload = {
        "step": "model_fallback",
        "message": f"Primary model rate limit reached. Switching to {fallback_provider_name}...",
    }
    _logger.info("[ModelFallback] Emitting fallback event to client stream: %s", payload["message"])
    _dispatch_stream_payload(payload)


class RotatingChatGroq(BaseChatModel):
    """A wrapper for ChatGroq that rotates through multiple API keys to bypass rate limits."""
    api_keys: List[str]
    model_name: str
    temperature: float
    reasoning_effort: Optional[str] = None
    _rotator: Any = None

    def __init__(self, api_keys: List[str], model: str, temperature: float = 0, reasoning_effort: Optional[str] = None, **kwargs: Any):
        super().__init__(api_keys=api_keys, model_name=model, temperature=temperature, reasoning_effort=reasoning_effort, **kwargs)
        object.__setattr__(self, '_rotator', KeyRotator(api_keys, "groq"))

    def _get_model_with_index(self) -> tuple[Any, int]:
        """Get a ChatGroq instance with the next API key in the rotation and return (model, key_index)"""
        from langchain_groq import ChatGroq
        key, idx = self._rotator.next_key()
        kwargs = {
            "api_key": key,
            "model": self.model_name,
            "temperature": self.temperature,
            "reasoning_format": "parsed",
        }
        if self.reasoning_effort:
            kwargs["reasoning_effort"] = self.reasoning_effort
        try:
            return ChatGroq(**kwargs), idx
        except Exception:
            kwargs.pop("reasoning_effort", None)
            kwargs.pop("reasoning_format", None)
            return ChatGroq(**kwargs), idx

    def bind_tools(self, tools: List[Any], **kwargs: Any) -> BaseChatModel:
        """Required for agents that use tools"""
        from langchain_groq import ChatGroq
        kwargs.setdefault("parallel_tool_calls", True)
        dummy_kwargs = {
            "api_key": self.api_keys[0],
            "model": self.model_name,
            "temperature": self.temperature,
            "reasoning_format": "parsed",
        }
        if self.reasoning_effort:
            dummy_kwargs["reasoning_effort"] = self.reasoning_effort
        try:
            dummy = ChatGroq(**dummy_kwargs)
        except Exception:
            dummy_kwargs.pop("reasoning_effort", None)
            dummy_kwargs.pop("reasoning_format", None)
            dummy = ChatGroq(**dummy_kwargs)
        bound = dummy.bind_tools(tools, **kwargs)
        
        # Extract formatted tools and tool_choice from the RunnableBinding
        new_kwargs = getattr(bound, "kwargs", {})
        
        # Groq API is picky about tool_choice: it only allows "none", "auto", or "required"
        # LangChain often converts specific tool names to a dict like {"type": "function", ...}
        # which Groq currently rejects with a 400 Bad Request error.
        if "tool_choice" in new_kwargs and isinstance(new_kwargs["tool_choice"], dict):
            new_kwargs["tool_choice"] = "required"

        return self.bind(**new_kwargs)

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        num_attempts = max(1, len(self.api_keys))
        last_exc: Optional[Exception] = None
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                return model._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            except Exception as e:
                last_exc = e
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/groq] Key #%d failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("groq", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e
        if last_exc:
            raise last_exc
        raise RuntimeError("No keys available for Groq")

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        num_attempts = max(1, len(self.api_keys))
        last_exc: Optional[Exception] = None
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                return await model._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
            except Exception as e:
                last_exc = e
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/groq] Key #%d failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("groq", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e
        if last_exc:
            raise last_exc
        raise RuntimeError("No keys available for Groq")

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        num_attempts = max(1, len(self.api_keys))
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                stream_iter = model._stream(messages, stop=stop, run_manager=run_manager, **kwargs)
                first_chunk = next(stream_iter)
            except StopIteration:
                return
            except Exception as e:
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/groq] Key #%d stream start failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("groq", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e

            yield first_chunk
            try:
                for chunk in stream_iter:
                    yield chunk
                return
            except Exception as e:
                _logger.warning("[KeyRotator/groq] Stream failed mid-generation: %s", e)
                raise e

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        num_attempts = max(1, len(self.api_keys))
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                stream_iter = model._astream(messages, stop=stop, run_manager=run_manager, **kwargs)
                first_chunk = await stream_iter.__anext__()
            except StopAsyncIteration:
                return
            except Exception as e:
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/groq] Key #%d astream start failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("groq", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e

            yield first_chunk
            try:
                async for chunk in stream_iter:
                    yield chunk
                return
            except Exception as e:
                _logger.warning("[KeyRotator/groq] astream failed mid-generation: %s", e)
                raise e

    @property
    def _llm_type(self) -> str:
        return "rotating-groq"


class RotatingChatOpenAI(BaseChatModel):
    """A wrapper for ChatOpenAI that rotates through multiple API keys to bypass rate limits."""
    api_keys: List[str]
    model_name: str
    base_url: str
    temperature: float
    reasoning_effort: Optional[str] = None
    _rotator: Any = None

    def __init__(self, api_keys: List[str], model: str, base_url: str, temperature: float = 0.7, reasoning_effort: Optional[str] = None, provider_name: str = "openai", **kwargs: Any):
        super().__init__(api_keys=api_keys, model_name=model, base_url=base_url, temperature=temperature, reasoning_effort=reasoning_effort, **kwargs)
        object.__setattr__(self, '_rotator', KeyRotator(api_keys, provider_name))

    def _get_model_with_index(self) -> tuple[Any, int]:
        """Get a ChatOpenAI instance with the next API key in the rotation and return (model, key_index)"""
        from langchain_openai import ChatOpenAI
        key, idx = self._rotator.next_key()
        kwargs = {
            "openai_api_key": key,
            "model_name": self.model_name,
            "base_url": self.base_url,
            "temperature": self.temperature,
            "stream_usage": True,
        }
        if self.reasoning_effort:
            kwargs["reasoning_effort"] = self.reasoning_effort
        try:
            return ChatOpenAI(**kwargs), idx
        except Exception:
            kwargs.pop("reasoning_effort", None)
            return ChatOpenAI(**kwargs), idx

    def bind_tools(self, tools: List[Any], **kwargs: Any) -> BaseChatModel:
        """Required for agents that use tools"""
        from langchain_openai import ChatOpenAI
        kwargs.setdefault("parallel_tool_calls", True)
        dummy_kwargs = {
            "openai_api_key": self.api_keys[0],
            "model_name": self.model_name,
            "base_url": self.base_url,
            "temperature": self.temperature,
            "stream_usage": True,
        }
        if self.reasoning_effort:
            dummy_kwargs["reasoning_effort"] = self.reasoning_effort
        try:
            dummy = ChatOpenAI(**dummy_kwargs)
        except Exception:
            dummy_kwargs.pop("reasoning_effort", None)
            dummy = ChatOpenAI(**dummy_kwargs)
        bound = dummy.bind_tools(tools, **kwargs)
        new_kwargs = getattr(bound, "kwargs", {})
        return self.bind(**new_kwargs)

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        num_attempts = max(1, len(self.api_keys))
        last_exc: Optional[Exception] = None
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                return model._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            except Exception as e:
                last_exc = e
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/openai] Key #%d failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("openai", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e
        if last_exc:
            raise last_exc
        raise RuntimeError("No keys available for OpenAI")

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        num_attempts = max(1, len(self.api_keys))
        last_exc: Optional[Exception] = None
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                return await model._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
            except Exception as e:
                last_exc = e
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/openai] Key #%d failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("openai", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e
        if last_exc:
            raise last_exc
        raise RuntimeError("No keys available for OpenAI")

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        num_attempts = max(1, len(self.api_keys))
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                stream_iter = model._stream(messages, stop=stop, run_manager=run_manager, **kwargs)
                first_chunk = next(stream_iter)
            except StopIteration:
                return
            except Exception as e:
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/openai] Key #%d stream start failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("openai", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e

            yield first_chunk
            try:
                for chunk in stream_iter:
                    yield chunk
                return
            except Exception as e:
                _logger.warning("[KeyRotator/openai] Stream failed mid-generation: %s", e)
                raise e

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        num_attempts = max(1, len(self.api_keys))
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                stream_iter = model._astream(messages, stop=stop, run_manager=run_manager, **kwargs)
                first_chunk = await stream_iter.__anext__()
            except StopAsyncIteration:
                return
            except Exception as e:
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/openai] Key #%d astream start failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("openai", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e

            yield first_chunk
            try:
                async for chunk in stream_iter:
                    yield chunk
                return
            except Exception as e:
                _logger.warning("[KeyRotator/openai] astream failed mid-generation: %s", e)
                raise e

    @property
    def _llm_type(self) -> str:
        return "rotating-openai"


def _sanitize_proto_schema(schema_obj: Any) -> None:
    """Recursively ensure all ARRAY types in a proto Schema or dict have items set."""
    if not schema_obj:
        return

    # Handle protobuf Schema
    if hasattr(schema_obj, "type") and hasattr(schema_obj, "properties"):
        is_array = False
        try:
            is_array = schema_obj.type == 5 or str(schema_obj.type).endswith("ARRAY")
        except Exception:
            pass

        if is_array:
            if not hasattr(schema_obj, "items") or not schema_obj.items or getattr(schema_obj.items, "type", 0) == 0:
                try:
                    schema_obj.items.type = 1  # Type.STRING
                except Exception:
                    pass

        # Check all child properties
        if hasattr(schema_obj, "properties") and schema_obj.properties:
            for prop_name in list(schema_obj.properties.keys()):
                prop_val = schema_obj.properties[prop_name]
                prop_is_array = False
                try:
                    prop_is_array = prop_val.type == 5 or str(prop_val.type).endswith("ARRAY")
                except Exception:
                    pass
                if prop_is_array:
                    if not hasattr(prop_val, "items") or not prop_val.items or getattr(prop_val.items, "type", 0) == 0:
                        try:
                            prop_val.items.type = 1  # Type.STRING
                        except Exception:
                            pass
                _sanitize_proto_schema(prop_val)

    # Handle dict
    elif isinstance(schema_obj, dict):
        prop_type = str(schema_obj.get("type", "")).upper()
        if prop_type in ("ARRAY", "5") and (not schema_obj.get("items") or schema_obj.get("items") == {}):
            schema_obj["items"] = {"type": "STRING"}
        if "properties" in schema_obj and isinstance(schema_obj["properties"], dict):
            for k, v in schema_obj["properties"].items():
                _sanitize_proto_schema(v)
        for k, v in schema_obj.items():
            if isinstance(v, (dict, list)):
                _sanitize_proto_schema(v)
    elif isinstance(schema_obj, list):
        for item in schema_obj:
            _sanitize_proto_schema(item)


def _sanitize_gemini_tool_declarations(tools_spec: Any) -> Any:
    """Recursively sanitize tools/function_declarations for Gemini API to ensure every array has items."""
    if isinstance(tools_spec, dict):
        prop_type = str(tools_spec.get("type", "")).upper()
        if prop_type in ("ARRAY", "array") and (not tools_spec.get("items") or tools_spec.get("items") == {}):
            tools_spec["items"] = {"type": "STRING"}

        # Also check properties inside parameters schema
        if "properties" in tools_spec and isinstance(tools_spec["properties"], dict):
            for prop_k, prop_v in list(tools_spec["properties"].items()):
                if isinstance(prop_v, dict):
                    p_type = str(prop_v.get("type", "")).upper()
                    if p_type in ("ARRAY", "array") and (not prop_v.get("items") or prop_v.get("items") == {}):
                        prop_v["items"] = {"type": "STRING"}
                    if "properties" in prop_v:
                        tools_spec["properties"][prop_k] = _sanitize_gemini_tool_declarations(prop_v)

        for k, v in list(tools_spec.items()):
            tools_spec[k] = _sanitize_gemini_tool_declarations(v)
    elif isinstance(tools_spec, list):
        return [_sanitize_gemini_tool_declarations(item) for item in tools_spec]
    return tools_spec


_SafeChatGoogleGenerativeAICls = None


def _get_safe_chat_google_generative_ai_cls():
    """Lazily import and subclass ChatGoogleGenerativeAI with automatic Gemini schema sanitization."""
    global _SafeChatGoogleGenerativeAICls
    if _SafeChatGoogleGenerativeAICls is None:
        from langchain_google_genai import ChatGoogleGenerativeAI

        class _SafeChatGoogleGenerativeAI(ChatGoogleGenerativeAI):
            """ChatGoogleGenerativeAI with automatic Gemini schema sanitization on _prepare_request and bind_tools."""

            def _prepare_request(self, messages: List[BaseMessage], **kwargs: Any) -> Any:
                request = super()._prepare_request(messages, **kwargs)
                if hasattr(request, "tools") and request.tools:
                    for tool_obj in request.tools:
                        if hasattr(tool_obj, "function_declarations") and tool_obj.function_declarations:
                            for fd in tool_obj.function_declarations:
                                if hasattr(fd, "parameters") and fd.parameters:
                                    _sanitize_proto_schema(fd.parameters)
                return request

            def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
                bound = super().bind_tools(tools, **kwargs)
                if hasattr(bound, "kwargs") and isinstance(bound.kwargs, dict):
                    if "tools" in bound.kwargs:
                        bound.kwargs["tools"] = _sanitize_gemini_tool_declarations(bound.kwargs["tools"])
                return bound

        _SafeChatGoogleGenerativeAICls = _SafeChatGoogleGenerativeAI
    return _SafeChatGoogleGenerativeAICls


class RotatingChatGoogleGenerativeAI(BaseChatModel):
    """A wrapper for ChatGoogleGenerativeAI that rotates through multiple API keys to bypass rate limits."""
    api_keys: List[str]
    model_name: str
    temperature: float
    reasoning_effort: Optional[str] = None
    _rotator: Any = None

    def __init__(self, api_keys: List[str], model: str, temperature: float = 0, reasoning_effort: Optional[str] = None, **kwargs: Any):
        super().__init__(api_keys=api_keys, model_name=model, temperature=temperature, reasoning_effort=reasoning_effort, **kwargs)
        object.__setattr__(self, '_rotator', KeyRotator(api_keys, "gemini"))

    def _get_model_with_index(self) -> tuple[Any, int]:
        """Get a SafeChatGoogleGenerativeAI instance with the next API key in the rotation and return (model, key_index)"""
        SafeCls = _get_safe_chat_google_generative_ai_cls()
        key, idx = self._rotator.next_key()
        kwargs = {
            "google_api_key": key,
            "model": self.model_name,
            "temperature": self.temperature,
        }
        if self.reasoning_effort:
            kwargs["include_thoughts"] = True
            kwargs["thinking_budget"] = -1
        else:
            kwargs["include_thoughts"] = False
            kwargs["thinking_budget"] = 0
        try:
            return SafeCls(**kwargs), idx
        except Exception:
            kwargs.pop("include_thoughts", None)
            kwargs.pop("thinking_budget", None)
            return SafeCls(**kwargs), idx

    def bind_tools(self, tools: List[Any], **kwargs: Any) -> BaseChatModel:
        """Required for agents that use tools"""
        SafeCls = _get_safe_chat_google_generative_ai_cls()
        kwargs.setdefault("parallel_tool_calls", True)
        dummy_kwargs = {
            "google_api_key": self.api_keys[0],
            "model": self.model_name,
            "temperature": self.temperature,
        }
        if self.reasoning_effort:
            dummy_kwargs["include_thoughts"] = True
            dummy_kwargs["thinking_budget"] = -1
        else:
            dummy_kwargs["include_thoughts"] = False
            dummy_kwargs["thinking_budget"] = 0
        try:
            dummy = SafeCls(**dummy_kwargs)
        except Exception:
            dummy_kwargs.pop("include_thoughts", None)
            dummy_kwargs.pop("thinking_budget", None)
            dummy = SafeCls(**dummy_kwargs)
        bound = dummy.bind_tools(tools, **kwargs)
        new_kwargs = getattr(bound, "kwargs", {})
        if "tools" in new_kwargs:
            new_kwargs["tools"] = _sanitize_gemini_tool_declarations(new_kwargs["tools"])
        return self.bind(**new_kwargs)

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        num_attempts = max(1, len(self.api_keys))
        last_exc: Optional[Exception] = None
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                return model._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            except Exception as e:
                last_exc = e
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/gemini] Key #%d failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("gemini", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e
        if last_exc:
            raise last_exc
        raise RuntimeError("No keys available for Gemini")

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> ChatResult:
        num_attempts = max(1, len(self.api_keys))
        last_exc: Optional[Exception] = None
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                return await model._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
            except Exception as e:
                last_exc = e
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/gemini] Key #%d failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("gemini", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e
        if last_exc:
            raise last_exc
        raise RuntimeError("No keys available for Gemini")

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        num_attempts = max(1, len(self.api_keys))
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                stream_iter = model._stream(messages, stop=stop, run_manager=run_manager, **kwargs)
                first_chunk = next(stream_iter)
            except StopIteration:
                return
            except Exception as e:
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/gemini] Key #%d stream start failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("gemini", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e

            yield first_chunk
            try:
                for chunk in stream_iter:
                    yield chunk
                return
            except Exception as e:
                _logger.warning("[KeyRotator/gemini] Stream failed mid-generation: %s", e)
                raise e

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        num_attempts = max(1, len(self.api_keys))
        for attempt in range(num_attempts):
            model, idx = self._get_model_with_index()
            try:
                stream_iter = model._astream(messages, stop=stop, run_manager=run_manager, **kwargs)
                first_chunk = await stream_iter.__anext__()
            except StopAsyncIteration:
                return
            except Exception as e:
                self._rotator.record_error(idx)
                _logger.warning(
                    "[KeyRotator/gemini] Key #%d astream start failed (attempt %d/%d): %s",
                    idx + 1, attempt + 1, num_attempts, e
                )
                if attempt < num_attempts - 1 and _is_rate_limit_or_recoverable_error(e):
                    _emit_retry_event("gemini", (idx + 1) % len(self.api_keys), num_attempts, e)
                    continue
                raise e

            yield first_chunk
            try:
                async for chunk in stream_iter:
                    yield chunk
                return
            except Exception as e:
                _logger.warning("[KeyRotator/gemini] astream failed mid-generation: %s", e)
                raise e

    @property
    def _llm_type(self) -> str:
        return "rotating-google-generative-ai"


class FallbackChatModel(BaseChatModel):
    """A wrapper chat model that falls back to a secondary model if the primary model fails."""
    _primary_model: Any = None
    _fallback_model: Any = None

    def __init__(self, primary_model: Any, fallback_model: Any, **kwargs: Any):
        super().__init__(**kwargs)
        object.__setattr__(self, '_primary_model', primary_model)
        object.__setattr__(self, '_fallback_model', fallback_model)

    def _generate(self, *args: Any, **kwargs: Any) -> Any:
        if hasattr(self._primary_model, "_generate"):
            return self._primary_model._generate(*args, **kwargs)
        return self._primary_model.invoke(*args, **kwargs)

    @property
    def _llm_type(self) -> str:
        return "fallback-chat-model"

    def bind_tools(self, tools: List[Any], **kwargs: Any) -> BaseChatModel:
        """Bind tools to both primary and fallback models"""
        bound_primary = self._primary_model.bind_tools(tools, **kwargs) if hasattr(self._primary_model, "bind_tools") else self._primary_model
        bound_fallback = self._fallback_model.bind_tools(tools, **kwargs) if hasattr(self._fallback_model, "bind_tools") else self._fallback_model
        return FallbackChatModel(
            primary_model=bound_primary,
            fallback_model=bound_fallback
        )

    def invoke(self, input: Any, config: Optional[Any] = None, **kwargs: Any) -> Any:
        try:
            return self._primary_model.invoke(input, config=config, **kwargs)
        except Exception as e:
            _logger.warning(f"Primary model failed: {e}. Falling back to fallback model.")
            _emit_fallback_event()
            return self._fallback_model.invoke(input, config=config, **kwargs)

    async def ainvoke(self, input: Any, config: Optional[Any] = None, **kwargs: Any) -> Any:
        try:
            return await self._primary_model.ainvoke(input, config=config, **kwargs)
        except Exception as e:
            _logger.warning(f"Primary model failed: {e}. Falling back to fallback model.")
            _emit_fallback_event()
            return await self._fallback_model.ainvoke(input, config=config, **kwargs)

    def stream(self, input: Any, config: Optional[Any] = None, **kwargs: Any) -> Iterator[Any]:
        try:
            iterator = self._primary_model.stream(input, config=config, **kwargs)
            first_chunk = next(iterator)
        except Exception as e:
            _logger.warning(f"Primary model stream failed to start: {e}. Falling back to fallback model.")
            _emit_fallback_event()
            yield from self._fallback_model.stream(input, config=config, **kwargs)
            return

        yield first_chunk
        try:
            for chunk in iterator:
                yield chunk
        except Exception as e:
            _logger.warning(f"Primary model stream failed mid-stream: {e}. Cannot fall back mid-stream.")
            raise e

    async def astream(self, input: Any, config: Optional[Any] = None, **kwargs: Any) -> AsyncIterator[Any]:
        try:
            iterator = self._primary_model.astream(input, config=config, **kwargs)
            first_chunk = await iterator.__anext__()
        except Exception as e:
            _logger.warning(f"Primary model stream failed to start: {e}. Falling back to fallback model.")
            _emit_fallback_event()
            async for chunk in self._fallback_model.astream(input, config=config, **kwargs):
                yield chunk
            return

        yield first_chunk
        try:
            async for chunk in iterator:
                yield chunk
        except Exception as e:
            _logger.warning(f"Primary model stream failed mid-stream: {e}. Cannot fall back mid-stream.")
            raise e


class LoadSkillInput(BaseModel):
    skill_name: str = Field(description="The exact name of the skill to load.")


@tool(args_schema=LoadSkillInput)
def load_skill(skill_name: str, runtime: Annotated[ToolRuntime, InjectedToolArg] = None) -> str:
    """Load the full content of a skill into the agent's context.
    Use this when you need detailed instructions or guidelines for a specific domain/task.
    
    Args:
        skill_name: The exact name of the skill to load.
    """
    try:
        from app.database import list_skills
        import os
        from langgraph.config import get_config

        normalized_name = skill_name.strip().lower()
        db_skills = list_skills()
        for row in db_skills:
            if row.get("name", "").strip().lower() == normalized_name or row.get("id", "").strip().lower() == normalized_name:
                content = (row.get("content") or "").strip()
                return f"Loaded Skill: {row.get('name')}\n\n{content}"
        
        # Fuzzy / substring fallback for DB skill names
        for row in db_skills:
            r_name = row.get("name", "").strip().lower()
            if normalized_name in r_name or r_name in normalized_name:
                content = (row.get("content") or "").strip()
                return f"Loaded Skill: {row.get('name')}\n\n{content}"

        # Workspace & global file checks
        config = None
        try:
            config = get_config()
        except Exception:
            pass
        project_root = config.get("configurable", {}).get("project_root") if config and "configurable" in config else None

        if project_root and os.path.isdir(project_root):
            if normalized_name in ("claude.md", "claude", "workspace claude.md"):
                p = os.path.join(project_root, "CLAUDE.md")
                if os.path.isfile(p):
                    with open(p, "r", encoding="utf-8") as f:
                        return f"Loaded Workspace Skill: CLAUDE.md\n\n{f.read().strip()}"
            elif normalized_name in ("rie.md", "rie", "workspace rie.md"):
                p = os.path.join(project_root, "RIE.md")
                if os.path.isfile(p):
                    with open(p, "r", encoding="utf-8") as f:
                        return f"Loaded Workspace Skill: RIE.md\n\n{f.read().strip()}"
            ws_skills_dir = os.path.join(project_root, ".rie", "skills")
            if os.path.isdir(ws_skills_dir):
                for fname in os.listdir(ws_skills_dir):
                    if fname.lower() == normalized_name or fname.lower().replace(".md", "") == normalized_name:
                        p = os.path.join(ws_skills_dir, fname)
                        if os.path.isfile(p):
                            with open(p, "r", encoding="utf-8") as f:
                                return f"Loaded Workspace Skill: {fname}\n\n{f.read().strip()}"

        home_dir = os.path.expanduser("~")
        global_rie_dir = os.path.join(home_dir, ".rie")
        if normalized_name in ("global claude.md", "global claude"):
            p = os.path.join(global_rie_dir, "CLAUDE.md")
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    return f"Loaded Global Skill: CLAUDE.md\n\n{f.read().strip()}"
        elif normalized_name in ("global rie.md", "global rie"):
            p = os.path.join(global_rie_dir, "RIE.md")
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    return f"Loaded Global Skill: RIE.md\n\n{f.read().strip()}"
        global_skills_dir = os.path.join(global_rie_dir, "skills")
        if os.path.isdir(global_skills_dir):
            for fname in os.listdir(global_skills_dir):
                if fname.lower() == normalized_name or fname.lower().replace(".md", "") == normalized_name:
                    p = os.path.join(global_skills_dir, fname)
                    if os.path.isfile(p):
                        with open(p, "r", encoding="utf-8") as f:
                            return f"Loaded Global Skill: {fname}\n\n{f.read().strip()}"

    except Exception as exc:
        return f"Error loading skill '{skill_name}': {exc}"
        
    return f"Skill '{skill_name}' not found. Check the Available Skills list in your prompt for exact valid skill names."


class ToolNeedMiddleware(AgentMiddleware):
    """
    Binary Tool-Need Gate:
    - Answers only: "Can this request be completed using an external capability/action?"
    - False (Pure Casual / Greeting / Identity): passes tools = [] (0 tool schema overhead, ultra-fast response).
    - True (Agent Mode / Action): passes ALL session tools to LangGraph ReAct without fine-grained keyword slicing.
    """

    @staticmethod
    def _extract_query_and_history(messages: list[Any]) -> tuple[str, set[str]]:
        """Extract recent user query text and any previously invoked tool names."""
        user_texts: list[str] = []
        invoked_tool_names: set[str] = set()

        if not messages:
            return "", invoked_tool_names

        recent = messages[-6:] if len(messages) > 6 else messages
        for msg in recent:
            # Check tool calls
            tool_calls = getattr(msg, "tool_calls", None) or []
            for tc in tool_calls:
                tc_name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "")
                if tc_name:
                    invoked_tool_names.add(str(tc_name))

            # Check tool response message name
            msg_name = getattr(msg, "name", None)
            if msg_name:
                invoked_tool_names.add(str(msg_name))

            # Check user message text
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            if role in ("human", "user"):
                content = getattr(msg, "content", "")
                if isinstance(content, str):
                    user_texts.append(content)
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            user_texts.append(part.get("text", ""))

        latest_query = user_texts[-1].strip() if user_texts else ""
        return latest_query, invoked_tool_names

    @classmethod
    def _has_active_tool_history(cls, messages: list[Any]) -> bool:
        """Check if message context contains in-progress or recent tool activity."""
        if not messages:
            return False
        recent = messages[-6:] if len(messages) > 6 else messages
        for msg in recent:
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            if isinstance(role, str) and role in ("tool", "tool_result", "function"):
                return True
            tool_calls = getattr(msg, "tool_calls", None)
            if isinstance(tool_calls, list) and len(tool_calls) > 0:
                return True
            msg_name = getattr(msg, "name", None)
            if isinstance(msg_name, str) and msg_name:
                return True
        return False

    @classmethod
    def _is_obviously_casual(cls, query: str) -> bool:
        """
        Check if query is highly likely to be pure conversation / greeting / identity question
        with NO need for external tool execution.
        Conservative rule: 'True' ONLY when highly confident it is casual.
        """
        if not query:
            return True

        q_lower = query.lower().strip()
        import re
        normalized_q = re.sub(r"[^\w\s]", "", q_lower).strip()

        # Action verbs/indicators that MUST route to Agent mode (never casual)
        ACTION_TRIGGERS = (
            "open ", "launch ", "start ", "run ", "execute ", "search ", "google ",
            "find ", "look up", "check ", "read ", "get ", "send ", "draft ",
            "create ", "write ", "delete ", "remove ", "kill ", "stop ", "schedule ",
            "remind ", "remember ", "save ", "store ", "turn on", "turn off", "switch ",
            "click ", "type ", "press ", "scroll ", "drag ", "download ", "install ",
            "wallpaper", "wifi", "wi-fi", "battery", "cpu", "ram", "memory usage",
            "process", "taskmgr", "task manager", "settings", "control panel",
            "email", "gmail", "github", "jira", "mcp", "terminal", "powershell",
            "cmd", "browser", "weather", "temperature", "forecast", "news",
            "skill", "skills", "load_skill", "load skill",
        )

        for act in ACTION_TRIGGERS:
            if act in q_lower:
                return False

        # Strictly casual / conversational patterns
        CASUAL_PATTERNS = (
            "hi", "hello", "hey", "greetings", "good morning", "good afternoon",
            "good evening", "good night", "whats my name", "what is my name",
            "who are you", "who am i", "what is your name", "whats your name",
            "tell me a joke", "thank you", "thanks", "ok", "okay", "cool",
            "bye", "goodbye", "help", "how are you", "what can you do",
            "nice to meet you", "howdy", "sup", "yo",
        )

        if any(normalized_q == p or normalized_q.startswith(p + " ") or normalized_q.endswith(" " + p) for p in CASUAL_PATTERNS):
            return True

        if MemoryRetrievalMiddleware._is_low_information_query(query):
            return True

        # Any complex, domain, or ambiguous request defaults to False (needs tools / agent mode)
        return False

    @classmethod
    def _needs_tools(cls, query: str, messages: list[Any]) -> bool:
        """
        Conservative binary gate:
        - True if in active ReAct loop or if any tool/external capability might be needed.
        - False ONLY if highly confident it is pure casual chat.
        """
        if cls._has_active_tool_history(messages):
            return True

        if cls._is_obviously_casual(query):
            return False

        return True

    def _apply_tool_gating(self, request: ModelRequest) -> ModelRequest:
        tools = getattr(request, "tools", []) or []
        query, _ = self._extract_query_and_history(request.messages or [])

        needs_tools = self._needs_tools(query, request.messages or [])

        overrides: dict[str, Any] = {}
        if not needs_tools:
            _logger.debug("[ToolNeedMiddleware] Turn classified as CASUAL CHAT -> providing 0 tools")
            overrides["tools"] = []
        else:
            _logger.debug(
                "[ToolNeedMiddleware] Turn classified as AGENT MODE -> providing ALL %d session tools",
                len(tools),
            )
            # In agent mode, all session tools remain bound; no bloated technical rules injected

        if overrides:
            return request.override(**overrides)
        return request

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        modified_request = self._apply_tool_gating(request)
        return handler(modified_request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        modified_request = self._apply_tool_gating(request)
        return await handler(modified_request)

    # --- Legacy Helpers for backward compatibility with existing tests ---
    DOMAIN_PREFIXES: dict[str, tuple[str, ...]] = {
        "search": ("internet_search",),
        "email": ("gmail_",),
        "browser": ("browser_", "camofox_", "scrape_web"),
        "desktop": (
            "windows_", "app_control", "get_desktop_state", "run_terminal_command",
            "mouse_click", "keyboard_type", "scroll_mouse", "drag_mouse", "move_mouse",
            "press_keys", "wait", "scrape_web",
        ),
        "system": ("run_terminal_command", "windows_", "app_control", "get_desktop_state"),
        "mcp": ("list_mcp_servers", "add_mcp_server", "update_mcp_server", "delete_mcp_server", "get_mcp_tool_info"),
        "scheduler": ("schedule_chat_task",),
        "remote_friend": ("remote_friend_ask",),
        "knowledge": ("read_knowledge_asset",),
        "memory": ("get_memory", "search_memory"),
        "github": ("github_",),
        "jira": ("jira_",),
        "skills": ("load_skill",),
    }
    ALWAYS_AVAILABLE_TOOLS: set[str] = {"save_memory", "load_skill"}

    @classmethod
    def _classify_domains(cls, query: str, invoked_tool_names: set[str]) -> set[str]:
        active_domains: set[str] = set()
        for tool_name in invoked_tool_names:
            for domain, prefixes in cls.DOMAIN_PREFIXES.items():
                if any(tool_name.startswith(p) or tool_name == p for p in prefixes):
                    active_domains.add(domain)
        q = query.lower()
        if any(k in q for k in ("wifi", "ip address", "powershell", "terminal command", "cpu usage", "ram usage", "process", "task list", "run script")):
            active_domains.add("system")
        if any(k in q for k in ("settings", "wallpaper", "display", "notepad", "calculator", "app_control", "mouse click", "keyboard", "open ", "launch ")):
            active_domains.add("desktop")
        if any(k in q for k in ("email", "gmail", "inbox", "mail", "draft", "read email")):
            active_domains.add("email")
        if any(k in q for k in ("weather", "search web", "google", "search online", "temperature")):
            active_domains.add("search")
        if any(k in q for k in ("browser", "open website", "navigate to", "url", "scrape", "http://", "https://")):
            active_domains.add("browser")
        if any(k in q for k in ("github", "pull request", "pr #", "issue #", "repo")):
            active_domains.add("github")
        if any(k in q for k in ("jira", "sprint", "backlog", "story", "ticket")):
            active_domains.add("jira")
        if any(k in q for k in ("skill", "skills", "load skill", "load_skill")):
            active_domains.add("skills")
        return active_domains

    @classmethod
    def _filter_tools(cls, tools: list[Any], active_domains: set[str], query: str = "") -> list[Any]:
        if not tools:
            return []
        if not active_domains and query and cls._is_obviously_casual(query):
            return []
        if not active_domains and query:
            q = query.lower().strip()
            if "remember" in q or "save memory" in q:
                return [t for t in tools if getattr(t, "name", str(t)) in ("save_memory", "get_memory", "search_memory")]
            if "remind" in q or "schedule" in q:
                return [t for t in tools if getattr(t, "name", str(t)) in ("schedule_chat_task",)]
            if "skill" in q or "load_skill" in q:
                return [t for t in tools if getattr(t, "name", str(t)) in ("load_skill",)]
        filtered = []
        all_domain_prefixes = [p for prefixes in cls.DOMAIN_PREFIXES.values() for p in prefixes]
        for t in tools:
            t_name = getattr(t, "name", getattr(t, "__name__", str(t)))
            if t_name in cls.ALWAYS_AVAILABLE_TOOLS:
                filtered.append(t)
                continue
            in_active = False
            for domain in active_domains:
                prefixes = cls.DOMAIN_PREFIXES.get(domain, ())
                if any(t_name.startswith(p) or t_name == p for p in prefixes):
                    in_active = True
                    break
            if in_active:
                filtered.append(t)
                continue
            in_any_domain = any(t_name.startswith(p) or t_name == p for p in all_domain_prefixes)
            if not in_any_domain:
                filtered.append(t)
        return filtered

    @classmethod
    def _build_technical_rules(cls, active_domains: set[str], filtered_tools: list[Any]) -> str:
        domain_set = set(active_domains)
        rules: list[str] = []
        for domain in sorted(domain_set):
            if domain in DOMAIN_RULES:
                rules.append(DOMAIN_RULES[domain])
        return "\n\n".join(rules)

    def _apply_dynamic_routing(self, request: ModelRequest) -> ModelRequest:
        return self._apply_tool_gating(request)


# Backwards compatibility alias
DynamicToolRoutingMiddleware = ToolNeedMiddleware


class ContextProjectionMiddleware(AgentMiddleware):
    """
    Non-destructive model context projection middleware:
    - Never mutates the underlying checkpoint, thread store, or trajectory ledger.
    - Projects a compact view of historical tool results and message payloads into the model request:
      * Latest ToolMessage: Retained in 100% full raw detail so LLM can immediately reason on it.
      * Older ToolMessages: Compacted (summarizing candidate search lists, truncating raw historical dumps
        once subsequent steps have processed them) to prevent monotonic ReAct token accumulation.
    """

    MAX_HISTORICAL_TOOL_RESULT_CHARS: int = 350

    @classmethod
    def _compact_tool_content(cls, tool_name: str, raw_content: str) -> str:
        """Compact older/historical tool content while preserving essential identifiers and status."""
        if not raw_content or len(raw_content) <= cls.MAX_HISTORICAL_TOOL_RESULT_CHARS:
            return raw_content

        import json
        clean_content = raw_content.strip()

        # 1. Search results compaction (e.g. gmail_search_emails, internet_search)
        if any(k in tool_name for k in ("search_emails", "internet_search", "search")):
            try:
                parsed = json.loads(clean_content)
                if isinstance(parsed, list):
                    items_summary = []
                    for idx, item in enumerate(parsed[:4], 1):
                        if isinstance(item, dict):
                            id_val = item.get("id") or item.get("message_id") or item.get("key") or ""
                            subj = item.get("subject") or item.get("title") or item.get("name") or ""
                            sender = item.get("from") or item.get("sender") or ""
                            summary_line = f"Item {idx}: id={id_val}"
                            if subj:
                                summary_line += f", subject='{subj[:40]}'"
                            if sender:
                                summary_line += f", from='{sender[:30]}'"
                            items_summary.append(summary_line)
                    return f"[Found {len(parsed)} results]\n" + "\n".join(items_summary) + f"\n... [{len(parsed)} results total; detailed content processed in trajectory]"
                elif isinstance(parsed, dict) and "results" in parsed:
                    results = parsed.get("results") or []
                    return f"[Found {len(results)} results]\n" + clean_content[:cls.MAX_HISTORICAL_TOOL_RESULT_CHARS] + "\n... [truncated for context]"
            except Exception:
                pass

        # 2. Email or page fetch compaction (once subsequent actions are in progress)
        if any(k in tool_name for k in ("get_email", "scrape_web", "read_knowledge")):
            lines = clean_content.splitlines()
            header_lines = [l for l in lines[:5] if any(l.lower().startswith(h) for h in ("from:", "subject:", "to:", "date:", "title:", "url:"))]
            header_block = "\n".join(header_lines) if header_lines else clean_content[:150]
            return f"{header_block}\n[Full content body fetched and processed; retained in task trajectory]"

        # 3. Generic truncation for other verbose outputs
        return clean_content[:cls.MAX_HISTORICAL_TOOL_RESULT_CHARS] + "\n... [earlier tool output truncated for context]"

    @classmethod
    def _project_messages(cls, messages: list[Any]) -> list[Any]:
        """Project messages non-destructively for the LLM request."""
        if not messages:
            return messages

        # Find the index of the latest ToolMessage
        latest_tool_idx = -1
        for idx in range(len(messages) - 1, -1, -1):
            msg = messages[idx]
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            if role in ("tool", "tool_result", "function") or isinstance(msg, ToolMessage):
                latest_tool_idx = idx
                break

        projected: list[Any] = []
        for idx, msg in enumerate(messages):
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            is_tool = role in ("tool", "tool_result", "function") or isinstance(msg, ToolMessage)

            # If it's a ToolMessage and NOT the latest one, project/compact it
            if is_tool and idx != latest_tool_idx:
                tool_name = getattr(msg, "name", "") or ""
                raw_content = getattr(msg, "content", "")
                if isinstance(raw_content, str) and len(raw_content) > cls.MAX_HISTORICAL_TOOL_RESULT_CHARS:
                    compacted_content = cls._compact_tool_content(tool_name, raw_content)
                    try:
                        projected_msg = ToolMessage(
                            content=compacted_content,
                            name=getattr(msg, "name", None),
                            tool_call_id=getattr(msg, "tool_call_id", ""),
                            status=getattr(msg, "status", "success"),
                            id=getattr(msg, "id", None),
                            additional_kwargs=dict(getattr(msg, "additional_kwargs", {}) or {}),
                        )
                        projected.append(projected_msg)
                        continue
                    except Exception:
                        pass

            projected.append(msg)

        return projected

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        messages = getattr(request, "messages", []) or []
        projected = self._project_messages(messages)
        if len(projected) == len(messages) and projected != messages:
            request = request.override(messages=projected)
        return handler(request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        messages = getattr(request, "messages", []) or []
        projected = self._project_messages(messages)
        if len(projected) == len(messages) and projected != messages:
            request = request.override(messages=projected)
        return await handler(request)


class PromptCompositionDiagnosticMiddleware(AgentMiddleware):
    """
    Diagnostic middleware that calculates and logs the prompt and schema composition
    immediately before model invocation to ensure complete visibility of input token distribution per turn.
    """

    @staticmethod
    def _count_tokens(text: str) -> int:
        if not text:
            return 0
        try:
            import tiktoken
            enc = tiktoken.get_encoding("cl100k_base")
            return len(enc.encode(text))
        except Exception:
            return max(1, len(text.encode("utf-8")) // 4)

    @classmethod
    def _calculate_breakdown(cls, request: ModelRequest) -> dict[str, Any]:
        import json
        from langchain_core.utils.function_calling import convert_to_openai_tool

        base_system_tok = 0
        tech_rules_tok = 0
        skills_tok = 0
        ltm_tok = 0
        runtime_ctx_tok = 0
        user_msg_tok = 0
        ai_msg_tok = 0
        tool_res_tok = 0
        tool_schema_tok = 0

        # 1. System message breakdown
        sys_msg = getattr(request, "system_message", None)
        if sys_msg:
            sys_text = ""
            if isinstance(sys_msg.content, str):
                sys_text = sys_msg.content
            elif isinstance(sys_msg.content, list):
                for block in sys_msg.content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        sys_text += block.get("text", "") + "\n"
                    elif hasattr(block, "text"):
                        sys_text += block.text + "\n"

            if "Technical & Tool Execution Rules:" in sys_text:
                tech_start = sys_text.find("Technical & Tool Execution Rules:")
                next_indices = [
                    idx for idx in (
                        sys_text.find("Active Skill Instructions (Pre-loaded)", tech_start),
                        sys_text.find("## Recalled Long-Term Memories", tech_start),
                    ) if idx != -1
                ]
                tech_end = min(next_indices) if next_indices else len(sys_text)
                tech_text = sys_text[tech_start:tech_end].strip()
                tech_rules_tok = cls._count_tokens(tech_text)

            if "Active Skill Instructions" in sys_text or "Available Skills" in sys_text:
                skill_start = -1
                for marker in ("## Active Skill Instructions", "Active Skill Instructions", "## Available Skills", "Available Skills"):
                    pos = sys_text.find(marker)
                    if pos != -1 and (skill_start == -1 or pos < skill_start):
                        skill_start = pos
                next_indices = [
                    idx for idx in (
                        sys_text.find("## Recalled Long-Term Memories", skill_start),
                        sys_text.find("Technical & Tool Execution Rules:", skill_start),
                    ) if idx != -1
                ]
                skill_end = min(next_indices) if next_indices else len(sys_text)
                skill_text = sys_text[skill_start:skill_end].strip()
                skills_tok = cls._count_tokens(skill_text)

            if "Recalled Long-Term Memories" in sys_text:
                ltm_start = sys_text.find("Recalled Long-Term Memories")
                ltm_end = sys_text.find("End Recalled Long-Term Memories")
                ltm_text = sys_text[ltm_start:ltm_end] if ltm_end != -1 else sys_text[ltm_start:]
                ltm_tok = cls._count_tokens(ltm_text)

            total_sys_tok = cls._count_tokens(sys_text)
            base_system_tok = max(0, total_sys_tok - tech_rules_tok - skills_tok - ltm_tok)

        # 2. Messages breakdown
        messages = getattr(request, "messages", []) or []
        tool_results_list = []
        for msg in messages:
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            content = getattr(msg, "content", "")
            msg_text = content if isinstance(content, str) else str(content)
            tool_calls = getattr(msg, "tool_calls", None) or []
            tc_text = json.dumps(tool_calls) if tool_calls else ""

            if role == "system":
                runtime_ctx_tok += cls._count_tokens(msg_text)
            elif role in ("human", "user"):
                user_msg_tok += cls._count_tokens(msg_text)
            elif role in ("ai", "assistant"):
                ai_msg_tok += cls._count_tokens(msg_text) + (cls._count_tokens(tc_text) if tc_text else 0)
            elif role in ("tool", "tool_result", "function"):
                tok = cls._count_tokens(msg_text)
                tool_res_tok += tok
                tool_name = getattr(msg, "name", "tool")
                tool_results_list.append((tool_name, tok))
            else:
                user_msg_tok += cls._count_tokens(msg_text)

        # 3. Tool schemas breakdown
        tools = getattr(request, "tools", []) or []
        tool_names = []
        tool_schemas_list = []
        for t in tools:
            t_name = getattr(t, "name", getattr(t, "__name__", str(t)))
            tool_names.append(t_name)
            try:
                schema = convert_to_openai_tool(t)
                schema_json = json.dumps(schema)
                tok = cls._count_tokens(schema_json)
                tool_schema_tok += tok
                tool_schemas_list.append((t_name, tok))
            except Exception:
                pass

        total_messages_tok = user_msg_tok + ai_msg_tok + tool_res_tok
        total_tok = (
            base_system_tok
            + tech_rules_tok
            + skills_tok
            + ltm_tok
            + runtime_ctx_tok
            + total_messages_tok
            + tool_schema_tok
        )

        # 4. Turn calculation
        step_count = 0
        for msg in messages:
            if getattr(msg, "type", "") in ("ai", "assistant") or isinstance(msg, AIMessage):
                if getattr(msg, "tool_calls", None):
                    step_count += 1
        turn_number = step_count + 1

        return {
            "turn_number": turn_number,
            "base_system": base_system_tok,
            "technical_rules": tech_rules_tok,
            "skills": skills_tok,
            "ltm_context": ltm_tok,
            "runtime_context": runtime_ctx_tok,
            "messages": total_messages_tok,
            "user_messages": user_msg_tok,
            "ai_messages": ai_msg_tok,
            "tool_results": tool_res_tok,
            "tool_results_list": tool_results_list,
            "tool_schema": tool_schema_tok,
            "tool_schemas_list": tool_schemas_list,
            "tool_count": len(tools),
            "tool_names": tool_names,
            "total": total_tok,
        }

    @classmethod
    def _log_breakdown(cls, request: ModelRequest) -> None:
        b = cls._calculate_breakdown(request)
        messages = getattr(request, "messages", []) or []
        query, _ = ToolNeedMiddleware._extract_query_and_history(messages)
        needs_tools = ToolNeedMiddleware._needs_tools(query, messages)
        mode_label = f"AGENT ({b['tool_count']} tools bound)" if needs_tools else "CHAT (0 tools bound)"

        provider = settings.LLM_PROVIDER or "rie"
        model_name = getattr(request.model, "model_name", getattr(request.model, "model", str(type(request.model).__name__)))
        model_cls = type(request.model).__name__
        plugin_tools = [t for t in b["tool_names"] if any(t.startswith(p) for p in ("gmail_", "github_", "jira_"))]

        print("\n" + "=" * 60)
        print(f"MODEL TURN {b['turn_number']} | Mode: {mode_label}")
        print("-" * 60)
        print(f"system tokens:        {b['base_system']:5d}")
        print(f"technical rules:      {b['technical_rules']:5d}")
        print(f"skills:               {b['skills']:5d}")
        print(f"LTM:                  {b['ltm_context']:5d}")
        print(f"runtime:              {b['runtime_context']:5d}")
        print(f"messages:             {b['messages']:5d}  (user: {b['user_messages']}, ai: {b['ai_messages']}, tool results: {b['tool_results']})")
        if b.get("tool_results_list"):
            for tr_name, tr_tok in b["tool_results_list"]:
                print(f"   ↳ [tool result] {tr_name}: {tr_tok:4d} tokens")
        print(f"tool schemas:         {b['tool_schema']:5d}  ({b['tool_count']} tools)")
        if b.get("tool_schemas_list"):
            top_schemas = sorted(b["tool_schemas_list"], key=lambda x: x[1], reverse=True)
            for ts_name, ts_tok in top_schemas[:5]:
                print(f"   ↳ [schema] {ts_name}: {ts_tok:4d} tokens")
        print("-" * 60)
        print(f"TOTAL:                {b['total']:5d} tokens")
        print("=" * 60)
        print(f"Model: {model_cls} ({model_name}) | Provider: {provider}")
        if plugin_tools:
            print(f"Plugin Tools:   {plugin_tools}")
        print(f"Bound Tools:    {b['tool_names']}")
        print("=" * 60 + "\n")

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        self._log_breakdown(request)
        return handler(request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        self._log_breakdown(request)
        return await handler(request)


class SkillMiddleware(AgentMiddleware):
    """
    Middleware that pre-injects active and matching database skill instructions directly
    into the system prompt, eliminating the costly 'load_skill' LLM round trip while
    maintaining load_skill as a fallback.
    """
    tools = [load_skill]

    @staticmethod
    def _extract_query_text(messages: list[Any]) -> str:
        """Extract recent user query text from messages."""
        if not messages:
            return ""
        for msg in reversed(messages):
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            if role in ("human", "user"):
                content = getattr(msg, "content", "")
                if isinstance(content, str):
                    return content
                elif isinstance(content, list):
                    parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
                    return " ".join(parts)
        return ""

    @staticmethod
    def _matches_skill_query(skill_name: str, skill_desc: str, query: str) -> bool:
        """Heuristic to determine if a skill should be pre-injected based on user query."""
        if not query:
            return False
        q = query.lower()
        lower_name = skill_name.lower()
        lower_desc = skill_desc.lower() if skill_desc else ""

        # Skill-specific keyword triggers
        SKILL_TRIGGERS: dict[str, tuple[str, ...]] = {
            "job application assistant": ("job", "apply", "career", "resume", "linkedin", "greenhouse", "lever", "workday", "candidate"),
            "camofox browser": ("camofox", "camoufox", "firefox", "stealth browser", "headless browser"),
            "powershell style & scripting": ("powershell", "ps1", "posh", ".ps1", "cmdlet", "powershell script", "terminal script"),
            "windows system tasks": (
                "wallpaper", "desktop background", "background", "registry", "regedit",
                "windows service", "services", "taskmgr", "task manager", "event log",
                "schtasks", "scheduled task", "display settings", "resolution", "startup", "p/invoke",
                "cpu", "cpu usage", "ram", "kill process", "process", "processes"
            ),
            "computer use guide": (
                "mouse", "click at", "keyboard", "press key", "type text", "uia",
                "desktop state", "app_control", "shortcut"
            ),
            "pdf generation expert": ("pdf", "generate pdf", "report pdf", "weasyprint", "fpdf", "reportlab"),
            "file & directory operations": (
                "zip", "unzip", "tar", "archive file", "directory tree", "move files",
                "copy file", "delete file", "rename file", "compress", "extract archive", "folder"
            ),
            "network & downloads": (
                "download file", "download", "curl", "wget", "network test", "ping host", "ping ",
                "dns lookup", "wifi", "wi-fi", "ip address", "port", "firewall", "adapter", "traceroute"
            ),
        }

        # 1. Check explicit trigger keywords
        for key, triggers in SKILL_TRIGGERS.items():
            if key in lower_name:
                if any(tr in q for tr in triggers):
                    return True

        # 2. Check if skill name itself appears in query
        if lower_name in q:
            return True

        # 3. Description keyword check for high-value system action objects
        HIGH_VALUE_OBJECTS = ("wallpaper", "wifi", "wi-fi", "powershell", "registry", "scheduled task", "ip address")
        for hvo in HIGH_VALUE_OBJECTS:
            if hvo in q and hvo in lower_desc:
                return True

        return False

    def _build_skills_sections(self, request: Optional[ModelRequest] = None) -> tuple[list[str], list[str]]:
        preloaded_sections: list[str] = []
        available_list: list[str] = []

        try:
            from app.database import list_skills
            from langgraph.config import get_config

            config = None
            try:
                config = get_config()
            except Exception:
                pass

            thread_id = None
            skill_ids_from_config = []
            project_root = None
            if config and "configurable" in config:
                thread_id = config["configurable"].get("thread_id")
                skill_ids_from_config = config["configurable"].get("skill_ids", [])
                project_root = config["configurable"].get("project_root")

            # Check available tools in the model request
            has_camofox_tools = True
            has_native_gmail_tools = False
            if request and hasattr(request, "tools"):
                tool_names = [getattr(t, "name", str(t)) for t in (request.tools or [])]
                has_camofox_tools = any(t in tool_names for t in ("browser_open", "browser_snapshot"))
                has_native_gmail_tools = any(t.startswith("gmail_") for t in tool_names)

            query_text = self._extract_query_text(getattr(request, "messages", []) or [])

            # Collect active/available database skills:
            db_skills = list_skills()
            seen_skill_names: set[str] = set()
            for row in db_skills:
                name = row.get("name", "Skill")
                lower_name = name.lower()

                # If Camoufox browser tools are not present, filter out CamoFox and Job Application skills
                if not has_camofox_tools and ("camofox" in lower_name or "camoufox" in lower_name or "job application" in lower_name):
                    continue

                # If native Gmail tools are present and query is about email, omit CamoFox/browser skills to avoid confusion
                if has_native_gmail_tools and ("email" in query_text.lower() or "mail" in query_text.lower()):
                    if "camofox" in lower_name or "computer use" in lower_name:
                        continue

                # Check if attached to this thread or config
                is_attached = row.get("id") in skill_ids_from_config
                if not is_attached and thread_id:
                    from app.database import get_db_path
                    import sqlite3
                    try:
                        db_path = get_db_path()
                        conn = sqlite3.connect(db_path)
                        cursor = conn.cursor()
                        cursor.execute("SELECT COUNT(*) FROM thread_skills WHERE thread_id = ? AND skill_id = ?", (thread_id, row.get("id")))
                        if cursor.fetchone()[0] > 0:
                            is_attached = True
                        conn.close()
                    except Exception:
                        pass

                is_globally_enabled = bool(row.get("enabled", 1))
                if not is_globally_enabled and not is_attached:
                    continue

                content = (row.get("content") or "").strip()
                desc = (row.get("description") or "").strip() or "Specialized skill instructions."
                seen_skill_names.add(lower_name)

                # Determine whether to PRELOAD full content or list as AVAILABLE
                should_preload = is_attached or self._matches_skill_query(name, desc, query_text)

                if should_preload and content:
                    preloaded_sections.append(f"### Skill: {name}\n{content}")
                else:
                    available_list.append(f"- **{name}**: {desc}")

            # Also discover workspace skills if present
            import os
            if project_root and os.path.isdir(project_root):
                claude_path = os.path.join(project_root, "CLAUDE.md")
                if os.path.isfile(claude_path) and "claude.md" not in seen_skill_names:
                    desc = "Rules and instructions from workspace root CLAUDE.md"
                    if "ws_claude" in skill_ids_from_config:
                        try:
                            with open(claude_path, "r", encoding="utf-8") as f:
                                preloaded_sections.append(f"### Skill: CLAUDE.md\n{f.read().strip()}")
                        except Exception:
                            pass
                    else:
                        available_list.append(f"- **CLAUDE.md**: {desc}")
                    seen_skill_names.add("claude.md")

                rie_path = os.path.join(project_root, "RIE.md")
                if os.path.isfile(rie_path) and "rie.md" not in seen_skill_names:
                    desc = "Rules and instructions from workspace root RIE.md"
                    if "ws_rie" in skill_ids_from_config:
                        try:
                            with open(rie_path, "r", encoding="utf-8") as f:
                                preloaded_sections.append(f"### Skill: RIE.md\n{f.read().strip()}")
                        except Exception:
                            pass
                    else:
                        available_list.append(f"- **RIE.md**: {desc}")
                    seen_skill_names.add("rie.md")

        except Exception as exc:
            _logger.warning("Error building skills prompt: %s", exc)

        return preloaded_sections, available_list

    def _apply_skills_to_request(self, request: ModelRequest) -> ModelRequest:
        preloaded_sections, available_list = self._build_skills_sections(request)
        if not preloaded_sections and not available_list:
            return request

        sections: list[str] = []
        if preloaded_sections:
            sections.append(
                "## Active Skill Instructions (Pre-loaded)\n"
                "The following specialized skill guidelines are directly loaded and active for your task. "
                "Adhere to them immediately without calling `load_skill`:\n\n"
                + "\n\n".join(preloaded_sections)
            )

        if available_list:
            sections.append(
                "## Available Skills (Load on Demand)\n"
                "The following specialized procedural skills are available in your library. "
                "If your task requires detailed domain instructions or procedures for any of these, "
                "invoke the `load_skill` tool with the exact skill name to load its complete guidelines:\n"
                + "\n".join(available_list)
            )

        skills_addendum = "\n\n" + "\n\n".join(sections)
        new_content = list(request.system_message.content_blocks) + [
            {"type": "text", "text": skills_addendum}
        ]
        new_system_message = SystemMessage(content=new_content)
        return request.override(system_message=new_system_message)

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        modified_request = self._apply_skills_to_request(request)
        return handler(modified_request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        modified_request = self._apply_skills_to_request(request)
        return await handler(modified_request)


class MemoryRetrievalMiddleware(AgentMiddleware):
    """
    Middleware that automatically retrieves relevant long-term memories (facts, user identity, preferences)
    and pre-injects them directly into the system message for the current model turn.
    This eliminates extra LLM round-trips for routine memory retrieval while retaining LTM tools
    for explicit memory operations.
    """

    GREETING_TOKENS: frozenset[str] = frozenset({
        "hi", "gi", "hey", "hello", "hola", "howdy", "sup", "yo",
        "greetings", "good morning", "good evening", "good afternoon", "good night",
        "ok", "okay", "thanks", "thank you", "thx", "ty", "k",
        "bye", "goodbye", "cya", "see ya", "cool", "nice", "great",
        "yes", "no", "yep", "nope", "sure", "fine", "how are you",
        "what's up", "whats up"
    })

    @classmethod
    def _is_low_information_query(cls, query: str) -> bool:
        """Check if query is a simple greeting, acknowledgment, or non-informative short turn."""
        import re
        normalized = re.sub(r"[^\w\s]", "", query.strip().lower())
        if not normalized or len(normalized) <= 2:
            return True
        if normalized in cls.GREETING_TOKENS:
            return True
        words = normalized.split()
        if words and all(w in cls.GREETING_TOKENS for w in words):
            return True
        return False

    @staticmethod
    def _extract_query_text(messages: list[Any]) -> str:
        """Extract latest user query text from messages."""
        if not messages:
            return ""
        for msg in reversed(messages):
            role = getattr(msg, "type", "") or getattr(msg, "role", "")
            if role in ("human", "user"):
                content = getattr(msg, "content", "")
                if isinstance(content, str):
                    return content.strip()
                elif isinstance(content, list):
                    parts = [
                        p.get("text", "")
                        for p in content
                        if isinstance(p, dict) and p.get("type") == "text"
                    ]
                    return " ".join(parts).strip()
        return ""

    def _build_memory_context(self, request: ModelRequest) -> str:
        messages = getattr(request, "messages", []) or []
        query_text = self._extract_query_text(messages)
        if not query_text or self._is_low_information_query(query_text):
            return ""

        try:
            from app.memory import memory_store

            store = memory_store.get_store_sync()
            user_id = "default_user"
            namespace = ("users", user_id)

            items = list(store.search(namespace, query=query_text, limit=4))
            if not items:
                return ""

            is_explicit_identity_query = any(
                kw in query_text.lower()
                for kw in (
                    "who am i",
                    "my name",
                    "my preference",
                    "about me",
                    "remember me",
                    "what do you know about me",
                    "what did i tell you",
                )
            )

            recalled_facts = []
            for item in items:
                content = (item.value.get("content") or "").strip()
                cat = item.value.get("category", "general")
                score = item.metadata.get("score", 0.0) if hasattr(item, "metadata") else 0.0
                if content and (
                    score >= 0.60
                    or (is_explicit_identity_query and cat in ("profile", "personal_info", "identity", "preferences"))
                ):
                    recalled_facts.append(f"- {content} [category: {cat}]")

            if not recalled_facts:
                return ""

            return (
                "## Recalled Long-Term Memories (Proactive Context)\n"
                "The following facts about the user were automatically retrieved from long-term memory. "
                "Use them directly to personalize your response without needing to invoke `search_memory`:\n"
                + "\n".join(recalled_facts)
            )
        except Exception as e:
            _logger.warning("Error in MemoryRetrievalMiddleware: %s", e)
            return ""

    def _apply_memory_to_request(self, request: ModelRequest) -> ModelRequest:
        memory_ctx = self._build_memory_context(request)
        if not memory_ctx:
            return request

        new_content = list(request.system_message.content_blocks) + [
            {"type": "text", "text": "\n\n" + memory_ctx}
        ]
        new_system_message = SystemMessage(content=new_content)
        return request.override(system_message=new_system_message)

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        modified_request = self._apply_memory_to_request(request)
        return handler(modified_request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        modified_request = self._apply_memory_to_request(request)
        return await handler(modified_request)


@dataclass
class TaskContext:
    task_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    thread_id: str = "default_thread"
    objective: str = ""
    status: str = "running"  # "running", "completed", "budget_exhausted", "failed"
    step_number: int = 0
    max_steps: int = 15
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    completed_at: Optional[str] = None
    last_tool: Optional[str] = None
    last_error: Optional[str] = None

    # Granular Decision & Operational Metrics
    capability_resolution_ms: float = 0.0
    capabilities_considered: int = 0
    capabilities_selected: int = 0
    react_llm_round_trips: int = 0
    batch_step_count: int = 0
    approval_requests: int = 0
    approval_wait_ms: float = 0.0
    retry_count: int = 0
    fatal_failures: int = 0
    recoverable_failures: int = 0
    checkpoint_writes: int = 0
    checkpoint_restore_count: int = 0
    duplicate_action_preventions: int = 0


class TaskExecutionAccountingMiddleware(AgentMiddleware):
    """
    Middleware that manages TaskContext lifecycle, accounts for step budgets,
    logs granular step telemetry, enforces the tool-free Grace Call when
    the execution budget is reached, records full sanitized execution trajectories,
    classifies tool errors with bounded retries, and enforces HITL approval boundaries.
    """
    def __init__(self, max_steps: int = 15):
        super().__init__()
        self.max_steps = max_steps
        self.active_tasks: dict[str, TaskContext] = {}

    def get_or_create_context(self, thread_id: str, objective: str = "") -> TaskContext:
        if thread_id not in self.active_tasks:
            self.active_tasks[thread_id] = TaskContext(
                thread_id=thread_id,
                objective=objective,
                max_steps=self.max_steps
            )
        return self.active_tasks[thread_id]

    @staticmethod
    def _count_steps(messages: list[Any]) -> int:
        """Count assistant tool call turns in trajectory."""
        step_count = 0
        for msg in messages:
            if getattr(msg, "type", "") in ("ai", "assistant") or isinstance(msg, AIMessage):
                if getattr(msg, "tool_calls", None):
                    step_count += 1
        return step_count

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelResponse:
        return handler(request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        import time
        from langgraph.config import get_config
        config = None
        try:
            config = get_config()
        except Exception:
            pass

        thread_id = "default_thread"
        if config and "configurable" in config:
            thread_id = config["configurable"].get("thread_id", "default_thread")

        messages = getattr(request, "messages", []) or []
        step_num = self._count_steps(messages) + 1
        
        ctx = self.get_or_create_context(thread_id)
        ctx.step_number = step_num

        # Record task.started on initial turn
        if step_num == 1:
            trajectory_store.record_event(TaskEvent(
                task_id=ctx.task_id,
                thread_id=thread_id,
                event_type="task.started",
                step_number=step_num,
                status="running",
                metadata={"objective": ctx.objective or "user_query"}
            ))

        # Record model.started
        model_name = getattr(request.model, "model_name", getattr(request.model, "model", str(type(request.model).__name__)))
        trajectory_store.record_event(TaskEvent(
            task_id=ctx.task_id,
            thread_id=thread_id,
            event_type="model.started",
            step_number=step_num,
            model=model_name,
            status="running"
        ))

        # Check if budget is exhausted
        if step_num > ctx.max_steps:
            ctx.status = "budget_exhausted"
            _logger.info("[GraceCall] Execution budget reached (%d/%d steps) for task %s.", step_num - 1, ctx.max_steps, ctx.task_id)
            print(f"\n[GraceCall] (!) Execution budget reached ({step_num - 1}/{ctx.max_steps} steps) for task {ctx.task_id}.")
            print("[GraceCall] INVARIANT ENFORCED: Setting tools=[] (tool-free Grace Call).")

            grace_prompt = (
                "\n\n[EXECUTION BUDGET EXHAUSTED]\n"
                "You have reached your maximum execution budget. No more tools are available.\n"
                "Please provide a final summary stating:\n"
                "1. What actions/steps were completed\n"
                "2. What remaining steps were not finished\n"
                "3. Why execution stopped"
            )
            sys_msg = getattr(request, "system_message", None)
            new_content = list(sys_msg.content_blocks) if sys_msg else []
            new_content.append({"type": "text", "text": grace_prompt})

            override_req = request.override(
                tools=[],  # STRICT INVARIANT: Grace Call has NO tools
                system_message=SystemMessage(content=new_content)
            )

            t0 = time.time()
            resp = await handler(override_req)
            dur = time.time() - t0
            ctx.completed_at = datetime.now(timezone.utc).isoformat()
            
            trajectory_store.record_event(TaskEvent(
                task_id=ctx.task_id,
                thread_id=thread_id,
                event_type="task.budget_exhausted",
                step_number=step_num,
                duration=dur,
                status="budget_exhausted",
                metadata={"max_steps": ctx.max_steps}
            ))

            print(f"[Telemetry] task={ctx.task_id} thread={thread_id} step={step_num} (GRACE) duration={dur:.2f}s status={ctx.status}\n")
            return resp

        # Normal execution turn
        t0 = time.time()
        resp = await handler(request)
        dur = time.time() - t0

        ai_msg = getattr(resp, "result", getattr(resp, "message", resp))
        tool_calls = getattr(ai_msg, "tool_calls", []) or []
        
        # Record model.completed
        trajectory_store.record_event(TaskEvent(
            task_id=ctx.task_id,
            thread_id=thread_id,
            event_type="model.completed",
            step_number=step_num,
            model=model_name,
            duration=dur,
            status="ok",
            metadata={"tool_calls_count": len(tool_calls)}
        ))

        if tool_calls:
            tool_names = [tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "") for tc in tool_calls]
            ctx.last_tool = ", ".join(tool_names)
            ctx.status = "running"
            print(f"[Telemetry] task={ctx.task_id} thread={thread_id} step={step_num}/{ctx.max_steps} model_dur={dur:.2f}s dispatched_tools={tool_names}")
        else:
            ctx.status = "completed"
            ctx.completed_at = datetime.now(timezone.utc).isoformat()
            
            trajectory_store.record_event(TaskEvent(
                task_id=ctx.task_id,
                thread_id=thread_id,
                event_type="task.completed",
                step_number=step_num,
                duration=dur,
                status="completed"
            ))
            print(f"[Telemetry] task={ctx.task_id} thread={thread_id} step={step_num}/{ctx.max_steps} model_dur={dur:.2f}s status={ctx.status} (FINAL)")

        return resp

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Any],
    ) -> Any:
        import time
        tc = getattr(request, "tool_call", {}) or {}
        tool_name = tc.get("name", "unknown_tool")
        t0 = time.time()
        try:
            result = handler(request)
            dur = time.time() - t0
            print(f"[Telemetry] tool={tool_name} tool_dur={dur:.2f}s status=ok")
            return result
        except Exception as e:
            dur = time.time() - t0
            print(f"[Telemetry] tool={tool_name} tool_dur={dur:.2f}s status=error error={e}")
            raise

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[Any]],
    ) -> Any:
        import time
        import asyncio
        from langgraph.config import get_config
        config = None
        try:
            config = get_config()
        except Exception:
            pass

        thread_id = "default_thread"
        if config and "configurable" in config:
            thread_id = config["configurable"].get("thread_id", "default_thread")

        ctx = self.get_or_create_context(thread_id)
        tc = getattr(request, "tool_call", {}) or {}
        tool_name = tc.get("name", "unknown_tool")
        tool_args = tc.get("args", {}) or {}
        tool_call_id = tc.get("id", str(uuid.uuid4()))

        # 1. HITL Safety Approval Boundary Check
        approval_req = hitl_manager.is_approval_required(ctx.task_id, thread_id, tool_name, tool_args)
        if approval_req:
            trajectory_store.record_event(TaskEvent(
                task_id=ctx.task_id,
                thread_id=thread_id,
                event_type="approval.requested",
                step_number=ctx.step_number,
                tool_name=tool_name,
                tool_args=tool_args,
                status="awaiting_approval",
                metadata={"approval_id": approval_req.approval_id, "reason": approval_req.reason}
            ))
            print(f"\n[HITL] Approval required for '{tool_name}' (Approval ID: {approval_req.approval_id}). Suspending execution.", flush=True)
            return ToolMessage(
                content=f"[APPROVAL REQUIRED] Operation '{tool_name}' requires explicit user authorization (Approval ID: {approval_req.approval_id}). Execution suspended.",
                tool_call_id=tool_call_id
            )

        # 2. Record tool.started
        trajectory_store.record_event(TaskEvent(
            task_id=ctx.task_id,
            thread_id=thread_id,
            event_type="tool.started",
            step_number=ctx.step_number,
            tool_name=tool_name,
            tool_args=tool_args,
            status="running"
        ))

        # 3. Execution with Bounded Retry Policy for TRANSIENT errors
        retries = 0
        max_retries = 2
        while True:
            t0 = time.time()
            try:
                result = await handler(request)
                dur = time.time() - t0
                if isinstance(result, list):
                    extracted = [getattr(r, "content", r) for r in result]
                    result_content = extracted[0] if len(extracted) == 1 else extracted
                else:
                    result_content = getattr(result, "content", result)

                # Check if tool returned transient error output
                classification = classify_tool_error(tool_name, output=result_content)
                if classification.category == ErrorCategory.TRANSIENT and classification.retry_recommended and retries < max_retries:
                    retries += 1
                    trajectory_store.record_event(TaskEvent(
                        task_id=ctx.task_id,
                        thread_id=thread_id,
                        event_type="retry.decided",
                        step_number=ctx.step_number,
                        tool_name=tool_name,
                        duration=dur,
                        status="retrying",
                        error=classification.reason,
                        metadata={"retry_count": retries, "category": classification.category.value}
                    ))
                    print(f"[Telemetry] tool={tool_name} TRANSIENT failure, retrying ({retries}/{max_retries}) after {classification.backoff_seconds * retries:.1f}s backoff...", flush=True)
                    await asyncio.sleep(classification.backoff_seconds * retries)
                    continue

                # Record tool.completed
                trajectory_store.record_event(TaskEvent(
                    task_id=ctx.task_id,
                    thread_id=thread_id,
                    event_type="tool.completed",
                    step_number=ctx.step_number,
                    tool_name=tool_name,
                    tool_args=tool_args,
                    tool_result=result_content,
                    duration=dur,
                    status="ok"
                ))
                print(f"[Telemetry] tool={tool_name} tool_dur={dur:.2f}s status=ok")
                return result

            except Exception as e:
                dur = time.time() - t0
                classification = classify_tool_error(tool_name, error=e)

                if classification.category == ErrorCategory.TRANSIENT and classification.retry_recommended and retries < max_retries:
                    retries += 1
                    trajectory_store.record_event(TaskEvent(
                        task_id=ctx.task_id,
                        thread_id=thread_id,
                        event_type="retry.decided",
                        step_number=ctx.step_number,
                        tool_name=tool_name,
                        duration=dur,
                        status="retrying",
                        error=str(e),
                        metadata={"retry_count": retries, "category": classification.category.value}
                    ))
                    print(f"[Telemetry] tool={tool_name} TRANSIENT exception ({e}), retrying ({retries}/{max_retries})...", flush=True)
                    await asyncio.sleep(classification.backoff_seconds * retries)
                    continue

                # Fatal or unretryable tool failure
                trajectory_store.record_event(TaskEvent(
                    task_id=ctx.task_id,
                    thread_id=thread_id,
                    event_type="tool.failed",
                    step_number=ctx.step_number,
                    tool_name=tool_name,
                    tool_args=tool_args,
                    duration=dur,
                    status="error",
                    error=str(e),
                    metadata={"category": classification.category.value, "fatal": classification.category == ErrorCategory.FATAL}
                ))
                print(f"[Telemetry] tool={tool_name} tool_dur={dur:.2f}s status=error error={e} category={classification.category.value}")
                raise


class AgentManager:
    """Manages the Deep Agent instance"""
    
    def __init__(self):
        self._agent: Optional[object] = None
        self._llm: Optional[object] = None
        self._current_stream: Optional[Generator] = None
        self._checkpointer: Optional[Any] = None
        self._checkpointer_cm: Optional[Any] = None
        self._checkpointer_pool: Optional[Any] = None
        self._init_lock = asyncio.Lock()
        self._active_tasks: dict[str, asyncio.Task] = {}
        self._store: Optional[Any] = None
        self._current_chat_mode: Optional[str] = None
        self._current_speed_mode: Optional[str] = None
        self._peer_inbound_cache: "OrderedDict[tuple[Any, ...], Any]" = OrderedDict()
        self._peer_cache_max: int = 16

    async def _ensure_checkpoint_and_store(self) -> None:
        if not self._checkpointer:
            pg_url = settings.LANGGRAPH_DATABASE_URL

            # Fail-fast in production if PostgreSQL is not configured
            if settings.IS_PRODUCTION and not pg_url:
                raise RuntimeError(
                    "Production environment detected, but 'LANGGRAPH_DATABASE_URL' is not configured. "
                    "A dedicated PostgreSQL instance is required in production to support async concurrent checkpointing without SQLite lock contention."
                )

            if pg_url:
                from psycopg_pool import AsyncConnectionPool
                from psycopg.rows import dict_row
                from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

                safe_url = pg_url.split("@")[-1] if "@" in pg_url else "configured PostgreSQL"
                _logger.info("Initializing LangGraph AsyncPostgresSaver with AsyncConnectionPool on %s", safe_url)

                pool = AsyncConnectionPool(
                    conninfo=pg_url,
                    max_size=settings.LANGGRAPH_DB_POOL_MAX_SIZE,
                    kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row}
                )
                await pool.open()
                self._checkpointer_pool = pool
                self._checkpointer = AsyncPostgresSaver(conn=pool)
                await self._checkpointer.setup()
                print(f"DEBUG [Checkpointer]: Initialized PostgreSQL pool saver id={id(self._checkpointer)} for pid={os.getpid()}")
            else:
                import aiosqlite
                if not hasattr(aiosqlite.Connection, "is_alive"):
                    def is_alive(self):
                        return True
                    aiosqlite.Connection.is_alive = is_alive
                db_path = get_checkpoint_db_path()
                try:
                    import sqlite3
                    with sqlite3.connect(db_path, timeout=30.0) as _cp_conn:
                        _cp_conn.execute("PRAGMA journal_mode=WAL;")
                        _cp_conn.execute("PRAGMA busy_timeout=30000;")
                        _cp_conn.execute("PRAGMA synchronous=NORMAL;")
                except Exception as _e:
                    _logger.warning("Failed to configure PRAGMAs on checkpoints.db: %s", _e)

                self._checkpointer_cm = AsyncSqliteSaver.from_conn_string(db_path)
                self._checkpointer = await self._checkpointer_cm.__aenter__()
                try:
                    await self._checkpointer.conn.execute("PRAGMA busy_timeout=30000;")
                    await self._checkpointer.conn.execute("PRAGMA journal_mode=WAL;")
                    await self._checkpointer.conn.execute("PRAGMA synchronous=NORMAL;")
                except Exception:
                    pass
                print(f"DEBUG [Checkpointer]: Initialized SQLite saver id={id(self._checkpointer)} for pid={os.getpid()} on {db_path}")

        if not self._store:
            self._store = await memory_store.get_store()

    async def shutdown(self) -> None:
        """Clean up checkpointer connection / pool on application shutdown."""
        if self._checkpointer_pool is not None:
            try:
                await self._checkpointer_pool.close()
                print(f"DEBUG [Checkpointer]: Closed PostgreSQL connection pool id={id(self._checkpointer_pool)}")
            except Exception as e:
                _logger.warning("Error closing PostgreSQL connection pool on shutdown: %s", e)
            finally:
                self._checkpointer_pool = None
                self._checkpointer = None

        if self._checkpointer_cm is not None:
            try:
                await self._checkpointer_cm.__aexit__(None, None, None)
                print(f"DEBUG [Checkpointer]: Closed SQLite checkpointer saver id={id(self._checkpointer)}")
            except Exception as e:
                _logger.warning("Error closing SQLite checkpointer on shutdown: %s", e)
            finally:
                self._checkpointer = None
                self._checkpointer_cm = None

    async def _async_load_all_tools_map(self) -> dict[str, Any]:
        """Runtime tool registry (baseline + MCP + external), for peer inbound policy."""
        all_tools_map: dict[str, Any] = {
            "internet_search": internet_search,
            "schedule_chat_task": schedule_chat_task_tool,
            "remote_friend_ask": remote_friend_ask_tool,
            "read_knowledge_asset": read_knowledge_asset,
            "load_skill": load_skill,
            **{t.name: t for t in LANGGRAPH_BROWSER_TOOLS},
            **WINDOWS_TOOLS,
            **{t.name: t for t in LTM_TOOLS},
            **{t.name: t for t in MCP_REGISTRY_TOOLS},
        }
        try:
            loaded_mcp_tools = await mcp_manager.refresh_tools()
            if loaded_mcp_tools:
                print(f"DEBUG: Peer tool map integrated {len(loaded_mcp_tools)} MCP tools")
        except Exception as e:
            print(f"ERROR: Failed to load MCP tools for peer map: {e}")
            loaded_mcp_tools = []
        try:
            loaded_external_tools = get_external_tools(settings.EXTERNAL_APIS) or []
        except Exception as e:
            print(f"ERROR: Failed to load external tools for peer map: {e}")
            loaded_external_tools = []
        try:
            loaded_plugin_tools = await plugin_manager.refresh_tools() or []
            if loaded_plugin_tools:
                print(f"DEBUG: Peer tool map integrated {len(loaded_plugin_tools)} plugin tools")
        except Exception as e:
            print(f"ERROR: Failed to load plugin tools for peer map: {e}")
            loaded_plugin_tools = []
        for tool in loaded_mcp_tools + loaded_external_tools + loaded_plugin_tools:
            tool_name = getattr(tool, "name", None)
            if tool_name:
                all_tools_map[tool_name] = tool
        return all_tools_map

    def _resolve_provider(self) -> str:
        """Resolve LLM provider from settings, defaulting to Rie."""
        provider = settings.LLM_PROVIDER
        if not provider:
            provider = "rie"
            if settings.GROQ_API_KEY:
                provider = "groq"
            elif settings.VERTEX_PROJECT:
                provider = "vertex"
            elif settings.GOOGLE_API_KEY:
                provider = "gemini"
            elif settings.OPENAI_API_KEY:
                provider = "openai"
            elif settings.DEEPSEEK_API_KEY:
                provider = "deepseek"
            elif settings.GLM_API_KEY:
                provider = "glm"
        return provider

    def _create_llm_for_peer(self) -> Optional[BaseChatModel]:
        """Instantiate LLM for peer sessions (does not mutate self._llm)."""
        provider = self._resolve_provider()
        llm = self._create_llm_by_provider(provider, speed_mode="flash")
        if not llm:
            print("ERROR: No valid LLM provider selected or configured for peer inbound.")
        return llm

    def _peer_system_prompt(self, receive_profile: str) -> str:
        eff = "chat" if receive_profile == "chat" else "agent"
        mode_instructions = ""
        if eff == "chat":
            mode_instructions += (
                "\n- CURRENT MODE: Chat Mode. You are acting as a conversational assistant. "
                "Keep answers concise. Do not attempt complex multi-step technical workflows unless requested."
            )
        else:
            mode_instructions += (
                "\n- CURRENT MODE: Agent Mode. You are acting as an autonomous technical agent. "
                "Use your tools extensively to accomplish the user's goal."
            )
        mode_instructions += "\n- SPEED: Flash. Provide immediate answers. Do not output internal thinking or plans."
        planner_graph = settings.SUBAGENT_PLANNER_GRAPH or {}
        planner_main_instruction = str(planner_graph.get("main_instruction", "")).strip()
        planner_main_section = ""
        if planner_main_instruction:
            planner_main_section = (
                "\n\n[Planner Main Instruction]\n"
                f"{planner_main_instruction}\n"
                "[End Planner Main Instruction]"
            )
        peer_note = (
            "\n\n[Inbound linked device] You are replying to a request from another paired Rie install. "
            "Use only the tools available in this session."
        )
        return SYSTEM_PROMPT + mode_instructions + planner_main_section + peer_note

    def _lru_peer_put(self, key: tuple[Any, ...], agent: Any) -> None:
        if key in self._peer_inbound_cache:
            del self._peer_inbound_cache[key]
        self._peer_inbound_cache[key] = agent
        while len(self._peer_inbound_cache) > self._peer_cache_max:
            self._peer_inbound_cache.popitem(last=False)

    async def _get_or_create_peer_inbound_agent(
        self,
        receive_profile: str,
        effective_tool_ids: List[str],
        tools_to_use: List[Any],
    ) -> Any:
        cache_key = (receive_profile, tuple(effective_tool_ids))
        if cache_key in self._peer_inbound_cache:
            self._peer_inbound_cache.move_to_end(cache_key)
            return self._peer_inbound_cache[cache_key]

        llm = self._create_llm_for_peer()
        if not llm:
            raise RuntimeError("Agent not configured. Please check your API keys and try again.")

        system_prompt = self._peer_system_prompt(receive_profile)
        middleware_stack = [
            ToolNeedMiddleware(),
            ContextProjectionMiddleware(),
            SummarizationMiddleware(
                model=llm,
                trigger=("tokens", 8000),
                keep=("messages", 20),
                summary_prompt="""Summarize the conversation history. 
                            1. EXPLICITLY preserve all file paths (e.g., /src/main.py).
                            2. EXPLICITLY preserve class names and function names.
                            3. Maintain a bulleted list of 'Tasks Completed' and 'Remaining Work'.
                            4. Do not include actual code blocks in the summary, just describe what was modified.
                            
                            Messages to summarize:
                            {messages}""",
            )
        ]
        peer_agent = create_agent(
            model=llm,
            tools=tools_to_use,
            system_prompt=system_prompt,
            debug=True,
            checkpointer=self._checkpointer,
            store=self._store,
            context_schema=Context,
            middleware=middleware_stack,
        )
        self._lru_peer_put(cache_key, peer_agent)
        return peer_agent

    async def invoke_peer_inbound(
        self,
        *,
        messages: Optional[list] = None,
        thread_id: Optional[str] = None,
        receive_profile: str = "chat",
        effective_tool_ids: Optional[List[str]] = None,
        memory_user_id: str = "default_user",
        client_timezone: Optional[str] = None,
        client_local_datetime_iso: Optional[str] = None,
        client_latitude: Optional[float] = None,
        client_longitude: Optional[float] = None,
        client_location_accuracy_m: Optional[float] = None,
    ) -> dict:
        """Run an inbound peer /connectivity/peer/receive turn with a cached per-policy agent."""
        await self._ensure_checkpoint_and_store()
        ids = effective_tool_ids or []
        tools_map = await self._async_load_all_tools_map()
        tools_to_use: List[Any] = []
        for tid in ids:
            t = tools_map.get(tid)
            if t is not None:
                tools_to_use.append(t)
        if not tools_to_use:
            raise RuntimeError(
                "Peer policy allows no usable tools. Adjust Connectivity access for this friend."
            )

        peer_agent = await self._get_or_create_peer_inbound_agent(
            receive_profile, ids, tools_to_use
        )

        config: dict = {"configurable": {}}
        if thread_id:
            config["configurable"]["thread_id"] = thread_id

        context = Context(user_id=memory_user_id)

        input_data: Any = None
        if messages is not None:
            device_ctx = _client_device_system_content(
                client_timezone,
                client_local_datetime_iso,
                client_latitude,
                client_longitude,
                client_location_accuracy_m,
            )
            if device_ctx:
                input_data = {"messages": [{"role": "system", "content": device_ctx}, *messages]}
            else:
                input_data = {"messages": messages}

        eff_chat = "chat" if receive_profile == "chat" else "agent"
        tokens = set_agent_context(
            thread_id,
            eff_chat,
            "flash",
            friend_target_id=None,
            friend_target_name=None,
        )
        try:
            return await peer_agent.ainvoke(input_data, config=config, context=context)
        finally:
            reset_agent_context(tokens)

    async def stream_peer_inbound(
        self,
        *,
        messages: Optional[list] = None,
        thread_id: Optional[str] = None,
        receive_profile: str = "chat",
        effective_tool_ids: Optional[List[str]] = None,
        memory_user_id: str = "default_user",
        client_timezone: Optional[str] = None,
        client_local_datetime_iso: Optional[str] = None,
        client_latitude: Optional[float] = None,
        client_longitude: Optional[float] = None,
        client_location_accuracy_m: Optional[float] = None,
    ) -> AsyncIterator[dict]:
        """Stream an inbound peer turn with policy-scoped tools."""
        await self._ensure_checkpoint_and_store()
        ids = effective_tool_ids or []
        tools_map = await self._async_load_all_tools_map()
        tools_to_use: List[Any] = []
        for tid in ids:
            t = tools_map.get(tid)
            if t is not None:
                tools_to_use.append(t)
        if not tools_to_use:
            raise RuntimeError(
                "Peer policy allows no usable tools. Adjust Connectivity access for this friend."
            )

        peer_agent = await self._get_or_create_peer_inbound_agent(
            receive_profile, ids, tools_to_use
        )

        config = {"configurable": {}}
        if thread_id:
            config["configurable"]["thread_id"] = thread_id

        input_data: Any = None
        if messages is not None:
            device_ctx = _client_device_system_content(
                client_timezone,
                client_local_datetime_iso,
                client_latitude,
                client_longitude,
                client_location_accuracy_m,
            )
            if device_ctx:
                input_data = {"messages": [{"role": "system", "content": device_ctx}, *messages]}
            else:
                input_data = {"messages": messages}

        context = Context(user_id=memory_user_id)
        stream_modes = ["updates", "messages"]
        stream_gen = peer_agent.astream(
            input_data,
            config=config,
            context=context,
            stream_mode=stream_modes,
        )

        logger = logging.getLogger(__name__)
        current_task = asyncio.current_task()
        if thread_id and current_task:
            self._active_tasks[thread_id] = current_task

        eff_chat = "chat" if receive_profile == "chat" else "agent"
        tokens = set_agent_context(
            thread_id,
            eff_chat,
            "flash",
            friend_target_id=None,
            friend_target_name=None,
        )
        try:
            async for chunk in stream_gen:
                if isinstance(chunk, tuple):
                    if len(chunk) == 3:
                        _stream_ns, mode, payload = chunk
                    elif len(chunk) == 2:
                        mode, payload = chunk
                    else:
                        continue

                    if mode == "updates":
                        if isinstance(payload, dict):
                            yield payload
                    elif mode == "messages":
                        yield {"__lg_messages__": payload}
                    continue

                if isinstance(chunk, dict):
                    yield chunk
        except asyncio.CancelledError:
            logger.info("Peer inbound stream cancelled for thread_id=%s", thread_id)
            raise
        except APIConnectionError as e:
            raise RuntimeError("upstream_connection_error") from e
        except httpx.ConnectError as e:
            raise RuntimeError("upstream_connection_error") from e
        finally:
            if thread_id in self._active_tasks:
                del self._active_tasks[thread_id]
            reset_agent_context(tokens)

    def _get_reasoning_effort(self, speed_mode: str = "thinking") -> Optional[str]:
        """Returns 'high' for thinking mode, or None (disabled) for flash mode."""
        if speed_mode == "flash":
            return None
        return "high"

    def _create_llm_by_provider(self, provider: str, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create an LLM instance by provider name and speed mode."""
        if provider == "vertex":
            return self._create_vertex_llm(speed_mode=speed_mode)
        elif provider == "gemini":
            return self._create_gemini_llm(speed_mode=speed_mode)
        elif provider == "groq":
            return self._create_groq_llm(speed_mode=speed_mode)
        elif provider == "openai":
            return self._create_openai_llm(speed_mode=speed_mode)
        elif provider == "deepseek":
            return self._create_deepseek_llm(speed_mode=speed_mode)
        elif provider == "glm":
            return self._create_glm_llm(speed_mode=speed_mode)
        elif provider == "rie":
            return self._create_rie_llm(speed_mode=speed_mode)
        elif provider == "ollama":
            return self._create_ollama_llm(speed_mode=speed_mode)
        return None

    def _create_groq_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return a Groq LLM instance (potentially rotating)"""
        keys = settings.GROQ_API_KEYS
        if not keys:
            print("ERROR: No Groq API keys configured")
            return None
        
        reasoning_effort = self._get_reasoning_effort(speed_mode)

        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatGroq with {len(keys)} keys (reasoning_effort={reasoning_effort})")
                llm = RotatingChatGroq(
                    api_keys=keys,
                    model=settings.GROQ_MODEL,
                    temperature=0,
                    reasoning_effort=reasoning_effort,
                )
            else:
                from langchain_groq import ChatGroq
                kwargs = {
                    "api_key": keys[0],
                    "model": settings.GROQ_MODEL,
                    "temperature": 0,
                    "reasoning_format": "parsed",
                }
                if reasoning_effort:
                    kwargs["reasoning_effort"] = reasoning_effort
                try:
                    llm = ChatGroq(**kwargs)
                except Exception as e:
                    print(f"DEBUG: Fallback without reasoning params for ChatGroq: {e}")
                    kwargs.pop("reasoning_effort", None)
                    kwargs.pop("reasoning_format", None)
                    llm = ChatGroq(**kwargs)
            print(f"DEBUG: Groq LLM created successfully with model: {settings.GROQ_MODEL} (reasoning_effort={reasoning_effort})")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Groq LLM: {e}")
            import traceback
            traceback.print_exc()
            return None

    # Backward-compatibility alias
    _create_llm = _create_groq_llm

    def _create_gemini_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return a direct Gemini LLM instance (Generative AI API)"""
        keys = settings.GOOGLE_API_KEYS
        if not keys:
            print("ERROR: GOOGLE_API_KEY is not set")
            return None

        reasoning_effort = self._get_reasoning_effort(speed_mode)

        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatGoogleGenerativeAI with {len(keys)} keys (reasoning_effort={reasoning_effort})")
                llm = RotatingChatGoogleGenerativeAI(
                    api_keys=keys,
                    model=settings.GEMINI_MODEL,
                    temperature=0,
                    reasoning_effort=reasoning_effort,
                )
            else:
                SafeCls = _get_safe_chat_google_generative_ai_cls()
                kwargs = {
                    "google_api_key": keys[0],
                    "model": settings.GEMINI_MODEL,
                    "temperature": 0,
                }
                if reasoning_effort:
                    kwargs["include_thoughts"] = True
                    kwargs["thinking_budget"] = -1
                else:
                    kwargs["include_thoughts"] = False
                    kwargs["thinking_budget"] = 0
                try:
                    llm = SafeCls(**kwargs)
                except Exception as e:
                    print(f"DEBUG: Fallback without thinking kwargs for SafeChatGoogleGenerativeAI: {e}")
                    kwargs.pop("include_thoughts", None)
                    kwargs.pop("thinking_budget", None)
                    llm = SafeCls(**kwargs)
            print(f"DEBUG: Gemini LLM (Generative AI API) created successfully with model: {settings.GEMINI_MODEL} (reasoning_effort={reasoning_effort})")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Gemini LLM: {e}")
            import traceback
            traceback.print_exc()
            return None

    def _create_vertex_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return a Vertex AI (Gemini) LLM instance"""
        if settings.VERTEX_CREDENTIALS_PATH:
             import os
             os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = settings.VERTEX_CREDENTIALS_PATH
             
        if not settings.VERTEX_PROJECT:
            print("ERROR: VERTEX_PROJECT is not set")
            if not settings.VERTEX_CREDENTIALS_PATH:
                return None

        reasoning_effort = self._get_reasoning_effort(speed_mode)

        try:
            from langchain_google_vertexai import ChatVertexAI
            kwargs = {
                "model": settings.VERTEX_MODEL,
                "project": settings.VERTEX_PROJECT,
                "location": settings.VERTEX_LOCATION,
                "temperature": 0,
            }
            if reasoning_effort:
                kwargs["reasoning_effort"] = reasoning_effort
            try:
                llm = ChatVertexAI(**kwargs)
            except Exception as e:
                print(f"DEBUG: Fallback without reasoning_effort for ChatVertexAI: {e}")
                kwargs.pop("reasoning_effort", None)
                llm = ChatVertexAI(**kwargs)
            print(
                f"DEBUG: Vertex AI LLM created successfully with model: {settings.VERTEX_MODEL}, "
                f"project: {settings.VERTEX_PROJECT}, location: {settings.VERTEX_LOCATION} (reasoning_effort={reasoning_effort})"
            )
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Vertex AI LLM: {e}")
            return None

    def _create_openai_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return an OpenAI LLM instance (compatible with Z.ai, potentially rotating)"""
        keys = settings.OPENAI_API_KEYS
        if not keys:
            print("ERROR: No OpenAI API keys configured")
            return None

        reasoning_effort = self._get_reasoning_effort(speed_mode)

        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatOpenAI with {len(keys)} keys (reasoning_effort={reasoning_effort})")
                llm = RotatingChatOpenAI(
                    api_keys=keys,
                    model=settings.OPENAI_MODEL,
                    base_url=settings.OPENAI_BASE_URL,
                    temperature=0.7,
                    reasoning_effort=reasoning_effort,
                )
            else:
                from langchain_openai import ChatOpenAI
                kwargs = {
                    "model_name": settings.OPENAI_MODEL,
                    "openai_api_key": keys[0],
                    "base_url": settings.OPENAI_BASE_URL,
                    "temperature": 0.7,
                    "stream_usage": True,
                }
                if reasoning_effort:
                    kwargs["reasoning_effort"] = reasoning_effort
                try:
                    llm = ChatOpenAI(**kwargs)
                except Exception as e:
                    print(f"DEBUG: Fallback without reasoning_effort for ChatOpenAI: {e}")
                    kwargs.pop("reasoning_effort", None)
                    llm = ChatOpenAI(**kwargs)
            print(f"DEBUG: OpenAI LLM created successfully with model: {settings.OPENAI_MODEL} and base_url: {settings.OPENAI_BASE_URL} (reasoning_effort={reasoning_effort})")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create OpenAI LLM: {e}")
            return None

    def _create_deepseek_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return a DeepSeek LLM instance (OpenAI-compatible, potentially rotating)"""
        keys = settings.DEEPSEEK_API_KEYS
        if not keys:
            print("ERROR: No DeepSeek API keys configured")
            return None

        reasoning_effort = self._get_reasoning_effort(speed_mode)

        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatOpenAI for DeepSeek with {len(keys)} keys (reasoning_effort={reasoning_effort})")
                llm = RotatingChatOpenAI(
                    api_keys=keys,
                    model=settings.DEEPSEEK_MODEL,
                    base_url=settings.DEEPSEEK_BASE_URL,
                    temperature=0.7,
                    reasoning_effort=reasoning_effort,
                    provider_name="deepseek",
                )
            else:
                from langchain_openai import ChatOpenAI
                kwargs = {
                    "model_name": settings.DEEPSEEK_MODEL,
                    "openai_api_key": keys[0],
                    "base_url": settings.DEEPSEEK_BASE_URL,
                    "temperature": 0.7,
                    "stream_usage": True,
                }
                if reasoning_effort:
                    kwargs["reasoning_effort"] = reasoning_effort
                try:
                    llm = ChatOpenAI(**kwargs)
                except Exception as e:
                    print(f"DEBUG: Fallback without reasoning_effort for ChatOpenAI (DeepSeek): {e}")
                    kwargs.pop("reasoning_effort", None)
                    llm = ChatOpenAI(**kwargs)
            print(f"DEBUG: DeepSeek LLM created successfully with model: {settings.DEEPSEEK_MODEL} and base_url: {settings.DEEPSEEK_BASE_URL} (reasoning_effort={reasoning_effort})")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create DeepSeek LLM: {e}")
            return None

    def _create_glm_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return a GLM (Zhipu AI) LLM instance (OpenAI-compatible, potentially rotating)"""
        keys = settings.GLM_API_KEYS
        if not keys:
            print("ERROR: No GLM API keys configured")
            return None

        reasoning_effort = self._get_reasoning_effort(speed_mode)

        try:
            if len(keys) > 1:
                print(f"DEBUG: Creating RotatingChatOpenAI for GLM with {len(keys)} keys (reasoning_effort={reasoning_effort})")
                llm = RotatingChatOpenAI(
                    api_keys=keys,
                    model=settings.GLM_MODEL,
                    base_url=settings.GLM_BASE_URL,
                    temperature=0.7,
                    reasoning_effort=reasoning_effort,
                    provider_name="glm",
                )
            else:
                from langchain_openai import ChatOpenAI
                kwargs = {
                    "model_name": settings.GLM_MODEL,
                    "openai_api_key": keys[0],
                    "base_url": settings.GLM_BASE_URL,
                    "temperature": 0.7,
                    "stream_usage": True,
                }
                if reasoning_effort:
                    kwargs["reasoning_effort"] = reasoning_effort
                try:
                    llm = ChatOpenAI(**kwargs)
                except Exception as e:
                    print(f"DEBUG: Fallback without reasoning_effort for ChatOpenAI (GLM): {e}")
                    kwargs.pop("reasoning_effort", None)
                    llm = ChatOpenAI(**kwargs)
            print(f"DEBUG: GLM LLM created successfully with model: {settings.GLM_MODEL} and base_url: {settings.GLM_BASE_URL} (reasoning_effort={reasoning_effort})")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create GLM LLM: {e}")
            return None

    def _create_rie_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return a Rie LLM instance (OpenAI compatible)"""
        reasoning_effort = self._get_reasoning_effort(speed_mode)
        try:
            from langchain_openai import ChatOpenAI
            kwargs = {
                "model_name": settings.RIE_MODEL,
                "openai_api_key": settings.RIE_ACCESS_TOKEN,
                "base_url": settings.RIE_API_URL,
                "temperature": 0.7,
                "stream_usage": True,
            }
            if reasoning_effort:
                kwargs["reasoning_effort"] = reasoning_effort
            try:
                llm = ChatOpenAI(**kwargs)
            except Exception:
                kwargs.pop("reasoning_effort", None)
                llm = ChatOpenAI(**kwargs)
            print(f"DEBUG: Rie LLM created successfully with model: {settings.RIE_MODEL} at {settings.RIE_API_URL} (reasoning_effort={reasoning_effort})")
            return llm
        except Exception as e:
            print(f"ERROR: Failed to create Rie LLM: {e}")
            return None

    def _create_ollama_llm(self, speed_mode: str = "thinking") -> Optional[BaseChatModel]:
        """Create and return an Ollama LLM instance (via OpenAI-compatible bridge for stability)"""
        if not settings.OLLAMA_MODEL:
            print("ERROR: No Ollama model selected")
            return None
        reasoning_effort = self._get_reasoning_effort(speed_mode)
        try:
            from langchain_openai import ChatOpenAI
            api_key = settings.OLLAMA_API_KEY or "ollama"
            kwargs = {
                "model_name": settings.OLLAMA_MODEL,
                "openai_api_key": api_key,
                "base_url": f"{settings.OLLAMA_API_URL.rstrip('/')}/v1",
                "temperature": 0.7,
                "stream_usage": True,
            }
            if reasoning_effort:
                kwargs["reasoning_effort"] = reasoning_effort
            try:
                llm = ChatOpenAI(**kwargs)
            except Exception:
                kwargs.pop("reasoning_effort", None)
                llm = ChatOpenAI(**kwargs)
            print(f"DEBUG: Ollama LLM created successfully using OpenAI bridge with model: {settings.OLLAMA_MODEL} at {settings.OLLAMA_API_URL}/v1 (reasoning_effort={reasoning_effort})")
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
                "system_prompt": "You are a coding specialist. You have direct access to the files. Always select the most specific dedicated tools for viewing, editing, or searching files over writing raw terminal scripts. Since the host OS is Windows, when running terminal commands, you MUST use native PowerShell/Windows commands rather than Linux commands (e.g. use type/Get-Content instead of cat, echo/New-Item instead of touch, and backslashes for all paths).",
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

            # Ensure core system tools like read_knowledge_asset and load_skill are available to subagents
            if "read_knowledge_asset" in all_tools_map and all_tools_map["read_knowledge_asset"] not in resolved_tools:
                resolved_tools.append(all_tools_map["read_knowledge_asset"])
            if "load_skill" in all_tools_map and all_tools_map["load_skill"] not in resolved_tools:
                resolved_tools.append(all_tools_map["load_skill"])

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
        
        # Ensure singleton checkpointer and LTM store are initialized
        await self._ensure_checkpoint_and_store()

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
            "ask_question": ask_question,
            "schedule_chat_task": schedule_chat_task_tool,
            "remote_friend_ask": remote_friend_ask_tool,
            "read_knowledge_asset": read_knowledge_asset,
            "load_skill": load_skill,
            **{t.name: t for t in LANGGRAPH_BROWSER_TOOLS},
            **WINDOWS_TOOLS,
            **{t.name: t for t in LTM_TOOLS},
            **{t.name: t for t in MCP_REGISTRY_TOOLS},
        }
        loaded_mcp_tools: list[Any] = []
        loaded_external_tools: list[Any] = []

        # Select LLM based on provider setting
        provider = self._resolve_provider()
        print(f"DEBUG: Selected LLM Provider: {provider}")

        # Resolve effective modes early (used by prompt construction and tool policy).
        effective_chat_mode = chat_mode or "agent"
        if provider == "rie":
            effective_chat_mode = "chat"
            
        effective_speed_mode = speed_mode or "thinking"
        orchestration_mode = settings.AGENT_ORCHESTRATION_MODE
        self._current_chat_mode = effective_chat_mode
        self._current_speed_mode = effective_speed_mode

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

        final_system_prompt = (
            BASE_SYSTEM_PROMPT.strip()
            + mode_instructions
            + (planner_main_section if effective_chat_mode != "chat" else "")
        )

        system_prompt = final_system_prompt

        primary_llm = self._create_llm_by_provider(provider, speed_mode=effective_speed_mode)
        
        fallback_provider = settings.FALLBACK_LLM_PROVIDER
        fallback_llm = None
        if fallback_provider and fallback_provider != provider:
            fallback_llm = self._create_llm_by_provider(fallback_provider, speed_mode=effective_speed_mode)
            
        if primary_llm and fallback_llm:
            print(f"DEBUG: Creating FallbackChatModel with primary: {provider}, fallback: {fallback_provider}")
            self._llm = FallbackChatModel(primary_model=primary_llm, fallback_model=fallback_llm)
        elif primary_llm:
            self._llm = primary_llm
        elif fallback_llm:
            print(f"WARNING: Primary LLM provider ({provider}) failed to initialize. Falling back to {fallback_provider}.")
            self._llm = fallback_llm
        else:
            print(f"ERROR: Failed to create LLM for provider {provider} (and no fallback succeeded).")
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

        # Load Connected Integration Plugin Tools
        try:
            loaded_plugin_tools = await plugin_manager.refresh_tools() or []
            if loaded_plugin_tools:
                print(f"DEBUG: Integrated {len(loaded_plugin_tools)} integration plugin tools")
        except Exception as e:
            print(f"ERROR: Failed to load integration plugin tools: {e}")
            loaded_plugin_tools = []

        for tool in loaded_mcp_tools + loaded_external_tools + loaded_plugin_tools:
            tool_name = getattr(tool, "name", None)
            if tool_name:
                all_tools_map[tool_name] = tool

        # Register Programmatic Batched Execution Tool
        all_tools_map["execute_batched_plan"] = execute_batched_plan
        batched_tool_registry.clear()
        batched_tool_registry.update(all_tools_map)

        # Populate Dynamic Capability Resolver
        try:
            capability_resolver.populate_from_runtime(
                base_tools=list(all_tools_map.values()),
                plugins={"gmail": loaded_plugin_tools},
                mcp_tools=loaded_mcp_tools,
                user_apis=loaded_external_tools
            )
        except Exception as e:
            _logger.warning("Failed to populate capability resolver: %s", e)

        def _resolve_tools_from_ids(tool_ids: list[str]) -> list[Any]:
            resolved: list[Any] = []
            seen: set[str] = set()
            expanded_tool_ids = list(tool_ids)
            # Expand legacy scrape_web or browser_open to full browser tool suite
            if any(t in expanded_tool_ids for t in ("scrape_web", "browser_open", "browser_snapshot")):
                for bt in LANGGRAPH_BROWSER_TOOLS:
                    if bt.name not in expanded_tool_ids:
                        expanded_tool_ids.append(bt.name)

            for tool_id in expanded_tool_ids:
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
            # Chat mode: internet_search + ask_question + LTM + scheduling + knowledge tool + connected plugins
            tools_to_use = []
            if "internet_search" in all_tools_map:
                tools_to_use.append(all_tools_map["internet_search"])
            if "ask_question" in all_tools_map:
                tools_to_use.append(all_tools_map["ask_question"])
            if "schedule_chat_task" in all_tools_map:
                tools_to_use.append(all_tools_map["schedule_chat_task"])
            if "remote_friend_ask" in all_tools_map:
                tools_to_use.append(all_tools_map["remote_friend_ask"])
            if "read_knowledge_asset" in all_tools_map:
                tools_to_use.append(all_tools_map["read_knowledge_asset"])
            if "load_skill" in all_tools_map:
                tools_to_use.append(all_tools_map["load_skill"])
            tools_to_use.extend(LTM_TOOLS)
            # Include connected plugin tools so DynamicToolRoutingMiddleware can route them when requested
            existing_tool_names = {getattr(x, "name", getattr(x, "__name__", str(x))) for x in tools_to_use}
            for extra_tool in loaded_plugin_tools:
                t_name = getattr(extra_tool, "name", getattr(extra_tool, "__name__", str(extra_tool)))
                if t_name and t_name not in existing_tool_names:
                    tools_to_use.append(extra_tool)
                    existing_tool_names.add(t_name)
            print(f"DEBUG: Chat mode active - using limited tools + plugins: {[getattr(t, 'name', getattr(t, '__name__', str(t))) for t in tools_to_use]}")
        elif orchestration_mode == "team":
            planner_graph = settings.SUBAGENT_PLANNER_GRAPH or {}
            main_tool_ids = planner_graph.get("main_tool_ids") if isinstance(planner_graph, dict) else []
            if not isinstance(main_tool_ids, list):
                main_tool_ids = []
            if main_tool_ids:
                tools_to_use = _resolve_tools_from_ids(main_tool_ids)
            else:
                # Default team mode: coordinator agent has access to all enabled runtime tools
                enabled_tool_names = settings.ENABLED_TOOLS
                if enabled_tool_names is None:
                    tools_to_use = list(all_tools_map.values())
                else:
                    tools_to_use = _resolve_tools_from_ids(enabled_tool_names)
            existing_tool_names = {getattr(x, "name", getattr(x, "__name__", str(x))) for x in tools_to_use}
            for extra_tool in loaded_mcp_tools + loaded_external_tools + loaded_plugin_tools:
                t_name = getattr(extra_tool, "name", getattr(extra_tool, "__name__", str(extra_tool)))
                if t_name and t_name not in existing_tool_names:
                    tools_to_use.append(extra_tool)
                    existing_tool_names.add(t_name)
        else:
            # Solo mode: full catalog by default, with user-controlled disable list.
            enabled_tool_names = settings.ENABLED_TOOLS
            if enabled_tool_names is None:
                tools_to_use = list(all_tools_map.values())
            else:
                tools_to_use = _resolve_tools_from_ids(enabled_tool_names)
                # Automatically include dynamic MCP tools, external API tools, and plugin tools
                existing_tool_names = {getattr(x, "name", getattr(x, "__name__", str(x))) for x in tools_to_use}
                for extra_tool in loaded_mcp_tools + loaded_external_tools + loaded_plugin_tools:
                    t_name = getattr(extra_tool, "name", getattr(extra_tool, "__name__", str(extra_tool)))
                    if t_name and t_name not in existing_tool_names:
                        tools_to_use.append(extra_tool)
                        existing_tool_names.add(t_name)

        # Always ensure core system tools (search, questions, LTM, knowledge, scheduling, remote friends, skills) are available
        core_tool_names = [
            "internet_search",
            "ask_question",
            "save_memory",
            "get_memory",
            "search_memory",
            "read_knowledge_asset",
            "load_skill",
            "schedule_chat_task",
            "remote_friend_ask",
        ]
        existing_tool_names = {getattr(x, "name", getattr(x, "__name__", str(x))) for x in tools_to_use}
        for ctn in core_tool_names:
            core_t = all_tools_map.get(ctn)
            if core_t and getattr(core_t, "name", getattr(core_t, "__name__", str(core_t))) not in existing_tool_names:
                tools_to_use.append(core_t)
                existing_tool_names.add(getattr(core_t, "name", getattr(core_t, "__name__", str(core_t))))

        print(
            "DEBUG: Initializing agent with orchestration_mode=%s and tools=%s"
            % (
                orchestration_mode,
                [getattr(t, "name", getattr(t, "__name__", str(t))) for t in tools_to_use],
            )
        )

        try:
            print(f"DEBUG: Creating deep agent with {provider}...")

            # Core middleware stack: binary tool-need gate + context projection + skill preloading + memory retrieval + task accounting
            middleware_stack = [
                ToolNeedMiddleware(),
                ContextProjectionMiddleware(),
                SkillMiddleware(),
                MemoryRetrievalMiddleware(),
                TaskExecutionAccountingMiddleware(),
            ]
            
            # Only add TodoListMiddleware in thinking mode (skip for flash)
            if effective_speed_mode != "flash":
                middleware_stack.append(
                    TodoListMiddleware(
                        system_prompt="Use the write_todos tool to plan your tasks. Group independent tasks so relevant tools can be executed in parallel."
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

            # Human‑in‑the‑Loop middleware based on settings
            from app.config import settings as _settings
            hitl_mode = _settings.HITL_MODE
            
            if hitl_mode != "disable":
                if hitl_mode == "always":
                    # For "Always Ask", we interrupt on all tools except safe/read-only ones.
                    safe_tools = {
                        "internet_search", "ask_question", "get_desktop_state", "list_dir", "read_file", 
                        "save_memory", "get_memory", "search_memory", "list_mcp_servers", "get_mcp_tool_info",
                        "schedule_chat_task", "read_knowledge_asset", "load_skill"
                    }
                    interrupt_on = {}
                    for tool in tools_to_use:
                        tool_name = getattr(tool, "name", None)
                        if tool_name and tool_name not in safe_tools:
                            interrupt_on[tool_name] = True
                    
                    if not interrupt_on:
                        # Fallback if no specific tools found but mode is always
                        interrupt_on = {"run_terminal_command": True}
                        
                    middleware_stack.append(
                        HumanInTheLoopMiddleware(interrupt_on=interrupt_on)
                    )
                    print(f"DEBUG: HITL enabled in 'always' mode for {len(interrupt_on)} tools")
                
                elif hitl_mode == "let_decide":
                    # NOTE: InterruptOnConfig is a config TypedDict, not middleware.
                    # Build a regular HITL middleware map to avoid passing raw dicts
                    # into create_agent(..., middleware=[...]), which crashes.
                    safe_tools = {
                        "internet_search", "ask_question", "get_desktop_state", "list_dir", "read_file",
                        "save_memory", "get_memory", "search_memory", "list_mcp_servers", "get_mcp_tool_info",
                        "schedule_chat_task", "read_knowledge_asset", "load_skill"
                    }
                    interrupt_on = {}
                    for tool in tools_to_use:
                        tool_name = getattr(tool, "name", None)
                        if tool_name:
                            interrupt_on[tool_name] = tool_name not in safe_tools

                    middleware_stack.append(
                        HumanInTheLoopMiddleware(interrupt_on=interrupt_on)
                    )
                    print(
                        "DEBUG: HITL enabled in 'let_decide' mode "
                        "(safe tools auto-approved, others require approval)"
                    )

            # Prompt & token composition diagnostic middleware placed at the end so it sees all injected tools & prompts
            middleware_stack.append(PromptCompositionDiagnosticMiddleware())

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



    
    def invalidate_agent(self) -> None:
        """
        Invalidate the cached compiled agent graph.
        Forces the next request to rebuild the graph and re-discover plugin / MCP / external tools.
        """
        print("DEBUG: Invalidating cached agent graph (will recompile on next request)")
        self._agent = None

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

    def get_key_rotation_stats(self) -> Optional[dict]:
        """Return rotation stats for the currently active LLM, or None if not rotating."""
        llm = self._llm
        if llm is None:
            return None
            
        # Unpack FallbackChatModel if wrapped
        while hasattr(llm, "_primary_model"):
            llm = llm._primary_model
            
        rotator: Optional[KeyRotator] = getattr(llm, "_rotator", None)
        if rotator is None:
            # Single-key provider or non-rotating LLM
            return None
        return {
            "provider": self._resolve_provider(),
            "total_keys": rotator.total_keys,
            "keys": rotator.stats(),
        }


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

        # Serialize initialization to avoid concurrent heavy inits from
        # parallel health checks right after reload/startup.
        async with self._init_lock:
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

    async def generate_chat_thread_title(self, user_messages: List[str]) -> str:
        """Summarize the first two user turns into a short chat title."""
        if not self._llm:
            await self._initialize_agent_async(chat_mode="chat", speed_mode="flash")
        if not self._llm:
            raise RuntimeError("LLM is not initialized. Please verify provider settings.")

        lines = []
        for i, text in enumerate(user_messages[:2], start=1):
            cleaned = (text or "").strip()
            if "\n\n[Clipboard Content]:" in cleaned:
                cleaned = cleaned.split("\n\n[Clipboard Content]:")[0].strip()
            if cleaned:
                lines.append(f"{i}. {cleaned[:500]}")

        if len(lines) < 2:
            raise ValueError("Need at least two user messages to generate a title.")

        system_text = (
            "Write a short chat title (3–8 words) that captures the conversation topic. "
            "Return plain text only: no quotes, no markdown, no trailing punctuation."
        )
        user_text = "User messages:\n" + "\n".join(lines)

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
        title = (content or "").strip().strip('"\'')
        if not title:
            raise RuntimeError("Model returned empty title.")
        return title[:60]

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
        client_latitude: Optional[float] = None,
        client_longitude: Optional[float] = None,
        client_location_accuracy_m: Optional[float] = None,
        friend_target_id: Optional[str] = None,
        friend_target_name: Optional[str] = None,
    ) -> dict:
        """
        Invoke the agent (Async)
        """
        # Check if modes changed and re-initialize if needed
        provider = self._resolve_provider()
        effective_chat_mode = chat_mode or "agent"
        if provider == "rie":
            effective_chat_mode = "chat"
            
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
            device_ctx = _client_device_system_content(
                client_timezone,
                client_local_datetime_iso,
                client_latitude,
                client_longitude,
                client_location_accuracy_m,
            )
            if device_ctx:
                input_data = {"messages": [{"role": "system", "content": device_ctx}, *messages]}
            else:
                input_data = {"messages": messages}

        tokens = set_agent_context(
            thread_id,
            effective_chat_mode,
            effective_speed_mode,
            friend_target_id=friend_target_id,
            friend_target_name=friend_target_name,
        )
        try:
            return await self._agent.ainvoke(input_data, config=config, context=context)
        finally:
            reset_agent_context(tokens)

    async def seed_thread_history(self, thread_id: str, messages: list[dict]) -> None:
        """Seed LangGraph checkpoint state from forked history without running the LLM."""
        if not messages or not thread_id:
            return

        if self._agent is None:
            await self._initialize_agent_async(chat_mode="agent", speed_mode="thinking")
        if not self._agent:
            return

        processed: list[dict] = []
        for msg in messages:
            role = msg.get("role", "user")
            content = (msg.get("content") or "").strip()
            if not content:
                continue
            if role == "user" and msg.get("image_url"):
                processed.append(
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": content},
                            {
                                "type": "image_url",
                                "image_url": {"url": msg["image_url"]},
                            },
                        ],
                    }
                )
            else:
                processed.append({"role": role, "content": content})

        if not processed:
            return

        config = {"configurable": {"thread_id": thread_id}}
        await self._agent.aupdate_state(config, {"messages": processed})

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
        client_latitude: Optional[float] = None,
        client_longitude: Optional[float] = None,
        client_location_accuracy_m: Optional[float] = None,
        friend_target_id: Optional[str] = None,
        friend_target_name: Optional[str] = None,
        knowledge_context: Optional[str] = None,
        skill_ids: Optional[list[str]] = None,
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

        provider = self._resolve_provider()
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
            device_ctx = _client_device_system_content(
                client_timezone,
                client_local_datetime_iso,
                client_latitude,
                client_longitude,
                client_location_accuracy_m,
            )
            if device_ctx:
                processed_messages.append({"role": "system", "content": device_ctx})
            if is_voice:
                # Inject hidden instructions for human-like voice response
                processed_messages.append({
                    "role": "system", 
                    "content": "You are responding via voice. Use natural human fillers like 'hmm', 'uh', 'well', and expressive punctuation like '!' and '?' to sound more conversational. Keep responses relatively concise and engaging. Do not use markdown like bold or code blocks unless requested."
                })
            if knowledge_context and knowledge_context.strip():
                processed_messages.append({
                    "role": "system",
                    "content": f"[Custom Knowledge Context]\n{knowledge_context.strip()}",
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
        if skill_ids:
            config["configurable"]["skill_ids"] = skill_ids

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

        # "updates" yields graph-node completions (tools, interrupts).
        # "messages" yields LLM tokens as AIMessageChunk tuples — required for token streaming UI.
        stream_modes = ["updates", "messages"]

        print(f"DEBUG [Graph Request]: pid={os.getpid()} thread_id={thread_id} saver_id={id(self._checkpointer)}")

        if config:
            stream_gen = self._agent.astream(
                input_data,
                config=config,
                context=context,
                stream_mode=stream_modes,
            )
        else:
            stream_gen = self._agent.astream(
                input_data,
                context=context,
                stream_mode=stream_modes,
            )

        # Track this stream if a thread_id is provided
        current_task = asyncio.current_task()
        if thread_id and current_task:
            self._active_tasks[thread_id] = current_task
            logger.info(f"Registered task for thread_id={thread_id}")

        tokens = set_agent_context(
            thread_id,
            effective_chat_mode,
            effective_speed_mode,
            friend_target_id=friend_target_id,
            friend_target_name=friend_target_name,
        )
        try:
            async for chunk in stream_gen:
                # Multiple stream modes:
                # - default: (mode, payload)
                # - subgraph streaming: (namespace, mode, payload) — see LangGraph streaming docs
                if isinstance(chunk, tuple):
                    if len(chunk) == 3:
                        _stream_ns, mode, payload = chunk
                    elif len(chunk) == 2:
                        mode, payload = chunk
                    else:
                        logger.warning(
                            "Unexpected LangGraph stream tuple length %s; skipping",
                            len(chunk),
                        )
                        continue

                    if mode == "updates":
                        if not isinstance(payload, dict):
                            logger.warning(
                                "updates stream payload is %s; expected dict",
                                type(payload),
                            )
                            continue
                        logger.debug(
                            "Agent stream (updates) keys: %s",
                            list(payload.keys()),
                        )
                        if "__interrupt__" in payload:
                            logger.debug(
                                "Chunk contains interrupt: %s",
                                payload["__interrupt__"],
                            )
                        yield payload
                    elif mode == "messages":
                        # LangGraph: payload is normally (token_chunk, metadata)
                        yield {"__lg_messages__": payload}
                    else:
                        logger.warning("Unknown LangGraph stream mode: %s", mode)
                    continue

                logger.debug(
                    "Agent stream chunk keys: %s",
                    list(chunk.keys()) if isinstance(chunk, dict) else type(chunk),
                )
                if isinstance(chunk, dict) and "__interrupt__" in chunk:
                    logger.debug(f"Chunk contains interrupt: {chunk['__interrupt__']}")
                yield chunk
        except asyncio.CancelledError:
            logger.info(f"Stream for thread_id={thread_id} was cancelled")
            raise
        except APIConnectionError as e:
            logger.warning("Model provider connection failed for thread_id=%s: %s", thread_id, e)
            raise RuntimeError("upstream_connection_error") from e
        except httpx.ConnectError as e:
            logger.warning("HTTP connection failed for thread_id=%s: %s", thread_id, e)
            raise RuntimeError("upstream_connection_error") from e
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

    async def cancel_all_runs(self) -> None:
        """Cancel all active agent runs"""
        for thread_id, task in list(self._active_tasks.items()):
            if task and not task.done():
                task.cancel()
                logging.getLogger(__name__).info(f"Requested cancellation for thread_id={thread_id} during clear all")
# Global agent manager instance
agent_manager = AgentManager()

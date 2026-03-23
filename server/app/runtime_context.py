"""
Request-scoped context for agent tool calls (e.g. current thread id).
"""
from contextvars import ContextVar
from typing import Optional

_current_thread_id: ContextVar[Optional[str]] = ContextVar("current_thread_id", default=None)
_current_chat_mode: ContextVar[Optional[str]] = ContextVar("current_chat_mode", default=None)
_current_speed_mode: ContextVar[Optional[str]] = ContextVar("current_speed_mode", default=None)


def set_agent_context(
    thread_id: Optional[str],
    chat_mode: Optional[str] = None,
    speed_mode: Optional[str] = None,
):
    """Returns a list of tokens for reset_agent_context."""
    tokens = []
    tokens.append((_current_thread_id, _current_thread_id.set(thread_id)))
    tokens.append((_current_chat_mode, _current_chat_mode.set(chat_mode)))
    tokens.append((_current_speed_mode, _current_speed_mode.set(speed_mode)))
    return tokens


def reset_agent_context(tokens: list) -> None:
    for var, token in tokens:
        var.reset(token)


def get_current_thread_id() -> Optional[str]:
    return _current_thread_id.get()


def get_current_chat_mode() -> Optional[str]:
    return _current_chat_mode.get()


def get_current_speed_mode() -> Optional[str]:
    return _current_speed_mode.get()

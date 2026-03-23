"""
Agent tool: schedule work in the current chat thread (reminders, timed analysis).
"""
from typing import Literal, Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.runtime_context import (
    get_current_thread_id,
    get_current_chat_mode,
    get_current_speed_mode,
)


class ScheduleChatTaskInput(BaseModel):
    run_at_iso: str = Field(
        ...,
        description=(
            "When to run: ISO 8601 with offset. Use the 'User device local date and time' system line "
            "as authoritative 'now' — do not guess the year or day."
        ),
    )
    task_text: str = Field(
        ...,
        description="The reminder text, or the analysis/instruction to run at that time.",
    )
    intent: Literal["reminder", "analysis_silent", "analysis_inform"] = Field(
        ...,
        description=(
            "reminder: notify the user at that time (e.g. meeting). "
            "analysis_silent: run analysis only; results appear in chat, no popup. "
            "analysis_inform: run analysis and notify with a summary."
        ),
    )
    title: Optional[str] = Field(
        None,
        description="Short label for the schedule list and notifications (e.g. Team meeting).",
    )


def _schedule_chat_task(
    run_at_iso: str,
    task_text: str,
    intent: str,
    title: Optional[str] = None,
) -> str:
    thread_id = get_current_thread_id()
    if not thread_id:
        return (
            "Could not schedule: no active thread. Ask the user to send a normal message first, "
            "then try scheduling again."
        )
    chat_mode = get_current_chat_mode() or "agent"
    speed_mode = get_current_speed_mode() or "thinking"
    from app.scheduler import scheduler_manager

    try:
        job_id = scheduler_manager.add_task(
            text=task_text.strip(),
            run_at=run_at_iso.strip(),
            thread_id=thread_id,
            chat_mode=chat_mode,
            speed_mode=speed_mode,
            intent=intent,
            title=title.strip() if title else None,
        )
    except Exception as e:
        return f"Failed to schedule: {e}"

    return (
        f"Scheduled successfully (id={job_id}). Intent={intent}. "
        f"The task will run at the requested time in this chat thread."
    )


schedule_chat_task_tool = StructuredTool.from_function(
    func=_schedule_chat_task,
    name="schedule_chat_task",
    description=(
        "ONLY way to register reminders and timed work in Rie so they appear in the Scheduled sidebar. "
        "Call this when the user asks to be reminded, or to run analysis at a specific time. "
        "Do NOT use terminal commands or Windows Task Scheduler for this — they will not show in the app. "
        "Use intent: reminder (notify at time); analysis_silent (chat only, no popup); "
        "analysis_inform (analysis + notification summary). "
        "Always pass run_at_iso as a full ISO 8601 datetime (convert 'tomorrow 9am' to a concrete date)."
    ),
    args_schema=ScheduleChatTaskInput,
)

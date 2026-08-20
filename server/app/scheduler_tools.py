"""
Agent tools: schedule, list, update, and cancel scheduled tasks and reminders in Rie.
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


class ListScheduledTasksInput(BaseModel):
    thread_only: bool = Field(
        default=False,
        description="If True, lists tasks only for the current chat thread. If False, lists all pending tasks.",
    )


class UpdateScheduledTaskInput(BaseModel):
    task_id: str = Field(
        ...,
        description="The ID of the scheduled task to update (can be found with list_scheduled_tasks).",
    )
    run_at_iso: Optional[str] = Field(
        default=None,
        description="New ISO 8601 datetime with offset for when the task should run.",
    )
    task_text: Optional[str] = Field(
        default=None,
        description="New task text or reminder description.",
    )
    intent: Optional[Literal["reminder", "analysis_silent", "analysis_inform"]] = Field(
        default=None,
        description="Updated intent (reminder, analysis_silent, analysis_inform).",
    )
    title: Optional[str] = Field(
        default=None,
        description="Updated short title/label for the task.",
    )


class CancelScheduledTaskInput(BaseModel):
    task_id: Optional[str] = Field(
        default=None,
        description="The exact ID of the scheduled task to cancel.",
    )
    search_text: Optional[str] = Field(
        default=None,
        description="Keyword or phrase to find and cancel the matching pending task if ID is not known.",
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


def _list_scheduled_tasks(thread_only: bool = False) -> str:
    from app.scheduler import scheduler_manager
    tasks = scheduler_manager.list_tasks()
    current_thread = get_current_thread_id()
    if thread_only and current_thread:
        tasks = [t for t in tasks if t.thread_id == current_thread]
    if not tasks:
        return "No pending scheduled tasks found."
    lines = []
    for t in tasks:
        title_str = f" '{t.title}'" if t.title else ""
        lines.append(
            f"- [ID: {t.id}]{title_str} (run_at: {t.run_at.isoformat()}, intent: {t.intent}): {t.text}"
        )
    return "Pending scheduled tasks:\n" + "\n".join(lines)


def _update_scheduled_task(
    task_id: str,
    run_at_iso: Optional[str] = None,
    task_text: Optional[str] = None,
    intent: Optional[str] = None,
    title: Optional[str] = None,
) -> str:
    from app.scheduler import scheduler_manager
    try:
        updated = scheduler_manager.update_task(
            job_id=task_id.strip(),
            text=task_text.strip() if task_text else None,
            run_at=run_at_iso.strip() if run_at_iso else None,
            intent=intent.strip() if intent else None,
            title=title.strip() if title else None,
        )
        if not updated:
            return f"Scheduled task with ID '{task_id}' not found or could not be updated."
        return (
            f"Successfully updated scheduled task [{updated.id}]: "
            f"run_at={updated.run_at.isoformat()}, intent={updated.intent}, "
            f"title='{updated.title or ''}', text='{updated.text}'."
        )
    except Exception as e:
        return f"Failed to update scheduled task: {e}"


def _cancel_scheduled_task(
    task_id: Optional[str] = None,
    search_text: Optional[str] = None,
) -> str:
    from app.scheduler import scheduler_manager
    if task_id and task_id.strip():
        clean_id = task_id.strip()
        success = scheduler_manager.cancel_task(clean_id)
        if success:
            return f"Successfully cancelled scheduled task [{clean_id}]."
        return f"Could not cancel task [{clean_id}]: task not found."
    if search_text and search_text.strip():
        clean_search = search_text.strip().lower()
        tasks = scheduler_manager.list_tasks()
        matched = [
            t for t in tasks
            if clean_search in (t.text or "").lower() or clean_search in (t.title or "").lower()
        ]
        if not matched:
            return f"No pending scheduled tasks found matching '{search_text}'."
        target = matched[0]
        success = scheduler_manager.cancel_task(target.id)
        if success:
            return f"Successfully cancelled scheduled task [{target.id}] ('{target.title or target.text}')."
        return f"Failed to cancel scheduled task [{target.id}]."
    return "Please provide either 'task_id' or 'search_text' to cancel a scheduled task."


schedule_chat_task_tool = StructuredTool.from_function(
    func=_schedule_chat_task,
    name="schedule_chat_task",
    description=(
        "Register reminders and timed work in Rie so they appear in the Scheduled sidebar. "
        "Call this when the user asks to be reminded, or to run analysis at a specific time. "
        "Use intent: reminder (notify at time); analysis_silent (chat only, no popup); "
        "analysis_inform (analysis + notification summary). "
        "Always pass run_at_iso as a full ISO 8601 datetime."
    ),
    args_schema=ScheduleChatTaskInput,
)

list_scheduled_tasks_tool = StructuredTool.from_function(
    func=_list_scheduled_tasks,
    name="list_scheduled_tasks",
    description=(
        "List all pending scheduled tasks and reminders in Rie, including their IDs, run times, intents, and task descriptions. "
        "Use this when the user asks 'what reminders do I have?', 'what is scheduled?', or before updating/cancelling a task."
    ),
    args_schema=ListScheduledTasksInput,
)

update_scheduled_task_tool = StructuredTool.from_function(
    func=_update_scheduled_task,
    name="update_scheduled_task",
    description=(
        "Update or reschedule an existing scheduled task or reminder. "
        "Use this to change the time (run_at_iso), reminder text, intent, or title of an existing task."
    ),
    args_schema=UpdateScheduledTaskInput,
)

cancel_scheduled_task_tool = StructuredTool.from_function(
    func=_cancel_scheduled_task,
    name="cancel_scheduled_task",
    description=(
        "Cancel or delete a pending scheduled task or reminder by its task_id or by searching for matching text/title. "
        "Use this whenever the user asks to remove, delete, or cancel a reminder or scheduled task."
    ),
    args_schema=CancelScheduledTaskInput,
)

SCHEDULER_TOOLS = [
    schedule_chat_task_tool,
    list_scheduled_tasks_tool,
    update_scheduled_task_tool,
    cancel_scheduled_task_tool,
]


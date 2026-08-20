import logging
import uuid
import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Union

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.memory import MemoryJobStore

from app.database import (
    save_message,
    insert_scheduled_task,
    update_scheduled_task_status,
    get_pending_scheduled_tasks_rows,
    get_scheduled_task_by_id,
    update_scheduled_task_details,
    insert_schedule_notification,
)

from app.models import ScheduledTaskResponse

logger = logging.getLogger(__name__)

SCHEDULE_INTENTS = ("reminder", "analysis_silent", "analysis_inform")


def parse_run_at(value: Union[str, datetime]) -> datetime:
    if isinstance(value, datetime):
        dt = value
    else:
        s = value.strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _run_at_to_store_iso(dt: datetime) -> str:
    """Normalize to UTC ISO for SQLite."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat()


def format_time_delta(td: timedelta) -> str:
    total_seconds = max(0, int(td.total_seconds()))
    if total_seconds < 60:
        return f"{total_seconds}s"
    minutes = total_seconds // 60
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = minutes // 60
    if hours < 24:
        rem_min = minutes % 60
        return f"{hours} hour{'s' if hours != 1 else ''}" + (f" {rem_min} min" if rem_min else "")
    days = hours // 24
    rem_hours = hours % 24
    return f"{days} day{'s' if days != 1 else ''}" + (f" {rem_hours} hr" if rem_hours else "")


def build_scheduled_user_prompt(
    text: str,
    intent: str,
    title: Optional[str],
) -> str:
    """Turn the stored task into the user message shown in chat + sent to the LLM."""
    if intent == "reminder":
        head = title.strip() if title else "Reminder"
        return f"[Scheduled reminder — {head}]\n{text}"
    if intent == "analysis_silent":
        return (
            "[Scheduled analysis — silent / no popup]\n"
            "Perform the following. Output only the analysis or results. "
            "Do not discuss scheduling, reminders, or notifying the user.\n\n"
            f"{text}"
        )
    if intent == "analysis_inform":
        return (
            "[Scheduled analysis — inform user]\n"
            "Perform the following task. When finished, end with a short, clear summary "
            "the user asked to be shown when notified.\n\n"
            f"{text}"
        )
    return text


def build_missed_scheduled_user_prompt(
    text: str,
    intent: str,
    title: Optional[str],
    original_run_at: datetime,
    now: datetime,
) -> str:
    """Turn a missed/overdue stored task into a contextual prompt evaluated by the LLM."""
    elapsed = format_time_delta(now - original_run_at)
    due_str = original_run_at.strftime("%Y-%m-%d %H:%M:%S UTC")
    head = title.strip() if title else ("Reminder" if intent == "reminder" else "Analysis")

    if intent == "reminder":
        return (
            f"[Missed Scheduled Reminder — {head}]\n"
            f"This reminder was originally scheduled for {due_str} ({elapsed} ago) "
            f"while the system was offline.\n\n"
            f"Reminder Text:\n{text}\n\n"
            f"Instruction: Deliver this reminder now to the user and clearly mention that it was delayed because the app was offline."
        )
    if intent == "analysis_silent":
        return (
            f"[Missed Scheduled Analysis — silent / no popup — {head}]\n"
            f"Originally scheduled for {due_str} ({elapsed} ago) while offline.\n"
            f"Evaluate and perform the following analysis if still relevant. Output only the analysis or results.\n\n"
            f"{text}"
        )
    if intent == "analysis_inform":
        return (
            f"[Missed Scheduled Analysis — inform user — {head}]\n"
            f"Originally scheduled for {due_str} ({elapsed} ago) while offline.\n"
            f"Perform the task if still meaningful. End with a clear summary noting that execution occurred upon reconnecting after being offline.\n\n"
            f"{text}"
        )
    return f"[Missed Scheduled Task — originally due {due_str} ({elapsed} ago)]\n{text}"


def _notification_title(intent: str, title: Optional[str], task_text: str) -> str:
    if title and title.strip():
        return title.strip()[:120]
    if intent == "reminder":
        return "Reminder"
    if intent == "analysis_inform":
        return "Analysis complete"
    return task_text[:80] + ("…" if len(task_text) > 80 else "")


class SchedulerManager:
    def __init__(self):
        self.scheduler = AsyncIOScheduler(
            jobstores={"default": MemoryJobStore()},
            job_defaults={"misfire_grace_time": 60},
        )

    def start(self):
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:
            current_loop = None

        if self.scheduler.running:
            if current_loop and getattr(self.scheduler, "_eventloop", None) is not current_loop:
                try:
                    self.scheduler.shutdown(wait=False)
                except Exception:
                    pass
                self.scheduler = AsyncIOScheduler(
                    jobstores={"default": MemoryJobStore()},
                    job_defaults={"misfire_grace_time": 60},
                )
                self.scheduler.start()
                logger.info("Scheduler restarted on active event loop.")
        else:
            self.scheduler.start()
            logger.info("Scheduler started.")

    def shutdown(self):
        if self.scheduler.running:
            self.scheduler.shutdown()
            logger.info("Scheduler shut down.")


    def reschedule_pending_from_db(self) -> None:
        """Re-register APScheduler jobs after process restart, and dispatch missed tasks for LLM recovery."""
        now = datetime.now(timezone.utc)
        missed_tasks: List[dict] = []
        for row in get_pending_scheduled_tasks_rows():
            task_id = row["id"]
            try:
                run_at = parse_run_at(row["run_at"])
            except Exception as e:
                logger.error("Bad run_at for task %s: %s", task_id, e)
                update_scheduled_task_status(task_id, "failed")
                continue
            if run_at <= now:
                logger.info("Found overdue/missed task %s (scheduled for %s, now %s)", task_id, run_at, now)
                missed_tasks.append(row)
                continue
            try:
                self.scheduler.add_job(
                    self.execute_llm_task,
                    "date",
                    run_date=run_at,
                    id=task_id,
                    args=[
                        task_id,
                        row["text"],
                        row["thread_id"],
                        "agent",
                        "thinking",
                        row["intent"],
                        row["title"],
                    ],
                    replace_existing=True,
                )
                logger.info("Rescheduled task %s for %s", task_id, run_at)
            except Exception as e:
                logger.error("Failed to reschedule %s: %s", task_id, e)
                update_scheduled_task_status(task_id, "failed")

        if missed_tasks:
            logger.info("Spawning background recovery for %d missed scheduled task(s)...", len(missed_tasks))
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(self.handle_missed_tasks(missed_tasks))
                else:
                    asyncio.create_task(self.handle_missed_tasks(missed_tasks))
            except Exception as e:
                logger.warning("Could not schedule handle_missed_tasks on event loop: %s", e)

    async def handle_missed_tasks(self, missed_rows: List[dict]) -> None:
        """Asynchronously evaluate and execute missed scheduled tasks using LLM decisions."""
        if not missed_rows:
            return
        logger.info("Evaluating %d missed scheduled task(s) with LLM...", len(missed_rows))
        now = datetime.now(timezone.utc)
        for row in missed_rows:
            task_id = row["id"]
            text = row["text"]
            thread_id = row["thread_id"]
            intent = row.get("intent", "reminder")
            title = row.get("title")
            try:
                run_at = parse_run_at(row["run_at"])
            except Exception:
                run_at = now

            try:
                await self.execute_missed_llm_task(
                    task_id=task_id,
                    text=text,
                    thread_id=thread_id,
                    chat_mode="agent",
                    speed_mode="thinking",
                    intent=intent,
                    title=title,
                    original_run_at=run_at,
                    now=now,
                )
            except Exception as e:
                logger.error("Failed executing missed scheduled task %s: %s", task_id, e, exc_info=True)
                update_scheduled_task_status(task_id, "failed")

    async def execute_missed_llm_task(
        self,
        task_id: str,
        text: str,
        thread_id: str,
        chat_mode: str,
        speed_mode: str,
        intent: str,
        title: Optional[str],
        original_run_at: datetime,
        now: datetime,
    ):
        from app.agent import agent_manager

        user_prompt = build_missed_scheduled_user_prompt(text, intent, title, original_run_at, now)
        logger.info(
            "Executing missed scheduled task %s for thread %s intent=%s (originally due %s)",
            task_id,
            thread_id,
            intent,
            original_run_at.isoformat(),
        )

        try:
            save_message(thread_id, "user", user_prompt)

            response = await agent_manager.invoke(
                messages=[{"role": "user", "content": user_prompt}],
                thread_id=thread_id,
                chat_mode=chat_mode,
                speed_mode=speed_mode,
            )

            final_content = ""
            if isinstance(response, dict) and "messages" in response and response["messages"]:
                last_msg = response["messages"][-1]
                if hasattr(last_msg, "content"):
                    final_content = last_msg.content
                elif isinstance(last_msg, dict):
                    final_content = last_msg.get("content", "")
                else:
                    final_content = str(last_msg)

            if final_content:
                save_message(thread_id, "assistant", final_content)
            else:
                final_content = f"Missed scheduled task from {original_run_at.strftime('%Y-%m-%d %H:%M UTC')} processed."
                save_message(thread_id, "assistant", final_content)

            update_scheduled_task_status(task_id, "completed")

            if intent in ("reminder", "analysis_inform") and final_content:
                notif_id = str(uuid.uuid4())
                body = final_content.strip()
                if len(body) > 2000:
                    body = body[:1997] + "..."
                notif_title = f"[Delayed] {_notification_title(intent, title, text)}"
                insert_schedule_notification(
                    notif_id,
                    thread_id,
                    task_id,
                    intent,
                    notif_title,
                    body,
                )
                logger.info("Created schedule notification %s for missed task %s", notif_id, task_id)

        except Exception as e:
            logger.error("Error executing missed scheduled task %s: %s", task_id, e, exc_info=True)
            update_scheduled_task_status(task_id, "failed")
            try:
                save_message(thread_id, "assistant", f"Error executing missed scheduled task: {str(e)}")
            except Exception:
                pass

    async def execute_llm_task(
        self,
        task_id: str,
        text: str,
        thread_id: str,
        chat_mode: str,
        speed_mode: str,
        intent: str,
        title: Optional[str],
    ):
        from app.agent import agent_manager

        user_prompt = build_scheduled_user_prompt(text, intent, title)
        logger.info(
            "Executing scheduled task %s for thread %s intent=%s",
            task_id,
            thread_id,
            intent,
        )

        try:
            save_message(thread_id, "user", user_prompt)

            response = await agent_manager.invoke(
                messages=[{"role": "user", "content": user_prompt}],
                thread_id=thread_id,
                chat_mode=chat_mode,
                speed_mode=speed_mode,
            )

            final_content = ""
            if isinstance(response, dict) and "messages" in response and response["messages"]:
                last_msg = response["messages"][-1]
                if hasattr(last_msg, "content"):
                    final_content = last_msg.content
                elif isinstance(last_msg, dict):
                    final_content = last_msg.get("content", "")
                else:
                    final_content = str(last_msg)

            if final_content:
                save_message(thread_id, "assistant", final_content)
            else:
                final_content = "I processed your scheduled task but had no verbal response."
                save_message(thread_id, "assistant", final_content)

            update_scheduled_task_status(task_id, "completed")

            if intent in ("reminder", "analysis_inform") and final_content:
                notif_id = str(uuid.uuid4())
                body = final_content.strip()
                if len(body) > 2000:
                    body = body[:1997] + "..."
                insert_schedule_notification(
                    notif_id,
                    thread_id,
                    task_id,
                    intent,
                    _notification_title(intent, title, text),
                    body,
                )
                logger.info("Created schedule notification %s for task %s", notif_id, task_id)

        except Exception as e:
            logger.error("Error executing scheduled task %s: %s", task_id, e, exc_info=True)
            update_scheduled_task_status(task_id, "failed")
            try:
                save_message(thread_id, "assistant", f"Error executing scheduled task: {str(e)}")
            except Exception:
                pass

    def add_task(
        self,
        text: str,
        run_at: Union[str, datetime],
        thread_id: str,
        chat_mode: str = "agent",
        speed_mode: str = "thinking",
        intent: str = "reminder",
        title: Optional[str] = None,
    ) -> str:
        if not thread_id:
            raise ValueError("thread_id is required")
        if intent not in SCHEDULE_INTENTS:
            raise ValueError(f"intent must be one of {SCHEDULE_INTENTS}")

        task_id = str(uuid.uuid4())
        run_dt = parse_run_at(run_at)
        run_at_iso = _run_at_to_store_iso(run_dt)

        insert_scheduled_task(
            task_id,
            thread_id,
            text,
            run_at_iso,
            intent,
            title,
            "pending",
        )

        self.scheduler.add_job(
            self.execute_llm_task,
            "date",
            run_date=run_dt,
            id=task_id,
            args=[task_id, text, thread_id, chat_mode, speed_mode, intent, title],
            replace_existing=True,
        )
        logger.info("Scheduled task %s for %s (intent=%s)", task_id, run_dt, intent)
        return task_id

    def get_task(self, job_id: str) -> Optional[ScheduledTaskResponse]:
        row = get_scheduled_task_by_id(job_id)
        if not row:
            return None
        run_at = parse_run_at(row["run_at"])
        return ScheduledTaskResponse(
            id=row["id"],
            text=row["text"],
            run_at=run_at,
            thread_id=row.get("thread_id"),
            status=row.get("status", "pending"),
            intent=row.get("intent", "reminder"),
            title=row.get("title"),
        )

    def update_task(
        self,
        job_id: str,
        text: Optional[str] = None,
        run_at: Optional[Union[str, datetime]] = None,
        intent: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Optional[ScheduledTaskResponse]:
        """Update task details in database and reschedule in APScheduler if pending."""
        existing = get_scheduled_task_by_id(job_id)
        if not existing:
            return None
        if intent and intent not in SCHEDULE_INTENTS:
            raise ValueError(f"intent must be one of {SCHEDULE_INTENTS}")

        run_at_iso = None
        run_dt = None
        if run_at is not None:
            run_dt = parse_run_at(run_at)
            run_at_iso = _run_at_to_store_iso(run_dt)

        update_scheduled_task_details(
            job_id,
            text=text,
            run_at_iso=run_at_iso,
            intent=intent,
            title=title,
        )

        updated_row = get_scheduled_task_by_id(job_id)
        if not updated_row:
            return None

        # If task is still pending, update the in-memory APScheduler job
        if updated_row.get("status") == "pending":
            eff_run_dt = parse_run_at(updated_row["run_at"])
            eff_text = updated_row["text"]
            eff_thread_id = updated_row["thread_id"]
            eff_intent = updated_row["intent"]
            eff_title = updated_row.get("title")

            try:
                self.scheduler.remove_job(job_id)
            except Exception:
                pass

            now = datetime.now(timezone.utc)
            if eff_run_dt > now:
                self.scheduler.add_job(
                    self.execute_llm_task,
                    "date",
                    run_date=eff_run_dt,
                    id=job_id,
                    args=[job_id, eff_text, eff_thread_id, "agent", "thinking", eff_intent, eff_title],
                    replace_existing=True,
                )
                logger.info("Updated and rescheduled task %s for %s", job_id, eff_run_dt)

        return ScheduledTaskResponse(
            id=updated_row["id"],
            text=updated_row["text"],
            run_at=parse_run_at(updated_row["run_at"]),
            thread_id=updated_row["thread_id"],
            status=updated_row["status"],
            intent=updated_row["intent"],
            title=updated_row.get("title"),
        )

    def list_tasks(self) -> List[ScheduledTaskResponse]:
        tasks: List[ScheduledTaskResponse] = []
        for row in get_pending_scheduled_tasks_rows():
            run_at = parse_run_at(row["run_at"])
            tasks.append(
                ScheduledTaskResponse(
                    id=row["id"],
                    text=row["text"],
                    run_at=run_at,
                    thread_id=row["thread_id"],
                    status="pending",
                    intent=row["intent"],
                    title=row["title"],
                )
            )
        return tasks

    def cancel_task(self, job_id: str) -> bool:
        try:
            self.scheduler.remove_job(job_id)
        except Exception:
            pass
        try:
            update_scheduled_task_status(job_id, "cancelled")
            logger.info("Cancelled task %s", job_id)
            return True
        except Exception:
            return False

    def cancel_all_tasks(self) -> None:
        """Cancel all pending in-memory scheduler jobs."""
        for job in list(self.scheduler.get_jobs()):
            try:
                self.scheduler.remove_job(job.id)
            except Exception as e:
                logger.error("Failed to remove job %s during clear all: %s", job.id, e)

    @property
    def is_ready(self) -> bool:
        """Return True if scheduler is running and initialized."""
        return bool(self.scheduler and self.scheduler.running)


scheduler_manager = SchedulerManager()

def is_scheduler_ready() -> bool:
    """Return True if the scheduler subsystem is active."""
    return scheduler_manager.is_ready


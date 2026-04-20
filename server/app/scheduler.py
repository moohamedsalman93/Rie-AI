import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Union

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.memory import MemoryJobStore

from app.database import (
    save_message,
    insert_scheduled_task,
    update_scheduled_task_status,
    get_pending_scheduled_tasks_rows,
    insert_schedule_notification,
)

from app.models import ScheduledTaskResponse
from app.realtime import hub, notify_scheduler_tasks_changed

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
        if not self.scheduler.running:
            self.scheduler.start()
            logger.info("Scheduler started.")

    def shutdown(self):
        if self.scheduler.running:
            self.scheduler.shutdown()
            logger.info("Scheduler shut down.")

    def reschedule_pending_from_db(self) -> None:
        """Re-register APScheduler jobs after process restart (DB is source of truth)."""
        now = datetime.now(timezone.utc)
        for row in get_pending_scheduled_tasks_rows():
            task_id = row["id"]
            try:
                run_at = parse_run_at(row["run_at"])
            except Exception as e:
                logger.error("Bad run_at for task %s: %s", task_id, e)
                update_scheduled_task_status(task_id, "failed")
                continue
            if run_at <= now:
                logger.warning("Skipping overdue task %s (run_at in the past)", task_id)
                update_scheduled_task_status(task_id, "failed")
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
                try:
                    title_val = _notification_title(intent, title, text)
                    await hub.emit(
                        "scheduler_notifications",
                        {
                            "action": "created",
                            "notification": {
                                "id": notif_id,
                                "thread_id": thread_id,
                                "task_id": task_id,
                                "intent": intent,
                                "title": title_val,
                                "body": body,
                                "created_at": datetime.utcnow().isoformat(),
                            },
                        },
                    )
                except Exception:
                    logger.debug("Realtime scheduler notification emit failed", exc_info=True)

        except Exception as e:
            logger.error("Error executing scheduled task %s: %s", task_id, e, exc_info=True)
            update_scheduled_task_status(task_id, "failed")
            try:
                save_message(thread_id, "assistant", f"Error executing scheduled task: {str(e)}")
            except Exception:
                pass
        finally:
            try:
                notify_scheduler_tasks_changed()
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
        try:
            notify_scheduler_tasks_changed()
        except Exception:
            pass
        return task_id

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
            try:
                notify_scheduler_tasks_changed()
            except Exception:
                pass
            return True
        except Exception:
            return False


scheduler_manager = SchedulerManager()

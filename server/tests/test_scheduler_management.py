"""
Unit tests for scheduler tools, schedule altering (list, update, cancel),
and missed schedule online execution/recovery.
"""
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from app.database import (
    init_db,
    insert_scheduled_task,
    get_scheduled_task_by_id,
    get_pending_scheduled_tasks_rows,
    update_scheduled_task_status,
    get_unread_schedule_notifications,
)
from app.models import ScheduledTaskResponse
from app.runtime_context import set_agent_context, reset_agent_context
from app.scheduler import (
    scheduler_manager,
    build_scheduled_user_prompt,
    build_missed_scheduled_user_prompt,
    format_time_delta,
)
from app.scheduler_tools import (
    schedule_chat_task_tool,
    list_scheduled_tasks_tool,
    update_scheduled_task_tool,
    cancel_scheduled_task_tool,
    SCHEDULER_TOOLS,
)


class TestSchedulerManagement(unittest.IsolatedAsyncioTestCase):

    async def asyncSetUp(self):
        init_db()
        scheduler_manager.start()
        self.test_thread_id = f"test_thread_{uuid.uuid4().hex[:8]}"
        self.context_token = set_agent_context(
            thread_id=self.test_thread_id,
            chat_mode="agent",
            speed_mode="thinking",
        )

    async def asyncTearDown(self):
        reset_agent_context(self.context_token)
        scheduler_manager.cancel_all_tasks()


    def test_01_scheduler_tools_exported(self):
        """Verify all 4 scheduler tools are exported."""
        tool_names = {t.name for t in SCHEDULER_TOOLS}
        expected = {
            "schedule_chat_task",
            "list_scheduled_tasks",
            "update_scheduled_task",
            "cancel_scheduled_task",
        }
        self.assertEqual(tool_names, expected)

    def test_02_schedule_and_list_tasks(self):
        """Test scheduling a task and retrieving it via list_scheduled_tasks tool."""
        future_dt = datetime.now(timezone.utc) + timedelta(hours=2)
        run_at_iso = future_dt.isoformat()

        # Schedule
        res = schedule_chat_task_tool.invoke({
            "run_at_iso": run_at_iso,
            "task_text": "Submit quarterly report",
            "intent": "reminder",
            "title": "Quarterly Report",
        })
        self.assertIn("Scheduled successfully", res)

        # List
        list_res = list_scheduled_tasks_tool.invoke({"thread_only": True})
        self.assertIn("Quarterly Report", list_res)
        self.assertIn("Submit quarterly report", list_res)

    def test_03_update_scheduled_task(self):
        """Test updating an existing scheduled task's time and description."""
        future_dt = datetime.now(timezone.utc) + timedelta(hours=1)
        job_id = scheduler_manager.add_task(
            text="Initial description",
            run_at=future_dt,
            thread_id=self.test_thread_id,
            intent="reminder",
            title="Initial Title",
        )

        new_future_dt = datetime.now(timezone.utc) + timedelta(hours=5)
        new_run_at_iso = new_future_dt.isoformat()

        update_res = update_scheduled_task_tool.invoke({
            "task_id": job_id,
            "run_at_iso": new_run_at_iso,
            "task_text": "Updated report description",
            "title": "Updated Title",
            "intent": "analysis_inform",
        })
        self.assertIn("Successfully updated scheduled task", update_res)
        self.assertIn("Updated Title", update_res)

        # Verify DB updated
        row = get_scheduled_task_by_id(job_id)
        self.assertIsNotNone(row)
        self.assertEqual(row["text"], "Updated report description")
        self.assertEqual(row["title"], "Updated Title")
        self.assertEqual(row["intent"], "analysis_inform")

    def test_04_cancel_scheduled_task_by_id_and_search(self):
        """Test cancelling a task by ID and by keyword search."""
        future_dt = datetime.now(timezone.utc) + timedelta(hours=3)
        job1 = scheduler_manager.add_task(
            text="Take medication at night",
            run_at=future_dt,
            thread_id=self.test_thread_id,
            intent="reminder",
            title="Night Meds",
        )
        job2 = scheduler_manager.add_task(
            text="Check website analytics at midnight",
            run_at=future_dt,
            thread_id=self.test_thread_id,
            intent="analysis_silent",
            title="Analytics Check",
        )

        # Cancel job1 by ID
        cancel_id_res = cancel_scheduled_task_tool.invoke({"task_id": job1})
        self.assertIn(f"Successfully cancelled scheduled task [{job1}]", cancel_id_res)
        row1 = get_scheduled_task_by_id(job1)
        self.assertEqual(row1["status"], "cancelled")

        # Cancel job2 by search text
        cancel_search_res = cancel_scheduled_task_tool.invoke({"search_text": "analytics"})
        self.assertIn(f"Successfully cancelled scheduled task [{job2}]", cancel_search_res)
        row2 = get_scheduled_task_by_id(job2)
        self.assertEqual(row2["status"], "cancelled")

    def test_05_format_time_delta(self):
        """Test elapsed time formatting."""
        self.assertEqual(format_time_delta(timedelta(seconds=45)), "45s")
        self.assertEqual(format_time_delta(timedelta(minutes=5)), "5 minutes")
        self.assertEqual(format_time_delta(timedelta(hours=2, minutes=15)), "2 hours 15 min")
        self.assertEqual(format_time_delta(timedelta(days=3, hours=4)), "3 days 4 hr")

    def test_06_build_missed_scheduled_user_prompt(self):
        """Test prompt construction for missed tasks."""
        past_dt = datetime.now(timezone.utc) - timedelta(hours=2)
        now = datetime.now(timezone.utc)
        prompt = build_missed_scheduled_user_prompt(
            text="Pay electricity bill",
            intent="reminder",
            title="Electricity",
            original_run_at=past_dt,
            now=now,
        )
        self.assertIn("Missed Scheduled Reminder", prompt)
        self.assertIn("Electricity", prompt)
        self.assertIn("Pay electricity bill", prompt)
        self.assertIn("delayed because the app was offline", prompt)

    async def test_07_execute_missed_task_recovery(self):
        """Test missed scheduled task execution upon coming back online."""
        past_dt = datetime.now(timezone.utc) - timedelta(hours=1)
        past_iso = past_dt.isoformat()
        task_id = str(uuid.uuid4())

        insert_scheduled_task(
            task_id=task_id,
            thread_id=self.test_thread_id,
            text="Review missed team announcement",
            run_at_iso=past_iso,
            intent="reminder",
            title="Team Notice",
            status="pending",
        )

        mock_invoke = AsyncMock(return_value={"messages": [{"role": "assistant", "content": "Here is the missed reminder for Team Notice."}]})
        with patch("app.agent.agent_manager.invoke", mock_invoke):
            await scheduler_manager.handle_missed_tasks([{
                "id": task_id,
                "text": "Review missed team announcement",
                "run_at": past_iso,
                "thread_id": self.test_thread_id,
                "intent": "reminder",
                "title": "Team Notice",
            }])

        # Verify task is completed
        row = get_scheduled_task_by_id(task_id)
        self.assertEqual(row["status"], "completed")

        # Verify notification was generated for reminder
        notifs = get_unread_schedule_notifications()
        matching_notif = [n for n in notifs if n.get("task_id") == task_id]
        self.assertTrue(len(matching_notif) > 0, "Notification should be generated for completed missed reminder")
        self.assertIn("[Delayed]", matching_notif[0]["title"])


if __name__ == "__main__":
    unittest.main()

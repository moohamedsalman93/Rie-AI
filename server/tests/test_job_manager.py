import asyncio
import unittest
from app.job_manager import JobManager, JobRecord

class TestJobManager(unittest.TestCase):
    def setUp(self):
        self.manager = JobManager()

    def test_create_and_get_job(self):
        job = self.manager.create_job(task="Refactor login component", mode="background")
        self.assertTrue(job.job_id.startswith("job_"))
        self.assertEqual(job.task, "Refactor login component")
        self.assertEqual(job.mode, "background")
        self.assertEqual(job.status, "running")

        retrieved = self.manager.get_job(job.job_id)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.job_id, job.job_id)

    def test_add_event(self):
        job = self.manager.create_job(task="Run tests")
        # create_job logs initial event, now add one more
        self.manager.add_event(job.job_id, "Running pytest in app/server", {"tool": "run_terminal_command"})
        
        self.assertEqual(len(job.events), 2)
        self.assertEqual(job.events[1]["message"], "Running pytest in app/server")
        self.assertEqual(job.events[1]["meta"]["tool"], "run_terminal_command")

    def test_complete_job(self):
        job = self.manager.create_job(task="Build app")
        completed = self.manager.complete_job(job.job_id, result="Build succeeded in 4.2s")
        
        self.assertIsNotNone(completed)
        self.assertEqual(completed.status, "completed")
        self.assertEqual(completed.result, "Build succeeded in 4.2s")
        self.assertIsNotNone(completed.finished_at)

    def test_fail_job(self):
        job = self.manager.create_job(task="Deploy app")
        failed = self.manager.fail_job(job.job_id, error="Network timeout connecting to server")
        
        self.assertIsNotNone(failed)
        self.assertEqual(failed.status, "failed")
        self.assertEqual(failed.error, "Network timeout connecting to server")

    def test_cancel_job(self):
        from unittest.mock import MagicMock
        job = self.manager.create_job(task="Long task")
        mock_task = MagicMock()
        mock_task.done.return_value = False
        self.manager.register_async_task(job.job_id, mock_task)

        success = self.manager.cancel_job(job.job_id)
        self.assertTrue(success)
        self.assertEqual(job.status, "cancelled")
        mock_task.cancel.assert_called_once()

    def test_list_jobs(self):
        self.manager.create_job(task="Job 1")
        self.manager.create_job(task="Job 2")
        jobs = self.manager.list_jobs(limit=10)
        self.assertGreaterEqual(len(jobs), 2)


if __name__ == "__main__":
    unittest.main()

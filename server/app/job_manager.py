"""
Background Job Manager for Rie-AI.
Tracks asynchronous subagent execution tasks, progress events, and completions.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import logging
import uuid
from typing import Dict, Any, List, Optional

logger = logging.getLogger("job_manager")


@dataclass
class JobRecord:
    job_id: str
    task: str
    status: str = "queued"  # "queued", "running", "completed", "failed", "cancelled"
    mode: str = "background"  # "background", "foreground"
    thread_id: Optional[str] = None
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    finished_at: Optional[str] = None
    events: List[Dict[str, Any]] = field(default_factory=list)
    result: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "task": self.task,
            "status": self.status,
            "mode": self.mode,
            "thread_id": self.thread_id,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "events": self.events,
            "result": self.result,
            "error": self.error,
        }


class JobManager:
    """Manages active and historical background subagent jobs."""

    def __init__(self):
        self._jobs: Dict[str, JobRecord] = {}
        self._active_tasks: Dict[str, Any] = {}

    def create_job(
        self,
        task: str,
        mode: str = "background",
        thread_id: Optional[str] = None,
        job_id: Optional[str] = None,
    ) -> JobRecord:
        jid = job_id or f"job_{uuid.uuid4().hex[:6]}"
        record = JobRecord(
            job_id=jid,
            task=task,
            mode=mode,
            thread_id=thread_id,
            status="running",
        )
        self._jobs[jid] = record
        self.add_event(jid, "Agent job initialized")
        logger.info(f"[JobManager] Created job '{jid}' in mode '{mode}': {task[:80]}")
        return record

    def get_job(self, job_id: str) -> Optional[JobRecord]:
        return self._jobs.get(job_id)

    def list_jobs(self, thread_id: Optional[str] = None, limit: int = 20) -> List[JobRecord]:
        jobs = list(self._jobs.values())
        if thread_id:
            jobs = [j for j in jobs if j.thread_id == thread_id]
        return sorted(jobs, key=lambda j: j.started_at, reverse=True)[:limit]

    def add_event(self, job_id: str, message: str, meta: Optional[Dict[str, Any]] = None) -> None:
        job = self._jobs.get(job_id)
        if not job:
            return
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message": message,
        }
        if meta:
            event["meta"] = meta
        job.events.append(event)
        logger.debug(f"[JobManager] Job '{job_id}' event: {message}")

    def complete_job(self, job_id: str, result: str) -> Optional[JobRecord]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job.status = "completed"
        job.result = result
        job.finished_at = datetime.now(timezone.utc).isoformat()
        self.add_event(job_id, "Agent job completed")
        self._active_tasks.pop(job_id, None)
        logger.info(f"[JobManager] Job '{job_id}' completed successfully.")
        return job

    def fail_job(self, job_id: str, error: str) -> Optional[JobRecord]:
        job = self._jobs.get(job_id)
        if not job:
            return None
        job.status = "failed"
        job.error = error
        job.finished_at = datetime.now(timezone.utc).isoformat()
        self.add_event(job_id, f"Agent job failed: {error}")
        self._active_tasks.pop(job_id, None)
        logger.error(f"[JobManager] Job '{job_id}' failed: {error}")
        return job

    def register_async_task(self, job_id: str, task_handle: Any) -> None:
        self._active_tasks[job_id] = task_handle

    def cancel_job(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job:
            return False
        job.status = "cancelled"
        job.finished_at = datetime.now(timezone.utc).isoformat()
        self.add_event(job_id, "Agent job cancelled")
        task_handle = self._active_tasks.pop(job_id, None)
        if task_handle and not task_handle.done():
            task_handle.cancel()
            logger.info(f"[JobManager] Cancelled running task for job '{job_id}'.")
        return True


# Singleton JobManager instance
job_manager = JobManager()

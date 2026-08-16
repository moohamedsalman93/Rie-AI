"""
Skills Learner & Trajectory Evaluator module for Rie Agent Runtime.

Asynchronously evaluates completed task trajectories, applies deterministic quality
and novelty gates, extracts reusable procedure templates into sanitized SkillCandidate
objects, and stages them for human review before promotion into Rie's Skill Library.
"""
import os
import re
import json
import uuid
import sqlite3
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple

from app.trajectory import trajectory_store, TaskEvent, sanitize_payload, sanitize_text
from app.database import get_db_path, list_skills, create_skill

_logger = logging.getLogger(__name__)


@dataclass
class SkillCandidate:
    """Represents a proposed reusable skill extracted from an execution trajectory."""
    candidate_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    name: str = ""
    description: str = ""
    procedure: List[Dict[str, Any]] = field(default_factory=list)
    requirements: List[str] = field(default_factory=list)
    confidence: float = 0.9
    source_task_id: str = ""
    source_thread_id: str = ""
    candidate_type: str = "new_skill"  # new_skill, skill_improvement
    target_skill_id: Optional[str] = None
    status: str = "pending_review"     # pending_review, approved, rejected
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class SkillCandidateStore:
    """
    SQLite persistence for staged SkillCandidate proposals.
    """
    def __init__(self, db_path: Optional[str] = None):
        if db_path is None:
            self.db_path = str(get_db_path())
        else:
            self.db_path = db_path
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=15.0)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS skill_candidates (
                    candidate_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    procedure TEXT NOT NULL,
                    requirements TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    source_task_id TEXT NOT NULL,
                    source_thread_id TEXT NOT NULL,
                    candidate_type TEXT NOT NULL,
                    target_skill_id TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates(status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_skill_candidates_task_id ON skill_candidates(source_task_id)")
            conn.commit()

    def save_candidate(self, candidate: SkillCandidate) -> None:
        """Persist a candidate to SQLite."""
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO skill_candidates (
                    candidate_id, name, description, procedure, requirements,
                    confidence, source_task_id, source_thread_id, candidate_type,
                    target_skill_id, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.candidate_id,
                    candidate.name,
                    candidate.description,
                    json.dumps(candidate.procedure, ensure_ascii=False),
                    json.dumps(candidate.requirements, ensure_ascii=False),
                    candidate.confidence,
                    candidate.source_task_id,
                    candidate.source_thread_id,
                    candidate.candidate_type,
                    candidate.target_skill_id,
                    candidate.status,
                    candidate.created_at
                )
            )
            conn.commit()

    def get_candidate(self, candidate_id: str) -> Optional[SkillCandidate]:
        """Fetch a specific candidate by ID."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT * FROM skill_candidates WHERE candidate_id = ?", (candidate_id,))
            row = cursor.fetchone()
            if not row:
                return None
            return SkillCandidate(
                candidate_id=row["candidate_id"],
                name=row["name"],
                description=row["description"],
                procedure=json.loads(row["procedure"]),
                requirements=json.loads(row["requirements"]),
                confidence=row["confidence"],
                source_task_id=row["source_task_id"],
                source_thread_id=row["source_thread_id"],
                candidate_type=row["candidate_type"],
                target_skill_id=row["target_skill_id"],
                status=row["status"],
                created_at=row["created_at"]
            )

    def list_pending_candidates(self) -> List[SkillCandidate]:
        """Fetch all candidates awaiting human review."""
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT * FROM skill_candidates WHERE status = 'pending_review' ORDER BY created_at DESC")
            rows = cursor.fetchall()
            return [
                SkillCandidate(
                    candidate_id=r["candidate_id"],
                    name=r["name"],
                    description=r["description"],
                    procedure=json.loads(r["procedure"]),
                    requirements=json.loads(r["requirements"]),
                    confidence=r["confidence"],
                    source_task_id=r["source_task_id"],
                    source_thread_id=r["source_thread_id"],
                    candidate_type=r["candidate_type"],
                    target_skill_id=r["target_skill_id"],
                    status=r["status"],
                    created_at=r["created_at"]
                )
                for r in rows
            ]

    def update_status(self, candidate_id: str, status: str) -> bool:
        """Update candidate status (e.g. approved, rejected)."""
        with self._get_connection() as conn:
            cursor = conn.execute("UPDATE skill_candidates SET status = ? WHERE candidate_id = ?", (status, candidate_id))
            conn.commit()
            return cursor.rowcount > 0


class DeterministicTrajectoryFilter:
    """
    Quality and Novelty Gates applied BEFORE invoking the LLM Trajectory Evaluator.
    Prevents token waste on failed, trivial, or duplicate task trajectories.
    """
    @staticmethod
    def evaluate_pre_filter(task_id: str) -> Tuple[bool, str]:
        """
        Check if a task trajectory is eligible for skill extraction.
        Returns (passes: bool, reason: str).
        """
        events = trajectory_store.get_task_trajectory(task_id)
        if not events:
            return False, "Trajectory is empty or task_id not found."

        event_types = [e["event_type"] for e in events]

        # 1. Must be completed successfully
        if "task.completed" not in event_types:
            return False, "Task did not complete successfully (missing task.completed event)."

        # 2. Must not contain unhandled fatal errors
        for e in events:
            if e.get("event_type") == "tool.failed":
                meta = e.get("metadata") or {}
                if isinstance(meta, str):
                    try:
                        meta = json.loads(meta)
                    except Exception:
                        pass
                if meta.get("fatal") is True or meta.get("category") == "fatal":
                    return False, f"Task contains unhandled fatal error in tool '{e.get('tool_name')}'."

        # 3. Must not have unapproved / rejected approval requests
        for e in events:
            if e.get("event_type") == "approval.requested" and e.get("status") == "awaiting_approval":
                return False, "Task contains unresolved approval request."

        # 4. Multi-step gate: Must have at least 2 distinct tool execution turns
        completed_tools = [e for e in events if e.get("event_type") == "tool.completed"]
        if len(completed_tools) < 2:
            return False, f"Task is single-step atomic ({len(completed_tools)} tool call(s)). Requires >= 2 tool steps to qualify as a procedural skill candidate."

        # 5. Novelty Gate against existing Skill Library
        db_skills = list_skills()
        tool_names = set([e.get("tool_name") for e in completed_tools if e.get("tool_name")])
        
        # Extract command strings / arguments from completed tool events
        command_texts = []
        for e in completed_tools:
            args = e.get("tool_args") or {}
            res = e.get("tool_result") or ""
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            if isinstance(args, dict):
                cmd = args.get("command", "") or args.get("name", "")
                if cmd:
                    command_texts.append(str(cmd).lower())
            if isinstance(res, str) and res:
                command_texts.append(res.lower())

        # Check if an existing skill already encompasses this exact procedure
        for skill in db_skills:
            skill_name = skill.get("name", "").lower()
            skill_content = (skill.get("content") or "").lower()
            skill_desc = (skill.get("description") or "").lower()
            combined_skill_doc = f"{skill_name} {skill_desc} {skill_content}"

            # If all commands / tools executed are already covered in an existing skill documentation
            if command_texts and all(any(c in combined_skill_doc for c in cmd.split()) for cmd in command_texts):
                return False, f"Procedure already covered by existing skill '{skill.get('name')}'."

            if "windows system tasks" in skill_name and tool_names.issubset({"run_terminal_command", "app_control", "get_desktop_state"}):
                if any("get-process" in cmd for cmd in command_texts) and any("notepad" in cmd for cmd in command_texts):
                    return False, f"Procedure already covered by existing skill '{skill.get('name')}'."

        return True, f"Passed quality and novelty gates ({len(completed_tools)} completed tool steps)."


class TrajectoryEvaluator:
    """
    Evaluator that converts execution trajectories into clean, parameterized procedure templates.
    """
    @staticmethod
    def _extract_generalized_template(tool_name: str, tool_args: Dict[str, Any]) -> str:
        """Generalize concrete argument literals into parameterized placeholders."""
        if tool_name in ("run_terminal_command", "terminal_tool"):
            cmd = tool_args.get("command", "")
            # Parameterize WiFi SSID
            cmd = re.sub(r'name="([^"]+)"', 'name="{ssid}"', cmd)
            # Parameterize Process name
            cmd = re.sub(r'Get-Process\s+([a-zA-Z0-9_\-]+)', 'Get-Process {process_name}', cmd)
            return cmd
        elif tool_name == "app_control":
            mode = tool_args.get("mode", "launch")
            name = tool_args.get("name", "{app_name}")
            return f"app_control(mode='{mode}', name='{name}')"
        elif tool_name == "gmail_send_mail":
            return "gmail_send_mail(recipient='{recipient}', subject='{subject}', body='{body}')"
        
        return json.dumps(tool_args)

    @classmethod
    async def evaluate_task_trajectory(
        cls,
        task_id: str,
        llm: Optional[Any] = None,
        override_name: Optional[str] = None,
        override_description: Optional[str] = None
    ) -> Optional[SkillCandidate]:
        """
        Evaluate a task trajectory, extract procedural templates, and produce a SkillCandidate.
        """
        passes, reason = DeterministicTrajectoryFilter.evaluate_pre_filter(task_id)
        if not passes:
            _logger.info("Task %s rejected by pre-filter: %s", task_id, reason)
            return None

        events = trajectory_store.get_task_trajectory(task_id)
        completed_tools = [e for e in events if e.get("event_type") == "tool.completed"]
        thread_id = events[0].get("thread_id", "default_thread") if events else "default_thread"

        procedure_steps = []
        for idx, e in enumerate(completed_tools, 1):
            tool_name = e.get("tool_name", "unknown_tool")
            tool_args = e.get("tool_args") or {}
            if isinstance(tool_args, str):
                try:
                    tool_args = json.loads(tool_args)
                except Exception:
                    tool_args = {}

            template = cls._extract_generalized_template(tool_name, tool_args)
            procedure_steps.append({
                "step": idx,
                "tool": tool_name,
                "template": template,
                "purpose": f"Execute {tool_name} to advance task."
            })

        candidate_name = override_name or f"Procedural Workflow for Task {task_id}"
        candidate_desc = override_description or f"Automated multi-step workflow extracted from task {task_id}."

        # Detect requirements
        requirements = []
        all_tools = [step["tool"] for step in procedure_steps]
        if any("terminal" in t or "app_control" in t for t in all_tools):
            requirements.append("Windows OS")
        if any("gmail" in t for t in all_tools):
            requirements.append("Gmail Integration")
        if any("browser" in t for t in all_tools):
            requirements.append("Browser Automation")

        candidate = SkillCandidate(
            name=candidate_name,
            description=candidate_desc,
            procedure=procedure_steps,
            requirements=requirements or ["Standard Agent Tools"],
            confidence=0.92,
            source_task_id=task_id,
            source_thread_id=thread_id,
            candidate_type="new_skill",
            status="pending_review"
        )

        return candidate


def promote_candidate_to_skill_library(candidate_id: str, store: Optional[SkillCandidateStore] = None) -> Optional[Dict[str, Any]]:
    """
    Promote an approved SkillCandidate directly into Rie's active production Skill Library.
    Formats the procedural template into clean markdown skill instructions and invokes create_skill.
    """
    candidate_store = store or skill_candidate_store
    candidate = candidate_store.get_candidate(candidate_id)
    if not candidate:
        raise ValueError(f"SkillCandidate with ID '{candidate_id}' not found.")

    # Format procedural steps into markdown instructions
    steps_md = []
    for step in candidate.procedure:
        steps_md.append(f"{step.get('step', 1)}. **{step.get('tool')}**:\n   `{step.get('template')}`\n   *Purpose: {step.get('purpose')}*")

    content = (
        f"## Objective\n{candidate.description}\n\n"
        f"## Requirements\n" + "\n".join([f"- {r}" for r in candidate.requirements]) + "\n\n"
        f"## Execution Procedure\n" + "\n".join(steps_md) + "\n\n"
        f"## Confidence & Provenance\n- Confidence Score: {candidate.confidence:.2f}\n- Source Task: `{candidate.source_task_id}`"
    )

    candidate_tools = list(set([s.get("tool") for s in candidate.procedure if s.get("tool")]))

    # Create active skill in DB
    new_skill = create_skill(
        name=candidate.name,
        description=candidate.description,
        content=content,
        icon="⚡",
        tool_ids=candidate_tools
    )

    # Mark candidate as approved
    candidate_store.update_status(candidate_id, "approved")
    _logger.info("Promoted SkillCandidate '%s' to active Skill Library (ID: %s)", candidate.name, new_skill.get("id"))
    return new_skill


# Global default instance
skill_candidate_store = SkillCandidateStore()

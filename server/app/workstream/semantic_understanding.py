"""
Deep Semantic Understanding Engine for Rie-AI Workstream (Phase 4.1).
Infers high-level task intent, goals, underlying problems, technologies, progress,
and unresolved issues from cross-sensor session signals.
"""
from datetime import datetime, timezone
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Set

from app.workstream.models import WorkSession, SessionUnderstanding

logger = logging.getLogger("workstream.semantic_understanding")


def _detect_technologies(
    files: List[str],
    commands: List[Any],
    topics: List[str],
    project: Optional[str],
    primary_apps: Optional[List[str]] = None
) -> List[str]:
    """Infers tech stack from file extensions, paths, command names, topics, and applications."""
    techs: Set[str] = set()

    for f in files:
        low = f.lower()
        if low.endswith(".py"):
            techs.add("Python")
        elif low.endswith((".ts", ".tsx")):
            techs.add("TypeScript")
            techs.add("React")
        elif low.endswith((".js", ".jsx")):
            techs.add("JavaScript")
            techs.add("React")
        elif low.endswith(".rs"):
            techs.add("Rust")
            techs.add("Tauri")
        elif low.endswith(".ps1"):
            techs.add("PowerShell")
        elif low.endswith((".sh", ".bash")):
            techs.add("Bash")
        elif low.endswith((".sql", ".sqlite", ".db")):
            techs.add("SQLite")
        elif low.endswith((".html", ".css")):
            techs.add("HTML/CSS")

        if "fastapi" in low or "router.py" in low:
            techs.add("FastAPI")
        if "dispatcher" in low or "voice" in low:
            techs.add("Live Voice")
        if "chroma" in low or "memory" in low:
            techs.add("ChromaDB")
            techs.add("Long-Term Memory")
        if "workstream" in low:
            techs.add("Workstream Engine")

    for c in commands:
        cmd_str = c if isinstance(c, str) else (c.get("command", "") if isinstance(c, dict) else "")
        cmd_low = cmd_str.lower()
        if "pytest" in cmd_low:
            techs.add("pytest")
            techs.add("Python")
        if "poetry" in cmd_low:
            techs.add("Poetry")
        if "npm" in cmd_low or "node" in cmd_low:
            techs.add("Node.js")
        if "cargo" in cmd_low:
            techs.add("Rust")
        if "git" in cmd_low:
            techs.add("Git")
        if "docker" in cmd_low:
            techs.add("Docker")
        if "uvicorn" in cmd_low:
            techs.add("FastAPI")
            techs.add("Uvicorn")

    for t in topics:
        t_low = t.lower()
        if "terminal" in t_low:
            techs.add("Terminal / Shell")
        if "langchain" in t_low:
            techs.add("LangChain")
        if "browser" in t_low:
            techs.add("Browser Extension")

    for app in (primary_apps or []):
        low_app = app.lower()
        if "powershell" in low_app:
            techs.add("PowerShell")
        elif "chrome" in low_app or "brave" in low_app or "edge" in low_app or "browser" in low_app:
            techs.add("Browser")
        elif "antigravity" in low_app or "code" in low_app:
            techs.add("VS Code / IDE")

    return sorted(list(techs))


def _identify_component(files: List[str], project: Optional[str]) -> str:
    """Identifies the primary architectural component worked on."""
    if not files:
        return project or "the project"

    # Count component occurrences
    comp_scores: Dict[str, int] = {
        "Live Voice Tool Dispatcher": 0,
        "Workstream Session Engine": 0,
        "Terminal Shell Integration": 0,
        "Authentication & Security": 0,
        "Frontend Desktop UI": 0,
        "API Gateway & Routes": 0,
        "Long-Term Memory Store": 0,
    }

    for f in files:
        low = f.lower()
        if "dispatcher" in low or "live_voice" in low:
            comp_scores["Live Voice Tool Dispatcher"] += 3
        if "session" in low or "aggregator" in low or "workstream" in low:
            comp_scores["Workstream Session Engine"] += 3
        if "terminal" in low or "shell" in low or "rie-shell" in low:
            comp_scores["Terminal Shell Integration"] += 3
        if "auth" in low or "security" in low:
            comp_scores["Authentication & Security"] += 3
        if "client" in low or "component" in low or "jsx" in low or "tsx" in low:
            comp_scores["Frontend Desktop UI"] += 3
        if "router" in low or "api" in low:
            comp_scores["API Gateway & Routes"] += 2
        if "memory" in low or "chroma" in low:
            comp_scores["Long-Term Memory Store"] += 3

    top_comp = max(comp_scores.items(), key=lambda x: x[1])
    if top_comp[1] > 0:
        return top_comp[0]

    # Fallback to base filename or project
    base = os.path.basename(files[0])
    name, _ = os.path.splitext(base)
    clean_name = name.replace("_", " ").title()
    return f"{clean_name} Module"


class SemanticUnderstandingEngine:
    """
    Phase 4.1: Extracts and synthesizes Task, Goal, Problem, Technologies,
    Progress, and Unresolved Issues for developer work sessions.
    """

    def infer_session_understanding(self, session: WorkSession) -> SessionUnderstanding:
        """
        Infers high-level understanding for a work session.
        Combines deterministic heuristics with optional LLM reasoning.
        """
        # 1. Deterministic heuristic baseline
        base = self._infer_heuristic(session)

        # 2. Attempt LLM enhancement if configured
        try:
            enhanced = self._infer_with_llm(session, base)
            if enhanced:
                return enhanced
        except Exception as e:
            logger.debug("LLM semantic enhancement skipped (%s); using heuristic baseline.", e)

        return base

    def _infer_heuristic(self, session: WorkSession) -> SessionUnderstanding:
        """Rule-based semantic intent extraction from signals."""
        files = session.files or []
        commands = session.commands or []
        domains = session.domains or []
        meta = session.metadata or {}
        project = session.project or "General"
        branch = meta.get("git_branch") or (meta.get("git_branches", [None])[0] if meta.get("git_branches") else None)

        component = _identify_component(files, project)
        technologies = _detect_technologies(files, commands, session.topics or [], project, session.primary_apps or [])

        # Inspect commands and exit codes
        interrupted_cmds: List[str] = meta.get("interrupted_commands", [])
        failed_cmds: List[str] = []
        test_cmds: List[str] = []
        for c in commands:
            if isinstance(c, dict):
                cmd_line = c.get("command", "")
                if c.get("status") == "interrupted":
                    if cmd_line and cmd_line not in interrupted_cmds:
                        interrupted_cmds.append(cmd_line)
                elif c.get("exit_code") and c.get("exit_code") != 0:
                    failed_cmds.append(cmd_line)
                if "pytest" in cmd_line or "test" in cmd_line:
                    test_cmds.append(cmd_line)
            elif isinstance(c, str):
                if "pytest" in c or "test" in c:
                    test_cmds.append(c)

        unresolved_issues: List[str] = []
        for ic in interrupted_cmds:
            unresolved_issues.append(f"Command interrupted via Ctrl+C: `{ic}`")
        for fc in failed_cmds[:2]:
            unresolved_issues.append(f"Command failed with non-zero exit: `{fc}`")

        # Determine task, goal, problem, and status
        status = "completed"
        decisions: List[str] = []
        progress: Optional[str] = None

        is_debugging = bool(failed_cmds or interrupted_cmds or (branch and any(k in branch.lower() for k in ("fix", "bug", "issue", "debug"))))
        if not is_debugging and any("error" in (f or "").lower() or "exception" in (f or "").lower() for f in files):
            is_debugging = True

        if is_debugging:
            task = f"Debugging and resolving issues in {component}"
            if interrupted_cmds:
                problem = f"Investigating command execution or interruption flow during `{interrupted_cmds[0]}`"
                status = "interrupted"
            elif failed_cmds:
                problem = f"Investigating failure in test/command: `{failed_cmds[0]}`"
                status = "in_progress"
            else:
                problem = f"Investigating bugs reported in {branch or component}"
                status = "in_progress" if not session.is_finalized else "completed"

            goal = f"Fix underlying errors in {component} and ensure all test suites pass reliably"
            if files:
                progress = f"Inspected and modified {len(files)} file(s), including `{os.path.basename(files[0])}`"
        elif files and (meta.get("lines_added", 0) > 0 or meta.get("lines_removed", 0) > 0):
            task = f"Implementing core features and updates in {component}"
            goal = f"Build and enhance functionality for {component} in {project}"
            problem = None
            added = meta.get("lines_added", 0)
            removed = meta.get("lines_removed", 0)
            diff_str = f" (+{added}/-{removed} lines)" if added or removed else ""
            progress = f"Updated {', '.join([os.path.basename(f) for f in files[:3]])}{diff_str}"
            status = "completed" if session.is_finalized else "in_progress"
        elif domains and not files and not commands:
            task = f"Technical research and documentation review on {', '.join(domains[:2])}"
            goal = f"Investigate architectural approaches and API documentation for {project}"
            problem = f"Researching implementation details on {domains[0]}"
            progress = f"Reviewed documentation and resources on {', '.join(domains[:3])}"
            status = "completed"
        elif test_cmds and not files:
            task = f"Running test suites and verifying stability in {component}"
            goal = f"Ensure regression tests and test suites pass across {project}"
            problem = None
            progress = f"Executed {len(test_cmds)} test command(s)"
            status = "completed"
        else:
            task = f"General development and workspace activity in {component}"
            goal = f"Work on {project} tasks across {', '.join(session.primary_apps[:2]) if session.primary_apps else 'desktop'}"
            problem = None
            progress = session.summary
            status = "completed" if session.is_finalized else "in_progress"

        if branch:
            decisions.append(f"Working on dedicated branch `{branch}`")
        if interrupted_cmds and status != "completed":
            if not unresolved_issues:
                unresolved_issues.append(f"Verify interrupted command `{interrupted_cmds[0]}`")

        return SessionUnderstanding(
            task=task,
            goal=goal,
            problem=problem,
            technologies=technologies,
            status=status,
            progress=progress,
            decisions=decisions,
            unresolved_issues=unresolved_issues,
            confidence=0.88,
            source="heuristic",
            created_at=datetime.now(timezone.utc).isoformat()
        )

    def _infer_with_llm(self, session: WorkSession, base: SessionUnderstanding) -> Optional[SessionUnderstanding]:
        """Optionally queries an active LLM for deep semantic reasoning."""
        import sys
        if "pytest" in sys.modules or os.getenv("TESTING"):
            return None

        try:
            from app.agent import agent_manager
            if not getattr(agent_manager, "is_configured", False):
                return None
            llm = getattr(agent_manager, "_llm", None) or agent_manager._create_llm_for_peer()
            if not llm:
                return None
        except Exception:
            return None

        # Build concise extraction prompt
        meta = session.metadata or {}
        prompt_data = {
            "title": session.title,
            "project": session.project,
            "git_branches": meta.get("git_branches") or ([meta.get("git_branch")] if meta.get("git_branch") else []),
            "files_modified": session.files[:8],
            "commands": session.commands[:6],
            "domains": session.domains[:4],
            "interrupted_commands": meta.get("interrupted_commands", []),
            "heuristic_baseline": {
                "task": base.task,
                "goal": base.goal,
                "problem": base.problem,
            }
        }

        system_prompt = (
            "You are an expert AI software engineering analyst. "
            "Analyze the developer's work session activity and deduce their true intent, goal, and problem. "
            "Respond ONLY with a valid JSON object matching this schema:\n"
            "{\n"
            '  "task": "High-level summary of what task was being performed",\n'
            '  "goal": "Main objective of the session",\n'
            '  "problem": "Specific bug, obstacle, or problem being investigated or solved (or null if none)",\n'
            '  "technologies": ["list", "of", "technologies"],\n'
            '  "status": "completed" | "in_progress" | "interrupted",\n'
            '  "progress": "Key progress milestone achieved",\n'
            '  "decisions": ["technical decision 1"],\n'
            '  "unresolved_issues": ["unresolved issue 1"]\n'
            "}"
        )

        try:
            from langchain_core.messages import SystemMessage, HumanMessage
            response = llm.invoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=f"Work session signals:\n{json.dumps(prompt_data, indent=2)}")
            ])
            text = str(getattr(response, "content", "")).strip()

            # Clean markdown code blocks
            if text.startswith("```"):
                text = re.sub(r"^```(?:json)?\s*", "", text)
                text = re.sub(r"\s*```$", "", text)

            data = json.loads(text)
            return SessionUnderstanding(
                task=data.get("task") or base.task,
                goal=data.get("goal") or base.goal,
                problem=data.get("problem") or base.problem,
                technologies=data.get("technologies") or base.technologies,
                status=data.get("status") or base.status,
                progress=data.get("progress") or base.progress,
                decisions=data.get("decisions") or base.decisions,
                unresolved_issues=data.get("unresolved_issues") or base.unresolved_issues,
                confidence=0.95,
                source="llm",
                created_at=datetime.now(timezone.utc).isoformat()
            )
        except Exception as err:
            logger.debug("LLM extraction failed (%s), falling back to heuristic", err)
            return None

    def enrich_work_session(self, session: WorkSession) -> WorkSession:
        """Computes and attaches SessionUnderstanding to a WorkSession."""
        session.understanding = self.infer_session_understanding(session)
        return session

    def enrich_sessions(self, sessions: List[WorkSession]) -> List[WorkSession]:
        """Enriches a batch of WorkSessions."""
        for s in sessions:
            self.enrich_work_session(s)
        return sessions


# Global singleton instance
semantic_understanding_engine = SemanticUnderstandingEngine()

"""
Human-In-The-Loop (HITL) Safety Boundaries for Rie Agent Runtime.

Classifies operations by risk level:
- READ: Information extraction -> Auto-approved.
- BENIGN_WRITE: Standard safe UI actions & state updates -> Auto-approved.
- DESTRUCTIVE / EXTERNAL: Mail sending/deletion, file wiping, destructive shell commands -> Suspends task and requires approval.
"""
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Set
import re
import uuid
from datetime import datetime, timezone


class ActionRiskLevel(str, Enum):
    READ = "read"
    BENIGN_WRITE = "benign_write"
    DESTRUCTIVE = "destructive"


# High-risk tool names & destructive command patterns
DESTRUCTIVE_TOOLS = {
    "gmail_send_mail",
    "gmail_delete_mail",
    "gmail_batch_delete",
    "github_delete_repo",
    "jira_delete_issue",
}

DESTRUCTIVE_COMMAND_PATTERNS = [
    re.compile(r'(?i)\b(?:rmdir|del|erase|Remove-Item)\s+.*[/\\](?:\*|\.|\.\.)'),
    re.compile(r'(?i)\b(?:Format-Volume|Clear-Disk|Initialize-Disk|diskpart)\b'),
    re.compile(r'(?i)\b(?:Drop-Database|DROP\s+TABLE|DELETE\s+FROM)\b'),
    re.compile(r'(?i)\b(?:Stop-Computer|Restart-Computer|shutdown\s+/[srf])\b'),
]


@dataclass
class ApprovalRequest:
    approval_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    task_id: str = ""
    thread_id: str = ""
    tool_name: str = ""
    tool_args: Dict[str, Any] = field(default_factory=dict)
    risk_level: ActionRiskLevel = ActionRiskLevel.DESTRUCTIVE
    reason: str = ""
    status: str = "pending"  # pending, approved, rejected
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class HITLApprovalManager:
    """
    Manages approval requests and decisions for high-risk operations.
    Suspends execution when an unapproved destructive action is encountered.
    """
    def __init__(self):
        self._pending_approvals: Dict[str, ApprovalRequest] = {}
        self._approved_actions: Set[str] = set()

    def assess_risk(self, tool_name: str, tool_args: Dict[str, Any]) -> tuple[ActionRiskLevel, str]:
        """Assess the risk tier of a tool call."""
        # 1. Known destructive tool names or high-risk keywords in custom tools
        if tool_name in DESTRUCTIVE_TOOLS or any(k in tool_name.lower() for k in ("charge", "payment", "refund", "transfer_funds", "delete", "drop", "terminate")):
            return ActionRiskLevel.DESTRUCTIVE, f"Tool '{tool_name}' performs external, financial, or irreversible side-effects."

        # 2. Terminal commands risk evaluation
        if tool_name in ("run_terminal_command", "terminal_tool"):
            cmd = tool_args.get("command", "")
            for pattern in DESTRUCTIVE_COMMAND_PATTERNS:
                if pattern.search(cmd):
                    return ActionRiskLevel.DESTRUCTIVE, f"Terminal command matches destructive pattern: '{pattern.pattern}'."

        # 3. Standard UI / Desktop / Safe tools
        if tool_name in ("internet_search", "read_knowledge_asset", "get_desktop_state", "get_memory", "search_memory"):
            return ActionRiskLevel.READ, "Read-only operation."

        return ActionRiskLevel.BENIGN_WRITE, "Benign write operation."

    def is_approval_required(self, task_id: str, thread_id: str, tool_name: str, tool_args: Dict[str, Any]) -> Optional[ApprovalRequest]:
        """Check if action requires user confirmation. Returns ApprovalRequest if required and pending."""
        risk, reason = self.assess_risk(tool_name, tool_args)
        if risk != ActionRiskLevel.DESTRUCTIVE:
            return None

        # Check if already approved
        action_sig = f"{thread_id}:{tool_name}:{str(sorted(tool_args.items()))}"
        if action_sig in self._approved_actions:
            return None

        req = ApprovalRequest(
            task_id=task_id,
            thread_id=thread_id,
            tool_name=tool_name,
            tool_args=tool_args,
            risk_level=risk,
            reason=reason,
            status="pending"
        )
        self._pending_approvals[req.approval_id] = req
        return req

    def grant_approval(self, approval_id: str) -> bool:
        """Approve a pending action."""
        if approval_id in self._pending_approvals:
            req = self._pending_approvals.pop(approval_id)
            req.status = "approved"
            action_sig = f"{req.thread_id}:{req.tool_name}:{str(sorted(req.tool_args.items()))}"
            self._approved_actions.add(action_sig)
            return True
        return False

    def reject_approval(self, approval_id: str) -> bool:
        """Reject a pending action."""
        if approval_id in self._pending_approvals:
            req = self._pending_approvals.pop(approval_id)
            req.status = "rejected"
            return True
        return False


# Global default instance
hitl_manager = HITLApprovalManager()

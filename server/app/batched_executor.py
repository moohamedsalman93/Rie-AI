"""
Programmatic & Batched Tool Execution module for Rie Agent Runtime.

Allows the agent to execute multi-step deterministic tool chains in a single turn
while strictly preserving all Phase 1–3 invariants:
- Per-step execution duration timing
- Granular event ledger recording (tool.started, tool.completed, retry.decided, tool.failed)
- Human-In-The-Loop (HITL) approval gates before high-risk operations
- 3-tier error classification and bounded retry for transient errors
"""
import time
import json
import uuid
import asyncio
import logging
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

from langchain_core.tools import tool, StructuredTool
from langchain_core.messages import ToolMessage
from app.trajectory import trajectory_store, TaskEvent
from app.error_classifier import classify_tool_error, ErrorCategory
from app.hitl import hitl_manager

_logger = logging.getLogger(__name__)


class BatchedStepInput(BaseModel):
    step_id: str = Field(..., description="Unique step identifier (e.g. 'step_1')")
    tool_name: str = Field(..., description="The name of the tool to execute")
    args: Dict[str, Any] = Field(default_factory=dict, description="Arguments to pass to the tool")
    description: Optional[str] = Field(None, description="Human-readable explanation of this step")


class BatchedPlanInput(BaseModel):
    plan_id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8], description="Plan execution ID")
    steps: List[BatchedStepInput] = Field(..., description="List of sequential tool steps to execute")
    stop_on_error: bool = Field(True, description="Whether to halt execution immediately if a step fails")


class BatchedExecutor:
    """
    Executes a BatchedPlan while recording telemetry and checking safety boundaries.
    """
    def __init__(self, tool_registry: Optional[Dict[str, Any]] = None):
        self.tool_registry = tool_registry or {}

    async def execute_plan(
        self,
        plan: BatchedPlanInput,
        task_id: str = "batch_task",
        thread_id: str = "batch_thread",
        step_number: int = 1
    ) -> Dict[str, Any]:
        """Execute all steps in the plan with safety and telemetry."""
        results = []
        overall_status = "completed"

        for step in plan.steps:
            tool_name = step.tool_name
            tool_args = step.args
            step_id = step.step_id
            t0 = time.time()

            # 1. HITL Safety Gate Check
            approval_req = hitl_manager.is_approval_required(task_id, thread_id, tool_name, tool_args)
            if approval_req:
                trajectory_store.record_event(TaskEvent(
                    task_id=task_id,
                    thread_id=thread_id,
                    event_type="approval.requested",
                    step_number=step_number,
                    tool_name=tool_name,
                    tool_args=tool_args,
                    status="awaiting_approval",
                    metadata={"approval_id": approval_req.approval_id, "step_id": step_id}
                ))
                results.append({
                    "step_id": step_id,
                    "tool_name": tool_name,
                    "status": "awaiting_approval",
                    "approval_id": approval_req.approval_id,
                    "error": f"[APPROVAL REQUIRED] Operation '{tool_name}' requires user authorization."
                })
                overall_status = "suspended_for_approval"
                break

            # 2. Tool Lookup
            target_tool = self.tool_registry.get(tool_name)
            if not target_tool:
                err_msg = f"Tool '{tool_name}' not found in registry."
                trajectory_store.record_event(TaskEvent(
                    task_id=task_id,
                    thread_id=thread_id,
                    event_type="tool.failed",
                    step_number=step_number,
                    tool_name=tool_name,
                    tool_args=tool_args,
                    status="error",
                    error=err_msg
                ))
                results.append({
                    "step_id": step_id,
                    "tool_name": tool_name,
                    "status": "error",
                    "error": err_msg
                })
                if plan.stop_on_error:
                    overall_status = "failed"
                    break
                continue

            # 3. Record tool.started
            trajectory_store.record_event(TaskEvent(
                task_id=task_id,
                thread_id=thread_id,
                event_type="tool.started",
                step_number=step_number,
                tool_name=tool_name,
                tool_args=tool_args,
                metadata={"step_id": step_id}
            ))

            # 4. Tool Execution with Bounded Retry
            retries = 0
            max_retries = 2
            step_success = False
            output_content = None

            while not step_success:
                try:
                    if hasattr(target_tool, "ainvoke"):
                        raw_res = await target_tool.ainvoke(tool_args)
                    elif hasattr(target_tool, "invoke"):
                        raw_res = target_tool.invoke(tool_args)
                    elif callable(target_tool):
                        if asyncio.iscoroutinefunction(target_tool):
                            raw_res = await target_tool(**tool_args)
                        else:
                            raw_res = target_tool(**tool_args)
                    else:
                        raise ValueError(f"Target tool '{tool_name}' is not callable.")

                    dur = time.time() - t0
                    output_content = getattr(raw_res, "content", raw_res)

                    # Check for transient error in output
                    classification = classify_tool_error(tool_name, output=output_content)
                    if classification.category == ErrorCategory.TRANSIENT and classification.retry_recommended and retries < max_retries:
                        retries += 1
                        trajectory_store.record_event(TaskEvent(
                            task_id=task_id,
                            thread_id=thread_id,
                            event_type="retry.decided",
                            step_number=step_number,
                            tool_name=tool_name,
                            duration=dur,
                            status="retrying",
                            error=classification.reason,
                            metadata={"step_id": step_id, "retry_count": retries}
                        ))
                        await asyncio.sleep(classification.backoff_seconds * retries)
                        continue

                    # Record tool.completed
                    trajectory_store.record_event(TaskEvent(
                        task_id=task_id,
                        thread_id=thread_id,
                        event_type="tool.completed",
                        step_number=step_number,
                        tool_name=tool_name,
                        tool_args=tool_args,
                        tool_result=output_content,
                        duration=dur,
                        status="ok",
                        metadata={"step_id": step_id}
                    ))
                    results.append({
                        "step_id": step_id,
                        "tool_name": tool_name,
                        "status": "ok",
                        "duration": round(dur, 2),
                        "output": output_content
                    })
                    step_success = True

                except Exception as exc:
                    dur = time.time() - t0
                    classification = classify_tool_error(tool_name, error=exc)
                    if classification.category == ErrorCategory.TRANSIENT and classification.retry_recommended and retries < max_retries:
                        retries += 1
                        trajectory_store.record_event(TaskEvent(
                            task_id=task_id,
                            thread_id=thread_id,
                            event_type="retry.decided",
                            step_number=step_number,
                            tool_name=tool_name,
                            duration=dur,
                            status="retrying",
                            error=str(exc),
                            metadata={"step_id": step_id, "retry_count": retries}
                        ))
                        await asyncio.sleep(classification.backoff_seconds * retries)
                        continue

                    # Fatal or exhausted retry
                    trajectory_store.record_event(TaskEvent(
                        task_id=task_id,
                        thread_id=thread_id,
                        event_type="tool.failed",
                        step_number=step_number,
                        tool_name=tool_name,
                        tool_args=tool_args,
                        duration=dur,
                        status="error",
                        error=str(exc),
                        metadata={"step_id": step_id, "category": classification.category.value}
                    ))
                    results.append({
                        "step_id": step_id,
                        "tool_name": tool_name,
                        "status": "error",
                        "duration": round(dur, 2),
                        "error": str(exc)
                    })
                    if plan.stop_on_error:
                        overall_status = "failed"
                    break

            if overall_status in ("failed", "suspended_for_approval"):
                break

        return {
            "plan_id": plan.plan_id,
            "overall_status": overall_status,
            "completed_steps": len([r for r in results if r.get("status") == "ok"]),
            "total_steps": len(plan.steps),
            "step_results": results
        }


# Global tool registry for batched execution
batched_tool_registry: Dict[str, Any] = {}
batched_executor = BatchedExecutor(batched_tool_registry)


@tool(args_schema=BatchedPlanInput)
async def execute_batched_plan(
    plan_id: str,
    steps: List[BatchedStepInput],
    stop_on_error: bool = True
) -> str:
    """Execute a deterministic multi-step tool plan sequentially in a single turn with full safety and event telemetry."""
    plan = BatchedPlanInput(plan_id=plan_id, steps=steps, stop_on_error=stop_on_error)
    res = await batched_executor.execute_plan(plan)
    return json.dumps(res, indent=2, ensure_ascii=False)

"""
First-Class Tool Dispatcher for Gemini Live Voice Sessions.
Exposes Rie's unified tool layer (Camoufox browser, Windows desktop automation,
PowerShell commands, media shortcuts, and web search) to Gemini Live function calling.
"""
import asyncio
import contextvars
import json
import logging
import uuid
from typing import Dict, Any, List, Optional, Callable, Awaitable

from app.browser.service import browser_service
from app.windows_tools import app_tool, shortcut_tool, state_tool
from app.tools import internet_search

logger = logging.getLogger("live_tool_dispatcher")

_current_live_context: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar("_current_live_context", default=None)

def set_live_context(ctx: Dict[str, Any]) -> contextvars.Token:
    """Sets the ambient context for the active live voice session."""
    return _current_live_context.set(ctx)

def reset_live_context(token: contextvars.Token) -> None:
    """Resets the ambient context for the active live voice session."""
    try:
        _current_live_context.reset(token)
    except Exception:
        pass

def get_live_context() -> Dict[str, Any]:
    """Retrieves the ambient context for the active live voice session."""
    return _current_live_context.get() or {}

from app.job_manager import job_manager

# Gemini Live Function Declarations (Tiered Fast-Tools + Autonomous Subagent Spawner)
LIVE_TOOL_DECLARATIONS = [
    {
        "name": "spawn_subagent",
        "description": (
            "Spawns Rie's autonomous execution agent to perform tasks requiring "
            "programming, writing or debugging code, running scripts or tests, executing terminal or PowerShell commands, "
            "inspecting or editing files, git workflows, deep web research, or multi-step technical problem solving. "
            "Use mode='background' (default) for long-running workflows so you can continue talking with the user. "
            "Use mode='foreground' only for quick synchronous checks under 10 seconds."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "task": {
                    "type": "STRING",
                    "description": "Clear and comprehensive prompt of what the agent should accomplish, inspect, or produce."
                },
                "mode": {
                    "type": "STRING",
                    "enum": ["background", "foreground"],
                    "description": "Execution mode: 'background' (default, returns job_id immediately and notifies on completion) or 'foreground' (waits for result)."
                }
            },
            "required": ["task"]
        }
    },
    {
        "name": "cancel_subagent",
        "description": "Cancels an active background subagent task or workflow when the user requests to stop, abort, or cancel.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "job_id": {
                    "type": "STRING",
                    "description": "Optional specific job ID (e.g. 'job_123456'). If omitted, cancels the most recent active running subagent."
                }
            }
        }
    },
    {
        "name": "app_tool",
        "description": (
            "Launches or switches to a Windows desktop application. "
            "Examples of application names: 'Spotify', 'Notepad', 'Calculator', 'Chrome', 'Discord', 'VS Code', 'Explorer', 'Settings'."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "mode": {
                    "type": "STRING",
                    "description": "Either 'launch' to open/start an app, or 'switch' to focus an existing window."
                },
                "name": {
                    "type": "STRING",
                    "description": "The name of the desktop application (e.g. 'Notepad', 'Spotify', 'Calculator')."
                }
            },
            "required": ["mode", "name"]
        }
    },
    {
        "name": "press_keys",
        "description": (
            "Presses keyboard shortcuts or multimedia control keys. "
            "Media keys: 'playpause' (media play/pause), 'nexttrack', 'prevtrack', 'volumeup' (volume up), 'volumedown' (volume down), 'volumemute' (mute). "
            "Shortcuts: 'ctrl+c', 'ctrl+v', 'alt+tab', 'space', 'enter'."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "keys": {
                    "type": "STRING",
                    "description": "Key combo or media key name (e.g. 'playpause', 'volumeup', 'volumedown', 'ctrl+c')."
                }
            },
            "required": ["keys"]
        }
    },
    {
        "name": "internet_search",
        "description": (
            "Searches the web in real-time for up-to-date facts, current news, sports scores, weather, stock prices, or quick facts. "
            "Returns top search result snippets."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "Search query keywords."
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "browser_open",
        "description": (
            "Opens the web browser on the desktop and navigates to the given URL. "
            "Use this when the user asks to open a website, watch a video on YouTube, or search for something in the browser."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "url": {
                    "type": "STRING",
                    "description": "Full URL to open, e.g. 'https://youtube.com', 'https://google.com', 'https://github.com'."
                }
            },
            "required": ["url"]
        }
    },
    {
        "name": "save_memory",
        "description": (
            "Saves a user fact, preference, or context into long-term memory across sessions. "
            "Examples: user's name, preferences, favorite tech stack, birthday, project details."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "fact": {
                    "type": "STRING",
                    "description": "The fact, preference, or information to remember."
                },
                "category": {
                    "type": "STRING",
                    "description": "Category for the memory (e.g. 'personal', 'preference', 'work', 'project')."
                }
            },
            "required": ["fact"]
        }
    },
    {
        "name": "search_memory",
        "description": (
            "Searches long-term memory for previously remembered user facts, preferences, or personal context."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "Query to search memories for."
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "schedule_task",
        "description": (
            "Schedules a reminder or timed check in Rie. Specify the time in ISO 8601 format."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "run_at_iso": {
                    "type": "STRING",
                    "description": "When the task or reminder should trigger in ISO 8601 format (e.g. '2026-09-25T14:00:00+05:30')."
                },
                "task_text": {
                    "type": "STRING",
                    "description": "Description of the reminder or task."
                },
                "intent": {
                    "type": "STRING",
                    "description": "Either 'reminder' (notify user), 'analysis_silent', or 'analysis_inform'."
                }
            },
            "required": ["run_at_iso", "task_text"]
        }
    },
    {
        "name": "get_desktop_state",
        "description": "Inspects the user's desktop to see what applications and windows are currently open.",
        "parameters": {
            "type": "OBJECT",
            "properties": {}
        }
    }
]


class RieLiveToolDispatcher:
    """Dispatches Gemini Live function calls to Rie's internal subsystems."""

    def __init__(self):
        self._context_var: contextvars.ContextVar[Optional[Dict[str, Any]]] = contextvars.ContextVar(
            "rie_live_session_context", default=None
        )

    def set_context(self, ctx: Dict[str, Any]) -> None:
        self._context_var.set(ctx)

    def clear_context(self) -> None:
        self._context_var.set(None)

    def get_context(self) -> Dict[str, Any]:
        return self._context_var.get() or {}

    def get_tool_declarations(self) -> List[Dict[str, Any]]:
        """Returns the function declarations list formatted for Gemini Live setup."""
        return LIVE_TOOL_DECLARATIONS

    async def dispatch(
        self,
        tool_name: str,
        args: Dict[str, Any],
        context: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Executes the named tool with provided arguments and returns a concise, conversational result string.
        """
        logger.info(f"[LiveDispatcher] Dispatching tool='{tool_name}' with args={args}")
        ctx = context or self.get_context()
        try:
            # 1. Browser Tools
            if tool_name == "browser_open":
                url = args.get("url", "")
                # Always open visible browser (headless=False) so user can see it on desktop
                res = await browser_service.open_browser(url=url, headless=False)
                if not res.success:
                    return f"Error: {res.message or 'Could not open browser'}"
                return f"Browser opened successfully to {res.url or url}."

            elif tool_name == "browser_navigate":
                url = args.get("url", "")
                res = await browser_service.navigate(url=url)
                if not res.success:
                    return f"Error: {res.message or 'Navigation failed'}"
                return f"Navigated browser to {res.url or url}."

            elif tool_name == "browser_snapshot":
                interactive_only = args.get("interactive_only", True)
                snap = await browser_service.snapshot(interactive_only=interactive_only)
                elements_summary = ", ".join([f"{el.ref} ({el.role}): {el.name}" for el in snap.elements[:10] if el.name])
                return f"Webpage Title: {snap.title}. Elements: {elements_summary or 'None'}. Content: {snap.text[:300] if snap.text else 'N/A'}"

            elif tool_name == "browser_click":
                target = args.get("target", "")
                res = await browser_service.click(target=target)
                if res.success:
                    return f"Successfully clicked on '{target}'."
                return f"Could not click '{target}': {res.message}"

            elif tool_name == "browser_type":
                target = args.get("target", "")
                text = args.get("text", "")
                press_enter = args.get("press_enter", True)
                res = await browser_service.type_text(target=target, text=text)
                if res.success:
                    if press_enter:
                        submitted = await browser_service.send_keyboard_input("Enter")
                        if not submitted.success:
                            return f"Error: Text was entered but submission failed: {submitted.message}"
                    return f"Successfully typed into '{target}'."
                return f"Failed typing into '{target}': {res.message}"

            elif tool_name == "browser_scroll":
                direction = args.get("direction", "down")
                res = await browser_service.scroll(direction=direction)
                if not res.success:
                    return f"Error: {res.message or 'Scroll failed'}"
                return f"Scrolled page {direction}."

            elif tool_name == "browser_extract":
                query = args.get("query", "")
                res = await browser_service.extract(query=query)
                return f"Extracted info: {res.content[:400] if res.content else 'No matching information found.'}"

            elif tool_name == "browser_close":
                res = await browser_service.close_browser()
                if not res.success:
                    return f"Error: {res.message or 'Could not close browser'}"
                return res.message or "Browser closed."

            # 2. Windows Desktop & App Tools
            elif tool_name == "app_tool":
                mode = args.get("mode", "launch")
                name = args.get("name", "")
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, app_tool, mode, name)
                return str(result)

            elif tool_name == "press_keys":
                keys = args.get("keys", "")
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(None, shortcut_tool, keys)
                return f"Pressed keys '{keys}': {result}"

            elif tool_name == "get_desktop_state":
                loop = asyncio.get_running_loop()
                # The shared wrapper initializes COM on this worker thread and
                # formats the DesktopState dataclass correctly.
                return await loop.run_in_executor(None, state_tool, False, False)

            # 3. Web Search
            elif tool_name == "internet_search":
                query = args.get("query", "")
                loop = asyncio.get_running_loop()
                search_data = await loop.run_in_executor(None, internet_search, query)
                if search_data.get("error"):
                    return f"Error: {search_data['error']}"
                results = search_data.get("results", [])
                if not results:
                    return f"No search results found for query: '{query}'."
                summaries = []
                for r in results[:3]:
                    # Every provider normalizes snippets to `content`. Reading
                    # only provider-native fields silently drops the findings.
                    content = r.get("content") or r.get("snippet") or r.get("body") or ""
                    source = r.get("url") or r.get("href") or ""
                    title = r.get("title") or "Search result"
                    summaries.append(f"- {title}: {str(content)[:2000] or 'No summary available.'}"
                                     + (f"\n  Source: {source}" if source else ""))
                return f"Search results for '{query}':\n" + "\n".join(summaries)

            # 4. Long-Term Memory Tools
            elif tool_name == "save_memory":
                fact = str(args.get("fact", "")).strip()
                category = str(args.get("category", "general")).strip()
                if not fact:
                    return "Error: fact is required."
                from app.ltm_tools import _save_memory
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(None, _save_memory, fact, category)

            elif tool_name == "search_memory":
                query = str(args.get("query", "")).strip()
                if not query:
                    return "Error: query is required."
                from app.ltm_tools import _search_memory
                loop = asyncio.get_running_loop()
                return await loop.run_in_executor(None, _search_memory, query)

            # 5. Task & Reminder Scheduling
            elif tool_name == "schedule_task":
                run_at_iso = str(args.get("run_at_iso", "")).strip()
                task_text = str(args.get("task_text", "")).strip()
                intent = str(args.get("intent", "reminder")).strip()
                title = args.get("title")
                if not run_at_iso or not task_text:
                    return "Error: run_at_iso and task_text are required."
                from app.scheduler import scheduler_manager
                ctx = context or get_live_context()
                thread_id = ctx.get("thread_id") or "voice_session"
                job_id = scheduler_manager.add_task(
                    text=task_text,
                    run_at=run_at_iso,
                    thread_id=thread_id,
                    chat_mode="agent",
                    speed_mode="flash",
                    intent=intent,
                    title=title,
                )
                return f"Task scheduled successfully (id={job_id}). Intent={intent}."

            # 6. Autonomous Subagent Spawner (Tier 2 Heavy Agent via JobManager)
            elif tool_name == "spawn_subagent":
                task = str(args.get("task") or args.get("task_description") or "").strip()
                if not task:
                    return "Error: task is required."

                raw_mode = args.get("mode")
                if raw_mode in ("foreground", "background"):
                    mode = raw_mode
                elif args.get("wait_for_result") is True:
                    mode = "foreground"
                else:
                    mode = "background"

                ctx = context or self.get_context()
                thread_id = ctx.get("thread_id")
                notify_callback = ctx.get("notify_callback")
                client_ws = ctx.get("websocket")

                job = job_manager.create_job(task=task, mode=mode, thread_id=thread_id)

                if mode == "foreground":
                    return await self._run_subagent(
                        job=job,
                        notify_callback=notify_callback,
                        client_ws=client_ws,
                    )
                else:
                    task_handle = asyncio.create_task(
                        self._run_subagent(
                            job=job,
                            notify_callback=notify_callback,
                            client_ws=client_ws,
                        )
                    )
                    job_manager.register_async_task(job.job_id, task_handle)
                    return json.dumps({
                        "job_id": job.job_id,
                        "status": "started",
                        "message": (
                            f"Subagent job '{job.job_id}' launched in the background. "
                            "Acknowledge to the user that the agent is running and you'll notify them when finished."
                        )
                    })

            # 7. Cancel Active Subagent Workflow
            elif tool_name == "cancel_subagent":
                job_id = str(args.get("job_id") or "").strip()
                if not job_id:
                    running_jobs = [j for j in job_manager.list_jobs(limit=10) if j.status == "running"]
                    if running_jobs:
                        job_id = running_jobs[0].job_id
                    else:
                        return "No active subagent job is currently running to cancel."

                success = job_manager.cancel_job(job_id)
                ctx = context or self.get_context()
                client_ws = ctx.get("websocket")
                if client_ws:
                    try:
                        await client_ws.send_json({
                            "type": "job_status",
                            "job_id": job_id,
                            "status": "cancelled",
                            "result": "Subagent execution was cancelled by user request.",
                        })
                    except Exception:
                        pass
                if success:
                    return f"Subagent job '{job_id}' was successfully cancelled."
                else:
                    return f"Subagent job '{job_id}' could not be cancelled or is already finished."

            else:
                logger.warning(f"[LiveDispatcher] Unrecognized tool: {tool_name}")
                return f"Error: Unknown tool '{tool_name}'."

        except Exception as e:
            logger.error(f"[LiveDispatcher] Error executing '{tool_name}': {e}", exc_info=True)
            return f"Error executing {tool_name}: {str(e)}"

    async def _run_subagent(
        self,
        job: Any,
        notify_callback: Optional[Callable[[str, str], Awaitable[None]]] = None,
        client_ws: Optional[Any] = None,
    ) -> str:
        job_id = job.job_id
        task = job.task
        logger.info(f"[LiveDispatcher] Starting subagent '{job_id}': {task[:100]}...")

        # Notify client UI that subagent is working
        if client_ws:
            try:
                await client_ws.send_json({
                    "type": "job_status",
                    "job_id": job_id,
                    "task": task,
                    "status": "running",
                })
            except Exception:
                pass

        sub_thread_id = f"voice_subagent_{job_id}"
        final_summary = ""
        try:
            from app.agent import agent_manager
            from app.config import settings

            speed_mode = getattr(settings, "SPEED_MODE", "flash") or "flash"
            user_message = {
                "role": "user",
                "content": (
                    f"{task}\n\n"
                    "[Instruction: You are an autonomous execution subagent spawned by Rie's voice system. "
                    "Use all necessary tools (terminal commands, filesystem read/write/edit, browser, desktop, MCP) "
                    "to thoroughly accomplish this objective. "
                    "Provide a clear, concise final summary of what was accomplished, verified, or discovered.]"
                ),
            }

            ctx = self.get_context()
            async for chunk in agent_manager.stream(
                messages=[user_message],
                thread_id=sub_thread_id,
                chat_mode="agent",
                speed_mode=speed_mode,
                client_timezone=ctx.get("client_timezone"),
                client_local_datetime_iso=ctx.get("client_local_datetime_iso"),
                client_latitude=ctx.get("client_latitude"),
                client_longitude=ctx.get("client_longitude"),
                client_location_accuracy_m=ctx.get("client_location_accuracy_m"),
            ):
                for step, data in chunk.items():
                    if isinstance(data, dict):
                        msgs = data.get("messages")
                        if hasattr(msgs, "value"):
                            msgs = getattr(msgs, "value")
                        if isinstance(msgs, list) and msgs:
                            last_msg = msgs[-1]

                            # Check for tool call events to stream rich progress
                            tool_calls = getattr(last_msg, "tool_calls", None)
                            if tool_calls and isinstance(tool_calls, list):
                                for tc in tool_calls:
                                    tc_name = tc.get("name", "tool") if isinstance(tc, dict) else getattr(tc, "name", "tool")
                                    tc_args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
                                    if tc_name == "run_terminal_command":
                                        cmd = str(tc_args.get("command", "")).strip()[:60]
                                        evt = f"Running command: {cmd}"
                                    elif tc_name in ("write_file", "edit_file"):
                                        p = str(tc_args.get("path", "")).strip()
                                        evt = f"Editing file: {p}"
                                    elif tc_name == "read_file":
                                        p = str(tc_args.get("path", "")).strip()
                                        evt = f"Reading file: {p}"
                                    elif tc_name == "internet_search":
                                        q = str(tc_args.get("query", "")).strip()[:50]
                                        evt = f"Searching web: {q}"
                                    elif tc_name.startswith("browser_"):
                                        evt = f"Browser action: {tc_name}"
                                    elif tc_name == "task":
                                        sub_t = str(tc_args.get("subagent_type", "worker"))
                                        evt = f"Delegating to {sub_t}"
                                    else:
                                        evt = f"Executing {tc_name}"

                                    job_manager.add_event(job_id, evt, meta={"tool": tc_name, "args": tc_args})
                                    if client_ws:
                                        try:
                                            await client_ws.send_json({
                                                "type": "job_progress",
                                                "job_id": job_id,
                                                "task": task,
                                                "event": evt,
                                                "tool_name": tc_name,
                                                "tool_args": tc_args,
                                                "status": "running",
                                            })
                                        except Exception:
                                            pass

                            m_type = getattr(last_msg, "type", "")
                            m_content = getattr(last_msg, "content", "")
                            if m_type in ("ai", "assistant") and m_content:
                                if not getattr(last_msg, "tool_calls", None):
                                    final_summary = str(m_content).strip()

            if not final_summary:
                final_summary = "The subagent completed execution successfully."

            job_manager.complete_job(job_id, final_summary)

        except Exception as e:
            logger.error(f"[LiveDispatcher] Subagent '{job_id}' failed: {e}", exc_info=True)
            final_summary = f"The subagent encountered an error while executing: {str(e)}"
            job_manager.fail_job(job_id, str(e))

        logger.info(f"[LiveDispatcher] Subagent '{job_id}' finished: {final_summary[:150]}")

        # Notify client UI
        if client_ws:
            try:
                await client_ws.send_json({
                    "type": "job_status",
                    "job_id": job_id,
                    "task": task,
                    "status": job.status,
                    "result": final_summary,
                })
            except Exception:
                pass

        # Save to database thread if thread_id is available
        if job.thread_id:
            try:
                from app.database import save_message
                await asyncio.to_thread(
                    save_message,
                    job.thread_id,
                    "assistant",
                    f"[Background Agent ({job_id})]: {final_summary}",
                )
            except Exception as dberr:
                logger.warning(f"[LiveDispatcher] Could not save subagent result to DB: {dberr}")

        # Proactively speak result to user via Gemini Live WebSocket if callback provided
        if notify_callback:
            try:
                await notify_callback(task, final_summary)
            except Exception as notif_err:
                logger.warning(f"[LiveDispatcher] Notification callback failed: {notif_err}")

        return final_summary


# Singleton instance
live_tool_dispatcher = RieLiveToolDispatcher()

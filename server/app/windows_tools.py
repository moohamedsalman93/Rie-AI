import os
import asyncio
import logging
import json
import subprocess
import threading
import sys
from typing import Literal, Optional, List
from textwrap import dedent
import pyautogui as pg
import pythoncom
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from app.integrations.windows_mcp.desktop.service import Desktop
from app.integrations.windows_mcp.desktop.views import Image
from app.integrations.windows_mcp.watch_cursor import WatchCursor
from langchain_core.runnables import RunnableConfig
from app.terminal_stream import streamer

logger = logging.getLogger(__name__)

# Initialize core components
desktop = Desktop()
watch_cursor = WatchCursor()
windows_version = desktop.get_windows_version()
default_language = desktop.get_default_language()
screen_width, screen_height = desktop.get_resolution()

# Start cursor watching in background (if needed)
try:
    watch_cursor.start()
except Exception as e:
    logger.error(f"Failed to start watch_cursor: {e}")

# --- Tool Input Schemas ---

class AppToolInput(BaseModel):
    mode: Literal['launch', 'resize', 'switch'] = Field(..., description="Mode of operation")
    name: Optional[str] = Field(None, description="Application name")
    window_loc: Optional[List[int]] = Field(None, description="Window location coordinates [x, y]")
    window_size: Optional[List[int]] = Field(None, description="Window size [width, height]")

class PowershellToolInput(BaseModel):
    command: str = Field(..., description="PowerShell command to execute")

class StateToolInput(BaseModel):
    use_vision: bool = Field(False, description="Include screenshot in state")
    use_dom: bool = Field(False, description="Extract browser DOM content")

class ClickToolInput(BaseModel):
    loc: List[int] = Field(..., description="Coordinates [x, y] to click")
    button: Literal['left', 'right', 'middle'] = Field('left', description="Mouse button")
    clicks: int = Field(1, description="Number of clicks")

class TypeToolInput(BaseModel):
    loc: List[int] = Field(..., description="Coordinates [x, y] to click before typing")
    text: str = Field(..., description="Text to type")
    clear: bool = Field(False, description="Clear existing text first")
    press_enter: bool = Field(False, description="Press enter after typing")

class ScrollToolInput(BaseModel):
    loc: Optional[List[int]] = Field(None, description="Coordinates to scroll at")
    type: Literal['horizontal', 'vertical'] = Field('vertical', description="Scroll type")
    direction: Literal['up', 'down', 'left', 'right'] = Field('down', description="Scroll direction")
    wheel_times: int = Field(1, description="Number of wheel rotations")

class DragToolInput(BaseModel):
    to_loc: List[int] = Field(..., description="Destination coordinates [x, y]")

class MoveToolInput(BaseModel):
    to_loc: List[int] = Field(..., description="Target coordinates [x, y]")

class ShortcutToolInput(BaseModel):
    shortcut: str = Field(..., description="Keyboard shortcut (e.g., 'ctrl+c')")

class WaitToolInput(BaseModel):
    duration: int = Field(..., description="Seconds to wait")

class ScrapeToolInput(BaseModel):
    url: str = Field(..., description="URL to scrape")
    use_dom: bool = Field(False, description="Extract content from active tab's DOM")

# --- Tool Implementation Functions ---

def app_tool(mode, name=None, window_loc=None, window_size=None):
    pythoncom.CoInitialize()
    try:
        return desktop.app(mode, name, window_loc, window_size)
    finally:
        pythoncom.CoUninitialize()

async def terminal_tool(command: str, config: RunnableConfig = None) -> str:
    # Check restrictions
    from app.config import settings
    
    thread_id = None
    if config and "configurable" in config:
        thread_id = config["configurable"].get("thread_id")

    restrictions = settings.TERMINAL_RESTRICTIONS
    if restrictions:
        restricted_keywords = [k.strip().lower() for k in restrictions.split(',') if k.strip()]
        
        command_lower = command.lower()
        for keyword in restricted_keywords:
            if keyword in command_lower:
                return json.dumps({
                    "status": "error",
                    "command": command,
                    "stdout": "",
                    "stderr": f"Error: Command blocked: contains restricted keyword or character '{keyword}'",
                    "returncode": 1
                })

    pythoncom.CoInitialize()
    try:
        # Instead of executing synchronously with desktop.execute_command
        # We spawn a child process to stream outputs.
        # We encode it like desktop.execute_command
        import base64
        encoded = base64.b64encode(command.encode("utf-16le")).decode("ascii")
        
        loop = asyncio.get_running_loop()
        
        creationflags = 0
        if sys.platform == "win32":
            creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)

        process = subprocess.Popen(
            ['powershell', '-NoProfile', '-EncodedCommand', encoded],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=os.path.expanduser('~'),
            creationflags=creationflags
        )
        
        stdout_lines = []
        stderr_lines = []

        def read_stream(stream, lines_list, is_stderr):
            while True:
                line_bytes = stream.readline()
                if not line_bytes:
                    break
                try:
                    line = line_bytes.decode('utf-8', errors='ignore')
                except:
                    line = str(line_bytes)
                
                lines_list.append(line)
                
                if thread_id:
                    # Stream the raw line to the frontend via SSE pub/sub
                    payload = {
                        "step": "terminal_chunk",
                        "data": line
                    }
                    asyncio.run_coroutine_threadsafe(
                        streamer.put_chunk(thread_id, json.dumps(payload)),
                        loop
                    )

        # Run stdout and stderr readers concurrently in threads
        t_out = threading.Thread(target=read_stream, args=(process.stdout, stdout_lines, False))
        t_err = threading.Thread(target=read_stream, args=(process.stderr, stderr_lines, True))
        
        t_out.start()
        t_err.start()
        
        def wait_for_process(*args, **kwargs):
            process.wait()
            t_out.join()
            t_err.join()

        await loop.run_in_executor(None, wait_for_process)
        returncode = process.returncode

        output_stdout = "".join(stdout_lines)
        output_stderr = "".join(stderr_lines)

        status = 'ok' if returncode == 0 else 'error'
        
        result = {
            "status": status,
            "command": command,
            "stdout": output_stdout,
            "stderr": output_stderr,
            "returncode": returncode
        }
        return json.dumps(result)
    finally:
        pythoncom.CoUninitialize()

def state_tool(use_vision: bool = False, use_dom: bool = False):
    pythoncom.CoInitialize()
    try:
        # Calculate scale factor to cap resolution at 1080p
        max_width, max_height = 1920, 1080
        scale_width = max_width / screen_width if screen_width > max_width else 1.0
        scale_height = max_height / screen_height if screen_height > max_height else 1.0
        scale = min(scale_width, scale_height)
        
        desktop_state = desktop.get_state(use_vision=use_vision, use_dom=use_dom, as_bytes=True, scale=scale)
        interactive_elements = desktop_state.tree_state.interactive_elements_to_string()
        scrollable_elements = desktop_state.tree_state.scrollable_elements_to_string()
        apps = desktop_state.apps_to_string()
        active_app = desktop_state.active_app_to_string()
        
        result_text = dedent(f'''
        Default Language of User:
        {default_language} with encoding: {desktop.encoding}
                                
        Focused App:
        {active_app}
    
        Opened Apps:
        {apps}
    
        List of Interactive Elements:
        {interactive_elements or 'No interactive elements found.'}
    
        List of Scrollable Elements:
        {scrollable_elements or 'No scrollable elements found.'}
        ''')
        
        if use_vision and desktop_state.screenshot:
            return f"{result_text}\n[Screenshot captured and available for vision analysis]"
        
        return result_text
    finally:
        pythoncom.CoUninitialize()

def click_tool(loc, button='left', clicks=1):
    pythoncom.CoInitialize()
    try:
        if len(loc) != 2: raise ValueError("loc must be [x, y]")
        desktop.click(loc=loc, button=button, clicks=clicks)
        return f"Clicked {button} {clicks} time(s) at {loc}"
    finally:
        pythoncom.CoUninitialize()

def type_tool(loc, text, clear=False, press_enter=False):
    pythoncom.CoInitialize()
    try:
        if len(loc) != 2: raise ValueError("loc must be [x, y]")
        desktop.type(loc=loc, text=text, clear='true' if clear else 'false', press_enter='true' if press_enter else 'false')
        return f"Typed '{text}' at {loc}"
    finally:
        pythoncom.CoUninitialize()

def scroll_tool(loc=None, type='vertical', direction='down', wheel_times=1):
    pythoncom.CoInitialize()
    try:
        response = desktop.scroll(loc, type, direction, wheel_times)
        if response: return response
        return f"Scrolled {type} {direction} by {wheel_times} units"
    finally:
        pythoncom.CoUninitialize()

def drag_tool(to_loc):
    pythoncom.CoInitialize()
    try:
        desktop.drag(to_loc)
        return f"Dragged to {to_loc}"
    finally:
        pythoncom.CoUninitialize()

def move_tool(to_loc):
    pythoncom.CoInitialize()
    try:
        desktop.move(to_loc)
        return f"Moved mouse to {to_loc}"
    finally:
        pythoncom.CoUninitialize()

def shortcut_tool(shortcut: str):
    pythoncom.CoInitialize()
    try:
        desktop.shortcut(shortcut)
        return f"Pressed shortcut {shortcut}"
    finally:
        pythoncom.CoUninitialize()

def wait_tool(duration: int):
    pg.sleep(duration)
    return f"Waited {duration} seconds"

def scrape_tool(url: str, use_dom: bool = False):
    pythoncom.CoInitialize()
    try:
        if not use_dom:
            content = desktop.scrape(url)
            return f'URL: {url}\nContent:\n{content}'
        
        desktop_state = desktop.get_state(use_vision=False, use_dom=use_dom)
        tree_state = desktop_state.tree_state
        if not tree_state.dom_info:
            return f'No DOM information found. Please open {url} in browser first.'
        
        content = '\n'.join([node.text for node in tree_state.dom_informative_nodes])
        return f'URL: {url}\nContent extracted from DOM:\n{content}'
    finally:
        pythoncom.CoUninitialize()

# --- Export Tools as LangChain StructuredTools ---

WINDOWS_TOOLS = {
    "app_control": StructuredTool.from_function(
        func=app_tool,
        name="app_control",
        description="Launch, resize, or switch Windows applications.",
        args_schema=AppToolInput,
    ),
    "run_terminal_command": StructuredTool.from_function(
        coroutine=terminal_tool,
        name="run_terminal_command",
        description=(
            "Execute a terminal command on the Windows system. "
            "Do not use this for user reminders or timed notifications — use schedule_chat_task instead so they appear in Rie's Scheduled panel."
        ),
        args_schema=PowershellToolInput,
    ),
    "get_desktop_state": StructuredTool.from_function(
        func=state_tool,
        name="get_desktop_state",
        description="Capture current desktop state, apps, and interactive elements.",
        args_schema=StateToolInput,
    ),
    "mouse_click": StructuredTool.from_function(
        func=click_tool,
        name="mouse_click",
        description="Perform a mouse click at specific coordinates.",
        args_schema=ClickToolInput,
    ),
    "keyboard_type": StructuredTool.from_function(
        func=type_tool,
        name="keyboard_type",
        description="Type text at specific coordinates.",
        args_schema=TypeToolInput,
    ),
    "scroll_mouse": StructuredTool.from_function(
        func=scroll_tool,
        name="scroll_mouse",
        description="Scroll vertically or horizontally.",
        args_schema=ScrollToolInput,
    ),
    "drag_mouse": StructuredTool.from_function(
        func=drag_tool,
        name="drag_mouse",
        description="Drag from current position to target coordinates.",
        args_schema=DragToolInput,
    ),
    "move_mouse": StructuredTool.from_function(
        func=move_tool,
        name="move_mouse",
        description="Move mouse cursor to specific coordinates.",
        args_schema=MoveToolInput,
    ),
    "press_keys": StructuredTool.from_function(
        func=shortcut_tool,
        name="press_keys",
        description="Press keyboard shortcuts or keys.",
        args_schema=ShortcutToolInput,
    ),
    "wait": StructuredTool.from_function(
        func=wait_tool,
        name="wait",
        description="Pause execution for a specified duration.",
        args_schema=WaitToolInput,
    ),
    "scrape_web": StructuredTool.from_function(
        func=scrape_tool,
        name="scrape_web",
        description="Scrape content from a URL or active browser tab.",
        args_schema=ScrapeToolInput,
    ),
}

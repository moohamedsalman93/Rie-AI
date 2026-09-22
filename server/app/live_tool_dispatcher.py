"""
First-Class Tool Dispatcher for Gemini Live Voice Sessions.
Exposes Rie's unified tool layer (Camoufox browser, Windows desktop automation,
PowerShell commands, media shortcuts, and web search) to Gemini Live function calling.
"""
import asyncio
import logging
from typing import Dict, Any, List

from app.browser.service import browser_service
from app.windows_tools import app_tool, shortcut_tool, state_tool
from app.tools import internet_search

logger = logging.getLogger("live_tool_dispatcher")

# Gemini Live Function Declarations
LIVE_TOOL_DECLARATIONS = [
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
        "name": "browser_navigate",
        "description": "Navigates the currently open browser session to a new URL.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "url": {
                    "type": "STRING",
                    "description": "Target webpage URL to visit."
                }
            },
            "required": ["url"]
        }
    },
    {
        "name": "browser_snapshot",
        "description": "Reads the current browser page title, URL, interactive buttons, inputs, links, and content summary.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "interactive_only": {
                    "type": "BOOLEAN",
                    "description": "Whether to focus primarily on interactive elements like links and buttons."
                }
            }
        }
    },
    {
        "name": "browser_click",
        "description": "Clicks an interactive element, button, link, or tab on the active webpage.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "target": {
                    "type": "STRING",
                    "description": "Reference ID (e.g. 'ref-3'), visible text, or selector of the element to click."
                }
            },
            "required": ["target"]
        }
    },
    {
        "name": "browser_type",
        "description": "Types text into an input field or search bar on the active webpage.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "target": {
                    "type": "STRING",
                    "description": "Reference ID (e.g. 'ref-5') or description of the text input field."
                },
                "text": {
                    "type": "STRING",
                    "description": "Text to type into the field."
                },
                "press_enter": {
                    "type": "BOOLEAN",
                    "description": "Whether to press Enter after typing to submit the form/search."
                }
            },
            "required": ["target", "text"]
        }
    },
    {
        "name": "browser_scroll",
        "description": "Scrolls the active webpage up or down.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "direction": {
                    "type": "STRING",
                    "description": "Scroll direction: 'down' or 'up'."
                }
            },
            "required": ["direction"]
        }
    },
    {
        "name": "browser_extract",
        "description": "Extracts text or specific content from the active webpage based on a question or query.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "What specific information to find or extract from the page."
                }
            },
            "required": ["query"]
        }
    },
    {
        "name": "browser_close",
        "description": (
            "Closes the active browser session. "
            "WARNING: Do NOT call this if the user is listening to music, watching a video, or asked to keep the page open."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {}
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
            "Examples: 'playpause' (media play/pause), 'volumeup' (volume up), 'volumedown' (volume down), "
            "'volumemute' (mute), 'ctrl+c', 'ctrl+v', 'alt+tab', 'space'."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "keys": {
                    "type": "STRING",
                    "description": "Key combo or media key name (e.g. 'playpause', 'volumeup', 'volumedown', 'ctrl+shift+esc')."
                }
            },
            "required": ["keys"]
        }
    },
    {
        "name": "internet_search",
        "description": (
            "Searches the web in real-time for up-to-date facts, current news, sports scores, weather, stock prices, or general information. "
            "Use this whenever the user asks a question about recent events or facts."
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

    def get_tool_declarations(self) -> List[Dict[str, Any]]:
        """Returns the function declarations list formatted for Gemini Live setup."""
        return LIVE_TOOL_DECLARATIONS

    async def dispatch(self, tool_name: str, args: Dict[str, Any]) -> str:
        """
        Executes the named tool with provided arguments and returns a concise, conversational result string.
        """
        logger.info(f"[LiveDispatcher] Dispatching tool='{tool_name}' with args={args}")
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

            else:
                logger.warning(f"[LiveDispatcher] Unrecognized tool: {tool_name}")
                return f"Error: Unknown tool '{tool_name}'."

        except Exception as e:
            logger.error(f"[LiveDispatcher] Error executing '{tool_name}': {e}", exc_info=True)
            return f"Error executing {tool_name}: {str(e)}"


# Singleton instance
live_tool_dispatcher = RieLiveToolDispatcher()

"""
LangGraph Browser Tools for Rie.
Exposes a minimal, clean set of 5 Phase 1 browser tools delegating to BrowserService.
Session handles remain hidden inside BrowserService.
"""
from typing import Optional, Dict, Any
from langchain_core.tools import tool

from app.browser.service import browser_service, BrowserSessionRequiredError
from app.browser.providers.base import (
    ProviderUnavailableError,
    ServerUnavailableError,
    StaleTargetError,
    TargetNotFoundError,
    NavigationTimeoutError,
)


@tool
async def browser_open(url: Optional[str] = None, profile: Optional[str] = None, headless: Optional[bool] = None) -> str:
    """Opens the stealth browser session using a persistent profile and optionally navigates to the specified URL.
    
    Args:
        url: Optional webpage URL to open (e.g. 'https://youtube.com').
        profile: Optional persistent browser profile identifier (e.g. 'work', 'personal', 'default').
        headless: Optional boolean. When Auto mode is enabled in settings, the LLM decides: pass True for hidden background tasks/scraping, or pass False for visible desktop GUI window (e.g. playing music/video, manual login, user interaction).
    """
    try:
        res = await browser_service.open_browser(url=url, profile=profile, headless=headless)
        prof_msg = f" Profile: '{profile}'" if profile else ""
        mode_msg = " (Headless)" if headless else " (Visible GUI)"
        return f"Browser opened successfully.{prof_msg}{mode_msg} {res.message or ''} URL: {res.url or url or 'about:blank'}"
    except ServerUnavailableError as e:
        return f"Error: Browser server is unavailable. {e}"
    except Exception as e:
        return f"Failed to open browser: {e}"


@tool
async def browser_snapshot(interactive_only: bool = True) -> str:
    """Captures an accessibility DOM snapshot of the active webpage, returning interactive elements and page content.
    
    Args:
        interactive_only: If True, focuses on interactive buttons, inputs, links, and forms.
    """
    try:
        snap = await browser_service.snapshot(interactive_only=interactive_only)
        elements_str = "\n".join(
            f" - [{el.ref}] {el.role}: '{el.name or ''}' (value: '{el.value or ''}')"
            for el in snap.elements[:30]
        )
        return (
            f"Page Title: {snap.title}\n"
            f"Page URL: {snap.url}\n"
            f"Interactive Elements:\n{elements_str or 'No interactive elements found.'}\n\n"
            f"Page Summary:\n{snap.text or 'N/A'}"
        )
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Snapshot error: {e}"


@tool
async def browser_click(target: str) -> str:
    """Clicks an element on the active webpage using its reference ID, text, or selector.
    
    Args:
        target: Element reference ID (e.g., 'ref-0'), visible text label, or selector to click.
    """
    try:
        res = await browser_service.click(target=target)
        if res.success:
            return f"Clicked '{target}' successfully. {res.message or ''}"
        return f"Click on '{target}' failed: {res.message}"
    except StaleTargetError as e:
        return f"Stale Element Error: {e}"
    except TargetNotFoundError as e:
        return f"Target Not Found: {e}"
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Click error: {e}"


@tool
async def browser_type(target: str, text: str) -> str:
    """Types text into an input field or text area on the active webpage.
    
    Args:
        target: Element reference ID (e.g., 'ref-1'), input label, or selector.
        text: Text string to type into the targeted input element.
    """
    try:
        res = await browser_service.type_text(target=target, text=text)
        if res.success:
            return f"Typed '{text}' into '{target}' successfully."
        return f"Typing into '{target}' failed: {res.message}"
    except StaleTargetError as e:
        return f"Stale Element Error: {e}"
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Type error: {e}"


@tool
async def browser_navigate(url: str) -> str:
    """Navigates the current browser tab to a new URL.
    
    Args:
        url: Webpage URL to navigate to (e.g. 'https://github.com').
    """
    try:
        res = await browser_service.navigate(url=url)
        if res.success:
            return f"Navigated successfully to {res.url or url}."
        return f"Navigation failed: {res.message}"
    except NavigationTimeoutError as e:
        return f"Navigation Timeout: {e}"
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Navigation error: {e}"


@tool
async def browser_scroll(direction: str = "down", amount: int = 500) -> str:
    """Scrolls the active webpage up, down, top, or bottom.
    
    Args:
        direction: Scroll direction ('down', 'up', 'top', 'bottom').
        amount: Scroll pixel distance (default 500px).
    """
    try:
        res = await browser_service.scroll(direction=direction, amount=amount)
        if res.success:
            return f"Scrolled {direction} by {amount}px."
        return f"Scroll failed: {res.message}"
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Scroll error: {e}"


@tool
async def browser_tabs(action: str, tab_id: Optional[str] = None) -> str:
    """Manages browser tabs (list, switch, new, close).
    
    Args:
        action: Tab management action ('list', 'new', 'switch', 'close').
        tab_id: Optional tab ID when switching or closing tabs.
    """
    try:
        res = await browser_service.tabs(action=action, tab_id=tab_id)
        return res.message or f"Tab action '{action}' completed."
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Tab action error: {e}"


@tool
async def browser_extract(query: Optional[str] = None) -> str:
    """Extracts clean readability text, markdown summary, or structured data from the active webpage.
    
    Args:
        query: Optional extraction query or focus topic.
    """
    try:
        ext = await browser_service.extract(query=query)
        return (
            f"Extracted Page Content for {ext.url or 'current tab'} "
            f"({ext.title or 'No title'}):\n\n"
            f"{ext.content}"
        )
    except BrowserSessionRequiredError as e:
        return f"Error: {e}"
    except ServerUnavailableError as e:
        return f"Error: Browser server unavailable. {e}"
    except Exception as e:
        return f"Extraction error: {e}"


@tool
async def browser_job_extract_form() -> str:
    """Extracts all form fields, labels, input types, and current values on the active page in a single pass.
    Use this tool for Job Mode form extraction before bulk injecting application details.
    """
    try:
        res = await browser_service.extract_form_fields()
        if not res.get("success"):
            return f"Form extraction failed: {res.get('error')}"
        
        fields_str = ""
        for f in res.get("fields", []):
            req = " (REQUIRED)" if f.get("required") else ""
            val = f": '{f.get('value')}'" if f.get('value') else ""
            opts = f" [options: {', '.join(f.get('options'))}]" if f.get("options") else ""
            fields_str += f"- [{f.get('type')}] '{f.get('label')}' (name: '{f.get('name')}', id: '{f.get('id')}') {req}{val}{opts}\n"
        
        return (
            f"Extracted {res.get('field_count')} Form Fields for {res.get('url')}:\n\n"
            f"{fields_str or 'No form fields found on active page.'}"
        )
    except Exception as e:
        return f"Form extraction error: {e}"


@tool
async def browser_job_bulk_autofill(field_data: dict) -> str:
    """Bulk injects applicant details into all matching form fields via DOM in a single pass, then re-verifies for missing required fields.
    
    Args:
        field_data: Key-value dictionary of form values to inject (e.g. {"first_name": "John", "email": "john@example.com", "phone": "+1234567890", "work_authorization": "Yes"}).
    """
    try:
        res = await browser_service.bulk_autofill_form(field_data)
        if not res.get("success"):
            return f"Bulk autofill failed: {res.get('error')}"
        
        injected = res.get("injected_fields", [])
        missing = res.get("missing_required_fields", [])
        
        inj_str = "\n".join([f"- Injected '{f.get('label')}': {f.get('value')}" for f in injected])
        miss_str = "\n".join([f"- Missing '{f.get('label')}' ({f.get('type')})" for f in missing])
        
        return (
            f"Bulk Form Injection Complete for {res.get('url')}:\n"
            f"Injected Count: {res.get('injected_count')}\n\n"
            f"Successfully Injected:\n{inj_str or 'None'}\n\n"
            f"Re-verification - Unfilled Required Fields:\n{miss_str or 'None! All required fields are populated.'}"
        )
    except Exception as e:
        return f"Bulk autofill error: {e}"


@tool
async def browser_upload_file(target: str, file_path: str) -> str:
    """Injects/uploads a file (e.g. PDF resume, cover letter, image, photo, or document) into a file input element on the active webpage.
    
    Args:
        target: Element reference ID (e.g., 'ref-2'), file input label, or selector.
        file_path: Absolute local path to the PDF, image, or file to upload (e.g. 'C:/path/to/resume.pdf').
    """
    try:
        res = await browser_service.upload_file(target=target, file_path=file_path)
        if res.success:
            return f"Uploaded file '{file_path}' into '{target}' successfully."
        return f"File upload into '{target}' failed: {res.message}"
    except Exception as e:
        return f"Upload file error: {e}"


@tool
async def browser_close() -> str:
    """Closes the active browser session.
    
    IMPORTANT: DO NOT call this tool if the user asked to play music, watch a video, or keep the browser window open.
    Leave the browser running on the desktop so audio/video playback is not interrupted.
    """
    try:
        res = await browser_service.close_browser()
        return res.message or "Browser closed."
    except Exception as e:
        return f"Error closing browser: {e}"


LANGGRAPH_BROWSER_TOOLS = [
    browser_open,
    browser_navigate,
    browser_snapshot,
    browser_click,
    browser_type,
    browser_scroll,
    browser_tabs,
    browser_extract,
    browser_job_extract_form,
    browser_job_bulk_autofill,
    browser_upload_file,
    browser_close,
]

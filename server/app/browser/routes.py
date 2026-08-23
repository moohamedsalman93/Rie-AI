"""
FastAPI REST Routes for Rie's Browser Subsystem.
Exposes status observability and profile management for frontend Settings UI.
"""
import logging
from typing import List, Optional, Literal, Union, Dict, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.browser.runtime_manager import runtime_manager
from app.browser.profile_manager import profile_manager
from app.browser.models import BrowserProfile

from app.config import Settings
settings = Settings()

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/browser", tags=["browser"])


class BrowserBinaryInfo(BaseModel):
    """Browser binary availability info."""
    available: bool = False
    version: Optional[str] = None
    path: Optional[str] = None
    error: Optional[str] = None


class BrowserRuntimeStatus(BaseModel):
    """Normalized runtime observability status for frontend UI."""
    provider: str = Field("camofox", description="Browser provider backend")
    mode: str = Field("embedded", description="Runtime mode (embedded or remote)")
    state: str = Field(..., description="Normalized lifecycle state")
    camoufox_version: Optional[str] = Field(None, description="Camoufox package version")
    headless_mode: str = Field("auto", description="Configured headless mode (headless, normal, auto)")
    browser_binary: Optional[BrowserBinaryInfo] = Field(None, description="Browser binary status")
    is_fetching: bool = Field(False, description="Whether binary is currently downloading")
    fetch_error: Optional[str] = Field(None, description="Error from fetching binary")
    error: Optional[str] = Field(None, description="Error details if unhealthy")


class CreateProfileRequest(BaseModel):
    """Payload for registering a new browser profile."""
    id: str = Field(..., description="Unique profile identifier, e.g. 'work'")
    name: Optional[str] = Field(None, description="Human-readable display name")


@router.get("/status", response_model=BrowserRuntimeStatus)
async def get_browser_status() -> BrowserRuntimeStatus:
    """Get current browser runtime status and health metrics."""
    try:
        settings.reload()
        status = await runtime_manager.get_status()
        binary = status.get("browser_binary", {}) or {}

        binary_info = BrowserBinaryInfo(
            available=binary.get("available", False),
            version=binary.get("version"),
            path=binary.get("path"),
            error=binary.get("error"),
        ) if binary else None

        return BrowserRuntimeStatus(
            provider=status.get("provider", "camofox"),
            mode=status.get("mode", "embedded"),
            state=status.get("state", "stopped"),
            camoufox_version=status.get("camoufox_version"),
            headless_mode=settings.CAMOFOX_HEADLESS_MODE,
            browser_binary=binary_info,
            is_fetching=status.get("is_fetching", False),
            fetch_error=status.get("fetch_error"),
            error=status.get("error"),
        )
    except Exception as e:
        logger.exception("Failed to get browser status")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/runtime/initialize", response_model=BrowserRuntimeStatus)
async def initialize_browser_runtime() -> BrowserRuntimeStatus:
    """Initialize the embedded Camoufox runtime."""
    success = await runtime_manager.ensure_running()
    if not success:
        raise HTTPException(
            status_code=500,
            detail=runtime_manager._last_error or "Failed to initialize Camoufox runtime."
        )
    return await get_browser_status()


@router.post("/runtime/fetch")
async def fetch_browser_binary():
    """Trigger on-demand fetch/download of the Camoufox browser binary."""
    res = await runtime_manager.fetch_binary()
    if res.get("status") == "error":
        raise HTTPException(status_code=500, detail=res.get("error", "Failed to fetch browser binary."))
    return res


@router.delete("/runtime/binary")
async def delete_browser_binary():
    """Delete/uninstall the downloaded Camoufox browser binary."""
    res = await runtime_manager.delete_browser_binary()
    if res.get("status") == "error":
        raise HTTPException(status_code=500, detail=res.get("message", "Failed to delete browser binary."))
    return res



@router.get("/profiles", response_model=List[BrowserProfile])
async def list_browser_profiles() -> List[BrowserProfile]:
    """List all registered browser user profiles."""
    return profile_manager.list_profiles()


@router.post("/profiles", response_model=BrowserProfile)
async def create_browser_profile(req: CreateProfileRequest) -> BrowserProfile:
    """Create a new persistent browser profile."""
    try:
        return profile_manager.create_profile(profile_id=req.id, name=req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/profiles/{profile_id}")
async def delete_browser_profile(profile_id: str):
    """Delete a persistent browser profile."""
    try:
        success = profile_manager.delete_profile(profile_id)
        if not success:
            raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found.")
        return {"success": True, "message": f"Profile '{profile_id}' deleted."}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Failed deleting profile '{profile_id}'")
        raise HTTPException(status_code=500, detail=str(e))


from app.browser.cookie_importer import cookie_importer


class CookieImportLocalRequest(BaseModel):
    source_browser: str = Field(..., description="Browser ID: chrome, edge, brave, firefox, opera, etc.")
    domain_filter: Optional[str] = Field(None, description="Optional domain filter e.g. 'google.com' or 'github.com'")
    profile: Optional[str] = Field(None, description="Target Camoufox profile ID")


class CookieImportJsonRequest(BaseModel):
    cookies: Union[str, List[Dict[str, Any]], Dict[str, Any]] = Field(..., description="JSON string or array of cookies")
    profile: Optional[str] = Field(None, description="Target Camoufox profile ID")


@router.get("/cookies/sources")
async def get_cookie_sources():
    """List available local browsers for cookie extraction."""
    return {"sources": cookie_importer.list_supported_browsers()}


@router.post("/cookies/import_local")
async def import_local_cookies(req: CookieImportLocalRequest):
    """Extract cookies from local browser and inject into active session."""
    domains = [req.domain_filter.strip()] if req.domain_filter and req.domain_filter.strip() else None
    res = cookie_importer.extract_from_local_browser(req.source_browser, domains=domains)
    if not res["success"]:
        return {"success": False, "message": res["error"] or "Failed extracting cookies", "count": 0}
    
    cookies = res["cookies"]
    if not cookies:
        return {"success": False, "message": f"No matching cookies found in {req.source_browser}.", "count": 0}
    
    injected_count = len(cookies)
    if browser_service.has_active_session():
        action_res = await browser_service.inject_cookies(cookies)
        if not action_res.success:
            return {"success": False, "message": action_res.message, "count": 0}

    return {
        "success": True,
        "message": f"Successfully extracted and imported {injected_count} cookies from {req.source_browser}.",
        "count": injected_count,
    }


@router.post("/cookies/import_json")
async def import_json_cookies(req: CookieImportJsonRequest):
    """Import and inject custom JSON cookie arrays into active session."""
    try:
        cookies = cookie_importer.parse_cookie_json(req.cookies)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    
    if not cookies:
        return {"success": False, "message": "No valid cookies found in JSON payload.", "count": 0}

    if browser_service.has_active_session():
        action_res = await browser_service.inject_cookies(cookies)
        if not action_res.success:
            return {"success": False, "message": action_res.message, "count": 0}

    return {
        "success": True,
        "message": f"Successfully injected {len(cookies)} cookies into active session.",
        "count": len(cookies),
    }


@router.get("/cookies")
async def get_active_session_cookies():
    """Retrieve cookies currently loaded in active browser session."""
    cookies = await browser_service.get_cookies()
    domains = list({c.get("domain", "") for c in cookies if c.get("domain")})
    return {
        "count": len(cookies),
        "domains": sorted(domains),
    }


import base64
import asyncio
from fastapi import WebSocket, WebSocketDisconnect
from app.browser.service import browser_service


class BrowserActionPayload(BaseModel):
    action: str = Field(..., description="Action type: open, navigate, click, type, scroll, close, resize_viewport")
    url: Optional[str] = None
    x: Optional[int] = None
    y: Optional[int] = None
    text: Optional[str] = None
    delta_x: Optional[int] = 0
    delta_y: Optional[int] = 0
    headless: Optional[bool] = None
    width: Optional[int] = None
    height: Optional[int] = None


@router.get("/active_session")
async def get_active_session_info():
    """Get active session details for live UI workspace."""
    has_session = browser_service.has_active_session()
    ctx = browser_service.context if has_session else None
    return {
        "active": has_session,
        "state": browser_service.state.value if hasattr(browser_service.state, 'value') else str(browser_service.state),
        "url": ctx.current_url if ctx else None,
        "title": ctx.current_title if ctx else None,
        "interaction_mode": ctx.interaction_mode.value if ctx and hasattr(ctx.interaction_mode, 'value') else "desktop",
    }


@router.post("/action")
async def perform_browser_action(payload: BrowserActionPayload):
    """Perform a direct user action on the browser session."""
    act = payload.action.lower()
    try:
        if act == "open":
            is_headless = getattr(payload, "headless", None)
            if is_headless is None:
                is_headless = True
            res = await browser_service.open_browser(url=payload.url or "https://google.com", headless=is_headless)
            return {"success": res.success, "message": res.message, "url": res.url}
        elif act == "navigate":
            res = await browser_service.navigate(url=payload.url or "https://google.com")
            return {"success": res.success, "message": res.message, "url": res.url}
        elif act == "click":
            res = await browser_service.click_at_coords(x=payload.x or 0, y=payload.y or 0)
            return {"success": res.success, "message": res.message, "url": res.url}
        elif act == "type":
            res = await browser_service.send_keyboard_input(text=payload.text or "")
            return {"success": res.success, "message": res.message}
        elif act == "scroll":
            res = await browser_service.scroll_page(delta_x=payload.delta_x or 0, delta_y=payload.delta_y or 0)
            return {"success": res.success, "message": res.message}
        elif act == "resize_viewport":
            res = await browser_service.resize_viewport(width=payload.width or 1280, height=payload.height or 720)
            return {"success": res.success, "message": res.message}
        elif act == "back":
            res = await browser_service.go_back()
            return {"success": res.success, "message": res.message, "url": res.url}
        elif act == "forward":
            res = await browser_service.go_forward()
            return {"success": res.success, "message": res.message, "url": res.url}
        elif act == "close":
            res = await browser_service.close_browser()
            return {"success": res.success, "message": res.message}
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {act}")
    except Exception as e:
        logger.error(f"Browser action '{act}' failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.websocket("/stream")
async def browser_stream_websocket(websocket: WebSocket):
    """WebSocket endpoint to stream live Camoufox screenshots with high FPS and event-driven responsiveness."""
    await websocket.accept()
    logger.info("WebSocket browser stream client connected.")
    
    immediate_frame_trigger = asyncio.Event()

    async def frame_sender():
        last_url = None
        last_title = None
        last_active = None
        try:
            while True:
                has_session = browser_service.has_active_session()
                if has_session:
                    try:
                        ctx = browser_service.context
                        current_url = ctx.current_url if ctx else None
                        current_title = ctx.current_title if ctx else None
                        
                        # Send metadata packet if URL, title, or active status changed
                        if current_url != last_url or current_title != last_title or last_active is not True:
                            last_url = current_url
                            last_title = current_title
                            last_active = True
                            await websocket.send_json({
                                "type": "metadata",
                                "active": True,
                                "url": current_url,
                                "title": current_title,
                            })

                        # Capture and stream raw binary JPEG directly (0% Base64 overhead, GPU hardware decodable)
                        screenshot_bytes = await browser_service.screenshot(
                            full_page=False,
                            format="jpeg",
                            quality=88,
                        )
                        if screenshot_bytes:
                            await websocket.send_bytes(screenshot_bytes)
                        else:
                            if last_active is not False:
                                last_active = False
                                await websocket.send_json({"type": "status", "active": False})
                    except Exception:
                        if last_active is not False:
                            last_active = False
                            await websocket.send_json({"type": "status", "active": False})
                else:
                    if last_active is not False:
                        last_active = False
                        await websocket.send_json({"type": "status", "active": False})
                
                # Adaptive frame delay: ~15 FPS (0.065s) when active, 0.4s when idle, instant wake on user interaction
                frame_delay = 0.065 if browser_service.has_active_session() else 0.4
                try:
                    await asyncio.wait_for(immediate_frame_trigger.wait(), timeout=frame_delay)
                    immediate_frame_trigger.clear()
                except asyncio.TimeoutError:
                    pass
        except Exception as e:
            logger.debug(f"WebSocket frame_sender exited: {e}")

    sender_task = asyncio.create_task(frame_sender())

    try:
        while True:
            data = await websocket.receive_json()
            act = data.get("action")
            if act == "click" and "x" in data and "y" in data:
                await browser_service.click_at_coords(int(data["x"]), int(data["y"]))
                immediate_frame_trigger.set()
            elif act == "type" and "text" in data:
                await browser_service.send_keyboard_input(str(data["text"]))
                immediate_frame_trigger.set()
            elif act == "scroll":
                await browser_service.scroll_page(int(data.get("deltaX", 0)), int(data.get("deltaY", 0)))
                immediate_frame_trigger.set()
            elif act == "navigate" and "url" in data:
                await browser_service.navigate(str(data["url"]))
                immediate_frame_trigger.set()
            elif act == "resize_viewport" and "width" in data and "height" in data:
                await browser_service.resize_viewport(int(data["width"]), int(data["height"]))
                immediate_frame_trigger.set()
            elif act == "back":
                await browser_service.go_back()
                immediate_frame_trigger.set()
            elif act == "forward":
                await browser_service.go_forward()
                immediate_frame_trigger.set()
            elif act == "close":
                await browser_service.close_browser()
                immediate_frame_trigger.set()
    except WebSocketDisconnect:
        logger.info("WebSocket browser stream client disconnected.")
    except Exception as e:
        logger.warning(f"WebSocket browser stream error: {e}")
    finally:
        sender_task.cancel()


"""
FastAPI REST Routes for Rie's Browser Subsystem.
Exposes status observability and profile management for frontend Settings UI.
"""
import logging
from typing import List, Optional, Literal
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
    """WebSocket endpoint to stream live Camoufox screenshots and accept interaction events."""
    await websocket.accept()
    logger.info("WebSocket browser stream client connected.")
    
    async def frame_sender():
        try:
            while True:
                if browser_service.has_active_session():
                    try:
                        screenshot_bytes = await browser_service.screenshot(full_page=False)
                        if screenshot_bytes:
                            b64_img = base64.b64encode(screenshot_bytes).decode('utf-8')
                            ctx = browser_service.context
                            await websocket.send_json({
                                "type": "frame",
                                "active": True,
                                "image": f"data:image/jpeg;base64,{b64_img}",
                                "url": ctx.current_url,
                                "title": ctx.current_title,
                            })
                        else:
                            await websocket.send_json({"type": "status", "active": False})
                    except Exception:
                        await websocket.send_json({"type": "status", "active": False})
                else:
                    await websocket.send_json({"type": "status", "active": False})
                
                await asyncio.sleep(0.3)
        except Exception as e:
            logger.debug(f"WebSocket frame_sender exited: {e}")

    sender_task = asyncio.create_task(frame_sender())

    try:
        while True:
            data = await websocket.receive_json()
            act = data.get("action")
            if act == "click" and "x" in data and "y" in data:
                await browser_service.click_at_coords(int(data["x"]), int(data["y"]))
            elif act == "type" and "text" in data:
                await browser_service.send_keyboard_input(str(data["text"]))
            elif act == "scroll":
                await browser_service.scroll_page(int(data.get("deltaX", 0)), int(data.get("deltaY", 0)))
            elif act == "navigate" and "url" in data:
                await browser_service.navigate(str(data["url"]))
            elif act == "resize_viewport" and "width" in data and "height" in data:
                await browser_service.resize_viewport(int(data["width"]), int(data["height"]))
            elif act == "close":
                await browser_service.close_browser()
    except WebSocketDisconnect:
        logger.info("WebSocket browser stream client disconnected.")
    except Exception as e:
        logger.warning(f"WebSocket browser stream error: {e}")
    finally:
        sender_task.cancel()


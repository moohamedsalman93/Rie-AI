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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/browser", tags=["browser"])


class BrowserBinaryInfo(BaseModel):
    """Browser binary availability info."""
    available: bool = False
    version: Optional[str] = None
    path: Optional[str] = None


class BrowserRuntimeStatus(BaseModel):
    """Normalized runtime observability status for frontend UI."""
    provider: str = Field("camofox", description="Browser provider backend")
    mode: str = Field("embedded", description="Runtime mode (embedded or remote)")
    state: str = Field(..., description="Normalized lifecycle state")
    camoufox_version: Optional[str] = Field(None, description="Camoufox package version")
    browser_binary: Optional[BrowserBinaryInfo] = Field(None, description="Browser binary status")
    error: Optional[str] = Field(None, description="Error details if unhealthy")


class CreateProfileRequest(BaseModel):
    """Payload for registering a new browser profile."""
    id: str = Field(..., description="Unique profile identifier, e.g. 'work'")
    name: Optional[str] = Field(None, description="Human-readable display name")


@router.get("/status", response_model=BrowserRuntimeStatus)
async def get_browser_status() -> BrowserRuntimeStatus:
    """Get current browser runtime status and health metrics."""
    status = await runtime_manager.get_status()
    binary = status.get("browser_binary", {})

    return BrowserRuntimeStatus(
        provider=status.get("provider", "camofox"),
        mode=status.get("mode", "embedded"),
        state=status.get("state", "stopped"),
        camoufox_version=status.get("camoufox_version"),
        browser_binary=BrowserBinaryInfo(**binary) if binary else None,
        error=status.get("error"),
    )


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

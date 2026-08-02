"""
Normalized data models for Rie's Browser Subsystem.
All provider-specific data structures are mapped into these standard Pydantic models.
"""
from enum import Enum
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class InteractionMode(str, Enum):
    """Active interaction mode for tool routing and gating."""
    BROWSER = "browser"
    DESKTOP = "desktop"


class BrowserSessionState(str, Enum):
    """Session lifecycle state machine."""
    CLOSED = "closed"
    ACTIVE = "active"


class RuntimeState(str, Enum):
    """Normalized runtime server process lifecycle states."""
    STOPPED = "stopped"
    STARTING = "starting"
    READY = "ready"
    UNHEALTHY = "unhealthy"
    STOPPING = "stopping"
    ERROR = "error"


class OperationCategory(str, Enum):
    """Operation categorization for retry policies and safety guarantees."""
    READ_ONLY = "read_only"      # Safe, idempotent (snapshot, extract, status, list_tabs)
    NAVIGATION = "navigation"    # Page navigation with explicit semantics (open, navigate)
    MUTATING = "mutating"        # State-altering (click, type_text, close_tab) - NEVER auto-replay


class BrowserElement(BaseModel):
    """Normalized representation of an interactive browser element."""
    ref: str = Field(..., description="Element selector, ARIA ID, or element index")
    role: str = Field("element", description="ARIA role or HTML tag name")
    name: Optional[str] = Field(None, description="Accessible name or visible text label")
    value: Optional[str] = Field(None, description="Input field value or checked state")
    disabled: bool = Field(False, description="Whether element is disabled")


class Snapshot(BaseModel):
    """Normalized accessibility snapshot of the current page."""
    snapshot_id: str = Field(..., description="Unique snapshot generation identifier")
    url: str = Field("", description="Current page URL")
    title: str = Field("", description="Current page title")
    elements: List[BrowserElement] = Field(default_factory=list, description="Interactive elements")
    text: Optional[str] = Field(None, description="Clean text summary of the page")
    raw_tree: Optional[Dict[str, Any]] = Field(None, description="Raw tree if needed")


class ActionResult(BaseModel):
    """Normalized result of a browser interaction action."""
    success: bool = Field(True, description="Whether the action succeeded")
    url: Optional[str] = Field(None, description="Page URL after action")
    title: Optional[str] = Field(None, description="Page title after action")
    navigation_occurred: bool = Field(False, description="Whether a page navigation/redirect occurred")
    dom_changed: bool = Field(False, description="Whether page DOM state changed")
    previous_tab_id: Optional[str] = Field(None, description="Tab ID before action")
    active_tab_id: Optional[str] = Field(None, description="Active tab ID after action")
    new_tab_opened: bool = Field(False, description="Whether a new tab was opened")
    message: Optional[str] = Field(None, description="Human-readable result message or error")


class ExtractResult(BaseModel):
    """Normalized output of a webpage content extraction action."""
    url: str = Field(..., description="URL from which content was extracted")
    title: Optional[str] = Field(None, description="Page title")
    content: str = Field(..., description="Extracted readability text or markdown body")


class BrowserContext(BaseModel):
    """Internal runtime context tracking active session, tab, URL, and interaction mode."""
    session_id: str
    active_tab_id: Optional[str] = None
    current_url: Optional[str] = None
    current_title: Optional[str] = None
    snapshot_id: Optional[str] = None
    dom_generation: int = Field(0, description="Current DOM generation counter")
    interaction_mode: InteractionMode = InteractionMode.DESKTOP
    state: BrowserSessionState = BrowserSessionState.CLOSED


class BrowserProfile(BaseModel):
    """Metadata representing a persistent browser identity."""
    id: str = Field(..., description="Unique profile identifier, e.g. 'work' or 'personal'")
    name: str = Field(..., description="Human-readable display name")
    provider: str = Field("camofox", description="Associated browser provider backend")
    created_at: str = Field(..., description="ISO 8601 creation timestamp")
    last_used_at: Optional[str] = Field(None, description="ISO 8601 last usage timestamp")


class BrowserSession(BaseModel):
    """Representation of an active browser session."""
    session_id: str
    provider_name: str = "camofox"
    profile: Optional[str] = None
    created_at: str
    active_url: Optional[str] = None
    active_tab_id: Optional[str] = None

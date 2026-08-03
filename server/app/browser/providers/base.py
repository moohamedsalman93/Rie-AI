"""
Abstract BrowserProvider interface.
All browser runtime backends (CamoFox, Playwright, CDP) implement this contract.
"""
from abc import ABC, abstractmethod
from typing import Optional
from app.browser.models import BrowserSession, Snapshot, ActionResult, ExtractResult


class BrowserError(Exception):
    """Base exception for all browser errors."""
    pass


class ProviderUnavailableError(BrowserError):
    """Raised when browser server runtime is unreachable."""
    pass


class ServerUnavailableError(ProviderUnavailableError):
    """Alias for backwards compatibility."""
    pass


class NavigationTimeoutError(BrowserError):
    """Raised when page navigation times out or DOM ready state fails."""
    pass


class TargetNotFoundError(BrowserError):
    """Raised when element target is not found in DOM."""
    pass


class StaleTargetError(BrowserError):
    """Raised when an action targets an element from an outdated snapshot generation."""
    pass


class SessionLostError(BrowserError):
    """Raised when active browser session terminates unexpectedly."""
    pass


class UnsupportedCamoFoxVersion(BrowserError):
    """Raised when the detected CamoFox server version is not supported."""
    pass


class BrowserProvider(ABC):
    """Abstract interface defining required operations for browser backends."""

    @abstractmethod
    async def check_health(self) -> bool:
        """Check if browser server runtime is healthy and reachable."""
        pass

    @abstractmethod
    async def create_session(self, profile: Optional[str] = None, headless: Optional[bool] = None) -> BrowserSession:
        """Create a new browser session."""
        pass

    @abstractmethod
    async def navigate(self, session_id: str, url: str) -> ActionResult:
        """Navigate active session tab to target URL."""
        pass

    @abstractmethod
    async def snapshot(self, session_id: str, interactive_only: bool = True) -> Snapshot:
        """Get normalized accessibility tree snapshot."""
        pass

    @abstractmethod
    async def click(self, session_id: str, target: str) -> ActionResult:
        """Click element by reference ID, selector, or text."""
        pass

    @abstractmethod
    async def type_text(self, session_id: str, target: str, text: str, clear_first: bool = True) -> ActionResult:
        """Type text into targeted input element."""
        pass

    @abstractmethod
    async def scroll(self, session_id: str, direction: str = "down", amount: int = 500) -> ActionResult:
        """Scroll active tab or targeted container."""
        pass

    @abstractmethod
    async def manage_tabs(self, session_id: str, action: str, tab_id: Optional[str] = None) -> ActionResult:
        """List, switch, create, or close browser tabs."""
        pass

    @abstractmethod
    async def extract_content(self, session_id: str, query: Optional[str] = None, tab_id: Optional[str] = None) -> ExtractResult:
        """Extract clean readability markdown or structured content."""
        pass

    @abstractmethod
    async def capture_screenshot(self, session_id: str, full_page: bool = False) -> bytes:
        """Capture visual page screenshot."""
        pass

    @abstractmethod
    async def extract_form_fields(self, session_id: str) -> dict:
        """Extract all form fields, labels, types, and current values."""
        pass

    @abstractmethod
    async def bulk_autofill_form(self, session_id: str, field_data: dict) -> dict:
        """Bulk inject form field values into DOM in a single pass."""
        pass

    @abstractmethod
    async def upload_file(self, session_id: str, target: str, file_path: str) -> ActionResult:
        """Upload/inject a file into a targeted file input element."""
        pass

    @abstractmethod
    async def close_session(self, session_id: str) -> bool:
        """Close browser session."""
        pass

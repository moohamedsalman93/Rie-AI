"""
BrowserService facade for Rie.
Enforces deterministic session state machine (CLOSED <-> ACTIVE), encapsulates session handles from LLM,
manages InteractionMode state, and delegates browser actions to the active BrowserProvider.
"""
import asyncio
import logging
from typing import Optional

from app.browser.models import (
    BrowserSession,
    BrowserSessionState,
    InteractionMode,
    Snapshot,
    ActionResult,
    ExtractResult,
    BrowserContext,
)
from app.browser.providers.base import (
    BrowserProvider,
    ServerUnavailableError,
    ProviderUnavailableError,
    StaleTargetError,
    TargetNotFoundError,
    SessionLostError,
)
from app.browser.providers.camofox import CamoFoxProvider
from app.browser.runtime_manager import runtime_manager

logger = logging.getLogger(__name__)


class BrowserSessionRequiredError(Exception):
    """Raised when a browser action tool is invoked without an active browser session."""
    pass


class BrowserService:
    """Singleton facade managing active browser session lifecycle and interaction mode."""

    def __init__(self, provider: Optional[BrowserProvider] = None):
        self.provider: BrowserProvider = provider or CamoFoxProvider()
        self._session: Optional[BrowserSession] = None
        self._state: BrowserSessionState = BrowserSessionState.CLOSED
        self._interaction_mode: InteractionMode = InteractionMode.DESKTOP
        self._active_tab_id: Optional[str] = None
        self._current_url: Optional[str] = None
        self._current_title: Optional[str] = None
        self._active_snapshot_id: Optional[str] = None
        self._dom_generation: int = 0
        self._last_snapshot_generation: int = 0
        self._valid_refs: set[str] = set()
        self._lock: asyncio.Lock = asyncio.Lock()

    @property
    def state(self) -> BrowserSessionState:
        return self._state

    @property
    def interaction_mode(self) -> InteractionMode:
        return self._interaction_mode

    @property
    def context(self) -> BrowserContext:
        """Returns the current BrowserContext."""
        session_id = self._session.session_id if self._session else ""
        return BrowserContext(
            session_id=session_id,
            active_tab_id=self._active_tab_id,
            current_url=self._current_url,
            current_title=self._current_title,
            snapshot_id=self._active_snapshot_id,
            dom_generation=self._dom_generation,
            interaction_mode=self._interaction_mode,
            state=self._state,
        )

    def set_interaction_mode(self, mode: InteractionMode) -> None:
        """Switch active interaction mode between BROWSER and DESKTOP."""
        self._interaction_mode = mode
        logger.info(f"InteractionMode set to: {mode.value}")

    def has_active_session(self) -> bool:
        """Return True if browser session is ACTIVE."""
        return self._state == BrowserSessionState.ACTIVE and self._session is not None

    def _invalidate_dom(self) -> None:
        """Bump DOM generation and clear valid element references after any mutating action."""
        self._dom_generation += 1
        self._valid_refs.clear()
        self._active_snapshot_id = None

    def _handle_process_crash(self, exc: Exception) -> None:
        """Safely handle browser runtime process crashes without replaying mutating actions."""
        logger.error(f"Browser runtime failure detected: {exc}")
        self._session = None
        self._state = BrowserSessionState.CLOSED
        self._interaction_mode = InteractionMode.DESKTOP
        self._current_url = None
        self._current_title = None
        self._active_tab_id = None
        self._invalidate_dom()
        raise SessionLostError(
            f"Browser server runtime process lost or unreachable ({exc}). Session closed safely. "
            f"Do NOT replay mutating actions automatically. Call 'browser_open()' to re-establish session."
        )

    async def open_browser(self, url: Optional[str] = None, profile: Optional[str] = None, headless: Optional[bool] = None) -> ActionResult:
        """Open browser session and optionally navigate to URL."""
        async with self._lock:
            if not self.has_active_session():
                logger.info("Verifying browser runtime process readiness...")
                await runtime_manager.ensure_running()
                logger.info("Initializing new browser session via provider...")
                try:
                    self._session = await self.provider.create_session(profile=profile, headless=headless)
                except (ProviderUnavailableError, ServerUnavailableError) as e:
                    self._handle_process_crash(e)
                self._state = BrowserSessionState.ACTIVE
                self._active_tab_id = getattr(self._session, "active_tab_id", None)
                try:
                    from app.browser.telemetry import telemetry_tracer
                    telemetry_tracer.record_session_start(
                        session_id=self._session.session_id,
                        profile=profile,
                        provider=getattr(self._session, "provider_name", "camofox"),
                    )
                except Exception as e:
                    logger.debug(f"Telemetry session start record error: {e}")
            
            self._interaction_mode = InteractionMode.BROWSER
            self._invalidate_dom()

            if url:
                prev_url = self._current_url
                try:
                    res = await self.provider.navigate(self._session.session_id, url)
                except (ProviderUnavailableError, ServerUnavailableError) as e:
                    self._handle_process_crash(e)
                self._current_url = res.url or url
                self._current_title = res.title
                self._session.active_url = self._current_url
                if res.active_tab_id:
                    self._active_tab_id = res.active_tab_id
                res.navigation_occurred = bool(prev_url and prev_url != self._current_url)
                res.dom_changed = True
                return res

            return ActionResult(
                success=True,
                url=self._current_url,
                title=self._current_title,
                message="Browser opened and active.",
                dom_changed=True,
                active_tab_id=self._active_tab_id
            )

    async def navigate(self, url: str) -> ActionResult:
        """Navigate active tab to target URL."""
        async with self._lock:
            self._ensure_active_session("browser_navigate")
            prev_url = self._current_url
            self._invalidate_dom()
            try:
                res = await self.provider.navigate(self._session.session_id, url)
            except (ProviderUnavailableError, ServerUnavailableError) as e:
                self._handle_process_crash(e)
            self._current_url = res.url or url
            self._current_title = res.title
            self._session.active_url = self._current_url
            if res.active_tab_id:
                self._active_tab_id = res.active_tab_id
            res.navigation_occurred = True
            res.dom_changed = True
            self._interaction_mode = InteractionMode.BROWSER
            return res

    async def snapshot(self, interactive_only: bool = True) -> Snapshot:
        """Take accessible DOM snapshot of active browser tab."""
        async with self._lock:
            self._ensure_active_session("browser_snapshot")
            self._interaction_mode = InteractionMode.BROWSER
            try:
                snap = await self.provider.snapshot(self._session.session_id, interactive_only=interactive_only)
            except (ProviderUnavailableError, ServerUnavailableError) as e:
                self._handle_process_crash(e)
            
            self._dom_generation += 1
            self._last_snapshot_generation = self._dom_generation
            snap.snapshot_id = f"snap-gen-{self._dom_generation}"
            self._active_snapshot_id = snap.snapshot_id
            self._valid_refs = {el.ref for el in snap.elements}

            if snap.url:
                self._current_url = snap.url
            if snap.title:
                self._current_title = snap.title
            return snap

    async def click(self, target: str) -> ActionResult:
        """Click element on active browser tab."""
        async with self._lock:
            self._ensure_active_session("browser_click")
            self._validate_target_ref(target)
            self._interaction_mode = InteractionMode.BROWSER
            prev_url = self._current_url
            prev_tab = self._active_tab_id

            try:
                res = await self.provider.click(self._session.session_id, target=target)
            except (ProviderUnavailableError, ServerUnavailableError) as e:
                self._handle_process_crash(e)
            self._invalidate_dom()

            if res.url and res.url != prev_url:
                res.navigation_occurred = True
                self._current_url = res.url
            if res.title:
                self._current_title = res.title
            if res.new_tab_opened or (res.active_tab_id and res.active_tab_id != prev_tab):
                res.previous_tab_id = prev_tab
                if res.active_tab_id:
                    self._active_tab_id = res.active_tab_id
            res.dom_changed = True
            return res

    async def type_text(self, target: str, text: str, clear_first: bool = True) -> ActionResult:
        """Type text into targeted input element."""
        async with self._lock:
            self._ensure_active_session("browser_type")
            self._validate_target_ref(target)
            self._interaction_mode = InteractionMode.BROWSER
            try:
                res = await self.provider.type_text(self._session.session_id, target=target, text=text, clear_first=clear_first)
            except (ProviderUnavailableError, ServerUnavailableError) as e:
                self._handle_process_crash(e)
            self._invalidate_dom()
            if res.url:
                self._current_url = res.url
            if res.title:
                self._current_title = res.title
            res.dom_changed = True
            return res

    async def scroll(self, direction: str = "down", amount: int = 500) -> ActionResult:
        """Scroll active tab."""
        async with self._lock:
            self._ensure_active_session("browser_scroll")
            self._interaction_mode = InteractionMode.BROWSER
            try:
                res = await self.provider.scroll(self._session.session_id, direction=direction, amount=amount)
            except (ProviderUnavailableError, ServerUnavailableError) as e:
                self._handle_process_crash(e)
            self._invalidate_dom()
            return res

    async def tabs(self, action: str, tab_id: Optional[str] = None) -> ActionResult:
        """Manage active browser tabs."""
        async with self._lock:
            self._ensure_active_session("browser_tabs")
            self._interaction_mode = InteractionMode.BROWSER
            prev_tab = self._active_tab_id
            try:
                res = await self.provider.manage_tabs(self._session.session_id, action=action, tab_id=tab_id)
            except (ProviderUnavailableError, ServerUnavailableError) as e:
                self._handle_process_crash(e)
            # Update tab ID only AFTER provider call succeeds
            if action in ("switch", "select") and tab_id and res.success:
                self._active_tab_id = tab_id
            self._invalidate_dom()
            res.previous_tab_id = prev_tab
            res.active_tab_id = self._active_tab_id
            if res.url:
                self._current_url = res.url
            return res

    async def extract(self, query: Optional[str] = None) -> ExtractResult:
        """Extract readability text or structured content from active tab."""
        async with self._lock:
            self._ensure_active_session("browser_extract")
            self._interaction_mode = InteractionMode.BROWSER
            ext = await self.provider.extract_content(self._session.session_id, query=query, tab_id=self._active_tab_id)
            if not ext.url:
                ext.url = self._current_url or ""
            if not ext.title:
                ext.title = self._current_title
            return ext

    async def screenshot(self, full_page: bool = False) -> bytes:
        """Capture screenshot of active tab."""
        async with self._lock:
            self._ensure_active_session("browser_screenshot")
            self._interaction_mode = InteractionMode.BROWSER
            return await self.provider.capture_screenshot(self._session.session_id, full_page=full_page)

    async def extract_form_fields(self) -> dict:
        """Extract all form fields across the active page in a single call."""
        async with self._lock:
            self._ensure_active_session("browser_job_extract_form")
            self._interaction_mode = InteractionMode.BROWSER
            return await self.provider.extract_form_fields(self._session.session_id)

    async def bulk_autofill_form(self, field_data: dict) -> dict:
        """Bulk inject form field values into DOM in a single pass and re-verify missing fields."""
        async with self._lock:
            self._ensure_active_session("browser_job_bulk_autofill")
            self._interaction_mode = InteractionMode.BROWSER
            self._invalidate_dom()
            return await self.provider.bulk_autofill_form(self._session.session_id, field_data)

    async def close_browser(self) -> ActionResult:
        """Close active browser session and transition state to CLOSED."""
        async with self._lock:
            if not self.has_active_session():
                return ActionResult(success=True, message="Browser was already closed.")

            session_id = self._session.session_id
            try:
                await self.provider.close_session(session_id)
            except Exception as e:
                logger.warning(f"Error during close_session: {e}")

            try:
                from app.browser.telemetry import telemetry_tracer
                telemetry_tracer.record_session_close(session_id, reason="normal_teardown")
            except Exception:
                pass

            self._session = None
            self._state = BrowserSessionState.CLOSED
            self._interaction_mode = InteractionMode.DESKTOP
            self._current_url = None
            self._current_title = None
            self._active_tab_id = None
            self._active_snapshot_id = None
            self._dom_generation = 0
            self._last_snapshot_generation = 0
            self._valid_refs.clear()
            return ActionResult(success=True, message="Browser session closed successfully.")

    def _ensure_active_session(self, tool_name: str) -> None:
        """Raise BrowserSessionRequiredError if state is not ACTIVE."""
        if not self.has_active_session():
            raise BrowserSessionRequiredError(
                f"No active browser session exists. Invoking '{tool_name}' requires an open browser. "
                f"Call 'browser_open(url=...)' first to start a browser session."
            )

    def _validate_target_ref(self, target: str) -> None:
        """Raise StaleTargetError if target is a ref from an outdated DOM generation."""
        if target.startswith("ref-"):
            if self._last_snapshot_generation < self._dom_generation or target not in self._valid_refs:
                raise StaleTargetError(
                    f"Element reference '{target}' belongs to DOM generation {self._last_snapshot_generation}; "
                    f"current page generation is {self._dom_generation}. Call 'browser_snapshot()' before interacting."
                )


# Global BrowserService singleton instance
browser_service = BrowserService()

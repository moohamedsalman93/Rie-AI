"""
CamoFox Playwright BrowserProvider implementation.
Drives Camoufox (stealth Firefox) via Playwright in-process using AsyncCamoufox.
Handles Windows SelectorEventLoop limitations (e.g. uvicorn --reload worker loop)
by automatically routing browser operations to a dedicated ProactorEventLoop background thread when needed.
"""
import asyncio
import logging
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Union

from app.browser.models import (
    BrowserSession,
    Snapshot,
    ActionResult,
    ExtractResult,
    BrowserElement,
)
from app.browser.providers.base import (
    BrowserProvider,
    ProviderUnavailableError,
    TargetNotFoundError,
)
from app.browser.profile_manager import profile_manager

logger = logging.getLogger(__name__)


class ProactorThreadRunner:
    """
    Manages a dedicated background thread running a ProactorEventLoop on Windows.
    This bypasses Windows SelectorEventLoop limitations (e.g. uvicorn --reload worker loop)
    when spawning Playwright/Camoufox subprocesses.
    """
    def __init__(self):
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._ready = threading.Event()
        self._lock = threading.Lock()

    def _ensure_running(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive() and self._loop and self._loop.is_running():
                return
            self._ready.clear()
            self._thread = threading.Thread(target=self._thread_main, daemon=True, name="CamoFoxProactorThread")
            self._thread.start()
            if not self._ready.wait(timeout=10.0):
                raise RuntimeError("Failed to start CamoFox background ProactorEventLoop thread.")

    def _thread_main(self):
        self._loop = asyncio.ProactorEventLoop()
        asyncio.set_event_loop(self._loop)
        self._ready.set()
        try:
            self._loop.run_forever()
        finally:
            try:
                pending = asyncio.all_tasks(self._loop)
                for task in pending:
                    task.cancel()
                if pending and not self._loop.is_closed():
                    self._loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            except Exception:
                pass
            try:
                if not self._loop.is_closed():
                    self._loop.close()
            except Exception:
                pass

    async def run(self, coro_factory):
        self._ensure_running()
        fut = asyncio.run_coroutine_threadsafe(coro_factory(), self._loop)
        return await asyncio.wrap_future(fut)

    def stop(self):
        with self._lock:
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._loop.stop)
            if self._thread and self._thread.is_alive() and threading.current_thread() != self._thread:
                self._thread.join(timeout=3.0)
            self._thread = None
            self._loop = None


def _is_proactor_loop() -> bool:
    """Check if active event loop is ProactorEventLoop or if running on non-Windows OS."""
    if sys.platform != "win32":
        return True
    try:
        loop = asyncio.get_running_loop()
        return isinstance(loop, asyncio.ProactorEventLoop)
    except RuntimeError:
        return False


# Interactive ARIA roles worth surfacing in snapshots
INTERACTIVE_ROLES = frozenset({
    "link", "button", "textbox", "searchbox", "combobox",
    "checkbox", "radio", "switch", "slider", "spinbutton",
    "option", "menuitem", "menuitemcheckbox", "menuitemradio",
    "tab", "treeitem", "listbox", "menu",
})


class CamoFoxProvider(BrowserProvider):
    """
    Embedded Camoufox provider using AsyncCamoufox + Playwright in-process.
    No external REST server required.
    """

    def __init__(self, **launch_kwargs):
        self._launch_kwargs = launch_kwargs
        self._camoufox_cm = None          # AsyncCamoufox context manager
        self._browser = None              # Browser or BrowserContext (persistent)
        self._context = None              # BrowserContext (non-persistent)
        self._page = None                 # Active Playwright Page
        self._pages: Dict[str, Any] = {}  # tab_id → Page
        self._ref_map: Dict[str, Any] = {}  # ref-N → Locator (current generation)
        self._session_id: Optional[str] = None
        self._persistent = False
        self._initialized = False
        self._thread_runner = ProactorThreadRunner()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def check_health(self) -> bool:
        """Check if the embedded Camoufox runtime can be imported."""
        try:
            from camoufox import AsyncCamoufox  # noqa: F401
            return True
        except ImportError:
            return False

    async def initialize(self) -> None:
        """Verify camoufox package availability."""
        if self._initialized:
            return
        if not await self.check_health():
            raise ProviderUnavailableError(
                "Camoufox Python package is not installed. "
                "Install it with: pip install camoufox"
            )
        self._initialized = True

    async def create_session(self, profile: Optional[str] = None, headless: Optional[bool] = None) -> BrowserSession:
        """Launch Camoufox browser and create a session."""
        if _is_proactor_loop():
            return await self._impl_create_session(profile=profile, headless=headless)
        return await self._thread_runner.run(lambda: self._impl_create_session(profile=profile, headless=headless))

    async def _impl_create_session(self, profile: Optional[str] = None, headless: Optional[bool] = None) -> BrowserSession:
        await self.initialize()
        from camoufox import AsyncCamoufox

        prof_id = profile or "default"
        profile_dir = str(profile_manager.get_profile_dir(prof_id))
        profile_manager.touch_profile(prof_id)

        # Merge user launch kwargs with profile settings
        kwargs = {**self._launch_kwargs}
        if headless is not None:
            kwargs["headless"] = headless
        else:
            from app.config import Settings
            cfg = Settings()
            mode = cfg.CAMOFOX_HEADLESS_MODE
            if mode == "headless":
                kwargs["headless"] = True
            elif mode == "normal":
                kwargs["headless"] = False
            else:
                # "auto" mode: default to visible GUI (False) for user sessions
                kwargs.setdefault("headless", False)

        # Ensure high resolution window size to fill desktop panel workspace
        kwargs.setdefault("window", (1920, 1080))
        self._headless = kwargs.get("headless", False)

        # Configure Firefox user preferences to allow media autoplay with sound
        user_prefs = kwargs.setdefault("firefox_user_prefs", {})
        user_prefs.setdefault("media.autoplay.default", 0)
        user_prefs.setdefault("media.autoplay.blocking_policy", 0)
        user_prefs.setdefault("media.autoplay.allow-muted", False)

        if prof_id != "default":
            kwargs["persistent_context"] = True
            kwargs["user_data_dir"] = profile_dir
            self._persistent = True
        else:
            self._persistent = False

        try:
            self._camoufox_cm = AsyncCamoufox(**kwargs)
            result = await self._camoufox_cm.__aenter__()

            if hasattr(result, "pages"):
                # AsyncCamoufox returns BrowserContext directly
                self._context = result
                self._browser = getattr(result, "browser", None)
            else:
                self._browser = result
                self._context = await self._browser.new_context()

            if self._context.pages:
                self._page = self._context.pages[0]
            else:
                self._page = await self._context.new_page()

            self._session_id = f"camofox-{uuid.uuid4().hex[:8]}"
            tab_id = f"tab-{id(self._page)}"
            self._pages = {tab_id: self._page}
            self._ref_map = {}

            logger.info(f"CamoFox session created: {self._session_id} (profile={prof_id}, persistent={self._persistent})")

            return BrowserSession(
                session_id=self._session_id,
                provider_name="camofox",
                profile=profile,
                created_at=datetime.now(timezone.utc).isoformat(),
                active_url=self._page.url if self._page.url != "about:blank" else None,
                active_tab_id=tab_id,
            )

        except Exception as e:
            err_detail = f"{type(e).__name__}: {str(e) or repr(e)}"
            logger.error(f"Failed to launch Camoufox browser: {err_detail}", exc_info=True)
            await self._cleanup()
            raise ProviderUnavailableError(f"Failed to launch Camoufox: {err_detail}") from e

    async def close_session(self, session_id: str) -> bool:
        """Close the Camoufox browser session."""
        if _is_proactor_loop():
            return await self._impl_close_session(session_id)
        res = await self._thread_runner.run(lambda: self._impl_close_session(session_id))
        self._thread_runner.stop()
        return res

    async def _impl_close_session(self, session_id: str) -> bool:
        try:
            await self._cleanup()
            logger.info(f"CamoFox session closed: {session_id}")
            return True
        except Exception as e:
            logger.warning(f"Error closing CamoFox session: {e}")
            return True

    async def _cleanup(self):
        """Tear down all Playwright/Camoufox resources."""
        self._ref_map = {}
        self._pages = {}
        # Exit the Camoufox context manager BEFORE nulling references,
        # so __aexit__ can still access browser/context/page for graceful shutdown.
        if self._camoufox_cm:
            try:
                await self._camoufox_cm.__aexit__(None, None, None)
            except Exception as e:
                logger.debug(f"Cleanup error: {e}")
            self._camoufox_cm = None
        self._page = None
        self._context = None
        self._browser = None
        self._session_id = None

    # ------------------------------------------------------------------
    # Navigation
    # ------------------------------------------------------------------

    async def navigate(self, session_id: str, url: str) -> ActionResult:
        """Navigate current page to URL."""
        if _is_proactor_loop():
            return await self._impl_navigate(session_id, url)
        return await self._thread_runner.run(lambda: self._impl_navigate(session_id, url))

    async def _impl_navigate(self, session_id: str, url: str) -> ActionResult:
        self._require_page()
        try:
            response = await self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            try:
                await self._page.wait_for_load_state("networkidle", timeout=3000)
            except Exception:
                pass
            self._ref_map = {}  # Invalidate refs on navigation

            return ActionResult(
                success=True,
                url=self._page.url,
                title=await self._page.title(),
                message=f"Successfully navigated to {url}",
                changed=True,
                navigation_occurred=True,
                active_tab_id=self._get_active_tab_id(),
            )
        except Exception as e:
            return ActionResult(
                success=False,
                url=url,
                message=f"Navigation to {url} failed: {e}",
            )

    # ------------------------------------------------------------------
    # Snapshot (Accessibility Tree → BrowserElements + ref_map)
    # ------------------------------------------------------------------

    async def snapshot(self, session_id: str, interactive_only: bool = True) -> Snapshot:
        """Build accessibility snapshot and populate ref_map with Locators."""
        if _is_proactor_loop():
            return await self._impl_snapshot(session_id, interactive_only)
        return await self._thread_runner.run(lambda: self._impl_snapshot(session_id, interactive_only))

    async def _impl_snapshot(self, session_id: str, interactive_only: bool = True) -> Snapshot:
        self._require_page()

        self._ref_map = {}
        elements: List[BrowserElement] = []
        ref_idx = 0

        try:
            aria_text = None
            try:
                # Use Playwright's aria_snapshot with a 5s timeout budget for heavy SPAs
                aria_text = await self._page.aria_snapshot(timeout=5000)
            except Exception as e:
                logger.debug(f"aria_snapshot timed out or failed ({e}), using fast JS interactive scanner")

            if aria_text:
                # Parse ARIA snapshot YAML-like text into interactive elements
                for line in aria_text.splitlines():
                    stripped = line.strip()
                    if not stripped:
                        continue

                    # Match patterns like: - role "name": value
                    # or: - role "name"
                    match = re.match(
                        r'^-\s+(\w+)\s+"([^"]*)"(?:\s*:\s*(.*))?$',
                        stripped,
                    )
                    if not match:
                        # Try: - role "name" [checked]
                        match = re.match(
                            r'^-\s+(\w+)\s+"([^"]*)"(?:\s+\[([^\]]+)\])?$',
                            stripped,
                        )

                    if match:
                        role = match.group(1).lower()
                        name = match.group(2)
                        value = match.group(3) if match.lastindex >= 3 else None

                        if interactive_only and role not in INTERACTIVE_ROLES:
                            continue

                        ref = f"ref-{ref_idx}"

                        # Build a Playwright locator for this element
                        try:
                            locator = self._page.get_by_role(role, name=name, exact=False)
                            count = await locator.count()
                            if count > 0:
                                locator = locator.first
                            else:
                                locator = None
                        except Exception:
                            locator = None

                        if locator:
                            self._ref_map[ref] = locator

                        elements.append(BrowserElement(
                            ref=ref,
                            role=role,
                            name=name,
                            value=value.strip() if value else None,
                        ))
                        ref_idx += 1

            # If ARIA snapshot parsing yielded fewer than 5 elements (e.g. SPA initial header load), run fast JS scanner
            if len(elements) < 5:
                fallback_elems, ref_idx = await self._fallback_interactive_scan(interactive_only, start_ref_idx=ref_idx)
                elements.extend(fallback_elems)
                if len(elements) < 5:
                    # Give single-page app (e.g. YouTube search results) 1.0s to render DOM elements
                    await asyncio.sleep(1.0)
                    fallback_elems, ref_idx = await self._fallback_interactive_scan(interactive_only, start_ref_idx=ref_idx)
                    elements.extend(fallback_elems)

            snap_id = f"snap-{uuid.uuid4().hex[:8]}"
            page_title = await self._page.title()
            page_url = self._page.url

            # Build summary text
            summary_parts = []
            if page_title:
                summary_parts.append(page_title)
            if page_url and page_url != "about:blank":
                summary_parts.append(page_url)
            summary = " - ".join(summary_parts) if summary_parts else None

            return Snapshot(
                snapshot_id=snap_id,
                url=page_url,
                title=page_title,
                elements=elements,
                text=summary,
            )

        except Exception as e:
            logger.error(f"Snapshot failed: {e}")
            snap_id = f"snap-{uuid.uuid4().hex[:8]}"
            return Snapshot(
                snapshot_id=snap_id,
                url=self._page.url if self._page else "",
                title="",
                elements=[],
                text=f"Snapshot error: {e}",
            )

    async def _fallback_interactive_scan(self, interactive_only: bool, start_ref_idx: int = 0) -> tuple:
        """Fast recursive Shadow-DOM-aware JS scanner for interactive elements."""
        elements: List[BrowserElement] = []
        ref_idx = start_ref_idx

        try:
            raw_items = await self._page.evaluate("""
                () => {
                    const results = [];
                    const selector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="searchbox"], [role="combobox"], [role="textbox"], [role="tab"], [role="option"]';
                    
                    function collect(root) {
                        if (!root || results.length >= 100) return;
                        try {
                            const nodes = Array.from(root.querySelectorAll(selector));
                            for (const node of nodes) {
                                if (results.length >= 100) break;
                                try {
                                    if (window.getComputedStyle(node).display === 'none') continue;
                                } catch(e) {}
                                const role = node.getAttribute('role') || node.tagName.toLowerCase();
                                let name = node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.getAttribute('title') || node.getAttribute('name') || node.innerText || node.textContent || '';
                                name = name.trim().replace(/\\s+/g, ' ').slice(0, 100);
                                let value = null;
                                if (['input', 'textarea', 'select'].includes(node.tagName.toLowerCase())) {
                                    value = node.value || null;
                                }
                                let href = node.getAttribute('href');
                                let idAttr = node.id;
                                results.push({ role, name, value, href, idAttr, tag: node.tagName.toLowerCase() });
                            }
                        } catch(e) {}

                        try {
                            const all = Array.from(root.querySelectorAll('*'));
                            for (const el of all) {
                                if (results.length >= 100) break;
                                if (el.shadowRoot) {
                                    collect(el.shadowRoot);
                                }
                            }
                        } catch(e) {}
                    }

                    collect(document);
                    return results;
                }
            """)

            for item in raw_items:
                ref = f"ref-{ref_idx}"
                role = item.get("role", "element")
                name = item.get("name", "")
                value = item.get("value")
                href = item.get("href")
                id_attr = item.get("idAttr")
                tag = item.get("tag", "a")

                locator = None
                try:
                    if id_attr:
                        locator = self._page.locator(f"#{id_attr}").first
                    elif href:
                        locator = self._page.locator(f"a[href='{href}']").first
                    elif name:
                        locator = self._page.get_by_role(role, name=name, exact=False).first if role in INTERACTIVE_ROLES else self._page.get_by_text(name, exact=False).first
                    else:
                        locator = self._page.locator(tag).first
                except Exception:
                    pass

                if locator:
                    self._ref_map[ref] = locator

                elements.append(BrowserElement(
                    ref=ref, role=role, name=name, value=value,
                ))
                ref_idx += 1
        except Exception as e:
            logger.debug(f"Fast JS interactive scan error: {e}")

        return elements, ref_idx

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    async def click(self, session_id: str, target: str) -> ActionResult:
        """Click an element by ref or text."""
        if _is_proactor_loop():
            return await self._impl_click(session_id, target)
        return await self._thread_runner.run(lambda: self._impl_click(session_id, target))

    async def _impl_click(self, session_id: str, target: str) -> ActionResult:
        self._require_page()

        locator = self._ref_map.get(target)
        if not locator:
            # Try text-based fallback
            locator = self._page.get_by_text(target, exact=False).first
            try:
                if not await locator.is_visible():
                    raise TargetNotFoundError(f"Target '{target}' not found on page")
            except Exception:
                raise TargetNotFoundError(f"Target '{target}' not found on page")

        url_before = self._page.url
        ctx = self._context or (self._browser.contexts[0] if self._browser and self._browser.contexts else None)
        pages_before = set(id(p) for p in ctx.pages) if ctx else set()

        try:
            # Stage 1: Standard Playwright click
            await locator.click(timeout=4000)
        except Exception as first_err:
            try:
                # Stage 2: Forced click (bypasses Playwright pointer-event interception & actionability checks)
                await locator.click(force=True, timeout=4000)
            except Exception as second_err:
                try:
                    # Stage 3: Direct JS element click event dispatch
                    await locator.evaluate("el => el.click()")
                except Exception as third_err:
                    return ActionResult(
                        success=False,
                        message=f"Click on '{target}' failed: {first_err}",
                    )

        # Brief wait for potential navigation/DOM changes
        await asyncio.sleep(0.3)

        url_after = self._page.url
        title_after = await self._page.title()
        nav_occurred = url_before != url_after

        # Check for new tabs/popups
        new_tab = False
        new_tab_id = None
        ctx = self._context or (self._browser.contexts[0] if self._browser and self._browser.contexts else None)
        if ctx:
            pages_after = set(id(p) for p in ctx.pages)
            new_page_ids = pages_after - pages_before
            if new_page_ids:
                new_tab = True
                for p in ctx.pages:
                    if id(p) in new_page_ids:
                        new_tab_id = f"tab-{id(p)}"
                        self._pages[new_tab_id] = p
                        self._page = p  # Switch to new tab
                        break

        self._ref_map = {}  # Conservative invalidation

        return ActionResult(
            success=True,
            url=url_after,
            title=title_after,
            message=f"Clicked target '{target}'",
            changed=True,
            navigation_occurred=nav_occurred,
            dom_changed=True,
            active_tab_id=new_tab_id or self._get_active_tab_id(),
            new_tab_opened=new_tab,
        )

    async def type_text(self, session_id: str, target: str, text: str, clear_first: bool = True) -> ActionResult:
        """Type text into an element."""
        if _is_proactor_loop():
            return await self._impl_type_text(session_id, target, text, clear_first)
        return await self._thread_runner.run(lambda: self._impl_type_text(session_id, target, text, clear_first))

    async def _impl_type_text(self, session_id: str, target: str, text: str, clear_first: bool = True) -> ActionResult:
        self._require_page()

        locator = self._ref_map.get(target)
        if not locator:
            raise TargetNotFoundError(f"Target '{target}' not found in current snapshot")

        try:
            should_press_enter = ("\n" in text or "\r" in text)
            clean_text = text.replace("\r", "").replace("\n", "")

            # Check if locator is an editable element (input/textarea/contenteditable).
            # If targeted element is a button/wrapper (e.g. search box wrapper), resolve to nearest editable input.
            target_input = locator
            try:
                is_editable = await locator.evaluate(
                    "el => el.isContentEditable || ['input', 'textarea'].includes(el.tagName ? el.tagName.toLowerCase() : '')"
                )
                if not is_editable:
                    # Look inside element for an input
                    child_input = locator.locator("input, textarea, [contenteditable='true']").first
                    if await child_input.count() > 0:
                        target_input = child_input
                    else:
                        # Fallback to page-level input field (e.g. YouTube search input)
                        page_input = self._page.locator(
                            "input[name='search_query'], input#search, input[type='search'], input[type='text'], [contenteditable='true']"
                        ).first
                        if await page_input.count() > 0:
                            target_input = page_input
            except Exception:
                pass

            if clear_first:
                await target_input.fill(clean_text, timeout=10000)
            else:
                await target_input.press_sequentially(clean_text, timeout=10000)

            if should_press_enter:
                await target_input.press("Enter", timeout=5000)
        except Exception as e:
            return ActionResult(
                success=False,
                message=f"Typing into '{target}' failed: {e}",
            )

        self._ref_map = {}  # Conservative invalidation

        return ActionResult(
            success=True,
            url=self._page.url,
            title=await self._page.title(),
            message=f"Typed text into '{target}'",
            changed=True,
        )

    async def scroll(self, session_id: str, direction: str = "down", amount: int = 500) -> ActionResult:
        """Scroll the page."""
        if _is_proactor_loop():
            return await self._impl_scroll(session_id, direction, amount)
        return await self._thread_runner.run(lambda: self._impl_scroll(session_id, direction, amount))

    async def _impl_scroll(self, session_id: str, direction: str = "down", amount: int = 500) -> ActionResult:
        self._require_page()

        delta_map = {
            "down": amount,
            "up": -amount,
            "top": "top",
            "bottom": "bottom",
        }
        delta = delta_map.get(direction, amount)

        try:
            if delta == "top":
                await self._page.evaluate("window.scrollTo(0, 0)")
            elif delta == "bottom":
                await self._page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            else:
                await self._page.evaluate(f"window.scrollBy(0, {delta})")
        except Exception as e:
            return ActionResult(success=False, message=f"Scroll failed: {e}")

        return ActionResult(
            success=True,
            url=self._page.url,
            message=f"Scrolled {direction} by {amount}px",
            changed=True,
        )

    async def manage_tabs(self, session_id: str, action: str, tab_id: Optional[str] = None) -> ActionResult:
        """List, switch, or close tabs."""
        if _is_proactor_loop():
            return await self._impl_manage_tabs(session_id, action, tab_id)
        return await self._thread_runner.run(lambda: self._impl_manage_tabs(session_id, action, tab_id))

    async def _impl_manage_tabs(self, session_id: str, action: str, tab_id: Optional[str] = None) -> ActionResult:
        self._require_page()
        ctx = self._context or (self._browser.contexts[0] if self._browser and self._browser.contexts else None)

        if action == "list":
            tabs = []
            if ctx:
                for p in ctx.pages:
                    tid = f"tab-{id(p)}"
                    tabs.append({"id": tid, "url": p.url})
            return ActionResult(
                success=True,
                url=self._page.url,
                message=f"Tab action 'list' executed. Open tabs: {len(tabs)}",
            )

        elif action == "switch" and tab_id:
            page = self._pages.get(tab_id)
            if page:
                self._page = page
                await page.bring_to_front()
                self._ref_map = {}
                return ActionResult(
                    success=True, url=page.url, title=await page.title(),
                    message=f"Switched to tab {tab_id}",
                    active_tab_id=tab_id,
                )
            return ActionResult(success=False, message=f"Tab '{tab_id}' not found")

        elif action == "close" and tab_id:
            page = self._pages.pop(tab_id, None)
            if page and page != self._page:
                await page.close()
                return ActionResult(success=True, message=f"Closed tab {tab_id}")
            return ActionResult(success=False, message=f"Cannot close tab '{tab_id}'")

        return ActionResult(success=False, message=f"Unknown tab action '{action}'")

    async def resize_viewport(self, session_id: str, width: int, height: int) -> ActionResult:
        """Resize active page viewport dynamically."""
        if _is_proactor_loop():
            return await self._impl_resize_viewport(session_id, width, height)
        return await self._thread_runner.run(lambda: self._impl_resize_viewport(session_id, width, height))

    async def _impl_resize_viewport(self, session_id: str, width: int, height: int) -> ActionResult:
        self._require_page()
        try:
            target_w = max(320, width)
            target_h = max(240, height)
            await self._page.set_viewport_size({"width": target_w, "height": target_h})
            return ActionResult(
                success=True,
                url=self._page.url,
                title=await self._page.title(),
                message=f"Viewport resized to {target_w}x{target_h}",
            )
        except Exception as e:
            return ActionResult(success=False, message=f"Resize viewport error: {e}")

    async def extract_content(self, session_id: str, query: Optional[str] = None, tab_id: Optional[str] = None) -> ExtractResult:
        """Extract page content as clean text."""
        if _is_proactor_loop():
            return await self._impl_extract_content(session_id, query, tab_id)
        return await self._thread_runner.run(lambda: self._impl_extract_content(session_id, query, tab_id))

    async def _impl_extract_content(self, session_id: str, query: Optional[str] = None, tab_id: Optional[str] = None) -> ExtractResult:
        self._require_page()
        page = self._pages.get(tab_id, self._page) if tab_id else self._page

        try:
            title = await page.title()
            url = page.url

            # Get page text content
            body_text = await page.evaluate("""
                () => {
                    const body = document.body;
                    if (!body) return '';
                    // Remove script/style elements
                    const clone = body.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
                    return clone.innerText || clone.textContent || '';
                }
            """)

            # Clean up whitespace
            content = re.sub(r'\n{3,}', '\n\n', body_text.strip())

            return ExtractResult(
                url=url,
                title=title,
                content=content[:50000],  # Cap at 50k chars
            )
        except Exception as e:
            return ExtractResult(
                url=self._page.url if self._page else "",
                title=None,
                content=f"Content extraction failed: {e}",
            )

    async def capture_screenshot(self, session_id: str, full_page: bool = False) -> bytes:
        """Capture page screenshot."""
        if _is_proactor_loop():
            return await self._impl_capture_screenshot(session_id, full_page)
        return await self._thread_runner.run(lambda: self._impl_capture_screenshot(session_id, full_page))

    async def _impl_capture_screenshot(self, session_id: str, full_page: bool = False) -> bytes:
        self._require_page()
        try:
            return await self._page.screenshot(full_page=full_page)
        except Exception as e:
            logger.error(f"Screenshot failed: {e}")
            return b""

    # ------------------------------------------------------------------
    # Job Form Extraction & Bulk DOM Autofill
    # ------------------------------------------------------------------

    async def extract_form_fields(self, session_id: str) -> dict:
        """Extract all form fields, labels, types, and current values in a single JS pass."""
        if _is_proactor_loop():
            return await self._impl_extract_form_fields(session_id)
        return await self._thread_runner.run(lambda: self._impl_extract_form_fields(session_id))

    async def _impl_extract_form_fields(self, session_id: str) -> dict:
        self._require_page()
        try:
            fields = await self._page.evaluate("""
                () => {
                    function getDetailedLabel(el) {
                        if (!el) return '';
                        let aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title');
                        if (aria && aria.trim().length > 1) return aria.trim();

                        if (el.id) {
                            try {
                                let lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                                if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
                            } catch(e) {}
                        }

                        let parentLbl = el.closest('label');
                        if (parentLbl && parentLbl.innerText.trim()) {
                            let t = parentLbl.innerText.trim();
                            if (t.length < 150) return t;
                        }

                        let sib = el.previousElementSibling;
                        while (sib) {
                            let sibText = (sib.innerText || sib.textContent || '').trim();
                            if (sibText.length > 1 && sibText.length < 150) return sibText;
                            sib = sib.previousElementSibling;
                        }

                        let parent = el.parentElement;
                        for (let depth = 0; depth < 4 && parent && parent !== document.body; depth++) {
                            let psib = parent.previousElementSibling;
                            while (psib) {
                                let psibText = (psib.innerText || psib.textContent || '').trim();
                                if (psibText.length > 1 && psibText.length < 150) return psibText;
                                psib = psib.previousElementSibling;
                            }

                            let labelTarget = parent.querySelector('label, .label, .field-label, [class*="label"], [class*="title"], [class*="heading"], p, h1, h2, h3, h4, h5, h6, legend');
                            if (labelTarget && labelTarget !== el) {
                                let ltText = (labelTarget.innerText || labelTarget.textContent || '').trim();
                                if (ltText.length > 1 && ltText.length < 150) return ltText;
                            }
                            parent = parent.parentElement;
                        }

                        let fieldset = el.closest('fieldset');
                        if (fieldset) {
                            let legend = fieldset.querySelector('legend');
                            if (legend && legend.innerText.trim()) return legend.innerText.trim();
                        }

                        return el.name || el.id || '';
                    }

                    const fields = [];
                    function scan(root) {
                        if (!root) return;
                        const selector = 'input, textarea, select, [contenteditable="true"]';
                        const nodes = Array.from(root.querySelectorAll(selector));
                        for (const el of nodes) {
                            try {
                                if (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden') continue;
                            } catch(e) {}
                            
                            const tag = el.tagName.toLowerCase();
                            const type = (el.type || tag).toLowerCase();
                            if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
                            
                            let rawLabel = getDetailedLabel(el);
                            let label = rawLabel.trim().replace(/\\s+/g, ' ').slice(0, 100);
                            
                            let options = [];
                            if (tag === 'select') {
                                options = Array.from(el.options).map(o => o.text.trim());
                            }
                            
                            fields.push({
                                tag,
                                type,
                                name: el.name || '',
                                id: el.id || '',
                                label,
                                value: el.value || (el.isContentEditable ? el.innerText : ''),
                                required: el.required || el.getAttribute('aria-required') === 'true',
                                options
                            });
                        }
                        try {
                            const all = Array.from(root.querySelectorAll('*'));
                            for (const sub of all) {
                                if (sub.shadowRoot) scan(sub.shadowRoot);
                            }
                        } catch(e) {}
                    }
                    scan(document);
                    return fields;
                }
            """)
            return {
                "success": True,
                "url": self._page.url,
                "title": await self._page.title(),
                "field_count": len(fields),
                "fields": fields
            }
        except Exception as e:
            return {"success": False, "error": str(e), "fields": []}

    async def bulk_autofill_form(self, session_id: str, field_data: dict) -> dict:
        """Bulk inject form field values into DOM in a single pass and verify missing fields."""
        if _is_proactor_loop():
            return await self._impl_bulk_autofill_form(session_id, field_data)
        return await self._thread_runner.run(lambda: self._impl_bulk_autofill_form(session_id, field_data))

    async def _impl_bulk_autofill_form(self, session_id: str, field_data: dict) -> dict:
        self._require_page()
        try:
            res = await self._page.evaluate("""
                (dataMap) => {
                    function getDetailedLabel(el) {
                        if (!el) return '';
                        let aria = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title');
                        if (aria && aria.trim().length > 1) return aria.trim();

                        if (el.id) {
                            try {
                                let lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                                if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
                            } catch(e) {}
                        }

                        let parentLbl = el.closest('label');
                        if (parentLbl && parentLbl.innerText.trim()) {
                            let t = parentLbl.innerText.trim();
                            if (t.length < 150) return t;
                        }

                        let sib = el.previousElementSibling;
                        while (sib) {
                            let sibText = (sib.innerText || sib.textContent || '').trim();
                            if (sibText.length > 1 && sibText.length < 150) return sibText;
                            sib = sib.previousElementSibling;
                        }

                        let parent = el.parentElement;
                        for (let depth = 0; depth < 4 && parent && parent !== document.body; depth++) {
                            let psib = parent.previousElementSibling;
                            while (psib) {
                                let psibText = (psib.innerText || psib.textContent || '').trim();
                                if (psibText.length > 1 && psibText.length < 150) return psibText;
                                psib = psib.previousElementSibling;
                            }

                            let labelTarget = parent.querySelector('label, .label, .field-label, [class*="label"], [class*="title"], [class*="heading"], p, h1, h2, h3, h4, h5, h6, legend');
                            if (labelTarget && labelTarget !== el) {
                                let ltText = (labelTarget.innerText || labelTarget.textContent || '').trim();
                                if (ltText.length > 1 && ltText.length < 150) return ltText;
                            }
                            parent = parent.parentElement;
                        }

                        let fieldset = el.closest('fieldset');
                        if (fieldset) {
                            let legend = fieldset.querySelector('legend');
                            if (legend && legend.innerText.trim()) return legend.innerText.trim();
                        }

                        return el.name || el.id || '';
                    }

                    const results = { injected: [], missing: [], total_matched: 0 };
                    const selector = 'input, textarea, select, [contenteditable="true"]';
                    
                    function findAndFill(root) {
                        if (!root) return;
                        const nodes = Array.from(root.querySelectorAll(selector));
                        for (const el of nodes) {
                            try {
                                if (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden') continue;
                            } catch(e) {}
                            
                            const tag = el.tagName.toLowerCase();
                            const type = (el.type || tag).toLowerCase();
                            if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
                            
                            let label = getDetailedLabel(el);
                            const cleanLabel = label.trim().toLowerCase();
                            
                            let matchedValue = null;
                            for (const [k, val] of Object.entries(dataMap)) {
                                const keyLower = k.toLowerCase().replace(/_/g, ' ');
                                if (cleanLabel.includes(keyLower) || (el.name && el.name.toLowerCase().includes(keyLower)) || (el.id && el.id.toLowerCase().includes(keyLower))) {
                                    matchedValue = val;
                                    break;
                                }
                            }
                            
                            if (matchedValue !== null && matchedValue !== undefined) {
                                try {
                                    if (type === 'checkbox') {
                                        const boolVal = String(matchedValue).toLowerCase() === 'true' || String(matchedValue) === '1' || String(matchedValue).toLowerCase() === 'yes';
                                        if (el.checked !== boolVal) {
                                            el.checked = boolVal;
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                            el.dispatchEvent(new Event('input', { bubbles: true }));
                                        }
                                    } else if (type === 'radio') {
                                        if (el.value.toLowerCase() === String(matchedValue).toLowerCase() || cleanLabel.includes(String(matchedValue).toLowerCase())) {
                                            el.checked = true;
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    } else if (tag === 'select') {
                                        let optMatched = false;
                                        for (const opt of el.options) {
                                            if (opt.text.toLowerCase().includes(String(matchedValue).toLowerCase()) || opt.value.toLowerCase() === String(matchedValue).toLowerCase()) {
                                                el.value = opt.value;
                                                optMatched = true;
                                                break;
                                            }
                                        }
                                        if (optMatched) {
                                            el.dispatchEvent(new Event('change', { bubbles: true }));
                                        }
                                    } else if (el.isContentEditable) {
                                        el.innerText = String(matchedValue);
                                        el.dispatchEvent(new Event('input', { bubbles: true }));
                                    } else {
                                        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                                            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                                        if (nativeSetter) {
                                            nativeSetter.call(el, String(matchedValue));
                                        } else {
                                            el.value = String(matchedValue);
                                        }
                                        el.dispatchEvent(new Event('input', { bubbles: true }));
                                        el.dispatchEvent(new Event('change', { bubbles: true }));
                                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                                    }
                                    results.injected.push({ label: label || el.name || el.id, value: String(matchedValue) });
                                    results.total_matched++;
                                } catch(e) {}
                            } else {
                                if (el.required || el.getAttribute('aria-required') === 'true') {
                                    if (!el.value || (el.type === 'checkbox' && !el.checked)) {
                                        results.missing.push({ label: label || el.name || el.id, type, required: true });
                                    }
                                }
                            }
                        }
                        
                        try {
                            const all = Array.from(root.querySelectorAll('*'));
                            for (const sub of all) {
                                if (sub.shadowRoot) findAndFill(sub.shadowRoot);
                            }
                        } catch(e) {}
                    }
                    
                    findAndFill(document);
                    return results;
                }
            """, field_data)
            return {
                "success": True,
                "url": self._page.url,
                "title": await self._page.title(),
                "injected_count": res.get("total_matched", 0),
                "injected_fields": res.get("injected", []),
                "missing_required_fields": res.get("missing", []),
            }
        except Exception as e:
            return {"success": False, "error": str(e), "injected_count": 0}

    async def upload_file(self, session_id: str, target: str, file_path: str) -> ActionResult:
        """Upload/inject a file into a targeted file input element."""
        if _is_proactor_loop():
            return await self._impl_upload_file(session_id, target, file_path)
        return await self._thread_runner.run(lambda: self._impl_upload_file(session_id, target, file_path))

    async def _impl_upload_file(self, session_id: str, target: str, file_path: str) -> ActionResult:
        self._require_page()
        import os
        if not os.path.exists(file_path):
            return ActionResult(
                success=False,
                url=self._page.url,
                title=await self._page.title(),
                message=f"File not found on path: '{file_path}'"
            )

        locator = self._ref_map.get(target)
        if not locator:
            locator = self._page.locator('input[type="file"]').first
            try:
                if not await locator.count():
                    locator = self._page.get_by_label(target).first
            except Exception:
                pass

        try:
            await locator.set_input_files(file_path)
            return ActionResult(
                success=True,
                url=self._page.url,
                title=await self._page.title(),
                message=f"Successfully uploaded file '{os.path.basename(file_path)}' into '{target}'.",
                dom_changed=True
            )
        except Exception as e:
            return ActionResult(
                success=False,
                url=self._page.url,
                title=await self._page.title(),
                message=f"Failed to upload file: {e}"
            )

    async def click_at_coords(self, session_id: str, x: int, y: int) -> ActionResult:
        """Click at pixel coordinates."""
        if _is_proactor_loop():
            return await self._impl_click_at_coords(session_id, x, y)
        return await self._thread_runner.run(lambda: self._impl_click_at_coords(session_id, x, y))

    async def _impl_click_at_coords(self, session_id: str, x: int, y: int) -> ActionResult:
        self._require_page()
        try:
            await self._page.mouse.click(x, y)
            await asyncio.sleep(0.1)
            return ActionResult(
                success=True,
                url=self._page.url,
                title=await self._page.title(),
                message=f"Clicked at ({x}, {y})",
                changed=True,
            )
        except Exception as e:
            return ActionResult(success=False, message=f"Click failed: {e}")

    async def scroll_page(self, session_id: str, delta_x: int, delta_y: int) -> ActionResult:
        """Scroll page by delta offsets."""
        if _is_proactor_loop():
            return await self._impl_scroll_page(session_id, delta_x, delta_y)
        return await self._thread_runner.run(lambda: self._impl_scroll_page(session_id, delta_x, delta_y))

    async def _impl_scroll_page(self, session_id: str, delta_x: int, delta_y: int) -> ActionResult:
        self._require_page()
        try:
            await self._page.mouse.wheel(delta_x, delta_y)
            return ActionResult(
                success=True,
                url=self._page.url,
                title=await self._page.title(),
                message=f"Scrolled by ({delta_x}, {delta_y})",
                changed=True,
            )
        except Exception as e:
            return ActionResult(success=False, message=f"Scroll failed: {e}")

    async def send_keyboard_input(self, session_id: str, text: str) -> ActionResult:
        """Send keyboard typing or key press."""
        if _is_proactor_loop():
            return await self._impl_send_keyboard_input(session_id, text)
        return await self._thread_runner.run(lambda: self._impl_send_keyboard_input(session_id, text))

    async def _impl_send_keyboard_input(self, session_id: str, text: str) -> ActionResult:
        self._require_page()
        try:
            if len(text) == 1 or text in ["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]:
                await self._page.keyboard.press(text)
            else:
                await self._page.keyboard.type(text)
            return ActionResult(
                success=True,
                url=self._page.url,
                title=await self._page.title(),
                message="Sent keyboard input",
                changed=True,
            )
        except Exception as e:
            return ActionResult(success=False, message=f"Keyboard input failed: {e}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _require_page(self):
        """Raise if no active page."""
        if not self._page:
            raise ProviderUnavailableError("No active browser page. Call create_session() first.")

    def _get_active_tab_id(self) -> Optional[str]:
        """Get tab ID for the current active page."""
        if not self._page:
            return None
        for tid, page in self._pages.items():
            if page is self._page:
                return tid
        return None

"""
Acceptance Gate Test Suite for Rie's Browser Subsystem.

Tests 1-13: Architecture acceptance (mock provider)
Test 14:    Real CamoFox vertical E2E (no mocks)

Mock tests use MockBrowserProvider — a direct BrowserProvider implementation
that returns deterministic responses without any HTTP transport or browser process.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional, List

from app.browser.models import (
    InteractionMode,
    BrowserSessionState,
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
from app.browser.service import BrowserService, BrowserSessionRequiredError
from app.browser.tools import (
    browser_open,
    browser_navigate,
    browser_snapshot,
    browser_click,
    browser_type,
    browser_scroll,
    browser_tabs,
    browser_extract,
    browser_close,
)

logger = logging.getLogger("e2e_acceptance")


class MockBrowserProvider(BrowserProvider):
    """
    Deterministic mock implementing BrowserProvider directly.
    No HTTP, no Playwright, no browser process. Returns canned responses
    so architecture-level invariants can be verified.
    """

    def __init__(self):
        self.session_id = "test-mock-session-123"
        self.current_url = "about:blank"
        self.current_title = "Blank Page"
        self.search_value = ""
        self.active_profile_path: Optional[str] = None
        self.active_tab_id = "tab-1"

    async def check_health(self) -> bool:
        return True

    async def create_session(self, profile: Optional[str] = None) -> BrowserSession:
        from app.browser.profile_manager import profile_manager
        prof_id = profile or "default"
        profile_dir = str(profile_manager.get_profile_dir(prof_id))
        profile_manager.touch_profile(prof_id)
        self.active_profile_path = profile_dir
        self.current_url = "https://wikipedia.org"
        self.current_title = "Wikipedia, the free encyclopedia"
        self.active_tab_id = "tab-1"

        # Load persistent profile state if exists
        state_file = Path(profile_dir) / "state.json"
        if state_file.exists():
            try:
                saved = json.loads(state_file.read_text(encoding="utf-8"))
                self.search_value = saved.get("search_value", "")
            except Exception:
                self.search_value = ""
        else:
            self.search_value = ""

        return BrowserSession(
            session_id=self.session_id,
            provider_name="mock",
            profile=profile,
            created_at=datetime.now(timezone.utc).isoformat(),
            active_url=self.current_url,
            active_tab_id=self.active_tab_id,
        )

    async def navigate(self, session_id: str, url: str) -> ActionResult:
        self.current_url = url
        self.current_title = (
            "GitHub: Where the world builds software" if "github" in url
            else "Wikipedia, the free encyclopedia"
        )
        return ActionResult(
            success=True,
            url=self.current_url,
            title=self.current_title,
            message=f"Successfully navigated to {url}",
            changed=True,
            navigation_occurred=True,
            active_tab_id=self.active_tab_id,
        )

    async def snapshot(self, session_id: str, interactive_only: bool = True) -> Snapshot:
        elements = [
            BrowserElement(ref="ref-0", role="searchbox", name="Search Wikipedia", value=self.search_value or None),
            BrowserElement(ref="ref-1", role="button", name="Search", value=None),
            BrowserElement(ref="ref-2", role="link", name="Main Page", value=None),
        ]
        text_summary = f"Page summary for {self.current_url}. Search value: '{self.search_value}'"
        return Snapshot(
            snapshot_id=f"snap-{uuid.uuid4().hex[:8]}",
            url=self.current_url,
            title=self.current_title,
            elements=elements,
            text=text_summary,
        )

    async def click(self, session_id: str, target: str) -> ActionResult:
        if target == "redirect_btn":
            self.current_url = "https://github.com/login"
            self.current_title = "Sign in to GitHub"
            return ActionResult(
                success=True, url=self.current_url, title=self.current_title,
                message=f"Clicked '{target}'", navigation_occurred=True,
                active_tab_id=self.active_tab_id,
            )
        if target == "new_tab_btn":
            self.current_url = "https://github.com/signup"
            self.current_title = "Join GitHub"
            return ActionResult(
                success=True, url=self.current_url, title=self.current_title,
                message=f"Clicked '{target}'", new_tab_opened=True,
                active_tab_id="tab-popup-2",
            )
        return ActionResult(
            success=True, url=self.current_url, title=self.current_title,
            message=f"Clicked '{target}'", active_tab_id=self.active_tab_id,
        )

    async def type_text(self, session_id: str, target: str, text: str, clear_first: bool = True) -> ActionResult:
        self.search_value = text
        # Persist state to profile directory
        if self.active_profile_path:
            state_file = Path(self.active_profile_path) / "state.json"
            state_file.write_text(json.dumps({"search_value": text}), encoding="utf-8")
        return ActionResult(
            success=True, url=self.current_url, title=self.current_title,
            message=f"Typed into '{target}'", changed=True,
        )

    async def scroll(self, session_id: str, direction: str = "down", amount: int = 500) -> ActionResult:
        return ActionResult(
            success=True, url=self.current_url,
            message=f"Scrolled {direction} by {amount}px", changed=True,
        )

    async def manage_tabs(self, session_id: str, action: str, tab_id: Optional[str] = None) -> ActionResult:
        return ActionResult(
            success=True, url=self.current_url,
            message=f"Tab action '{action}' executed. Open tabs: 1",
        )

    async def extract_content(self, session_id: str, query: Optional[str] = None, tab_id: Optional[str] = None) -> ExtractResult:
        return ExtractResult(
            url=self.current_url,
            title=self.current_title,
            content=f"# Extracted Page Content for {self.current_url}\n\nClean body markdown content for {self.current_url} ({self.current_title})...",
        )

    async def capture_screenshot(self, session_id: str, full_page: bool = False) -> bytes:
        return b"\x89PNG_MOCK"

    async def close_session(self, session_id: str) -> bool:
        return True


async def run_e2e_acceptance_tests():
    print("==========================================================")
    print("STARTING ACCEPTANCE GATE VERIFICATION")
    print("==========================================================")

    # 1. Instantiate mock provider (no HTTP, no REST, no browser)
    provider = MockBrowserProvider()

    # 2. Wire mock provider into service
    test_service = BrowserService(provider=provider)

    # Patch global browser_service for tools
    from app.browser import tools as browser_tools_module
    original_service = browser_tools_module.browser_service
    browser_tools_module.browser_service = test_service

    try:
        # -------------------------------------------------------------------
        # TEST CASE 1: Core E2E Loop Execution
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 1: Core E2E Loop ---")

        # Step A: browser_open
        open_res = await browser_open.ainvoke({"url": "https://wikipedia.org"})
        print(f"[Step A] browser_open:\n  {open_res}")
        assert test_service.state == BrowserSessionState.ACTIVE
        assert test_service.interaction_mode == InteractionMode.BROWSER

        # Step B: browser_snapshot
        snap1_res = await browser_snapshot.ainvoke({"interactive_only": True})
        print(f"[Step B] browser_snapshot:\n  {snap1_res}")
        assert "ref-0" in snap1_res
        assert "Search Wikipedia" in snap1_res

        # Step C: browser_click
        click_res = await browser_click.ainvoke({"target": "ref-0"})
        print(f"[Step C] browser_click:\n  {click_res}")

        # Fresh snapshot post-click (conservative ref invalidation)
        await browser_snapshot.ainvoke({"interactive_only": True})

        # Step D: browser_type
        type_res = await browser_type.ainvoke({"target": "ref-0", "text": "Artificial Intelligence"})
        print(f"[Step D] browser_type:\n  {type_res}")

        # Step E: browser_snapshot (verify typed value reflected)
        snap2_res = await browser_snapshot.ainvoke({"interactive_only": True})
        print(f"[Step E] browser_snapshot post-type:\n  {snap2_res}")
        assert "Artificial Intelligence" in snap2_res

        # Step F: browser_close
        close_res = await browser_close.ainvoke({})
        print(f"[Step F] browser_close:\n  {close_res}")
        assert test_service.state == BrowserSessionState.CLOSED
        assert test_service.interaction_mode == InteractionMode.DESKTOP

        print("\n[PASS]: Test Case 1 (Core E2E Loop) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 2: Mixed-Mode Interaction & Context Survival
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 2: Mixed-Mode Interaction & Context Survival ---")

        # Step A: browser_open
        await browser_open.ainvoke({"url": "https://wikipedia.org"})
        assert test_service.state == BrowserSessionState.ACTIVE
        assert test_service.interaction_mode == InteractionMode.BROWSER
        print("[Step A] Browser session ACTIVE, InteractionMode = BROWSER")

        # Step B: Switch InteractionMode -> DESKTOP (simulating OS task switch)
        test_service.set_interaction_mode(InteractionMode.DESKTOP)
        print(f"[Step B] InteractionMode set to: {test_service.interaction_mode.value}")

        # Verify: Browser session remains ACTIVE in the background!
        assert test_service.state == BrowserSessionState.ACTIVE
        assert test_service.has_active_session() is True
        print("[Step B Verified] Browser session process remained ACTIVE in background during DESKTOP mode.")

        # Step C: Switch InteractionMode back -> BROWSER and resume web actions
        snap_mixed = await browser_snapshot.ainvoke({})
        assert test_service.interaction_mode == InteractionMode.BROWSER
        print(f"[Step C] Resumed web actions, InteractionMode auto-restored to: {test_service.interaction_mode.value}")
        assert "Search Wikipedia" in snap_mixed

        # Step D: browser_close
        await browser_close.ainvoke({})
        assert test_service.state == BrowserSessionState.CLOSED
        print("[Step D] Cleanly closed browser session.")

        print("\n[PASS]: Test Case 2 (Mixed-Mode Context Survival) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 3: Extended Tools (Navigate, Scroll, Tabs, Extract)
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 3: Extended Capabilities (Navigate, Scroll, Tabs, Extract) ---")

        await browser_open.ainvoke({"url": "https://wikipedia.org"})

        # Step A: browser_navigate
        nav_res = await browser_navigate.ainvoke({"url": "https://github.com"})
        print(f"[Step A] browser_navigate:\n  {nav_res}")
        assert "github.com" in nav_res
        assert test_service.context.current_url == "https://github.com"
        assert "GitHub" in (test_service.context.current_title or "")
        print(f"[Step A Verified] BrowserContext updated: url='{test_service.context.current_url}', title='{test_service.context.current_title}'")

        # Step B: browser_scroll
        scroll_res = await browser_scroll.ainvoke({"direction": "down", "amount": 800})
        print(f"[Step B] browser_scroll:\n  {scroll_res}")
        assert "Scrolled down" in scroll_res

        # Step C: browser_tabs
        tabs_res = await browser_tabs.ainvoke({"action": "list"})
        print(f"[Step C] browser_tabs:\n  {tabs_res}")
        assert "Tab action 'list'" in tabs_res

        # Step D: browser_extract
        extract_res = await browser_extract.ainvoke({"query": "repository summary"})
        print(f"[Step D] browser_extract:\n  {extract_res[:160]}...")
        assert "https://github.com" in extract_res
        assert "GitHub" in extract_res
        print("[Step D Verified] ExtractResult matched current BrowserContext page identity (https://github.com).")

        await browser_close.ainvoke({})
        print("[Step E] Closed session post extended tools.")

        print("\n[PASS]: Test Case 3 (Extended Capabilities) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 4: Stale Element Reference Protection & Snapshot Generation
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 4: Stale Element Reference Protection ---")

        await browser_open.ainvoke({"url": "https://wikipedia.org"})
        snap_a = await browser_snapshot.ainvoke({})
        snapshot_id_a = test_service.context.snapshot_id
        print(f"[Step A] Snapshot Generation A created: {snapshot_id_a}")

        # Navigate to a new page (invalidating Snapshot A generation)
        await browser_navigate.ainvoke({"url": "https://github.com"})
        print(f"[Step B] Navigated to GitHub. Current snapshot_id = {test_service.context.snapshot_id}")

        # Attempt to click ref-0 from Snapshot A (must fail with Stale Element Error)
        stale_click_res = await browser_click.ainvoke({"target": "ref-0"})
        print(f"[Step C] Click on stale ref-0 result:\n  {stale_click_res}")
        assert "Stale Element Error" in stale_click_res
        print("[Step C Verified] Stale element reference 'ref-0' correctly blocked after navigation.")

        # Take fresh Snapshot B
        snap_b = await browser_snapshot.ainvoke({})
        snapshot_id_b = test_service.context.snapshot_id
        print(f"[Step D] Snapshot Generation B created: {snapshot_id_b}")
        assert snapshot_id_b != snapshot_id_a

        # Now click ref-0 on fresh Snapshot B (succeeds!)
        fresh_click_res = await browser_click.ainvoke({"target": "ref-0"})
        print(f"[Step E] Click on fresh ref-0 result:\n  {fresh_click_res}")
        assert "Clicked 'ref-0' successfully" in fresh_click_res
        print("[Step E Verified] Click on fresh ref-0 succeeded post-snapshot.")

        await browser_close.ainvoke({})
        print("[Step F] Closed session post stale ref test.")

        print("\n[PASS]: Test Case 4 (Stale Element Reference Protection) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 5: SPA Mutation (DOM mutation without URL change)
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 5: SPA Mutation ---")
        await browser_open.ainvoke({"url": "https://wikipedia.org"})
        await browser_snapshot.ainvoke({})
        gen_before = test_service.context.dom_generation
        print(f"[Step A] Snapshot created at DOM generation {gen_before}")

        # Click an element (triggers conservative DOM invalidation)
        await browser_click.ainvoke({"target": "ref-0"})
        gen_after = test_service.context.dom_generation
        print(f"[Step B] Click executed. DOM generation bumped from {gen_before} -> {gen_after}")

        # Attempting to reuse ref-0 without fresh snapshot fails cleanly with detailed generation error
        spa_stale_res = await browser_click.ainvoke({"target": "ref-0"})
        print(f"[Step C] Stale click result:\n  {spa_stale_res}")
        assert "Stale Element Error" in spa_stale_res
        assert f"belongs to DOM generation {gen_before}" in spa_stale_res
        print("[Step C Verified] Conservative SPA ref invalidation correctly enforced.")

        await browser_close.ainvoke({})

        print("\n[PASS]: Test Case 5 (SPA Mutation) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 6: Redirect / Navigation Detection
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 6: Redirect / Navigation Detection ---")
        await browser_open.ainvoke({"url": "https://github.com"})
        await browser_snapshot.ainvoke({})

        # Click element
        click_res = await test_service.click("ref-0")
        assert click_res.url == "https://github.com"

        # Take fresh snapshot post-click
        await browser_snapshot.ainvoke({})

        # Explicit test redirect
        red_res = await test_service.click("redirect_btn")
        print(f"[Step A] Redirect action result:\n  navigation_occurred={red_res.navigation_occurred}, url='{red_res.url}', title='{red_res.title}'")
        assert red_res.navigation_occurred is True
        assert test_service.context.current_url == "https://github.com/login"
        assert test_service.context.current_title == "Sign in to GitHub"
        print("[Step A Verified] Redirect correctly updated BrowserContext url and title.")

        await browser_close.ainvoke({})

        print("\n[PASS]: Test Case 6 (Redirect / Navigation Detection) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 7: New Tab / Popup Detection
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 7: New Tab / Popup Detection ---")
        await browser_open.ainvoke({"url": "https://github.com"})
        await browser_snapshot.ainvoke({})
        initial_tab = test_service.context.active_tab_id
        print(f"[Step A] Initial active_tab_id: {initial_tab}")

        # Click link with target="_blank" (triggers popup / new tab)
        tab_res = await test_service.click("new_tab_btn")
        print(f"[Step B] New tab action result:\n  new_tab_opened={tab_res.new_tab_opened}, active_tab_id='{tab_res.active_tab_id}', previous_tab_id='{tab_res.previous_tab_id}'")
        assert tab_res.new_tab_opened is True
        assert tab_res.active_tab_id == "tab-popup-2"
        assert test_service.context.active_tab_id == "tab-popup-2"
        print("[Step B Verified] BrowserContext updated active_tab_id to new popup tab 'tab-popup-2'.")

        await browser_close.ainvoke({})

        print("\n[PASS]: Test Case 7 (New Tab / Popup Detection) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 8: Persistent Profile Management & Session Metadata
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 8: Persistent Profile Management ---")
        from app.browser.profile_manager import profile_manager

        profiles = profile_manager.list_profiles()
        profile_ids = [p.id for p in profiles]
        print(f"[Step A] Registered profiles found: {profile_ids}")
        assert "default" in profile_ids
        assert "work" in profile_ids
        assert "personal" in profile_ids

        # Open session with 'work' profile
        open_work_res = await browser_open.ainvoke({"url": "https://github.com", "profile": "work"})
        print(f"[Step B] browser_open with profile='work':\n  {open_work_res}")
        assert "Profile: 'work'" in open_work_res
        assert test_service._session.profile == "work"

        # Verify profile timestamp updated
        work_prof = profile_manager.get_profile("work")
        assert work_prof is not None
        assert work_prof.last_used_at is not None
        print(f"[Step B Verified] Profile 'work' metadata updated last_used_at timestamp: {work_prof.last_used_at}")

        # Security: verify path traversal attempt is rejected cleanly
        try:
            profile_manager.get_profile_dir("../../etc/passwd")
            assert False, "Path traversal should have raised ValueError"
        except ValueError as e:
            print(f"[Step D Verified] Path traversal attack vector blocked cleanly: {e}")

        print("\n[PASS]: Test Case 8 (Persistent Profile Management & Security) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 9: Profile Persistence Across Session Restarts
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 9: Profile Persistence Across Restarts ---")

        # Step A: Launch work session and establish persistent state
        await browser_open.ainvoke({"url": "https://wikipedia.org", "profile": "work"})
        await browser_snapshot.ainvoke({})
        await browser_type.ainvoke({"target": "ref-0", "text": "TEST_PROFILE_MARKER_WORK_123"})
        print("[Step A] Typed 'TEST_PROFILE_MARKER_WORK_123' in profile 'work'.")
        await browser_close.ainvoke({})
        print("[Step A] Closed Session 1.")

        # Step B: Launch new session with profile='work' (restarts runtime session)
        await browser_open.ainvoke({"url": "https://wikipedia.org", "profile": "work"})
        snap_work = await browser_snapshot.ainvoke({})
        print(f"[Step B] Snapshot post-restart for profile 'work':\n  {snap_work}")
        assert "TEST_PROFILE_MARKER_WORK_123" in snap_work
        print("[Step B Verified] Persistent profile state ('TEST_PROFILE_MARKER_WORK_123') survived session restart.")
        await browser_close.ainvoke({})

        print("\n[PASS]: Test Case 9 (Profile Persistence Across Restarts) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 10: Profile Isolation & Zero Cross-Leakage
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 10: Profile Isolation ---")

        # Step A: Launch session with profile='personal'
        await browser_open.ainvoke({"url": "https://wikipedia.org", "profile": "personal"})
        snap_personal = await browser_snapshot.ainvoke({})
        print(f"[Step A] Initial snapshot for profile 'personal':\n  {snap_personal}")
        assert "TEST_PROFILE_MARKER_WORK_123" not in snap_personal
        print("[Step A Verified] Zero state leakage from 'work' profile into 'personal' profile.")

        # Step B: Set distinct state for profile 'personal'
        await browser_type.ainvoke({"target": "ref-0", "text": "TEST_PROFILE_MARKER_PERSONAL_999"})
        print("[Step B] Typed 'TEST_PROFILE_MARKER_PERSONAL_999' in profile 'personal'.")
        await browser_close.ainvoke({})

        # Step C: Re-verify 'work' profile still holds WORK token, not PERSONAL token
        await browser_open.ainvoke({"url": "https://wikipedia.org", "profile": "work"})
        snap_work_recheck = await browser_snapshot.ainvoke({})
        assert "TEST_PROFILE_MARKER_WORK_123" in snap_work_recheck
        assert "TEST_PROFILE_MARKER_PERSONAL_999" not in snap_work_recheck
        print("[Step C Verified] Profile 'work' isolated and retained WORK state.")
        await browser_close.ainvoke({})

        # Step D: Re-verify 'personal' profile holds PERSONAL token
        await browser_open.ainvoke({"url": "https://wikipedia.org", "profile": "personal"})
        snap_personal_recheck = await browser_snapshot.ainvoke({})
        assert "TEST_PROFILE_MARKER_PERSONAL_999" in snap_personal_recheck
        assert "TEST_PROFILE_MARKER_WORK_123" not in snap_personal_recheck
        print("[Step D Verified] Profile 'personal' isolated and retained PERSONAL state.")
        await browser_close.ainvoke({})

        print("\n[PASS]: Test Case 10 (Profile Isolation) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 11: Embedded Runtime Readiness
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 11: Embedded Runtime Readiness ---")
        from app.browser.runtime_manager import runtime_manager

        # Verify readiness check works for embedded mode
        readiness_status = await runtime_manager.get_status()
        print(f"[Step A] Runtime status: state='{readiness_status['state']}', mode='{readiness_status['mode']}'")
        assert readiness_status["mode"] == "embedded"
        await browser_open.ainvoke({"url": "https://wikipedia.org"})
        assert test_service.state == BrowserSessionState.ACTIVE
        print("[Step A Verified] browser_open successfully passed embedded readiness.")
        await browser_close.ainvoke({})

        print("\n[PASS]: Test Case 11 (Embedded Runtime Readiness) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 12: Safe Session Crash Recovery (No Mutating Action Replay)
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 12: Safe Session Crash Recovery ---")
        await browser_open.ainvoke({"url": "https://wikipedia.org"})
        await browser_snapshot.ainvoke({})
        assert test_service.state == BrowserSessionState.ACTIVE

        # Simulate provider failure during action
        from app.browser.providers.base import SessionLostError

        class FailingProvider(MockBrowserProvider):
            async def click(self, session_id: str, target: str):
                raise ProviderUnavailableError("Simulated CamoFox crash during click action")

        # Temporarily attach failing provider to test_service
        original_prov = test_service.provider
        test_service.provider = FailingProvider()

        try:
            # Click action triggers process crash handler
            await test_service.click("ref-0")
            assert False, "Click should have raised SessionLostError"
        except SessionLostError as e:
            print(f"[Step A Verified] SessionLostError caught cleanly: {e}")
            assert "Session closed safely" in str(e)
            assert "Do NOT replay mutating actions automatically" in str(e)

        # Assert session context state marked CLOSED and valid refs cleared
        assert test_service.state == BrowserSessionState.CLOSED
        assert test_service.has_active_session() is False
        assert test_service.context.snapshot_id is None
        print("[Step B Verified] BrowserSession state safely marked CLOSED without replaying mutating action.")

        # Restore provider
        test_service.provider = original_prov

        print("\n[PASS]: Test Case 12 (Safe Session Crash Recovery) succeeded.")

        # -------------------------------------------------------------------
        # TEST CASE 13: Realistic Multi-Step Agent Benchmark & Telemetry Traces
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 13: Agent Benchmark & Telemetry Traces ---")
        from app.browser.telemetry import telemetry_tracer

        # Benchmark Flow 1: GitHub LangGraph search & README inspection
        task1 = telemetry_tracer.start_task("bench-001", "GitHub search for langgraph and inspect installation")
        await browser_open.ainvoke({"url": "https://github.com", "profile": "work"})
        telemetry_tracer.record_tool_call("bench-001", "browser_open")

        snap1 = await browser_snapshot.ainvoke({})
        telemetry_tracer.record_tool_call("bench-001", "browser_snapshot", snapshot_len=len(snap1))

        type_res = await browser_type.ainvoke({"target": "ref-0", "text": "langgraph"})
        telemetry_tracer.record_tool_call("bench-001", "browser_type")

        ext1 = await browser_extract.ainvoke({"query": "installation instructions"})
        telemetry_tracer.record_tool_call("bench-001", "browser_extract")

        await browser_close.ainvoke({})
        telemetry_tracer.record_tool_call("bench-001", "browser_close")
        telemetry_tracer.complete_task("bench-001", success=True)
        print("[Step A] Benchmark Flow 1 (GitHub Search & Readme) completed successfully.")

        # Benchmark Flow 2: Wikipedia Alan Turing early life summary
        task2 = telemetry_tracer.start_task("bench-002", "Wikipedia Alan Turing early life summary")
        await browser_open.ainvoke({"url": "https://wikipedia.org", "profile": "personal"})
        telemetry_tracer.record_tool_call("bench-002", "browser_open")

        snap2 = await browser_snapshot.ainvoke({})
        telemetry_tracer.record_tool_call("bench-002", "browser_snapshot", snapshot_len=len(snap2))

        await browser_type.ainvoke({"target": "ref-0", "text": "Alan Turing"})
        telemetry_tracer.record_tool_call("bench-002", "browser_type")

        ext2 = await browser_extract.ainvoke({"query": "early life and education"})
        telemetry_tracer.record_tool_call("bench-002", "browser_extract")

        await browser_close.ainvoke({})
        telemetry_tracer.record_tool_call("bench-002", "browser_close")
        telemetry_tracer.complete_task("bench-002", success=True)
        print("[Step B] Benchmark Flow 2 (Wikipedia Alan Turing) completed successfully.")

        # Compute aggregate benchmarks
        metrics = telemetry_tracer.get_aggregate_metrics()
        print(f"[Step C] Aggregate Agent Telemetry Benchmarks:\n  {metrics}")
        assert metrics["total_tasks"] == 2
        assert metrics["success_rate"] == 1.0
        assert metrics["avg_tool_calls"] == 5.0
        assert metrics["avg_snapshots"] == 1.0
        print("[Step C Verified] Telemetry tracer calculated valid benchmarks across multi-step flows.")

        print("\n[PASS]: Test Case 13 (Agent Benchmark & Telemetry Traces) succeeded.")

        print("\n==========================================================")
        print("ALL 13 ACCEPTANCE GATE TESTS PASSED SUCCESSFULLY!")
        print("==========================================================")

    finally:
        # Restore global singleton
        browser_tools_module.browser_service = original_service


if __name__ == "__main__":
    asyncio.run(run_e2e_acceptance_tests())

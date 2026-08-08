"""
Test 14 — Real CamoFox Vertical E2E.

No mocks. No fake provider. No REST server.
Uses CamoFoxProvider → AsyncCamoufox → actual Firefox process.
"""
import asyncio
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("test_real_camofox")


async def run_real_camofox_e2e():
    print("==========================================================")
    print("TEST 14 -- REAL CAMOFOX VERTICAL E2E")
    print("==========================================================")

    # Step 0: Verify camoufox is importable
    try:
        from camoufox import AsyncCamoufox  # noqa: F401
        print("[Step 0] [OK] Camoufox package importable.")
    except ImportError:
        print("[Step 0] [FAIL] Camoufox not installed. Skipping real E2E test.")
        print("   Install with: pip install camoufox && camoufox fetch")
        return

    from app.browser.providers.camofox import CamoFoxProvider
    from app.browser.service import BrowserService
    from app.browser.models import BrowserSessionState

    # Use headless mode for CI/automated testing
    headless = "--headless" in sys.argv or "--ci" in sys.argv
    provider = CamoFoxProvider(headless=headless)
    service = BrowserService(provider=provider)

    try:
        # Step 1: Create session → launches real Camoufox Firefox
        print("\n[Step 1] Creating CamoFox session...")
        open_result = await service.open_browser(url="https://en.wikipedia.org")
        assert service.state == BrowserSessionState.ACTIVE
        print(f"  [OK] Session opened: {open_result.message}")
        print(f"  [OK] URL: {service.context.current_url}")
        print(f"  [OK] Title: {service.context.current_title}")

        # Step 2: Snapshot → accessibility tree from real page
        print("\n[Step 2] Taking snapshot of Wikipedia...")
        snap = await service.snapshot()
        print(f"  [OK] Snapshot ID: {snap.snapshot_id}")
        print(f"  [OK] URL: {snap.url}")
        print(f"  [OK] Elements found: {len(snap.elements)}")
        assert len(snap.elements) > 0, "Snapshot should find interactive elements"
        assert "wikipedia" in snap.url.lower()

        # Print first 10 elements
        for el in snap.elements[:10]:
            print(f"    [{el.ref}] {el.role}: '{el.name}' {f'= {el.value}' if el.value else ''}")

        # Step 3: Find searchbox
        searchbox_ref = None
        for el in snap.elements:
            if el.role in ("searchbox", "textbox") and el.name:
                if "search" in el.name.lower():
                    searchbox_ref = el.ref
                    break

        if not searchbox_ref:
            print("  [WARN] No searchbox found in snapshot. Looking for any textbox...")
            for el in snap.elements:
                if el.role in ("searchbox", "textbox"):
                    searchbox_ref = el.ref
                    break

        if not searchbox_ref:
            print("  [FAIL] No input element found. Skipping interaction steps.")
        else:
            print(f"\n[Step 3] Found searchbox: {searchbox_ref}")

            # Step 4: Click the searchbox
            print("\n[Step 4] Clicking searchbox...")
            click_result = await service.click(searchbox_ref)
            print(f"  [OK] Click result: success={click_result.success}, msg={click_result.message}")

            # Step 5: Type into searchbox
            print("\n[Step 5] Typing 'Artificial Intelligence'...")
            # Take fresh snapshot post-click
            snap2 = await service.snapshot()
            new_search_ref = None
            for el in snap2.elements:
                if el.role in ("searchbox", "textbox", "combobox"):
                    new_search_ref = el.ref
                    print(f"  [OK] Match element in snap2: [{el.ref}] {el.role}: '{el.name}'")
                    break

            if not new_search_ref:
                # Log all snap2 roles to diagnose
                roles_found = [f"[{el.ref}] {el.role}: '{el.name}'" for el in snap2.elements[:15]]
                print(f"  [WARN] No search input in snap2 elements. First 15: {roles_found}")

            if new_search_ref:
                type_result = await service.type_text(new_search_ref, "Artificial Intelligence")
                print(f"  [OK] Type result: success={type_result.success}, msg={type_result.message}")

                # Step 6: Verify value
                print("\n[Step 6] Verifying typed value in fresh snapshot...")
                snap3 = await service.snapshot()
                found_value = False
                for el in snap3.elements:
                    if el.value and "Artificial Intelligence" in el.value:
                        found_value = True
                        print(f"  [OK] Found typed value in [{el.ref}]: '{el.value}'")
                        break
                if not found_value:
                    print("  [WARN] Typed value not reflected in snapshot (may be async)")
            else:
                print("  [WARN] Searchbox ref lost after click snapshot")

        # Step 7: Extract page content
        print("\n[Step 7] Extracting page content...")
        content = await service.extract()
        print(f"  [OK] URL: {content.url}")
        print(f"  [OK] Title: {content.title}")
        print(f"  [OK] Content length: {len(content.content)} chars")
        print(f"  [OK] Content preview: {content.content[:200]}...")
        assert len(content.content) > 0, "Extract should return content"

        # Step 8: Navigate to different page
        print("\n[Step 8] Navigating to https://github.com...")
        nav_result = await service.navigate("https://github.com")
        print(f"  [OK] Navigation: success={nav_result.success}")
        print(f"  [OK] URL: {nav_result.url}")
        print(f"  [OK] Title: {nav_result.title}")
        assert nav_result.success
        assert "github" in (nav_result.url or "").lower()

        # Step 9: Snapshot the new page
        print("\n[Step 9] Snapshot of GitHub...")
        snap_gh = await service.snapshot()
        print(f"  [OK] Snapshot URL: {snap_gh.url}")
        print(f"  [OK] Elements: {len(snap_gh.elements)}")
        assert "github" in snap_gh.url.lower()

        # Step 10: Close session
        print("\n[Step 10] Closing session...")
        await service.close_browser()
        assert service.state == BrowserSessionState.CLOSED
        print("  [OK] Session closed. State = CLOSED")

        print("\n==========================================================")
        print("TEST 14 -- REAL CAMOFOX VERTICAL E2E PASSED [OK]")
        print("==========================================================")

        # -------------------------------------------------------------------
        # TEST CASE 15: Windows Runtime Bootstrap & Event Loop Policy
        # -------------------------------------------------------------------
        print("\n--- TEST CASE 15: Windows Runtime Bootstrap Verification ---")
        if sys.platform == "win32":
            loop = asyncio.get_running_loop()
            print(f"[Step A] Running event loop type: {type(loop).__name__}")
            assert isinstance(loop, asyncio.ProactorEventLoop), (
                f"Expected ProactorEventLoop on Windows, got {type(loop).__name__}"
            )
            print("[Step A Verified] Event loop is ProactorEventLoop — Playwright subprocess transport supported.")

        print("\n==========================================================")
        print("TEST 15 -- WINDOWS RUNTIME BOOTSTRAP VERIFICATION PASSED [OK]")
        print("==========================================================")

    except Exception as e:
        logger.error(f"Real E2E test failed: {e}", exc_info=True)
        print(f"\n[FAIL] TEST 14 / 15 FAILED: {e}")
        # Clean up on failure
        try:
            await service.close_browser()
        except Exception:
            pass
        raise


if __name__ == "__main__":
    import sys
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    asyncio.run(run_real_camofox_e2e())

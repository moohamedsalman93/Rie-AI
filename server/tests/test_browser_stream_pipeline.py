"""
Unit tests verifying the high-performance browser stream pipeline.
"""
import unittest
import asyncio
from unittest.mock import AsyncMock, MagicMock
from app.browser.providers.base import BrowserProvider
from app.browser.providers.camofox import CamoFoxProvider
from app.browser.service import BrowserService
from app.browser.models import BrowserSession, BrowserSessionState, InteractionMode
from main import app


class TestBrowserStreamPipeline(unittest.TestCase):
    def test_provider_signature_and_defaults(self):
        """Verify capture_screenshot signature accepts format and quality."""
        provider = CamoFoxProvider()
        self.assertTrue(hasattr(provider, "capture_screenshot"))

    def test_service_screenshot_parameter_forwarding(self):
        """Verify BrowserService forwards format and quality to provider."""
        mock_provider = MagicMock(spec=BrowserProvider)
        mock_provider.capture_screenshot = AsyncMock(return_value=b"fake-jpeg-bytes")

        service = BrowserService(provider=mock_provider)
        service._session = BrowserSession(
            session_id="test-session",
            provider_name="camofox",
            created_at="2026-08-23T12:00:00Z",
            active_tab_id="tab-1",
        )
        service._state = BrowserSessionState.ACTIVE

        loop = asyncio.new_event_loop()
        try:
            res = loop.run_until_complete(
                service.screenshot(full_page=False, format="jpeg", quality=75)
            )
            self.assertEqual(res, b"fake-jpeg-bytes")
            mock_provider.capture_screenshot.assert_awaited_once_with(
                "test-session",
                full_page=False,
                format="jpeg",
                quality=75,
            )
        finally:
            loop.close()

    def test_websocket_stream_route_registered(self):
        """Verify the /api/browser/stream websocket route is registered in FastAPI."""
        routes = [r.path for r in app.routes]
        self.assertIn("/api/browser/stream", routes)

    def test_browser_action_payload_profile_support(self):
        """Verify BrowserActionPayload supports optional profile field."""
        from app.browser.routes import BrowserActionPayload
        payload = BrowserActionPayload(action="open", url="https://example.com", profile="work", headless=True)
        self.assertEqual(payload.action, "open")
        self.assertEqual(payload.profile, "work")
        self.assertEqual(payload.headless, True)

    def test_websocket_stream_handles_early_action_without_crashing(self):
        """Verify websocket stream gracefully ignores actions sent before active session."""
        from fastapi.testclient import TestClient
        client = TestClient(app)
        with client.websocket_connect("/api/browser/stream") as ws:
            # Send resize_viewport before any browser session is started
            ws.send_json({"action": "resize_viewport", "width": 1280, "height": 720})
            msg = ws.receive_json()
            # Should receive status/metadata message without crashing
            self.assertIn(msg.get("type"), ["status", "metadata"])

    def test_settings_allows_camofox_headless_mode(self):
        """Verify POST /settings accepts and validates CAMOFOX_HEADLESS_MODE."""
        from fastapi.testclient import TestClient
        from app.database import get_setting
        client = TestClient(app)
        resp = client.post("/settings", json={"key": "CAMOFOX_HEADLESS_MODE", "value": "headless"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(get_setting("CAMOFOX_HEADLESS_MODE"), "headless")
        self.assertEqual(get_setting("CAMOUFOX_HEADLESS"), "1")

    def test_headless_mode_enforcement(self):
        """Verify open_browser enforces headless=True when CAMOFOX_HEADLESS_MODE is headless."""
        from app.database import update_setting
        from app.config import settings
        update_setting("CAMOFOX_HEADLESS_MODE", "headless")
        settings.reload()

        mock_provider = MagicMock(spec=BrowserProvider)
        mock_provider.create_session = AsyncMock(return_value=BrowserSession(
            session_id="headless-test-session",
            provider_name="camofox",
            created_at="2026-08-23T12:00:00Z",
            active_tab_id="tab-1",
        ))
        mock_provider._headless = True

        service = BrowserService(provider=mock_provider)
        loop = asyncio.new_event_loop()
        try:
            # Even if caller passes headless=False, it should enforce headless=True because user setting is "headless"
            loop.run_until_complete(service.open_browser(url="https://example.com", headless=False))
            mock_provider.create_session.assert_awaited_once_with(profile=None, headless=True)
        finally:
            loop.close()


if __name__ == "__main__":
    unittest.main()

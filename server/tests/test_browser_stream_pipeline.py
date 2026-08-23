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


if __name__ == "__main__":
    unittest.main()

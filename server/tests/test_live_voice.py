"""
Unit test suite for Gemini 2.0 Live Voice WebSocket and endpoints.
"""
import unittest
from fastapi.testclient import TestClient
from main import app
from app.live_voice import AVAILABLE_LIVE_VOICES, router as live_voice_router


class TestLiveVoice(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_routes_registered(self):
        """Verify live voice routes are registered in FastAPI."""
        routes = [r.path for r in app.routes]
        self.assertIn("/audio/live-voices", routes)
        self.assertIn("/ws/voice-live", routes)

    def test_get_live_voices_endpoint(self):
        """Verify /audio/live-voices returns available voice personas."""
        response = self.client.get("/audio/live-voices")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("voices", data)
        self.assertEqual(len(data["voices"]), len(AVAILABLE_LIVE_VOICES))
        voice_ids = [v["id"] for v in data["voices"]]
        self.assertIn("Aoede", voice_ids)
        self.assertIn("Kore", voice_ids)
        self.assertIn("Puck", voice_ids)
        self.assertIn("Charon", voice_ids)
        self.assertIn("Fenrir", voice_ids)

    def test_websocket_missing_key_behavior(self):
        """Verify WebSocket handles missing or placeholder key gracefully."""
        from app.config import settings
        orig_key = settings._settings.get("GOOGLE_API_KEY")
        try:
            # Set to empty or placeholder
            settings._settings["GOOGLE_API_KEY"] = "your_gemini_api_key_here"
            with self.client.websocket_connect("/ws/voice-live") as ws:
                msg = ws.receive_json()
                self.assertEqual(msg.get("type"), "error")
                self.assertIn("Google API key", msg.get("message", ""))
        finally:
            if orig_key is not None:
                settings._settings["GOOGLE_API_KEY"] = orig_key
            else:
                settings._settings.pop("GOOGLE_API_KEY", None)


if __name__ == "__main__":
    unittest.main()

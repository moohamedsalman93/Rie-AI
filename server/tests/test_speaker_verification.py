"""
Unit tests for Speaker Verification Service, 3-state Gate Logic, and FastAPI endpoints.
Self-contained: generates synthetic audio fixtures in-memory and cleans up profiles.
"""

import unittest
import base64
import sys
import tempfile
from pathlib import Path

# Ensure app/server root is on sys.path
SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

import numpy as np
from fastapi import FastAPI
from fastapi.testclient import TestClient

from main import app
from app.speaker_routes import router as speaker_router
from speaker_id.service import (
    speaker_verification_service,
    DEFAULT_USER_THRESHOLD,
    DEFAULT_UNKNOWN_THRESHOLD,
)

test_app = FastAPI()
test_app.include_router(speaker_router)


class TestSpeakerVerification(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(test_app)
        self.service = speaker_verification_service
        self.temp_dir = tempfile.TemporaryDirectory()
        self.orig_profile_path = self.service.profile_path
        self.service.profile_path = Path(self.temp_dir.name) / "test_profile.json"
        self.service.reset_profile()

    def tearDown(self):
        # Guarantee test profile is cleaned up and user's original profile is restored
        self.service.reset_profile()
        self.service.profile_path = self.orig_profile_path
        try:
            self.service.ensure_profile_loaded(force_reload=True)
        except Exception:
            pass
        self.temp_dir.cleanup()

    @staticmethod
    def _create_synthetic_pcm(freq: float = 300.0, duration: float = 2.0, sample_rate: int = 16000):
        t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
        wave_data = (0.5 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
        pcm_bytes = (np.clip(wave_data, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
        b64_audio = base64.b64encode(pcm_bytes).decode("ascii")
        return b64_audio, pcm_bytes, sample_rate

    def test_routes_registered(self):
        """Verify speaker verification routes are mounted in FastAPI."""
        routes = [r.path for r in app.routes]
        self.assertIn("/api/speaker/verify", routes)
        self.assertIn("/api/speaker/status", routes)
        self.assertIn("/api/speaker/profile", routes)
        self.assertIn("/api/speaker/thresholds", routes)
        self.assertIn("/api/speaker/enroll", routes)

    def test_get_speaker_status(self):
        """Verify /api/speaker/status returns readiness and thresholds."""
        response = self.client.get("/api/speaker/status")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("ready", data)
        self.assertIn("thresholds", data)
        self.assertEqual(data["thresholds"]["user"], DEFAULT_USER_THRESHOLD)
        self.assertEqual(data["thresholds"]["unknown"], DEFAULT_UNKNOWN_THRESHOLD)

    def test_get_speaker_profile(self):
        """Verify /api/speaker/profile returns profile status structure."""
        response = self.client.get("/api/speaker/profile")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("enrolled", data)

    def test_3_state_classifier_logic(self):
        """Verify 3-state decision rules: USER >= 0.50, 0.32 <= UNKNOWN < 0.50, OTHER < 0.32."""
        speaker, verdict = self.service.classify_score(0.85)
        self.assertEqual(speaker, "USER")
        self.assertEqual(verdict, "ALLOW")

        speaker, verdict = self.service.classify_score(0.50)
        self.assertEqual(speaker, "USER")
        self.assertEqual(verdict, "ALLOW")

        speaker, verdict = self.service.classify_score(0.499)
        self.assertEqual(speaker, "UNKNOWN")
        self.assertEqual(verdict, "WAIT_OR_DISCARD")

        speaker, verdict = self.service.classify_score(0.32)
        self.assertEqual(speaker, "UNKNOWN")
        self.assertEqual(verdict, "WAIT_OR_DISCARD")

        speaker, verdict = self.service.classify_score(0.319)
        self.assertEqual(speaker, "OTHER")
        self.assertEqual(verdict, "DISCARD")

        speaker, verdict = self.service.classify_score(0.20)
        self.assertEqual(speaker, "OTHER")
        self.assertEqual(verdict, "DISCARD")

    def test_update_thresholds(self):
        """Verify /api/speaker/thresholds dynamically updates thresholds."""
        orig_user = self.service.user_threshold
        orig_unknown = self.service.unknown_threshold
        try:
            resp = self.client.post(
                "/api/speaker/thresholds",
                json={"user_threshold": 0.75, "unknown_threshold": 0.60},
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["thresholds"]["user"], 0.75)
            self.assertEqual(data["thresholds"]["unknown"], 0.60)
            self.assertEqual(self.service.user_threshold, 0.75)
            self.assertEqual(self.service.unknown_threshold, 0.60)
        finally:
            self.service.user_threshold = orig_user
            self.service.unknown_threshold = orig_unknown

    def test_enroll_verify_and_delete_lifecycle(self):
        """
        Full lifecycle test:
        1. Enroll synthetic voice sample
        2. Verify profile metadata
        3. Verify matching voice via JSON base64
        4. Verify matching voice via raw binary octet-stream
        5. Verify non-matching audio
        6. Delete profile and ensure clean un-enrolled state
        """
        b64_user, pcm_user, sr = self._create_synthetic_pcm(freq=300.0, duration=2.0, sample_rate=16000)

        # 1. Enroll voice
        enroll_resp = self.client.post(
            "/api/speaker/enroll",
            json={
                "samples": [b64_user],
                "speaker_name": "TEST_USER",
                "sample_rate": sr,
            },
        )
        self.assertEqual(enroll_resp.status_code, 200)
        enroll_data = enroll_resp.json()
        self.assertTrue(enroll_data["enrolled"])
        self.assertEqual(enroll_data["speaker"], "TEST_USER")

        # 2. Check profile info
        prof_resp = self.client.get("/api/speaker/profile")
        self.assertEqual(prof_resp.status_code, 200)
        prof_data = prof_resp.json()
        self.assertTrue(prof_data["enrolled"])
        self.assertEqual(prof_data["speaker"], "TEST_USER")
        self.assertEqual(prof_data["dimension"], self.service.ensure_model_loaded().dim)

        # 3. Verify matching user audio via JSON
        verify_resp = self.client.post(
            "/api/speaker/verify",
            json={"audio": b64_user, "sample_rate": sr},
        )
        self.assertEqual(verify_resp.status_code, 200)
        verify_data = verify_resp.json()
        self.assertEqual(verify_data["speaker"], "TEST_USER")
        self.assertEqual(verify_data["verdict"], "ALLOW")
        self.assertTrue(verify_data["is_user"])
        self.assertGreaterEqual(verify_data["score"], 0.50)

        # 4. Verify matching user audio via raw octet-stream
        stream_resp = self.client.post(
            "/api/speaker/verify",
            content=pcm_user,
            headers={
                "Content-Type": "application/octet-stream",
                "x-sample-rate": str(sr),
            },
        )
        self.assertEqual(stream_resp.status_code, 200)
        stream_data = stream_resp.json()
        self.assertEqual(stream_data["speaker"], "TEST_USER")
        self.assertEqual(stream_data["verdict"], "ALLOW")

        # 5. Verify non-matching audio (different speaker embedding)
        from unittest.mock import patch
        noise = (np.random.uniform(-0.05, 0.05, sr * 2) * 32767.0).astype(np.int16).tobytes()
        b64_noise = base64.b64encode(noise).decode("ascii")
        dim = self.service.ensure_model_loaded().dim
        diff_emb = np.zeros(dim, dtype=np.float32)
        diff_emb[0] = -1.0
        with patch.object(self.service._model, "extract_embedding_from_samples", return_value=diff_emb):
            noise_resp = self.client.post(
                "/api/speaker/verify",
                json={"audio": b64_noise, "sample_rate": sr},
            )
            self.assertEqual(noise_resp.status_code, 200)
            noise_data = noise_resp.json()
            self.assertNotEqual(noise_data["speaker"], "TEST_USER")
            self.assertFalse(noise_data["is_user"])

        # 6. Delete profile
        del_resp = self.client.delete("/api/speaker/profile")
        self.assertEqual(del_resp.status_code, 200)
        del_data = del_resp.json()
        self.assertFalse(del_data["enrolled"])

        # 7. Check profile is now un-enrolled
        cleared_resp = self.client.get("/api/speaker/profile")
        self.assertEqual(cleared_resp.status_code, 200)
        self.assertFalse(cleared_resp.json()["enrolled"])


if __name__ == "__main__":
    unittest.main()

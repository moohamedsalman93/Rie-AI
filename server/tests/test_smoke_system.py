"""
Smoke test suite ensuring full system integrity and module health.
"""
import unittest
from app.database import init_db, is_db_ready, prune_stale_checkpoints, vacuum_checkpoint_db
from app.agent_modules.key_rotator import KeyRotator
from app.security import verify_app_token, PEER_AUTH_EXEMPT_PATHS
from app.windows_tools import WINDOWS_TOOLS
from app.routes import router
from main import app

class TestSmokeSystem(unittest.TestCase):
    def test_database_initialization_and_pruner(self):
        init_db()
        self.assertTrue(is_db_ready())
        res = prune_stale_checkpoints(keep_recent_threads=10)
        self.assertIn("status", res)

    def test_key_rotator_module(self):
        rotator = KeyRotator(["gsk_test1234567890", "gsk_test0987654321"], "groq")
        self.assertEqual(rotator.total_keys, 2)
        key1, idx1 = rotator.next_key()
        self.assertEqual(key1, "gsk_test1234567890")
        self.assertEqual(idx1, 0)
        key2, idx2 = rotator.next_key()
        self.assertEqual(key2, "gsk_test0987654321")
        self.assertEqual(idx2, 1)
        stats = rotator.stats()
        self.assertEqual(len(stats), 2)
        self.assertEqual(stats[0]["calls"], 1)
        self.assertEqual(stats[1]["calls"], 1)

    def test_security_exemptions(self):
        self.assertIn("/connectivity/peer/receive", PEER_AUTH_EXEMPT_PATHS)
        self.assertIn("/api/plugins/oauth/callback", PEER_AUTH_EXEMPT_PATHS)

    def test_fastapi_app_and_routes(self):
        self.assertIsNotNone(app)
        self.assertIsNotNone(router)
        self.assertGreater(len(WINDOWS_TOOLS), 0)

if __name__ == "__main__":
    unittest.main()

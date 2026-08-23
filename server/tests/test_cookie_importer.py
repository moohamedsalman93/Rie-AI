import unittest
import json
from app.browser.cookie_importer import CookieImporter, cookie_importer


class TestCookieImporter(unittest.TestCase):
    def test_supported_browsers_list(self):
        sources = cookie_importer.list_supported_browsers()
        self.assertIsInstance(sources, list)
        browser_ids = [s["id"] for s in sources]
        self.assertIn("chrome", browser_ids)
        self.assertIn("edge", browser_ids)
        self.assertIn("firefox", browser_ids)
        self.assertIn("brave", browser_ids)

    def test_normalize_cookie(self):
        raw = {
            "name": "session_token",
            "value": "xyz123",
            "domain": ".google.com",
            "path": "/",
            "expires": 1800000000,
            "http_only": True,
            "secure": True,
            "same_site": "no_restriction",
        }
        normalized = CookieImporter.normalize_cookie(raw)
        self.assertEqual(normalized["name"], "session_token")
        self.assertEqual(normalized["value"], "xyz123")
        self.assertEqual(normalized["domain"], ".google.com")
        self.assertEqual(normalized["sameSite"], "None")
        self.assertTrue(normalized["httpOnly"])
        self.assertTrue(normalized["secure"])

    def test_parse_cookie_json_array(self):
        raw_json = json.dumps([
            {"name": "c1", "value": "v1", "domain": "example.com"},
            {"name": "c2", "value": "v2", "domain": "test.org", "httpOnly": True},
        ])
        cookies = CookieImporter.parse_cookie_json(raw_json)
        self.assertEqual(len(cookies), 2)
        self.assertEqual(cookies[0]["name"], "c1")
        self.assertEqual(cookies[1]["name"], "c2")
        self.assertTrue(cookies[1]["httpOnly"])

    def test_parse_cookie_storage_state(self):
        storage_state = json.dumps({
            "cookies": [
                {"name": "auth_token", "value": "abc", "domain": "app.com"}
            ],
            "origins": []
        })
        cookies = CookieImporter.parse_cookie_json(storage_state)
        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0]["name"], "auth_token")


if __name__ == "__main__":
    unittest.main()

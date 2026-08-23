"""
Browser Cookie Extraction & Injection Subsystem for Camoufox.
Extracts cookies from local installed browsers (Chrome, Edge, Brave, Firefox, Opera, etc.)
or parses imported JSON/Netscape formats, and normalizes them for Playwright/Camoufox contexts.
"""
import json
import logging
from typing import List, Dict, Any, Optional

try:
    import rookiepy
    HAS_ROOKIEPY = True
except ImportError:
    HAS_ROOKIEPY = False

logger = logging.getLogger(__name__)


SUPPORTED_BROWSERS = [
    {"id": "chrome", "name": "Google Chrome", "icon": "chrome"},
    {"id": "edge", "name": "Microsoft Edge", "icon": "edge"},
    {"id": "brave", "name": "Brave Browser", "icon": "brave"},
    {"id": "firefox", "name": "Mozilla Firefox", "icon": "firefox"},
    {"id": "opera", "name": "Opera", "icon": "opera"},
    {"id": "opera_gx", "name": "Opera GX", "icon": "opera"},
    {"id": "vivaldi", "name": "Vivaldi", "icon": "globe"},
    {"id": "arc", "name": "Arc Browser", "icon": "compass"},
]


class CookieImporter:
    """Manages extraction and normalization of browser session cookies."""

    @staticmethod
    def list_supported_browsers() -> List[Dict[str, Any]]:
        """Return list of supported browser types."""
        return SUPPORTED_BROWSERS

    @staticmethod
    def normalize_cookie(c: Dict[str, Any]) -> Dict[str, Any]:
        """Normalize a cookie dict into Playwright's expected cookie format."""
        domain = c.get("domain") or c.get("host") or ""
        # Ensure domain starts without protocol
        if domain.startswith("http://"):
            domain = domain[7:]
        elif domain.startswith("https://"):
            domain = domain[8:]

        same_site_raw = c.get("same_site") or c.get("sameSite") or "Lax"
        if isinstance(same_site_raw, str):
            if same_site_raw.lower() in ("no_restriction", "none"):
                same_site = "None"
            elif same_site_raw.lower() == "strict":
                same_site = "Strict"
            else:
                same_site = "Lax"
        else:
            same_site = "Lax"

        expires = c.get("expires") or c.get("expiry") or -1
        try:
            expires_float = float(expires)
        except (ValueError, TypeError):
            expires_float = -1

        return {
            "name": str(c.get("name", "")),
            "value": str(c.get("value", "")),
            "domain": domain,
            "path": str(c.get("path") or "/"),
            "expires": expires_float,
            "httpOnly": bool(c.get("http_only", c.get("httpOnly", False))),
            "secure": bool(c.get("secure", False)),
            "sameSite": same_site,
        }

    @classmethod
    def extract_from_local_browser(
        cls,
        browser_id: str,
        domains: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Extract cookies from an installed browser on Windows using rookiepy.
        Returns {"success": bool, "cookies": list, "count": int, "error": str | None}
        """
        if not HAS_ROOKIEPY:
            return {
                "success": False,
                "cookies": [],
                "count": 0,
                "error": "rookiepy package is not installed on server.",
            }

        b_id = browser_id.lower().strip()
        fn = getattr(rookiepy, b_id, None)
        if not fn or not callable(fn):
            return {
                "success": False,
                "cookies": [],
                "count": 0,
                "error": f"Browser '{browser_id}' is not supported for auto-extraction.",
            }

        try:
            # Pass domain filter list if provided
            if domains and len(domains) > 0:
                raw_cookies = fn(domains=domains)
            else:
                raw_cookies = fn()

            normalized = []
            for c in raw_cookies:
                cookie_dict = dict(c) if not isinstance(c, dict) else c
                norm = cls.normalize_cookie(cookie_dict)
                if norm["name"] and norm["value"]:
                    normalized.append(norm)

            return {
                "success": True,
                "cookies": normalized,
                "count": len(normalized),
                "error": None,
            }
        except Exception as e:
            err_msg = str(e)
            if "appbound encryption" in err_msg.lower() or "v130" in err_msg.lower():
                err_msg = f"Chromium v130+ App-Bound Encryption: {browser_id.capitalize()} requires running Rie-AI as Administrator for auto-extraction. Alternatively, switch to the 'Paste Cookie JSON' tab to import in 1 click."
            logger.warning(f"Failed to extract cookies from {browser_id}: {err_msg}")
            return {
                "success": False,
                "cookies": [],
                "count": 0,
                "error": err_msg,
            }

    @classmethod
    def parse_cookie_json(cls, json_data: Any) -> List[Dict[str, Any]]:
        """
        Parse raw JSON string or list of cookies exported from Cookie-Editor,
        EditThisCookie, or Playwright storage state.
        """
        if isinstance(json_data, str):
            try:
                parsed = json.loads(json_data.strip())
            except Exception as e:
                raise ValueError(f"Invalid JSON format: {e}")
        else:
            parsed = json_data

        # Handle Playwright storage_state format {"cookies": [...], "origins": [...]}
        if isinstance(parsed, dict) and "cookies" in parsed:
            raw_list = parsed["cookies"]
        elif isinstance(parsed, list):
            raw_list = parsed
        else:
            raise ValueError("Expected a JSON array of cookies or a Playwright storage_state object.")

        normalized = []
        for item in raw_list:
            if isinstance(item, dict):
                norm = cls.normalize_cookie(item)
                if norm["name"]:
                    normalized.append(norm)

        return normalized


cookie_importer = CookieImporter()

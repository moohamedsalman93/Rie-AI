"""
BrowserProfileManager for Rie.
Manages persistent browser profiles (identities, cookies, localStorage) separately from active BrowserSessions.
"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Dict

from app.browser.models import BrowserProfile

logger = logging.getLogger(__name__)

DEFAULT_PROFILES_DIR = Path.home() / ".rie" / "profiles" / "camofox"


class BrowserProfileManager:
    """Manages persistent browser user profiles and directory resolution."""

    def __init__(self, profiles_dir: Optional[Path] = None):
        self.profiles_dir = profiles_dir or DEFAULT_PROFILES_DIR
        self.metadata_file = self.profiles_dir / "metadata.json"
        self._ensure_storage()

    def _ensure_storage(self) -> None:
        """Create profiles root directory and metadata registry if not existing."""
        try:
            self.profiles_dir.mkdir(parents=True, exist_ok=True)
            if not self.metadata_file.exists():
                default_registry = {
                    "default": {
                        "id": "default",
                        "name": "Default Profile",
                        "provider": "camofox",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "last_used_at": None,
                    },
                    "work": {
                        "id": "work",
                        "name": "Work Profile",
                        "provider": "camofox",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "last_used_at": None,
                    },
                    "personal": {
                        "id": "personal",
                        "name": "Personal Profile",
                        "provider": "camofox",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                        "last_used_at": None,
                    },
                }
                self._save_registry(default_registry)
                # Create profile subdirectories
                for pid in default_registry:
                    (self.profiles_dir / pid).mkdir(exist_ok=True)
        except Exception as e:
            logger.warning(f"Could not initialize profile directory at {self.profiles_dir}: {e}")

    def _load_registry(self) -> Dict[str, Dict]:
        if not self.metadata_file.exists():
            return {}
        try:
            with open(self.metadata_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            logger.warning(f"Failed loading profile registry: {e}")
            return {}

    def _save_registry(self, data: Dict[str, Dict]) -> None:
        try:
            with open(self.metadata_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.warning(f"Failed saving profile registry: {e}")

    def _sanitize_profile_id(self, profile_id: str) -> str:
        """Sanitize and validate profile ID, rejecting path traversal attempts."""
        if not profile_id or not isinstance(profile_id, str):
            raise ValueError("Profile identifier must be a non-empty string.")
        
        if "/" in profile_id or "\\" in profile_id or ".." in profile_id:
            raise ValueError(f"Security error: Invalid profile identifier '{profile_id}' contains path traversal characters.")
            
        import re
        clean_id = re.sub(r"[^a-zA-Z0-9_-]", "_", profile_id.strip().lower())
        
        # Verify resolved path stays strictly within profiles_dir
        target_path = (self.profiles_dir / clean_id).resolve()
        profiles_root = self.profiles_dir.resolve()
        if not str(target_path).startswith(str(profiles_root)):
            raise ValueError(f"Security error: Profile path '{target_path}' escapes profile root '{profiles_root}'.")
            
        return clean_id

    def list_profiles(self) -> List[BrowserProfile]:
        """List all available registered browser profiles."""
        registry = self._load_registry()
        profiles: List[BrowserProfile] = []
        for pid, pdata in registry.items():
            profiles.append(BrowserProfile(**pdata))
        return profiles

    def get_profile(self, profile_id: str) -> Optional[BrowserProfile]:
        """Get profile metadata by ID."""
        clean_id = self._sanitize_profile_id(profile_id)
        registry = self._load_registry()
        pdata = registry.get(clean_id)
        return BrowserProfile(**pdata) if pdata else None

    def create_profile(self, profile_id: str, name: Optional[str] = None) -> BrowserProfile:
        """Create a new persistent browser profile directory and record metadata."""
        clean_id = self._sanitize_profile_id(profile_id)
        registry = self._load_registry()
        
        profile_dir = self.profiles_dir / clean_id
        profile_dir.mkdir(parents=True, exist_ok=True)

        pdata = {
            "id": clean_id,
            "name": name or clean_id.capitalize(),
            "provider": "camofox",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "last_used_at": None,
        }
        registry[clean_id] = pdata
        self._save_registry(registry)
        return BrowserProfile(**pdata)

    def get_profile_dir(self, profile_id: str) -> Path:
        """Resolve absolute filesystem path for persistent profile storage."""
        clean_id = self._sanitize_profile_id(profile_id)
        pdir = self.profiles_dir / clean_id
        pdir.mkdir(parents=True, exist_ok=True)
        return pdir

    def touch_profile(self, profile_id: str) -> None:
        """Update last_used_at timestamp for specified profile."""
        clean_id = self._sanitize_profile_id(profile_id)
        registry = self._load_registry()
        if clean_id in registry:
            registry[clean_id]["last_used_at"] = datetime.now(timezone.utc).isoformat()
            self._save_registry(registry)


# Global singleton instance
profile_manager = BrowserProfileManager()

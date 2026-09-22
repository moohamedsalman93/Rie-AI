"""Test voice preference persistence without loading desktop agents or real secrets."""
import ast
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from typing import Optional
import unittest
from unittest.mock import patch

from app.models import SettingsResponse, SettingsUpdate


class TestVoiceSettings(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.saved = {}
        database = ModuleType("app.database")
        database.get_all_settings = lambda: dict(self.saved)
        database.get_setting = self.saved.get
        app_dir = Path(__file__).parents[1] / "app"
        spec = importlib.util.spec_from_file_location("voice_settings_config_test", app_dir / "config.py")
        self.config = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"app.database": database}):
            spec.loader.exec_module(self.config)

        # Execute the actual route bodies with an in-memory DB. Importing the
        # full routes module would start unrelated desktop/agent dependencies.
        tree = ast.parse((app_dir / "routes.py").read_text(encoding="utf-8"))
        functions = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                     and node.name in {"get_settings", "update_settings"}]
        self.assertEqual(len(functions), 2)
        for node in functions:
            node.decorator_list = []
        namespace = {
            "Optional": Optional,
            "SettingsResponse": SettingsResponse,
            "SettingsUpdate": SettingsUpdate,
            "settings": self.config.settings,
            "get_setting": self.saved.get,
            "update_setting": self.saved.__setitem__,
            "_SECRET_SETTING_KEYS": frozenset(),
            "agent_manager": SimpleNamespace(_agent=None),
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(app_dir / "routes.py"), "exec"), namespace)
        self.get_settings = namespace["get_settings"]
        self.update_settings = namespace["update_settings"]

    async def test_disabled_preference_round_trips_and_survives_reload(self):
        result = await self.update_settings(SettingsUpdate(key="WAKE_WORD_ENABLED", value="false"))
        self.assertEqual(result["status"], "success")
        self.assertEqual(self.saved["WAKE_WORD_ENABLED"], "false")
        response = await self.get_settings()
        self.assertIs(response.model_dump()["wake_word_enabled"], False)
        self.assertFalse(self.config.Settings().WAKE_WORD_ENABLED)

    async def test_reenabling_is_returned_as_a_boolean(self):
        for value in ["false", "true", "false"]:
            await self.update_settings(SettingsUpdate(key="WAKE_WORD_ENABLED", value=value))
            response = await self.get_settings()
            self.assertIs(response.model_dump()["wake_word_enabled"], value == "true")

    async def test_existing_default_is_preserved_but_invalid_values_are_off(self):
        self.assertTrue((await self.get_settings()).wake_word_enabled)
        for value in [None, "", "invalid", "FALSE", False]:
            self.saved["WAKE_WORD_ENABLED"] = value
            self.assertFalse((await self.get_settings()).wake_word_enabled)


if __name__ == "__main__":
    unittest.main()

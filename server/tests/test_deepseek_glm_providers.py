import unittest
from unittest.mock import patch, MagicMock
from app.config import settings
from app.agent import agent_manager
from app.models import SettingsResponse


class TestDeepSeekAndGlmProviders(unittest.TestCase):

    def test_settings_properties_deepseek(self):
        with patch.object(settings, "_get") as mock_get:
            def side_effect(key, default=None):
                if key == "DEEPSEEK_API_KEY":
                    return "sk-test1, sk-test2\nsk-test3"
                if key == "DEEPSEEK_MODEL":
                    return "deepseek-reasoner"
                if key == "DEEPSEEK_BASE_URL":
                    return "https://api.deepseek.com"
                return default
            mock_get.side_effect = side_effect

            self.assertEqual(settings.DEEPSEEK_API_KEY_STRING, "sk-test1, sk-test2\nsk-test3")
            self.assertEqual(settings.DEEPSEEK_API_KEYS, ["sk-test1", "sk-test2", "sk-test3"])
            self.assertEqual(settings.DEEPSEEK_API_KEY, "sk-test1")
            self.assertEqual(settings.DEEPSEEK_MODEL, "deepseek-reasoner")
            self.assertEqual(settings.DEEPSEEK_BASE_URL, "https://api.deepseek.com")

    def test_settings_properties_glm(self):
        with patch.object(settings, "_get") as mock_get:
            def side_effect(key, default=None):
                if key == "GLM_API_KEY":
                    return "glm-key-1, glm-key-2"
                if key == "GLM_MODEL":
                    return "glm-4.7-flash"
                if key == "GLM_BASE_URL":
                    return "https://open.bigmodel.cn/api/paas/v4/"
                return default
            mock_get.side_effect = side_effect

            self.assertEqual(settings.GLM_API_KEY_STRING, "glm-key-1, glm-key-2")
            self.assertEqual(settings.GLM_API_KEYS, ["glm-key-1", "glm-key-2"])
            self.assertEqual(settings.GLM_API_KEY, "glm-key-1")
            self.assertEqual(settings.GLM_MODEL, "glm-4.7-flash")
            self.assertEqual(settings.GLM_BASE_URL, "https://open.bigmodel.cn/api/paas/v4/")

    def test_has_llm_api_key_deepseek_and_glm(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "deepseek" if k == "LLM_PROVIDER" else "sk-test" if k == "DEEPSEEK_API_KEY" else d
            self.assertTrue(settings.has_llm_api_key)

        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "glm" if k == "LLM_PROVIDER" else "glm-key" if k == "GLM_API_KEY" else d
            self.assertTrue(settings.has_llm_api_key)

    def test_create_llm_deepseek_single_key(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "sk-deepseek-123" if k == "DEEPSEEK_API_KEY" else "deepseek-chat" if k == "DEEPSEEK_MODEL" else "https://api.deepseek.com" if k == "DEEPSEEK_BASE_URL" else d
            llm = agent_manager._create_llm_by_provider("deepseek", speed_mode="thinking")
            self.assertIsNotNone(llm)

    def test_create_llm_deepseek_multi_key_rotation(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "sk-key1, sk-key2" if k == "DEEPSEEK_API_KEY" else "deepseek-chat" if k == "DEEPSEEK_MODEL" else "https://api.deepseek.com" if k == "DEEPSEEK_BASE_URL" else d
            llm = agent_manager._create_llm_by_provider("deepseek", speed_mode="flash")
            self.assertIsNotNone(llm)
            self.assertTrue(hasattr(llm, "_rotator"))

    def test_create_llm_glm_multi_key_rotation(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "glm1, glm2" if k == "GLM_API_KEY" else "glm-4.7-flash" if k == "GLM_MODEL" else "https://open.bigmodel.cn/api/paas/v4/" if k == "GLM_BASE_URL" else d
            llm = agent_manager._create_llm_by_provider("glm", speed_mode="thinking")
            self.assertIsNotNone(llm)
            self.assertTrue(hasattr(llm, "_rotator"))

    def test_settings_response_serialization(self):
        resp = SettingsResponse(
            deepseek_api_key="sk-test",
            deepseek_model="deepseek-chat",
            deepseek_base_url="https://api.deepseek.com",
            glm_api_key="glm-test",
            glm_model="glm-4.7-flash",
            glm_base_url="https://open.bigmodel.cn/api/paas/v4/",
        )
        data = resp.model_dump()
        self.assertEqual(data["deepseek_api_key"], "sk-test")
        self.assertEqual(data["deepseek_model"], "deepseek-chat")
        self.assertEqual(data["glm_api_key"], "glm-test")
        self.assertEqual(data["glm_model"], "glm-4.7-flash")


if __name__ == "__main__":
    unittest.main()

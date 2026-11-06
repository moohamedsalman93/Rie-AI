import unittest
from unittest.mock import patch, MagicMock
from app.config import settings
from app.agent import agent_manager
from app.models import SettingsResponse


class TestAzureFoundryProvider(unittest.TestCase):

    def test_settings_properties_azure_foundry(self):
        with patch.object(settings, "_get") as mock_get:
            def side_effect(key, default=None):
                if key == "AZURE_FOUNDRY_API_KEY":
                    return "az-key-1, az-key-2\naz-key-3"
                if key == "AZURE_FOUNDRY_MODEL":
                    return "gpt-4o"
                if key == "AZURE_FOUNDRY_BASE_URL":
                    return "https://my-resource.services.ai.azure.com/models"
                return default
            mock_get.side_effect = side_effect

            self.assertEqual(settings.AZURE_FOUNDRY_API_KEY_STRING, "az-key-1, az-key-2\naz-key-3")
            self.assertEqual(settings.AZURE_FOUNDRY_API_KEYS, ["az-key-1", "az-key-2", "az-key-3"])
            self.assertEqual(settings.AZURE_FOUNDRY_API_KEY, "az-key-1")
            self.assertEqual(settings.AZURE_FOUNDRY_MODEL, "gpt-4o")
            self.assertEqual(settings.AZURE_FOUNDRY_BASE_URL, "https://my-resource.services.ai.azure.com/models")

    def test_settings_properties_azure_openai_endpoint_normalization(self):
        with patch.object(settings, "_get") as mock_get:
            def side_effect(key, default=None):
                if key == "AZURE_FOUNDRY_BASE_URL":
                    return "https://my-resource.openai.azure.com/"
                return default
            mock_get.side_effect = side_effect

            self.assertEqual(settings.AZURE_FOUNDRY_BASE_URL, "https://my-resource.openai.azure.com/openai/v1")

    def test_has_llm_api_key_azure_foundry(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "azure_foundry" if k == "LLM_PROVIDER" else "az-key" if k == "AZURE_FOUNDRY_API_KEY" else d
            self.assertTrue(settings.has_llm_api_key)

        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "azure" if k == "LLM_PROVIDER" else "az-key" if k == "AZURE_FOUNDRY_API_KEY" else d
            self.assertTrue(settings.has_llm_api_key)

    def test_create_llm_azure_foundry_single_key(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "az-key-123" if k == "AZURE_FOUNDRY_API_KEY" else "gpt-4o" if k == "AZURE_FOUNDRY_MODEL" else "https://models.inference.ai.azure.com" if k == "AZURE_FOUNDRY_BASE_URL" else d
            llm = agent_manager._create_llm_by_provider("azure_foundry", speed_mode="thinking")
            self.assertIsNotNone(llm)
            self.assertEqual(getattr(llm, "default_headers", {}).get("api-key"), "az-key-123")
            self.assertIsNone(getattr(llm, "temperature", None))
            sub_model, idx = llm._get_model_with_index()
            self.assertEqual(sub_model.default_headers.get("api-key"), "az-key-123")
            self.assertIsNone(getattr(sub_model, "temperature", None))

    def test_create_llm_azure_foundry_multi_key_rotation(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "az-key-1, az-key-2" if k == "AZURE_FOUNDRY_API_KEY" else "gpt-4o" if k == "AZURE_FOUNDRY_MODEL" else "https://models.inference.ai.azure.com" if k == "AZURE_FOUNDRY_BASE_URL" else d
            llm = agent_manager._create_llm_by_provider("azure_foundry", speed_mode="flash")
            self.assertIsNotNone(llm)
            self.assertTrue(hasattr(llm, "_rotator"))
            self.assertIsNone(llm.temperature)
            # Test getting model with key rotation
            sub_model, idx = llm._get_model_with_index()
            self.assertEqual(sub_model.default_headers.get("api-key"), "az-key-1")
            self.assertIsNone(getattr(sub_model, "temperature", None))

    def test_azure_endpoint_under_openai_provider_omits_temperature(self):
        with patch.object(settings, "_get") as mock_get:
            mock_get.side_effect = lambda k, d=None: "sk-proj-test" if k == "OPENAI_API_KEY" else "gpt-6-luna" if k == "OPENAI_MODEL" else "https://digival-ai-2345.services.ai.azure.com/openai/v1" if k == "OPENAI_BASE_URL" else d
            llm = agent_manager._create_llm_by_provider("openai", speed_mode="thinking")
            self.assertIsNotNone(llm)
            self.assertIsNone(getattr(llm, "temperature", None))
            sub_model, idx = llm._get_model_with_index()
            self.assertIsNone(getattr(sub_model, "temperature", None))

    def test_azure_rotating_model_strips_temperature_on_kwargs_and_bind_tools(self):
        from app.agent import RotatingChatOpenAI, internet_search
        rot_llm = RotatingChatOpenAI(
            api_keys=["test-key"],
            model="gpt-6-luna",
            base_url="https://digival-ai-2345.services.ai.azure.com/openai/v1",
            temperature=0.7,  # Should be overridden to None because it's Azure
            provider_name="azure_foundry",
        )
        self.assertIsNone(rot_llm.temperature)
        self.assertTrue(rot_llm._is_azure())

        # Test bind_tools strips temperature
        bound = rot_llm.bind_tools([internet_search])
        bound_kwargs = getattr(bound, "kwargs", {})
        self.assertNotIn("temperature", bound_kwargs)

    def test_settings_response_serialization(self):
        resp = SettingsResponse(
            azure_foundry_api_key="az-secret",
            azure_foundry_model="gpt-4o",
            azure_foundry_base_url="https://models.inference.ai.azure.com",
        )
        data = resp.model_dump()
        self.assertEqual(data["azure_foundry_api_key"], "az-secret")
        self.assertEqual(data["azure_foundry_model"], "gpt-4o")
        self.assertEqual(data["azure_foundry_base_url"], "https://models.inference.ai.azure.com")


if __name__ == "__main__":
    unittest.main()


"""
Configuration settings for the application
"""
import os
import sys
from pathlib import Path
from typing import Optional, Dict, Any
from app.database import get_all_settings, get_setting

# Get the project root directory
if getattr(sys, 'frozen', False):
    # If running as a bundle, the executable's directory
    PROJECT_ROOT = Path(sys.executable).parent
else:
    PROJECT_ROOT = Path(__file__).parent.parent


class Settings:
    """Application settings loaded from database"""
    
    def __init__(self):
        # Initial load
        self.reload()
    
    def reload(self):
        """Reload settings from database"""
        self._settings = get_all_settings()
    
    def _get(self, key: str, default: Any = None) -> Any:
        return self._settings.get(key, default)

    @property
    def GROQ_API_KEY_STRING(self) -> Optional[str]:
        """Raw string of Groq API keys as stored in DB"""
        return self._get("GROQ_API_KEY")

    # API Keys - fetched dynamically
    @property
    def GROQ_API_KEYS(self) -> list[str]:
        """List of Groq API keys for rotation"""
        keys_str = self.GROQ_API_KEY_STRING
        if not keys_str:
            return []
        # Support comma and newline separated
        return [k.strip() for k in keys_str.replace('\n', ',').split(',') if k.strip()]

    @property
    def GROQ_API_KEY(self) -> Optional[str]:
        # Keep this for backward compatibility and simple checks
        keys = self.GROQ_API_KEYS
        return keys[0] if keys else None

    @property
    def ANTHROPIC_API_KEY(self) -> Optional[str]:
        return self._get("ANTHROPIC_API_KEY")

    @property
    def OPENAI_API_KEY_STRING(self) -> Optional[str]:
        """Raw string of OpenAI API keys as stored in DB"""
        return self._get("OPENAI_API_KEY")

    @property
    def OPENAI_API_KEYS(self) -> list[str]:
        """List of OpenAI API keys for rotation"""
        keys_str = self.OPENAI_API_KEY_STRING
        if not keys_str:
            return []
        # Support comma and newline separated
        return [k.strip() for k in keys_str.replace('\n', ',').split(',') if k.strip()]

    @property
    def OPENAI_API_KEY(self) -> Optional[str]:
        # Keep this for backward compatibility and simple checks
        keys = self.OPENAI_API_KEYS
        return keys[0] if keys else None

    @property
    def OPENAI_MODEL(self) -> str:
        return self._get("OPENAI_MODEL", "glm-4.5-flash")

    @property
    def OPENAI_BASE_URL(self) -> str:
        return self._get("OPENAI_BASE_URL", "https://api.z.ai/api/paas/v4/")

    @property
    def TAVILY_API_KEY(self) -> Optional[str]:
        return self._get("TAVILY_API_KEY")

    @property
    def GOOGLE_API_KEY(self) -> Optional[str]:
        return self._get("GOOGLE_API_KEY")

    # LangSmith settings
    @property
    def LANGSMITH_TRACING(self) -> bool:
        """Whether LangSmith tracing is enabled"""
        return self._get("LANGSMITH_TRACING", "false").lower() == "true"

    @property
    def LANGSMITH_API_KEY(self) -> Optional[str]:
        """LangSmith API Key"""
        return self._get("LANGSMITH_API_KEY")

    @property
    def LANGSMITH_PROJECT(self) -> str:
        """LangSmith Project Name"""
        return self._get("LANGSMITH_PROJECT", "Rie-AI")

    @property
    def LANGSMITH_ENDPOINT(self) -> str:
        """LangSmith API Endpoint"""
        return self._get("LANGSMITH_ENDPOINT", "https://api.smith.langchain.com")
    
    # Application settings
    APP_NAME: str = "Rie BE Chat API"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    
    # Groq model settings
    @property
    def GROQ_MODEL(self) -> str:
        return self._get("GROQ_MODEL", "moonshotai/kimi-k2-instruct-0905")
    
    # Vertex AI (Gemini via Vertex) settings
    @property
    def VERTEX_PROJECT(self) -> Optional[str]:
        return self._get("VERTEX_PROJECT")
    
    @property
    def VERTEX_LOCATION(self) -> str:
        return self._get("VERTEX_LOCATION", "us-central1")
    
    @property
    def VERTEX_MODEL(self) -> str:
        return self._get("VERTEX_MODEL", "gemini-1.5-pro")
    
    # Gemini (Generative AI) model settings
    @property
    def GEMINI_MODEL(self) -> str:
        return self._get("GEMINI_MODEL", "gemini-1.5-pro")

    # Rie configuration - hardcoded, no API key needed
    @property
    def RIE_API_URL(self) -> str:
        return "http://localhost:8001/v1"

    @property
    def RIE_MODEL(self) -> str:
        return "glm-4.6v-flash"

    @property
    def VERTEX_CREDENTIALS_PATH(self) -> Optional[str]:
        return self._get("VERTEX_CREDENTIALS_PATH")

    @property
    def OLLAMA_API_URL(self) -> str:
        """Ollama base URL; empty or unset defaults to localhost."""
        url = (self._get("OLLAMA_API_URL") or "").strip()
        return url if url else "http://localhost:11434"

    @property
    def OLLAMA_API_KEY(self) -> Optional[str]:
        """Optional API key for Ollama (e.g. remote or secured instances)."""
        key = (self._get("OLLAMA_API_KEY") or "").strip()
        return key or None

    @property
    def OLLAMA_MODEL(self) -> Optional[str]:
        return self._get("OLLAMA_MODEL")

    @property
    def EMBEDDING_SOURCE(self) -> str:
        """
        LTM embedding source: 'bundled' (default) or 'ollama'.
        - bundled: use sentence-transformers model in-process (no Ollama needed).
        - ollama: use Ollama's nomic-embed-text (requires Ollama running).
        If you switch between them, delete the chroma_ltm folder to recreate LTM (different vector sizes).
        """
        return (self._get("EMBEDDING_SOURCE") or "bundled").strip().lower()

    @property
    def EMBEDDING_MODEL_PATH(self) -> Optional[str]:
        """
        Optional path to a bundled embedding model (for PyInstaller/frozen builds).
        If set, sentence-transformers loads from this path instead of downloading.
        E.g. pass sys._MEIPASS + '/embedding_model' when model is bundled in the exe.
        """
        path = (self._get("EMBEDDING_MODEL_PATH") or "").strip()
        return path if path else None

    @property
    def LLM_PROVIDER(self) -> Optional[str]:
        """
        Selected LLM provider: 'groq', 'gemini', 'vertex'
        """
        return self._get("LLM_PROVIDER")

    @property
    def ENABLED_TOOLS(self) -> Optional[list[str]]:
        """
        List of enabled tool names.
        Stored as JSON string in DB, returned as list.
        Returns None if not set (implies default/all).
        """
        import json
        tools_json = self._get("ENABLED_TOOLS")
        if tools_json is None:
            return None
            
        try:
            return json.loads(tools_json)
        except json.JSONDecodeError:
            return []

    @property
    def TERMINAL_RESTRICTIONS(self) -> str:
        """
        Regex or comma-separated list of restricted terminal commands.
        If empty, all commands are allowed (subject to system permissions).
        """
        return self._get("TERMINAL_RESTRICTIONS", "")

    @property
    def WINDOW_MODE(self) -> str:
        """
        Window mode: 'floating' or 'normal'
        """
        return self._get("WINDOW_MODE", "floating")

    @property
    def CHAT_MODE(self) -> str:
        """
        Chat mode: 'agent' or 'chat'
        """
        return self._get("CHAT_MODE", "agent")

    @property
    def SPEED_MODE(self) -> str:
        """
        Speed mode: 'thinking' or 'flash'
        """
        return self._get("SPEED_MODE", "thinking")

    @property
    def HITL_ENABLED(self) -> bool:
        """
        Whether Human‑in‑the‑Loop (HITL) middleware is enabled.
        When disabled, tool calls run without explicit human approval prompts.
        """
        return self._get("HITL_ENABLED", "true").lower() == "true"

    @property
    def VOICE_REPLY(self) -> bool:
        """
        Whether to automatically reply with voice for voice input
        """
        return self._get("VOICE_REPLY", "true").lower() == "true"

    @property
    def TTS_PROVIDER(self) -> str:
        """
        TTS Provider: 'edge-tts' or 'groq'
        """
        return self._get("TTS_PROVIDER", "edge-tts")

    @property
    def TTS_VOICE(self) -> str:
        """
        Default voice for the selected TTS provider
        """
        default_voice = "en-US-EmmaNeural" if self.TTS_PROVIDER == "edge-tts" else "hannah"
        return self._get("TTS_VOICE", default_voice)

    
    @property
    def RIE_ACCESS_TOKEN(self) -> Optional[str]:
        return get_setting("RIE_ACCESS_TOKEN")

    @property
    def has_llm_api_key(self) -> bool:
        """Check if the currently selected LLM provider has a valid API key configured"""
        provider = self.LLM_PROVIDER
        
        if not provider:
            return True # Default to Rie (which now needs checking)
            
        if provider == "groq":
            return bool(self.GROQ_API_KEYS)
        elif provider == "vertex":
            return bool(self.VERTEX_PROJECT) # Credentials might be implicit
        elif provider == "gemini":
            return bool(self.GOOGLE_API_KEY)
        elif provider == "openai":
            return bool(self.OPENAI_API_KEYS)
        elif provider == "rie":
            return bool(self.RIE_ACCESS_TOKEN)
        elif provider == "ollama":
            return bool(self.OLLAMA_MODEL)
            
        return False

    @property
    def MCP_SERVERS(self) -> list[dict]:
        """
        List of MCP server configurations.
        Stored as JSON string in DB, returned as list of dicts.
        """
        import json
        mcp_json = self._get("MCP_SERVERS")
        if not mcp_json:
            return []
            
        try:
            return json.loads(mcp_json)
        except json.JSONDecodeError:
            return []

    
    @property
    def EXTERNAL_APIS(self) -> list[dict]:
        """
        List of custom external API configurations.
        Stored as JSON string in DB, returned as list of dicts.
        """
        import json
        apis_json = self._get("EXTERNAL_APIS")
        if not apis_json:
            return []
            
        try:
            return json.loads(apis_json)
        except json.JSONDecodeError:
            return []

    
    @property
    def has_tavily_key(self) -> bool:
        """Check if Tavily API key is configured"""
        return bool(self.TAVILY_API_KEY)


    @property
    def LOG_FILE(self) -> Path:
        """Path to backend log file"""
        if getattr(sys, 'frozen', False):
            log_dir = Path(os.getenv('LOCALAPPDATA', os.path.expanduser('~'))) / 'Rie-AI' / 'logs'
            log_dir.mkdir(parents=True, exist_ok=True)
            return log_dir / 'backend_debug.log'
        else:
            return Path('backend_debug.log')


# Global settings instance
settings = Settings()

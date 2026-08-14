"""
Base Plugin Handler and Manifest Data Models for RIE Generic Plugin SDK.
"""
from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional
from pydantic import BaseModel, Field


class PluginToolSpec(BaseModel):
    name: str
    description: str
    risk_level: str = "read"  # "read", "write", "destructive"
    capability: Optional[str] = None  # e.g. "gmail.read", "gmail.send"
    parameters: Dict[str, Any] = Field(default_factory=dict)


class PluginManifestSpec(BaseModel):
    manifest_version: int = 1
    id: str
    name: str
    displayName: str
    version: str = "1.0.0"
    description: str
    category: str
    icon: str
    auth_type: str = "oauth2"  # "oauth2", "api_key", "mcp"
    docs_url: Optional[str] = None
    default_scopes: List[str] = Field(default_factory=list)
    scopes: List[str] = Field(default_factory=list)
    tools: List[PluginToolSpec] = Field(default_factory=list)


class BasePluginHandler(ABC):
    """
    Abstract base handler for all RIE 3rd-party integration plugins.
    Each plugin directory implements this interface in its handler.py.
    """
    def __init__(self, manifest: PluginManifestSpec):
        self.manifest = manifest

    @abstractmethod
    async def execute_tool(self, tool_name: str, args: Dict[str, Any], access_token: str, creds: Dict[str, Any]) -> str:
        """
        Execute a tool declared by this plugin.
        :param tool_name: Name of the tool invoked by the LLM agent.
        :param args: Dictionary of arguments supplied by the agent.
        :param access_token: Active authorization token.
        :param creds: Complete credentials dict (including refresh_token, token_type, etc.).
        :return: String response formatted for LLM context.
        """
        pass

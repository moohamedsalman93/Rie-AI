"""
Dynamic Capability Resolver module for Rie Agent Runtime.

Indexes and dynamically resolves capabilities across:
- Built-in System & Desktop Tools
- Active Plugins (Gmail, GitHub, Jira)
- MCP Tools (Model Context Protocol servers)
- User-Connected APIs (custom external REST tools)
- Learned & Stored Skills

Scopes model contexts by binding only the exact capabilities required for a task turn.
"""
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Set, Any, Callable
import re
import logging
from langchain_core.tools import BaseTool, StructuredTool

_logger = logging.getLogger(__name__)


class CapabilitySource(str, Enum):
    BUILTIN = "builtin"
    PLUGIN = "plugin"
    MCP = "mcp"
    USER_API = "user_api"
    SKILL = "skill"


@dataclass
class CapabilityDescriptor:
    name: str
    description: str
    source: CapabilitySource
    provider: str = "rie"  # e.g. system, gmail, github, jira, crm, weather
    keywords: List[str] = field(default_factory=list)
    tool_instance: Optional[BaseTool] = None
    enabled: bool = True

    def matches_query(self, query_lower: str, active_domains: Set[str]) -> float:
        """Calculate relevance score between 0.0 and 1.0 for a query."""
        score = 0.0
        name_lower = self.name.lower()
        desc_lower = self.description.lower()
        provider_lower = self.provider.lower()

        # 1. Domain match boost
        if provider_lower in active_domains or (self.source == CapabilitySource.PLUGIN and provider_lower in active_domains):
            score += 0.4

        # 2. Exact name in query
        if name_lower in query_lower:
            score += 0.5

        # 3. Provider/source keyword match
        if provider_lower and provider_lower in query_lower:
            score += 0.3

        # 4. Keyword matches
        for kw in self.keywords:
            if kw.lower() in query_lower:
                score += 0.2

        # 5. Token overlap with description
        query_words = set(re.findall(r'\b[a-z]{3,}\b', query_lower))
        desc_words = set(re.findall(r'\b[a-z]{3,}\b', desc_lower))
        overlap = query_words.intersection(desc_words)
        if overlap:
            score += min(0.3, len(overlap) * 0.1)

        return min(1.0, score)


class CapabilityCatalog:
    """Registry maintaining searchable descriptors of all available capabilities."""
    def __init__(self):
        self._descriptors: Dict[str, CapabilityDescriptor] = {}

    def register_capability(self, descriptor: CapabilityDescriptor) -> None:
        self._descriptors[descriptor.name] = descriptor

    def register_tool(
        self,
        tool: BaseTool,
        source: CapabilitySource,
        provider: str = "rie",
        keywords: Optional[List[str]] = None
    ) -> None:
        desc = getattr(tool, "description", "") or ""
        name = getattr(tool, "name", str(tool))
        self.register_capability(CapabilityDescriptor(
            name=name,
            description=desc,
            source=source,
            provider=provider,
            keywords=keywords or [],
            tool_instance=tool,
            enabled=True
        ))

    def get_all_descriptors(self) -> List[CapabilityDescriptor]:
        return list(self._descriptors.values())


class CapabilityResolver:
    """
    Dynamically resolves user intents into a minimal, optimal tool subset.
    """
    def __init__(self, catalog: Optional[CapabilityCatalog] = None):
        self.catalog = catalog or CapabilityCatalog()

    def populate_from_runtime(
        self,
        base_tools: List[BaseTool],
        plugins: Optional[Dict[str, Any]] = None,
        mcp_tools: Optional[List[BaseTool]] = None,
        user_apis: Optional[List[BaseTool]] = None,
    ) -> None:
        """Populate catalog with all live capabilities across runtime layers."""
        # 1. Built-in Tools
        for t in base_tools:
            name = getattr(t, "name", "")
            if name == "internet_search":
                provider = "search"
                keywords = ["weather", "temperature", "forecast", "climate", "search", "web", "google", "news", "price"]
            elif any(k in name for k in ("terminal", "windows", "app_control", "desktop")):
                provider = "system"
                keywords = ["terminal", "command", "powershell", "wifi", "desktop", "process"]
            elif any(k in name for k in ("memory", "ltm")):
                provider = "memory"
                keywords = ["remember", "memory", "preference"]
            elif "knowledge" in name:
                provider = "knowledge"
                keywords = ["knowledge", "doc", "asset"]
            elif "schedule" in name:
                provider = "scheduler"
                keywords = ["schedule", "reminder", "alarm"]
            elif "friend" in name:
                provider = "remote_friend"
                keywords = ["friend", "peer", "remote"]
            else:
                provider = "builtin"
                keywords = []
            self.catalog.register_tool(t, source=CapabilitySource.BUILTIN, provider=provider, keywords=keywords)

        # 2. Plugins
        if plugins:
            for p_name, p_tools in plugins.items():
                if isinstance(p_tools, list):
                    for t in p_tools:
                        self.catalog.register_tool(t, source=CapabilitySource.PLUGIN, provider=p_name)

        # 3. MCP Tools
        if mcp_tools:
            for t in mcp_tools:
                self.catalog.register_tool(t, source=CapabilitySource.MCP, provider="mcp")

        # 4. User-Connected APIs
        if user_apis:
            for t in user_apis:
                name = getattr(t, "name", "")
                self.catalog.register_tool(t, source=CapabilitySource.USER_API, provider="user_api", keywords=[name])

    def resolve_capabilities(
        self,
        query: str,
        active_domains: Set[str],
        fallback_tools: Optional[List[BaseTool]] = None,
        max_tools: int = 8,
        min_score: float = 0.2
    ) -> List[BaseTool]:
        """
        Selects and binds only the relevant tools matching the user request.
        """
        query_lower = query.lower() if query else ""
        scored_tools: List[Tuple[float, BaseTool]] = []

        for descriptor in self.catalog.get_all_descriptors():
            if not descriptor.enabled or not descriptor.tool_instance:
                continue

            score = descriptor.matches_query(query_lower, active_domains)
            if score >= min_score:
                scored_tools.append((score, descriptor.tool_instance))

        # Sort by relevance score descending
        scored_tools.sort(key=lambda x: x[0], reverse=True)
        selected = [t for _, t in scored_tools[:max_tools]]

        # Ensure fallbacks are included if empty
        if not selected and fallback_tools:
            return fallback_tools[:max_tools]

        return selected


# Global default instance
capability_catalog = CapabilityCatalog()
capability_resolver = CapabilityResolver(capability_catalog)

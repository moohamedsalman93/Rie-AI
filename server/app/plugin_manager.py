"""
Plugin Manager for RIE Desktop Client.
Manages installed integrations, token refreshes via rie-be-main proxy, capability checks,
and dynamic tool construction for LangChain agent using the Generic Plugin SDK.
"""
import asyncio
import json
import logging
import re
import time
import httpx
from typing import Dict, List, Any, Optional
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, create_model

from app.database import (
    list_plugin_integrations,
    get_plugin_integration,
    save_plugin_integration,
    delete_plugin_integration
)
from app.security_crypto import decrypt_json, encrypt_json
from app.plugins.loader import plugin_registry
from app.plugins.base import PluginManifestSpec, PluginToolSpec

logger = logging.getLogger(__name__)

# Cloud middleware backend base URL
RIE_BE_MAIN_URL = "http://localhost:8001/v1"


class PluginManager:
    """
    Manages 3rd-party plugin connections, token refresh cycles, capability enforcement, and dynamic tool router registration.
    """
    def __init__(self):
        self._tools_map: Dict[str, StructuredTool] = {}
        self._active_plugins: Dict[str, dict] = {}
        self._refresh_locks: Dict[str, asyncio.Lock] = {}
        self._initialized = False

    def _get_refresh_lock(self, plugin_id: str) -> asyncio.Lock:
        """Retrieve or create per-plugin asyncio.Lock for refresh synchronization."""
        if plugin_id not in self._refresh_locks:
            self._refresh_locks[plugin_id] = asyncio.Lock()
        return self._refresh_locks[plugin_id]

    async def initialize(self):
        """Load installed plugins from SQLite DB and generate dynamic tools."""
        try:
            # Ensure plugin registry is loaded
            plugin_registry.discover_plugins()

            db_records = list_plugin_integrations()
            self._active_plugins = {}
            tools_list = []

            for record in db_records:
                plugin_id = record["plugin_id"]
                status = record.get("status", "connected")

                if status != "connected":
                    continue

                target_plugin_id = "gmail" if plugin_id == "google" else plugin_id

                encrypted_creds = record.get("encrypted_credentials", "")
                creds = decrypt_json(encrypted_creds)
                config = record.get("config", {})

                plugin_data = {
                    "record": record,
                    "creds": creds,
                    "config": config
                }
                self._active_plugins[plugin_id] = plugin_data
                self._active_plugins[target_plugin_id] = plugin_data

                # Construct dynamic tools from manifest in registry
                manifest = plugin_registry.get_manifest(target_plugin_id)
                if manifest:
                    plugin_tools = self._build_tools_for_plugin(manifest, creds, config)
                    tools_list.extend(plugin_tools)

            self._tools_map = {t.name: t for t in tools_list}
            self._initialized = True
            logger.info(f"PluginManager initialized with {len(self._tools_map)} active tools across {len(self._active_plugins)} integrations.")
        except Exception as e:
            logger.error(f"Error initializing PluginManager: {e}", exc_info=True)

    def is_capability_enabled(self, plugin_id: str, capability: Optional[str]) -> bool:
        """Check if a specific tool capability is enabled in plugin config."""
        if not capability:
            return True

        plugin_data = self._active_plugins.get(plugin_id)
        if not plugin_data:
            return False

        config = plugin_data.get("config", {})
        disabled_caps = config.get("disabled_capabilities", [])
        return capability not in disabled_caps

    def _build_tools_for_plugin(self, manifest: PluginManifestSpec, creds: dict, config: dict) -> List[StructuredTool]:
        """Convert manifest specs into executable LangChain StructuredTools."""
        tools = []
        disabled_caps = config.get("disabled_capabilities", [])

        for tool_spec in manifest.tools:
            # Skip building tools whose capabilities have been explicitly disabled by user
            if tool_spec.capability and tool_spec.capability in disabled_caps:
                continue

            tool_name = tool_spec.name
            tool_description = tool_spec.description
            params_schema = tool_spec.parameters or {}
            properties = params_schema.get("properties", {})
            required = params_schema.get("required", [])

            fields = {}
            for prop_name, prop_info in properties.items():
                schema_type = prop_info.get("type", "string")
                if schema_type == "array":
                    items_info = prop_info.get("items", {})
                    item_type_str = items_info.get("type", "string") if isinstance(items_info, dict) else "string"
                    item_py_type = {
                        "integer": int,
                        "number": float,
                        "boolean": bool,
                        "object": dict
                    }.get(item_type_str, str)
                    prop_type = List[item_py_type]
                else:
                    prop_type = {
                        "integer": int,
                        "number": float,
                        "boolean": bool,
                        "object": dict
                    }.get(schema_type, str)

                prop_description = prop_info.get("description", "")
                prop_default = ... if prop_name in required else prop_info.get("default", None)

                fields[prop_name] = (
                    prop_type,
                    Field(..., description=prop_description) if prop_default is ... else Field(default=prop_default, description=prop_description)
                )

            class EmptyInput(BaseModel):
                pass

            InputModel = EmptyInput
            if fields:
                try:
                    class_name = re.sub(r'[^a-zA-Z0-9_]', '', tool_name)
                    InputModel = create_model(f"{class_name}Input", **fields)
                except Exception as e:
                    logger.error(f"Failed to create Pydantic model for plugin tool {tool_name}: {e}")
                    InputModel = EmptyInput

            # Capture tool_spec in closure
            current_tool_spec = tool_spec

            async def _executor(ts=current_tool_spec, **kwargs):
                return await self._execute_plugin_tool(manifest.id, ts.name, ts.capability, kwargs)

            lc_tool = StructuredTool(
                name=tool_name,
                description=tool_description,
                coroutine=_executor,
                args_schema=InputModel,
                metadata={
                    "risk_level": tool_spec.risk_level,
                    "capability": tool_spec.capability,
                    "plugin_id": manifest.id
                }
            )
            tools.append(lc_tool)

        return tools

    async def force_refresh_token(self, plugin_id: str) -> str:
        """Force refresh token regardless of expires_at."""
        target_provider = "google" if plugin_id in ("gmail", "google") else plugin_id
        plugin_data = self._active_plugins.get(plugin_id) or self._active_plugins.get(target_provider)
        if not plugin_data:
            return ""

        creds = plugin_data.get("creds", {})
        tokens = creds.get("tokens", {})
        refresh_token = tokens.get("refresh_token") or creds.get("refresh_token", "")

        if not refresh_token:
            return tokens.get("access_token") or creds.get("access_token", "")

        lock = self._get_refresh_lock(plugin_id)
        async with lock:
            logger.info(f"Force refreshing access token for {plugin_id} ({target_provider}) via cloud middleware...")
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    ref_res = await client.post(
                        f"{RIE_BE_MAIN_URL}/integrations/oauth/{target_provider}/refresh?refresh_token={refresh_token}",
                        json={"refresh_token": refresh_token}
                    )
                    if ref_res.status_code == 200:
                        ref_data = ref_res.json()
                        new_tokens = ref_data.get("tokens", {})
                        if new_tokens.get("access_token"):
                            new_access_token = new_tokens["access_token"]
                            tokens["access_token"] = new_access_token
                            if new_tokens.get("expires_in"):
                                tokens["expires_at"] = time.time() + new_tokens["expires_in"]

                            creds["tokens"] = tokens
                            encrypted_creds = encrypt_json(creds)
                            plugin_record = plugin_data["record"]
                            real_plugin_id = plugin_record.get("plugin_id", plugin_id)
                            save_plugin_integration(
                                plugin_id=real_plugin_id,
                                name=plugin_record["name"],
                                auth_type=plugin_record["auth_type"],
                                status="connected",
                                encrypted_credentials=encrypted_creds,
                                account_info=json.dumps(plugin_record.get("account_info", {})),
                                config=json.dumps(plugin_record.get("config", {}))
                            )
                            # Update in-memory active plugins map
                            plugin_data["creds"] = creds
                            logger.info(f"Successfully refreshed access token for {plugin_id}.")
                            return new_access_token
                    else:
                        logger.warning(f"Refresh failed for {plugin_id}: {ref_res.status_code} {ref_res.text}")
            except Exception as ex:
                logger.warning(f"Failed token refresh for {plugin_id}: {ex}")

        return tokens.get("access_token") or creds.get("access_token", "")

    async def _ensure_valid_token(self, plugin_id: str, creds: dict) -> str:
        """
        Preemptive token refresh: Check token expiration and refresh if expired or expiring within 300s.
        """
        tokens = creds.get("tokens", {})
        access_token = tokens.get("access_token") or creds.get("access_token", "")
        refresh_token = tokens.get("refresh_token") or creds.get("refresh_token", "")
        expires_at = tokens.get("expires_at", 0)

        now = time.time()
        # If refresh_token exists AND (expires_at is missing/0 or expires in < 300s)
        if refresh_token and (expires_at == 0 or (expires_at - now) < 300):
            return await self.force_refresh_token(plugin_id)

        return access_token

    async def _execute_plugin_tool(self, plugin_id: str, tool_name: str, capability: Optional[str], args: dict) -> str:
        """Dispatch tool invocation with capability checks & auto-refreshed token."""
        target_provider = "gmail" if plugin_id == "google" else plugin_id
        plugin_data = self._active_plugins.get(plugin_id) or self._active_plugins.get(target_provider)
        if not plugin_data:
            return f"Error: Plugin '{plugin_id}' is not connected. Please connect it in Settings -> Connectors."

        # Check capability enablement
        if capability and not self.is_capability_enabled(plugin_id, capability):
            return f"Error: Capability '{capability}' is disabled by user setting for plugin '{plugin_id}'."

        creds = plugin_data.get("creds", {})
        access_token = await self._ensure_valid_token(target_provider, creds)

        if not access_token:
            return f"Error: Access token for connected plugin '{plugin_id}' is expired or revoked. Please reconnect in Settings."

        handler = plugin_registry.get_handler(target_provider)
        if not handler:
            return f"Error: Plugin handler for '{target_provider}' is not registered."

        try:
            result = await handler.execute_tool(tool_name, args, access_token, creds)
            # If 401 or UNAUTHENTICATED error returned, attempt force token refresh and retry once
            if "401" in result or "UNAUTHENTICATED" in result or "Invalid Credentials" in result:
                logger.info(f"Received 401 response for tool {tool_name}. Forcing token refresh and retrying...")
                new_token = await self.force_refresh_token(target_provider)
                if new_token and new_token != access_token:
                    result = await handler.execute_tool(tool_name, args, new_token, creds)
            return result
        except Exception as e:
            logger.error(f"Error executing tool {tool_name} on handler {plugin_id}: {e}", exc_info=True)
            return f"Error executing plugin tool {tool_name}: {str(e)}"

    async def refresh_tools(self) -> List[StructuredTool]:
        """Refresh initialized plugin tools."""
        await self.initialize()
        return list(self._tools_map.values())

    @property
    def tools(self) -> List[StructuredTool]:
        return list(self._tools_map.values())


# Global PluginManager singleton
plugin_manager = PluginManager()

"""
Tools for managing MCP server connections and registry.
"""
import json
import logging
from typing import Optional, List, Dict, Any, Literal
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from app.config import settings
from app.database import update_setting

logger = logging.getLogger(__name__)

class MCPServerConfig(BaseModel):
    name: str = Field(..., description="Unique name for the MCP server")
    url: Optional[str] = Field(None, description="SSE URL for the MCP server (if using SSE)")
    command: Optional[str] = Field(None, description="Command to run the MCP server (if using Stdio)")
    args: Optional[List[str]] = Field(default_factory=list, description="Arguments for the Stdio command")
    env: Optional[Dict[str, str]] = Field(default_factory=dict, description="Environment variables for the Stdio server")

@tool
def list_mcp_servers() -> str:
    """
    List all configured MCP servers and their current status.
    """
    try:
        servers = settings.MCP_SERVERS
        if not servers:
            return "No MCP servers configured."
        
        output = ["Current MCP Servers:"]
        for s in servers:
            server_type = "SSE" if s.get("url") else "Stdio"
            output.append(f"- **{s.get('name')}** ({server_type})")
            if s.get("url"):
                output.append(f"  URL: {s.get('url')}")
            else:
                output.append(f"  Command: {s.get('command')} {' '.join(s.get('args', []))}")
        
        return "\n".join(output)
    except Exception as e:
        logger.error(f"Error listing MCP servers: {e}")
        return f"Error listing MCP servers: {e}"

@tool
def add_mcp_server(config: Dict[str, Any]) -> str:
    """
    Add a new MCP server configuration.
    
    Args:
        config: A dictionary containing 'name', and either 'url' (for SSE) or 'command' and 'args' (for Stdio).
                Optional 'env' dictionary can be provided for Stdio servers.
    """
    try:
        name = config.get("name")
        if not name:
            return "Error: 'name' is required for the MCP server."
            
        current_servers = settings.MCP_SERVERS
        if any(s.get("name") == name for s in current_servers):
            return f"Error: MCP server with name '{name}' already exists."
        
        # Simple validation
        if not config.get("url") and not config.get("command"):
            return "Error: Either 'url' (SSE) or 'command' (Stdio) must be provided."
            
        new_server = {
            "name": name,
            "url": config.get("url"),
            "command": config.get("command"),
            "args": config.get("args", []),
            "env": config.get("env", {})
        }
        
        current_servers.append(new_server)
        update_setting("MCP_SERVERS", json.dumps(current_servers))
        settings.reload()
        
        return f"Successfully added MCP server: {name}. The agent will re-initialize to include its tools on the next request."
    except Exception as e:
        logger.error(f"Error adding MCP server: {e}")
        return f"Error adding MCP server: {e}"

@tool
def update_mcp_server(name: str, updates: Dict[str, Any]) -> str:
    """
    Update an existing MCP server configuration.
    
    Args:
        name: The name of the MCP server to update.
        updates: A dictionary of fields to update (url, command, args, env, or even name).
    """
    try:
        current_servers = settings.MCP_SERVERS
        server_idx = next((i for i, s in enumerate(current_servers) if s.get("name") == name), -1)
        
        if server_idx == -1:
            return f"Error: MCP server '{name}' not found."
            
        server = current_servers[server_idx]
        for key, value in updates.items():
            if key in ["name", "url", "command", "args", "env"]:
                server[key] = value
        
        current_servers[server_idx] = server
        update_setting("MCP_SERVERS", json.dumps(current_servers))
        settings.reload()
        
        return f"Successfully updated MCP server: {name}. The agent will re-initialize on the next request."
    except Exception as e:
        logger.error(f"Error updating MCP server: {e}")
        return f"Error updating MCP server: {e}"

@tool
def delete_mcp_server(name: str) -> str:
    """
    Delete an MCP server configuration.
    
    Args:
        name: The name of the MCP server to delete.
    """
    try:
        current_servers = settings.MCP_SERVERS
        new_servers = [s for s in current_servers if s.get("name") != name]
        
        if len(new_servers) == len(current_servers):
            return f"Error: MCP server '{name}' not found."
            
        update_setting("MCP_SERVERS", json.dumps(new_servers))
        settings.reload()
        
        return f"Successfully deleted MCP server: {name}. The agent will re-initialize on the next request."
    except Exception as e:
        logger.error(f"Error deleting MCP server: {e}")
        return f"Error deleting MCP server: {e}"

MCP_REGISTRY_TOOLS = [list_mcp_servers, add_mcp_server, update_mcp_server, delete_mcp_server]

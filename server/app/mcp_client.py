import asyncio
import logging
import re
from typing import List, Dict, Any, Optional, Callable, Union
from contextlib import AsyncExitStack
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.sse import sse_client
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, create_model
from app.config import settings

logger = logging.getLogger(__name__)

class ServerConnection:
    """
    Manages a single connection to an MCP server.
    Handles connection lifecycle and reconnection.
    """
    def __init__(self, name: str, config: dict):
        self.name = name
        self.config = config
        self.session: Optional[ClientSession] = None
        self._exit_stack: Optional[AsyncExitStack] = None
        self._lock = asyncio.Lock()

    async def connect(self):
        """Establish connection to the MCP server"""
        async with self._lock:
            if self.session:
                return self.session

            url = self.config.get("url")
            command = self.config.get("command")
            args = self.config.get("args", [])
            env = self.config.get("env")

            if not command and not url:
                raise ValueError(f"MCP server {self.name} configuration missing command or url")

            self._exit_stack = AsyncExitStack()
            await self._exit_stack.__aenter__()

            try:
                if url:
                    logger.info(f"Connecting to SSE MCP server {self.name}: {url}")
                    read, write = await self._exit_stack.enter_async_context(sse_client(url))
                    session = await self._exit_stack.enter_async_context(ClientSession(read, write))
                else:
                    logger.info(f"Connecting to Stdio MCP server {self.name}: {command}")
                    server_params = StdioServerParameters(command=command, args=args, env=env)
                    read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
                    session = await self._exit_stack.enter_async_context(ClientSession(read, write))
                
                await session.initialize()
                self.session = session
                logger.info(f"Successfully connected to MCP server: {self.name}")
                return self.session
            except Exception as e:
                await self.cleanup()
                logger.error(f"Failed to connect to MCP server {self.name}: {e}")
                raise

    async def ensure_connected(self):
        """Ensure connection is alive or reconnect"""
        if not self.session:
            return await self.connect()
        return self.session

    async def cleanup(self):
        """Close connection and clean up resources"""
        if self._exit_stack:
            try:
                await self._exit_stack.__aexit__(None, None, None)
            except Exception as e:
                logger.error(f"Error cleaning up MCP server {self.name}: {e}")
            finally:
                self._exit_stack = None
                self.session = None

    async def call_tool(self, tool_name: str, arguments: dict):
        """Call a tool on this server with automatic reconnection"""
        try:
            session = await self.ensure_connected()
            return await session.call_tool(tool_name, arguments=arguments)
        except Exception as e:
            # Check for common "closed session" errors
            error_str = str(e).lower()
            import anyio
            if isinstance(e, anyio.ClosedResourceError) or "closed" in error_str or "connection" in error_str:
                logger.warning(f"MCP connection for {self.name} lost, attempting to reconnect...")
                await self.cleanup()
                session = await self.connect()
                return await session.call_tool(tool_name, arguments=arguments)
            raise


class MCPManager:
    """
    Manages connections to MCP servers and provides tools to the agent.
    Maintains persistent connections to keep tools functional.
    """
    
    def __init__(self):
        self._tools = []
        self._connections: Dict[str, ServerConnection] = {}
        self._initialized = False

    async def _create_tool_from_mcp(self, connection: ServerConnection, tool_info: Any) -> StructuredTool:
        """
        Create a LangChain tool from MCP tool info with persistent server reference.
        """
        tool_name = tool_info.name
        tool_description = tool_info.description or f"Execute {tool_name}"
        
        # Create dynamic Pydantic model for tool inputs based on inputSchema
        input_schema = tool_info.inputSchema or {}
        properties = input_schema.get("properties", {})
        required = input_schema.get("required", [])
        
        # Build fields dict for Pydantic model
        fields = {}
        for prop_name, prop_info in properties.items():
            # Map JSON schema types to Python types
            schema_type = prop_info.get("type", "string")
            prop_type = {
                "integer": int,
                "number": float,
                "boolean": bool,
                "array": list,
                "object": dict
            }.get(schema_type, str)
                
            prop_description = prop_info.get("description", "")
            prop_default = ... if prop_name in required else None
            
            fields[prop_name] = (
                prop_type, 
                Field(..., description=prop_description) if prop_default is ... else Field(default=prop_default, description=prop_description)
            )
        
        # Create dynamic Pydantic model using create_model
        try:
            # Sanitize tool name for class name (remove non-alphanumeric)
            class_name = re.sub(r'[^a-zA-Z0-9_]', '', tool_name)
            InputModel = create_model(f"{class_name}Input", **fields)
        except Exception as e:
            logger.error(f"Failed to create Pydantic model for tool {tool_name}: {e}")
            InputModel = None
        
        # Create async function that calls the MCP tool through the connection
        async def tool_func(**kwargs):
            """Execute the MCP tool with given arguments"""
            try:
                # Filter out any lingering type info or FieldInfo
                cleaned_kwargs = {
                    k: v for k, v in kwargs.items() 
                    if not isinstance(v, (type, Field.__class__)) and "FieldInfo" not in str(type(v))
                }
                
                logger.info(f"Executing MCP tool {tool_name} with args: {cleaned_kwargs}")
                result = await connection.call_tool(tool_name, arguments=cleaned_kwargs)
                
                # Extract content from result
                if hasattr(result, 'content') and result.content:
                    if isinstance(result.content, list) and len(result.content) > 0:
                        content_item = result.content[0]
                        if hasattr(content_item, 'text'):
                            return content_item.text
                        return str(content_item)
                    return str(result.content)
                    
                return str(result)
            except Exception as e:
                logger.error(f"Error executing MCP tool {tool_name}: {e}", exc_info=True)
                return f"Error executing {tool_name}: {str(e)}"
        
        # Create LangChain StructuredTool
        return StructuredTool(
            name=tool_name,
            description=tool_description,
            coroutine=tool_func,
            args_schema=InputModel if (fields and InputModel) else None
        )

    async def refresh_tools(self) -> List[Any]:
        """
        Refresh the list of tools from all configured MCP servers.
        """
        # Clean up existing connections
        await self.cleanup()
        
        mcp_servers = settings.MCP_SERVERS
        if not mcp_servers:
            self._tools = []
            self._initialized = True
            return []

        all_tools = []

        # Connect to all MCP servers concurrently for faster init
        async def _connect_and_list(i: int, server_config: dict):
            server_name = server_config.get("name", f"server_{i}")
            conn = ServerConnection(server_name, server_config)
            self._connections[server_name] = conn
            session = await conn.connect()
            tools_list = await session.list_tools()
            return conn, tools_list

        results = await asyncio.gather(
            *[_connect_and_list(i, cfg) for i, cfg in enumerate(mcp_servers)],
            return_exceptions=True,
        )

        for i, result in enumerate(results):
            server_name = mcp_servers[i].get("name", f"server_{i}")
            if isinstance(result, Exception):
                logger.error(f"Failed to load tools from server {server_name}: {result}")
                continue
            conn, tools_list = result
            for tool_info in tools_list.tools:
                try:
                    lc_tool = await self._create_tool_from_mcp(conn, tool_info)
                    all_tools.append(lc_tool)
                except Exception as e:
                    logger.error(f"Failed to create tool {tool_info.name}: {e}")
        
        self._tools = all_tools
        self._initialized = True
        logger.info(f"MCP Manager initialized with {len(all_tools)} total tools from {len(self._connections)} server(s)")
        return self._tools

    async def cleanup(self):
        """Clean up all MCP sessions"""
        for conn in self._connections.values():
            await conn.cleanup()
        self._connections = {}
        self._tools = []
        self._initialized = False

    @property
    def tools(self) -> List[Any]:
        """Return currently loaded MCP tools"""
        return self._tools

# Global MCP manager instance
mcp_manager = MCPManager()

import json
import httpx
import logging
from typing import Any, Dict, List, Optional
from langchain_core.tools import StructuredTool
from pydantic import create_model

logger = logging.getLogger(__name__)

# HTTP methods that typically send a request body
BODY_METHODS = {"POST", "PUT", "PATCH"}


def _format_body_template(body_str: str, kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Replace {param_name} placeholders in body JSON string with kwargs, then parse as JSON."""
    try:
        # Use format_map so missing keys leave the placeholder as-is (e.g. {optional})
        class SafeDict(dict):
            def __missing__(self, key):
                return "{" + key + "}"
        filled = body_str.format_map(SafeDict(**kwargs))
        return json.loads(filled)
    except (json.JSONDecodeError, KeyError) as e:
        logger.warning(f"Body template format failed: {e}")
        return json.loads(body_str)


async def call_external_api(
    url: str,
    method: str = "GET",
    headers: Optional[Dict[str, str]] = None,
    body: Optional[str] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """
    Makes an asynchronous HTTP request to an external API.

    - URL: can contain placeholders like {param_name}, replaced by kwargs.
    - method: GET, POST, PUT, PATCH, or DELETE.
    - body: optional JSON string for POST/PUT/PATCH. Use {param_name} for values
      filled from kwargs. If omitted for those methods, kwargs are sent as the JSON body.
    - GET/DELETE: kwargs are sent as query parameters (params).
    """
    try:
        formatted_url = url.format(**kwargs)
        method_upper = method.upper()

        # Build request body for POST/PUT/PATCH
        request_json: Optional[Dict[str, Any]] = None
        if method_upper in BODY_METHODS:
            if body and body.strip():
                request_json = _format_body_template(body.strip(), kwargs)
            else:
                request_json = kwargs

        async with httpx.AsyncClient(timeout=30.0) as client:
            if method_upper == "GET":
                response = await client.get(formatted_url, headers=headers, params=kwargs)
            elif method_upper == "POST":
                response = await client.post(formatted_url, headers=headers, json=request_json)
            elif method_upper == "PUT":
                response = await client.put(formatted_url, headers=headers, json=request_json)
            elif method_upper == "PATCH":
                response = await client.patch(formatted_url, headers=headers, json=request_json)
            elif method_upper == "DELETE":
                # Some APIs accept a body for DELETE; send params only by default
                response = await client.delete(formatted_url, headers=headers, params=kwargs)
            else:
                return {"error": f"Unsupported HTTP method: {method}"}

            response.raise_for_status()
            try:
                return response.json()
            except Exception:
                return {"text": response.text}

    except Exception as e:
        logger.error(f"External API call failed: {e}")
        return {"error": str(e)}

def create_external_tool(config: Dict[str, Any]) -> StructuredTool:
    """
    Creates a LangChain StructuredTool from a custom API configuration.

    Config keys: name, description, url, method (GET|POST|PUT|PATCH|DELETE),
    headers (dict), body (optional JSON string for POST/PUT/PATCH with {param} placeholders),
    parameters_schema (optional JSON schema for tool args).
    """
    name = config.get("name", "custom_tool")
    description = config.get("description", "A custom external tool")
    url = config.get("url", "")
    method = config.get("method", "GET")
    headers = config.get("headers") or {}
    body = config.get("body")

    async def tool_func(**kwargs: Any) -> Any:
        return await call_external_api(url, method, headers, body=body, **kwargs)

    return StructuredTool.from_function(
        func=None,
        coroutine=tool_func,
        name=name,
        description=description,
    )

def get_external_tools(configs: List[Dict[str, Any]]) -> List[StructuredTool]:
    """
    Converts a list of configurations into StructuredTool objects.
    """
    tools = []
    for config in configs:
        try:
            if isinstance(config, dict) and config.get("enabled", True) is False:
                continue
            tools.append(create_external_tool(config))
        except Exception as e:
            logger.error(f"Failed to create external tool {config.get('name')}: {e}")
    return tools

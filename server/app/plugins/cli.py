"""
Plugin Developer CLI Tool for RIE Plugin SDK.
Generates template scaffolding, validates manifests, and lists installed plugins.
Usage:
    python -m app.plugins.cli create <plugin_id> [--name "Display Name"] [--category "Category"]
    python -m app.plugins.cli validate <plugin_id>
    python -m app.plugins.cli list
"""
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Optional

MANIFEST_TEMPLATE = {
    "manifest_version": 1,
    "id": "{plugin_id}",
    "name": "{plugin_id}",
    "displayName": "{display_name}",
    "version": "1.0.0",
    "description": "Integration plugin for {display_name}.",
    "category": "{category}",
    "icon": "{plugin_id}",
    "auth_type": "oauth2",
    "scopes": [
        "Read access to {display_name}",
        "Write access to {display_name}"
    ],
    "default_scopes": ["read", "write"],
    "tools": [
        {
          "name": "{plugin_id}_search",
          "description": "Search items in {display_name}.",
          "risk_level": "read",
          "capability": "{plugin_id}.read",
          "parameters": {
            "type": "object",
            "properties": {
              "query": { "type": "string", "description": "Search query filter." }
            },
            "required": ["query"]
          }
        },
        {
          "name": "{plugin_id}_create_item",
          "description": "Create a new item in {display_name}.",
          "risk_level": "write",
          "capability": "{plugin_id}.write",
          "parameters": {
            "type": "object",
            "properties": {
              "title": { "type": "string", "description": "Item title." },
              "description": { "type": "string", "description": "Item description details." }
            },
            "required": ["title"]
          }
        }
    ]
}

HANDLER_TEMPLATE = """\"\"\"
{display_name} Integration Plugin Handler.
\"\"\"
import httpx
from typing import Dict, Any
from app.plugins.base import BasePluginHandler

class {class_name}PluginHandler(BasePluginHandler):
    async def execute_tool(self, tool_name: str, args: Dict[str, Any], access_token: str, creds: Dict[str, Any]) -> str:
        headers = {{
            "Authorization": f"Bearer {{access_token}}",
            "Accept": "application/json",
            "User-Agent": "RIE-AI-Agent"
        }}

        if tool_name == "{plugin_id}_search":
            query = args.get("query", "")
            return f"Found 2 items in {display_name} matching query '{{query}}'."

        elif tool_name == "{plugin_id}_create_item":
            title = args.get("title", "Untitled")
            return f"Successfully created new item '{{title}}' in {display_name}!"

        return f"Unknown tool '{{tool_name}}' for {display_name} plugin."
"""


def create_plugin(plugin_id: str, display_name: str = None, category: str = "Integrations", plugins_dir: Optional[Path] = None) -> Path:
    """Scaffold new plugin directory with manifest.json and handler.py."""
    plugin_id = plugin_id.lower().replace("-", "_")
    if not display_name:
        display_name = plugin_id.capitalize()

    class_name = "".join([part.capitalize() for part in plugin_id.split("_")])

    if not plugins_dir:
        plugins_dir = Path(__file__).parent
    target_dir = Path(plugins_dir) / plugin_id

    if target_dir.exists():
        print(f"Error: Plugin directory '{target_dir}' already exists.")
        return target_dir

    target_dir.mkdir(parents=True, exist_ok=True)

    manifest_data = json.loads(
        json.dumps(MANIFEST_TEMPLATE)
        .replace("{plugin_id}", plugin_id)
        .replace("{display_name}", display_name)
        .replace("{category}", category)
    )

    manifest_path = target_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, indent=2)

    handler_code = (
        HANDLER_TEMPLATE
        .replace("{plugin_id}", plugin_id)
        .replace("{display_name}", display_name)
        .replace("{class_name}", class_name)
    )

    handler_path = target_dir / "handler.py"
    with open(handler_path, "w", encoding="utf-8") as f:
        f.write(handler_code.strip() + "\n")

    print(f"[OK] Successfully created plugin '{plugin_id}' at {target_dir}")
    print(f"   - Manifest: {manifest_path}")
    print(f"   - Handler:  {handler_path}")
    print(f"\nRestart RIE server to auto-discover '{plugin_id}'!")


def validate_plugin(plugin_id: str) -> bool:
    """Validate manifest schema, risk levels, capabilities, and tool names."""
    plugins_dir = Path(__file__).parent
    target_dir = plugins_dir / plugin_id
    manifest_path = target_dir / "manifest.json"

    if not manifest_path.exists():
        print(f"[FAIL] Error: manifest.json not found for plugin '{plugin_id}' at {manifest_path}")
        return False

    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        errors = []
        if data.get("manifest_version", 0) < 1:
            errors.append("Missing or invalid 'manifest_version' (must be >= 1).")
        if not data.get("id"):
            errors.append("Missing required field 'id'.")
        if not data.get("displayName"):
            errors.append("Missing required field 'displayName'.")

        tools = data.get("tools", [])
        seen_tools = set()
        for t in tools:
            name = t.get("name")
            if not name:
                errors.append("Tool missing 'name' attribute.")
            elif name in seen_tools:
                errors.append(f"Duplicate tool name '{name}'.")
            else:
                seen_tools.add(name)

            risk = t.get("risk_level", "read")
            if risk not in ("read", "write", "destructive"):
                errors.append(f"Tool '{name}' has invalid risk_level '{risk}'. Expected 'read', 'write', or 'destructive'.")

            if not t.get("capability"):
                errors.append(f"Tool '{name}' is missing declared 'capability' string.")

        if errors:
            print(f"[FAIL] Validation failed for plugin '{plugin_id}':")
            for err in errors:
                print(f"   - {err}")
            return False

        print(f"[OK] Plugin '{plugin_id}' ({data.get('displayName')}) manifest is valid!")
        print(f"   - Manifest Version: {data.get('manifest_version')}")
        print(f"   - Tools Verified:   {len(tools)} tools ({', '.join(seen_tools)})")
        return True

    except Exception as e:
        print(f"[FAIL] Error parsing manifest.json: {e}")
        return False


def list_plugins():
    """List all installed/discovered plugin folders and tool summaries."""
    plugins_dir = Path(__file__).parent
    print("Installed RIE Plugins:\n" + "=" * 40)

    count = 0
    for item in sorted(plugins_dir.iterdir()):
        if item.is_dir() and not item.name.startswith("__") and not item.name.startswith("."):
            manifest_file = item / "manifest.json"
            if manifest_file.exists():
                try:
                    with open(manifest_file, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    print(f"* {data.get('displayName', item.name)} [{item.name}] (v{data.get('version', '1.0.0')})")
                    print(f"  Category: {data.get('category')} | Tools: {len(data.get('tools', []))}")
                    count += 1
                except Exception:
                    pass

    print(f"\nTotal: {count} plugins discovered.")


def main():
    parser = argparse.ArgumentParser(description="RIE Plugin Developer Scaffolding CLI")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    create_parser = subparsers.add_parser("create", help="Create a new plugin template")
    create_parser.add_argument("plugin_id", help="Unique identifier for the plugin (e.g. 'linear', 'hubspot')")
    create_parser.add_argument("--name", help="Display name for the plugin")
    create_parser.add_argument("--category", default="Integrations", help="Category name")

    val_parser = subparsers.add_parser("validate", help="Validate a plugin manifest")
    val_parser.add_argument("plugin_id", help="Plugin ID to validate")

    subparsers.add_parser("list", help="List all installed plugins")

    args = parser.parse_args()
    if args.command == "create":
        create_plugin(args.plugin_id, args.name, args.category)
    elif args.command == "validate":
        success = validate_plugin(args.plugin_id)
        sys.exit(0 if success else 1)
    elif args.command == "list":
        list_plugins()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

"""
Dynamic Plugin Loader for RIE Generic Plugin SDK.
Scans app/server/app/plugins/<plugin_id>/ subdirectories, parses manifest.json,
and registers plugin handlers without modifying core application code.
"""
import importlib
import json
import logging
from pathlib import Path
from typing import Dict, Optional
from app.plugins.base import PluginManifestSpec, BasePluginHandler

logger = logging.getLogger(__name__)


class PluginRegistry:
    """
    Registry that maintains all dynamically discovered plugins and their handlers.
    """
    def __init__(self):
        self.manifests: Dict[str, PluginManifestSpec] = {}
        self.handlers: Dict[str, BasePluginHandler] = {}
        self._loaded = False

    def discover_plugins(self, plugins_dir: Optional[Path] = None):
        """
        Scan plugins directory and register all valid plugin manifests and handlers.
        """
        if not plugins_dir:
            import sys
            if getattr(sys, "frozen", False):
                candidates = [
                    Path(getattr(sys, "_MEIPASS", "")) / "app" / "plugins",
                    Path(sys.executable).parent / "_internal" / "app" / "plugins",
                    Path(sys.executable).parent / "app" / "plugins",
                    Path(__file__).resolve().parent,
                ]
                for cand in candidates:
                    try:
                        if cand.exists() and any(cand.iterdir()):
                            plugins_dir = cand
                            break
                    except Exception:
                        pass
            if not plugins_dir:
                plugins_dir = Path(__file__).resolve().parent

        self.manifests = {}
        self.handlers = {}

        if not plugins_dir.exists():
            logger.warning(f"Plugins directory {plugins_dir} does not exist.")
            return

        for item in plugins_dir.iterdir():
            if item.is_dir() and not item.name.startswith("__") and not item.name.startswith("."):
                manifest_file = item / "manifest.json"
                handler_file = item / "handler.py"

                if manifest_file.exists():
                    try:
                        with open(manifest_file, "r", encoding="utf-8") as f:
                            manifest_data = json.load(f)

                        manifest = PluginManifestSpec(**manifest_data)
                        plugin_id = manifest.id
                        self.manifests[plugin_id] = manifest

                        handler_instance = None
                        if handler_file.exists():
                            try:
                                import importlib.util
                                spec = importlib.util.spec_from_file_location(f"rie_plugin_{item.name}", str(handler_file))
                                if spec and spec.loader:
                                    module = importlib.util.module_from_spec(spec)
                                    spec.loader.exec_module(module)
                                    
                                    # Find class inheriting from BasePluginHandler
                                    for attr_name in dir(module):
                                        attr = getattr(module, attr_name)
                                        if (
                                            isinstance(attr, type)
                                            and issubclass(attr, BasePluginHandler)
                                            and attr is not BasePluginHandler
                                        ):
                                            handler_instance = attr(manifest)
                                            break
                            except Exception as h_err:
                                logger.error(f"Failed to load handler for plugin '{plugin_id}': {h_err}", exc_info=True)

                        if handler_instance:
                            self.handlers[plugin_id] = handler_instance
                        
                        logger.info(f"Successfully loaded plugin '{plugin_id}' ({manifest.displayName}) with {len(manifest.tools)} tools.")
                    except Exception as e:
                        logger.error(f"Failed to load plugin manifest from {item}: {e}", exc_info=True)

        self._loaded = True

    def get_manifest(self, plugin_id: str) -> Optional[PluginManifestSpec]:
        return self.manifests.get(plugin_id)

    def get_handler(self, plugin_id: str) -> Optional[BasePluginHandler]:
        return self.handlers.get(plugin_id)


# Global Plugin Registry singleton
plugin_registry = PluginRegistry()

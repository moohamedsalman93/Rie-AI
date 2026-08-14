"""
RIE Generic Plugin SDK Package.
"""
from app.plugins.loader import plugin_registry

# Discover all plugin folders on module import
plugin_registry.discover_plugins()

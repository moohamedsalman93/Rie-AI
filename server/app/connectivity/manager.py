from typing import Dict, List

from app.connectivity.base import ConnectivityPlugin
from app.connectivity.ngrok import NgrokPlugin


class ConnectivityManager:
    def __init__(self) -> None:
        self._plugins: List[ConnectivityPlugin] = [NgrokPlugin()]

    def resolve_peer(self, peer: Dict[str, str]) -> str:
        for plugin in self._plugins:
            if not plugin.is_available():
                continue
            addr = plugin.resolve(peer)
            if addr:
                return addr
        raise RuntimeError("Peer not reachable by enabled connectivity plugins")


connectivity_manager = ConnectivityManager()

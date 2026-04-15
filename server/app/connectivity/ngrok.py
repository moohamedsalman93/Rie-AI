from typing import Dict, Optional

from app.connectivity.base import ConnectivityPlugin
from app.config import settings


class NgrokPlugin(ConnectivityPlugin):
    @property
    def name(self) -> str:
        return "ngrok"

    def is_available(self) -> bool:
        return settings.CONNECTIVITY_NGROK_ENABLED

    def resolve(self, peer: Dict[str, str]) -> Optional[str]:
        url = (peer.get("public_url") or "").strip()
        return url or None

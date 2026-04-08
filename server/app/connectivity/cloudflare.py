from typing import Dict, Optional

from app.connectivity.base import ConnectivityPlugin
from app.config import settings


class CloudflarePlugin(ConnectivityPlugin):
    @property
    def name(self) -> str:
        return "cloudflare"

    def is_available(self) -> bool:
        return settings.CONNECTIVITY_CLOUDFLARE_ENABLED

    def resolve(self, peer: Dict[str, str]) -> Optional[str]:
        url = (peer.get("cloudflare_public_url") or "").strip()
        if settings.CONNECTIVITY_CLOUDFLARE_NAMED_ONLY and url.endswith(".trycloudflare.com"):
            return None
        return url or None

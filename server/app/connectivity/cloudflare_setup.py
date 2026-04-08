from typing import Any, Dict, Optional

from app.database import update_setting
from app.config import settings


def persist_cloudflare_setup(
    install_path: str,
    public_url: Optional[str] = None,
    tunnel_pid: Optional[int] = None,
    tunnel_hostname: Optional[str] = None,
) -> Dict[str, Any]:
    current_url = public_url or settings.CONNECTIVITY_CLOUDFLARE_PUBLIC_URL or ""
    update_setting("CONNECTIVITY_CLOUDFLARE_ENABLED", "true")
    update_setting("CONNECTIVITY_CLOUDFLARE_INSTALL_PATH", install_path)
    update_setting("CONNECTIVITY_CLOUDFLARE_NAMED_ONLY", "true")
    if tunnel_pid is not None:
        update_setting("CONNECTIVITY_CLOUDFLARE_TUNNEL_PID", str(tunnel_pid))
    if tunnel_hostname:
        update_setting("CONNECTIVITY_CLOUDFLARE_HOSTNAME", tunnel_hostname)
    if current_url:
        update_setting("CONNECTIVITY_CLOUDFLARE_PUBLIC_URL", current_url)
    settings.reload()
    return {
        "enabled": settings.CONNECTIVITY_CLOUDFLARE_ENABLED,
        "public_url": settings.CONNECTIVITY_CLOUDFLARE_PUBLIC_URL,
        "install_path": install_path,
        "tunnel_pid": tunnel_pid,
        "hostname": settings.CONNECTIVITY_CLOUDFLARE_HOSTNAME,
    }

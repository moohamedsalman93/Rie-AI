from typing import Any, Dict, Optional

from app.config import settings
from app.database import update_setting


def persist_ngrok_setup(
    install_path: str,
    public_url: Optional[str] = None,
    tunnel_pid: Optional[int] = None,
    domain: Optional[str] = None,
) -> Dict[str, Any]:
    current_url = public_url or settings.CONNECTIVITY_PUBLIC_URL or ""
    update_setting("CONNECTIVITY_NGROK_ENABLED", "true")
    update_setting("CONNECTIVITY_NGROK_INSTALL_PATH", install_path)
    if tunnel_pid is not None:
        update_setting("CONNECTIVITY_NGROK_TUNNEL_PID", str(tunnel_pid))
    if domain:
        update_setting("CONNECTIVITY_NGROK_DOMAIN", domain)
    if current_url:
        update_setting("CONNECTIVITY_PUBLIC_URL", current_url)
    settings.reload()
    return {
        "enabled": settings.CONNECTIVITY_NGROK_ENABLED,
        "public_url": settings.CONNECTIVITY_PUBLIC_URL,
        "install_path": install_path,
        "tunnel_pid": tunnel_pid,
        "domain": settings.CONNECTIVITY_NGROK_DOMAIN,
    }

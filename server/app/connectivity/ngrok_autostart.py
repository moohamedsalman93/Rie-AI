"""
Best-effort ngrok tunnel autostart when CONNECTIVITY_NGROK_ENABLED is stored in settings.
"""

import logging

from app.config import settings
from app.connectivity.ngrok_installer import (
    detect_existing_ngrok,
    discover_https_url_for_local_port,
    start_tunnel,
)
from app.connectivity.ngrok_setup import persist_ngrok_setup

logger = logging.getLogger(__name__)

_BACKEND_PORT = 14300


def try_start_ngrok_tunnel_on_startup() -> None:
    """
    If connectivity ngrok is enabled and credentials exist, ensure a tunnel exists:
    reuse an ngrok agent already forwarding to this backend port, or spawn one.
    """
    if not settings.CONNECTIVITY_NGROK_ENABLED:
        return

    token = (settings.CONNECTIVITY_NGROK_AUTH_TOKEN or "").strip()
    domain_raw = (settings.CONNECTIVITY_NGROK_DOMAIN or "").strip()
    domain = domain_raw or None

    resolved_path = (settings.CONNECTIVITY_NGROK_INSTALL_PATH or "").strip()
    if not resolved_path:
        det = detect_existing_ngrok()
        resolved_path = (det.get("path") or "").strip()

    existing_url = discover_https_url_for_local_port(_BACKEND_PORT)
    if existing_url:
        if resolved_path:
            try:
                persist_ngrok_setup(
                    resolved_path,
                    public_url=existing_url,
                    tunnel_pid=None,
                    domain=domain,
                )
            except Exception:
                logger.exception("ngrok: failed to persist discovered tunnel URL")
        logger.info("ngrok: using existing tunnel -> %s", existing_url)
        return

    if not token:
        logger.info(
            "ngrok autostart skipped: CONNECTIVITY_NGROK_ENABLED but CONNECTIVITY_NGROK_AUTH_TOKEN is empty",
        )
        return

    if not resolved_path:
        logger.warning(
            "ngrok autostart skipped: ngrok binary not found (install from Connectivity settings)",
        )
        return

    result = start_tunnel(resolved_path, token, domain, backend_port=_BACKEND_PORT)
    if not result.get("ok"):
        logger.warning(
            "ngrok autostart failed: %s",
            result.get("message") or result,
        )
        return

    pub = result.get("public_url")
    pid = result.get("pid")
    try:
        persist_ngrok_setup(resolved_path, public_url=pub, tunnel_pid=pid, domain=domain)
        logger.info("ngrok tunnel autostarted pid=%s url=%s", pid, pub)
    except Exception:
        logger.exception("ngrok tunnel started but persisting settings failed")

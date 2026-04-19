"""Shared timeouts for peer HTTP calls (friend ask hits full agent inference)."""

import httpx

# Peer runs agent_manager.invoke — allow cold starts and slow models (status_ping stays fast).
PEER_HTTP_ASK_TIMEOUT = httpx.Timeout(180.0, connect=30.0)

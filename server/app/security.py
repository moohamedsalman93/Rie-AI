import os
import logging
import secrets
from fastapi import Request, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from starlette.status import HTTP_403_FORBIDDEN

logger = logging.getLogger(__name__)

API_KEY_NAME = "X-Rie-App-Token"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# Routes exempt from internal desktop app token check (e.g. peer routes, browser OAuth callbacks)
PEER_AUTH_EXEMPT_PATHS = (
    "/connectivity/peer/receive",
    "/connectivity/peer/receive/stream",
    "/connectivity/peer/receive/stream/cancel",
    "/connectivity/pair/finalize",
    "/api/plugins/oauth/callback",
)

async def verify_app_token(request: Request = None, api_key: str = Security(api_key_header)):
    """
    Verify the RIE_APP_TOKEN from environment matches the request header.
    If RIE_APP_TOKEN is not set, we allow the request (for dev/local run without tauri).
    """
    if request is None:
        return None

    # Browser CORS preflight must be allowed through so CORSMiddleware can respond.
    if getattr(request, "method", None) == "OPTIONS":
        return None

    path = request.url.path
    if path in PEER_AUTH_EXEMPT_PATHS:
        return None

    expected_token = os.environ.get("RIE_APP_TOKEN")
    if not expected_token:
        # If no token is set in ENV, we assume it's running in a trusted environment (dev)
        # and don't enforce token validation.
        return None
        
    if api_key and secrets.compare_digest(api_key, expected_token):
        return api_key
    
    logger.warning("Unauthorized access attempt with invalid token.")
    raise HTTPException(
        status_code=HTTP_403_FORBIDDEN, detail="Could not validate credentials"
    )


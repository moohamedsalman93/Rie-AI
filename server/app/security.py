import os
import logging
from fastapi import Request, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from starlette.status import HTTP_403_FORBIDDEN

logger = logging.getLogger(__name__)

API_TOKEN = os.environ.get("RIE_APP_TOKEN")
API_KEY_NAME = "X-Rie-App-Token"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

# Connectivity peer routes are authenticated by known device id + fingerprint.
PEER_AUTH_EXEMPT_PATHS = (
    "/connectivity/peer/receive",
    "/connectivity/pair/finalize",
)

async def verify_app_token(request: Request, api_key: str = Security(api_key_header)):
    """
    Verify the RIE_APP_TOKEN from environment matches the request header.
    If RIE_APP_TOKEN is not set, we allow the request (for dev/local run without tauri).
    """
    path = request.url.path
    if path in PEER_AUTH_EXEMPT_PATHS:
        return None

    if not API_TOKEN:
        # If no token is set in ENV, we assume it's running in a trusted environment (dev)
        # and don't enforce token validation.
        return None
        
    if api_key == API_TOKEN:
        return api_key
    
    logger.warning(f"Unauthorized access attempt with token: {api_key}")
    raise HTTPException(
        status_code=HTTP_403_FORBIDDEN, detail="Could not validate credentials"
    )

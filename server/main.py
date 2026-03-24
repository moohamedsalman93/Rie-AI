import logging
import logging.config
import sys
import os
import asyncio
from pathlib import Path

# Fix for Windows subprocess: explicitly set ProactorEventLoop
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from app.config import settings

# Set up logging configuration
LOG_CONFIG = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "default": {
            "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        },
        "access": {
            "format": '%(asctime)s - %(name)s - %(levelname)s - %(client_addr)s - "%(request_line)s" %(status_code)s',
        },
    },
    "handlers": {
        "file": {
            "class": "logging.FileHandler",
            "filename": str(settings.LOG_FILE),
            "mode": "w",
            "formatter": "default",
        },
    },
    "loggers": {
        "": {"handlers": ["file"], "level": "INFO"},
        "uvicorn": {"handlers": ["file"], "level": "INFO", "propagate": False},
        "uvicorn.error": {"level": "INFO", "propagate": True},
        "uvicorn.access": {"handlers": ["file"], "level": "INFO", "propagate": False},
    },
}

# Apply logging configuration
logging.config.dictConfig(LOG_CONFIG)
logger = logging.getLogger(__name__)
logger.info(f"Backend starting up... Logging to: {settings.LOG_FILE}")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import router
from app.database import init_db
from app.mcp_client import mcp_manager
from app.scheduler import scheduler_manager

# Initialize database
init_db()

# Create FastAPI application instance
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    debug=settings.DEBUG
)

# Lifecycle event handlers
@app.on_event("startup")
async def startup_event():
    """Start scheduler on app startup"""
    scheduler_manager.start()
    scheduler_manager.reschedule_pending_from_db()

@app.on_event("shutdown")
async def shutdown_event():
    """Clean up MCP sessions and scheduler on app shutdown"""
    logger.info("Shutting down, cleaning up...")
    await mcp_manager.cleanup()
    scheduler_manager.shutdown()

# Configure CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:14200",  # Tauri/Vite dev server
        "http://127.0.0.1:14200",
        "tauri://localhost",  # Tauri production
        "https://tauri.localhost",  # Tauri production HTTPS
        "http://tauri.localhost",  # Tauri production HTTP
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

from app.security import verify_app_token
from fastapi import Depends

# Include routers
app.include_router(router, dependencies=[Depends(verify_app_token)])


if __name__ == "__main__":
    import uvicorn

    # Check if running as a PyInstaller executable
    is_frozen = getattr(sys, 'frozen', False)
    
    if is_frozen:
        # Standardize stdout/stderr to UTF-8 to prevent encoding crashes (e.g. LangGraph printing emojis)
        # Even in windowed mode, Tauri might attach a pipe with default system encoding (CP1252).
        
        def force_utf8(stream_name):
            stream = getattr(sys, stream_name)
            if stream is None:
                # If None, redirect to devnull with UTF-8
                setattr(sys, stream_name, open(os.devnull, 'w', encoding='utf-8'))
            elif hasattr(stream, 'reconfigure'):
                try:
                    # Try to change encoding of existing stream
                    stream.reconfigure(encoding='utf-8', errors='replace')
                except Exception:
                    # If reconfigure fails, replace with devnull
                    setattr(sys, stream_name, open(os.devnull, 'w', encoding='utf-8'))
            else:
                 # Fallback: replace with devnull
                 setattr(sys, stream_name, open(os.devnull, 'w', encoding='utf-8'))

        force_utf8('stdout')
        force_utf8('stderr')

    uvicorn.run(
        app if is_frozen else "main:app",
        host="127.0.0.1",
        port=14300,
        reload=settings.DEBUG if not is_frozen else False,
        use_colors=not is_frozen,  # Disable colors in frozen/windowed mode
        log_config=LOG_CONFIG
    )

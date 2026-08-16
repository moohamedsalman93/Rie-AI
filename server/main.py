import os
import sys

# Windows BLAS thread limiter: Prevents OpenBLAS memory allocation failures on Windows
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"
os.environ["NUMEXPR_NUM_THREADS"] = "1"
os.environ["VECLIB_MAXIMUM_THREADS"] = "1"

import asyncio
import logging
import logging.config
from pathlib import Path

# Fix for Windows subprocess: explicitly set ProactorEventLoop
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

from app.config import settings

# Set up application logging (console and file output)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(str(settings.LOG_FILE), mode="a", encoding="utf-8"),
    ]
)
logger = logging.getLogger("main")
logger.info(f"Backend starting up... Logging to: {settings.LOG_FILE}")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from app.routes import router
from app.database import init_db, is_db_ready, ensure_db_ready, get_db_initialization_status
from app.mcp_client import mcp_manager
from app.scheduler import scheduler_manager, is_scheduler_ready
from app.connectivity.ngrok_autostart import try_start_ngrok_tunnel_on_startup

# Create FastAPI application instance
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    debug=settings.DEBUG
)

# Configure CORS middleware immediately so all endpoints and error handlers are covered
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:14200",
        "http://127.0.0.1:14200",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    ],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Subsystem background status tracker
_subsystem_status = {
    "ngrok": False,
}

@app.get("/health")
async def health_check():
    """Liveness check: returns 200 OK immediately when the FastAPI server is up (<2ms)."""
    return {"status": "ok", "app": settings.APP_NAME, "version": settings.APP_VERSION}

@app.get("/ready")
async def readiness_check():
    """Readiness check: returns 200 OK only when BOTH database and scheduler are initialized."""
    db_ready = is_db_ready()
    sched_ready = is_scheduler_ready()
    ready = db_ready and sched_ready
    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "status": "ready" if ready else "initializing",
            "database": db_ready,
            "scheduler": sched_ready,
        },
    )

@app.get("/status")
async def status_check():
    """Subsystem status check: reports detailed state across background services."""
    db_status = get_db_initialization_status()
    sched_status = "READY" if is_scheduler_ready() else "INITIALIZING"
    ngrok_enabled = getattr(settings, "CONNECTIVITY_NGROK_ENABLED", False)
    ngrok_status = "RUNNING" if _subsystem_status.get("ngrok") else ("DISABLED" if not ngrok_enabled else "STOPPED")

    is_overall_ready = (db_status == "READY" and sched_status == "READY")

    return {
        "status": "ready" if is_overall_ready else ("error" if db_status == "ERROR" else "initializing"),
        "subsystems": {
            "database": db_status,
            "scheduler": sched_status,
            "plugins": "READY",
            "ngrok": ngrok_status,
            "browser": "NOT_INITIALIZED",
            "llm_providers": "LAZY",
        },
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
    }

async def _background_initialization():
    """Run non-critical background initialization without blocking FastAPI startup or /health."""
    try:
        logger.info("Starting background initialization (database, scheduler, ngrok)...")
        # 1. DB initialization in worker thread
        await asyncio.to_thread(init_db)
        logger.info("Database schema initialized.")

        # 2. Scheduler start & pending restore
        scheduler_manager.start()
        scheduler_manager.reschedule_pending_from_db()
        logger.info("Scheduler started.")

        # 3. Ngrok autostart check
        await asyncio.to_thread(try_start_ngrok_tunnel_on_startup)
        _subsystem_status["ngrok"] = getattr(settings, "CONNECTIVITY_NGROK_ENABLED", False)
        logger.info("Ngrok autostart check complete.")
    except Exception as e:
        logger.exception("Error during background initialization: %s", e)

# Lifecycle event handlers
@app.on_event("startup")
async def startup_event():
    """Non-blocking startup: triggers background tasks so server starts listening immediately"""
    asyncio.create_task(_background_initialization())

@app.on_event("shutdown")
async def shutdown_event():
    """Clean up MCP sessions and scheduler on app shutdown"""
    logger.info("Shutting down, cleaning up...")
    # Avoid hanging uvicorn reload if a cleanup routine blocks.
    try:
        await asyncio.wait_for(mcp_manager.cleanup(), timeout=5)
    except asyncio.TimeoutError:
        logger.warning("Timed out while cleaning up MCP sessions during shutdown.")
    except Exception:
        logger.exception("Unexpected error while cleaning up MCP sessions.")

    try:
        scheduler_manager.shutdown()
    except Exception:
        logger.exception("Unexpected error while shutting down scheduler.")

    try:
        from app.agent import agent_manager
        await asyncio.wait_for(agent_manager.shutdown(), timeout=5)
    except Exception:
        logger.exception("Unexpected error while shutting down agent checkpointer.")

from app.security import verify_app_token
from fastapi import Depends
from app.browser.routes import router as browser_router

# Include routers
app.include_router(router, dependencies=[Depends(verify_app_token)])
app.include_router(browser_router)


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
        # Force ProactorEventLoop on Windows even with --reload.
        # uvicorn defaults to SelectorEventLoop when use_subprocess=True,
        # but Playwright/Camoufox need ProactorEventLoop for subprocess spawning.
        # When frozen (PyInstaller), uvicorn's dynamic module loader cannot resolve "app.loop"
        # because PyInstaller bundles modules differently. Since we already set
        # WindowsProactorEventLoopPolicy() at the top, using loop="asyncio" makes
        # uvicorn honor that policy. In dev mode, we use the explicit factory.
        loop=("asyncio" if is_frozen else "app.loop:proactor_loop_factory") if sys.platform == "win32" else "auto",
    )

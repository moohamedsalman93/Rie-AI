"""
Browser Runtime Manager for Rie.
Manages embedded Camoufox runtime dependencies, initialization status, and lifecycle state.
No external server process — Camoufox runs in-process via Playwright.
"""
import logging
from typing import Optional, Dict, Any

from app.browser.models import RuntimeState

logger = logging.getLogger(__name__)


class BrowserRuntimeManager:
    """
    Manages embedded Camoufox browser runtime readiness.

    Unlike the previous REST-server model, the embedded provider runs Camoufox
    in-process via AsyncCamoufox + Playwright. There is no external process, port,
    or health endpoint. Readiness means the Python package is importable and the
    browser binary is available.
    """

    def __init__(self):
        self._state: RuntimeState = RuntimeState.STOPPED
        self._last_error: Optional[str] = None
        self._camoufox_version: Optional[str] = None
        self._is_fetching: bool = False
        self._fetch_error: Optional[str] = None

    @property
    def current_state(self) -> RuntimeState:
        return self._state

    async def check_health(self) -> bool:
        """Check if camoufox package is importable and browser binary is available."""
        try:
            import camoufox  # noqa: F401
            from camoufox import AsyncCamoufox  # noqa: F401

            import sys
            import asyncio
            if sys.platform == "win32":
                try:
                    loop = asyncio.get_running_loop()
                    if not isinstance(loop, asyncio.ProactorEventLoop):
                        logger.warning(
                            f"Windows event loop is '{type(loop).__name__}'. "
                            "Playwright requires WindowsProactorEventLoop for subprocess transports."
                        )
                except RuntimeError:
                    pass

            # Cache version info
            try:
                from camoufox.__version__ import __version__
                self._camoufox_version = str(__version__)
            except Exception:
                self._camoufox_version = "installed"

            return True
        except ImportError:
            return False

    async def ensure_running(self) -> bool:
        """Verify embedded Camoufox runtime is available."""
        if self._state == RuntimeState.READY:
            return True

        self._state = RuntimeState.STARTING

        if await self.check_health():
            self._state = RuntimeState.READY
            self._last_error = None
            logger.info(f"Camoufox embedded runtime ready (version={self._camoufox_version}).")
            return True
        else:
            self._state = RuntimeState.ERROR
            self._last_error = (
                "Camoufox Python package not found. "
                "Install with: pip install camoufox && camoufox fetch"
            )
            logger.error(self._last_error)
            return False

    async def check_browser_binary(self) -> Dict[str, Any]:
        """Check if the Camoufox browser binary (Firefox) is downloaded."""
        try:
            from camoufox.multiversion import list_installed
            installed = list_installed()
            if installed:
                active = installed[0]
                return {
                    "available": True,
                    "version": active.version.full_string if hasattr(active, 'version') else str(active),
                    "path": str(active.path) if hasattr(active, 'path') else None,
                }
            return {"available": False, "version": None, "path": None}
        except Exception as e:
            logger.debug(f"Browser binary check failed: {e}")
            return {"available": False, "version": None, "error": str(e)}

    async def fetch_binary(self) -> Dict[str, Any]:
        """Download/fetch the Camoufox stealth browser executable on demand."""
        if self._is_fetching:
            return {"status": "fetching", "message": "Browser binary download is already in progress."}

        import sys
        import asyncio

        self._is_fetching = True
        self._fetch_error = None
        logger.info("Starting on-demand Camoufox browser binary download...")

        try:
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "camoufox", "fetch",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await proc.communicate()

            if proc.returncode == 0:
                logger.info("Camoufox browser binary download successful.")
                self._is_fetching = False
                await self.check_health()
                return {"status": "success", "message": "Browser binary downloaded successfully."}
            else:
                err_msg = stderr.decode().strip() or stdout.decode().strip() or "Fetch process failed."
                logger.error(f"Camoufox fetch failed: {err_msg}")
                self._fetch_error = err_msg
                self._is_fetching = False
                return {"status": "error", "error": err_msg}
        except Exception as e:
            logger.exception("Failed to execute camoufox fetch")
            self._fetch_error = str(e)
            self._is_fetching = False
            return {"status": "error", "error": str(e)}

    async def get_status(self) -> Dict[str, Any]:
        """Return runtime status for backend and frontend Settings UI."""
        is_healthy = await self.check_health()
        browser_info = await self.check_browser_binary()

        if is_healthy:
            self._state = RuntimeState.READY
        elif self._state not in (RuntimeState.STARTING, RuntimeState.ERROR):
            self._state = RuntimeState.STOPPED

        return {
            "provider": "camofox",
            "mode": "embedded",
            "healthy": is_healthy,
            "state": self._state.value,
            "status": self._state.value,
            "camoufox_version": self._camoufox_version,
            "browser_binary": browser_info,
            "is_fetching": self._is_fetching,
            "fetch_error": self._fetch_error,
            "error": self._last_error if not is_healthy else None,
        }

    async def shutdown(self) -> None:
        """Mark runtime as stopped. No external process to terminate."""
        self._state = RuntimeState.STOPPED
        logger.info("Browser runtime manager shut down.")


# Global singleton
runtime_manager = BrowserRuntimeManager()


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
        self._download_percentage: float = 0.0
        self._download_bytes: int = 0
        self._total_bytes: int = 0
        self._download_stage: str = "idle"  # idle, starting, downloading, extracting, completed, error

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

    def _in_process_fetch_sync(self):
        """Perform browser binary download in-process with real-time percentage progress callback."""
        import os
        import sys
        import subprocess

        # Ensure camoufox package is importable before attempting binary fetch
        try:
            import camoufox  # noqa: F401
        except ImportError:
            if getattr(sys, 'frozen', False):
                err_msg = (
                    "Camoufox Python package is not bundled in this executable build. "
                    "Please rebuild the backend binary using update-backend.ps1."
                )
                logger.error(err_msg)
                raise RuntimeError(err_msg)

            logger.info("Camoufox Python package not found. Attempting auto-installation via pip...")
            self._download_stage = "installing_package"
            try:
                res = subprocess.run(
                    [sys.executable, "-m", "pip", "install", "camoufox[geoip]"],
                    capture_output=True,
                    text=True,
                    check=True
                )
                logger.info(f"Successfully installed camoufox package via pip: {res.stdout}")
            except Exception as pip_err:
                err_msg = (
                    f"Camoufox Python package is not installed and auto-installation failed: {pip_err}. "
                    "Please install manually using: pip install camoufox[geoip]"
                )
                logger.error(err_msg)
                raise RuntimeError(err_msg) from pip_err

        import camoufox.pkgman as p
        from camoufox.pkgman import CamoufoxFetcher, webdl
        from camoufox.multiversion import install_versioned

        old_token = getattr(p, "GITHUB_TOKEN", None)
        self._download_stage = "starting"
        self._download_percentage = 0.0
        self._download_bytes = 0
        self._total_bytes = 0

        try:
            # Handle possible GITHUB_TOKEN 401 errors
            try:
                fetcher = CamoufoxFetcher()
            except Exception as auth_err:
                if "401" in str(auth_err) or "Unauthorized" in str(auth_err):
                    logger.warning("GitHub API 401 with GITHUB_TOKEN, retrying without authorization header...")
                    p.GITHUB_TOKEN = None
                    os.environ.pop("GITHUB_TOKEN", None)
                    fetcher = CamoufoxFetcher()
                else:
                    raise auth_err

            def progress_download(file, url):
                self._download_stage = "downloading"
                def cb(downloaded, total):
                    if total > 0:
                        pct = round((downloaded / total) * 100, 1)
                        self._download_percentage = pct
                        self._download_bytes = downloaded
                        self._total_bytes = total
                return webdl(url, buffer=file, progress_callback=cb)

            fetcher.download_file = progress_download

            self._download_stage = "extracting"
            install_versioned(fetcher, replace=True)

            self._download_percentage = 100.0
            self._download_stage = "completed"
            logger.info("Camoufox in-process binary download and extraction complete.")
        finally:
            if old_token is not None:
                p.GITHUB_TOKEN = old_token

    async def fetch_binary(self) -> Dict[str, Any]:
        """Download/fetch the Camoufox stealth browser executable on demand with real-time progress."""
        if self._is_fetching:
            return {"status": "fetching", "message": "Browser binary download is already in progress."}

        import asyncio

        self._is_fetching = True
        self._fetch_error = None
        self._download_percentage = 0.0
        self._download_bytes = 0
        self._total_bytes = 0
        self._download_stage = "starting"
        logger.info("Starting on-demand Camoufox browser binary download...")

        async def _fetch_task():
            try:
                await asyncio.to_thread(self._in_process_fetch_sync)
                self._is_fetching = False
                await self.check_health()
            except Exception as e:
                logger.exception("In-process camoufox fetch failed")
                self._fetch_error = str(e)
                self._download_stage = "error"
                self._is_fetching = False

        asyncio.create_task(_fetch_task())
        return {"status": "started", "message": "Browser binary download started."}

    async def delete_browser_binary(self) -> Dict[str, Any]:
        """Delete/uninstall all downloaded Camoufox stealth browser binaries."""
        if self._is_fetching:
            return {"status": "error", "message": "Cannot delete binary while download is in progress."}

        import shutil
        try:
            from camoufox.multiversion import list_installed, remove_version, BROWSERS_DIR
            installed = list_installed()
            deleted_count = 0

            for ver in installed:
                if hasattr(ver, "path") and ver.path:
                    try:
                        remove_version(ver.path)
                        deleted_count += 1
                    except Exception as e:
                        logger.warning(f"Error deleting version path {ver.path}: {e}")
                        if ver.path.exists():
                            shutil.rmtree(ver.path, ignore_errors=True)
                            deleted_count += 1

            if BROWSERS_DIR.exists():
                shutil.rmtree(BROWSERS_DIR, ignore_errors=True)

            self._download_stage = "idle"
            self._download_percentage = 0.0
            self._download_bytes = 0
            self._total_bytes = 0
            self._last_error = None
            self._fetch_error = None

            logger.info(f"Deleted {deleted_count} Camoufox browser binary installation(s).")
            return {"status": "success", "message": "Browser binary deleted successfully.", "deleted_count": deleted_count}
        except Exception as e:
            logger.exception("Failed deleting Camoufox browser binary")
            return {"status": "error", "message": str(e)}

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
            "download_percentage": self._download_percentage,
            "download_bytes": self._download_bytes,
            "total_bytes": self._total_bytes,
            "download_stage": self._download_stage,
            "fetch_error": self._fetch_error,
            "error": self._last_error if not is_healthy else None,
        }

    async def shutdown(self) -> None:
        """Mark runtime as stopped. No external process to terminate."""
        self._state = RuntimeState.STOPPED
        logger.info("Browser runtime manager shut down.")



# Global singleton
runtime_manager = BrowserRuntimeManager()


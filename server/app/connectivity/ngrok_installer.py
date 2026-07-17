import json
import os
import shutil
import signal
import subprocess
import threading
import time
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.request import urlopen


NGROK_DOWNLOAD_URL = "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip"
_tunnel_process: Optional[subprocess.Popen] = None
_tunnel_pid: Optional[int] = None
_tunnel_url: Optional[str] = None
_tunnel_lock = threading.Lock()


def _install_dir() -> Path:
    base = Path(os.getenv("LOCALAPPDATA", str(Path.home())))
    path = base / "Rie-AI" / "ngrok"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _binary_path() -> Path:
    return _install_dir() / "ngrok.exe"


def _runtime_config_path(auth_token: str) -> Path:
    """
    Build a minimal runtime config to avoid failures from invalid user ngrok.yml.
    """
    path = _install_dir() / "ngrok.runtime.yml"
    content = (
        'version: "3"\n'
        "agent:\n"
        f"  authtoken: {auth_token.strip()}\n"
    )
    path.write_text(content, encoding="utf-8")
    return path


def _run_version(exe_path: str) -> Optional[str]:
    try:
        proc = subprocess.run([exe_path, "version"], capture_output=True, text=True, timeout=10, check=False)
        if proc.returncode == 0:
            return (proc.stdout or proc.stderr).strip()
    except Exception:
        return None
    return None


def detect_existing_ngrok() -> Dict[str, Any]:
    path_in_system = shutil.which("ngrok")
    if path_in_system:
        version = _run_version(path_in_system)
        return {"installed": True, "path": path_in_system, "version": version, "source": "path"}

    local = _binary_path()
    if local.exists():
        version = _run_version(str(local))
        if version:
            return {"installed": True, "path": str(local), "version": version, "source": "localappdata"}

    return {"installed": False, "path": None, "version": None, "source": None}


def install_ngrok_windows() -> Dict[str, Any]:
    steps: List[Dict[str, Any]] = []
    existing = detect_existing_ngrok()
    if existing["installed"]:
        steps.append({"step": "detect_existing", "ok": True, "message": f"Found existing ngrok at {existing['path']}"})
        return {"ok": True, "installed": True, "path": existing["path"], "version": existing["version"], "steps": steps}

    target_path = _binary_path()
    steps.append({"step": "prepare_directory", "ok": True, "message": f"Using install directory: {target_path.parent}"})

    try:
        with urlopen(NGROK_DOWNLOAD_URL, timeout=30) as resp:
            zip_bytes = resp.read()
        with zipfile.ZipFile(BytesIO(zip_bytes)) as zf:
            zf.extract("ngrok.exe", path=target_path.parent)
        steps.append({"step": "download_extract", "ok": True, "message": f"Downloaded ngrok to {target_path}"})
    except Exception as exc:
        steps.append({"step": "download_extract", "ok": False, "message": f"Download failed: {exc}"})
        return {"ok": False, "installed": False, "path": None, "version": None, "steps": steps}

    version = _run_version(str(target_path))
    if not version:
        steps.append({"step": "verify", "ok": False, "message": "Installed binary failed version check"})
        return {"ok": False, "installed": False, "path": str(target_path), "version": None, "steps": steps}

    steps.append({"step": "verify", "ok": True, "message": version})
    return {"ok": True, "installed": True, "path": str(target_path), "version": version, "steps": steps}


def _is_running(proc: Optional[subprocess.Popen]) -> bool:
    return bool(proc and proc.poll() is None)


def _tunnel_config_addr(tunnel: Dict[str, Any]) -> str:
    cfg = tunnel.get("config")
    if isinstance(cfg, dict):
        return str(cfg.get("addr") or cfg.get("Addr") or "")
    return ""


def discover_https_url_for_local_port(backend_port: int = 14300) -> Optional[str]:
    """
    If an ngrok agent is listening on 4040 and already exposes this backend port,
    return its https public URL. Used on startup to avoid spawning a duplicate agent.
    """
    port_fragment = f":{backend_port}"
    try:
        with urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        tunnels = data.get("tunnels") if isinstance(data, dict) else []
        if not isinstance(tunnels, list):
            return None
        candidates: List[Dict[str, str]] = []
        for tunnel in tunnels:
            if not isinstance(tunnel, dict):
                continue
            addr = _tunnel_config_addr(tunnel)
            # Match ":14300" only — avoid false positives like port 214300 (endswith "14300").
            if port_fragment not in addr:
                continue
            public_url = str(tunnel.get("public_url") or "").strip()
            proto = str(tunnel.get("proto") or "").strip().lower()
            if not public_url:
                continue
            candidates.append({"url": public_url, "proto": proto})
        for pref in ("https",):
            for c in candidates:
                if c["proto"] == pref:
                    return c["url"]
        return candidates[0]["url"] if candidates else None
    except Exception:
        return None


def _discover_tunnel_url() -> Optional[str]:
    try:
        with urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        tunnels = data.get("tunnels") if isinstance(data, dict) else []
        if not isinstance(tunnels, list):
            return None
        for tunnel in tunnels:
            if not isinstance(tunnel, dict):
                continue
            public_url = str(tunnel.get("public_url") or "").strip()
            proto = str(tunnel.get("proto") or "").strip().lower()
            if proto == "https" and public_url:
                return public_url
        for tunnel in tunnels:
            if not isinstance(tunnel, dict):
                continue
            public_url = str(tunnel.get("public_url") or "").strip()
            if public_url:
                return public_url
    except Exception:
        return None
    return None


def start_tunnel(
    ngrok_path: str,
    auth_token: str,
    domain: Optional[str] = None,
    backend_port: int = 14300,
) -> Dict[str, Any]:
    global _tunnel_process, _tunnel_pid, _tunnel_url
    with _tunnel_lock:
        if _is_running(_tunnel_process):
            return {"ok": True, "running": True, "pid": _tunnel_pid, "public_url": _tunnel_url}
        if not auth_token or not auth_token.strip():
            return {"ok": False, "running": False, "pid": None, "public_url": None, "message": "ngrok auth token is required"}

        runtime_config = _runtime_config_path(auth_token)
        command = [
            ngrok_path,
            "http",
            str(backend_port),
            "--config",
            str(runtime_config),
            "--log",
            "stdout",
        ]
        normalized_domain = (domain or "").strip()
        if normalized_domain:
            command.extend(["--domain", normalized_domain])

        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        _tunnel_process = proc
        _tunnel_pid = proc.pid

        deadline = time.time() + 20
        while time.time() < deadline:
            if proc.poll() is not None:
                return {
                    "ok": False,
                    "running": False,
                    "pid": proc.pid,
                    "public_url": None,
                    "message": "ngrok tunnel exited during startup",
                }
            discovered = _discover_tunnel_url()
            if discovered:
                _tunnel_url = discovered
                return {"ok": True, "running": True, "pid": proc.pid, "public_url": discovered}
            time.sleep(0.3)

        return {
            "ok": False,
            "running": True,
            "pid": proc.pid,
            "public_url": None,
            "message": "Timed out waiting for ngrok tunnel startup",
        }


def _terminate_pid(pid: int, timeout_seconds: float = 5.0) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                    check=False,
                )
            except Exception:
                return False
        else:
            return False
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            os.kill(pid, 0)
        except OSError:
            return True
        except Exception:
            return True
        time.sleep(0.15)
    return False


def stop_tunnel(pid_hint: Optional[int] = None) -> Dict[str, Any]:
    global _tunnel_process, _tunnel_pid, _tunnel_url
    with _tunnel_lock:
        stopped = False
        message = "ngrok tunnel is not running"
        active_pid = _tunnel_pid

        if _is_running(_tunnel_process):
            assert _tunnel_process is not None
            active_pid = _tunnel_process.pid
            try:
                _tunnel_process.terminate()
                _tunnel_process.wait(timeout=5)
            except Exception:
                try:
                    _tunnel_process.kill()
                    _tunnel_process.wait(timeout=3)
                except Exception:
                    pass
            stopped = not _is_running(_tunnel_process)
            message = "ngrok tunnel stopped" if stopped else "ngrok tunnel did not stop cleanly"

        if not stopped and pid_hint:
            stopped = _terminate_pid(int(pid_hint))
            if stopped:
                active_pid = int(pid_hint)
                message = "ngrok tunnel stopped via persisted PID"
            else:
                message = "failed to stop ngrok tunnel via persisted PID"

        _tunnel_process = None
        _tunnel_pid = None
        _tunnel_url = None
        running = bool(discover_https_url_for_local_port())
        return {
            "ok": stopped or not running,
            "running": running,
            "pid": active_pid,
            "public_url": None,
            "message": message if not running else "ngrok tunnel still appears active",
        }


def get_tunnel_runtime_status(backend_port: int = 14300) -> Dict[str, Any]:
    """
    Tunnel is considered running if either this process spawned ngrok, or the local
    ngrok agent (4040) already forwards to backend_port — e.g. after uvicorn reload
    or autostart that only persisted the URL without attaching in-memory state.
    """
    with _tunnel_lock:
        subprocess_running = _is_running(_tunnel_process)
        discovered_port = discover_https_url_for_local_port(backend_port)

        live_url: Optional[str] = None
        if subprocess_running:
            live_url = _discover_tunnel_url()
        if not live_url and discovered_port:
            live_url = discovered_port

        global _tunnel_url
        effective_running = subprocess_running or bool(discovered_port)
        effective_url = live_url or _tunnel_url or discovered_port
        if effective_url:
            _tunnel_url = effective_url

        return {
            "running": effective_running,
            "pid": _tunnel_pid if subprocess_running else None,
            "public_url": effective_url,
        }

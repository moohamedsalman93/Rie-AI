import os
import shutil
import subprocess
import threading
import time
import base64
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.request import urlopen


CLOUDFLARED_DOWNLOAD_URL = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
_tunnel_process: Optional[subprocess.Popen] = None
_tunnel_pid: Optional[int] = None
_tunnel_url: Optional[str] = None
_tunnel_lock = threading.Lock()


def _install_dir() -> Path:
    base = Path(os.getenv("LOCALAPPDATA", str(Path.home())))
    path = base / "Rie-AI" / "cloudflared"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _binary_path() -> Path:
    return _install_dir() / "cloudflared.exe"


def _run_version(exe_path: str) -> Optional[str]:
    try:
        proc = subprocess.run([exe_path, "--version"], capture_output=True, text=True, timeout=10, check=False)
        if proc.returncode == 0:
            return (proc.stdout or proc.stderr).strip()
    except Exception:
        return None
    return None


def detect_existing_cloudflared() -> Dict[str, Any]:
    path_in_system = shutil.which("cloudflared")
    if path_in_system:
        version = _run_version(path_in_system)
        return {"installed": True, "path": path_in_system, "version": version, "source": "path"}

    local = _binary_path()
    if local.exists():
        version = _run_version(str(local))
        if version:
            return {"installed": True, "path": str(local), "version": version, "source": "localappdata"}

    return {"installed": False, "path": None, "version": None, "source": None}


def install_cloudflared_windows() -> Dict[str, Any]:
    steps: List[Dict[str, Any]] = []
    existing = detect_existing_cloudflared()
    if existing["installed"]:
        steps.append({"step": "detect_existing", "ok": True, "message": f"Found existing cloudflared at {existing['path']}"})
        return {"ok": True, "installed": True, "path": existing["path"], "version": existing["version"], "steps": steps}

    target_path = _binary_path()
    steps.append({"step": "prepare_directory", "ok": True, "message": f"Using install directory: {target_path.parent}"})

    try:
        with urlopen(CLOUDFLARED_DOWNLOAD_URL, timeout=30) as resp:
            data = resp.read()
        target_path.write_bytes(data)
        steps.append({"step": "download", "ok": True, "message": f"Downloaded cloudflared to {target_path}"})
    except Exception as exc:
        steps.append({"step": "download", "ok": False, "message": f"Download failed: {exc}"})
        return {"ok": False, "installed": False, "path": None, "version": None, "steps": steps}

    version = _run_version(str(target_path))
    if not version:
        steps.append({"step": "verify", "ok": False, "message": "Installed binary failed version check"})
        return {"ok": False, "installed": False, "path": str(target_path), "version": None, "steps": steps}

    steps.append({"step": "verify", "ok": True, "message": version})
    return {"ok": True, "installed": True, "path": str(target_path), "version": version, "steps": steps}


def _is_running(proc: Optional[subprocess.Popen]) -> bool:
    return bool(proc and proc.poll() is None)


def _decode_jwt_payload(token: str) -> Dict[str, Any]:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("utf-8")).decode("utf-8")
        obj = json.loads(decoded)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def _read_tunnel_output(proc: subprocess.Popen, state: Dict[str, Any]) -> None:
    stream = proc.stdout
    if stream is None:
        return
    for line in iter(stream.readline, ""):
        if not line:
            break
        if "https://" in line and state.get("hostname"):
            state["url"] = f"https://{state['hostname']}"
            break


def infer_hostname_from_token(token: str) -> Optional[str]:
    payload = _decode_jwt_payload(token)
    for key in ("hostname", "host", "tunnel_hostname"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def start_named_tunnel(cloudflared_path: str, tunnel_token: str, hostname: str, backend_url: str = "http://127.0.0.1:14300") -> Dict[str, Any]:
    global _tunnel_process, _tunnel_pid, _tunnel_url
    with _tunnel_lock:
        if _is_running(_tunnel_process):
            return {"ok": True, "running": True, "pid": _tunnel_pid, "public_url": _tunnel_url}
        if not tunnel_token or not tunnel_token.strip():
            return {"ok": False, "running": False, "pid": None, "public_url": None, "message": "Tunnel token is required"}
        if not hostname or not hostname.strip():
            return {"ok": False, "running": False, "pid": None, "public_url": None, "message": "Named tunnel hostname inference failed"}

        proc = subprocess.Popen(
            [cloudflared_path, "tunnel", "--no-autoupdate", "--url", backend_url, "run", "--token", tunnel_token],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        _tunnel_process = proc
        _tunnel_pid = proc.pid
        state: Dict[str, Any] = {"url": None, "hostname": hostname}
        thread = threading.Thread(target=_read_tunnel_output, args=(proc, state), daemon=True)
        thread.start()
        deadline = time.time() + 20
        while time.time() < deadline:
            if proc.poll() is not None:
                return {
                    "ok": False,
                    "running": False,
                    "pid": proc.pid,
                    "public_url": None,
                    "message": "cloudflared named tunnel exited during startup",
                }
            if state["url"]:
                _tunnel_url = state["url"]
                return {"ok": True, "running": True, "pid": proc.pid, "public_url": state["url"]}
            time.sleep(0.2)
        return {
            "ok": False,
            "running": True,
            "pid": proc.pid,
            "public_url": None,
            "message": "Timed out waiting for named tunnel startup",
        }


def get_tunnel_runtime_status() -> Dict[str, Any]:
    with _tunnel_lock:
        running = _is_running(_tunnel_process)
        return {
            "running": running,
            "pid": _tunnel_pid if running else None,
            "public_url": _tunnel_url if running else _tunnel_url,
        }

"""
On-Demand Plugin & Extension Manager for Rie-AI Workstream.
Handles discovery, auto-bundling, auto-injection for IDE & Terminal,
and assisted loading for Chromium browsers.
"""
from dataclasses import dataclass, field
import json
import logging
import os
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional
import urllib.request
import zipfile

logger = logging.getLogger("workstream.plugin_manager")

PLUGIN_VERSION = "0.1.0"
DEFAULT_RELEASE_REPO = "moohammd-basith/Rie-AI"

USER_HOME = Path(os.path.expanduser("~"))
RIE_HOME = USER_HOME / ".rie"
RIE_PLUGINS_CACHE = RIE_HOME / "plugins" / "cache"
RIE_SHELL_DIR = RIE_HOME / "shell"
RIE_BROWSER_EXT_DIR = RIE_HOME / "extensions" / "browser"


def _get_project_extensions_root() -> Optional[Path]:
    """Finds the bundled app/extensions directory in source or packaged modes."""
    # 1. Direct server bundled path: app/server/extensions
    server_bundled = Path(__file__).resolve().parent.parent.parent / "extensions"
    if server_bundled.is_dir() and (server_bundled / "vscode").is_dir():
        return server_bundled

    # 2. PyInstaller / Frozen executable bundle
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            for cand in [Path(meipass) / "extensions", Path(meipass) / "app" / "extensions"]:
                if cand.is_dir() and (cand / "vscode").is_dir():
                    return cand
        exe_parent = Path(sys.executable).parent
        for cand in [exe_parent / "extensions", exe_parent / "app" / "extensions"]:
            if cand.is_dir() and (cand / "vscode").is_dir():
                return cand

    # 3. Check traversing upwards from this file
    current = Path(__file__).resolve().parent
    for _ in range(7):
        cand = current / "app" / "extensions"
        if cand.is_dir() and (cand / "vscode").is_dir():
            return cand
        cand_direct = current / "extensions"
        if cand_direct.is_dir() and (cand_direct / "vscode").is_dir():
            return cand_direct
        parent = current.parent
        if parent == current:
            break
        current = parent

    # 4. Check current working directory
    cwd = Path.cwd()
    for cand in [cwd / "app" / "extensions", cwd / "extensions"]:
        if cand.is_dir() and (cand / "vscode").is_dir():
            return cand

    return None


class PluginManager:
    """Manages bundled companion plugins, auto-injection, and browser extensions."""

    def __init__(self):
        RIE_PLUGINS_CACHE.mkdir(parents=True, exist_ok=True)
        RIE_SHELL_DIR.mkdir(parents=True, exist_ok=True)
        RIE_BROWSER_EXT_DIR.mkdir(parents=True, exist_ok=True)

    # -------------------------------------------------------------
    # STATUS CHECKS
    # -------------------------------------------------------------
    def get_status(self) -> Dict[str, Any]:
        """Returns the installation and readiness status of all companion plugins."""
        ide_status = self.check_ide_installed()
        terminal_status = self.check_terminal_installed()
        browser_status = self.check_browser_prepared()

        # If running on a new device or plugins not yet injected, auto-inject them automatically!
        if not ide_status.get("installed") or not terminal_status.get("installed") or not browser_status.get("prepared"):
            try:
                self.auto_inject_all()
                ide_status = self.check_ide_installed()
                terminal_status = self.check_terminal_installed()
                browser_status = self.check_browser_prepared()
            except Exception as auto_err:
                logger.debug("Auto-injection fallback error during get_status: %s", auto_err)

        return {
            "ide": ide_status,
            "terminal": terminal_status,
            "browser": browser_status,
        }

    def check_ide_installed(self) -> Dict[str, Any]:
        """Checks if the Rie companion extension is installed in VS Code, Antigravity, Cursor, etc."""
        target_dirs = self._get_ide_target_dirs()
        installed_editors = []
        installed_paths = []

        for editor_name, path_list in target_dirs.items():
            editor_found = False
            for target_dir in path_list:
                cand_paths = [
                    target_dir / "package.json",
                    target_dir.parent / "rie-context" / "package.json",
                ]
                if target_dir.parent.is_dir():
                    try:
                        for sub in target_dir.parent.iterdir():
                            if sub.is_dir() and "rie" in sub.name.lower():
                                cand_paths.append(sub / "package.json")
                    except Exception:
                        pass

                for pkg in cand_paths:
                    if pkg.is_file():
                        installed_paths.append(str(pkg.parent))
                        editor_found = True
                        break
                if editor_found:
                    break

            if editor_found:
                installed_editors.append(editor_name)

        return {
            "installed": len(installed_editors) > 0,
            "installed_editors": installed_editors,
            "paths": installed_paths,
            "available_targets": list(target_dirs.keys()),
        }

    def check_terminal_installed(self) -> Dict[str, Any]:
        """Checks if PowerShell profile or ~/.bashrc has Rie shell hooks injected."""
        ps_installed = False
        for p in self._get_powershell_profile_candidates():
            if p.is_file():
                try:
                    content = p.read_text(encoding="utf-8", errors="ignore")
                    if "rie-shell-powershell.ps1" in content:
                        ps_installed = True
                        break
                except Exception:
                    pass

        bash_installed = False
        bashrc = USER_HOME / ".bashrc"
        if bashrc.is_file():
            try:
                content = bashrc.read_text(encoding="utf-8", errors="ignore")
                if "rie-shell-bash.sh" in content:
                    bash_installed = True
            except Exception:
                pass

        return {
            "installed": ps_installed or bash_installed,
            "powershell": ps_installed,
            "bash": bash_installed,
        }

    def check_browser_prepared(self) -> Dict[str, Any]:
        """Checks if browser extension files are prepared at ~/.rie/extensions/browser."""
        manifest = RIE_BROWSER_EXT_DIR / "manifest.json"
        is_prepared = manifest.is_file()
        return {
            "prepared": is_prepared,
            "path": str(RIE_BROWSER_EXT_DIR),
        }

    # -------------------------------------------------------------
    # IDE AUTO-INJECTION (VS Code / Antigravity / Cursor)
    # -------------------------------------------------------------
    def install_ide(self) -> Dict[str, Any]:
        """Auto-injects the IDE companion extension into detected editor directories."""
        source_dir = self._acquire_extension_source("vscode")
        if not source_dir or not (source_dir / "package.json").is_file():
            raise RuntimeError("Failed to acquire IDE extension files.")

        target_dirs = self._get_ide_target_dirs()
        injected = []

        for editor_name, path_list in target_dirs.items():
            editor_succeeded = False
            for target_dir in path_list:
                for dest_dir in [target_dir, target_dir.parent / "rie-context"]:
                    try:
                        dest_dir.mkdir(parents=True, exist_ok=True)
                        for item in source_dir.iterdir():
                            if item.name.startswith("."):
                                continue
                            if item.is_file():
                                shutil.copy2(item, dest_dir / item.name)
                            elif item.is_dir():
                                shutil.copytree(item, dest_dir / item.name, dirs_exist_ok=True)
                        editor_succeeded = True
                        logger.info(f"Auto-injected IDE extension to {editor_name}: {dest_dir}")
                    except Exception as e:
                        logger.warning(f"Failed to inject to {editor_name} ({dest_dir}): {e}")

            if editor_succeeded:
                injected.append(editor_name)

        if not injected:
            # Fallback to standard .vscode/extensions
            default_dir = USER_HOME / ".vscode" / "extensions" / f"rie-companion-{PLUGIN_VERSION}"
            default_dir.mkdir(parents=True, exist_ok=True)
            for item in source_dir.iterdir():
                if not item.name.startswith("."):
                    if item.is_file():
                        shutil.copy2(item, default_dir / item.name)
                    elif item.is_dir():
                        shutil.copytree(item, default_dir / item.name, dirs_exist_ok=True)
            injected.append("VS Code (Default)")

        return {
            "success": True,
            "message": f"Successfully auto-injected companion into {', '.join(injected)}.",
            "injected_editors": injected,
        }

    def uninstall_ide(self) -> Dict[str, Any]:
        """Removes the auto-injected IDE companion from all editor extension folders."""
        target_dirs = self._get_ide_target_dirs()
        removed = []
        for editor_name, path_list in target_dirs.items():
            editor_removed = False
            for target_dir in path_list:
                for dest_dir in [target_dir, target_dir.parent / "rie-context"]:
                    if dest_dir.exists():
                        try:
                            shutil.rmtree(dest_dir)
                            editor_removed = True
                        except Exception as e:
                            logger.warning(f"Failed to remove {dest_dir}: {e}")
            if editor_removed:
                removed.append(editor_name)

        return {
            "success": True,
            "message": f"Removed IDE companion from {', '.join(removed) if removed else 'none'}.",
            "removed_editors": removed,
        }

    # -------------------------------------------------------------
    # TERMINAL AUTO-INJECTION (PowerShell & Bash)
    # -------------------------------------------------------------
    def install_terminal(self) -> Dict[str, Any]:
        """Auto-injects non-intrusive command hooks into PowerShell profile and Git Bash."""
        source_dir = self._acquire_extension_source("terminal")
        if not source_dir or not (source_dir / "rie-shell-powershell.ps1").is_file():
            raise RuntimeError("Failed to acquire terminal integration scripts.")

        # 1. Copy shell scripts to ~/.rie/shell/
        ps_script = RIE_SHELL_DIR / "rie-shell-powershell.ps1"
        bash_script = RIE_SHELL_DIR / "rie-shell-bash.sh"
        shutil.copy2(source_dir / "rie-shell-powershell.ps1", ps_script)
        if (source_dir / "rie-shell-bash.sh").is_file():
            shutil.copy2(source_dir / "rie-shell-bash.sh", bash_script)

        # 2. Inject hook into PowerShell profiles
        ps_marker_start = "# >>> Rie AI Shell Integration >>>"
        ps_marker_end = "# <<< Rie AI Shell Integration <<<"
        ps_hook_body = (
            f'{ps_marker_start}\n'
            f'if (Test-Path "{ps_script}") {{ . "{ps_script}" }}\n'
            f'{ps_marker_end}\n'
        )

        injected_ps = False
        for p in self._get_powershell_profile_candidates():
            try:
                p.parent.mkdir(parents=True, exist_ok=True)
                existing = p.read_text(encoding="utf-8", errors="ignore") if p.is_file() else ""
                if "rie-shell-powershell.ps1" not in existing:
                    new_content = (existing.rstrip() + "\n\n" + ps_hook_body).lstrip()
                    p.write_text(new_content, encoding="utf-8")
                    injected_ps = True
                    logger.info(f"Injected PowerShell hook into {p}")
            except Exception as e:
                logger.warning(f"Failed to inject PowerShell hook into {p}: {e}")

        # 3. Inject hook into Git Bash ~/.bashrc
        bash_marker_start = "# >>> Rie AI Shell Integration >>>"
        bash_marker_end = "# <<< Rie AI Shell Integration <<<"
        bash_path_posix = str(bash_script).replace("\\", "/")
        bash_hook_body = (
            f'{bash_marker_start}\n'
            f'[ -f "{bash_path_posix}" ] && source "{bash_path_posix}"\n'
            f'{bash_marker_end}\n'
        )

        injected_bash = False
        bashrc = USER_HOME / ".bashrc"
        try:
            existing_bash = bashrc.read_text(encoding="utf-8", errors="ignore") if bashrc.is_file() else ""
            if "rie-shell-bash.sh" not in existing_bash:
                new_bash = (existing_bash.rstrip() + "\n\n" + bash_hook_body).lstrip()
                bashrc.write_text(new_bash, encoding="utf-8")
                injected_bash = True
                logger.info(f"Injected Git Bash hook into {bashrc}")
        except Exception as e:
            logger.warning(f"Failed to inject Git Bash hook into {bashrc}: {e}")

        return {
            "success": True,
            "message": "Terminal hooks injected successfully.",
            "powershell": injected_ps,
            "bash": injected_bash,
        }

    def uninstall_terminal(self) -> Dict[str, Any]:
        """Removes the injected command hooks from PowerShell profiles and ~/.bashrc."""
        cleaned_ps = False
        for p in self._get_powershell_profile_candidates():
            if p.is_file():
                try:
                    lines = p.read_text(encoding="utf-8", errors="ignore").splitlines()
                    filtered = [line for line in lines if "rie-shell-" not in line and "Rie AI Shell Integration" not in line]
                    p.write_text("\n".join(filtered) + "\n", encoding="utf-8")
                    cleaned_ps = True
                except Exception as e:
                    logger.warning(f"Failed to clean {p}: {e}")

        cleaned_bash = False
        bashrc = USER_HOME / ".bashrc"
        if bashrc.is_file():
            try:
                lines = bashrc.read_text(encoding="utf-8", errors="ignore").splitlines()
                filtered = [line for line in lines if "rie-shell-" not in line and "Rie AI Shell Integration" not in line]
                bashrc.write_text("\n".join(filtered) + "\n", encoding="utf-8")
                cleaned_bash = True
            except Exception as e:
                logger.warning(f"Failed to clean {bashrc}: {e}")

        return {
            "success": True,
            "message": "Terminal hooks removed successfully.",
            "powershell": cleaned_ps,
            "bash": cleaned_bash,
        }

    # -------------------------------------------------------------
    # BROWSER EXTENSION PREPARATION & EXPLORER REVEAL
    # -------------------------------------------------------------
    def prepare_browser_extension(self) -> Dict[str, Any]:
        """Copies/unpacks browser extension files to ~/.rie/extensions/browser/."""
        source_dir = self._acquire_extension_source("browser")
        if not source_dir or not (source_dir / "manifest.json").is_file():
            raise RuntimeError("Failed to acquire browser extension files.")

        for item in source_dir.iterdir():
            if item.name.startswith("."):
                continue
            if item.is_file():
                shutil.copy2(item, RIE_BROWSER_EXT_DIR / item.name)
            elif item.is_dir():
                shutil.copytree(item, RIE_BROWSER_EXT_DIR / item.name, dirs_exist_ok=True)

        return {
            "success": True,
            "path": str(RIE_BROWSER_EXT_DIR),
            "manifest": str(RIE_BROWSER_EXT_DIR / "manifest.json"),
        }

    def open_browser_folder(self) -> Dict[str, Any]:
        """Prepares the browser extension and opens Windows Explorer showing the folder."""
        self.prepare_browser_extension()
        folder_str = str(RIE_BROWSER_EXT_DIR)

        try:
            if sys.platform == "win32":
                os.startfile(folder_str)
            else:
                subprocess.Popen(["xdg-open", folder_str])
            return {"success": True, "path": folder_str}
        except Exception as e:
            logger.warning(f"Could not open explorer directly: {e}")
            return {"success": True, "path": folder_str, "warning": str(e)}

    # -------------------------------------------------------------
    # AUTO-INJECT ALL (CALLED ON STARTUP & ON-DEMAND)
    # -------------------------------------------------------------
    def auto_inject_all(self) -> Dict[str, Any]:
        """
        Silently ensures all bundled plugins are injected and prepared on startup:
        1. Prepares browser extension at ~/.rie/extensions/browser.
        2. Auto-injects IDE companion extension into all detected editors.
        3. Auto-injects shell hooks into PowerShell profiles and ~/.bashrc.
        """
        results = {}
        try:
            results["browser"] = self.prepare_browser_extension()
        except Exception as e:
            logger.debug("Auto-prep browser extension: %s", e)
            results["browser"] = {"error": str(e)}

        try:
            results["ide"] = self.install_ide()
        except Exception as e:
            logger.debug("Auto-inject IDE: %s", e)
            results["ide"] = {"error": str(e)}

        try:
            results["terminal"] = self.install_terminal()
        except Exception as e:
            logger.debug("Auto-inject Terminal: %s", e)
            results["terminal"] = {"error": str(e)}

        return results

    # -------------------------------------------------------------
    # HELPER: ACQUIRE SOURCE (LOCAL BUNDLED OR FALLBACK)
    # -------------------------------------------------------------
    def _acquire_extension_source(self, ext_type: str) -> Optional[Path]:
        """
        Acquires extension source directory.
        1. Checks bundled app/extensions/<ext_type> or app/server/extensions/<ext_type>.
        2. Checks cached directory at ~/.rie/plugins/cache/<ext_type>.
        3. Remote download fallback if needed.
        """
        # 1. Bundled extensions check
        project_root = _get_project_extensions_root()
        if project_root:
            local_cand = project_root / ext_type
            if local_cand.is_dir():
                return local_cand

        # 2. Local cache check
        cached_dir = RIE_PLUGINS_CACHE / ext_type
        if cached_dir.is_dir():
            if ext_type == "vscode" and (cached_dir / "package.json").is_file():
                return cached_dir
            if ext_type == "terminal" and (cached_dir / "rie-shell-powershell.ps1").is_file():
                return cached_dir
            if ext_type == "browser" and (cached_dir / "manifest.json").is_file():
                return cached_dir

        # 3. Remote download fallback
        remote_url = f"https://github.com/{DEFAULT_RELEASE_REPO}/releases/download/v{PLUGIN_VERSION}/rie-{ext_type}-plugin.zip"
        zip_path = RIE_PLUGINS_CACHE / f"rie-{ext_type}-plugin.zip"

        try:
            logger.info(f"Downloading {ext_type} plugin from {remote_url}...")
            req = urllib.request.Request(remote_url, headers={"User-Agent": "Rie-AI-Desktop"})
            with urllib.request.urlopen(req, timeout=10) as resp, open(zip_path, "wb") as f:
                shutil.copyfileobj(resp, f)

            cached_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(zip_path, "r") as zip_ref:
                zip_ref.extractall(cached_dir)

            return cached_dir
        except Exception as e:
            logger.warning(f"Remote download failed for {ext_type} plugin: {e}")
            fallback_workspace = Path(os.getcwd()) / "app" / "extensions" / ext_type
            if fallback_workspace.is_dir():
                return fallback_workspace
            return None

    def _get_ide_target_dirs(self) -> Dict[str, List[Path]]:
        """Detects available IDE extension target paths on the user's system."""
        ext_folder_name = f"rie-companion-{PLUGIN_VERSION}"
        targets: Dict[str, List[Path]] = {}

        candidate_roots = [
            ("VS Code", USER_HOME / ".vscode"),
            ("VS Code Insiders", USER_HOME / ".vscode-insiders"),
            ("Antigravity", USER_HOME / ".antigravity"),
            ("Antigravity", USER_HOME / ".antigravity-ide"),
            ("Cursor", USER_HOME / ".cursor"),
            ("Windsurf", USER_HOME / ".windsurf"),
            ("VSCodium", USER_HOME / ".vscode-oss"),
        ]

        for editor_name, base_dir in candidate_roots:
            if base_dir.exists():
                ext_dir = base_dir / "extensions"
                targets.setdefault(editor_name, []).append(ext_dir / ext_folder_name)

        if not targets:
            targets["VS Code"] = [USER_HOME / ".vscode" / "extensions" / ext_folder_name]

        return targets

    def _get_powershell_profile_candidates(self) -> List[Path]:
        """Returns standard PowerShell profile locations on Windows."""
        candidates = []

        # 1. Standard Documents location
        candidates.append(USER_HOME / "Documents" / "WindowsPowerShell" / "Microsoft.PowerShell_profile.ps1")
        candidates.append(USER_HOME / "Documents" / "PowerShell" / "Microsoft.PowerShell_profile.ps1")

        # 2. OneDrive redirected Documents location
        onedrive = os.environ.get("OneDrive") or os.environ.get("OneDriveConsumer")
        if onedrive:
            od_path = Path(onedrive)
            candidates.append(od_path / "Documents" / "WindowsPowerShell" / "Microsoft.PowerShell_profile.ps1")
            candidates.append(od_path / "Documents" / "PowerShell" / "Microsoft.PowerShell_profile.ps1")

        # Deduplicate preserving order
        unique = []
        for c in candidates:
            if c not in unique:
                unique.append(c)
        return unique


plugin_manager = PluginManager()

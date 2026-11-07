# update-backend.ps1
# This script automates rebuilding the Python backend and updating the Tauri sidecar.
# Always uses paths relative to this script (not your shell cwd). Clear other venvs first:
# if another project's venv is active, Poetry can bind PyInstaller to the wrong Python
# (e.g. you would see graphRAG\.venv in the PyInstaller log).

$ErrorActionPreference = "Stop"

$AppRoot = $PSScriptRoot
$ServerDir = Join-Path $AppRoot "server"
$DistDir = Join-Path $ServerDir "dist\rie-backend"
$DistExe = Join-Path $DistDir "rie-backend.exe"
$DistInternal = Join-Path $DistDir "_internal"
$SidecarDir = Join-Path $AppRoot "client\src-tauri\bin"
$SidecarExe = Join-Path $SidecarDir "rie-backend-x86_64-pc-windows-msvc.exe"
$SidecarInternal = Join-Path $SidecarDir "_internal"

Write-Host "--- Stopping background backend processes ---"
try {
    taskkill /F /IM rie-backend.exe /T 2>$null
    taskkill /F /IM rie-backend-x86_64-pc-windows-msvc.exe /T 2>$null
} catch {}

# Do not inherit another repo's activated venv (common cause of wrong PyInstaller environment).
Remove-Item Env:\VIRTUAL_ENV -ErrorAction SilentlyContinue
Remove-Item Env:\VIRTUAL_ENV_PROMPT -ErrorAction SilentlyContinue

Write-Host "`n--- Rebuilding Python Backend (PyInstaller onedir) ---"
Push-Location $ServerDir
try {
    $venv = (poetry env info -p 2>$null | Select-Object -First 1).Trim()
    if (-not $venv) {
        Write-Error "No Poetry env for $ServerDir. Run: cd server; poetry install"
    }
    Write-Host "Using Poetry venv: $venv"
    Write-Host "Syncing backend dependencies..."
    poetry install --no-root

    # Ensure bundled Camoufox browser archive is present in $ServerDir/camoufox.zip
    # Option 2: bundle as a single compressed zip file (~470MB) to stay well under NSIS 2GB mmap limit
    $CamoufoxZip = Join-Path $ServerDir "camoufox.zip"
    $CamoufoxDir = Join-Path $ServerDir "camoufox_browser"
    $CamoufoxExe = Join-Path $CamoufoxDir "camoufox.exe"
    if (-not (Test-Path $CamoufoxZip)) {
        Write-Host "Ensuring Camoufox browser zip archive is available for bundling..."
        if (Test-Path $CamoufoxExe) {
            Write-Host "Compressing local Camoufox directory into $CamoufoxZip..."
            poetry run python -c "
import zipfile, os
src = r'$CamoufoxDir'
dst = r'$CamoufoxZip'
with zipfile.ZipFile(dst, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src)
            zf.write(full, rel)
"
        } else {
            Write-Host "Downloading Camoufox release zip for bundling..."
            curl.exe -L --retry 3 --fail -o $CamoufoxZip "https://github.com/daijro/camoufox/releases/download/v152.0.4-beta.28/camoufox-152.0.4-beta.28-win.x86_64.zip"
        }
    }

    poetry run pyinstaller --noconfirm rie-backend.spec

    # Clean up legacy uncompressed camoufox_browser folder in dist/_internal if present
    $LegacyDistCamoufox = Join-Path $DistInternal "camoufox_browser"
    if (Test-Path $LegacyDistCamoufox) {
        Remove-Item -Recurse -Force $LegacyDistCamoufox
    }
} finally {
    Pop-Location
}

Write-Host "`n--- Updating Tauri Sidecar Binary & Companion Files ---"
if (-not (Test-Path $SidecarDir)) {
    New-Item -ItemType Directory -Path $SidecarDir -Force | Out-Null
}
Copy-Item -Force $DistExe $SidecarExe

if (Test-Path $DistInternal) {
    if (Test-Path $SidecarInternal) {
        Remove-Item -Recurse -Force $SidecarInternal
    }
    Copy-Item -Recurse -Force $DistInternal $SidecarInternal
    $LegacySidecarCamoufox = Join-Path $SidecarInternal "camoufox_browser"
    if (Test-Path $LegacySidecarCamoufox) {
        Remove-Item -Recurse -Force $LegacySidecarCamoufox
    }
}

Write-Host "`n--- Done! Sidecar: $SidecarExe"

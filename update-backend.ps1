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

    # Ensure bundled Camoufox browser binary is present in $ServerDir/camoufox_browser
    $CamoufoxDir = Join-Path $ServerDir "camoufox_browser"
    $CamoufoxExe = Join-Path $CamoufoxDir "camoufox.exe"
    if (-not (Test-Path $CamoufoxExe)) {
        Write-Host "Ensuring Camoufox browser binary is available for bundling..."
        $LocalCacheBrowser = Get-ChildItem -Path "$env:LOCALAPPDATA\camoufox\camoufox\Cache\browsers\*\*" -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName "camoufox.exe") } | Select-Object -First 1
        if ($LocalCacheBrowser) {
            Write-Host "Copying installed Camoufox binary from cache: $($LocalCacheBrowser.FullName)"
            if (-not (Test-Path $CamoufoxDir)) { New-Item -ItemType Directory -Path $CamoufoxDir -Force | Out-Null }
            robocopy $LocalCacheBrowser.FullName $CamoufoxDir /E /NFL /NDL /NP /NJH /NJS | Out-Null
        } else {
            Write-Host "Fetching Camoufox binary via poetry..."
            poetry run python -m camoufox fetch
            $FreshCache = Get-ChildItem -Path "$env:LOCALAPPDATA\camoufox\camoufox\Cache\browsers\*\*" -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName "camoufox.exe") } | Select-Object -First 1
            if ($FreshCache) {
                if (-not (Test-Path $CamoufoxDir)) { New-Item -ItemType Directory -Path $CamoufoxDir -Force | Out-Null }
                robocopy $FreshCache.FullName $CamoufoxDir /E /NFL /NDL /NP /NJH /NJS | Out-Null
            }
        }
    }

    poetry run pyinstaller --noconfirm rie-backend.spec
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
}

Write-Host "`n--- Done! Sidecar: $SidecarExe"

# update-backend.ps1
# This script automates rebuilding the Python backend and updating the Tauri sidecar.

$ErrorActionPreference = "Stop"

Write-Host "--- Stopping background backend processes ---" -ForegroundColor Cyan
try {
    taskkill /F /IM rie-backend.exe /T 2>$null
    taskkill /F /IM rie-backend-x86_64-pc-windows-msvc.exe /T 2>$null
} catch {}

Write-Host "`n--- Rebuilding Python Backend (PyInstaller) ---" -ForegroundColor Cyan
Set-Location ".\server"
poetry run pyinstaller --noconfirm --onefile --windowed --name rie-backend `
    --collect-all deepagents `
    --collect-all langchain_groq `
    --collect-all langchain_google_genai `
    --collect-all langchain_google_vertexai `
    --collect-all chromadb `
    main.py
Set-Location ".."

Write-Host "`n--- Updating Tauri Sidecar Binary ---" -ForegroundColor Cyan
if (-not (Test-Path "client\src-tauri\bin")) {
    New-Item -ItemType Directory -Path "client\src-tauri\bin" -Force
}

copy "server\dist\rie-backend.exe" "client\src-tauri\bin\rie-backend-x86_64-pc-windows-msvc.exe"

Write-Host "`n--- Done! You can now run 'npm run tauri:staging' ---" -ForegroundColor Green

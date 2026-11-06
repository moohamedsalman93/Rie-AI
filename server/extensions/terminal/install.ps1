# Rie Context — Terminal Shell Integration Installer
# Configures PowerShell, Git Bash, and CMD to automatically report command activity to Rie.

param (
    [switch]$InstallPowerShell = $true,
    [switch]$InstallGitBash = $true,
    [switch]$InstallCMD = $false,
    [switch]$Test = $false,
    [switch]$Status = $false,
    [switch]$Uninstall = $false
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$psScriptPath = Join-Path $scriptDir "rie-shell-powershell.ps1"
$bashScriptPath = (Join-Path $scriptDir "rie-shell-bash.sh").Replace("\", "/")
$cmdScriptPath = Join-Path $scriptDir "rie-shell-cmd.bat"

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "  Rie-AI Terminal / Shell Context Integration (2.3) " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# ----------------- STATUS CHECK -----------------
if ($Status) {
    Write-Host "`n[Status Check]" -ForegroundColor Yellow
    
    # PowerShell
    if (Test-Path $PROFILE) {
        $psContent = Get-Content $PROFILE -Raw
        $psActive = $psContent -match "rie-shell-powershell\.ps1"
        Write-Host "  PowerShell ($PROFILE): $(if ($psActive) { '[ACTIVE]' } else { '[NOT INSTALLED]' })" -ForegroundColor $(if ($psActive) { 'Green' } else { 'DarkGray' })
    } else {
        Write-Host "  PowerShell: Profile file does not exist yet" -ForegroundColor DarkGray
    }

    # Git Bash
    $bashrc = [System.IO.Path]::Combine($env:USERPROFILE, ".bashrc")
    if (Test-Path $bashrc) {
        $bashContent = Get-Content $bashrc -Raw
        $bashActive = $bashContent -match "rie-shell-bash\.sh"
        Write-Host "  Git Bash ($bashrc): $(if ($bashActive) { '[ACTIVE]' } else { '[NOT INSTALLED]' })" -ForegroundColor $(if ($bashActive) { 'Green' } else { 'DarkGray' })
    } else {
        Write-Host "  Git Bash: ~/.bashrc file does not exist yet" -ForegroundColor DarkGray
    }
    return
}

# ----------------- TEST CONNECTIVITY -----------------
if ($Test) {
    Write-Host "`n[Testing Terminal Event Submission]..." -ForegroundColor Yellow
    $testPayload = @{
        event_type = "terminal_command"
        shell = "PowerShell (Test)"
        command = "echo 'Hello Rie Terminal Context'"
        cwd = $PWD.Path
        exit_code = 0
        duration = 0.042
        timestamp = [DateTime]::UtcNow.ToString("o")
    } | ConvertTo-Json -Compress

    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:14300/workstream/events" -Method Post -Body $testPayload -ContentType "application/json" -TimeoutSec 3
        Write-Host "  Successfully sent test event! Response: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
        
        $search = Invoke-RestMethod -Uri "http://127.0.0.1:14300/workstream/search?q=Hello+Rie" -Method Get -TimeoutSec 3
        Write-Host "  Search verification found $($search.total_matches) matching events!" -ForegroundColor Green
    } catch {
        Write-Host "  Failed to reach Rie Workstream API at http://127.0.0.1:14300: $_" -ForegroundColor Red
    }
    return
}

# ----------------- UNINSTALL -----------------
if ($Uninstall) {
    Write-Host "`n[Uninstalling Rie Terminal Integrations]..." -ForegroundColor Yellow

    if (Test-Path $PROFILE) {
        $lines = (Get-Content $PROFILE) | Where-Object { $_ -notmatch "rie-shell-powershell\.ps1" }
        Set-Content -Path $PROFILE -Value $lines
        Write-Host "  Removed PowerShell integration from $PROFILE" -ForegroundColor Green
    }

    $bashrc = [System.IO.Path]::Combine($env:USERPROFILE, ".bashrc")
    if (Test-Path $bashrc) {
        $lines = (Get-Content $bashrc) | Where-Object { $_ -notmatch "rie-shell-bash\.sh" }
        Set-Content -Path $bashrc -Value $lines
        Write-Host "  Removed Git Bash integration from $bashrc" -ForegroundColor Green
    }

    Write-Host "`nUninstall complete." -ForegroundColor Green
    return
}

# ----------------- INSTALL POWERSHELL -----------------
if ($InstallPowerShell) {
    Write-Host "`n[Configuring PowerShell]..." -ForegroundColor Yellow
    $profileDir = Split-Path -Parent $PROFILE
    if (-not (Test-Path $profileDir)) {
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    }
    if (-not (Test-Path $PROFILE)) {
        New-Item -ItemType File -Path $PROFILE -Force | Out-Null
    }

    $existingProfile = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($existingProfile -match [regex]::Escape($psScriptPath)) {
        Write-Host "  PowerShell is already configured in $PROFILE" -ForegroundColor Cyan
    } else {
        $hookLine = "`n# Rie Context Shell Integration`nif (Test-Path `"$psScriptPath`") { . `"$psScriptPath`" }`n"
        Add-Content -Path $PROFILE -Value $hookLine
        Write-Host "  Added Rie integration hook to $PROFILE" -ForegroundColor Green
    }
}

# ----------------- INSTALL GIT BASH -----------------
if ($InstallGitBash) {
    Write-Host "`n[Configuring Git Bash]..." -ForegroundColor Yellow
    $bashrc = [System.IO.Path]::Combine($env:USERPROFILE, ".bashrc")
    $existingBashrc = if (Test-Path $bashrc) { Get-Content $bashrc -Raw -ErrorAction SilentlyContinue } else { "" }
    
    if ($existingBashrc -match "rie-shell-bash\.sh") {
        Write-Host "  Git Bash is already configured in $bashrc" -ForegroundColor Cyan
    } else {
        $bashHook = "`n# Rie Context Shell Integration`nif [ -f `"$bashScriptPath`" ]; then`n    source `"$bashScriptPath`"`nfi`n"
        Add-Content -Path $bashrc -Value $bashHook
        Write-Host "  Added Rie integration hook to $bashrc" -ForegroundColor Green
    }
}

# ----------------- INSTALL CMD -----------------
if ($InstallCMD) {
    Write-Host "`n[Configuring CMD (AutoRun)]..." -ForegroundColor Yellow
    try {
        $cmdKey = "HKCU:\Software\Microsoft\Command Processor"
        if (-not (Test-Path $cmdKey)) {
            New-Item -Path $cmdKey -Force | Out-Null
        }
        $existingAutoRun = (Get-ItemProperty -Path $cmdKey -Name AutoRun -ErrorAction SilentlyContinue).AutoRun
        if ($existingAutoRun -match "rie-shell-cmd\.bat") {
            Write-Host "  CMD AutoRun is already configured" -ForegroundColor Cyan
        } else {
            $newAutoRun = if ($existingAutoRun) { "$existingAutoRun & `"$cmdScriptPath`" /init" } else { "`"$cmdScriptPath`" /init" }
            Set-ItemProperty -Path $cmdKey -Name AutoRun -Value $newAutoRun
            Write-Host "  Configured CMD AutoRun registry key to initialize doskey macros automatically" -ForegroundColor Green
        }
    } catch {
        Write-Host "  Could not write to registry: $_" -ForegroundColor DarkGray
        Write-Host "  You can initialize CMD manually anytime with: `"$cmdScriptPath`" /init" -ForegroundColor Cyan
    }
} else {
    Write-Host "`n[CMD Instructions]" -ForegroundColor Yellow
    Write-Host "  To use Rie in CMD:" -ForegroundColor White
    Write-Host "  1. Run 'rie <command>' to execute and track any command" -ForegroundColor Gray
    Write-Host "  2. Or run: & `"$cmdScriptPath`" /init" -ForegroundColor Gray
    Write-Host "  3. To enable CMD AutoRun automatically, run: .\install.ps1 -InstallCMD" -ForegroundColor Gray
}

Write-Host "`n[Installation Summary]" -ForegroundColor Green
Write-Host "  - Executed commands, exit codes, durations, and directories will now be tracked." -ForegroundColor White
Write-Host "  - No keystrokes are captured. Sensitive commands (passwords, tokens) are filtered." -ForegroundColor White
Write-Host "  - Non-blocking HTTP POST ensures 0ms delay to your terminal prompt." -ForegroundColor White
Write-Host "  - Next time you open a terminal, Rie context will be active!" -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

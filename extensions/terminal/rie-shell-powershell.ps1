# Rie Context — PowerShell Shell Integration (Phase 2.3 v2)
# Tracks executed and running commands, cwd, exit code, timestamp, and duration
# Captures command at execution start (Enter key) and completion / Ctrl+C interruption.
# PRESERVES ZERO KEYSTROKE LOGGING (only captures submitted buffer on Enter).

if ($global:__rie_shell_initialized) { return }
$global:__rie_shell_initialized = $true

$global:__rie_last_history_id = -1
$global:__rie_current_cmd = $null
$global:__rie_current_cmd_id = $null
$global:__rie_cmd_start_time = $null
$global:__rie_endpoint = if ($env:RIE_WORKSTREAM_URL) { $env:RIE_WORKSTREAM_URL } else { "http://127.0.0.1:14300/workstream/events" }

# Helper to check if terminal activity tracking is enabled locally and remotely
function global:__rie_is_terminal_enabled {
    if ($global:RIE_TERMINAL_DISABLED) { return $false }
    $cacheFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "rie_workstream_config.json")
    if (Test-Path -LiteralPath $cacheFile) {
        try {
            $raw = Get-Content -LiteralPath $cacheFile -Raw -ErrorAction SilentlyContinue
            if ($raw) {
                $cfg = $raw | ConvertFrom-Json -ErrorAction SilentlyContinue
                if ($cfg) {
                    if ($cfg.workstream -eq $false) { return $false }
                    if ($cfg.sensors -and $cfg.sensors.terminal -eq $false) { return $false }
                }
            }
        } catch { }
    }
    return $true
}

# Helper to dispatch non-blocking HTTP POST on thread pool
function global:__rie_send_event_async($payloadObj) {
    if (-not (global:__rie_is_terminal_enabled)) { return }
    $jsonStr = $payloadObj | ConvertTo-Json -Compress
    [void][System.Threading.ThreadPool]::QueueUserWorkItem({
        param($state)
        try {
            $data, $endpointUrl = $state
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($data)
            $req = [System.Net.WebRequest]::Create($endpointUrl)
            $req.Method = "POST"
            $req.ContentType = "application/json"
            $req.ContentLength = $bytes.Length
            $req.Timeout = 1000
            $stream = $req.GetRequestStream()
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Close()
            $resp = $req.GetResponse()
            $resp.Close()
        } catch {
            # Silently ignore if Rie backend is offline or network fails
        }
    }, @($jsonStr, $global:__rie_endpoint))
}

# Preserve existing prompt
if (Test-Path Function:\prompt) {
    Copy-Item -Path Function:\prompt -Destination Function:\global:__rie_original_prompt -Force
} else {
    function global:__rie_original_prompt { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}

# Hook Enter key using PSReadLine to capture command start and support Ctrl+C detection
try {
    if (-not (Get-Module -Name PSReadLine)) {
        Import-Module PSReadLine -ErrorAction SilentlyContinue
    }
    if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
        Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
            param($key, $arg)
            try {
                $line = ""
                $cursor = 0
                [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
                $trimmed = if ($line) { $line.Trim() } else { "" }

                # Privacy filter: ignore empty or sensitive commands
                $isSensitive = $trimmed -match "(?i)(password|secret|api_key|token|bearer|credential|id_rsa|private_key)"

                if ($trimmed -and -not $isSensitive -and (global:__rie_is_terminal_enabled)) {
                    $cmdId = [guid]::NewGuid().ToString()
                    $global:__rie_current_cmd = $trimmed
                    $global:__rie_current_cmd_id = $cmdId
                    $global:__rie_cmd_start_time = [DateTime]::UtcNow

                    # Send "running" event to Rie backend immediately at command start
                    $startPayload = @{
                        id = $cmdId
                        event_type = "terminal_command"
                        shell = "PowerShell"
                        command = $trimmed
                        cwd = $PWD.Path
                        status = "running"
                        exit_code = $null
                        duration = 0.0
                        timestamp = [DateTime]::UtcNow.ToString("o")
                    }
                    global:__rie_send_event_async $startPayload
                } else {
                    $global:__rie_current_cmd = $null
                    $global:__rie_current_cmd_id = $null
                    $global:__rie_cmd_start_time = $null
                }
            } catch {
                # Fallback safely
            }
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
    }
} catch {
    # If PSReadLine is not installed or available, continue with prompt-only fallback
}

function global:prompt {
    # Capture exit code immediately before executing anything else
    $lastCmdSuccess = $?
    $lastNativeExit = $LASTEXITCODE
    $global:LASTEXITCODE = 0

    try {
        if (global:__rie_is_terminal_enabled) {
            $lastCmd = Get-History -Count 1

            if ($global:__rie_current_cmd) {
                # Command was registered at start via Enter hook
                $cmdText = $global:__rie_current_cmd
                $cmdId = $global:__rie_current_cmd_id

                $duration = 0.0
                if ($global:__rie_cmd_start_time) {
                    $duration = [math]::Round(([DateTime]::UtcNow - $global:__rie_cmd_start_time).TotalSeconds, 3)
                }

                # Detect Ctrl+C / Interrupted status:
                # 1. Native process exited with NTSTATUS 0xC000013A (-1073741510) or 130 or 3221225786
                # 2. Or command did not complete successfully and Get-History does not record it
                $isInterrupted = ($lastNativeExit -eq -1073741510 -or $lastNativeExit -eq 130 -or $lastNativeExit -eq 3221225786) -or
                                 (-not $lastCmdSuccess -and ($lastCmd -eq $null -or $lastCmd.CommandLine -ne $cmdText))

                if ($isInterrupted) {
                    $status = "interrupted"
                    $exitCode = 130
                } elseif ($lastCmdSuccess -and ($lastNativeExit -eq $null -or $lastNativeExit -eq 0)) {
                    $status = "completed"
                    $exitCode = 0
                } else {
                    $status = "failed"
                    $exitCode = if ($lastNativeExit -ne $null -and $lastNativeExit -ne 0) { $lastNativeExit } else { 1 }
                }

                if ($lastCmd -and $lastCmd.CommandLine -eq $cmdText) {
                    $global:__rie_last_history_id = $lastCmd.Id
                }

                $payload = @{
                    id = $cmdId
                    event_type = "terminal_command"
                    shell = "PowerShell"
                    command = $cmdText
                    cwd = $PWD.Path
                    status = $status
                    exit_code = $exitCode
                    duration = $duration
                    timestamp = [DateTime]::UtcNow.ToString("o")
                }
                global:__rie_send_event_async $payload

                # Reset current command state
                $global:__rie_current_cmd = $null
                $global:__rie_current_cmd_id = $null
                $global:__rie_cmd_start_time = $null
            }
            elseif ($lastCmd -and $lastCmd.Id -ne $global:__rie_last_history_id) {
                # Fallback for systems without PSReadLine or background execution
                $global:__rie_last_history_id = $lastCmd.Id
                $cmdText = $lastCmd.CommandLine

                $isSensitive = $cmdText -match "(?i)(password|secret|api_key|token|bearer|credential|id_rsa|private_key)"
                if ($cmdText -and -not $isSensitive) {
                    $exitCode = if ($lastCmdSuccess) {
                        0
                    } else {
                        if ($lastNativeExit -ne $null -and $lastNativeExit -ne 0) { $lastNativeExit } else { 1 }
                    }

                    $status = if ($exitCode -eq 0) { "completed" } else { "failed" }

                    $duration = 0.0
                    if ($lastCmd.EndExecutionTime -and $lastCmd.StartExecutionTime) {
                        $duration = [math]::Round(($lastCmd.EndExecutionTime - $lastCmd.StartExecutionTime).TotalSeconds, 3)
                    }

                    $payload = @{
                        event_type = "terminal_command"
                        shell = "PowerShell"
                        command = $cmdText.Trim()
                        cwd = $PWD.Path
                        status = $status
                        exit_code = $exitCode
                        duration = $duration
                        timestamp = [DateTime]::UtcNow.ToString("o")
                    }
                    global:__rie_send_event_async $payload
                }
            }
        }
    } catch {
        # Never break user's terminal prompt on hook error
    }

    # Render original prompt
    __rie_original_prompt
}

if ($Host.UI.RawUI -and -not $global:RIE_QUIET) {
    Write-Host "[Rie] Terminal context tracking v2 active (PowerShell)" -ForegroundColor Cyan
}

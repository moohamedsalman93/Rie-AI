@echo off
rem ============================================================================
rem  Rie Context — Windows CMD Integration (Phase 2.3 v2)
rem  Tracks executed and running commands, cwd, exit code, timestamp, and duration
rem  Captures command at execution start and completion / Ctrl+C interruption.
rem  PRESERVES ZERO KEYSTROKE LOGGING.
rem ============================================================================

setlocal enabledelayedexpansion

set "RIE_URL=%RIE_WORKSTREAM_URL%"
if "%RIE_URL%"=="" set "RIE_URL=http://127.0.0.1:14300/workstream/events"

rem Check mode: /init, /session, run, or default
if /i "%~1"=="/init" goto :do_init
if /i "%~1"=="/setup" goto :do_init
if /i "%~1"=="/session" goto :do_session
if /i "%~1"=="run" goto :do_run

rem If arguments provided without "run", treat as command to run
if not "%~1"=="" goto :do_run

rem Default: initialize doskey macros in current shell
goto :do_init

:do_init
rem Register doskey macros for commonly used developer and test commands
doskey rie="%~dpnx0" run $*
doskey pytest="%~dpnx0" run pytest $*
doskey poetry="%~dpnx0" run poetry $*
doskey npm="%~dpnx0" run npm $*
doskey pnpm="%~dpnx0" run pnpm $*
doskey yarn="%~dpnx0" run yarn $*
doskey git="%~dpnx0" run git $*
doskey python="%~dpnx0" run python $*
doskey cargo="%~dpnx0" run cargo $*

if not defined RIE_QUIET (
    echo [Rie] Terminal context tracking v2 active ^(CMD^)
    echo [Rie] Tip: Use 'rie ^<cmd^>' to track any command, or 'rie-shell-cmd /session' for tracked shell session.
)
goto :eof

:do_session
echo [Rie] Started tracked CMD interactive session. Type 'exit' to quit.
:session_loop
set "USER_CMD="
set /p "USER_CMD=[Rie] %CD%> "
if /i "%USER_CMD%"=="exit" goto :eof
if "%USER_CMD%"=="" goto session_loop

call :execute_and_send "%USER_CMD%"
goto session_loop

:do_run
set "FULL_CMD=%*"
if /i "%~1"=="run" (
    for /f "tokens=1,* delims= " %%a in ("%*") do set "FULL_CMD=%%b"
)
call :execute_and_send "%FULL_CMD%"
exit /b %EXIT_CODE%

:execute_and_send
set "CMD_TO_RUN=%~1"
if "%CMD_TO_RUN%"=="" goto :eof

rem Privacy Filter: check for sensitive keywords
echo %CMD_TO_RUN% | findstr /i "password secret api_key token bearer credential id_rsa private_key" >nul 2>&1
if not errorlevel 1 (
    rem Contains sensitive keyword, execute directly without tracking
    %CMD_TO_RUN%
    set "EXIT_CODE=%ERRORLEVEL%"
    goto :eof
)

rem Generate pseudo-unique ID for CMD command
set "CMD_ID=cmd-%RANDOM%-%TIME::=%"
set "CMD_ID=%CMD_ID: =%"
set "CMD_ID=%CMD_ID:.=%"

rem Escape command and cwd for JSON: backslashes first, then quotes
set "SAFE_CMD=!CMD_TO_RUN:\=\\!"
set "SAFE_CMD=!SAFE_CMD:"=\u0022!"
set "SAFE_CWD=!CD:\=\\!"

rem Get UTC timestamp using powershell in background or fallback
for /f "tokens=*" %%t in ('powershell -NoProfile -Command "[DateTime]::UtcNow.ToString('o')" 2^>nul') do set "TIMESTAMP=%%t"
if "!TIMESTAMP!"=="" set "TIMESTAMP=2026-09-26T00:00:00Z"

rem 1. Send "running" event before executing command
start /B "" curl.exe -s -m 1 -X POST "!RIE_URL!" -H "Content-Type: application/json" -d "{\"id\":\"!CMD_ID!\",\"event_type\":\"terminal_command\",\"shell\":\"CMD\",\"command\":\"!SAFE_CMD!\",\"cwd\":\"!SAFE_CWD!\",\"status\":\"running\",\"exit_code\":null,\"duration\":0.0,\"timestamp\":\"!TIMESTAMP!\"}" >nul 2>&1

rem Capture start time in seconds
for /f "tokens=1-4 delims=:.," %%a in ("%time: =0%") do (
    set /a "START_SEC=(((%%a*60)+%%b)*60)+%%c"
)

rem Reset ERRORLEVEL to 0 and execute command
(call )
%CMD_TO_RUN%
set "RAW_EXIT=%ERRORLEVEL%"

rem Capture end time in seconds
for /f "tokens=1-4 delims=:.," %%a in ("%time: =0%") do (
    set /a "END_SEC=(((%%a*60)+%%b)*60)+%%c"
)

rem Calculate approximate duration
set /a "DUR_SEC=END_SEC-START_SEC"
if !DUR_SEC! lss 0 set /a "DUR_SEC+=86400"
set "DURATION=!DUR_SEC!.0"

rem Determine status and normalized exit code
set "STATUS=completed"
set "EXIT_CODE=!RAW_EXIT!"
if "!RAW_EXIT!"=="-1073741510" (
    set "STATUS=interrupted"
    set "EXIT_CODE=130"
)
if "!RAW_EXIT!"=="3221225786" (
    set "STATUS=interrupted"
    set "EXIT_CODE=130"
)
if "!RAW_EXIT!"=="130" (
    set "STATUS=interrupted"
)
if not "!STATUS!"=="interrupted" (
    if not "!RAW_EXIT!"=="0" (
        set "STATUS=failed"
    )
)

rem 2. Send completion / interruption event with the SAME CMD_ID
start /B "" curl.exe -s -m 1 -X POST "!RIE_URL!" -H "Content-Type: application/json" -d "{\"id\":\"!CMD_ID!\",\"event_type\":\"terminal_command\",\"shell\":\"CMD\",\"command\":\"!SAFE_CMD!\",\"cwd\":\"!SAFE_CWD!\",\"status\":\"!STATUS!\",\"exit_code\":!EXIT_CODE!,\"duration\":!DURATION!,\"timestamp\":\"!TIMESTAMP!\"}" >nul 2>&1

goto :eof

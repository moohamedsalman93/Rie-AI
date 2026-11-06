#!/usr/bin/env bash
# Rie Context — Git Bash / Bash Shell Integration (Phase 2.3 v2)
# Tracks executed and running commands, cwd, exit code, timestamp, and duration
# Captures command at execution start (DEBUG trap) and completion / Ctrl+C interruption.
# PRESERVES ZERO KEYSTROKE LOGGING (only captures submitted command before execution).

if [ -n "$__RIE_BASH_INITIALIZED" ]; then
    return 0 2>/dev/null || exit 0
fi
__RIE_BASH_INITIALIZED=1

__RIE_ENDPOINT="${RIE_WORKSTREAM_URL:-http://127.0.0.1:14300/workstream/events}"
__RIE_LAST_HIST_ID=""
__RIE_CMD_ID=""
__RIE_CURRENT_CMD=""
__RIE_CMD_START_TIME=""
__RIE_IN_PROMPT=""

__rie_is_disabled() {
    [ -n "$RIE_TERMINAL_DISABLED" ] && return 0
    local tmp_cfg="${TMPDIR:-/tmp}/rie_workstream_config.json"
    [ -f "$tmp_cfg" ] || tmp_cfg="/c/Users/${USER:-$(whoami)}/AppData/Local/Temp/rie_workstream_config.json"
    if [ -f "$tmp_cfg" ]; then
        if grep -q '"workstream":false' "$tmp_cfg" 2>/dev/null || grep -q '"terminal":false' "$tmp_cfg" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Preexec hook to record start time and send running status before command execution
__rie_preexec() {
    # Skip if non-interactive, inside prompt hook, or disabled
    [ -z "$PS1" ] && return
    [ -n "$__RIE_IN_PROMPT" ] && return
    __rie_is_disabled && return

    local cmd="$BASH_COMMAND"
    # Skip internal bash commands or prompt functions
    if [[ "$cmd" =~ ^__rie_ ]] || [[ "$cmd" =~ ^HISTTIMEFORMAT ]] || [[ "$cmd" =~ ^date ]] || [[ "$cmd" =~ ^curl ]]; then
        return
    fi

    # Privacy filter: ignore sensitive commands
    if [[ "$cmd" =~ (password|secret|api_key|token|bearer|credential|id_rsa|private_key) ]]; then
        __RIE_CURRENT_CMD=""
        __RIE_CMD_ID=""
        return
    fi

    __RIE_CURRENT_CMD="$cmd"
    __RIE_CMD_ID="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "bash-$$-$RANDOM-$(date +%s%N 2>/dev/null || date +%s)")"
    __RIE_CMD_START_TIME=$(date +%s%3N 2>/dev/null || date +%s)

    # Resolve cwd
    local cwd_path
    if pwd -W >/dev/null 2>&1; then
        cwd_path=$(pwd -W)
    else
        cwd_path=$(pwd)
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    local esc_cmd
    esc_cmd=$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r//g')
    local esc_cwd
    esc_cwd=$(printf '%s' "$cwd_path" | sed 's/\\/\\\\/g; s/"/\\"/g')

    # Send "running" event to Rie backend asynchronously
    local payload="{\"id\":\"${__RIE_CMD_ID}\",\"event_type\":\"terminal_command\",\"shell\":\"Git Bash\",\"command\":\"${esc_cmd}\",\"cwd\":\"${esc_cwd}\",\"status\":\"running\",\"exit_code\":null,\"duration\":0.0,\"timestamp\":\"${timestamp}\"}"
    (
        curl -s -m 1 -X POST "$__RIE_ENDPOINT" \
            -H "Content-Type: application/json" \
            -d "$payload" >/dev/null 2>&1 &
    ) >/dev/null 2>&1
}

# Trap DEBUG only for top-level interactive commands
trap '__rie_preexec' DEBUG

__rie_prompt_hook() {
    # 1. Capture exit status immediately as the very first operation
    local exit_code=$?
    __RIE_IN_PROMPT=1

    # Check if disabled
    __rie_is_disabled && { __RIE_IN_PROMPT=""; return 0; }

    # Calculate duration
    local duration=0.0
    if [ -n "$__RIE_CMD_START_TIME" ]; then
        local now_ms
        now_ms=$(date +%s%3N 2>/dev/null || date +%s)
        if [ "$now_ms" -gt "$__RIE_CMD_START_TIME" ] 2>/dev/null; then
            duration=$(awk -v start="$__RIE_CMD_START_TIME" -v end="$now_ms" 'BEGIN { printf "%.3f", (end - start) / 1000 }' 2>/dev/null || echo 0.0)
        fi
    fi

    # Determine status: exit code 130 is SIGINT / Ctrl+C
    local status="completed"
    if [ "$exit_code" -eq 130 ] || [ "$exit_code" -eq 2 ]; then
        status="interrupted"
        exit_code=130
    elif [ "$exit_code" -ne 0 ]; then
        status="failed"
    fi

    # Determine command text
    local cmd_text="${__RIE_CURRENT_CMD}"
    local cmd_id="${__RIE_CMD_ID}"

    if [ -z "$cmd_text" ]; then
        local last_entry
        last_entry=$(HISTTIMEFORMAT= history 1 2>/dev/null)
        if [ -n "$last_entry" ]; then
            local hist_num
            hist_num=$(echo "$last_entry" | awk '{print $1}')
            if [ "$hist_num" != "$__RIE_LAST_HIST_ID" ]; then
                __RIE_LAST_HIST_ID="$hist_num"
                cmd_text=$(echo "$last_entry" | sed -e 's/^[ ]*[0-9]*[ ]*//')
            fi
        fi
    fi

    # Clean up state for next execution
    __RIE_CURRENT_CMD=""
    __RIE_CMD_ID=""
    __RIE_CMD_START_TIME=""

    if [ -z "$cmd_text" ]; then
        __RIE_IN_PROMPT=""
        return 0
    fi

    # Privacy filter: ignore sensitive keywords
    if [[ "$cmd_text" =~ (password|secret|api_key|token|bearer|credential|id_rsa|private_key) ]]; then
        __RIE_IN_PROMPT=""
        return 0
    fi

    local cwd_path
    if pwd -W >/dev/null 2>&1; then
        cwd_path=$(pwd -W)
    else
        cwd_path=$(pwd)
    fi

    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

    local esc_cmd
    esc_cmd=$(printf '%s' "$cmd_text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r//g')
    local esc_cwd
    esc_cwd=$(printf '%s' "$cwd_path" | sed 's/\\/\\\\/g; s/"/\\"/g')

    local id_field=""
    if [ -n "$cmd_id" ]; then
        id_field="\"id\":\"${cmd_id}\","
    fi

    local payload="{${id_field}\"event_type\":\"terminal_command\",\"shell\":\"Git Bash\",\"command\":\"${esc_cmd}\",\"cwd\":\"${esc_cwd}\",\"status\":\"${status}\",\"exit_code\":${exit_code},\"duration\":${duration},\"timestamp\":\"${timestamp}\"}"

    # Asynchronous non-blocking dispatch
    (
        curl -s -m 1 -X POST "$__RIE_ENDPOINT" \
            -H "Content-Type: application/json" \
            -d "$payload" >/dev/null 2>&1 &
    ) >/dev/null 2>&1

    __RIE_IN_PROMPT=""
}

# Attach to PROMPT_COMMAND without overriding existing hooks
if [[ -z "$PROMPT_COMMAND" ]]; then
    PROMPT_COMMAND="__rie_prompt_hook"
else
    # Only append if not already present
    if [[ "$PROMPT_COMMAND" != *"__rie_prompt_hook"* ]]; then
        PROMPT_COMMAND="${PROMPT_COMMAND}; __rie_prompt_hook"
    fi
fi

if [ -t 1 ] && [ -z "$RIE_QUIET" ]; then
    printf "\033[0;36m[Rie] Terminal context tracking v2 active (Git Bash)\033[0m\n"
fi

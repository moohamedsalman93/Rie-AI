-- Rie Context — Clink Plugin for Windows CMD
-- Tracks commands executed in CMD when Clink is active (e.g. Cmder, ConEmu, Windows Terminal)
-- Privacy: Filters sensitive keywords. Non-blocking: fires curl via os.execute in background.

local endpoint = os.getenv("RIE_WORKSTREAM_URL") or "http://localhost:14300/workstream/events"

local function is_sensitive(cmd)
    local lower = string.lower(cmd)
    local sensitive_keywords = {"password", "secret", "api_key", "token", "bearer", "credential", "id_rsa", "private_key"}
    for _, kw in ipairs(sensitive_keywords) do
        if string.find(lower, kw, 1, true) then
            return true
        end
    end
    return false
end

local function escape_json(str)
    str = string.gsub(str, "\\", "\\\\")
    str = string.gsub(str, '"', '\\"')
    str = string.gsub(str, "\r", "")
    str = string.gsub(str, "\n", " ")
    return str
end

local start_time = 0

local function on_command_start()
    start_time = os.clock()
end

local function on_command_end(cmd, exit_code)
    if not cmd or cmd:match("^%s*$") or is_sensitive(cmd) then
        return
    end

    local duration = 0.0
    if start_time > 0 then
        duration = math.floor((os.clock() - start_time) * 1000) / 1000
    end

    local cwd = os.getenv("CD") or io.popen("cd"):read("*l") or ""
    local timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ")
    local ec = exit_code or 0

    local payload = string.format(
        '{"event_type":"terminal_command","shell":"CMD (Clink)","command":"%s","cwd":"%s","exit_code":%d,"duration":%.3f,"timestamp":"%s"}',
        escape_json(cmd),
        escape_json(cwd),
        ec,
        duration,
        timestamp
    )

    -- Non-blocking curl dispatch
    local curl_cmd = string.format('start /B "" curl.exe -s -m 1 -X POST "%s" -H "Content-Type: application/json" -d "%s" >nul 2>&1', endpoint, escape_json(payload))
    os.execute(curl_cmd)
end

if clink and clink.onendedit then
    clink.onendedit(function(line)
        if line and line:match("%S") then
            on_command_start()
        end
        return line
    end)
end

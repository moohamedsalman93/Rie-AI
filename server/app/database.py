
"""
Database module for managing application settings and chat history
"""
import sqlite3
import os
import json
from pathlib import Path
import sys
import uuid
import secrets
import hashlib
from datetime import datetime
from typing import Dict, List, Optional, Any
import logging

def get_db_path() -> Path:
    """Get the path to the SQLite database file"""
    if getattr(sys, 'frozen', False):
        # If running as a bundle, use LOCALAPPDATA (same as logs)
        # This prevents write permission errors in Program Files
        base_path = Path(os.getenv('LOCALAPPDATA', os.path.expanduser('~'))) / 'Rie-AI'
        base_path.mkdir(parents=True, exist_ok=True)
        return base_path / "settings.db"
    else:
        # If running as a script, use the project root
        base_path = Path(__file__).parent.parent
        return base_path / "settings.db"

def get_checkpoint_db_path() -> str:
    """Get the path to the checkpointer SQLite database file as a string"""
    path = get_db_path()
    return str(path.parent / "checkpoints.db")


def get_knowledge_storage_dir() -> Path:
    """Directory for custom knowledge asset files."""
    if getattr(sys, 'frozen', False):
        base_path = Path(os.getenv('LOCALAPPDATA', os.path.expanduser('~'))) / 'Rie-AI' / 'knowledge'
    else:
        base_path = Path(__file__).parent.parent / 'knowledge'
    base_path.mkdir(parents=True, exist_ok=True)
    return base_path

def vacuum_checkpoint_db() -> dict:
    """
    Vacuum the checkpoint database to reclaim space from deleted rows.
    Returns stats about the operation (size before/after).
    """
    db_path = get_checkpoint_db_path()
    if not os.path.exists(db_path):
        return {"error": "Checkpoint database not found", "path": db_path}
    
    size_before = os.path.getsize(db_path)
    
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("VACUUM")
    finally:
        conn.close()
    
    size_after = os.path.getsize(db_path)
    
    return {
        "path": db_path,
        "size_before_mb": round(size_before / (1024 * 1024), 2),
        "size_after_mb": round(size_after / (1024 * 1024), 2),
        "freed_mb": round((size_before - size_after) / (1024 * 1024), 2),
    }

def init_db():
    """Initialize the database and create tables if they don't exist"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Create settings table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
    ''')

    # Create threads table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT,
        updated_at TEXT
    )
    ''')

    # Create messages table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        role TEXT,
        content TEXT,
        image_url TEXT,
        created_at TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
    )
    ''')
    
    # Check if image_url column exists, if not add it (for existing databases)
    try:
        cursor.execute("SELECT image_url FROM messages LIMIT 1")
    except sqlite3.OperationalError:
        cursor.execute("ALTER TABLE messages ADD COLUMN image_url TEXT")

    # Migrate legacy tunnel settings keys to ngrok/neutral naming.
    legacy_prefix = "CONNECTIVITY_" + "CLOUD" + "FLARE_"
    connectivity_setting_migrations = {
        f"{legacy_prefix}ENABLED": "CONNECTIVITY_NGROK_ENABLED",
        f"{legacy_prefix}PUBLIC_URL": "CONNECTIVITY_PUBLIC_URL",
        f"{legacy_prefix}INSTALL_PATH": "CONNECTIVITY_NGROK_INSTALL_PATH",
        f"{legacy_prefix}TUNNEL_PID": "CONNECTIVITY_NGROK_TUNNEL_PID",
        f"{legacy_prefix}TUNNEL_TOKEN": "CONNECTIVITY_NGROK_AUTH_TOKEN",
        f"{legacy_prefix}HOSTNAME": "CONNECTIVITY_NGROK_DOMAIN",
    }
    for old_key, new_key in connectivity_setting_migrations.items():
        cursor.execute("SELECT value FROM settings WHERE key = ?", (new_key,))
        if cursor.fetchone():
            continue
        cursor.execute("SELECT value FROM settings WHERE key = ?", (old_key,))
        legacy_row = cursor.fetchone()
        if not legacy_row:
            continue
        cursor.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (new_key, legacy_row[0]),
        )

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        text TEXT NOT NULL,
        run_at TEXT NOT NULL,
        intent TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        completed_at TEXT
    )
    ''')

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS schedule_notifications (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        task_id TEXT,
        intent TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
    )
    ''')

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS device_identity (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            device_id TEXT NOT NULL,
            name TEXT NOT NULL,
            public_key TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS friends (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            device_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            public_key TEXT NOT NULL,
            public_url TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    # Migrate legacy tunnel column name to neutral public_url.
    cursor.execute("PRAGMA table_info(friends)")
    friend_columns = {row[1] for row in cursor.fetchall()}
    if "public_url" not in friend_columns:
        legacy_public_url_column = "cloud" + "flare_public_url"
        if legacy_public_url_column in friend_columns:
            cursor.execute(f"ALTER TABLE friends RENAME COLUMN {legacy_public_url_column} TO public_url")
        else:
            cursor.execute("ALTER TABLE friends ADD COLUMN public_url TEXT")

    cursor.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_device_id ON friends(device_id)")

    cursor.execute("PRAGMA table_info(friends)")
    friend_columns_peer = {row[1] for row in cursor.fetchall()}
    if "peer_access_json" not in friend_columns_peer:
        cursor.execute("ALTER TABLE friends ADD COLUMN peer_access_json TEXT")

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_pair_tokens (
            token TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_thread_approvals (
            thread_id TEXT NOT NULL,
            friend_id TEXT NOT NULL,
            approved_at TEXT NOT NULL,
            PRIMARY KEY(thread_id, friend_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS friend_threads (
            thread_id TEXT PRIMARY KEY,
            friend_id TEXT NOT NULL,
            friend_name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_packs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            instructions TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_assets (
            id TEXT PRIMARY KEY,
            pack_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            asset_type TEXT NOT NULL CHECK(asset_type IN ('text', 'image')),
            storage_path TEXT NOT NULL,
            summary TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(pack_id) REFERENCES knowledge_packs(id) ON DELETE CASCADE
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS thread_knowledge (
            thread_id TEXT NOT NULL,
            knowledge_id TEXT NOT NULL,
            knowledge_name TEXT NOT NULL,
            context_snapshot TEXT,
            is_locked INTEGER NOT NULL DEFAULT 0,
            attached_at TEXT NOT NULL,
            PRIMARY KEY(thread_id, knowledge_id),
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(knowledge_id) REFERENCES knowledge_packs(id)
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_knowledge_assets_pack ON knowledge_assets(pack_id)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_thread_knowledge_thread ON thread_knowledge(thread_id)"
    )

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS peer_query_events (
            id TEXT PRIMARY KEY,
            direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
            friend_id TEXT,
            friend_name TEXT,
            query_text TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
            response_preview TEXT,
            error_detail TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_peer_query_events_created ON peer_query_events(created_at DESC)"
    )

    # Skills system
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            content TEXT NOT NULL,
            icon TEXT DEFAULT '🧠',
            tool_ids TEXT DEFAULT '[]',
            enabled INTEGER DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS thread_skills (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            skill_id TEXT NOT NULL,
            attached_at TEXT NOT NULL,
            UNIQUE(thread_id, skill_id),
            FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS idx_thread_skills_thread ON thread_skills(thread_id)"
    )

    # Populate default skills if they don't exist by name
    import uuid
    from datetime import datetime
    now = datetime.utcnow().isoformat()
    
    # Clean up unwanted developer skills if previously seeded
    unwanted = [
        "React & TS Guidelines",
        "Python Style Guide",
        "No Code Placeholders",
        "Semantic Git Commits",
        "Security Hardening",
    ]
    for u in unwanted:
        cursor.execute("DELETE FROM skills WHERE name = ?", (u,))

    defaults = [
        (
            "📄",
            "PDF Generation Expert",
            "Conventions for generating professional programmatical PDFs.",
            "When generating PDFs:\n- In Python, prefer `reportlab` (using PLATYPUS Flowables for page-layout management) or `fpdf2` for simpler reports.\n- Avoid hardcoded layout coordinates `(x, y)` where possible; use flowables, Paragraphs, and Spacers to handle page-breaks and margins dynamically.\n- Always wrap text inside Paragraph flowables to enable automatic word wrapping in tables.\n- Define styles and reuse them to maintain color scheme and font consistency.\n- Ensure all custom fonts are registered before drawing them.\n- When generating in Node.js, prefer `pdf-lib` or HTML-to-PDF converters like `puppeteer`/`playwright` for design-heavy layouts."
        ),
        (
            "💻",
            "Computer Use Guide",
            "Instructions for controlling and automating the Windows OS using mouse, keyboard, and terminal tools. NOTE: If Browser MCP tools are available, prioritize Browser MCP tools for browser/web tasks.",
            "Guidelines for using computer control tools (desktop state, click, type, scroll, drag, shortcuts, wait, scrape):\n1. **Web vs Desktop Priority**: For web browsing, page navigation, or web tasks, if Browser MCP tools are available in your toolset, ALWAYS prioritize Browser MCP tools over desktop GUI tools. Use this Computer Use Guide only for native desktop applications or when no Browser MCP tool is available for the web task.\n2. **Always Check State First**: Before clicking, typing, or performing desktop actions, call `get_desktop_state` to see the currently open applications, focused window, and interactive elements.\n3. **Visual Verification**: If you are unsure of an element's location, or a text description is insufficient, call `get_desktop_state` with `use_vision=True` to receive a visual screenshot.\n4. **Coordinate Accuracy**: The coordinates returned by `get_desktop_state` are in `[x, y]` format. Always click or type exactly on the identified interactive element's coordinates.\n5. **App Launch & Control**: Use `app_control` to launch or switch to windows. If an app is already running, switch to it instead of starting a new instance.\n6. **Typing Best Practices**: When using `keyboard_type`, click on the input field first. Use `clear=True` if you need to replace existing content, and `press_enter=True` to submit forms or search boxes.\n7. **Wait for UI Transitions**: UI updates are not instantaneous. After launching a program or clicking a button that changes the screen, use the `wait` tool (typically 1-3 seconds) to allow the interface to settle before querying the new state.\n8. **Verify Actions**: After executing clicks or keystrokes, call `get_desktop_state` again to verify that your action was successful and the UI changed as expected. Make sure to verify each step and do not proceed blindly.\n9. **Keyboard Shortcuts**: Use `press_keys` (shortcut tool) for common actions: 'ctrl+c' to copy, 'ctrl+v' to paste, 'alt+tab' to switch active windows, 'win' or 'win+s' to open search."
        ),
        (
            "🐚",
            "PowerShell Style & Scripting",
            "Guidelines for writing clean, efficient, and secure PowerShell scripts.",
            "Always use complete cmdlet names instead of aliases (e.g. use `Get-ChildItem` instead of `ls` or `dir`).\nPrefer using the pipeline for data processing but avoid it in high-performance loops.\nWrite functions with `[CmdletBinding()]` and proper parameter attributes (`[Parameter(Mandatory=$true)]`).\nUse `Write-Output` for returning data, and `Write-Host` or `Write-Information` only for visual feedback/logging.\nHandle errors gracefully using `try { ... } catch { ... }` blocks and check `$PSItem` or `$_` for error details.\nPrefer strongly typed parameters and add HelpMessage or comment-based help to functions.\nUse `$Path = Join-Path $PSScriptRoot \"subdir\"` for relative file paths to ensure cross-environment compatibility."
        ),
        (
            "💻",
            "Windows System Tasks",
            "Expert instructions for Windows system operations: wallpaper, registry, services, scheduled tasks, startup, and display settings using native PowerShell APIs.",
            r"""# Windows System Tasks Skill

You are executing Windows system-level tasks. Follow these rules precisely.

## Setting the Desktop Wallpaper
NEVER use RUNDLL32 for wallpaper — it is unreliable on modern Windows.
ALWAYS use SystemParametersInfo via P/Invoke:

```powershell
$wallpaper = "C:\path\to\image.jpg"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Wallpaper {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
[Wallpaper]::SystemParametersInfo(0x0014, 0, $wallpaper, 0x0001 -bor 0x0002)
```
Flags: 0x0014 = SPI_SETDESKWALLPAPER, 0x0001 = SPIF_UPDATEINIFILE, 0x0002 = SPIF_SENDCHANGE.
Always ensure the destination folder exists with `New-Item -ItemType Directory -Force` before downloading.

## Registry Operations
Read:   `Get-ItemProperty -Path 'HKCU:\...' -Name 'ValueName'`
Write:  `Set-ItemProperty -Path 'HKCU:\...' -Name 'ValueName' -Value 'data'`
Create: `New-Item -Path 'HKCU:\...' -Force`
Delete value: `Remove-ItemProperty -Path 'HKCU:\...' -Name 'ValueName'`

Common paths:
- Startup:   `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`
- Desktop:   `HKCU:\Control Panel\Desktop`
- Taskbar:   `HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband`

## Services
Start:   `Start-Service -Name "ServiceName"`
Stop:    `Stop-Service -Name "ServiceName" -Force`
Status:  `Get-Service -Name "ServiceName"`
Enable at boot: `Set-Service -Name "ServiceName" -StartupType Automatic`
List all: `Get-Service | Where-Object { $_.Status -eq 'Running' }`

## Scheduled Tasks
Create:
```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-File "C:\script.ps1"'
$trigger = New-ScheduledTaskTrigger -Daily -At '09:00AM'
Register-ScheduledTask -TaskName "MyTask" -Action $action -Trigger $trigger -RunLevel Highest
```
List:   `Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' }`
Remove: `Unregister-ScheduledTask -TaskName "MyTask" -Confirm:$false`

## Display & Resolution
Get displays: `Get-CimInstance -ClassName Win32_VideoController | Select-Object Name, CurrentHorizontalResolution, CurrentVerticalResolution`
Refresh rate: `Get-CimInstance -ClassName Win32_VideoController | Select-Object CurrentRefreshRate`

## ⚠️ MANDATORY — Command Execution Format
**NEVER use `powershell -Command "..."` or `powershell -NoProfile -Command "..."`.**
You are ALREADY inside a PowerShell terminal. Wrapping commands this way causes nested-quote
parser errors (`TerminatorExpectedAtEndOfString`) because `\"` is NOT a valid PowerShell escape —
PowerShell uses the backtick (`` ` ``) as its escape character, not backslash.
Always run commands directly without any wrapper.

**FALLBACK for complex commands**: If a command involves hashtables, nested quotes, loops, or
special characters that make inline execution risky, write it to a temporary `.ps1` script file
first, then execute the script:
```powershell
# Step 1: Write the script
Set-Content -Path "$env:TEMP\rie_task.ps1" -Value @'
$map = @{ "jpg"="Images"; "png"="Images"; "pdf"="Documents" }
Get-ChildItem -Path "$env:USERPROFILE\Downloads" -File | ForEach-Object {
    $ext = $_.Extension.TrimStart(".").ToLower()
    $folder = $map[$ext]; if (-not $folder) { $folder = "Others" }
    $dest = Join-Path "$env:USERPROFILE\Downloads" $folder
    if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest -Force | Out-Null }
    Move-Item -LiteralPath $_.FullName -Destination $dest -Force
}
'@
# Step 2: Execute it
& "$env:TEMP\rie_task.ps1"
```
This completely avoids all quoting and escaping issues.

## Critical Rules
- Always use native cmdlets (Set-ItemProperty, New-Item, etc.), not Linux commands.
- Use backslashes `\` for Windows paths.
- Prefer `$env:USERPROFILE` over hardcoded `C:\Users\username`."""
        ),
        (
            "📁",
            "File & Directory Operations",
            "Best practices for Windows file and directory tasks: copy, move, delete, rename, search, compress/extract archives using native PowerShell cmdlets.",
            r"""# File & Directory Operations Skill

You are performing file system operations on Windows. Use native PowerShell cmdlets only.

## Creating Files & Directories
Create directory (with parents): `New-Item -ItemType Directory -Path "C:\path\to\dir" -Force`
Create empty file:               `New-Item -ItemType File -Path "C:\path\file.txt" -Force`
Create file with content:        `Set-Content -Path "C:\path\file.txt" -Value "content"`
Append content:                  `Add-Content -Path "C:\path\file.txt" -Value "more"`

## Copying & Moving
Copy file:       `Copy-Item -Path "src" -Destination "dst"`
Copy folder:     `Copy-Item -Path "src" -Destination "dst" -Recurse`
Move/rename:     `Move-Item -Path "src" -Destination "dst"`
Copy with force: `Copy-Item -Path "src" -Destination "dst" -Recurse -Force`

## Deleting
Delete file:     `Remove-Item -Path "C:\path\file.txt"`
Delete folder:   `Remove-Item -Path "C:\path\folder" -Recurse -Force`
Delete contents: `Remove-Item -Path "C:\path\*" -Recurse -Force`

## Reading Files
Read all text: `Get-Content -Path "C:\path\file.txt"`
Read as lines: `Get-Content -Path "C:\path\file.txt" | ForEach-Object { $_ }`
First N lines: `Get-Content -Path "C:\path\file.txt" -TotalCount 10`
Last N lines:  `Get-Content -Path "C:\path\file.txt" -Tail 10`

## Searching
Find files by name:    `Get-ChildItem -Path "C:\folder" -Filter "*.txt" -Recurse`
Find by content:       `Select-String -Path "C:\folder\*.log" -Pattern "error" -Recurse`
Find large files:      `Get-ChildItem -Path "C:\" -Recurse | Where-Object { $_.Length -gt 100MB }`
Find recent files:     `Get-ChildItem -Path "C:\" -Recurse | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-7) }`

## Listing & Info
List directory:   `Get-ChildItem -Path "C:\path"`
Directory size:   `(Get-ChildItem -Path "C:\path" -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB`
File properties:  `Get-Item -Path "C:\path\file.txt" | Select-Object Name, Length, LastWriteTime, CreationTime`
Check existence:  `Test-Path -Path "C:\path"` (returns True/False)

## Archives (Zip)
Compress:   `Compress-Archive -Path "C:\folder" -DestinationPath "C:\archive.zip" -Force`
Extract:    `Expand-Archive -Path "C:\archive.zip" -DestinationPath "C:\dest" -Force`
List zip:   `[System.IO.Compression.ZipFile]::OpenRead("C:\archive.zip").Entries | Select-Object FullName, Length`

## Permissions
Get ACL:  `Get-Acl -Path "C:\path\file.txt"`
Set owner: `$acl = Get-Acl "path"; $acl.SetOwner([NTAccount]"DOMAIN\user"); Set-Acl "path" $acl`

## ⚠️ MANDATORY — Command Execution Format
**NEVER use `powershell -Command "..."` or `powershell -NoProfile -Command "..."`.**
You are ALREADY inside a PowerShell terminal. Wrapping commands this way causes nested-quote
parser errors (`TerminatorExpectedAtEndOfString`) because `\"` is NOT a valid PowerShell escape —
PowerShell uses the backtick (`` ` ``) as its escape character, not backslash.

**CORRECT — run commands directly:**
```powershell
$downloads = "$env:USERPROFILE\Downloads"
Get-ChildItem -Path $downloads -File
```

**WRONG — will ALWAYS break:**
```
powershell -Command "& { $downloads = \"$env:USERPROFILE\\Downloads\" ... }"
```

If a command is multi-line, just emit it as multiple statements. The terminal handles it.

**FALLBACK for complex commands**: If a command involves hashtables, nested quotes, loops, or
special characters that make inline execution risky, write it to a temporary `.ps1` script file
first, then execute the script:
```powershell
Set-Content -Path "$env:TEMP\rie_task.ps1" -Value @'
# ... your complex PowerShell code here, no escaping needed inside here-string ...
'@
& "$env:TEMP\rie_task.ps1"
```
This completely avoids all quoting and escaping issues.

## PowerShell Quoting Rules
- Use double quotes `"..."` when you need variable expansion: `"$env:USERPROFILE\Downloads"`
- Use single quotes `'...'` for literal strings: `'Hello World'`
- Escape a double quote INSIDE a double-quoted string with backtick: `` "`" `` or by doubling the quote.
- NEVER use backslash `\` to escape quotes — it does NOT work in PowerShell.

## Critical Rules
- NEVER use Linux commands (`ls`, `cp`, `mv`, `rm`, `mkdir`, `cat`, `touch`).
- Always use `Test-Path` before deleting or reading to avoid errors.
- Use `-Force` with `New-Item` and `Remove-Item` to avoid prompts.
- Prefer `$env:USERPROFILE`, `$env:APPDATA`, `$env:TEMP` over hardcoded paths."""
        ),
        (
            "🌐",
            "Network & Downloads",
            "Instructions for downloading files, making HTTP requests, testing connectivity, and network diagnostics using PowerShell on Windows.",
            r"""# Network & Downloads Skill

You are performing network operations on Windows. Use native PowerShell cmdlets.

## Downloading Files
ALWAYS ensure the destination directory exists first:
```powershell
New-Item -ItemType Directory -Path "$env:USERPROFILE\Downloads" -Force
Invoke-WebRequest -Uri 'https://example.com/file.zip' -OutFile "$env:USERPROFILE\Downloads\file.zip"
```

For large files, use `-UseBasicParsing` to avoid IE engine dependency:
```powershell
Invoke-WebRequest -Uri 'https://...' -OutFile "C:\dest\file" -UseBasicParsing
```

Alternatively with .NET for better performance:
```powershell
(New-Object System.Net.WebClient).DownloadFile('https://...', 'C:\dest\file')
```

## HTTP Requests (REST APIs)
GET:
```powershell
$response = Invoke-RestMethod -Uri 'https://api.example.com/data' -Method GET
$response | ConvertTo-Json -Depth 5
```

POST with JSON body:
```powershell
$body = @{ key = "value"; num = 42 } | ConvertTo-Json
$response = Invoke-RestMethod -Uri 'https://api.example.com/endpoint' -Method POST -Body $body -ContentType 'application/json'
```

With headers/auth:
```powershell
$headers = @{ 'Authorization' = 'Bearer TOKEN'; 'Content-Type' = 'application/json' }
Invoke-RestMethod -Uri 'https://...' -Headers $headers -Method GET
```

## Testing Connectivity
Ping host:        `Test-NetConnection -ComputerName "google.com"`
Test port:        `Test-NetConnection -ComputerName "example.com" -Port 443`
Check internet:   `Test-NetConnection -ComputerName "8.8.8.8" -Port 53`
DNS lookup:       `Resolve-DnsName "example.com"`
Traceroute:       `Test-NetConnection -ComputerName "example.com" -TraceRoute`

## Network Info
All adapters:     `Get-NetAdapter | Select-Object Name, Status, LinkSpeed`
IP addresses:     `Get-NetIPAddress | Where-Object { $_.AddressFamily -eq 'IPv4' } | Select-Object InterfaceAlias, IPAddress`
Active connections: `Get-NetTCPConnection | Where-Object { $_.State -eq 'Established' } | Select-Object LocalAddress, LocalPort, RemoteAddress, RemotePort`
Open ports:       `Get-NetTCPConnection -State Listen | Select-Object LocalPort | Sort-Object LocalPort`

## Firewall
Check status:  `Get-NetFirewallProfile | Select-Object Name, Enabled`
Allow app:     `New-NetFirewallRule -DisplayName "MyApp" -Direction Inbound -Program "C:\app.exe" -Action Allow`
Block port:    `New-NetFirewallRule -DisplayName "BlockPort" -Direction Inbound -LocalPort 1234 -Protocol TCP -Action Block`

## ⚠️ MANDATORY — Command Execution Format
**NEVER use `powershell -Command "..."` or `powershell -NoProfile -Command "..."`.**
You are ALREADY inside a PowerShell terminal. Wrapping commands this way causes nested-quote
parser errors (`TerminatorExpectedAtEndOfString`) because `\"` is NOT a valid PowerShell escape —
PowerShell uses the backtick (`` ` ``) as its escape character, not backslash.
Always run commands directly without any wrapper.

**FALLBACK for complex commands**: If a command involves hashtables, nested quotes, or special
characters, write it to a temp `.ps1` script first, then execute it:
```powershell
Set-Content -Path "$env:TEMP\rie_task.ps1" -Value @'
# ... complex code here, no escaping needed inside here-string ...
'@
& "$env:TEMP\rie_task.ps1"
```

## Critical Rules
- ALWAYS create destination directory before downloading: `New-Item -ItemType Directory -Force`
- For downloading and setting images (e.g. wallpaper), verify the file exists after download with `Test-Path` before applying.
- Use `Invoke-WebRequest` with `-UseBasicParsing` to avoid dependency on IE's COM engine.
- On failure, check: DNS (`Resolve-DnsName`), port reachability (`Test-NetConnection -Port`), proxy settings."""
        ),
        (
            "🦊",
            "CamoFox Browser",
            "Instructions for using Rie's embedded stealth browser (CamoFox/Camoufox) — session lifecycle, snapshot-driven interaction, profile management, and error recovery.",
            r"""# CamoFox Browser Skill

You have access to a stealth browser powered by CamoFox (embedded Camoufox/Firefox via Playwright).
It runs in-process — no external server required. Follow these rules precisely.

## Session Lifecycle
1. **Open**: Call `browser_open(url=..., profile=...)` to start a session. Optional profile: 'default', 'work', 'personal'.
2. **Interact**: Use snapshot → click/type/scroll cycle (see below).
3. **Close**: Call `browser_close()` when done.

A session MUST be open before any other browser tool can be used. If you get a "No active browser session" error, call `browser_open()` first.

## Core Interaction Pattern: Snapshot → Act → Snapshot
This is the MANDATORY workflow for all browser interactions:

1. **Take a snapshot** (`browser_snapshot`) to see the page's interactive elements with `ref-N` IDs.
2. **Act** using the ref ID from the snapshot: `browser_click(target='ref-3')` or `browser_type(target='ref-5', text='query')`.
3. **Take another snapshot** after the action to see the updated page state.

⚠️ CRITICAL: Element refs (`ref-0`, `ref-1`, etc.) are INVALIDATED after every action (click, type, scroll, navigate). You MUST take a fresh snapshot before interacting again. Using stale refs will raise a `StaleTargetError`.

## Available Tools
| Tool | Purpose |
|------|---------|
| `browser_open` | Open session, optionally navigate to URL |
| `browser_navigate` | Navigate to a new URL |
| `browser_snapshot` | Get interactive elements with ref IDs |
| `browser_click` | Click element by ref ID or visible text |
| `browser_type` | Type text into input fields |
| `browser_scroll` | Scroll page (up/down/top/bottom) |
| `browser_tabs` | List, switch, or close tabs |
| `browser_extract` | Extract clean page text content |
| `browser_close` | Close the browser session |

## Error Handling
- **StaleTargetError**: You used an old ref. Take a new `browser_snapshot()` and retry.
- **TargetNotFoundError**: Element doesn't exist. Take a snapshot to verify page state.
- **SessionLostError**: Browser crashed. Call `browser_open()` to restart. Do NOT replay previous actions automatically.
- **NavigationTimeoutError**: Page load timed out. Try again or check the URL.

## Profiles
Profiles persist cookies, localStorage, and browsing state across sessions:
- `'default'` — ephemeral, no persistence
- `'work'` / `'personal'` — persistent profiles stored on disk

Use profiles when you need to maintain login state: `browser_open(url='https://...', profile='work')`

## Media & Music Playback (YouTube / Audio)
- By default, `browser_open()` opens a **visible GUI window on the desktop** with full audio/video playback support (`headless=False`).
- Media autoplay with sound is automatically configured for Firefox.
- When asked to play music or video (e.g. YouTube):
  1. Call `browser_open(url="https://www.youtube.com")`
  2. Take `browser_snapshot()` to get the search box reference ID.
  3. Type query using `browser_type(target="ref-N", text="Tamil songs\n")`.
  4. Take `browser_snapshot()` after results load.
  5. Click the top video result via `browser_click(target="ref-M")`.
  6. The visible browser window will open and play the song with full sound through speakers/headphones.

## Best Practices
- Start with `browser_open`.
- ⚠️ **DO NOT call `browser_close`** if the user asked to play music, watch a video, or keep the browser window open. Leave the browser window active on the user's desktop so media continues playing. Only call `browser_close` if the user explicitly asks to close the browser or for silent web extraction tasks.
- Never skip the snapshot step — blind clicking leads to errors.
- When searching, type into the search box ref and press Enter via `browser_click` on the submit button or use `browser_type(target='ref-N', text='query\n')`.
- For long pages, use `browser_scroll(direction='down')` then snapshot again to see new elements.
- Use `browser_extract()` to get clean text content instead of parsing snapshot elements.
- If a click opens a new tab, the browser auto-switches to it. Use `browser_tabs(action='list')` to see all open tabs."""
        ),
        (
            "💼",
            "Job Application Assistant",
            "Specialized skill for navigating job portals (LinkedIn, Greenhouse, Lever, Workday, Indeed, etc.), extracting form fields, and bulk-injecting applicant details via DOM.",
            r"""# Job Application Assistant Skill (Fast DOM Injection Mode)

Use this skill when navigating job search platforms, filling application forms, and applying for positions on company career portals (LinkedIn, Greenhouse, Lever, Workday, Indeed, Naukri, Wellfound).

## Single-Pass DOM Injection Workflow (Fast Job Mode)

Instead of typing field-by-field with individual clicks:

1. **Open Session**: Start with `browser_open(url="https://...")` (`headless=False`).
2. **Extract Form Fields**: Call `browser_job_extract_form()` to scan all input fields, labels, input types, and dropdown options across the active document and shadow roots in a single pass.
3. **Single-Pass Bulk DOM Injection**:
   Call `browser_job_bulk_autofill(field_data={...})` with a dictionary of applicant data e.g.:
   `{"first_name": "...", "last_name": "...", "email": "...", "phone": "...", "linkedin": "...", "work_authorization": "Yes"}`
   This injects all field values directly into the DOM in a single pass and dispatches HTML input/change/blur events.
4. **Re-Verification for Missing Fields**:
   Inspect the re-verification output returned by `browser_job_bulk_autofill()`. If any required fields remain unfilled (e.g. custom checkboxes or file inputs), use `browser_snapshot()` and targeted `browser_click` / `browser_type` to fill remaining gaps.
5. **Review Before Submission**:
   Take a final `browser_snapshot()` before submitting so the user can verify all details. **DO NOT** call `browser_close`."""
        )
    ]
    
    for icon, name, desc, content in defaults:
        cursor.execute("SELECT COUNT(*) FROM skills WHERE name = ?", (name,))
        if cursor.fetchone()[0] == 0:
            skill_id = str(uuid.uuid4())
            is_enabled = 1 if name in ("File & Directory Operations", "Network & Downloads", "Windows System Tasks", "CamoFox Browser", "Job Application Assistant") else 0
            cursor.execute(
                """
                INSERT INTO skills (id, name, description, content, icon, tool_ids, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)
                """,
                (skill_id, name, desc, content, icon, is_enabled, now, now)
            )
        else:
            cursor.execute(
                """
                UPDATE skills 
                SET description = ?, content = ?, icon = ?, updated_at = ? 
                WHERE name = ?
                """,
                (desc, content, icon, now, name)
            )

    conn.commit()
    conn.close()

def get_all_settings() -> Dict[str, str]:
    """Retrieve all settings as a dictionary"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    try:
        cursor.execute("SELECT key, value FROM settings")
        rows = cursor.fetchall()
        return {row["key"]: row["value"] for row in rows}
    except sqlite3.OperationalError:
        # Table might not exist yet
        return {}
    finally:
        conn.close()

def get_setting(key: str, default: Optional[str] = None) -> Optional[str]:
    """Retrieve a specific setting value"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    try:
        cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
        result = cursor.fetchone()
        return result[0] if result else default
    except sqlite3.OperationalError:
        return default
    finally:
        conn.close()

def update_setting(key: str, value: str):
    """Update or insert a setting"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
        (key, value, value)
    )
    
    conn.commit()
    conn.close()

def delete_setting(key: str):
    """Delete a setting"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("DELETE FROM settings WHERE key = ?", (key,))
    
    conn.commit()
    conn.close()

# Chat History Functions

def create_thread(title: str, thread_id: Optional[str] = None) -> str:
    """Create a new chat thread"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    if not thread_id:
        thread_id = str(uuid.uuid4())
    
    now = datetime.utcnow().isoformat()
    
    # Check if exists first to avoid error if reuse same ID
    cursor.execute("SELECT id FROM threads WHERE id = ?", (thread_id,))
    if cursor.fetchone():
        # Update timestamp if exists
        cursor.execute("UPDATE threads SET updated_at = ? WHERE id = ?", (now, thread_id))
    else:
        cursor.execute(
            "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (thread_id, title, now, now)
        )
    
    conn.commit()
    conn.close()
    return thread_id

def update_thread_title(thread_id: str, title: str) -> None:
    """Update a thread's display title."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        "UPDATE threads SET title = ?, updated_at = ? WHERE id = ?",
        (title.strip()[:120], now, thread_id),
    )
    conn.commit()
    conn.close()


def count_user_messages(thread_id: str) -> int:
    """Count user messages in a thread."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT COUNT(*) FROM messages WHERE thread_id = ? AND role = 'user' AND TRIM(COALESCE(content, '')) != ''",
        (thread_id,),
    )
    count = cursor.fetchone()[0]
    conn.close()
    return int(count or 0)


def save_message(thread_id: str, role: str, content: str, image_url: Optional[str] = None):
    """Save a message to a thread"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    now = datetime.utcnow().isoformat()
    
    # Ensure thread exists (create basic one if not found, though ideally should exist)
    cursor.execute("SELECT id FROM threads WHERE id = ?", (thread_id,))
    if not cursor.fetchone():
        create_thread("Untitled Chat", thread_id)
        
    cursor.execute(
        "INSERT INTO messages (thread_id, role, content, image_url, created_at) VALUES (?, ?, ?, ?, ?)",
        (thread_id, role, content, image_url, now)
    )
    
    # Update thread's updated_at
    cursor.execute("UPDATE threads SET updated_at = ? WHERE id = ?", (now, thread_id))
    
    conn.commit()
    conn.close()

def get_threads() -> List[Dict[str, Any]]:
    """Get all chat threads ordered by last update"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute(
        """
        SELECT
            t.*,
            ft.friend_id AS friend_id,
            ft.friend_name AS friend_name,
            tk_agg.knowledge_names AS knowledge_names
        FROM threads t
        LEFT JOIN friend_threads ft ON ft.thread_id = t.id
        LEFT JOIN (
            SELECT thread_id, json_group_array(knowledge_name) AS knowledge_names
            FROM thread_knowledge
            GROUP BY thread_id
        ) tk_agg ON tk_agg.thread_id = t.id
        ORDER BY t.updated_at DESC
        """
    )
    rows = cursor.fetchall()
    
    threads = []
    for row in rows:
        knowledge_names = []
        raw_names = row["knowledge_names"]
        if raw_names:
            try:
                parsed = json.loads(raw_names)
                if isinstance(parsed, list):
                    knowledge_names = [n for n in parsed if n]
            except (json.JSONDecodeError, TypeError):
                knowledge_names = []
        threads.append({
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "is_friend_chat": bool(row["friend_id"]),
            "friend_id": row["friend_id"],
            "friend_name": row["friend_name"],
            "is_knowledge_chat": len(knowledge_names) > 0,
            "knowledge_names": knowledge_names,
        })
        
    conn.close()
    return threads

def get_thread_messages(thread_id: str) -> List[Dict[str, Any]]:
    """Get all messages for a specific thread"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute(
        """
        SELECT
            m.*,
            ft.friend_id AS friend_id,
            ft.friend_name AS friend_name
        FROM messages m
        LEFT JOIN friend_threads ft ON ft.thread_id = m.thread_id
        WHERE m.thread_id = ?
        ORDER BY m.created_at ASC
        """,
        (thread_id,),
    )
    rows = cursor.fetchall()
    
    messages = []
    for row in rows:
        messages.append({
            "id": row["id"],
            "role": row["role"],
            "content": row["content"],
            "image_url": row["image_url"],
            "created_at": row["created_at"],
            "is_friend_chat": bool(row["friend_id"]),
            "friend_id": row["friend_id"],
            "friend_name": row["friend_name"],
        })
        
    conn.close()
    return messages


def fork_thread_messages(
    new_thread_id: str,
    source_thread_id: Optional[str] = None,
    until_message_id: Optional[Any] = None,
    messages_override: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Copy messages into a new thread before until_message_id (exclusive)."""
    to_insert: List[Dict[str, Any]] = []

    if messages_override:
        for m in messages_override:
            role = m.get("role")
            content = (m.get("content") or "").strip()
            if role == "assistant" and not content:
                continue
            if role not in ("user", "assistant"):
                continue
            if role == "user" and not content and not m.get("image_url"):
                continue
            to_insert.append(
                {
                    "role": role,
                    "content": content or ("(image)" if m.get("image_url") else ""),
                    "image_url": m.get("image_url"),
                }
            )
    elif source_thread_id:
        rows = get_thread_messages(source_thread_id)
        until_str = str(until_message_id) if until_message_id is not None else None
        for row in rows:
            if until_str is not None and str(row["id"]) == until_str:
                break
            to_insert.append(
                {
                    "role": row["role"],
                    "content": row["content"],
                    "image_url": row.get("image_url"),
                }
            )
    else:
        return []

    title = "Branched chat"
    for m in to_insert:
        if m["role"] == "user" and m.get("content"):
            text = m["content"]
            title = text[:30] + ("..." if len(text) > 30 else "")
            break

    create_thread(title, new_thread_id)

    for m in to_insert:
        save_message(
            new_thread_id,
            m["role"],
            m["content"],
            m.get("image_url"),
        )

    if source_thread_id:
        friend_row = get_friend_thread(source_thread_id)
        if friend_row:
            upsert_friend_thread(
                new_thread_id,
                friend_row["friend_id"],
                friend_row["friend_name"],
            )

    return to_insert


def delete_thread(thread_id: str):
    """Delete a thread and its messages"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
    cursor.execute("DELETE FROM friend_threads WHERE thread_id = ?", (thread_id,))
    cursor.execute("DELETE FROM thread_knowledge WHERE thread_id = ?", (thread_id,))
    cursor.execute("DELETE FROM threads WHERE id = ?", (thread_id,))
    
    conn.commit()
    conn.close()
def delete_last_message(thread_id: str, role: Optional[str] = None):
    """Delete the most recent message in a thread, optionally filtering by role"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    if role:
        # Delete the latest message with a specific role
        cursor.execute(
            "DELETE FROM messages WHERE id = (SELECT MAX(id) FROM messages WHERE thread_id = ? AND role = ?)",
            (thread_id, role)
        )
    else:
        # Delete the latest message regardless of role
        cursor.execute(
            "DELETE FROM messages WHERE id = (SELECT MAX(id) FROM messages WHERE thread_id = ?)",
            (thread_id,)
        )
    
    conn.commit()
    conn.close()


# --- Peer query history (inbound / outbound connectivity) ---

PEER_QUERY_TEXT_MAX = 8192
PEER_RESPONSE_PREVIEW_MAX = 2048
PEER_ERROR_DETAIL_MAX = 1024
PEER_QUERY_EVENTS_RETENTION = 500


def _truncate_peer_text(value: Optional[str], max_len: int) -> Optional[str]:
    if value is None:
        return None
    s = str(value)
    if len(s) <= max_len:
        return s
    return s[: max_len - 3] + "..."


def append_peer_query_event(
    direction: str,
    friend_id: Optional[str],
    friend_name: Optional[str],
    query_text: str,
    status: str,
    response_preview: Optional[str] = None,
    error_detail: Optional[str] = None,
) -> None:
    """Append one peer query event and prune to PEER_QUERY_EVENTS_RETENTION rows."""
    if direction not in ("inbound", "outbound"):
        direction = "outbound"
    if status not in ("ok", "error"):
        status = "error"
    event_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    q = _truncate_peer_text(query_text, PEER_QUERY_TEXT_MAX) or ""
    prev = _truncate_peer_text(response_preview, PEER_RESPONSE_PREVIEW_MAX)
    err = _truncate_peer_text(error_detail, PEER_ERROR_DETAIL_MAX)

    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO peer_query_events (
                id, direction, friend_id, friend_name, query_text, status,
                response_preview, error_detail, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                direction,
                friend_id,
                friend_name,
                q,
                status,
                prev,
                err,
                now,
            ),
        )
        cursor.execute("SELECT COUNT(*) FROM peer_query_events")
        count_row = cursor.fetchone()
        n = int(count_row[0]) if count_row else 0
        if n > PEER_QUERY_EVENTS_RETENTION:
            to_delete = n - PEER_QUERY_EVENTS_RETENTION
            cursor.execute(
                """
                DELETE FROM peer_query_events WHERE id IN (
                    SELECT id FROM peer_query_events ORDER BY created_at ASC LIMIT ?
                )
                """,
                (to_delete,),
            )
        conn.commit()
    finally:
        conn.close()


def list_peer_query_events(limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    """Newest first."""
    if limit < 1:
        limit = 1
    if limit > 500:
        limit = 500
    if offset < 0:
        offset = 0
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT id, direction, friend_id, friend_name, query_text, status,
                   response_preview, error_detail, created_at
            FROM peer_query_events
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )
        return [dict(r) for r in cursor.fetchall()]
    finally:
        conn.close()


def clear_peer_query_events() -> int:
    """Delete all peer query events. Returns number of rows removed."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT COUNT(*) FROM peer_query_events")
        n = int(cursor.fetchone()[0])
        cursor.execute("DELETE FROM peer_query_events")
        conn.commit()
        return n
    finally:
        conn.close()


# --- Scheduled tasks & UI notifications ---

def insert_scheduled_task(
    task_id: str,
    thread_id: str,
    text: str,
    run_at_iso: str,
    intent: str,
    title: Optional[str],
    status: str = "pending",
) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO scheduled_tasks (id, thread_id, text, run_at, intent, title, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (task_id, thread_id, text, run_at_iso, intent, title, status, now),
    )
    conn.commit()
    conn.close()


def update_scheduled_task_status(task_id: str, status: str) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    if status in ("completed", "failed", "cancelled"):
        cursor.execute(
            "UPDATE scheduled_tasks SET status = ?, completed_at = ? WHERE id = ?",
            (status, now, task_id),
        )
    else:
        cursor.execute(
            "UPDATE scheduled_tasks SET status = ? WHERE id = ?",
            (status, task_id),
        )
    conn.commit()
    conn.close()


def get_pending_scheduled_tasks_rows() -> List[Dict[str, Any]]:
    """Tasks still marked pending (used for listing and resync)."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM scheduled_tasks WHERE status = 'pending' ORDER BY run_at ASC"
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def insert_schedule_notification(
    notif_id: str,
    thread_id: Optional[str],
    task_id: Optional[str],
    intent: str,
    title: str,
    body: str,
) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO schedule_notifications (id, thread_id, task_id, intent, title, body, created_at, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        """,
        (notif_id, thread_id, task_id, intent, title, body, now),
    )
    conn.commit()
    conn.close()


def get_unread_schedule_notifications(limit: int = 50) -> List[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT * FROM schedule_notifications
        WHERE read_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def mark_schedule_notification_read(notif_id: str) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        "UPDATE schedule_notifications SET read_at = ? WHERE id = ?",
        (now, notif_id),
    )
    conn.commit()
    conn.close()


def mark_all_schedule_notifications_read() -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        "UPDATE schedule_notifications SET read_at = ? WHERE read_at IS NULL",
        (now,),
    )
    conn.commit()
    conn.close()


def _generate_device_identity() -> Dict[str, str]:
    now = datetime.utcnow().isoformat()
    public_key = secrets.token_hex(32)
    digest = hashlib.sha256(public_key.encode("utf-8")).hexdigest()
    fingerprint = f"SHA256:{digest}"
    device_id = f"rie-{secrets.token_hex(4)}"
    return {
        "device_id": device_id,
        "name": "My Rie",
        "public_key": public_key,
        "fingerprint": fingerprint,
        "created_at": now,
        "updated_at": now,
    }


def get_or_create_device_identity() -> Dict[str, Any]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM device_identity WHERE id = 1")
    row = cursor.fetchone()
    if row:
        conn.close()
        return dict(row)

    identity = _generate_device_identity()
    cursor.execute(
        """
        INSERT INTO device_identity (id, device_id, name, public_key, fingerprint, created_at, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        """,
        (
            identity["device_id"],
            identity["name"],
            identity["public_key"],
            identity["fingerprint"],
            identity["created_at"],
            identity["updated_at"],
        ),
    )
    conn.commit()
    conn.close()
    return {"id": 1, **identity}


def update_device_identity_name(name: str) -> Dict[str, Any]:
    identity = get_or_create_device_identity()
    now = datetime.utcnow().isoformat()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE device_identity SET name = ?, updated_at = ? WHERE id = 1",
        (name.strip() or identity["name"], now),
    )
    conn.commit()
    conn.close()
    identity["name"] = name.strip() or identity["name"]
    identity["updated_at"] = now
    return identity


def create_pairing_token(ttl_seconds: int = 600) -> str:
    token = secrets.token_urlsafe(24)
    now = datetime.utcnow()
    expires = datetime.fromtimestamp(now.timestamp() + ttl_seconds)
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM friend_pair_tokens WHERE expires_at < ?", (now.isoformat(),))
    cursor.execute(
        "INSERT INTO friend_pair_tokens (token, created_at, expires_at) VALUES (?, ?, ?)",
        (token, now.isoformat(), expires.isoformat()),
    )
    conn.commit()
    conn.close()
    return token


def consume_pairing_token(token: str) -> bool:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    now_iso = datetime.utcnow().isoformat()
    cursor.execute("SELECT token, expires_at FROM friend_pair_tokens WHERE token = ?", (token,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return False
    if row["expires_at"] < now_iso:
        cursor.execute("DELETE FROM friend_pair_tokens WHERE token = ?", (token,))
        conn.commit()
        conn.close()
        return False
    cursor.execute("DELETE FROM friend_pair_tokens WHERE token = ?", (token,))
    conn.commit()
    conn.close()
    return True


def upsert_friend(
    name: str,
    device_id: str,
    fingerprint: str,
    public_key: str,
    public_url: Optional[str] = None,
) -> Dict[str, Any]:
    now = datetime.utcnow().isoformat()
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT id, created_at FROM friends WHERE device_id = ?", (device_id,))
    existing = cursor.fetchone()
    if existing:
        friend_id = existing["id"]
        cursor.execute(
            """
            UPDATE friends
            SET name = ?, fingerprint = ?, public_key = ?, public_url = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, fingerprint, public_key, public_url, now, friend_id),
        )
    else:
        friend_id = str(uuid.uuid4())
        cursor.execute(
            """
            INSERT INTO friends (id, name, device_id, fingerprint, public_key, public_url, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (friend_id, name, device_id, fingerprint, public_key, public_url, now, now),
        )
    conn.commit()
    cursor.execute("SELECT * FROM friends WHERE id = ?", (friend_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {}


def list_friends() -> List[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM friends ORDER BY updated_at DESC")
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def get_friend_by_id(friend_id: str) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM friends WHERE id = ?", (friend_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_friend_by_device_id(device_id: str) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM friends WHERE device_id = ?", (device_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def delete_friend(friend_id: str) -> bool:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM friend_thread_approvals WHERE friend_id = ?", (friend_id,))
    cursor.execute("DELETE FROM friend_threads WHERE friend_id = ?", (friend_id,))
    cursor.execute("DELETE FROM friends WHERE id = ?", (friend_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def has_friend_thread_approval(thread_id: str, friend_id: str) -> bool:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT 1 FROM friend_thread_approvals WHERE thread_id = ? AND friend_id = ?",
        (thread_id, friend_id),
    )
    row = cursor.fetchone()
    conn.close()
    return row is not None


def approve_friend_for_thread(thread_id: str, friend_id: str) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO friend_thread_approvals (thread_id, friend_id, approved_at)
        VALUES (?, ?, ?)
        ON CONFLICT(thread_id, friend_id) DO UPDATE SET approved_at = excluded.approved_at
        """,
        (thread_id, friend_id, now),
    )
    conn.commit()
    conn.close()


def upsert_friend_thread(thread_id: str, friend_id: str, friend_name: str) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO friend_threads (thread_id, friend_id, friend_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
            friend_id = excluded.friend_id,
            friend_name = excluded.friend_name,
            updated_at = excluded.updated_at
        """,
        (thread_id, friend_id, friend_name, now, now),
    )
    conn.commit()
    conn.close()


def get_friend_thread(thread_id: str) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM friend_threads WHERE thread_id = ?", (thread_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def update_friend_peer_access(friend_id: str, peer_access_json: Optional[str]) -> Optional[Dict[str, Any]]:
    """Persist JSON policy for inbound peer access. Pass None to clear."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        "UPDATE friends SET peer_access_json = ?, updated_at = ? WHERE id = ?",
        (peer_access_json, now, friend_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM friends WHERE id = ?", (friend_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def update_friend_public_url(friend_id: str, public_url: Optional[str]) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    normalized_url = (public_url or "").strip() or None
    cursor.execute(
        "UPDATE friends SET public_url = ?, updated_at = ? WHERE id = ?",
        (normalized_url, now, friend_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM friends WHERE id = ?", (friend_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


# --- Custom knowledge packs ---


def create_knowledge_pack(name: str, instructions: str = "") -> Dict[str, Any]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    pack_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO knowledge_packs (id, name, instructions, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (pack_id, name.strip(), (instructions or "").strip(), now, now),
    )
    conn.commit()
    cursor.execute("SELECT * FROM knowledge_packs WHERE id = ?", (pack_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {}


def update_knowledge_pack(pack_id: str, name: Optional[str] = None, instructions: Optional[str] = None) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM knowledge_packs WHERE id = ?", (pack_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None
    now = datetime.utcnow().isoformat()
    new_name = name.strip() if name is not None else existing["name"]
    new_instructions = instructions.strip() if instructions is not None else (existing["instructions"] or "")
    cursor.execute(
        "UPDATE knowledge_packs SET name = ?, instructions = ?, updated_at = ? WHERE id = ?",
        (new_name, new_instructions, now, pack_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM knowledge_packs WHERE id = ?", (pack_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_knowledge_pack(pack_id: str) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM knowledge_packs WHERE id = ?", (pack_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def list_knowledge_packs() -> List[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT kp.*, COUNT(ka.id) AS asset_count
        FROM knowledge_packs kp
        LEFT JOIN knowledge_assets ka ON ka.pack_id = kp.id
        GROUP BY kp.id
        ORDER BY kp.updated_at DESC
        """
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_knowledge_pack(pack_id: str) -> bool:
    """Delete pack if not referenced by locked threads."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT 1 FROM thread_knowledge WHERE knowledge_id = ? AND is_locked = 1 LIMIT 1",
        (pack_id,),
    )
    if cursor.fetchone():
        conn.close()
        return False
    cursor.execute("DELETE FROM thread_knowledge WHERE knowledge_id = ?", (pack_id,))
    cursor.execute("DELETE FROM knowledge_assets WHERE pack_id = ?", (pack_id,))
    cursor.execute("DELETE FROM knowledge_packs WHERE id = ?", (pack_id,))
    conn.commit()
    conn.close()
    pack_dir = get_knowledge_storage_dir() / pack_id
    if pack_dir.exists():
        import shutil
        shutil.rmtree(pack_dir, ignore_errors=True)
    return True


def create_knowledge_asset(
    pack_id: str,
    filename: str,
    asset_type: str,
    storage_path: str,
    summary: Optional[str] = None,
) -> Dict[str, Any]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    asset_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO knowledge_assets (id, pack_id, filename, asset_type, storage_path, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (asset_id, pack_id, filename, asset_type, storage_path, summary, now),
    )
    cursor.execute(
        "UPDATE knowledge_packs SET updated_at = ? WHERE id = ?",
        (now, pack_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM knowledge_assets WHERE id = ?", (asset_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else {}


def get_knowledge_assets(pack_id: str) -> List[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM knowledge_assets WHERE pack_id = ? ORDER BY created_at ASC",
        (pack_id,),
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_knowledge_asset_summary(asset_id: str, summary: str) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("UPDATE knowledge_assets SET summary = ? WHERE id = ?", (summary, asset_id))
    conn.commit()
    conn.close()


def delete_knowledge_asset(asset_id: str) -> Optional[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM knowledge_assets WHERE id = ?", (asset_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None
    cursor.execute("DELETE FROM knowledge_assets WHERE id = ?", (asset_id,))
    now = datetime.utcnow().isoformat()
    cursor.execute(
        "UPDATE knowledge_packs SET updated_at = ? WHERE id = ?",
        (now, row["pack_id"]),
    )
    conn.commit()
    conn.close()
    return dict(row)


def get_thread_knowledge(thread_id: str) -> List[Dict[str, Any]]:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM thread_knowledge WHERE thread_id = ? ORDER BY attached_at ASC",
        (thread_id,),
    )
    rows = cursor.fetchall()
    conn.close()
    result = []
    for row in rows:
        d = dict(row)
        d["is_locked"] = bool(d.get("is_locked"))
        result.append(d)
    return result


def upsert_thread_knowledge(
    thread_id: str,
    knowledge_id: str,
    knowledge_name: str,
    context_snapshot: Optional[str] = None,
) -> None:
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO thread_knowledge (thread_id, knowledge_id, knowledge_name, context_snapshot, is_locked, attached_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(thread_id, knowledge_id) DO UPDATE SET
            knowledge_name = excluded.knowledge_name,
            context_snapshot = COALESCE(thread_knowledge.context_snapshot, excluded.context_snapshot)
        """,
        (thread_id, knowledge_id, knowledge_name, context_snapshot, now),
    )
    conn.commit()
    conn.close()


def lock_thread_knowledge(thread_id: str, snapshots: Optional[Dict[str, str]] = None) -> None:
    """Lock all knowledge on a thread; save snapshots only for rows not yet locked."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    snapshots = snapshots or {}
    cursor.execute(
        "SELECT knowledge_id, is_locked, context_snapshot FROM thread_knowledge WHERE thread_id = ?",
        (thread_id,),
    )
    for row in cursor.fetchall():
        kid = row[0]
        already_locked = bool(row[1])
        existing_snap = row[2]
        snap = snapshots.get(kid)
        if already_locked and existing_snap:
            cursor.execute(
                "UPDATE thread_knowledge SET is_locked = 1 WHERE thread_id = ? AND knowledge_id = ?",
                (thread_id, kid),
            )
        elif snap:
            cursor.execute(
                "UPDATE thread_knowledge SET is_locked = 1, context_snapshot = ? WHERE thread_id = ? AND knowledge_id = ?",
                (snap, thread_id, kid),
            )
        else:
            cursor.execute(
                "UPDATE thread_knowledge SET is_locked = 1 WHERE thread_id = ? AND knowledge_id = ?",
                (thread_id, kid),
            )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Skills CRUD
# ---------------------------------------------------------------------------

SYSTEM_SKILL_NAMES = {
    "File & Directory Operations",
    "Network & Downloads",
    "Windows System Tasks",
    "PowerShell Style & Scripting",
    "Computer Use Guide",
    "PDF Generation Expert",
    "CamoFox Browser",
    "Job Application Assistant",
}


def _skill_row_to_dict(row) -> Dict[str, Any]:
    """Convert a skills DB row to a plain dict with tool_ids as a list."""
    d = dict(row)
    try:
        d["tool_ids"] = json.loads(d.get("tool_ids") or "[]")
    except (json.JSONDecodeError, TypeError):
        d["tool_ids"] = []
    d["enabled"] = bool(d.get("enabled", 1))
    d["is_system"] = d.get("name") in SYSTEM_SKILL_NAMES
    return d


def create_skill(
    name: str,
    description: str = "",
    content: str = "",
    icon: str = "🧠",
    tool_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Create a new skill and return the created row."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    skill_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    cursor.execute(
        """
        INSERT INTO skills (id, name, description, content, icon, tool_ids, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (skill_id, name, description, content, icon, json.dumps(tool_ids or []), now, now),
    )
    conn.commit()
    cursor.execute("SELECT * FROM skills WHERE id = ?", (skill_id,))
    row = cursor.fetchone()
    conn.close()
    return _skill_row_to_dict(row)


def update_skill(
    skill_id: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    content: Optional[str] = None,
    icon: Optional[str] = None,
    tool_ids: Optional[List[str]] = None,
    enabled: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    """Update a skill's fields."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM skills WHERE id = ?", (skill_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None
    now = datetime.utcnow().isoformat()
    fields: List[str] = []
    values: List[Any] = []
    if name is not None:
        fields.append("name = ?")
        values.append(name.strip())
    if description is not None:
        fields.append("description = ?")
        values.append(description.strip())
    if content is not None:
        fields.append("content = ?")
        values.append(content)
    if icon is not None:
        fields.append("icon = ?")
        values.append(icon)
    if tool_ids is not None:
        fields.append("tool_ids = ?")
        values.append(json.dumps(tool_ids))
    if enabled is not None:
        fields.append("enabled = ?")
        values.append(1 if enabled else 0)
    fields.append("updated_at = ?")
    values.append(now)
    values.append(skill_id)
    cursor.execute(f"UPDATE skills SET {', '.join(fields)} WHERE id = ?", values)
    conn.commit()
    cursor.execute("SELECT * FROM skills WHERE id = ?", (skill_id,))
    updated = cursor.fetchone()
    conn.close()
    return _skill_row_to_dict(updated) if updated else None


def get_skill(skill_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a single skill by ID."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM skills WHERE id = ?", (skill_id,))
    row = cursor.fetchone()
    conn.close()
    return _skill_row_to_dict(row) if row else None


def list_skills() -> List[Dict[str, Any]]:
    """Return all skills ordered by creation date."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM skills ORDER BY created_at ASC")
    rows = cursor.fetchall()
    conn.close()
    return [_skill_row_to_dict(r) for r in rows]


def delete_skill(skill_id: str) -> bool:
    """Delete a skill and its thread attachments. Returns True if deleted."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT id, name FROM skills WHERE id = ?", (skill_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return False
    if row["name"] in SYSTEM_SKILL_NAMES:
        conn.close()
        raise ValueError(f"System skill '{row['name']}' is protected and cannot be deleted.")
    cursor.execute("DELETE FROM thread_skills WHERE skill_id = ?", (skill_id,))
    cursor.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
    conn.commit()
    conn.close()
    return True


def clear_all_checkpoints():
    """Clear all tables in the checkpoints database to remove LangGraph state for all threads."""
    db_path = get_checkpoint_db_path()
    if not os.path.exists(db_path):
        return
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cursor.fetchall()]
        for table in tables:
            if not table.startswith("sqlite_"):
                cursor.execute(f"DELETE FROM {table}")
        conn.commit()
    except Exception as e:
        logging.error(f"Error clearing checkpoints db: {e}")
    finally:
        conn.close()


def clear_all_history():
    """Delete all chat threads, messages, and associated thread data."""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    try:
        cursor.execute("DELETE FROM messages")
        cursor.execute("DELETE FROM friend_threads")
        cursor.execute("DELETE FROM friend_thread_approvals")
        cursor.execute("DELETE FROM thread_knowledge")
        cursor.execute("DELETE FROM thread_skills")
        cursor.execute("DELETE FROM scheduled_tasks")
        cursor.execute("DELETE FROM schedule_notifications")
        cursor.execute("DELETE FROM threads")
        
        conn.commit()
    except Exception as e:
        logging.error(f"Error clearing history: {e}")
        raise e
    finally:
        conn.close()
        
    clear_all_checkpoints()
    
    # Run vacuum on checkpoints db to reclaim space
    try:
        vacuum_checkpoint_db()
    except Exception as e:
        logging.error(f"Error vacuuming checkpoints db: {e}")
        
    # Run vacuum on main db as well
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("VACUUM")
    except Exception as e:
        logging.error(f"Error vacuuming main db: {e}")
    finally:
        conn.close()


def export_backup_data(sections: List[str]) -> Dict[str, Any]:
    """Gather and serialize configuration, history, and knowledge into a backup dict"""
    import base64
    backup = {"version": 1, "exported_at": datetime.utcnow().isoformat()}
    db_path = get_db_path()
    
    # 1. Settings (excluding EXTERNAL_APIS and MCP_SERVERS which have their own sections)
    if "settings" in sections:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT key, value FROM settings WHERE key NOT IN ('EXTERNAL_APIS', 'MCP_SERVERS')")
            rows = cursor.fetchall()
            backup["settings"] = {r["key"]: r["value"] for r in rows}
        except Exception as e:
            logging.error(f"Error exporting settings: {e}")
        finally:
            conn.close()
            
    # 2. External APIs
    if "apis" in sections:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT value FROM settings WHERE key = 'EXTERNAL_APIS'")
            row = cursor.fetchone()
            backup["external_apis"] = json.loads(row[0]) if row and row[0] else []
        except Exception as e:
            logging.error(f"Error exporting external APIs: {e}")
        finally:
            conn.close()
            
    # 3. Tools (MCP Servers & Skills)
    if "tools" in sections:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        try:
            # MCP Servers
            cursor.execute("SELECT value FROM settings WHERE key = 'MCP_SERVERS'")
            row = cursor.fetchone()
            backup["mcp_servers"] = json.loads(row[0]) if row and row[0] else []
            
            # Skills table
            cursor.execute("SELECT * FROM skills")
            skill_rows = cursor.fetchall()
            backup["skills"] = []
            for r in skill_rows:
                sd = dict(r)
                # Parse tool_ids if stored as JSON string
                if isinstance(sd.get("tool_ids"), str):
                    try:
                        sd["tool_ids"] = json.loads(sd["tool_ids"])
                    except Exception:
                        pass
                backup["skills"].append(sd)
        except Exception as e:
            logging.error(f"Error exporting tools: {e}")
        finally:
            conn.close()
            
    # 4. Conversations (threads, messages, thread_skills, thread_knowledge, friend_threads)
    if "conversations" in sections:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT * FROM threads")
            threads = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM messages")
            messages = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM thread_skills")
            thread_skills = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM thread_knowledge")
            thread_knowledge = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM friend_threads")
            friend_threads = [dict(r) for r in cursor.fetchall()]
            
            backup["conversations"] = {
                "threads": threads,
                "messages": messages,
                "thread_skills": thread_skills,
                "thread_knowledge": thread_knowledge,
                "friend_threads": friend_threads
            }
        except Exception as e:
            logging.error(f"Error exporting conversations: {e}")
        finally:
            conn.close()
            
    # 5. Knowledge (packs, assets, files)
    if "knowledge" in sections:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT * FROM knowledge_packs")
            packs = [dict(r) for r in cursor.fetchall()]
            
            cursor.execute("SELECT * FROM knowledge_assets")
            assets = [dict(r) for r in cursor.fetchall()]
            
            # Read all files for assets
            knowledge_dir = get_knowledge_storage_dir()
            backup["knowledge_packs"] = packs
            backup["knowledge_assets"] = []
            
            for asset in assets:
                asset_dict = dict(asset)
                rel_path = asset_dict.get("storage_path")
                if rel_path:
                    abs_path = knowledge_dir / rel_path
                    if abs_path.exists() and abs_path.is_file():
                        try:
                            file_bytes = abs_path.read_bytes()
                            asset_dict["file_bytes_b64"] = base64.b64encode(file_bytes).decode("ascii")
                        except Exception as file_err:
                            logging.error(f"Failed to read knowledge file {abs_path}: {file_err}")
                backup["knowledge_assets"].append(asset_dict)
        except Exception as e:
            logging.error(f"Error exporting knowledge: {e}")
        finally:
            conn.close()
            
    return backup


def import_backup_data(import_sections: List[str], data: Dict[str, Any]) -> Dict[str, Any]:
    """De-serialize and merge backed-up configuration, history, and files into SQLite and disk"""
    import base64
    db_path = get_db_path()
    result = {"success": True, "messages": []}
    
    # 1. Settings
    if "settings" in import_sections and "settings" in data:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        try:
            settings_dict = data["settings"]
            for key, val in settings_dict.items():
                cursor.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
                    (key, val, val)
                )
            conn.commit()
            result["messages"].append(f"Imported {len(settings_dict)} settings.")
        except Exception as e:
            conn.rollback()
            logging.error(f"Error importing settings: {e}")
            result["messages"].append(f"Failed to import settings: {str(e)}")
        finally:
            conn.close()
            
    # 2. External APIs
    if "apis" in import_sections and "external_apis" in data:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        try:
            apis_list = data["external_apis"]
            apis_json = json.dumps(apis_list)
            cursor.execute(
                "INSERT INTO settings (key, value) VALUES ('EXTERNAL_APIS', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
                (apis_json, apis_json)
            )
            conn.commit()
            result["messages"].append(f"Imported {len(apis_list)} external APIs.")
        except Exception as e:
            conn.rollback()
            logging.error(f"Error importing external APIs: {e}")
            result["messages"].append(f"Failed to import external APIs: {str(e)}")
        finally:
            conn.close()
            
    # 3. Tools (MCP Servers & Skills)
    if "tools" in import_sections:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        try:
            # MCP Servers
            mcp_servers = data.get("mcp_servers", [])
            mcp_json = json.dumps(mcp_servers)
            cursor.execute(
                "INSERT INTO settings (key, value) VALUES ('MCP_SERVERS', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
                (mcp_json, mcp_json)
            )
            
            # Skills
            skills = data.get("skills", [])
            for skill in skills:
                tool_ids_val = skill.get("tool_ids", "[]")
                if not isinstance(tool_ids_val, str):
                    tool_ids_val = json.dumps(tool_ids_val)
                cursor.execute(
                    """
                    INSERT INTO skills (id, name, description, content, icon, tool_ids, enabled, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        description = excluded.description,
                        content = excluded.content,
                        icon = excluded.icon,
                        tool_ids = excluded.tool_ids,
                        enabled = excluded.enabled,
                        updated_at = excluded.updated_at
                    """,
                    (
                        skill.get("id"),
                        skill.get("name"),
                        skill.get("description", ""),
                        skill.get("content", ""),
                        skill.get("icon", "🧠"),
                        tool_ids_val,
                        skill.get("enabled", 1),
                        skill.get("created_at"),
                        skill.get("updated_at")
                    )
                )
            conn.commit()
            result["messages"].append(f"Imported {len(mcp_servers)} MCP servers and {len(skills)} skills.")
        except Exception as e:
            conn.rollback()
            logging.error(f"Error importing tools: {e}")
            result["messages"].append(f"Failed to import tools: {str(e)}")
        finally:
            conn.close()
            
    # 4. Conversations
    if "conversations" in import_sections and "conversations" in data:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        try:
            conv_data = data["conversations"]
            
            threads = conv_data.get("threads", [])
            messages = conv_data.get("messages", [])
            thread_skills = conv_data.get("thread_skills", [])
            thread_knowledge = conv_data.get("thread_knowledge", [])
            friend_threads = conv_data.get("friend_threads", [])
            
            # Import threads
            for thread in threads:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO threads (id, title, created_at, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (thread.get("id"), thread.get("title"), thread.get("created_at"), thread.get("updated_at"))
                )
                
            # Import messages
            for msg in messages:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO messages (id, thread_id, role, content, image_url, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (msg.get("id"), msg.get("thread_id"), msg.get("role"), msg.get("content"), msg.get("image_url"), msg.get("created_at"))
                )
                
            # Import thread_skills
            for ts in thread_skills:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO thread_skills (id, thread_id, skill_id, attached_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (ts.get("id"), ts.get("thread_id"), ts.get("skill_id"), ts.get("attached_at"))
                )
                
            # Import thread_knowledge
            for tk in thread_knowledge:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO thread_knowledge (thread_id, knowledge_id, knowledge_name, context_snapshot, is_locked, attached_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        tk.get("thread_id"),
                        tk.get("knowledge_id"),
                        tk.get("knowledge_name"),
                        tk.get("context_snapshot"),
                        tk.get("is_locked", 0),
                        tk.get("attached_at")
                    )
                )
                
            # Import friend_threads
            for ft in friend_threads:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO friend_threads (thread_id, friend_id, friend_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (ft.get("thread_id"), ft.get("friend_id"), ft.get("friend_name"), ft.get("created_at"), ft.get("updated_at"))
                )
                
            conn.commit()
            result["messages"].append(f"Imported {len(threads)} threads and {len(messages)} messages.")
        except Exception as e:
            conn.rollback()
            logging.error(f"Error importing conversations: {e}")
            result["messages"].append(f"Failed to import conversations: {str(e)}")
        finally:
            conn.close()
            
    # 5. Knowledge packs
    if "knowledge" in import_sections:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        try:
            packs = data.get("knowledge_packs", [])
            assets = data.get("knowledge_assets", [])
            
            # Import packs
            for pack in packs:
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO knowledge_packs (id, name, instructions, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (pack.get("id"), pack.get("name"), pack.get("instructions"), pack.get("created_at"), pack.get("updated_at"))
                )
                
            # Import assets & write files
            knowledge_dir = get_knowledge_storage_dir()
            success_count = 0
            for asset in assets:
                pack_id = asset.get("pack_id")
                asset_id = asset.get("id")
                filename = asset.get("filename")
                rel_path = asset.get("storage_path")
                
                # Check for file data
                b64_content = asset.get("file_bytes_b64")
                if b64_content and rel_path:
                    abs_path = knowledge_dir / rel_path
                    try:
                        abs_path.parent.mkdir(parents=True, exist_ok=True)
                        file_bytes = base64.b64decode(b64_content)
                        abs_path.write_bytes(file_bytes)
                        
                        cursor.execute(
                            """
                            INSERT OR REPLACE INTO knowledge_assets (id, pack_id, filename, asset_type, storage_path, summary, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                asset_id,
                                pack_id,
                                filename,
                                asset.get("asset_type"),
                                rel_path,
                                asset.get("summary"),
                                asset.get("created_at")
                            )
                        )
                        success_count += 1
                    except Exception as file_err:
                        logging.error(f"Failed to write knowledge file {abs_path} on import: {file_err}")
                else:
                    cursor.execute(
                        """
                        INSERT OR REPLACE INTO knowledge_assets (id, pack_id, filename, asset_type, storage_path, summary, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            asset_id,
                            pack_id,
                            filename,
                            asset.get("asset_type"),
                            rel_path,
                            asset.get("summary"),
                            asset.get("created_at")
                        )
                    )
                    success_count += 1
                    
            conn.commit()
            result["messages"].append(f"Imported {len(packs)} knowledge packs and {success_count} assets.")
        except Exception as e:
            conn.rollback()
            logging.error(f"Error importing knowledge: {e}")
            result["messages"].append(f"Failed to import knowledge: {str(e)}")
        finally:
            conn.close()
            
    return result






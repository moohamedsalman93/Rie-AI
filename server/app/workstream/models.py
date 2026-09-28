"""
Data models and contracts for the Rie-AI Workstream Engine.
Defines the wire format for events collected by the native Tauri/Rust collector.
"""
from datetime import datetime, timezone
import hashlib
import os
from typing import Any, Dict, List, Optional, Union
import uuid
from pydantic import BaseModel, Field


def _current_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class ActivityEvent(BaseModel):
    """Event representing an application window change, focus shift, or state transition."""
    id: Optional[str] = None
    timestamp: str = Field(default_factory=_current_utc_iso, description="ISO-8601 formatted timestamp")
    event_type: str = Field(
        ...,
        description="Type of event, e.g. 'window_focus', 'idle_start', 'idle_end', 'app_launch'"
    )
    app_name: str = Field(..., description="Display name of the application, e.g. 'Visual Studio Code', 'Google Chrome'")
    process_name: Optional[str] = Field(None, description="Executable process name, e.g. 'Code.exe', 'chrome.exe'")
    window_title: Optional[str] = Field(None, description="Current window title text")
    source: str = Field("tauri_native", description="Origin of the event, e.g. 'tauri_native', 'browser_ext', 'vscode_ext'")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary extra metadata (e.g. url, file_path, git_branch)")
    duration_seconds: float = Field(0.0, description="Active focused duration in seconds (computed when focus leaves)")


class ClipboardEvent(BaseModel):
    """Event representing a copied clipboard item."""
    id: Optional[str] = None
    timestamp: str = Field(default_factory=_current_utc_iso, description="ISO-8601 formatted timestamp")
    app_name: Optional[str] = Field(None, description="Application from which the text was copied")
    content: str = Field(..., description="Copied text content")
    content_hash: Optional[str] = Field(None, description="SHA-256 hash of content for deduplication")
    content_type: str = Field("text", description="Detected content type: 'code', 'url', 'text'")

    def compute_hash(self) -> str:
        """Computes SHA-256 hash if not provided."""
        if not self.content_hash:
            self.content_hash = hashlib.sha256(self.content.encode("utf-8", errors="ignore")).hexdigest()
        return self.content_hash


class BrowserEvent(BaseModel):
    """Event sent by Chrome/Brave/Edge browser extensions representing active tab context or tab switch."""
    event_type: str = Field(default="browser_tab", description="Type of browser event, e.g. 'browser_tab', 'tab_activated', 'tab_updated'")
    browser: Optional[str] = Field(default="Browser", description="Browser name: 'Brave', 'Google Chrome', 'Edge', etc.")
    url: str = Field(..., description="Active tab URL")
    title: Optional[str] = Field(default=None, description="Active tab page title")
    timestamp: str = Field(default_factory=_current_utc_iso, description="ISO-8601 formatted timestamp")
    duration_seconds: float = Field(default=0.0, description="Active time on previous tab in seconds, if known")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary extra metadata (e.g. tab_id, window_id)")

    def to_activity_event(self) -> ActivityEvent:
        """Converts browser event into unified ActivityEvent for storage in SQLite."""
        meta = dict(self.metadata)
        meta["url"] = self.url
        if self.title:
            meta["title"] = self.title
        if self.browser:
            meta["browser"] = self.browser

        app_name = self.browser or "Browser"
        clean_proc = app_name.lower().replace(" ", "").replace("google", "")
        if not clean_proc.endswith(".exe"):
            clean_proc = f"{clean_proc}.exe"

        return ActivityEvent(
            event_type=self.event_type or "browser_tab",
            app_name=app_name,
            process_name=clean_proc,
            window_title=self.title or self.url,
            source="browser_ext",
            timestamp=self.timestamp or _current_utc_iso(),
            metadata=meta,
            duration_seconds=float(self.duration_seconds or 0.0)
        )


class IDEEvent(BaseModel):
    """Event sent by VS Code / Antigravity extension representing active editor context or file save diffs."""
    event_type: str = Field(default="ide_context", description="'ide_context' or 'file_change'")
    ide: Optional[str] = Field(default="Antigravity", description="'Antigravity', 'Visual Studio Code', etc.")
    workspace: Optional[str] = Field(default=None, description="Workspace or project folder name")
    file: str = Field(..., description="Active relative or full file path, or file name")
    language: Optional[str] = Field(default=None, description="Programming language, e.g. Python, TypeScript")
    git_branch: Optional[str] = Field(default=None, description="Active Git branch")
    git_status: Optional[str] = Field(default=None, description="Git working tree status summary")
    lines_added: Optional[int] = Field(default=0, description="Lines added on file save")
    lines_removed: Optional[int] = Field(default=0, description="Lines removed on file save")
    timestamp: str = Field(default_factory=_current_utc_iso, description="ISO-8601 formatted timestamp")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary extra metadata")

    def to_activity_event(self) -> ActivityEvent:
        """Converts IDE context/change event into unified ActivityEvent for SQLite storage."""
        meta = dict(self.metadata)
        meta["file"] = self.file
        if self.workspace:
            meta["workspace"] = self.workspace
        if self.language:
            meta["language"] = self.language
        if self.git_branch:
            meta["git_branch"] = self.git_branch
        if self.git_status:
            meta["git_status"] = self.git_status
        if self.lines_added is not None and self.lines_added > 0:
            meta["lines_added"] = self.lines_added
        if self.lines_removed is not None and self.lines_removed > 0:
            meta["lines_removed"] = self.lines_removed
        if self.ide:
            meta["ide"] = self.ide

        app_name = self.ide or "Antigravity"
        clean_proc = "code.exe" if "code" in app_name.lower() else "antigravity.exe"

        if self.event_type == "file_change":
            diff_parts = []
            if self.lines_added:
                diff_parts.append(f"+{self.lines_added}")
            if self.lines_removed:
                diff_parts.append(f"-{self.lines_removed}")
            diff_str = f" ({', '.join(diff_parts)})" if diff_parts else ""
            title = f"Saved {self.file}{diff_str}"
        else:
            ws_prefix = f"[{self.workspace}] " if self.workspace else ""
            lang_suffix = f" ({self.language})" if self.language else ""
            title = f"{ws_prefix}{self.file}{lang_suffix}"

        return ActivityEvent(
            event_type=self.event_type or "ide_context",
            app_name=app_name,
            process_name=clean_proc,
            window_title=title,
            source="vscode_ext",
            timestamp=self.timestamp or _current_utc_iso(),
            metadata=meta,
            duration_seconds=0.0
        )


class TerminalEvent(BaseModel):
    """Event representing an executed or running shell command sent by PowerShell, CMD, or Git Bash integration."""
    id: Optional[str] = None
    event_type: str = Field(default="terminal_command", description="Type of event, e.g. 'terminal_command'")
    shell: Optional[str] = Field(default="Terminal", description="Shell type: 'PowerShell', 'CMD', 'Git Bash', 'bash', 'zsh', etc.")
    command: str = Field(..., description="Executed command line string")
    cwd: Optional[str] = Field(default=None, description="Working directory path where command was executed")
    status: Optional[str] = Field(default=None, description="Command status: 'running', 'completed', 'interrupted', 'failed'")
    exit_code: Optional[int] = Field(default=None, description="Process exit code (0 = success, non-zero = failure, 130 = Ctrl+C/SIGINT, None if running)")
    duration: Optional[float] = Field(default=0.0, description="Command execution duration in seconds")
    timestamp: str = Field(default_factory=_current_utc_iso, description="ISO-8601 formatted timestamp")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary extra metadata")

    def to_activity_event(self) -> ActivityEvent:
        """Converts terminal command event into unified ActivityEvent for SQLite storage."""
        meta = dict(self.metadata)
        meta["command"] = self.command
        if self.shell:
            meta["shell"] = self.shell
        if self.cwd:
            meta["cwd"] = self.cwd

        # Determine normalized status: running, interrupted, completed, failed
        st = (self.status or "").lower()
        if not st:
            if self.exit_code is None:
                st = "running"
            elif self.exit_code in (130, -1073741510, 3221225786):
                st = "interrupted"
            elif self.exit_code == 0:
                st = "completed"
            else:
                st = "failed"
        elif st in ("sigint", "cancelled", "canceled", "ctrl+c"):
            st = "interrupted"

        meta["status"] = st
        meta["running"] = (st == "running")
        meta["interrupted"] = (st == "interrupted")
        meta["exit_code"] = self.exit_code
        meta["success"] = (st == "completed" or (st != "running" and self.exit_code == 0))

        if self.duration is not None:
            meta["duration"] = float(self.duration)

        shell_name = self.shell or "Terminal"
        lower_shell = shell_name.lower()
        if "powershell" in lower_shell or "pwsh" in lower_shell:
            clean_proc = "powershell.exe"
        elif "cmd" in lower_shell:
            clean_proc = "cmd.exe"
        elif "bash" in lower_shell or "sh" in lower_shell or "zsh" in lower_shell:
            clean_proc = "bash.exe"
        else:
            clean_proc = "terminal.exe"

        if st == "running":
            status_tag = "running..."
        elif st == "interrupted":
            status_tag = "interrupted"
        elif self.exit_code == 0:
            status_tag = "✓"
        elif self.exit_code is not None:
            status_tag = f"✗({self.exit_code})"
        else:
            status_tag = "✓"

        cwd_tag = f" [{os.path.basename(self.cwd)}]" if self.cwd else ""
        window_title = f"{self.command} ({status_tag}){cwd_tag}"

        return ActivityEvent(
            id=self.id,
            event_type="terminal_command",
            app_name=shell_name,
            process_name=clean_proc,
            window_title=window_title,
            source="terminal",
            timestamp=self.timestamp or _current_utc_iso(),
            metadata=meta,
            duration_seconds=float(self.duration or 0.0)
        )


class BatchEventsRequest(BaseModel):
    """Batch payload sent by the native collector every 1-5 seconds."""
    activity_events: List[ActivityEvent] = Field(default_factory=list)
    clipboard_events: List[ClipboardEvent] = Field(default_factory=list)


class SensorConfig(BaseModel):
    """Configuration toggles for individual system sensors."""
    windows: bool = Field(True, description="Windows Apps & Foreground focus tracking (Rust/Tauri)")
    idle: bool = Field(True, description="User idle & active detection (Rust/Tauri)")
    clipboard: bool = Field(False, description="Clipboard change tracking (OFF by default for privacy)")
    browser: bool = Field(True, description="Browser tab & navigation tracking (Browser extension)")
    ide: bool = Field(True, description="IDE workspace, file, and git context (VS Code / Antigravity extension)")
    terminal: bool = Field(True, description="Terminal commands, exit codes, and running state (Shell integration)")


class PrivacyConfig(BaseModel):
    """Granular privacy and safety settings for Workstream."""
    track_clipboard_content: bool = Field(False, description="Track raw clipboard text content (OFF by default)")
    track_file_changes: bool = Field(True, description="Track file change save diffs in IDE")
    track_urls: bool = Field(True, description="Track specific web URLs in browser")
    exclude_apps: List[str] = Field(
        default_factory=lambda: [
            "1password",
            "bitwarden",
            "keepass",
            "lastpass",
            "enpass",
            "credential",
            "authenticator",
            "banking",
            "finance",
            "wallet",
            "secret",
        ],
        description="Always blocked sensitive applications and processes"
    )


class MemoryConfig(BaseModel):
    """Memory generation and persistence controls."""
    sessions: bool = Field(True, description="Session clustering and aggregation across sensors")
    semantic: bool = Field(True, description="Semantic work understanding and summaries")
    ltm: bool = Field(True, description="Long-term memory persistence (ChromaDB)")


class WorkstreamConfig(BaseModel):
    """Central configuration for Workstream and all activity sensors."""
    workstream: bool = Field(True, description="Master Workstream Memory toggle")
    sensors: SensorConfig = Field(default_factory=SensorConfig)
    privacy: PrivacyConfig = Field(default_factory=PrivacyConfig)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    retention_days: int = Field(60, description="Event retention period in days")
    is_paused: bool = Field(False, description="Temporary pause state")


class WorkstreamPolicy(BaseModel):
    """Privacy and retention configuration for the Workstream Engine (Backward Compatible)."""
    enabled: bool = True
    clipboard_enabled: bool = True
    exclude_apps: List[str] = Field(
        default_factory=lambda: [
            "1password",
            "bitwarden",
            "keepass",
            "lastpass",
            "enpass",
            "credential",
            "authenticator",
            "banking",
            "finance",
            "wallet",
            "secret",
        ]
    )
    max_clipboard_length: int = 10000
    retention_days: int = 60
    is_paused: bool = False
    sensors: SensorConfig = Field(default_factory=lambda: SensorConfig(clipboard=True))
    privacy: PrivacyConfig = Field(default_factory=lambda: PrivacyConfig(track_clipboard_content=True))
    memory: MemoryConfig = Field(default_factory=MemoryConfig)

    def to_config(self) -> WorkstreamConfig:
        return WorkstreamConfig(
            workstream=self.enabled,
            sensors=self.sensors,
            privacy=self.privacy,
            memory=self.memory,
            retention_days=self.retention_days,
            is_paused=self.is_paused,
        )

    @classmethod
    def from_config(cls, cfg: WorkstreamConfig) -> "WorkstreamPolicy":
        return cls(
            enabled=cfg.workstream,
            clipboard_enabled=cfg.sensors.clipboard,
            exclude_apps=cfg.privacy.exclude_apps,
            retention_days=cfg.retention_days,
            is_paused=cfg.is_paused,
            sensors=cfg.sensors,
            privacy=cfg.privacy,
            memory=cfg.memory,
        )


class SessionUnderstanding(BaseModel):
    """
    Phase 4: Deep Semantic Understanding of a developer work session.
    Extracts high-level task intent, goals, problems solved, technical stack, progress,
    and unresolved next steps from cross-sensor session signals.
    """
    task: str = Field(..., description="High-level description of what task was being performed, e.g. 'Debugging the Live Voice tool dispatcher'")
    goal: str = Field(..., description="Main objective of the session, e.g. 'Fix tool routing and interrupted command handling'")
    problem: Optional[str] = Field(None, description="Underlying problem, bug, or obstacle investigated or resolved")
    technologies: List[str] = Field(default_factory=list, description="Technologies, libraries, languages, and tools involved")
    status: str = Field("completed", description="'completed', 'in_progress', or 'interrupted'")
    progress: Optional[str] = Field(None, description="Key milestone or progress achieved during this session")
    decisions: List[str] = Field(default_factory=list, description="Key technical or design decisions made")
    unresolved_issues: List[str] = Field(default_factory=list, description="Pending errors, failed tests, interrupted commands, or next steps")
    confidence: float = Field(default=0.85, description="Confidence score 0.0-1.0")
    source: str = Field("heuristic", description="'llm' or 'heuristic'")
    created_at: Optional[str] = None


class WorkSession(BaseModel):
    """
    Semantic Work Session representing an aggregated period of meaningful work.
    Combines Windows focus, Browser URLs, IDE file changes/diffs, Clipboard copies, and Terminal commands.
    """
    id: Optional[int] = None
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()), description="Unique session UUID")
    title: str = Field(..., description="High-level title of the work session, e.g. 'Worked on Rie-AI Workstream integration'")
    summary: str = Field(..., description="Compact narrative summary of activities performed")
    project: Optional[str] = Field(default=None, description="Primary project or workspace name (e.g. 'Rie-AI')")
    start_time: str = Field(..., description="ISO-8601 UTC start timestamp of session")
    end_time: str = Field(..., description="ISO-8601 UTC end timestamp of session")
    duration_seconds: float = Field(default=0.0, description="Total active duration in seconds")
    event_count: int = Field(default=0, description="Total raw events aggregated into this session")
    files: List[str] = Field(default_factory=list, description="Key files inspected or modified")
    domains: List[str] = Field(default_factory=list, description="Key web domains or websites visited")
    commands: List[Union[str, Dict[str, Any]]] = Field(default_factory=list, description="Key terminal commands executed")
    topics: List[str] = Field(default_factory=list, description="Key topics, keywords, or features worked on")
    primary_apps: List[str] = Field(default_factory=list, description="Main applications used, e.g. Antigravity, PowerShell, Chrome")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary extra metadata, e.g. git branches, lines added/removed, clipboard count")
    is_finalized: bool = Field(default=True, description="Whether this session has closed/finalized (after inactivity gap or project shift)")
    understanding: Optional[SessionUnderstanding] = Field(default=None, description="Phase 4 deep semantic understanding: task, goal, problem, progress, next steps")
    created_at: Optional[str] = None


class AggregateSessionsRequest(BaseModel):
    """Payload to trigger semantic session aggregation over raw events."""
    timeframe: Optional[str] = Field(default="today", description="Timeframe keyword: 'today', 'yesterday', 'last_24_hours', 'last_7_days', 'all'")
    start_time: Optional[str] = Field(default=None, description="Optional ISO start timestamp")
    end_time: Optional[str] = Field(default=None, description="Optional ISO end timestamp")
    idle_threshold_minutes: int = Field(default=20, description="Inactivity gap in minutes that marks a session boundary (default: 20)")
    force: bool = Field(default=False, description="If True, re-aggregates sessions even if already aggregated")


class SessionFilterRequest(BaseModel):
    """Query filters for retrieving semantic work sessions."""
    timeframe: Optional[str] = Field(default="today", description="Timeframe keyword: 'today', 'yesterday', 'this_week', 'last_7_days', 'all'")
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    project: Optional[str] = Field(default=None, description="Filter by project or workspace name")
    file: Optional[str] = Field(default=None, description="Filter by file path or name keyword")
    domain: Optional[str] = Field(default=None, description="Filter by web domain")
    topic: Optional[str] = Field(default=None, description="Filter by topic keyword")
    query: Optional[str] = Field(default=None, description="Full-text search keyword across title, summary, files, etc.")
    finalized_only: Optional[bool] = Field(default=None, description="If True, returns only closed/finalized sessions")
    limit: int = Field(default=20, ge=1, le=100, description="Max sessions to return")


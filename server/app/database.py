
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
    
    defaults = [
        (
            "⚛️",
            "React & TS Guidelines",
            "React components and TypeScript style rules.",
            "Use functional components and React Hooks only.\nAlways use strict type definitions; avoid using `any` at all costs.\nPrefer Tailwind CSS classes for styling unless customized.\nKeep components clean, modular, and focused (usually under 200 lines).\nExport interfaces and types cleanly at the top of files."
        ),
        (
            "📝",
            "Python Style Guide",
            "Python coding conventions and guidelines.",
            "Always write type hints for all function arguments and return types.\nPrefer Python 3.10+ syntax (e.g. use `x | y` instead of `Union[x, y]`).\nWrite clean docstrings following Google Style style guide.\nUse pytest for tests and place them in `tests/` directory.\nPrefer pathlib over os.path for all filesystem operations."
        ),
        (
            "🚀",
            "No Code Placeholders",
            "Enforces complete, self-contained, working implementations.",
            "Never use placeholder comments like `// TODO`, `// implement later`, or `...`.\nAlways write the complete logic so the code can build and execute immediately.\nWhen modifying files, write the full modified segments cleanly, including necessary imports.\nDouble-check edge cases, error handling, and parameter validations before completing tasks."
        ),
        (
            "🎯",
            "Semantic Git Commits",
            "Enforces standard semantic commit message formats.",
            "Use the semantic commit message prefix format:\n- `feat:` for new features\n- `fix:` for bug fixes\n- `docs:` for documentation updates\n- `style:` for formatting/styling changes\n- `refactor:` for refactoring code structure\n- `test:` for adding or updating unit tests\nWrite commit messages in the imperative mood (e.g. \"add endpoint\" instead of \"added endpoint\").\nKeep commit messages concise (under 72 characters)."
        ),
        (
            "🛡️",
            "Security Hardening",
            "Strict rules for credentials and inputs.",
            "Never hardcode secrets, API keys, private keys, or passwords.\nAlways read credentials from environment variables or secure configuration stores.\nSanitize all user inputs before querying databases or running shell commands.\nUse parameterization/prepared statements for all SQL commands to prevent SQL injection.\nKeep package dependencies updated to avoid known security advisories."
        ),
        (
            "📄",
            "PDF Generation Expert",
            "Conventions for generating professional programmatical PDFs.",
            "When generating PDFs:\n- In Python, prefer `reportlab` (using PLATYPUS Flowables for page-layout management) or `fpdf2` for simpler reports.\n- Avoid hardcoded layout coordinates `(x, y)` where possible; use flowables, Paragraphs, and Spacers to handle page-breaks and margins dynamically.\n- Always wrap text inside Paragraph flowables to enable automatic word wrapping in tables.\n- Define styles and reuse them to maintain color scheme and font consistency.\n- Ensure all custom fonts are registered before drawing them.\n- When generating in Node.js, prefer `pdf-lib` or HTML-to-PDF converters like `puppeteer`/`playwright` for design-heavy layouts."
        ),
        (
            "💻",
            "Computer Use Guide",
            "Instructions for controlling and automating the Windows OS using mouse, keyboard, and terminal tools.",
            "Guidelines for using computer control tools (desktop state, click, type, scroll, drag, shortcuts, wait, scrape):\n1. **Always Check State First**: Before clicking, typing, or performing actions, call `get_desktop_state` to see the currently open applications, focused window, and interactive elements.\n2. **Visual Verification**: If you are unsure of an element's location, or a text description is insufficient, call `get_desktop_state` with `use_vision=True` to receive a visual screenshot.\n3. **Coordinate Accuracy**: The coordinates returned by `get_desktop_state` are in `[x, y]` format. Always click or type exactly on the identified interactive element's coordinates.\n4. **App Launch & Control**: Use `app_control` to launch or switch to windows. If an app is already running, switch to it instead of starting a new instance.\n5. **Typing Best Practices**: When using `keyboard_type`, click on the input field first. Use `clear=True` if you need to replace existing content, and `press_enter=True` to submit forms or search boxes.\n6. **Wait for UI Transitions**: UI updates are not instantaneous. After launching a program or clicking a button that changes the screen, use the `wait` tool (typically 1-3 seconds) to allow the interface to settle before querying the new state.\n7. **Verify Actions**: After executing clicks or keystrokes, call `get_desktop_state` again to verify that your action was successful and the UI changed as expected. Make sure to verify each step and do not proceed blindly.\n8. **Keyboard Shortcuts**: Use `press_keys` (shortcut tool) for common actions: 'ctrl+c' to copy, 'ctrl+v' to paste, 'alt+tab' to switch active windows, 'win' or 'win+s' to open search."
        )
    ]
    
    for icon, name, desc, content in defaults:
        cursor.execute("SELECT COUNT(*) FROM skills WHERE name = ?", (name,))
        if cursor.fetchone()[0] == 0:
            skill_id = str(uuid.uuid4())
            cursor.execute(
                """
                INSERT INTO skills (id, name, description, content, icon, tool_ids, enabled, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, '[]', 0, ?, ?)
                """,
                (skill_id, name, desc, content, icon, now, now)
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

def _skill_row_to_dict(row) -> Dict[str, Any]:
    """Convert a skills DB row to a plain dict with tool_ids as a list."""
    d = dict(row)
    try:
        d["tool_ids"] = json.loads(d.get("tool_ids") or "[]")
    except (json.JSONDecodeError, TypeError):
        d["tool_ids"] = []
    d["enabled"] = bool(d.get("enabled", 1))
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
    tool_ids_json = json.dumps(tool_ids or [])
    cursor.execute(
        """
        INSERT INTO skills (id, name, description, content, icon, tool_ids, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        """,
        (skill_id, name.strip(), description.strip(), content, icon, tool_ids_json, now, now),
    )
    conn.commit()
    cursor.execute("SELECT * FROM skills WHERE id = ?", (skill_id,))
    row = cursor.fetchone()
    conn.close()
    return _skill_row_to_dict(row) if row else {}


def update_skill(
    skill_id: str,
    name: Optional[str] = None,
    description: Optional[str] = None,
    content: Optional[str] = None,
    icon: Optional[str] = None,
    tool_ids: Optional[List[str]] = None,
    enabled: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    """Update a skill by ID. Only provided fields are changed."""
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
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM skills WHERE id = ?", (skill_id,))
    if not cursor.fetchone():
        conn.close()
        return False
    cursor.execute("DELETE FROM thread_skills WHERE skill_id = ?", (skill_id,))
    cursor.execute("DELETE FROM skills WHERE id = ?", (skill_id,))
    conn.commit()
    conn.close()
    return True




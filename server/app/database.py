
"""
Database module for managing application settings and chat history
"""
import sqlite3
import os
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

def save_message(thread_id: str, role: str, content: str, image_url: Optional[str] = None):
    """Save a message to a thread"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    now = datetime.utcnow().isoformat()
    
    # Ensure thread exists (create basic one if not found, though ideally should exist)
    cursor.execute("SELECT id FROM threads WHERE id = ?", (thread_id,))
    if not cursor.fetchone():
        create_thread("New Chat", thread_id)
        
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
    
    cursor.execute("SELECT * FROM threads ORDER BY updated_at DESC")
    rows = cursor.fetchall()
    
    threads = []
    for row in rows:
        threads.append({
            "id": row["id"],
            "title": row["title"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"]
        })
        
    conn.close()
    return threads

def get_thread_messages(thread_id: str) -> List[Dict[str, Any]]:
    """Get all messages for a specific thread"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC", (thread_id,))
    rows = cursor.fetchall()
    
    messages = []
    for row in rows:
        messages.append({
            "id": row["id"],
            "role": row["role"],
            "content": row["content"],
            "image_url": row["image_url"],
            "created_at": row["created_at"]
        })
        
    conn.close()
    return messages

def delete_thread(thread_id: str):
    """Delete a thread and its messages"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("DELETE FROM messages WHERE thread_id = ?", (thread_id,))
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

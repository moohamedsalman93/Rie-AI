
"""
Database module for managing application settings and chat history
"""
import sqlite3
import os
from pathlib import Path
import sys
import uuid
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

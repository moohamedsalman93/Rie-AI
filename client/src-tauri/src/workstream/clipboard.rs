//! Clipboard monitoring using Win32 AddClipboardFormatListener.
//! Safely reads Unicode text on WM_CLIPBOARDUPDATE and computes a SHA-256 hash.
//! PRIVACY GUARANTEE: Never logs or prints raw clipboard content.

use sha2::{Digest, Sha256};
use windows::Win32::Foundation::{HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

pub struct ClipboardItem {
    pub content: String,
    pub content_hash: String,
    pub content_type: String,
}

/// Reads the current Unicode text from clipboard if present.
/// Bounds read size to prevent memory bloat on massive copies.
pub fn read_clipboard_text(hwnd: HWND) -> Option<ClipboardItem> {
    unsafe {
        // OpenClipboard can fail if another app has it open; return None gracefully
        if OpenClipboard(Some(hwnd)).is_err() {
            return None;
        }

        // CF_UNICODETEXT = 13
        let handle_res = GetClipboardData(13);
        let item = if let Ok(handle) = handle_res {
            if !handle.is_invalid() {
                let ptr = GlobalLock(HGLOBAL(handle.0 as _));
                if !ptr.is_null() {
                    let u16_ptr = ptr as *const u16;
                    let mut len = 0;
                    // Cap at 30,000 characters for memory safety
                    while *u16_ptr.add(len) != 0 && len < 30_000 {
                        len += 1;
                    }

                    let slice = std::slice::from_raw_parts(u16_ptr, len);
                    let content = String::from_utf16_lossy(slice);

                    let _ = GlobalUnlock(HGLOBAL(handle.0 as _));

                    if !content.trim().is_empty() {
                        let content_type = detect_content_type(&content);
                        let mut hasher = Sha256::new();
                        hasher.update(content.as_bytes());
                        let content_hash = format!("{:x}", hasher.finalize());

                        Some(ClipboardItem {
                            content,
                            content_hash,
                            content_type,
                        })
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        let _ = CloseClipboard();
        item
    }
}

/// Simple heuristic to tag text as URL, code, or plain text.
fn detect_content_type(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return "url".to_string();
    }

    let code_indicators = [
        "fn ", "def ", "function ", "class ", "import ", "from ", "const ", "let ",
        "var ", "return ", "async ", "await ", "public ", "private ", "SELECT ", "INSERT ",
        "UPDATE ", "DELETE ", "FROM ", "WHERE ", "=>", "->", "{", "}", ";\n",
    ];

    let hits = code_indicators.iter().filter(|&&kw| text.contains(kw)).count();
    if hits >= 2 {
        "code".to_string()
    } else {
        "text".to_string()
    }
}

//! Windows foreground window and process inspector.
//! Uses native Win32 APIs without continuous polling.

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

#[derive(Debug, Clone)]
pub struct WindowFocusInfo {
    pub app_name: String,
    pub process_name: String,
    pub window_title: String,
}

/// Retrieves window title, process name, and friendly app name for a given HWND.
pub fn get_window_focus_info(hwnd: HWND) -> Option<WindowFocusInfo> {
    if hwnd.0.is_null() {
        return None;
    }

    // 1. Window title
    let mut title_buf = [0u16; 512];
    let len = unsafe { GetWindowTextW(hwnd, &mut title_buf) };
    let window_title = if len > 0 {
        String::from_utf16_lossy(&title_buf[..len as usize])
    } else {
        String::new()
    };

    // 2. Process ID
    let mut process_id = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
    if process_id == 0 {
        return None;
    }

    // 3. Process Name
    let process_name = get_process_name(process_id).unwrap_or_else(|| "Unknown".to_string());
    let app_name = friendly_app_name(&process_name);

    Some(WindowFocusInfo {
        app_name,
        process_name,
        window_title,
    })
}

/// Convenience helper to inspect the currently focused foreground window.
pub fn get_current_foreground_info() -> Option<WindowFocusInfo> {
    let hwnd = unsafe { GetForegroundWindow() };
    get_window_focus_info(hwnd)
}

fn get_process_name(process_id: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;
        let mut path_buf = [0u16; 1024];
        let mut size = path_buf.len() as u32;

        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(path_buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);

        if res.is_ok() && size > 0 {
            let full_path = String::from_utf16_lossy(&path_buf[..size as usize]);
            let file_name = std::path::Path::new(&full_path)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(&full_path);
            Some(file_name.to_string())
        } else {
            None
        }
    }
}

/// Maps common executable names to recognizable display names.
pub fn friendly_app_name(process_name: &str) -> String {
    let lower = process_name.to_lowercase();
    match lower.as_str() {
        "code.exe" => "Visual Studio Code".into(),
        "cursor.exe" => "Cursor".into(),
        "chrome.exe" => "Google Chrome".into(),
        "msedge.exe" => "Microsoft Edge".into(),
        "firefox.exe" => "Mozilla Firefox".into(),
        "brave.exe" => "Brave Browser".into(),
        "windowsterminal.exe" => "Windows Terminal".into(),
        "powershell.exe" | "pwsh.exe" => "PowerShell".into(),
        "cmd.exe" => "Command Prompt".into(),
        "slack.exe" => "Slack".into(),
        "discord.exe" => "Discord".into(),
        "spotify.exe" => "Spotify".into(),
        "notion.exe" => "Notion".into(),
        "devenv.exe" => "Visual Studio".into(),
        "idea64.exe" => "IntelliJ IDEA".into(),
        "pycharm64.exe" => "PyCharm".into(),
        "sublime_text.exe" => "Sublime Text".into(),
        "notepad.exe" => "Notepad".into(),
        _ => {
            if lower.ends_with(".exe") {
                process_name[..process_name.len() - 4].to_string()
            } else {
                process_name.to_string()
            }
        }
    }
}

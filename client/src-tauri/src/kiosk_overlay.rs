use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

/// Shared flag: when true, the overlay mode is active
pub static KIOSK_OVERLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Flag: when true, we actively capture/consume keys because the mouse is inside Rie-AI
static CAPTURE_KEYS: AtomicBool = AtomicBool::new(false);

/// Stored HWND value so the background thread can access it
static OVERLAY_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Global Tauri AppHandle to emit events to the frontend
pub static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Stored keyboard hook handle (HHOOK) and the thread handle
static HOOK_HANDLE: Mutex<Option<(std::thread::JoinHandle<()>, isize)>> = Mutex::new(None);

#[derive(serde::Serialize, Clone)]
struct KeypressPayload {
    #[serde(rename = "type")]
    event_type: String, // "char", "special", "shortcut"
    key: String,
}

// ── Windows Imports ──────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, POINT, RECT, LPARAM, LRESULT, WPARAM};

#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE,
    GetWindowLongW, SetWindowLongW, GWL_EXSTYLE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_NOACTIVATE,
    GetCursorPos, GetWindowRect, IsIconic, IsWindowVisible,
    SetWindowsHookExW, CallNextHookEx, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, KBDLLHOOKSTRUCT, HC_ACTION, MSG, GetMessageW,
    TranslateMessage, DispatchMessageW,
};

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ToUnicode, VK_SHIFT, VK_CAPITAL, VK_CONTROL, VK_MENU,
};

// ── Windows-only implementation ──────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub mod win {
    use super::*;

    /// Translate virtual key and scan code into Unicode string based on layout/states
    pub unsafe fn vk_to_unicode(vk_code: u32, scan_code: u32) -> Option<String> {
        let mut keyboard_state = [0u8; 256];
        
        // Grab current Shift, Caps Lock, Ctrl, Alt states
        if GetKeyState(VK_SHIFT.0 as i32) < 0 {
            keyboard_state[VK_SHIFT.0 as usize] = 0x80;
        }
        if GetKeyState(VK_CAPITAL.0 as i32) & 1 != 0 {
            keyboard_state[VK_CAPITAL.0 as usize] = 0x01;
        }
        if GetKeyState(VK_CONTROL.0 as i32) < 0 {
            keyboard_state[VK_CONTROL.0 as usize] = 0x80;
        }
        if GetKeyState(VK_MENU.0 as i32) < 0 {
            keyboard_state[VK_MENU.0 as usize] = 0x80;
        }

        let mut buff = [0u16; 8];
        let len = ToUnicode(
            vk_code,
            scan_code,
            Some(&keyboard_state),
            &mut buff,
            0,
        );

        if len > 0 {
            let text = String::from_utf16_lossy(&buff[..len as usize]);
            // Exclude control chars (like backspace, tab, enter which are handled separately)
            if text.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
                None
            } else {
                Some(text)
            }
        } else {
            None
        }
    }

    /// Check if the window is minimized or not visible.
    pub fn is_window_minimized_or_hidden(hwnd: isize) -> bool {
        unsafe {
            let win_hwnd = HWND(hwnd as *mut _);
            IsIconic(win_hwnd).as_bool() || !IsWindowVisible(win_hwnd).as_bool()
        }
    }

    /// Check if the cursor is currently inside the window bounds.
    pub fn is_mouse_inside_window(hwnd: isize) -> bool {
        unsafe {
            let win_hwnd = HWND(hwnd as *mut _);
            let mut point = POINT { x: 0, y: 0 };
            let mut rect = RECT::default();
            
            if GetCursorPos(&mut point).is_ok() && GetWindowRect(win_hwnd, &mut rect).is_ok() {
                point.x >= rect.left && point.x <= rect.right &&
                point.y >= rect.top && point.y <= rect.bottom
            } else {
                false
            }
        }
    }

    /// Set topmost Z-order visually using SWP_NOACTIVATE to prevent stealing focus.
    pub fn force_topmost_once(hwnd: isize) {
        unsafe {
            let _ = SetWindowPos(
                HWND(hwnd as *mut _),
                Some(HWND_TOPMOST),
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }

    /// Apply WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW + WS_EX_TOPMOST.
    /// This prevents clicks on Rie-AI from blurring the kiosk window.
    pub fn apply_overlay_styles(hwnd: isize) {
        unsafe {
            let ex_style = GetWindowLongW(HWND(hwnd as *mut _), GWL_EXSTYLE);
            let new_style = ex_style
                | WS_EX_TOOLWINDOW.0 as i32
                | WS_EX_TOPMOST.0 as i32
                | WS_EX_NOACTIVATE.0 as i32;
            SetWindowLongW(HWND(hwnd as *mut _), GWL_EXSTYLE, new_style);
        }
    }

    /// Remove the extra styles when kiosk overlay mode is disabled.
    pub fn remove_overlay_styles(hwnd: isize) {
        unsafe {
            let ex_style = GetWindowLongW(HWND(hwnd as *mut _), GWL_EXSTYLE);
            let new_style = ex_style
                & !(WS_EX_TOOLWINDOW.0 as i32 | WS_EX_NOACTIVATE.0 as i32);
            SetWindowLongW(HWND(hwnd as *mut _), GWL_EXSTYLE, new_style);
        }
    }

    /// Background enforcer: keeps window on top visually, and updates key capture state
    /// based on whether the mouse is inside the window rect.
    pub fn enforcer_loop(running: Arc<AtomicBool>) {
        while running.load(Ordering::Relaxed) {
            let hwnd = OVERLAY_HWND.load(Ordering::Relaxed);
            if hwnd != 0 {
                if is_window_minimized_or_hidden(hwnd) {
                    CAPTURE_KEYS.store(false, Ordering::Relaxed);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
                
                // If mouse is inside Rie-AI, enable key hook capture.
                let inside = is_mouse_inside_window(hwnd);
                CAPTURE_KEYS.store(inside, Ordering::Relaxed);
                
                // Keep the window topmost visually.
                force_topmost_once(hwnd);
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }
}

// ── Global Keyboard Hook — Low Level (WH_KEYBOARD_LL) ─────────────────────────

#[cfg(target_os = "windows")]
fn emit_keypress(event_type: &str, key: &str) {
    use tauri::Emitter;
    if let Some(app) = APP_HANDLE.get() {
        let payload = KeypressPayload {
            event_type: event_type.to_string(),
            key: key.to_string(),
        };
        let _ = app.emit("rie-keypress", payload);
    }
}

#[cfg(target_os = "windows")]
fn process_key_event(vk_code: u32, scan_code: u32) -> bool {
    let ctrl_pressed = unsafe { GetKeyState(VK_CONTROL.0 as i32) < 0 };
    
    // 1. Check for standard shortcuts if Ctrl is pressed
    if ctrl_pressed {
        let key_char = match vk_code {
            65 | 97 => Some("a"), // A/a
            67 | 99 => Some("c"), // C/c
            86 | 118 => Some("v"), // V/v
            88 | 120 => Some("x"), // X/x
            90 | 122 => Some("z"), // Z/z
            _ => None,
        };
        if let Some(k) = key_char {
            emit_keypress("shortcut", k);
            return true;
        }
    }

    // 2. Check for special keys
    let special_key = match vk_code {
        8 => Some("Backspace"),
        9 => Some("Tab"),
        13 => Some("Enter"),
        27 => Some("Escape"),
        37 => Some("ArrowLeft"),
        38 => Some("ArrowUp"),
        39 => Some("ArrowRight"),
        40 => Some("ArrowDown"),
        46 => Some("Delete"),
        _ => None,
    };

    if let Some(k) = special_key {
        emit_keypress("special", k);
        return true;
    }

    // 3. Translate general characters (letters, numbers, symbols)
    if let Some(ch) = unsafe { win::vk_to_unicode(vk_code, scan_code) } {
        emit_keypress("char", &ch);
        return true;
    }

    false
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn keyboard_hook(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code == HC_ACTION as i32 && KIOSK_OVERLAY_ACTIVE.load(Ordering::Relaxed) {
        if CAPTURE_KEYS.load(Ordering::Relaxed) {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let msg_type = wparam.0 as u32;
            
            use windows::Win32::UI::WindowsAndMessaging::{WM_KEYDOWN, WM_SYSKEYDOWN};
            if msg_type == WM_KEYDOWN || msg_type == WM_SYSKEYDOWN {
                let vk_code = kb.vkCode;
                let scan_code = kb.scanCode;
                
                if process_key_event(vk_code, scan_code) {
                    return LRESULT(1); // Consume the key, preventing it from reaching the kiosk!
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

pub fn install_keyboard_hook() {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::Foundation::HINSTANCE;

        let mut hook_guard = HOOK_HANDLE.lock().unwrap();
        if hook_guard.is_none() {
            let (tx, rx) = std::sync::mpsc::channel();
            
            let handle = std::thread::spawn(move || {
                unsafe {
                    let hmod = GetModuleHandleW(None).unwrap_or_default();
                    let hinstance = HINSTANCE(hmod.0);

                    let hook = SetWindowsHookExW(
                        WH_KEYBOARD_LL,
                        Some(keyboard_hook),
                        Some(hinstance),
                        0,
                    );
                    
                    match hook {
                        Ok(h) => {
                            let _ = tx.send(Ok(h.0 as isize));
                            
                            let mut msg = MSG::default();
                            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                                let _ = TranslateMessage(&msg);
                                let _ = DispatchMessageW(&msg);
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e.to_string()));
                        }
                    }
                }
            });
            
            match rx.recv() {
                Ok(Ok(hwnd_raw)) => {
                    *hook_guard = Some((handle, hwnd_raw));
                    println!("[kiosk-overlay] Global keyboard hook installed successfully");
                }
                Ok(Err(e)) => {
                    println!("[kiosk-overlay] Failed to install keyboard hook: {}", e);
                }
                Err(_) => {
                    println!("[kiosk-overlay] Hook thread crashed during installation");
                }
            }
        }
    }
}

pub fn uninstall_keyboard_hook() {
    #[cfg(target_os = "windows")]
    {
        let mut hook_guard = HOOK_HANDLE.lock().unwrap();
        if let Some((_handle, raw_hook)) = hook_guard.take() {
            unsafe {
                let _ = UnhookWindowsHookEx(windows::Win32::UI::WindowsAndMessaging::HHOOK(raw_hook as *mut _));
                println!("[kiosk-overlay] Global keyboard hook uninstalled successfully");
            }
        }
    }
}

// ── Enforcer thread handle ──────────────────────────────────────────────────

/// Holds the enforcer thread join handle and its stop flag.
pub struct KioskOverlayState {
    thread: Mutex<Option<(std::thread::JoinHandle<()>, Arc<AtomicBool>)>>,
}

impl Default for KioskOverlayState {
    fn default() -> Self {
        Self {
            thread: Mutex::new(None),
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Toggle kiosk overlay mode on/off.
#[tauri::command]
pub fn set_kiosk_overlay_mode(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;

        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;

        // Store HWND for the background thread
        OVERLAY_HWND.store(hwnd, Ordering::Relaxed);
        KIOSK_OVERLAY_ACTIVE.store(enabled, Ordering::Relaxed);

        let state = app.state::<KioskOverlayState>();
        let mut guard = state.thread.lock().map_err(|e| e.to_string())?;

        if enabled {
            // Apply overlay styles (adds WS_EX_NOACTIVATE)
            win::apply_overlay_styles(hwnd);

            // Install the keyboard hook to intercept keystrokes
            install_keyboard_hook();

            // Force topmost immediately
            win::force_topmost_once(hwnd);

            // Start enforcer thread if not already running
            if guard.is_none() {
                let running = Arc::new(AtomicBool::new(true));
                let running_clone = running.clone();
                let handle = std::thread::Builder::new()
                    .name("kiosk-overlay-enforcer".into())
                    .spawn(move || {
                        win::enforcer_loop(running_clone);
                    })
                    .map_err(|e| e.to_string())?;
                *guard = Some((handle, running));
            }

            println!("[kiosk-overlay] Enabled – enforcer thread & keyboard hook started");
        } else {
            // Stop enforcer thread
            if let Some((handle, running)) = guard.take() {
                running.store(false, Ordering::Relaxed);
                let _ = handle.join();
            }

            // Uninstall the keyboard hook
            uninstall_keyboard_hook();
            CAPTURE_KEYS.store(false, Ordering::Relaxed);

            // Remove overlay styles (removes WS_EX_NOACTIVATE)
            win::remove_overlay_styles(hwnd);

            // Re-assert normal always-on-top (Tauri's standard)
            win::force_topmost_once(hwnd);

            println!("[kiosk-overlay] Disabled – enforcer thread & keyboard hook stopped");
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        let _ = enabled;
        println!("[kiosk-overlay] Not supported on this platform");
    }

    Ok(())
}

/// One-shot: force the window to topmost right now.
#[tauri::command]
pub fn force_topmost(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;

        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;

        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        win::force_topmost_once(hwnd);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }

    Ok(())
}

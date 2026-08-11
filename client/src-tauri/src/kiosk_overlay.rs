use std::collections::HashSet;
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

/// Stored original window procedure pointer
static ORIGINAL_WNDPROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Track modifier states globally for hotkey detection
static SHIFT_DOWN: AtomicBool = AtomicBool::new(false);
static ALT_DOWN: AtomicBool = AtomicBool::new(false);
static CTRL_DOWN: AtomicBool = AtomicBool::new(false);

/// Track last emit time per VK code to rate-limit and prevent duplicate/repeat events
static LAST_KEY_TIME: std::sync::LazyLock<Mutex<std::collections::HashMap<u32, std::time::Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

/// Track currently held-down keys to filter out hardware auto-repeat
static PRESSED_KEYS: std::sync::LazyLock<Mutex<HashSet<u32>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashSet::new()));

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
    SetWindowLongPtrW, GWLP_WNDPROC, CallWindowProcW, DefWindowProcW, WM_INPUT,
};

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, ToUnicode, VK_SHIFT, VK_CAPITAL, VK_CONTROL, VK_MENU,
};

#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::{
    RegisterRawInputDevices, GetRawInputData, RAWINPUTDEVICE, RAWINPUT, HRAWINPUT, RID_INPUT,
    RIDEV_INPUTSINK,
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

    /// Background selection monitor: queries the focused control for text selection
    /// and emits it to the frontend via the Tauri AppHandle.
    pub fn selection_monitor_loop(app: tauri::AppHandle, running: Arc<AtomicBool>) {
        use tauri::Emitter;
        
        println!("[selection-monitor] Thread started");
        
        // Initialize COM library for this thread
        let com_init = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        println!("[selection-monitor] COM init result: {:?}", com_init);
 
        let mut last_selection = String::new();

        while running.load(Ordering::Relaxed) {
            if let Some(selection) = get_current_selection() {
                let selection_trimmed = selection.trim().to_string();
                if !selection_trimmed.is_empty() && selection_trimmed != last_selection {
                    println!("[selection-monitor] New selection detected: {:?}", selection_trimmed);
                    last_selection = selection_trimmed.clone();
                    // Emit to frontend
                    let _ = app.emit("kiosk-selection-detected", selection_trimmed);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }

        println!("[selection-monitor] Thread stopping");

        unsafe {
            windows::Win32::System::Com::CoUninitialize();
        }
    }

    fn get_current_selection() -> Option<String> {
        use uiautomation::UIAutomation;
        use uiautomation::patterns::UITextPattern;

        let automation = match UIAutomation::new() {
            Ok(auto) => auto,
            Err(e) => {
                println!("[selection-monitor] Failed to create UIAutomation instance: {:?}", e);
                return None;
            }
        };

        let focused = match automation.get_focused_element() {
            Ok(el) => el,
            Err(_) => return None,
        };

        let name = focused.get_name().unwrap_or_default();
        let class = focused.get_classname().unwrap_or_default();
        // Avoid spamming logs for Desktop/Pane or Rie-AI itself
        if class != "#32769" && !class.contains("Tauri") && !name.contains("Rie-AI") {
            // Uncomment the line below if you want to trace focus transitions
            // println!("[selection-monitor] Focused control: {} (Class: {})", name, class);
        }

        let walker = match automation.get_control_view_walker() {
            Ok(w) => w,
            Err(e) => {
                println!("[selection-monitor] Failed to get tree walker: {:?}", e);
                return None;
            }
        };

        // Attempt UITextPattern directly on the focused control
        if let Ok(text_pattern) = focused.get_pattern::<UITextPattern>() {
            if let Ok(selections) = text_pattern.get_selection() {
                if let Some(range) = selections.first() {
                    if let Ok(text) = range.get_text(-1) {
                        let text_val = text.trim().to_string();
                        if !text_val.is_empty() {
                            return Some(text_val);
                        }
                    }
                }
            }
        }

        // Try checking parents in case the focus is inside a sub-pane
        let mut parent = walker.get_parent(&focused).ok();
        while let Some(current_parent) = parent {
            if let Ok(text_pattern) = current_parent.get_pattern::<UITextPattern>() {
                if let Ok(selections) = text_pattern.get_selection() {
                    if let Some(range) = selections.first() {
                        if let Ok(text) = range.get_text(-1) {
                            let text_val = text.trim().to_string();
                            if !text_val.is_empty() {
                                return Some(text_val);
                            }
                        }
                    }
                }
            }
            parent = walker.get_parent(&current_parent).ok();
        }

        None
    }
}
         // ── Windows Raw Input and Subclassing ────────────────────────────────────────

#[cfg(target_os = "windows")]
pub fn register_raw_input(hwnd: isize) -> Result<(), String> {
    unsafe {
        let device = RAWINPUTDEVICE {
            usUsagePage: 0x01,        // HID_USAGE_PAGE_GENERIC
            usUsage: 0x06,            // HID_USAGE_GENERIC_KEYBOARD
            dwFlags: RIDEV_INPUTSINK, // Receive input even without focus
            hwndTarget: HWND(hwnd as *mut _),
        };

        RegisterRawInputDevices(
            &[device],
            std::mem::size_of::<RAWINPUTDEVICE>() as u32,
        ).map_err(|e| e.to_string())?;
    }
    println!("[input-system] Raw input devices registered successfully");
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn subclass_window(hwnd: isize) {
    unsafe {
        let original = SetWindowLongPtrW(
            HWND(hwnd as *mut _),
            GWLP_WNDPROC,
            rie_wndproc as *const () as isize,
        );
        ORIGINAL_WNDPROC.store(original, Ordering::Relaxed);
    }
    println!("[input-system] Window subclassed successfully");
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn rie_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let original = ORIGINAL_WNDPROC.load(Ordering::Relaxed);

    if msg == WM_INPUT {
        let mut size: u32 = 0;
        let cb_size_header = std::mem::size_of::<windows::Win32::UI::Input::RAWINPUTHEADER>() as u32;
        let res_size = GetRawInputData(
            HRAWINPUT(lparam.0 as *mut _),
            RID_INPUT,
            None,
            &mut size,
            cb_size_header,
        );

        if res_size != u32::MAX && size > 0 {
            let mut buf = vec![0u8; size as usize];
            let res_data = GetRawInputData(
                HRAWINPUT(lparam.0 as *mut _),
                RID_INPUT,
                Some(buf.as_mut_ptr() as *mut _),
                &mut size,
                cb_size_header,
            );

            if res_data != u32::MAX {
                let raw = &*(buf.as_ptr() as *const RAWINPUT);
                if raw.header.dwType == windows::Win32::UI::Input::RIM_TYPEKEYBOARD.0 {
                    let kb = &raw.data.keyboard;
                    let vk = kb.VKey as u32;
                    let flags = kb.Flags as u32;
                    let key_down = (flags & 1) == 0;
                    let scan_code = kb.MakeCode as u32;
                    handle_raw_key(vk, key_down, scan_code);
                }
            }
        }
        
        // Return DefWindowProcW directly to ensure the raw input block is cleaned up by the OS
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    if original != 0 {
        CallWindowProcW(
            Some(std::mem::transmute(original)),
            hwnd,
            msg,
            wparam,
            lparam
        )
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(target_os = "windows")]
fn handle_raw_key(vk: u32, key_down: bool, scan_code: u32) {
    use tauri::Emitter;

    // 1. Track modifier states
    match vk as u16 {
        0x10 | 0xA0 | 0xA1 => { // VK_SHIFT, VK_LSHIFT, VK_RSHIFT
            SHIFT_DOWN.store(key_down, Ordering::Relaxed);
            update_pressed_set(vk, key_down);
            return;
        }
        0x12 | 0xA4 | 0xA5 => { // VK_MENU, VK_LMENU, VK_RMENU
            ALT_DOWN.store(key_down, Ordering::Relaxed);
            update_pressed_set(vk, key_down);
            if KIOSK_OVERLAY_ACTIVE.load(Ordering::Relaxed) && CAPTURE_KEYS.load(Ordering::Relaxed) {
                return; // consume Alt entirely when RIE chat is open
            }
            return;
        }
        0x11 | 0xA2 | 0xA3 => { // VK_CONTROL, VK_LCONTROL, VK_RCONTROL
            CTRL_DOWN.store(key_down, Ordering::Relaxed);
            update_pressed_set(vk, key_down);
            return;
        }
        _ => {}
    }

    // 2. Filter out hardware auto-repeat AND enforce minimum interval between events.
    if key_down {
        let mut pressed = PRESSED_KEYS.lock().unwrap();
        if !pressed.insert(vk) {
            // Key was already in the set → this is an auto-repeat, ignore it
            return;
        }
        // Also enforce a minimum 50ms cooldown per VK to catch any edge cases
        let now = std::time::Instant::now();
        if let Ok(mut times) = LAST_KEY_TIME.lock() {
            if let Some(last) = times.get(&vk) {
                if now.duration_since(*last).as_millis() < 50 {
                    return;
                }
            }
            times.insert(vk, now);
        }
    } else {
        // Key up → remove from pressed set
        update_pressed_set(vk, false);
        // Handle key-up for PTT (0x53) and Privacy (0x51 - 'Q')
        if vk == 0x53 || vk == 0x51 {
            use tauri::Emitter;
            if let Some(app) = APP_HANDLE.get() {
                let event_name = if vk == 0x53 { "rie-shortcut-ptt" } else { "rie-shortcut-privacy" };
                let _ = app.emit(event_name, "Released");
            }
        }
        return; // Nothing else to do on key-up for non-modifier keys
    }

    // Detect hotkeys (Shift+Alt+A, Shift+Alt+S, Shift+Alt+C, Shift+Alt+Q)
    let alt = ALT_DOWN.load(Ordering::Relaxed);
    let shift = SHIFT_DOWN.load(Ordering::Relaxed);

    if alt && shift {
        if vk == 0x41 { // 'A' - Toggle Bubble/Chat
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-toggle", ());
            }
            return;
        }
        if vk == 0x53 { // 'S' - Push To Talk
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-ptt", "Pressed");
            }
            return;
        }
        if vk == 0x43 { // 'C' - Cancel
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-cancel", ());
            }
            return;
        }
        if vk == 0x51 { // 'Q' - Screen Privacy Toggle (Press to enable, hold to disable)
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-privacy", "Pressed");
            }
            return;
        }
        if vk == 0x4E { // 'N' - New Chat
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-new-chat", ());
            }
            return;
        }
        if vk == 0x56 { // 'V' - Capture Screen
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-capture-screen", ());
            }
            return;
        }
        if vk == 0x4D { // 'M' - Toggle Mic / Mute
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-toggle-mute", ());
            }
            return;
        }
        if vk == 0x4B { // 'K' - Toggle Kiosk Mode
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-toggle-kiosk", ());
            }
            return;
        }
        if vk == 0x46 { // 'F' - Focus Chat Input
            if let Some(app) = APP_HANDLE.get() {
                let _ = app.emit("rie-shortcut-focus-input", ());
            }
            return;
        }
    }

    // Only process other keys on key down, and only when overlay is active and hovered (CAPTURE_KEYS is true)
    if KIOSK_OVERLAY_ACTIVE.load(Ordering::Relaxed) && CAPTURE_KEYS.load(Ordering::Relaxed) {
        process_key_event(vk, scan_code);
    }
}

/// Helper: insert or remove a VK from the pressed-keys set.
#[cfg(target_os = "windows")]
fn update_pressed_set(vk: u32, down: bool) {
    if let Ok(mut pressed) = PRESSED_KEYS.lock() {
        if down {
            pressed.insert(vk);
        } else {
            pressed.remove(&vk);
        }
    }
}

// ── Global Keyboard Hook — Low Level (WH_KEYBOARD_LL) [LEGACY] ─────────────────

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

// ── Enforcer and Selection Monitor thread handle ───────────────────────────

/// Holds the active threads join handles and their stop flag.
pub struct KioskOverlayState {
    thread: Mutex<Option<(Vec<std::thread::JoinHandle<()>>, Arc<AtomicBool>)>>,
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
    use tauri::Emitter;
    let _ = app.emit("kiosk-overlay-toggled", enabled);

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

            // Force topmost immediately
            win::force_topmost_once(hwnd);

            // Start background threads if not already running
            if guard.is_none() {
                let running = Arc::new(AtomicBool::new(true));
                let running_clone1 = running.clone();
                let running_clone2 = running.clone();
                
                let enforcer_handle = std::thread::Builder::new()
                    .name("kiosk-overlay-enforcer".into())
                    .spawn(move || {
                        win::enforcer_loop(running_clone1);
                    })
                    .map_err(|e| e.to_string())?;

                let app_clone = app.clone();
                let selection_handle = std::thread::Builder::new()
                    .name("kiosk-overlay-selection-monitor".into())
                    .spawn(move || {
                        win::selection_monitor_loop(app_clone, running_clone2);
                    })
                    .map_err(|e| e.to_string())?;

                *guard = Some((vec![enforcer_handle, selection_handle], running));
            }

            println!("[kiosk-overlay] Enabled – background threads started");
        } else {
            // Stop background threads
            if let Some((handles, running)) = guard.take() {
                running.store(false, Ordering::Relaxed);
                for handle in handles {
                    let _ = handle.join();
                }
            }

            CAPTURE_KEYS.store(false, Ordering::Relaxed);

            // Remove overlay styles (removes WS_EX_NOACTIVATE)
            win::remove_overlay_styles(hwnd);

            // Re-assert normal always-on-top (Tauri's standard)
            win::force_topmost_once(hwnd);

            println!("[kiosk-overlay] Disabled – background threads stopped");
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

/// Query if kiosk overlay mode is currently active.
#[tauri::command]
pub fn get_kiosk_overlay_mode() -> bool {
    KIOSK_OVERLAY_ACTIVE.load(Ordering::Relaxed)
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

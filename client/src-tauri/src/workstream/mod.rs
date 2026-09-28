//! Native Win32 Workstream Collector for Rie-AI.
//! Runs a single Win32 message loop on a dedicated thread servicing:
//! 1. Foreground window changes (SetWinEventHook: EVENT_SYSTEM_FOREGROUND)
//! 2. Clipboard changes (AddClipboardFormatListener on hidden HWND)
//! 3. Periodic idle checks (GetLastInputInfo on WM_TIMER)
//!
//! Events are placed in a memory-bounded VecDeque queue and batched to Python via HTTP.

pub mod clipboard;
pub mod collector;
pub mod idle;
pub mod window_focus;

use std::sync::Mutex;
use std::time::Instant;

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{AddClipboardFormatListener, RemoveClipboardFormatListener};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
const WINEVENT_OUTOFCONTEXT: u32 = 0;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, KillTimer, PostQuitMessage,
    RegisterClassW, SetTimer, TranslateMessage,
    EVENT_SYSTEM_FOREGROUND, HWND_MESSAGE, MSG, WNDCLASSW,
    WM_CLIPBOARDUPDATE, WM_DESTROY, WM_TIMER,
};

use self::collector::{ActivityEvent, ClipboardEvent, WorkstreamCollector};
use self::idle::{IdleStateChange, IdleTracker};
use self::window_focus::WindowFocusInfo;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SensorConfig {
    #[serde(default = "default_true")]
    pub windows: bool,
    #[serde(default = "default_true")]
    pub idle: bool,
    #[serde(default)]
    pub clipboard: bool,
    #[serde(default = "default_true")]
    pub browser: bool,
    #[serde(default = "default_true")]
    pub ide: bool,
    #[serde(default = "default_true")]
    pub terminal: bool,
}

impl Default for SensorConfig {
    fn default() -> Self {
        Self {
            windows: true,
            idle: true,
            clipboard: false,
            browser: true,
            ide: true,
            terminal: true,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkstreamConfig {
    #[serde(default = "default_true")]
    pub workstream: bool,
    #[serde(default)]
    pub sensors: SensorConfig,
}

impl Default for WorkstreamConfig {
    fn default() -> Self {
        Self {
            workstream: true,
            sensors: SensorConfig::default(),
        }
    }
}

struct SensorState {
    collector: WorkstreamCollector,
    idle_tracker: IdleTracker,
    last_window_info: Option<WindowFocusInfo>,
    last_window_timestamp: Instant,
    config: WorkstreamConfig,
    last_config_sync: Instant,
}

static SENSOR_STATE: Mutex<Option<SensorState>> = Mutex::new(None);

/// Updates the sensor configuration in memory from Tauri or sync.
pub fn update_sensor_config(new_config: WorkstreamConfig) {
    if let Ok(mut lock) = SENSOR_STATE.lock() {
        if let Some(ref mut state) = *lock {
            println!(
                "[Workstream] Updated sensor config: workstream={}, windows={}, idle={}, clipboard={}",
                new_config.workstream,
                new_config.sensors.windows,
                new_config.sensors.idle,
                new_config.sensors.clipboard
            );
            state.config = new_config;
            state.last_config_sync = Instant::now();
        }
    }
}

/// Starts the native Win32 workstream collector on a background thread.
pub fn start_collector() {
    std::thread::Builder::new()
        .name("rie-workstream".into())
        .spawn(|| {
            unsafe {
                println!("[Workstream] Starting native Win32 workstream collector...");
                let collector = WorkstreamCollector::new();
                let idle_tracker = IdleTracker::new(120); // 2 minute threshold

                {
                    let mut lock = SENSOR_STATE.lock().unwrap();
                    *lock = Some(SensorState {
                        collector,
                        idle_tracker,
                        last_window_info: window_focus::get_current_foreground_info(),
                        last_window_timestamp: Instant::now(),
                        config: WorkstreamConfig::default(),
                        last_config_sync: Instant::now(),
                    });
                }

                let class_name = windows::core::w!("RieWorkstreamMessageWindowClass");
                let wnd_class = WNDCLASSW {
                    lpfnWndProc: Some(wnd_proc),
                    hInstance: HINSTANCE::default(),
                    lpszClassName: class_name,
                    ..Default::default()
                };

                let _ = RegisterClassW(&wnd_class);

                let hwnd = CreateWindowExW(
                    Default::default(),
                    class_name,
                    windows::core::w!("RieWorkstreamMessageWindow"),
                    Default::default(),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    None,
                    None,
                );

                if let Ok(hwnd) = hwnd {
                    if !hwnd.is_invalid() {
                        let _ = AddClipboardFormatListener(hwnd);
                        // 2 second timer for idle check & background maintenance
                        let _ = SetTimer(Some(hwnd), 1, 2000, None);

                        // Hook EVENT_SYSTEM_FOREGROUND for window focus changes
                        let hook = SetWinEventHook(
                            EVENT_SYSTEM_FOREGROUND,
                            EVENT_SYSTEM_FOREGROUND,
                            None,
                            Some(win_event_proc),
                            0,
                            0,
                            WINEVENT_OUTOFCONTEXT,
                        );

                        let mut msg = MSG::default();
                        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }

                        if !hook.is_invalid() {
                            let _ = UnhookWinEvent(hook);
                        }
                    }
                }
            }
        })
        .expect("Failed to spawn workstream collector thread");
}

unsafe extern "system" fn win_event_proc(
    _h_win_event_hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    if event == EVENT_SYSTEM_FOREGROUND {
        handle_foreground_change(hwnd);
    }
}

fn handle_foreground_change(hwnd: HWND) {
    let mut lock = match SENSOR_STATE.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(ref mut state) = *lock {
        // Stop collection if master toggle or windows sensor is OFF
        if !state.config.workstream || !state.config.sensors.windows {
            return;
        }

        if let Some(info) = window_focus::get_window_focus_info(hwnd) {
            let now = Instant::now();
            let duration = now.duration_since(state.last_window_timestamp).as_secs_f64();
            state.last_window_timestamp = now;

            if let Some(prev) = state.last_window_info.take() {
                // Ignore flicker under 300ms
                if duration >= 0.3 {
                    state.collector.push_activity(ActivityEvent {
                        timestamp: collector::now_iso(),
                        event_type: "window_focus".to_string(),
                        app_name: prev.app_name,
                        process_name: Some(prev.process_name),
                        window_title: Some(prev.window_title),
                        source: "tauri_win32".to_string(),
                        metadata: serde_json::json!({}),
                        duration_seconds: duration,
                    });
                }
            }

            state.last_window_info = Some(info);
        }
    }
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            handle_clipboard_update(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            handle_timer_tick();
            LRESULT(0)
        }
        WM_DESTROY => {
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = KillTimer(Some(hwnd), 1);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn handle_clipboard_update(hwnd: HWND) {
    let lock = match SENSOR_STATE.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(ref state) = *lock {
        // Stop collection if master toggle or clipboard sensor is OFF
        if !state.config.workstream || !state.config.sensors.clipboard {
            return;
        }

        if let Some(item) = clipboard::read_clipboard_text(hwnd) {
            let app_name = state.last_window_info.as_ref().map(|w| w.app_name.clone());
            state.collector.push_clipboard(ClipboardEvent {
                timestamp: collector::now_iso(),
                app_name,
                content: item.content,
                content_hash: item.content_hash,
                content_type: item.content_type,
            });
        }
    }
}

fn sync_config_from_backend(state: &mut SensorState) {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    if let Ok(mut stream) = TcpStream::connect_timeout(
        &"127.0.0.1:14300".parse().unwrap(),
        Duration::from_millis(300),
    ) {
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let req = "GET /workstream/config HTTP/1.1\r\nHost: 127.0.0.1:14300\r\nConnection: close\r\n\r\n";
        if stream.write_all(req.as_bytes()).is_ok() {
            let mut buf = Vec::new();
            if stream.read_to_end(&mut buf).is_ok() {
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let body = &buf[pos + 4..];
                    if let Ok(cfg) = serde_json::from_slice::<WorkstreamConfig>(body) {
                        state.config = cfg;
                    }
                }
            }
        }
    }
}

fn handle_timer_tick() {
    let mut lock = match SENSOR_STATE.lock() {
        Ok(l) => l,
        Err(_) => return,
    };
    if let Some(ref mut state) = *lock {
        // Periodic sync every 10 seconds
        if state.last_config_sync.elapsed().as_secs() >= 10 {
            state.last_config_sync = Instant::now();
            sync_config_from_backend(state);
        }

        // Stop collection if master toggle or idle sensor is OFF
        if !state.config.workstream || !state.config.sensors.idle {
            return;
        }

        match state.idle_tracker.check() {
            IdleStateChange::BecameIdle { idle_seconds } => {
                state.collector.push_activity(ActivityEvent {
                    timestamp: collector::now_iso(),
                    event_type: "idle_start".to_string(),
                    app_name: "System".to_string(),
                    process_name: None,
                    window_title: Some("User Idle".to_string()),
                    source: "tauri_win32".to_string(),
                    metadata: serde_json::json!({ "idle_threshold_seconds": idle_seconds }),
                    duration_seconds: 0.0,
                });
            }
            IdleStateChange::BecameActive { idle_duration_seconds } => {
                state.collector.push_activity(ActivityEvent {
                    timestamp: collector::now_iso(),
                    event_type: "idle_end".to_string(),
                    app_name: "System".to_string(),
                    process_name: None,
                    window_title: Some("User Resumed".to_string()),
                    source: "tauri_win32".to_string(),
                    metadata: serde_json::json!({}),
                    duration_seconds: idle_duration_seconds as f64,
                });
            }
            IdleStateChange::None => {}
        }
    }
}

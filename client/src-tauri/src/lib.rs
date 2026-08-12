mod audio;
mod kiosk_overlay;
mod location;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn set_foreground_lock(app: tauri::AppHandle, lock: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        use windows::Win32::UI::WindowsAndMessaging::{LockSetForegroundWindow, LSFW_LOCK, LSFW_UNLOCK};
        
        if let Some(window) = app.get_webview_window("main") {
            let _hwnd = window.hwnd().map_err(|e| e.to_string())?;
            let lock_code = if lock { LSFW_LOCK } else { LSFW_UNLOCK };
            unsafe {
                LockSetForegroundWindow(lock_code).map_err(|e| e.to_string())?;
            }
        }
    }
    let _ = app;
    let _ = lock;
    Ok(())
}

#[tauri::command]
fn set_window_capture_excluded(app: tauri::AppHandle, exclude: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};
        
        if let Some(window) = app.get_webview_window("main") {
            let hwnd = window.hwnd().map_err(|e| e.to_string())?;
            let affinity = if exclude { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE };
            println!("set_window_capture_excluded called with exclude = {}. Target affinity: {:?}", exclude, affinity);
            unsafe {
                if let Err(e) = SetWindowDisplayAffinity(hwnd, affinity) {
                    println!("Failed to set window display affinity: {:?}", e);
                    return Err(e.to_string());
                } else {
                    println!("Successfully set window display affinity to exclude = {}", exclude);
                }
            }
        }
    }
    let _ = app;
    let _ = exclude;
    Ok(())
}


struct BackendState(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn is_backend_running() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    TcpStream::connect_timeout(
        &"127.0.0.1:14300".parse().unwrap(),
        Duration::from_millis(100),
    )
    .is_ok()
}

/// Kill all rie-backend.exe processes using taskkill /T to terminate the entire process tree.
/// This is necessary because PyInstaller's --onefile mode creates a parent+child process pair.
fn kill_backend_processes() {
    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        // taskkill /F = force /IM = image name /T = terminate tree (children too)
        let _ = Command::new("taskkill")
            .args(["/F", "/IM", "rie-backend.exe", "/T"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows, try to kill by process name using pkill
        use std::process::Command;
        let _ = Command::new("pkill")
            .args(["-f", "rie-backend"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

struct AppToken(String);

#[tauri::command]
fn get_app_token(token: tauri::State<'_, AppToken>) -> String {
    token.0.clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Manager, Emitter};
    use rand::{distributions::Alphanumeric, Rng};

    let app_token: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            use tauri::Emitter;
            for arg in args {
                if arg.starts_with("rie-ai://") {
                    let _ = app.emit("deep-link", arg);
                }
            }
        }))

        // Enable global shortcut plugin (JS registers handlers)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    // Updater requires valid `plugins.updater` config. Skip it in debug/dev.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .setup(move |app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            use tauri_plugin_shell::ShellExt;
            use tauri_plugin_deep_link::DeepLinkExt;

            // Store the global app handle for the keyboard hook
            let handle = app.handle().clone();
            let _ = kiosk_overlay::APP_HANDLE.set(handle);

            // Create main window programmatically
            let _window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Rie-AI")
            .inner_size(360.0, 520.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .shadow(false)
            .skip_taskbar(true)
            .focused(false)
            .build()?;

            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
                if let Ok(hwnd) = _window.hwnd() {
                    unsafe {
                        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
                    }
                    let hwnd_raw = hwnd.0 as isize;
                    let _ = kiosk_overlay::register_raw_input(hwnd_raw);
                    kiosk_overlay::subclass_window(hwnd_raw);
                }
            }

            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                // Explicitly register the scheme on Windows for dev
                #[cfg(target_os = "windows")]
                {
                    let _ = app.deep_link().register("rie-ai");
                }

                app.deep_link().on_open_url(move |event| {
                    let urls = event.urls();
                    for url in urls {
                        let _ = handle.emit("deep-link", url.as_str());
                    }
                });
            }

            // Manage backend state
            app.manage(BackendState(std::sync::Mutex::new(None)));
            app.manage(AppToken(app_token.clone()));
            app.manage(audio::NativeAudioRecorder::default());
            app.manage(kiosk_overlay::KioskOverlayState::default());


            // Create tray menu
            let quit_i = MenuItem::with_id(app, "quit", "Quit Rie-AI", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Chat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_focus();
                            let _ = window.emit("tray-show", true);
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_focus();
                            let _ = window.emit("tray-show", true);
                            #[cfg(target_os = "windows")]
                            {
                                use windows::Win32::UI::WindowsAndMessaging::{LockSetForegroundWindow, LSFW_LOCK};
                                if window.hwnd().is_ok() {
                                    unsafe {
                                        let _ = LockSetForegroundWindow(LSFW_LOCK);
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            if std::env::var("SKIP_SIDECAR").unwrap_or_default() != "true" {
                if is_backend_running() {
                    println!("Backend already running on port 14300. Killing stale processes before respawn...");
                    // Kill any zombie processes that may be holding the port
                    kill_backend_processes();
                    // Brief delay for process termination (reduced from 500ms to 150ms)
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                
                // Additional safety: kill any existing rie-backend.exe processes before spawning
                // kill_backend_processes();
                // Brief delay for process termination (reduced from 200ms to 150ms)
                std::thread::sleep(std::time::Duration::from_millis(50));
                
                let sidecar_command = app.shell().sidecar("rie-backend").unwrap();
                let sidecar_command = sidecar_command.env("RIE_APP_TOKEN", &app_token);
                let (mut _rx, child) = sidecar_command
                    .spawn()
                    .expect("Failed to spawn sidecar");
                
                let state = app.state::<BackendState>();
                *state.0.lock().unwrap() = Some(child);
            } else {
                println!("Skipping sidecar spawning (SKIP_SIDECAR is true)");
            }

            // Clipboard Monitoring
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last_clipboard_text = String::new();
                loop {
                    if let Ok(text) = handle.clipboard().read_text() {
                        if !text.is_empty() && text != last_clipboard_text {
                            last_clipboard_text = text.clone();
                            let _ = handle.emit("clipboard-update", text);
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            exit_app,
            get_app_token,
            audio::start_native_recording,
            audio::stop_native_recording,
            location::get_native_location,
            set_foreground_lock,
            set_window_capture_excluded,
            kiosk_overlay::set_kiosk_overlay_mode,
            kiosk_overlay::get_kiosk_overlay_mode,
            kiosk_overlay::force_topmost,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<BackendState>();
                let mut lock = state.0.lock().unwrap();
                
                // First, try to kill the child process we have a handle to
                if let Some(child) = lock.take() {
                    let _ = child.kill();
                }
                
                // Then, kill the entire process tree using taskkill /T
                // This ensures both PyInstaller parent and child processes are terminated
                kill_backend_processes();
                
                println!("Killed backend sidecar process tree on exit.");
            }
        });
}

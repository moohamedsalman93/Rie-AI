// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

struct BackendState(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

fn is_backend_running() -> bool {
    use std::net::TcpStream;
    use std::time::Duration;
    TcpStream::connect_timeout(
        &"127.0.0.1:8000".parse().unwrap(),
        Duration::from_millis(100),
    )
    .is_ok()
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

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(move |app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            use tauri_plugin_shell::ShellExt;
            use tauri_plugin_deep_link::DeepLinkExt;

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


            // Create tray menu
            let quit_i = MenuItem::with_id(app, "quit", "Quit Rie-AI", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Chat", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            if std::env::var("SKIP_SIDECAR").unwrap_or_default() != "true" {
                if is_backend_running() {
                    println!("Backend already running on port 8000, skipping sidecar spawn.");
                } else {
                    let sidecar_command = app.shell().sidecar("rie-backend").unwrap();
                    let sidecar_command = sidecar_command.env("RIE_APP_TOKEN", &app_token);
                    let (mut _rx, child) = sidecar_command
                        .spawn()
                        .expect("Failed to spawn sidecar");
                    
                    let state = app.state::<BackendState>();
                    *state.0.lock().unwrap() = Some(child);
                }
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
        .invoke_handler(tauri::generate_handler![greet, exit_app, get_app_token])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<BackendState>();
                let mut lock = state.0.lock().unwrap();
                if let Some(child) = lock.take() {
                    let _ = child.kill();
                    println!("Killed backend sidecar on exit.");
                }
            }
        });
}

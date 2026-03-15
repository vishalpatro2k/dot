use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Register ⌘⇧D as global hotkey to toggle the input
            let shortcut = Shortcut::new(
                Some(Modifiers::META | Modifiers::SHIFT),
                Code::KeyD,
            );

            app.global_shortcut().on_shortcut(shortcut, {
                let window = window.clone();
                move |_app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = window.set_focus();
                        let _ = window.emit("toggle-input", ());
                    }
                }
            })?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running dot");
}

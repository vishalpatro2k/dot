use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

// macOS: force the NSWindow to be fully transparent at the native layer.
// Tauri's config sets transparent:true/backgroundColor:#00000000 on the webview,
// but the NSWindow itself can still have an opaque background. These three calls
// are the definitive fix.
#[cfg(target_os = "macos")]
fn apply_macos_transparency(window: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSColor, NSWindow};
    use cocoa::base::{id, nil, NO};

    if let Ok(ptr) = window.ns_window() {
        let ns_window = ptr as id;
        unsafe {
            ns_window.setOpaque_(NO);
            ns_window.setBackgroundColor_(NSColor::clearColor(nil));
            ns_window.setHasShadow_(NO);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "macos")]
            apply_macos_transparency(&window);

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

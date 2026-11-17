//! The menu-bar (macOS) or system-tray icon shown while background mode is on.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const ID: &str = "castle-tray";

/// Brings the main window back.
pub fn show(app: &AppHandle) {
    if let Some(w) = app.webview_windows().values().next() {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn ensure(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(ID).is_some() {
        return Ok(());
    }
    let open = MenuItem::with_id(app, "open", "Open Castle", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Castle", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id(ID)
        .tooltip("Castle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn remove(app: &AppHandle) {
    let _ = app.remove_tray_by_id(ID);
}

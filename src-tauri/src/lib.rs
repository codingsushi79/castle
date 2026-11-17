mod db;
mod engine;
mod fics;
mod misc;
mod tray;
mod updates;

use tauri::Manager;

pub fn run() {
    // An engine that exits must not take the app down with a broken pipe.
    #[cfg(unix)]
    unsafe {
        extern "C" {
            fn signal(sig: i32, handler: usize) -> usize;
        }
        signal(13, 1);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(engine::Engines::default())
        .manage(fics::Fics::default())
        .manage(updates::Pending::default())
        .manage(updates::Background::default())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let database = db::Database::open(&dir.join("library.sqlite")).map_err(|e| e.to_string())?;
            app.manage(database);
            misc::install_bundled_engines(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // In background mode, closing the window hides it; Castle stays in the menu bar or tray.
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.state::<updates::Background>().0.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Destroyed => window.state::<engine::Engines>().kill_all(),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_send,
            engine::engine_kill,
            fics::fics_connect,
            fics::fics_send,
            fics::fics_disconnect,
            db::db_import,
            db::db_import_text,
            db::db_query,
            db::db_get,
            db::db_delete,
            db::db_explorer,
            db::db_pattern,
            db::db_players,
            db::db_player_stats,
            db::db_folders,
            db::db_set_folder,
            db::db_set_tags,
            db::db_duplicates,
            db::db_merge_duplicates,
            db::db_export,
            db::db_count,
            db::db_similar,
            db::db_update_pgn,
            db::db_events,
            db::db_backup,
            db::db_restore,
            db::db_compact,
            misc::scan_paths,
            misc::resource_path,
            misc::app_dir,
            misc::secret_get,
            misc::secret_set,
            misc::read_text,
            misc::write_text,
            misc::write_bytes,
            misc::download,
            misc::list_dir,
            misc::brew_install,
            misc::print_page,
            misc::legacy_library,
            misc::legacy_data,
            updates::update_check,
            updates::update_download,
            updates::update_install,
            updates::app_location,
            updates::set_background,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Castle")
        .run(|_app, _event| {
            // Clicking the Dock icon brings back a window hidden by background mode.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show(_app);
            }
        });
}

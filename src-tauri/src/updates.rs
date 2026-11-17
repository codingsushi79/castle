//! Updates on two channels. Stable reads the manifest on GitHub's latest
//! release, which never points at a pre-release. Beta reads a manifest kept on
//! the `updater-beta` release, which CI moves to whichever is newer: the latest
//! beta or the latest stable release. Beta users therefore get stable releases too.
//!
//! An update is downloaded in the background first and installed only when the
//! user restarts, so restarting is quick. On macOS the new version is opened
//! through Launch Services once this one has quit: launching the binary
//! directly while the old process is still exiting is what left a second
//! Castle icon in the Dock.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const STABLE: &str = "https://github.com/codingsushi79/castle/releases/latest/download/latest.json";
const BETA: &str = "https://github.com/codingsushi79/castle/releases/download/updater-beta/latest.json";

#[derive(Default)]
pub struct Pending {
    update: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize)]
pub struct Found {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>, channel: String) -> Result<Option<Found>, String> {
    let url = Url::parse(if channel == "beta" { BETA } else { STABLE }).map_err(|e| e.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let found = update.as_ref().map(|u| Found { version: u.version.clone(), notes: u.body.clone() });
    // A different version than the one already downloaded means downloading again.
    let same = matches!((&*pending.update.lock().unwrap(), &update), (Some(a), Some(b)) if a.version == b.version);
    if !same {
        *pending.bytes.lock().unwrap() = None;
    }
    *pending.update.lock().unwrap() = update;
    Ok(found)
}

/// Downloads the update found by the last check (checking its signature),
/// reporting `update-progress` events of (bytes received, total bytes).
#[tauri::command]
pub async fn update_download(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    if pending.bytes.lock().unwrap().is_some() {
        return Ok(());
    }
    let update = pending.update.lock().unwrap().clone().ok_or("No update is waiting to be downloaded.")?;
    let mut received = 0usize;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk;
                let _ = app.emit("update-progress", (received, total));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    *pending.bytes.lock().unwrap() = Some(bytes);
    Ok(())
}

/// Installs the downloaded update and starts the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending.update.lock().unwrap().clone().ok_or("No update is waiting to be installed.")?;
    let bytes = pending.bytes.lock().unwrap().take().ok_or("The update hasn't been downloaded yet.")?;
    update.install(bytes).map_err(|e| e.to_string())?;
    relaunch(&app);
    Ok(())
}

/// Where Castle is running from. macOS runs an app it hasn't seen moved out of
/// Downloads (or a disk image) from a temporary read-only copy ("translocated"),
/// which can't be updated in place.
#[derive(Serialize)]
pub struct Location {
    path: String,
    translocated: bool,
    in_applications: bool,
}

#[tauri::command]
pub fn app_location() -> Location {
    let path = bundle_path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    Location {
        translocated: path.contains("/AppTranslocation/"),
        in_applications: path.starts_with("/Applications/") || path.contains("/Applications/"),
        path,
    }
}

/// The .app bundle on macOS (three levels up from the binary); the binary elsewhere.
fn bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    if cfg!(target_os = "macos") {
        exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(|p| p.to_path_buf())
    } else {
        Some(exe)
    }
}

/// Quits and starts the (new) version of Castle.
pub fn relaunch(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(bundle) = bundle_path() {
        // Wait for this process to be gone, then open the bundle the normal way,
        // so the Dock keeps one Castle icon.
        let pid = std::process::id().to_string();
        let script = "while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; /usr/bin/open \"$0\"";
        let _ = std::process::Command::new("/bin/sh").args(["-c", script]).arg(&bundle).arg(&pid).spawn();
        app.exit(0);
        return;
    }
    app.restart();
}

/// Background mode: closing the window keeps Castle running in the menu bar or
/// system tray, so move alerts and challenges still arrive.
#[derive(Default)]
pub struct Background(pub std::sync::atomic::AtomicBool);

#[tauri::command]
pub fn set_background(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<Background>().0.store(enabled, std::sync::atomic::Ordering::Relaxed);
    if enabled {
        crate::tray::ensure(&app).map_err(|e| e.to_string())
    } else {
        crate::tray::remove(&app);
        Ok(())
    }
}

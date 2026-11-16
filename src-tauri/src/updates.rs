//! Updates on two channels. Stable reads the manifest on GitHub's latest
//! release, which never points at a pre-release. Beta reads a manifest kept on
//! the `updater-beta` release, which CI moves to whichever is newer: the latest
//! beta or the latest stable release. Beta users therefore get stable releases too.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

const STABLE: &str = "https://github.com/codingsushi79/castle/releases/latest/download/latest.json";
const BETA: &str = "https://github.com/codingsushi79/castle/releases/download/updater-beta/latest.json";

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

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
    *pending.0.lock().unwrap() = update;
    Ok(found)
}

/// Downloads and installs the update found by the last check, reporting
/// progress as `update-progress` events of (bytes received, total bytes).
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("No update is waiting to be installed.")?;
    let mut received = 0usize;
    update
        .download_and_install(
            |chunk, total| {
                received += chunk;
                let _ = app.emit("update-progress", (received, total));
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

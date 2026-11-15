use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Returns which of the candidate paths are executable files.
#[tauri::command]
pub fn scan_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
            }
            #[cfg(not(unix))]
            {
                std::path::Path::new(p).is_file()
            }
        })
        .collect()
}

#[tauri::command]
pub fn resource_path(app: AppHandle, name: String) -> Result<String, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(name).to_string_lossy().to_string())
}

/// The app's data folder, with `sub` created inside it.
#[tauri::command]
pub fn app_dir(app: AppHandle, sub: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Reads a secret from the login keychain. Runs off the main thread, because macOS
/// may ask the user for permission and that must not freeze the window. Development
/// builds skip the keychain so that rebuilding never triggers that prompt.
#[tauri::command(async)]
pub fn secret_get(key: String) -> Option<String> {
    if cfg!(debug_assertions) {
        return None;
    }
    keyring::Entry::new("app.castle.Castle", &key).ok()?.get_password().ok()
}

#[tauri::command(async)]
pub fn secret_set(key: String, value: Option<String>) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let entry = keyring::Entry::new("app.castle.Castle", &key).map_err(|e| e.to_string())?;
    match value {
        Some(v) if !v.is_empty() => entry.set_password(&v).map_err(|e| e.to_string()),
        _ => {
            let _ = entry.delete_credential();
            Ok(())
        }
    }
}

#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    })
}

#[tauri::command]
pub fn write_text(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_dir(path: String) -> Vec<(String, u64)> {
    std::fs::read_dir(&path)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| (e.file_name().to_string_lossy().to_string(), e.metadata().map(|m| m.len()).unwrap_or(0)))
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Serialize)]
struct Progress {
    id: String,
    received: u64,
    total: u64,
    done: bool,
    error: Option<String>,
}

/// Downloads a file into the app's data folder. Only the hosts Castle fetches
/// tablebases and network weights from are allowed.
#[tauri::command]
pub fn download(app: AppHandle, id: String, url: String, dest: String) -> Result<(), String> {
    const HOSTS: [&str; 4] = ["https://tablebase.lichess.ovh/", "https://github.com/", "https://raw.githubusercontent.com/", "https://objects.githubusercontent.com/"];
    if !HOSTS.iter().any(|h| url.starts_with(h)) {
        return Err("That download location is not allowed.".into());
    }
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let target = PathBuf::from(&dest);
    if !target.starts_with(&base) {
        return Err("Downloads must stay inside Castle's data folder.".into());
    }
    std::thread::spawn(move || {
        let send = |received: u64, total: u64, done: bool, error: Option<String>| {
            let _ = app.emit("download-progress", Progress { id: id.clone(), received, total, done, error });
        };
        let run = || -> Result<(u64, u64), String> {
            let resp = ureq::get(&url).call().map_err(|e| e.to_string())?;
            let total = resp.header("Content-Length").and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let tmp = target.with_extension("part");
            let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
            let mut reader = resp.into_reader();
            let mut buf = vec![0u8; 1 << 16];
            let mut received = 0u64;
            let mut last = 0u64;
            loop {
                let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
                received += n as u64;
                if received - last > 1 << 20 {
                    last = received;
                    send(received, total, false, None);
                }
            }
            drop(file);
            std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            Ok((received, total))
        };
        match run() {
            Ok((received, total)) => send(received, total.max(received), true, None),
            Err(e) => send(0, 0, true, Some(e)),
        }
    });
    Ok(())
}

/// Installs a Homebrew formula, reporting the latest line of output as it goes.
#[tauri::command]
pub fn brew_install(app: AppHandle, formula: String) -> Result<(), String> {
    if !formula.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("bad formula".into());
    }
    let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .ok_or("Homebrew is not installed.")?
        .to_string();
    std::thread::spawn(move || {
        let child = Command::new(&brew)
            .args(["install", &formula])
            .env("HOMEBREW_NO_AUTO_UPDATE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let ok = match child {
            Ok(mut child) => {
                if let Some(out) = child.stdout.take() {
                    for line in BufReader::new(out).lines().map_while(Result::ok) {
                        let _ = app.emit("brew-progress", (formula.clone(), line));
                    }
                }
                child.wait().map(|s| s.success()).unwrap_or(false)
            }
            Err(_) => false,
        };
        let _ = app.emit("brew-done", (formula.clone(), ok));
    });
    Ok(())
}

#[tauri::command]
pub fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

/// The PGN library of the earlier Swift version of Castle, if it is still there.
#[tauri::command]
pub fn legacy_library(app: AppHandle) -> Option<String> {
    let dir = app.path().data_dir().ok()?.join("Castle").join("Library.pgn");
    dir.exists().then(|| dir.to_string_lossy().to_string())
}

fn plist_to_json(v: plist::Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        plist::Value::Array(a) => J::Array(a.into_iter().map(plist_to_json).collect()),
        plist::Value::Dictionary(d) => J::Object(d.into_iter().map(|(k, v)| (k, plist_to_json(v))).collect()),
        plist::Value::Boolean(b) => J::Bool(b),
        plist::Value::Real(r) => serde_json::json!(r),
        plist::Value::Integer(i) => i.as_signed().map(|n| serde_json::json!(n)).unwrap_or(J::Null),
        plist::Value::String(s) => J::String(s),
        plist::Value::Date(d) => J::String(format!("{:?}", d)),
        // Swift stored some settings as encoded JSON.
        plist::Value::Data(bytes) => serde_json::from_slice(&bytes).unwrap_or(J::Null),
        _ => J::Null,
    }
}

/// Settings and training data saved by the earlier Swift version of Castle.
#[tauri::command(async)]
pub fn legacy_data(app: AppHandle) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Ok(o) = Command::new("/usr/bin/defaults").args(["export", "app.castle.Castle", "-"]).output() {
        if let Ok(v) = plist::Value::from_reader_xml(&o.stdout[..]) {
            out.insert("defaults".into(), plist_to_json(v));
        }
    }
    if let Ok(dir) = app.path().data_dir() {
        let dir = dir.join("Castle");
        for name in ["PuzzleStats.json", "Mistakes.json", "Repertoire-White.pgn", "Repertoire-Black.pgn", "RepertoireCards.json"] {
            if let Ok(text) = std::fs::read_to_string(dir.join(name)) {
                out.insert(name.into(), serde_json::Value::String(text));
            }
        }
    }
    serde_json::Value::Object(out)
}

/// Copies engines shipped inside the app into the data folder, so they survive
/// updates built without them (release builds leave out the private Wasabi binary).
pub fn install_bundled_engines(app: &AppHandle) {
    let (Ok(res), Ok(data)) = (app.path().resource_dir(), app.path().app_data_dir()) else { return };
    let src = res.join("wasabi-2.1");
    let dir = data.join("engines");
    let dest = dir.join("wasabi-2.1");
    let Ok(meta) = std::fs::metadata(&src) else { return };
    let current = std::fs::metadata(&dest).map(|m| m.len() == meta.len()).unwrap_or(false);
    if current {
        return;
    }
    if std::fs::create_dir_all(&dir).is_ok() && std::fs::copy(&src, &dest).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
    }
}

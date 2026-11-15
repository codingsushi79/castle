use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct Running {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Engines(Mutex<HashMap<String, Running>>);

impl Engines {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut e) in map.drain() {
                let _ = e.stdin.write_all(b"quit\n");
                let _ = e.child.kill();
            }
        }
    }
}

#[derive(Clone, Serialize)]
struct Output {
    id: String,
    lines: Vec<String>,
}

/// Starts a UCI engine. Its output arrives as batched `engine-output` events and
/// an `engine-exit` event when the process ends.
#[tauri::command]
pub fn engine_start(app: AppHandle, state: State<Engines>, id: String, path: String) -> Result<(), String> {
    let real = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&path);
    // Engines look for their network files next to the real binary.
    if let Some(dir) = real.parent() {
        cmd.current_dir(dir);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not start {}: {}", Path::new(&path).display(), e))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
            let text = String::from_utf8_lossy(&line).trim().to_string();
            if !text.is_empty() && tx.send(text).is_err() {
                break;
            }
        }
    });
    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut batch: Vec<String> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(40)) {
                Ok(line) => {
                    let urgent = line.starts_with("bestmove") || line == "uciok" || line == "readyok";
                    batch.push(line);
                    if !urgent && batch.len() < 200 {
                        continue;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !batch.is_empty() {
                        let _ = app.emit("engine-output", Output { id: emit_id.clone(), lines: std::mem::take(&mut batch) });
                    }
                    let _ = app.emit("engine-exit", emit_id.clone());
                    break;
                }
            }
            if !batch.is_empty() {
                let _ = app.emit("engine-output", Output { id: emit_id.clone(), lines: std::mem::take(&mut batch) });
            }
        }
    });

    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut old) = map.insert(id, Running { child, stdin }) {
        let _ = old.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn engine_send(state: State<Engines>, id: String, line: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let engine = map.get_mut(&id).ok_or("engine not running")?;
    engine.stdin.write_all(format!("{}\n", line).as_bytes()).map_err(|e| e.to_string())?;
    engine.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn engine_kill(state: State<Engines>, id: String) {
    if let Ok(mut map) = state.0.lock() {
        if let Some(mut e) = map.remove(&id) {
            let _ = e.stdin.write_all(b"quit\n");
            let _ = e.stdin.flush();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                let _ = e.child.kill();
                let _ = e.child.wait();
            });
        }
    }
}

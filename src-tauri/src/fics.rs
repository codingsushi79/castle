use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct Fics(Mutex<Option<TcpStream>>);

/// Opens the plain-text connection to a chess server. Incoming text arrives as
/// `fics-data` events with telnet negotiation stripped; `fics-closed` ends it.
#[tauri::command]
pub fn fics_connect(app: AppHandle, state: State<Fics>, host: String, port: u16) -> Result<(), String> {
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("host not found")?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(12)).map_err(|e| e.to_string())?;
    let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
    if let Some(old) = state.0.lock().map_err(|e| e.to_string())?.replace(stream) {
        let _ = old.shutdown(Shutdown::Both);
    }
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut text = String::with_capacity(n);
                    let mut i = 0;
                    while i < n {
                        let b = buf[i];
                        if b == 255 {
                            let cmd = if i + 1 < n { buf[i + 1] } else { 0 };
                            i += if (251..=254).contains(&cmd) { 3 } else { 2 };
                            continue;
                        }
                        if b != 13 && b != 7 && b != 0 {
                            text.push(b as char);
                        }
                        i += 1;
                    }
                    let _ = app.emit("fics-data", text);
                }
            }
        }
        let _ = app.emit("fics-closed", ());
    });
    Ok(())
}

#[tauri::command]
pub fn fics_send(state: State<Fics>, text: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let stream = guard.as_mut().ok_or("not connected")?;
    let bytes: Vec<u8> = text.chars().map(|c| if (c as u32) < 256 { c as u8 } else { b'?' }).chain(std::iter::once(b'\n')).collect();
    stream.write_all(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fics_disconnect(state: State<Fics>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(s) = guard.take() {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

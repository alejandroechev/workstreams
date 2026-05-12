// @test-skip: PTY native wrapper (portable-pty) — covered by E2E
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    #[allow(dead_code)]
    pid: Option<u32>,
}

pub struct PtyManager {
    handles: Mutex<HashMap<String, PtyHandle>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }

    /// Spawn a new PTY session. Returns the process PID (if available).
    /// The PTY reader runs in a background thread and emits events to the frontend.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: &AppHandle,
        tile_id: &str,
        cwd: &str,
        command: Option<&str>,
        args: Option<Vec<String>>,
        rows: u16,
        cols: u16,
    ) -> Result<Option<u32>, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {e}"))?;

        let shell = command.unwrap_or("pwsh.exe");
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        if let Some(ref a) = args {
            for arg in a {
                cmd.arg(arg);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn: {e}"))?;

        let pid = child.process_id();
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get reader: {e}"))?;

        let master = Arc::new(Mutex::new(pair.master));

        let handle = PtyHandle {
            writer,
            master,
            pid,
        };

        {
            let mut handles = self.handles.lock().unwrap();
            handles.insert(tile_id.to_string(), handle);
        }

        // Background reader thread: PTY output → Tauri events
        let id = tile_id.to_string();
        let app_handle = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = app_handle.emit(&format!("pty-exit-{id}"), ());
                        break;
                    }
                    Ok(n) => {
                        // Send raw bytes as lossy UTF-8 string
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_handle.emit(&format!("pty-output-{id}"), data);
                    }
                    Err(_) => {
                        let _ = app_handle.emit(&format!("pty-exit-{id}"), ());
                        break;
                    }
                }
            }
        });

        Ok(pid)
    }

    /// Write user input to a PTY
    pub fn write(&self, tile_id: &str, data: &[u8]) -> Result<(), String> {
        let mut handles = self.handles.lock().unwrap();
        if let Some(h) = handles.get_mut(tile_id) {
            h.writer
                .write_all(data)
                .map_err(|e| format!("Write error: {e}"))?;
            h.writer.flush().map_err(|e| format!("Flush error: {e}"))?;
            Ok(())
        } else {
            Err("Tile not found".into())
        }
    }

    /// Resize a PTY
    pub fn resize(&self, tile_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let handles = self.handles.lock().unwrap();
        if let Some(h) = handles.get(tile_id) {
            let master = h.master.lock().unwrap();
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("Resize error: {e}"))?;
            Ok(())
        } else {
            Err("Tile not found".into())
        }
    }

    /// Close/kill a PTY session
    pub fn close(&self, tile_id: &str) {
        let mut handles = self.handles.lock().unwrap();
        handles.remove(tile_id);
        // Dropping the handle closes the writer and master, which terminates the PTY
    }

    /// Close all PTY sessions (used on app shutdown)
    pub fn close_all(&self) {
        let mut handles = self.handles.lock().unwrap();
        let count = handles.len();
        handles.clear();
        if count > 0 {
            eprintln!("[pty] Closed {} PTY sessions on shutdown", count);
        }
    }

    /// Check if a PTY is active
    #[allow(dead_code)]
    pub fn is_active(&self, tile_id: &str) -> bool {
        let handles = self.handles.lock().unwrap();
        handles.contains_key(tile_id)
    }
}

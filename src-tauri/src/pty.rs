use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, ExitStatus, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

// Batching parameters for the PTY reader → Tauri event pipeline.
//
// Rationale (see docs/perf-investigation.md): on Windows ConPTY breaks
// output into ~55-byte chunks. Before batching, a single noisy command
// (e.g. a 2000-line `Write-Host` loop) produced ~1800 Tauri events/sec —
// each event paid JSON-encode + WebView2 IPC + JS handler + xterm.write.
// Batching for one frame (16 ms) or 4 KB collapses that to ~60 events/sec
// at the cost of one-frame perceived latency, which is below the human
// threshold for interactive feedback.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_BYTES: usize = 4096;
const PROCESS_EXIT_GRACE: Duration = Duration::from_secs(2);

/// Returns how many leading bytes of `buf` are safe to emit now such that the
/// retained remainder (if any) is only an *incomplete trailing* UTF-8 sequence.
///
/// - All-valid buffer → its full length (emit everything).
/// - Ends mid-multibyte-character (truncated tail) → the valid prefix length,
///   so the caller holds the 1–3 trailing bytes until the rest arrives. This is
///   what prevents `from_utf8_lossy` from baking `�` into a character that was
///   merely split across a flush boundary (the frequent TUI glyph corruption).
/// - Genuinely invalid bytes mid-stream (not a boundary split) → the full
///   length, so we never stall; `from_utf8_lossy` replaces them as before.
fn flushable_prefix_len(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) => match e.error_len() {
            // `None` = the error is an unexpected end of input → truncated
            // trailing char; hold it back.
            None => e.valid_up_to(),
            // `Some(_)` = a real invalid sequence in the middle; flush it all.
            Some(_) => buf.len(),
        },
    }
}

/// Emit the portion of `acc` that forms complete UTF-8, retaining any
/// incomplete trailing bytes in `acc` for the next flush. Emits nothing when
/// `acc` currently holds only an incomplete sequence.
fn flush_prefix<F>(acc: &mut Vec<u8>, emit: &mut F)
where
    F: FnMut(Vec<u8>),
{
    let n = flushable_prefix_len(acc);
    if n == 0 {
        return;
    }
    if n == acc.len() {
        emit(std::mem::take(acc));
    } else {
        let rest = acc.split_off(n); // acc = [..n]; rest = [n..]
        let prefix = std::mem::replace(acc, rest);
        emit(prefix);
    }
}

/// Drain `rx` of byte chunks, accumulate them, and invoke `emit` either
/// when the accumulator reaches `flush_bytes` or `flush_interval` has
/// elapsed since the last flush. Returns when the channel is disconnected;
/// performs one final flush of any remaining bytes before returning.
///
/// Only **complete** UTF-8 is emitted: an incomplete multi-byte character at a
/// flush boundary is held back until the rest of its bytes arrive, so the
/// downstream `from_utf8_lossy` never corrupts a split character (the final
/// flush on disconnect emits whatever remains, lossily, to avoid dropping a
/// truncated tail).
///
/// Extracted as a standalone function so it can be unit-tested without
/// a live PTY / Tauri AppHandle (see `tests::run_batcher_*` below).
pub fn run_batcher<F>(
    rx: mpsc::Receiver<Vec<u8>>,
    flush_interval: Duration,
    flush_bytes: usize,
    mut emit: F,
) where
    F: FnMut(Vec<u8>),
{
    let mut acc: Vec<u8> = Vec::with_capacity(flush_bytes * 2);
    let mut last_flush = Instant::now();
    loop {
        let timeout = if acc.is_empty() {
            flush_interval
        } else {
            flush_interval.saturating_sub(last_flush.elapsed())
        };
        match rx.recv_timeout(timeout) {
            Ok(chunk) => {
                acc.extend_from_slice(&chunk);
                if acc.len() >= flush_bytes {
                    flush_prefix(&mut acc, &mut emit);
                    last_flush = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !acc.is_empty() {
                    flush_prefix(&mut acc, &mut emit);
                    // Reset the timer even if nothing was emitted (acc held only
                    // an incomplete trailing char) so we wait a full interval for
                    // its remaining bytes instead of busy-spinning.
                    last_flush = Instant::now();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !acc.is_empty() {
                    // Final flush: emit everything, including any truncated tail.
                    emit(std::mem::take(&mut acc));
                }
                break;
            }
        }
    }
}

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    waiter: Option<JoinHandle<()>>,
    wait_done: mpsc::Receiver<()>,
    process_group_id: Option<i32>,
    generation: u64,
    #[allow(dead_code)]
    pid: Option<u32>,
}

#[derive(Clone, serde::Serialize)]
struct PtyProcessExit {
    pid: Option<u32>,
    exit_code: Option<u32>,
    success: bool,
    error: Option<String>,
}

fn wait_for_child(mut child: Box<dyn Child + Send + Sync>) -> std::io::Result<ExitStatus> {
    child.wait()
}

fn terminate_and_wait(mut child: Box<dyn Child + Send + Sync>) -> Result<ExitStatus, String> {
    let kill_error = child.kill().err();
    let wait_result = child
        .wait()
        .map_err(|error| format!("Failed to wait for PTY child: {error}"));
    match (kill_error, wait_result) {
        (_, Ok(status)) => Ok(status),
        (Some(kill), Err(wait)) => Err(format!("Failed to terminate PTY child: {kill}; {wait}")),
        (None, Err(wait)) => Err(wait),
    }
}

#[cfg(unix)]
fn force_kill_process(pid: Option<u32>, process_group_id: Option<i32>) -> Result<(), String> {
    let target = process_group_id
        .map(|group| -group)
        .or_else(|| pid.map(|value| value as i32))
        .ok_or_else(|| "PTY child has no process id".to_string())?;
    let result = unsafe { libc::kill(target, libc::SIGKILL) };
    if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(format!(
            "Failed to force-kill PTY process {target}: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(unix))]
fn force_kill_process(_pid: Option<u32>, _process_group_id: Option<i32>) -> Result<(), String> {
    Err("PTY child did not exit after termination request".to_string())
}

fn finish_pty_handle(mut handle: PtyHandle) -> Result<(), String> {
    let terminate_error = handle.killer.kill().err();
    drop(handle.writer);
    drop(handle.master);

    match handle.wait_done.recv_timeout(PROCESS_EXIT_GRACE) {
        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
        Err(mpsc::RecvTimeoutError::Timeout) => {
            force_kill_process(handle.pid, handle.process_group_id)?;
            handle
                .wait_done
                .recv_timeout(PROCESS_EXIT_GRACE)
                .map_err(|_| "PTY child did not exit after force-kill".to_string())?;
        }
    }
    if let Some(waiter) = handle.waiter.take() {
        waiter
            .join()
            .map_err(|_| "PTY process waiter panicked".to_string())?;
    }

    if let Some(error) = terminate_error {
        #[cfg(unix)]
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        eprintln!(
            "[pty] Initial termination request for {:?} failed after process exit: {error}",
            handle.pid
        );
    }
    Ok(())
}

/// Pick a sane default shell when a terminal tile doesn't specify a command.
///
/// This must be platform-aware: `pwsh.exe` only exists on Windows, so using it
/// as a universal default made every terminal tile fail to spawn on
/// macOS/Linux.
#[cfg(windows)]
pub fn default_shell() -> String {
    "pwsh.exe".to_string()
}

#[cfg(unix)]
pub fn default_shell() -> String {
    resolve_unix_shell(std::env::var("SHELL").ok())
}

/// Resolve the Unix default shell from the `$SHELL` environment variable.
///
/// Split out from [`default_shell`] so the fallback logic is unit-testable
/// without mutating process-global environment state. We only trust an
/// absolute path; anything else (unset, blank, or a bare name) falls back to
/// `/bin/zsh`, the macOS default login shell since Catalina and present on
/// virtually all Linux distros too.
#[cfg(unix)]
fn resolve_unix_shell(env_shell: Option<String>) -> String {
    const FALLBACK: &str = "/bin/zsh";
    match env_shell {
        Some(s) if s.trim().starts_with('/') => s.trim().to_string(),
        _ => FALLBACK.to_string(),
    }
}

/// Terminal type advertised to spawned shells when the launcher supplied none.
///
/// xterm.js implements the xterm protocol with 256-colour support, so this is
/// an honest description of the emulator on the other end of the PTY.
#[cfg(unix)]
const DEFAULT_TERM: &str = "xterm-256color";

/// True when `TERM` is missing or too degraded to support line editing.
///
/// A GUI launch (Dock/Finder/Spotlight on macOS) inherits launchd's
/// environment, which has no `TERM` at all; a bare `sh` under it reports
/// `dumb`. Either way `zsh` disables ZLE, the tty falls back to canonical
/// mode, and the kernel echoes an erase as a plain space — so Backspace
/// appears to *insert spaces* rather than delete. Advertising a real terminal
/// type restores normal line editing.
#[cfg(unix)]
fn needs_term_repair(inherited: Option<&str>) -> bool {
    match inherited.map(str::trim) {
        None | Some("") | Some("dumb") | Some("unknown") => true,
        Some(_) => false,
    }
}

/// Build the environment overrides applied to a spawned PTY.
///
/// Caller-supplied workstream vars are layered *on top of* the repaired
/// `PATH`/`TERM` so an explicit value from the caller always wins. Split out
/// from [`PtyManager::spawn`] so the precedence rules are unit-testable
/// without opening a real PTY.
fn spawn_env_overrides(
    caller_env: Option<HashMap<String, String>>,
    resolved_path: Option<String>,
) -> HashMap<String, String> {
    spawn_env_overrides_with(caller_env, resolved_path, std::env::var("TERM").ok())
}

/// [`spawn_env_overrides`] with the inherited `TERM` injected, so the repair
/// rule is testable without mutating process-global environment state.
fn spawn_env_overrides_with(
    caller_env: Option<HashMap<String, String>>,
    resolved_path: Option<String>,
    inherited_term: Option<String>,
) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(path) = resolved_path {
        out.insert("PATH".to_string(), path);
    }
    // Windows terminals do not use termcap/terminfo, and ConPTY already
    // reports a capable terminal, so this repair is Unix-only.
    #[cfg(unix)]
    {
        if needs_term_repair(inherited_term.as_deref()) {
            out.insert("TERM".to_string(), DEFAULT_TERM.to_string());
        } else if let Some(term) = inherited_term {
            out.insert("TERM".to_string(), term);
        }
    }
    #[cfg(not(unix))]
    let _ = inherited_term;
    if let Some(env_vars) = caller_env {
        for (k, v) in env_vars {
            out.insert(k, v);
        }
    }
    out
}

pub struct PtyManager {
    handles: Arc<Mutex<HashMap<String, PtyHandle>>>,
    next_generation: AtomicU64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            next_generation: AtomicU64::new(1),
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
        env: Option<HashMap<String, String>>,
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

        let shell = command.map(|c| c.to_string()).unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        if let Some(ref a) = args {
            for arg in a {
                cmd.arg(arg);
            }
        }
        // A GUI launch (Dock/Finder on macOS) inherits launchd's stunted PATH,
        // which hides every user-installed tool including the Copilot CLI.
        // Repair it before spawning so `agency`/`copilot`/`node` resolve.
        let overrides = spawn_env_overrides(env, crate::shell_env::resolved_path(&default_shell()));
        for (k, v) in overrides {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn: {e}"))?;

        let pid = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {e}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get reader: {e}"))?;

        #[cfg(unix)]
        let process_group_id = pair.master.process_group_leader();
        #[cfg(not(unix))]
        let process_group_id = None;
        let master = Arc::new(Mutex::new(pair.master));

        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let id_for_waiter = tile_id.to_string();
        let handles_for_waiter = Arc::clone(&self.handles);
        let app_for_waiter = app.clone();
        let (child_tx, child_rx) = mpsc::sync_channel::<Box<dyn Child + Send + Sync>>(0);
        let (wait_done_tx, wait_done_rx) = mpsc::sync_channel(1);
        let waiter = match std::thread::Builder::new()
            .name(format!("pty-wait-{tile_id}"))
            .spawn(move || {
                let Ok(child) = child_rx.recv() else {
                    return;
                };
                let exit = match wait_for_child(child) {
                    Ok(status) => PtyProcessExit {
                        pid,
                        exit_code: Some(status.exit_code()),
                        success: status.success(),
                        error: None,
                    },
                    Err(error) => PtyProcessExit {
                        pid,
                        exit_code: None,
                        success: false,
                        error: Some(error.to_string()),
                    },
                };
                let _ = wait_done_tx.send(());

                let mut handles = handles_for_waiter.lock().unwrap();
                if handles
                    .get(&id_for_waiter)
                    .is_some_and(|handle| handle.generation == generation)
                {
                    handles.remove(&id_for_waiter);
                }
                drop(handles);

                let _ = app_for_waiter.emit(&format!("pty-process-exit-{id_for_waiter}"), exit);
            }) {
            Ok(waiter) => waiter,
            Err(error) => {
                let cleanup = terminate_and_wait(child)
                    .err()
                    .map(|cleanup| format!("; cleanup also failed: {cleanup}"))
                    .unwrap_or_default();
                return Err(format!(
                    "Failed to start PTY process waiter: {error}{cleanup}"
                ));
            }
        };

        {
            let mut handles = self.handles.lock().unwrap();
            handles.insert(
                tile_id.to_string(),
                PtyHandle {
                    writer,
                    master,
                    killer,
                    waiter: Some(waiter),
                    wait_done: wait_done_rx,
                    process_group_id,
                    generation,
                    pid,
                },
            );
        }

        if let Err(error) = child_tx.send(child) {
            let mut handles = self.handles.lock().unwrap();
            let handle = handles.remove(tile_id);
            drop(handles);
            if let Some(handle) = handle {
                drop(handle.writer);
                drop(handle.master);
                if let Some(waiter) = handle.waiter {
                    let _ = waiter.join();
                }
            }
            let cleanup = terminate_and_wait(error.0)
                .err()
                .map(|cleanup| format!("; cleanup also failed: {cleanup}"))
                .unwrap_or_default();
            return Err(format!(
                "Failed to hand PTY child to process waiter{cleanup}"
            ));
        }

        // Background reader thread: PTY output → mpsc channel → batcher
        // thread → Tauri events. We split read from emit so we can apply a
        // time-based flush (recv_timeout) without losing data while the
        // reader blocks on the next OS read().
        let id = tile_id.to_string();
        let app_handle = app.clone();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();

        // Reader thread: blocking PTY reads → channel
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break; // batcher dropped
                        }
                    }
                    Err(_) => break,
                }
            }
            // Dropping tx closes the channel; batcher will see Disconnected.
        });

        // Batcher thread: accumulate up to FLUSH_BYTES or FLUSH_INTERVAL, then
        // emit a single pty-output event. Emit pty-exit when reader closes.
        let id_emit = id.clone();
        let app_for_batcher = app_handle.clone();
        std::thread::spawn(move || {
            run_batcher(rx, FLUSH_INTERVAL, FLUSH_BYTES, |chunk| {
                let data = String::from_utf8_lossy(&chunk).to_string();
                let _ = app_for_batcher.emit(&format!("pty-output-{id_emit}"), data);
            });
            let _ = app_handle.emit(&format!("pty-exit-{id}"), ());
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
    pub fn close(&self, tile_id: &str) -> Result<(), String> {
        let mut handles = self.handles.lock().unwrap();
        let handle = handles.remove(tile_id);
        drop(handles);
        let Some(handle) = handle else {
            return Ok(());
        };

        finish_pty_handle(handle)
    }

    /// Close all PTY sessions (used on app shutdown)
    pub fn close_all(&self) {
        let mut handles = self.handles.lock().unwrap();
        let count = handles.len();
        let drained: Vec<PtyHandle> = handles.drain().map(|(_, handle)| handle).collect();
        drop(handles);
        for handle in drained {
            let pid = handle.pid;
            if let Err(error) = finish_pty_handle(handle) {
                eprintln!("[pty] Failed to close {pid:?}: {error}");
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_is_platform_appropriate() {
        let shell = default_shell();
        assert!(
            !shell.is_empty(),
            "default shell must never be empty (it is passed straight to CommandBuilder)"
        );

        #[cfg(windows)]
        assert_eq!(
            shell, "pwsh.exe",
            "Windows keeps PowerShell as the default shell"
        );

        // On Unix (macOS/Linux) the default must be an absolute path to a real
        // shell binary — `pwsh.exe` does not exist there, so spawning a
        // terminal tile with the Windows default would fail outright.
        #[cfg(unix)]
        {
            assert!(
                shell.starts_with('/'),
                "unix default shell must be an absolute path, got {shell}"
            );
            assert!(
                !shell.ends_with(".exe"),
                "unix default shell must not be a Windows executable, got {shell}"
            );
        }
    }

    #[test]
    fn default_shell_prefers_the_shell_env_var_on_unix() {
        // The user's login shell ($SHELL) is the correct default on Unix; we
        // only fall back to a hardcoded path when it is unset/empty.
        #[cfg(unix)]
        {
            let resolved = resolve_unix_shell(Some("/opt/homebrew/bin/fish".to_string()));
            assert_eq!(resolved, "/opt/homebrew/bin/fish");

            // Unset or blank -> zsh (the macOS default since Catalina).
            assert_eq!(resolve_unix_shell(None), "/bin/zsh");
            assert_eq!(resolve_unix_shell(Some("   ".to_string())), "/bin/zsh");

            // A relative/garbage value is not trustworthy as an absolute
            // program path; fall back rather than fail to spawn.
            assert_eq!(resolve_unix_shell(Some("zsh".to_string())), "/bin/zsh");
        }
    }

    #[test]
    fn spawn_env_injects_the_repaired_path() {
        let out = spawn_env_overrides(None, Some("/opt/homebrew/bin:/usr/bin".to_string()));
        assert_eq!(
            out.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_env_sets_term_when_the_launcher_provided_none() {
        // A GUI launch (Dock/Finder) inherits no TERM. Without it zsh treats
        // the tty as dumb, disables ZLE, and the erase echo degrades to plain
        // spaces — backspace visibly "types spaces" instead of deleting.
        let out = spawn_env_overrides(None, None);
        assert_eq!(out.get("TERM").map(String::as_str), Some("xterm-256color"));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_env_keeps_an_inherited_term() {
        // Launched from a terminal: respect whatever the user's terminal set.
        let out = spawn_env_overrides_with(None, None, Some("screen-256color".to_string()));
        assert_eq!(out.get("TERM").map(String::as_str), Some("screen-256color"));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_env_replaces_a_dumb_term() {
        // `TERM=dumb` is what a bare `sh` reports under launchd; it disables
        // line editing just as badly as having no TERM at all.
        let out = spawn_env_overrides_with(None, None, Some("dumb".to_string()));
        assert_eq!(out.get("TERM").map(String::as_str), Some("xterm-256color"));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_env_lets_caller_override_term() {
        let mut caller = HashMap::new();
        caller.insert("TERM".to_string(), "vt100".to_string());
        let out = spawn_env_overrides(Some(caller), None);
        assert_eq!(out.get("TERM").map(String::as_str), Some("vt100"));
    }

    #[test]
    fn spawn_env_leaves_path_untouched_when_not_resolved() {
        // Terminal launches (and Windows) resolve to None — we must not set
        // PATH at all so the child inherits the process environment verbatim.
        let mut caller = HashMap::new();
        caller.insert("WORKSTREAMS_ACTIVE_TILE".to_string(), "tile-1".to_string());
        let out = spawn_env_overrides(Some(caller), None);
        assert!(!out.contains_key("PATH"));
        assert_eq!(
            out.get("WORKSTREAMS_ACTIVE_TILE").map(String::as_str),
            Some("tile-1")
        );
    }

    #[test]
    fn spawn_env_lets_caller_override_path() {
        let mut caller = HashMap::new();
        caller.insert("PATH".to_string(), "/caller/wins".to_string());
        let out = spawn_env_overrides(Some(caller), Some("/resolved".to_string()));
        assert_eq!(out.get("PATH").map(String::as_str), Some("/caller/wins"));
    }

    #[test]
    fn pty_manager_starts_empty() {
        let mgr = PtyManager::new();
        assert!(!mgr.is_active("nonexistent"));
    }

    #[test]
    fn pty_manager_close_all_on_empty_is_safe() {
        let mgr = PtyManager::new();
        mgr.close_all();
        assert!(!mgr.is_active("any-tile"));
    }

    #[test]
    fn pty_manager_write_to_missing_pty_errors() {
        let mgr = PtyManager::new();
        let result = mgr.write("nonexistent-tile", b"data");
        assert!(result.is_err());
    }

    #[test]
    fn pty_manager_resize_missing_pty_errors() {
        let mgr = PtyManager::new();
        let result = mgr.resize("nonexistent-tile", 24, 80);
        assert!(result.is_err());
    }

    #[test]
    fn pty_manager_close_missing_pty_is_idempotent() {
        let mgr = PtyManager::new();
        mgr.close("nonexistent-tile").unwrap();
        // Should not panic
        assert!(!mgr.is_active("nonexistent-tile"));
    }

    #[cfg(unix)]
    #[test]
    fn waiting_for_a_pty_child_collects_its_process() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open test PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("exit 7");
        let child = pair
            .slave
            .spawn_command(command)
            .expect("spawn short-lived PTY child");
        let pid = child.process_id().expect("unix PTY child has a pid");
        drop(pair.slave);

        let status = wait_for_child(child).expect("wait for PTY child");
        drop(pair.master);
        assert_eq!(status.exit_code(), 7);

        let mut raw_status = 0;
        let wait_result =
            unsafe { libc::waitpid(pid as libc::pid_t, &mut raw_status, libc::WNOHANG) };
        assert_eq!(
            wait_result, -1,
            "the child must already have been collected"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD),
            "a second wait must report that no child remains"
        );
    }

    #[cfg(unix)]
    #[test]
    fn terminating_a_pty_child_also_collects_its_process() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open test PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("sleep 30");
        let child = pair
            .slave
            .spawn_command(command)
            .expect("spawn long-lived PTY child");
        let pid = child.process_id().expect("unix PTY child has a pid");
        drop(pair.slave);

        let status = terminate_and_wait(child).expect("terminate and wait for PTY child");
        drop(pair.master);
        assert!(!status.success());

        let mut raw_status = 0;
        let wait_result =
            unsafe { libc::waitpid(pid as libc::pid_t, &mut raw_status, libc::WNOHANG) };
        assert_eq!(wait_result, -1, "the terminated child must be collected");
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD),
            "a second wait must report that no child remains"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounded_close_force_kills_a_child_that_ignores_hangup() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open test PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("trap '' HUP; sleep 30");
        let child = pair
            .slave
            .spawn_command(command)
            .expect("spawn HUP-resistant PTY child");
        let pid = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);
        let writer = pair.master.take_writer().expect("take writer");
        let process_group_id = pair.master.process_group_leader();
        let master = Arc::new(Mutex::new(pair.master));
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let waiter = std::thread::spawn(move || {
            let result = wait_for_child(child);
            let _ = done_tx.send(());
            result
        });
        std::thread::sleep(Duration::from_millis(100));

        let started = Instant::now();
        finish_pty_handle(PtyHandle {
            writer,
            master,
            killer,
            waiter: Some(std::thread::spawn(move || {
                let _ = waiter.join();
            })),
            wait_done: done_rx,
            process_group_id,
            generation: 1,
            pid,
        })
        .expect("bounded close");

        assert!(
            started.elapsed() < Duration::from_secs(6),
            "close must not wait for the ignored SIGHUP process"
        );
    }

    // ── PTY output batcher tests ─────────────────────────────────────────
    //
    // These cover the pure run_batcher() helper extracted from the spawn()
    // reader-thread plumbing. The spawn-side wiring is exercised
    // end-to-end by the e2e CDP probe.

    use std::sync::mpsc as test_mpsc;
    use std::sync::Mutex as TestMutex;

    #[test]
    fn batcher_flushes_a_small_chunk_after_interval_elapses() {
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let handle = std::thread::spawn(move || {
            run_batcher(rx, Duration::from_millis(20), 4096, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        tx.send(b"hi".to_vec()).unwrap();
        // Give the batcher time to hit its interval flush
        std::thread::sleep(Duration::from_millis(80));
        drop(tx);
        handle.join().unwrap();
        let out = emitted.lock().unwrap();
        // Exactly one event with the single small chunk's bytes.
        assert_eq!(out.len(), 1, "expected one event after interval flush");
        assert_eq!(out[0], b"hi");
    }

    #[test]
    fn batcher_flushes_immediately_when_buffer_reaches_threshold() {
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        // 1-hour interval guarantees the only flush trigger is the byte threshold.
        let handle = std::thread::spawn(move || {
            run_batcher(rx, Duration::from_secs(3600), 16, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        tx.send(b"abcdefgh".to_vec()).unwrap();
        // Below threshold — should not have flushed yet
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(
            emitted.lock().unwrap().len(),
            0,
            "must not flush below threshold"
        );
        tx.send(b"ijklmnop".to_vec()).unwrap(); // total = 16 bytes, hits threshold
                                                // Give batcher a tick to consume + emit
        std::thread::sleep(Duration::from_millis(50));
        let out = emitted.lock().unwrap();
        assert_eq!(out.len(), 1, "expected size-triggered flush");
        assert_eq!(out[0], b"abcdefghijklmnop");
        drop(tx);
        handle.join().unwrap();
    }

    #[test]
    fn batcher_coalesces_multiple_chunks_within_one_interval() {
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let handle = std::thread::spawn(move || {
            run_batcher(rx, Duration::from_millis(30), 4096, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        // Send three small chunks well within one 30ms window
        tx.send(b"a".to_vec()).unwrap();
        tx.send(b"b".to_vec()).unwrap();
        tx.send(b"c".to_vec()).unwrap();
        std::thread::sleep(Duration::from_millis(80));
        drop(tx);
        handle.join().unwrap();
        let out = emitted.lock().unwrap();
        assert_eq!(out.len(), 1, "expected 3 chunks coalesced into 1 event");
        assert_eq!(out[0], b"abc");
    }

    #[test]
    fn batcher_final_flushes_pending_bytes_on_channel_close() {
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let handle = std::thread::spawn(move || {
            // Long interval so only the disconnect can trigger a flush
            run_batcher(rx, Duration::from_secs(3600), 4096, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        tx.send(b"final".to_vec()).unwrap();
        drop(tx); // close the channel immediately
        handle.join().unwrap();
        let out = emitted.lock().unwrap();
        assert_eq!(out.len(), 1, "expected one final flush before exit");
        assert_eq!(out[0], b"final");
    }

    #[test]
    fn batcher_exits_immediately_with_no_data_when_channel_closes() {
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let handle = std::thread::spawn(move || {
            run_batcher(rx, Duration::from_secs(3600), 4096, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        drop(tx);
        handle.join().unwrap();
        assert_eq!(
            emitted.lock().unwrap().len(),
            0,
            "no flush when nothing was sent"
        );
    }

    // ── UTF-8 boundary handling ──────────────────────────────────────────

    #[test]
    fn flushable_prefix_len_handles_boundaries() {
        // All ASCII → whole buffer.
        assert_eq!(flushable_prefix_len(b"abc"), 3);
        // Complete 3-byte char (€ = E2 82 AC) → whole buffer.
        assert_eq!(flushable_prefix_len(&[0xE2, 0x82, 0xAC]), 3);
        // Truncated trailing multibyte → only the valid prefix is flushable.
        assert_eq!(flushable_prefix_len(&[0xE2, 0x82]), 0);
        assert_eq!(flushable_prefix_len(&[b'a', 0xE2, 0x82]), 1);
        // Genuinely invalid byte (not a boundary split) → flush all so we never
        // stall; from_utf8_lossy will replace it downstream.
        assert_eq!(flushable_prefix_len(&[0xFF]), 1);
        assert_eq!(flushable_prefix_len(&[0xFF, b'a']), 2);
    }

    #[test]
    fn batcher_holds_back_split_multibyte_char() {
        // '€' (E2 82 AC) arriving split across two reads must be emitted as one
        // complete character, never corrupted into replacement glyphs.
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let handle = std::thread::spawn(move || {
            run_batcher(rx, Duration::from_millis(20), 4096, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        tx.send(vec![0xE2, 0x82]).unwrap(); // first 2 bytes of '€'
        std::thread::sleep(Duration::from_millis(70)); // interval passes: nothing emittable yet
        assert_eq!(
            emitted.lock().unwrap().len(),
            0,
            "must not emit an incomplete character"
        );
        tx.send(vec![0xAC]).unwrap(); // completing byte
        std::thread::sleep(Duration::from_millis(70));
        drop(tx);
        handle.join().unwrap();
        let out = emitted.lock().unwrap();
        assert_eq!(out.len(), 1, "expected one event with the complete char");
        assert_eq!(out[0], vec![0xE2, 0x82, 0xAC]);
        // And it decodes cleanly with no replacement character.
        assert_eq!(String::from_utf8_lossy(&out[0]), "€");
    }

    #[test]
    fn batcher_flushes_genuinely_invalid_bytes_without_stalling() {
        // A real invalid byte must still be flushed (it can never "complete"),
        // so the pipeline never stalls waiting for it.
        let (tx, rx) = test_mpsc::channel::<Vec<u8>>();
        let emitted: Arc<TestMutex<Vec<Vec<u8>>>> = Arc::new(TestMutex::new(Vec::new()));
        let captured = Arc::clone(&emitted);
        let handle = std::thread::spawn(move || {
            run_batcher(rx, Duration::from_millis(20), 4096, move |c| {
                captured.lock().unwrap().push(c);
            });
        });
        tx.send(vec![0xFF]).unwrap();
        std::thread::sleep(Duration::from_millis(70));
        drop(tx);
        handle.join().unwrap();
        let out = emitted.lock().unwrap();
        assert_eq!(out.len(), 1, "invalid byte must be flushed, not retained");
        assert_eq!(out[0], vec![0xFF]);
    }
}

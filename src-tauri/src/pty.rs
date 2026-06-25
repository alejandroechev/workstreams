use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
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

        let shell = command.unwrap_or("pwsh.exe");
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        if let Some(ref a) = args {
            for arg in a {
                cmd.arg(arg);
            }
        }
        if let Some(env_vars) = env {
            for (k, v) in env_vars {
                cmd.env(k, v);
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

#[cfg(test)]
mod tests {
    use super::*;

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
        mgr.close("nonexistent-tile");
        // Should not panic
        assert!(!mgr.is_active("nonexistent-tile"));
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

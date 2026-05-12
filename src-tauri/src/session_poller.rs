use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Seek, SeekFrom};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionStats {
    pub session_id: String,
    pub session_name: Option<String>,
    pub cwd: Option<String>,
    pub turn_count: i32,
    pub summary: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_turn_at: Option<String>,
    pub activity_status: String, // "thinking" | "tool_use" | "responding" | "idle" | "offline" | "background_task"
    pub current_tool: Option<String>,
    pub process_alive: bool,
}

/// Watched session entry: tile_id, session_name (for DB lookup), optional session_id (for events.jsonl)
struct WatchEntry {
    tile_id: String,
    session_name: String,
    session_id: Option<String>,
    workstream_id: Option<String>,
}

pub struct SessionPoller {
    watched: Mutex<Vec<WatchEntry>>,
}

impl SessionPoller {
    pub fn new() -> Self {
        Self {
            watched: Mutex::new(Vec::new()),
        }
    }

    pub fn watch(&self, tile_id: &str, session_name: &str) {
        let mut watched = self.watched.lock().unwrap();
        watched.retain(|e| e.tile_id != tile_id);
        watched.push(WatchEntry {
            tile_id: tile_id.to_string(),
            session_name: session_name.to_string(),
            session_id: None,
            workstream_id: None,
        });
    }

    /// Register with session_id for direct events.jsonl reading
    pub fn watch_with_id(
        &self,
        tile_id: &str,
        session_name: &str,
        session_id: &str,
        workstream_id: Option<&str>,
    ) {
        let mut watched = self.watched.lock().unwrap();
        watched.retain(|e| e.tile_id != tile_id);
        watched.push(WatchEntry {
            tile_id: tile_id.to_string(),
            session_name: session_name.to_string(),
            session_id: Some(session_id.to_string()),
            workstream_id: workstream_id.map(|s| s.to_string()),
        });
    }

    pub fn unwatch(&self, tile_id: &str) {
        let mut watched = self.watched.lock().unwrap();
        watched.retain(|e| e.tile_id != tile_id);
    }

    fn get_watched(&self) -> Vec<(String, String, Option<String>, Option<String>)> {
        self.watched
            .lock()
            .unwrap()
            .iter()
            .map(|e| {
                (
                    e.tile_id.clone(),
                    e.session_name.clone(),
                    e.session_id.clone(),
                    e.workstream_id.clone(),
                )
            })
            .collect()
    }
}

/// Start the background poller thread
pub fn start_poller(app: AppHandle, poller: Arc<SessionPoller>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(5));

            let watched = poller.get_watched();
            if watched.is_empty() {
                continue;
            }

            let home = match dirs::home_dir() {
                Some(h) => h,
                None => continue,
            };

            // Open session-store.db for turn counts/summary (still useful metadata)
            let db_path = home.join(".copilot").join("session-store.db");
            let conn = if db_path.exists() {
                Connection::open_with_flags(
                    &db_path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .ok()
            } else {
                None
            };

            // Track workstream aggregate status: ws_id -> best_status
            let mut ws_statuses: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();

            for (tile_id, session_name, session_id_opt, ws_id_opt) in &watched {
                // Try events.jsonl approach first if we have a session_id
                let stats = if let Some(sid) = session_id_opt {
                    let session_dir = home.join(".copilot").join("session-state").join(sid);
                    if session_dir.exists() {
                        let events_status = read_events_status(&session_dir);
                        let process_alive = check_process_alive(&session_dir);
                        let db_meta = conn.as_ref().and_then(|c| query_session_meta(c, sid));

                        let activity = if !process_alive {
                            "offline".to_string()
                        } else {
                            events_status.status
                        };

                        Some(SessionStats {
                            session_id: sid.clone(),
                            session_name: Some(session_name.clone()),
                            cwd: db_meta.as_ref().and_then(|m| m.cwd.clone()),
                            turn_count: db_meta.as_ref().map(|m| m.turn_count).unwrap_or(0),
                            summary: db_meta.as_ref().and_then(|m| m.summary.clone()),
                            created_at: db_meta.as_ref().and_then(|m| m.created_at.clone()),
                            updated_at: db_meta.as_ref().and_then(|m| m.updated_at.clone()),
                            last_turn_at: events_status.last_event_at,
                            activity_status: activity,
                            current_tool: events_status.current_tool,
                            process_alive,
                        })
                    } else {
                        // Fall back to DB-only approach
                        conn.as_ref()
                            .and_then(|c| query_session_stats_legacy(c, session_name))
                    }
                } else {
                    // Legacy: no session_id, use DB pattern matching
                    conn.as_ref()
                        .and_then(|c| query_session_stats_legacy(c, session_name))
                };

                if let Some(s) = &stats {
                    let _ = app.emit(&format!("copilot-stats-{tile_id}"), s);

                    // Aggregate for workstream
                    if let Some(ws_id) = ws_id_opt {
                        let current_best = ws_statuses.get(ws_id).cloned().unwrap_or_default();
                        let new_status = &s.activity_status;
                        if status_priority(new_status) > status_priority(&current_best) {
                            ws_statuses.insert(ws_id.clone(), new_status.clone());
                        }
                    }
                }
            }

            // Emit workstream-level status
            for (ws_id, status) in &ws_statuses {
                let _ = app.emit(&format!("workstream-activity-{ws_id}"), status);
            }
        }
    });
}

/// Priority: higher = more "active"
fn status_priority(s: &str) -> u8 {
    match s {
        "thinking" => 5,
        "tool_use" => 5,
        "responding" => 4,
        "background_task" => 3,
        "idle" => 2,
        "offline" => 1,
        _ => 0,
    }
}

// ── Events.jsonl parsing ───────────────────────────────────────────────

struct EventsStatus {
    status: String,
    current_tool: Option<String>,
    last_event_at: Option<String>,
}

fn read_events_status(session_dir: &std::path::Path) -> EventsStatus {
    let events_path = session_dir.join("events.jsonl");
    if !events_path.exists() {
        return EventsStatus {
            status: "idle".into(),
            current_tool: None,
            last_event_at: None,
        };
    }

    // Read last ~30 lines from events.jsonl (tail read)
    let lines = tail_file(&events_path, 30);
    if lines.is_empty() {
        return EventsStatus {
            status: "idle".into(),
            current_tool: None,
            last_event_at: None,
        };
    }

    // Parse events in reverse to find the most recent meaningful state
    let mut status = "idle".to_string();
    let mut current_tool: Option<String> = None;
    let mut last_event_at: Option<String> = None;
    let has_open_turn = false;
    let mut has_background = false;

    for line in lines.iter().rev() {
        let event: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = event.get("timestamp").and_then(|v| v.as_str());

        if last_event_at.is_none() {
            last_event_at = timestamp.map(|s| s.to_string());
        }

        match event_type {
            "tool.execution_start" => {
                let tool_name = event
                    .get("data")
                    .and_then(|d| d.get("toolName"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                status = "tool_use".into();
                current_tool = tool_name;
                break;
            }
            "tool.execution_complete" => {
                // Tool finished — agent is thinking about result
                if has_open_turn {
                    status = "thinking".into();
                }
                break;
            }
            "assistant.turn_start" => {
                status = "thinking".into();
                break;
            }
            "assistant.turn_end" => {
                status = "idle".into();
                break;
            }
            "assistant.message" => {
                let has_tools = event
                    .get("data")
                    .and_then(|d| d.get("toolRequests"))
                    .and_then(|v| v.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(false);
                if has_tools {
                    // Tool request emitted, about to execute
                    let tool_name = event
                        .get("data")
                        .and_then(|d| d.get("toolRequests"))
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|t| t.get("name"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    status = "tool_use".into();
                    current_tool = tool_name;
                } else {
                    status = "responding".into();
                }
                break;
            }
            "user.message" => {
                status = "thinking".into();
                break;
            }
            "subagent.started" => {
                has_background = true;
                status = "background_task".into();
                break;
            }
            "subagent.completed" => {
                // Sub-agent done — probably thinking
                if has_open_turn {
                    status = "thinking".into();
                }
                break;
            }
            "session.task_complete" | "session.shutdown" => {
                status = "idle".into();
                break;
            }
            "session.error" => {
                status = "idle".into();
                break;
            }
            "hook.start" | "hook.end" => {
                // Hooks are transient — keep looking
                continue;
            }
            _ => continue,
        }
    }

    // If we found background activity but main status is idle, show background
    if has_background && status == "idle" {
        status = "background_task".into();
    }

    EventsStatus {
        status,
        current_tool,
        last_event_at,
    }
}

/// Read last N lines from a file efficiently
pub fn tail_file(path: &std::path::Path, n: usize) -> Vec<String> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return Vec::new(),
    };

    // Read last 32KB (enough for ~30 events)
    let read_size = std::cmp::min(file_len, 32768) as usize;
    let mut reader = std::io::BufReader::new(file);
    if file_len > read_size as u64 {
        let _ = reader.seek(SeekFrom::End(-(read_size as i64)));
        // Skip partial first line
        let mut skip = String::new();
        let _ = reader.read_line(&mut skip);
    }

    let mut lines = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }

    // Keep only last N
    if lines.len() > n {
        lines.drain(..lines.len() - n);
    }
    lines
}

// ── Process liveness check via lock files ──────────────────────────────

fn check_process_alive(session_dir: &std::path::Path) -> bool {
    // Look for inuse.*.lock files
    let entries = match std::fs::read_dir(session_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("inuse.") && name.ends_with(".lock") {
            // Extract PID: "inuse.12345.lock"
            let pid_str = name
                .strip_prefix("inuse.")
                .and_then(|s| s.strip_suffix(".lock"));
            if let Some(pid_str) = pid_str {
                if let Ok(pid) = pid_str.parse::<u32>() {
                    return is_pid_alive(pid);
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn is_pid_alive(pid: u32) -> bool {
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    unsafe {
        let handle = windows_sys::Win32::System::Threading::OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        );
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let ok = windows_sys::Win32::System::Threading::GetExitCodeProcess(handle, &mut exit_code);
        windows_sys::Win32::Foundation::CloseHandle(handle);
        ok != 0 && exit_code == STILL_ACTIVE
    }
}

#[cfg(not(windows))]
fn is_pid_alive(pid: u32) -> bool {
    // On Unix, signal 0 checks existence
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

// ── Session metadata from session-store.db ─────────────────────────────

struct SessionMeta {
    cwd: Option<String>,
    turn_count: i32,
    summary: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

fn query_session_meta(conn: &Connection, session_id: &str) -> Option<SessionMeta> {
    let mut stmt = conn
        .prepare("SELECT cwd, summary, created_at, updated_at FROM sessions WHERE id = ?1")
        .ok()?;

    let result = stmt
        .query_row([session_id], |row| {
            Ok(SessionMeta {
                cwd: row.get(0)?,
                summary: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                turn_count: 0,
            })
        })
        .ok()?;

    let turn_count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM turns WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Some(SessionMeta {
        turn_count,
        ..result
    })
}

/// Legacy: find session by name pattern (for tiles without session_id)
fn query_session_stats_legacy(conn: &Connection, session_name: &str) -> Option<SessionStats> {
    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, summary, created_at, updated_at
             FROM sessions
             WHERE summary LIKE ?1 OR cwd LIKE ?2
             ORDER BY updated_at DESC
             LIMIT 1",
        )
        .ok()?;

    let name_pattern = format!("%{session_name}%");
    let result = stmt
        .query_row([&name_pattern, &name_pattern], |row| {
            let session_id: String = row.get(0)?;
            let cwd: Option<String> = row.get(1)?;
            let summary: Option<String> = row.get(2)?;
            let created_at: Option<String> = row.get(3)?;
            let updated_at: Option<String> = row.get(4)?;
            Ok((session_id, cwd, summary, created_at, updated_at))
        })
        .ok()?;

    let turn_count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM turns WHERE session_id = ?1",
            [&result.0],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let last_turn_at: Option<String> = conn
        .query_row(
            "SELECT timestamp FROM turns WHERE session_id = ?1 ORDER BY turn_index DESC LIMIT 1",
            [&result.0],
            |row| row.get(0),
        )
        .ok();

    // Check events.jsonl for this session too
    let home = dirs::home_dir()?;
    let session_dir = home.join(".copilot").join("session-state").join(&result.0);
    let events_status = if session_dir.exists() {
        let es = read_events_status(&session_dir);
        let alive = check_process_alive(&session_dir);
        if !alive {
            "offline".to_string()
        } else {
            es.status
        }
    } else {
        "idle".to_string()
    };

    Some(SessionStats {
        session_id: result.0,
        session_name: Some(session_name.to_string()),
        cwd: result.1,
        turn_count,
        summary: result.2,
        created_at: result.3,
        updated_at: result.4,
        last_turn_at,
        activity_status: events_status,
        current_tool: None,
        process_alive: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn status_priority_ranks_active_above_idle() {
        assert!(status_priority("thinking") > status_priority("idle"));
        assert!(status_priority("tool_use") > status_priority("idle"));
        assert!(status_priority("responding") > status_priority("background_task"));
        assert!(status_priority("background_task") > status_priority("idle"));
        assert!(status_priority("idle") > status_priority("offline"));
        assert_eq!(status_priority("unknown"), 0);
    }

    #[test]
    fn status_priority_thinking_and_tool_use_tied() {
        assert_eq!(status_priority("thinking"), status_priority("tool_use"));
    }

    #[test]
    fn tail_file_reads_last_n_lines() {
        let tmp = std::env::temp_dir().join(format!("ws_tail_test_{}.txt", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            for i in 0..50 {
                writeln!(f, "line {i}").unwrap();
            }
        }
        let lines = tail_file(&tmp, 5);
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[4], "line 49");
        assert_eq!(lines[0], "line 45");
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn tail_file_returns_empty_for_missing_file() {
        let lines = tail_file(std::path::Path::new("/nonexistent/path/file.txt"), 10);
        assert_eq!(lines.len(), 0);
    }

    #[test]
    fn tail_file_handles_small_file_with_large_n() {
        let tmp = std::env::temp_dir().join(format!("ws_tail_small_{}.txt", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            writeln!(f, "only line").unwrap();
        }
        let lines = tail_file(&tmp, 100);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "only line");
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn read_events_status_returns_idle_for_missing_file() {
        let tmp = std::env::temp_dir().join(format!("ws_events_empty_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let status = read_events_status(&tmp);
        assert_eq!(status.status, "idle");
        assert!(status.current_tool.is_none());
        assert!(status.last_event_at.is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_events_status_detects_tool_use() {
        let tmp = std::env::temp_dir().join(format!("ws_events_tool_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let events_path = tmp.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant.turn_start","timestamp":"2026-01-01T00:00:00Z"}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:01Z","data":{{"toolName":"powershell"}}}}"#).unwrap();
        drop(f);
        let status = read_events_status(&tmp);
        assert_eq!(status.status, "tool_use");
        assert_eq!(status.current_tool, Some("powershell".to_string()));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_events_status_detects_idle_on_turn_end() {
        let tmp = std::env::temp_dir().join(format!("ws_events_idle_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let events_path = tmp.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant.turn_end","timestamp":"2026-01-01T00:00:00Z"}}"#
        )
        .unwrap();
        drop(f);
        let status = read_events_status(&tmp);
        assert_eq!(status.status, "idle");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_events_status_detects_responding() {
        let tmp = std::env::temp_dir().join(format!("ws_events_resp_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let events_path = tmp.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"assistant.message","timestamp":"2026-01-01T00:00:00Z","data":{{}}}}"#
        )
        .unwrap();
        drop(f);
        let status = read_events_status(&tmp);
        assert_eq!(status.status, "responding");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_events_status_detects_thinking_from_user_message() {
        let tmp = std::env::temp_dir().join(format!("ws_events_user_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let events_path = tmp.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"user.message","timestamp":"2026-01-01T00:00:00Z"}}"#
        )
        .unwrap();
        drop(f);
        let status = read_events_status(&tmp);
        assert_eq!(status.status, "thinking");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_events_status_detects_background_task() {
        let tmp = std::env::temp_dir().join(format!("ws_events_bg_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let events_path = tmp.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"subagent.started","timestamp":"2026-01-01T00:00:00Z"}}"#
        )
        .unwrap();
        drop(f);
        let status = read_events_status(&tmp);
        assert_eq!(status.status, "background_task");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_events_status_skips_hook_events() {
        let tmp = std::env::temp_dir().join(format!("ws_events_hook_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let events_path = tmp.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(f, r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:00Z","data":{{"toolName":"grep"}}}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"hook.start","timestamp":"2026-01-01T00:00:01Z"}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"hook.end","timestamp":"2026-01-01T00:00:02Z"}}"#
        )
        .unwrap();
        drop(f);
        let status = read_events_status(&tmp);
        // Should find tool_use (skipping hooks)
        assert_eq!(status.status, "tool_use");
        assert_eq!(status.current_tool, Some("grep".to_string()));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn check_process_alive_returns_false_for_no_lock_files() {
        let tmp = std::env::temp_dir().join(format!("ws_lock_empty_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        assert!(!check_process_alive(&tmp));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn check_process_alive_returns_false_for_dead_pid() {
        let tmp = std::env::temp_dir().join(format!("ws_lock_dead_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        // PID 1 is unlikely to be a running copilot process on Windows
        // PID 99999999 is definitely dead
        std::fs::write(tmp.join("inuse.99999999.lock"), "").ok();
        assert!(!check_process_alive(&tmp));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn check_process_alive_detects_running_process() {
        let tmp = std::env::temp_dir().join(format!("ws_lock_alive_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).ok();
        let my_pid = std::process::id();
        std::fs::write(tmp.join(format!("inuse.{my_pid}.lock")), "").ok();
        assert!(check_process_alive(&tmp));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn session_poller_watch_and_unwatch() {
        let poller = SessionPoller::new();
        poller.watch("tile1", "session1");
        let watched = poller.get_watched();
        assert_eq!(watched.len(), 1);
        assert_eq!(watched[0].0, "tile1");
        poller.unwatch("tile1");
        assert_eq!(poller.get_watched().len(), 0);
    }

    #[test]
    fn session_poller_watch_with_id_includes_ids() {
        let poller = SessionPoller::new();
        poller.watch_with_id("tile1", "session1", "sid-abc", Some("ws-123"));
        let watched = poller.get_watched();
        assert_eq!(watched[0].2, Some("sid-abc".to_string()));
        assert_eq!(watched[0].3, Some("ws-123".to_string()));
    }

    #[test]
    fn session_poller_watch_replaces_existing_tile() {
        let poller = SessionPoller::new();
        poller.watch("tile1", "session1");
        poller.watch("tile1", "session2"); // replaces
        let watched = poller.get_watched();
        assert_eq!(watched.len(), 1);
        assert_eq!(watched[0].1, "session2");
    }
}

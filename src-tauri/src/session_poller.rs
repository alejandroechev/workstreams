use rusqlite::Connection;
use serde::{Deserialize, Serialize};
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
}

/// Active tile-to-session mappings tracked by the poller
pub struct SessionPoller {
    /// Map of tile_id -> session_name to watch
    watched: Mutex<Vec<(String, String)>>,
}

impl SessionPoller {
    pub fn new() -> Self {
        Self {
            watched: Mutex::new(Vec::new()),
        }
    }

    /// Register a tile to watch for session stats
    pub fn watch(&self, tile_id: &str, session_name: &str) {
        let mut watched = self.watched.lock().unwrap();
        // Remove existing entry for this tile
        watched.retain(|(tid, _)| tid != tile_id);
        watched.push((tile_id.to_string(), session_name.to_string()));
    }

    /// Stop watching a tile
    pub fn unwatch(&self, tile_id: &str) {
        let mut watched = self.watched.lock().unwrap();
        watched.retain(|(tid, _)| tid != tile_id);
    }

    /// Get current watched tiles
    fn get_watched(&self) -> Vec<(String, String)> {
        self.watched.lock().unwrap().clone()
    }
}

/// Start the background poller thread
pub fn start_poller(app: AppHandle, poller: Arc<SessionPoller>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(10));

            let watched = poller.get_watched();
            if watched.is_empty() {
                continue;
            }

            // Try to open session-store.db
            let home = match dirs::home_dir() {
                Some(h) => h,
                None => continue,
            };
            let db_path = home.join(".copilot").join("session-store.db");
            if !db_path.exists() {
                continue;
            }

            let conn = match Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                Ok(c) => c,
                Err(_) => continue,
            };

            for (tile_id, session_name) in &watched {
                // Try to find session by summary/name match or by cwd
                let stats = query_session_stats(&conn, session_name);
                if let Some(s) = stats {
                    let _ = app.emit(&format!("copilot-stats-{tile_id}"), s);
                }
            }
        }
    });
}

fn query_session_stats(conn: &Connection, session_name: &str) -> Option<SessionStats> {
    // First try matching by summary containing the session name
    // Then fall back to most recent session
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

    // Count turns for this session
    let turn_count: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM turns WHERE session_id = ?1",
            [&result.0],
            |row| row.get(0),
        )
        .unwrap_or(0);

    Some(SessionStats {
        session_id: result.0,
        session_name: Some(session_name.to_string()),
        cwd: result.1,
        turn_count,
        summary: result.2,
        created_at: result.3,
        updated_at: result.4,
    })
}

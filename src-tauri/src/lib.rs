mod db;
mod pty;
mod session_poller;

use db::open_db;
use pty::PtyManager;
use session_poller::SessionPoller;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

// ── Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub directory: String,
    pub git_remote: Option<String>,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workstream {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub directory: Option<String>,
    pub git_repo: Option<String>,
    pub git_branch: Option<String>,
    pub status: String,
    pub project_id: Option<String>,
    pub workstream_type: String,
    pub worktree_branch: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tile {
    pub id: String,
    pub workstream_id: String,
    pub tile_type: String,
    pub title: Option<String>,
    pub config_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkstreamLayout {
    pub workstream_id: String,
    pub layout_mode: String,
    pub focused_tile_id: Option<String>,
    pub fullscreen_tile_id: Option<String>,
    pub tile_order_json: String,
    pub updated_at: String,
}

struct AppState {
    db: Mutex<Connection>,
    pty: PtyManager,
    session_poller: Arc<SessionPoller>,
}

fn now() -> String {
    // Simple ISO-ish timestamp
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{t}")
}

// ── Project Commands ──────────────────────────────────────────────────

#[tauri::command]
fn create_project(
    state: State<'_, AppState>,
    name: String,
    directory: String,
    color: Option<String>,
) -> Result<Project, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let c = color.unwrap_or_else(|| "#89b4fa".into());
    let db = state.db.lock().unwrap();

    // Auto-detect git remote
    let git_remote = detect_git_remote(&directory);

    db.execute(
        "INSERT INTO projects (id, name, directory, git_remote, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        (&id, &name, &directory, &git_remote, &c, &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    Ok(Project {
        id,
        name,
        directory,
        git_remote,
        color: c,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT id, name, directory, git_remote, color, created_at, updated_at FROM projects ORDER BY name")
        .map_err(|e| format!("DB error: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                directory: row.get(2)?,
                git_remote: row.get(3)?,
                color: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("DB error: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
fn update_project(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let ts = now();
    if let Some(n) = name {
        db.execute("UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3", (&n, &ts, &id))
            .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(c) = color {
        db.execute("UPDATE projects SET color = ?1, updated_at = ?2 WHERE id = ?3", (&c, &ts, &id))
            .map_err(|e| format!("DB error: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    // Unlink workstreams first (don't delete them)
    db.execute("UPDATE workstreams SET project_id = NULL WHERE project_id = ?1", [&id])
        .map_err(|e| format!("DB error: {e}"))?;
    db.execute("DELETE FROM projects WHERE id = ?1", [&id])
        .map_err(|e| format!("DB error: {e}"))?;
    Ok(())
}

/// Detect git remote URL from a directory
fn detect_git_remote(directory: &str) -> Option<String> {
    let git_config = std::path::Path::new(directory).join(".git").join("config");
    let content = std::fs::read_to_string(git_config).ok()?;
    // Simple parse: find [remote "origin"] section and extract url
    let mut in_origin = false;
    for line in content.lines() {
        if line.trim() == "[remote \"origin\"]" {
            in_origin = true;
            continue;
        }
        if in_origin {
            if line.starts_with('[') {
                break;
            }
            if let Some(url) = line.trim().strip_prefix("url = ") {
                return Some(url.to_string());
            }
        }
    }
    None
}

// ── Workstream Commands ────────────────────────────────────────────────

#[tauri::command]
fn create_workstream(
    state: State<'_, AppState>,
    name: String,
    directory: Option<String>,
    description: Option<String>,
    project_id: Option<String>,
    workstream_type: Option<String>,
    worktree_branch: Option<String>,
) -> Result<Workstream, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let ws_type = workstream_type.unwrap_or_else(|| "standalone".into());
    let db = state.db.lock().unwrap();

    db.execute(
        "INSERT INTO workstreams (id, name, description, directory, status, project_id, workstream_type, worktree_branch, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ?8)",
        (&id, &name, &description, &directory, &project_id, &ws_type, &worktree_branch, &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    // Create default layout
    db.execute(
        "INSERT INTO workstream_layouts (workstream_id, layout_mode, tile_order_json, updated_at)
         VALUES (?1, 'adaptive', '[]', ?2)",
        (&id, &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    Ok(Workstream {
        id,
        name,
        description,
        directory,
        git_repo: None,
        git_branch: None,
        status: "active".into(),
        project_id,
        workstream_type: ws_type,
        worktree_branch,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
fn list_workstreams(state: State<'_, AppState>) -> Result<Vec<Workstream>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT id, name, description, directory, git_repo, git_branch, status,
                    project_id, workstream_type, worktree_branch, created_at, updated_at
             FROM workstreams WHERE status != 'archived' ORDER BY created_at DESC",
        )
        .map_err(|e| format!("DB error: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Workstream {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                directory: row.get(3)?,
                git_repo: row.get(4)?,
                git_branch: row.get(5)?,
                status: row.get(6)?,
                project_id: row.get(7)?,
                workstream_type: row.get(8)?,
                worktree_branch: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(|e| format!("DB error: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
fn update_workstream(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    status: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let ts = now();
    if let Some(n) = name {
        db.execute(
            "UPDATE workstreams SET name = ?1, updated_at = ?2 WHERE id = ?3",
            (&n, &ts, &id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(s) = status {
        db.execute(
            "UPDATE workstreams SET status = ?1, updated_at = ?2 WHERE id = ?3",
            (&s, &ts, &id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(d) = description {
        db.execute(
            "UPDATE workstreams SET description = ?1, updated_at = ?2 WHERE id = ?3",
            (&d, &ts, &id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_workstream(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Close any active PTYs for this workstream's tiles
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare("SELECT id FROM tiles WHERE workstream_id = ?1 AND tile_type = 'terminal'")
        .map_err(|e| format!("DB error: {e}"))?;
    let tile_ids: Vec<String> = stmt
        .query_map([&id], |row| row.get(0))
        .map_err(|e| format!("DB error: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    for tid in &tile_ids {
        state.pty.close(tid);
    }

    db.execute("DELETE FROM workstreams WHERE id = ?1", [&id])
        .map_err(|e| format!("DB error: {e}"))?;
    Ok(())
}

// ── Tile Commands ──────────────────────────────────────────────────────

#[tauri::command]
fn create_tile(
    state: State<'_, AppState>,
    workstream_id: String,
    tile_type: String,
    title: Option<String>,
    config_json: Option<String>,
) -> Result<Tile, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    let config = config_json.unwrap_or_else(|| "{}".into());
    let db = state.db.lock().unwrap();

    db.execute(
        "INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        (&id, &workstream_id, &tile_type, &title, &config, &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    // Add to layout tile order
    let mut order: Vec<String> = {
        let order_json: String = db
            .query_row(
                "SELECT tile_order_json FROM workstream_layouts WHERE workstream_id = ?1",
                [&workstream_id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&order_json).unwrap_or_default()
    };
    order.push(id.clone());
    let new_order = serde_json::to_string(&order).unwrap();
    db.execute(
        "UPDATE workstream_layouts SET tile_order_json = ?1, updated_at = ?2 WHERE workstream_id = ?3",
        (&new_order, &ts, &workstream_id),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    Ok(Tile {
        id,
        workstream_id,
        tile_type,
        title,
        config_json: config,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
fn list_tiles(state: State<'_, AppState>, workstream_id: String) -> Result<Vec<Tile>, String> {
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT id, workstream_id, tile_type, title, config_json, created_at, updated_at
             FROM tiles WHERE workstream_id = ?1",
        )
        .map_err(|e| format!("DB error: {e}"))?;

    let rows = stmt
        .query_map([&workstream_id], |row| {
            Ok(Tile {
                id: row.get(0)?,
                workstream_id: row.get(1)?,
                tile_type: row.get(2)?,
                title: row.get(3)?,
                config_json: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("DB error: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
fn delete_tile(state: State<'_, AppState>, tile_id: String) -> Result<(), String> {
    state.pty.close(&tile_id);
    let db = state.db.lock().unwrap();

    // Remove from layout order
    let ws_id: Option<String> = db
        .query_row(
            "SELECT workstream_id FROM tiles WHERE id = ?1",
            [&tile_id],
            |row| row.get(0),
        )
        .ok();

    db.execute("DELETE FROM tiles WHERE id = ?1", [&tile_id])
        .map_err(|e| format!("DB error: {e}"))?;

    if let Some(ws_id) = ws_id {
        let ts = now();
        let order_json: String = db
            .query_row(
                "SELECT tile_order_json FROM workstream_layouts WHERE workstream_id = ?1",
                [&ws_id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "[]".into());
        let mut order: Vec<String> = serde_json::from_str(&order_json).unwrap_or_default();
        order.retain(|id| id != &tile_id);
        let new_order = serde_json::to_string(&order).unwrap();
        db.execute(
            "UPDATE workstream_layouts SET tile_order_json = ?1, updated_at = ?2 WHERE workstream_id = ?3",
            (&new_order, &ts, &ws_id),
        )
        .ok();
    }

    Ok(())
}

// ── Layout Commands ────────────────────────────────────────────────────

#[tauri::command]
fn get_layout(state: State<'_, AppState>, workstream_id: String) -> Result<WorkstreamLayout, String> {
    let db = state.db.lock().unwrap();
    db.query_row(
        "SELECT workstream_id, layout_mode, focused_tile_id, fullscreen_tile_id, tile_order_json, updated_at
         FROM workstream_layouts WHERE workstream_id = ?1",
        [&workstream_id],
        |row| {
            Ok(WorkstreamLayout {
                workstream_id: row.get(0)?,
                layout_mode: row.get(1)?,
                focused_tile_id: row.get(2)?,
                fullscreen_tile_id: row.get(3)?,
                tile_order_json: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    )
    .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
fn update_layout(
    state: State<'_, AppState>,
    workstream_id: String,
    focused_tile_id: Option<String>,
    fullscreen_tile_id: Option<String>,
    tile_order_json: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let ts = now();
    if let Some(f) = &focused_tile_id {
        db.execute(
            "UPDATE workstream_layouts SET focused_tile_id = ?1, updated_at = ?2 WHERE workstream_id = ?3",
            (f, &ts, &workstream_id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(f) = &fullscreen_tile_id {
        let val: Option<&str> = if f.is_empty() { None } else { Some(f) };
        db.execute(
            "UPDATE workstream_layouts SET fullscreen_tile_id = ?1, updated_at = ?2 WHERE workstream_id = ?3",
            (&val, &ts, &workstream_id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(o) = &tile_order_json {
        db.execute(
            "UPDATE workstream_layouts SET tile_order_json = ?1, updated_at = ?2 WHERE workstream_id = ?3",
            (o, &ts, &workstream_id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    Ok(())
}

// ── PTY Commands ───────────────────────────────────────────────────────

#[tauri::command]
fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    tile_id: String,
    cwd: String,
    command: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<Option<u32>, String> {
    state.pty.spawn(
        &app,
        &tile_id,
        &cwd,
        command.as_deref(),
        rows.unwrap_or(30),
        cols.unwrap_or(120),
    )
}

#[tauri::command]
fn write_to_pty(state: State<'_, AppState>, tile_id: String, data: String) -> Result<(), String> {
    state.pty.write(&tile_id, data.as_bytes())
}

#[tauri::command]
fn resize_pty(
    state: State<'_, AppState>,
    tile_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    state.pty.resize(&tile_id, rows, cols)
}

#[tauri::command]
fn close_terminal(state: State<'_, AppState>, tile_id: String) -> Result<(), String> {
    state.pty.close(&tile_id);
    Ok(())
}

// ── Scrollback Commands ────────────────────────────────────────────────

#[tauri::command]
fn save_scrollback(
    state: State<'_, AppState>,
    tile_id: String,
    scrollback: String,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let ts = now();
    db.execute(
        "INSERT OR REPLACE INTO terminal_scrollback (tile_id, scrollback_blob, encoding, saved_at)
         VALUES (?1, ?2, 'plain', ?3)",
        (&tile_id, scrollback.as_bytes(), &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;
    Ok(())
}

#[tauri::command]
fn load_scrollback(state: State<'_, AppState>, tile_id: String) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    let result: Result<Vec<u8>, _> = db.query_row(
        "SELECT scrollback_blob FROM terminal_scrollback WHERE tile_id = ?1",
        [&tile_id],
        |row| row.get(0),
    );
    match result {
        Ok(blob) => Ok(Some(String::from_utf8_lossy(&blob).to_string())),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("DB error: {e}")),
    }
}

// ── Session Enrichment ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CopilotSessionInfo {
    pub session_id: String,
    pub cwd: Option<String>,
    pub repository: Option<String>,
    pub branch: Option<String>,
    pub summary: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Read Copilot CLI session-store.db for enrichment data
#[tauri::command]
fn get_copilot_sessions(limit: Option<u32>) -> Result<Vec<CopilotSessionInfo>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let db_path = home.join(".copilot").join("session-store.db");
    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("Cannot read session-store.db: {e}"))?;

    let lim = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, repository, branch, summary, created_at, updated_at
             FROM sessions ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| format!("Query error: {e}"))?;

    let rows = stmt
        .query_map([lim], |row| {
            Ok(CopilotSessionInfo {
                session_id: row.get(0)?,
                cwd: row.get(1)?,
                repository: row.get(2)?,
                branch: row.get(3)?,
                summary: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| format!("Query error: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Query error: {e}"))
}

/// Link a tile to a Copilot CLI session (best-effort match)
#[tauri::command]
fn link_copilot_session(
    state: State<'_, AppState>,
    tile_id: String,
    copilot_session_id: String,
    context_percent: Option<f64>,
    turn_count: Option<i32>,
    summary: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let ts = now();
    db.execute(
        "INSERT OR REPLACE INTO copilot_session_links (tile_id, copilot_session_id, context_percent, turn_count, summary, linked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (&tile_id, &copilot_session_id, &context_percent, &turn_count, &summary, &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;
    Ok(())
}

/// Get Copilot session link for a tile
#[tauri::command]
fn get_copilot_link(state: State<'_, AppState>, tile_id: String) -> Result<Option<CopilotSessionInfo>, String> {
    let db = state.db.lock().unwrap();
    let result = db.query_row(
        "SELECT copilot_session_id, context_percent, turn_count, summary, linked_at
         FROM copilot_session_links WHERE tile_id = ?1",
        [&tile_id],
        |row| {
            Ok(CopilotSessionInfo {
                session_id: row.get(0)?,
                cwd: None,
                repository: None,
                branch: None,
                summary: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: None,
            })
        },
    );
    match result {
        Ok(info) => Ok(Some(info)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("DB error: {e}")),
    }
}

// ── Session Poller Commands ────────────────────────────────────────────

/// Register a copilot session tile for stats polling
#[tauri::command]
fn watch_session(state: State<'_, AppState>, tile_id: String, session_name: String) -> Result<(), String> {
    state.session_poller.watch(&tile_id, &session_name);
    Ok(())
}

/// Stop watching a copilot session tile
#[tauri::command]
fn unwatch_session(state: State<'_, AppState>, tile_id: String) -> Result<(), String> {
    state.session_poller.unwatch(&tile_id);
    Ok(())
}

// ── File System Commands ───────────────────────────────────────────────

/// Read a file's content for the code viewer
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file: {e}"))
}

/// List files in a directory (non-recursive, for file picker)
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("Cannot read dir: {e}"))?;
    let mut files: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            let prefix = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                "📁 "
            } else {
                "   "
            };
            files.push(format!("{prefix}{name}"));
        }
    }
    files.sort();
    Ok(files)
}

/// Recursively search for files matching a query (case-insensitive filename match)
#[tauri::command]
fn search_files(directory: String, query: String, limit: Option<u32>) -> Result<Vec<String>, String> {
    use std::collections::VecDeque;

    let max = limit.unwrap_or(50) as usize;
    let query_lower = query.to_lowercase();
    let skip_dirs: std::collections::HashSet<&str> =
        ["node_modules", "target", ".git", "dist", ".next", "__pycache__"].into();

    let mut results = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(std::path::PathBuf::from(&directory));

    while let Some(dir) = queue.pop_front() {
        if results.len() >= max {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if results.len() >= max {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if path.is_dir() {
                if !skip_dirs.contains(name_str.as_ref()) {
                    queue.push_back(path);
                }
            } else if name_str.to_lowercase().contains(&query_lower) {
                results.push(path.to_string_lossy().to_string());
            }
        }
    }
    Ok(results)
}

/// Get list of changed files for a diff mode
#[tauri::command]
fn git_diff_files(directory: String, mode: String) -> Result<Vec<String>, String> {
    let args: Vec<&str> = match mode.as_str() {
        "unstaged" => vec!["diff", "--name-only"],
        "last_commit" => vec!["diff", "HEAD~1", "--name-only"],
        "branch_vs_master" => {
            // Try master first, fall back to main
            let output = std::process::Command::new("git")
                .args(["diff", "master...HEAD", "--name-only"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                return Ok(stdout.lines().filter(|l| !l.is_empty()).map(|l| l.to_string()).collect());
            }
            // Fallback to main
            vec!["diff", "main...HEAD", "--name-only"]
        }
        _ => return Err(format!("Unknown diff mode: {mode}")),
    };

    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// Get diff content for a specific file
#[tauri::command]
fn git_diff_file(directory: String, file_path: String, mode: String) -> Result<String, String> {
    let base_args: Vec<&str> = match mode.as_str() {
        "unstaged" => vec!["diff"],
        "last_commit" => vec!["diff", "HEAD~1"],
        "branch_vs_master" => {
            // Try master, fallback to main
            let mut args = vec!["diff", "master...HEAD", "--", &file_path];
            let output = std::process::Command::new("git")
                .args(&args)
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            args = vec!["diff", "main...HEAD", "--", &file_path];
            let output2 = std::process::Command::new("git")
                .args(&args)
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            return Ok(String::from_utf8_lossy(&output2.stdout).to_string());
        }
        _ => return Err(format!("Unknown diff mode: {mode}")),
    };
    let mut args = base_args;
    args.push("--");
    args.push(&file_path);

    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Detect git repo info from a directory
#[tauri::command]
fn detect_git_info(directory: String) -> Result<(Option<String>, Option<String>), String> {
    let dir = std::path::Path::new(&directory);

    // Find .git directory by walking up
    let mut current = Some(dir);
    let mut git_dir = None;
    while let Some(d) = current {
        let candidate = d.join(".git");
        if candidate.exists() {
            git_dir = Some(d.to_path_buf());
            break;
        }
        current = d.parent();
    }

    let repo_root = match git_dir {
        Some(r) => r,
        None => return Ok((None, None)),
    };

    // Get repo name from directory name
    let repo_name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());

    // Get branch from HEAD
    let head_path = repo_root.join(".git").join("HEAD");
    let branch = std::fs::read_to_string(head_path)
        .ok()
        .and_then(|content| {
            content
                .strip_prefix("ref: refs/heads/")
                .map(|b| b.trim().to_string())
        });

    Ok((repo_name, branch))
}

/// Detect if a directory is a git worktree and return parent repo info
#[derive(Debug, Serialize, Deserialize)]
struct WorktreeInfo {
    is_worktree: bool,
    parent_repo_path: Option<String>,
    parent_repo_name: Option<String>,
    branch: Option<String>,
    git_remote: Option<String>,
}

#[tauri::command]
fn detect_worktree_info(directory: String) -> Result<WorktreeInfo, String> {
    let dir = std::path::Path::new(&directory);
    let git_path = dir.join(".git");

    // In a worktree, .git is a FILE containing "gitdir: /path/to/main/.git/worktrees/<name>"
    // In a normal repo, .git is a DIRECTORY
    if git_path.is_file() {
        let content = std::fs::read_to_string(&git_path)
            .map_err(|e| format!("Cannot read .git: {e}"))?;
        if let Some(gitdir) = content.trim().strip_prefix("gitdir: ") {
            // Parse parent repo from gitdir path
            // e.g., "C:/repos/myproject/.git/worktrees/my-worktree"
            let gitdir_path = std::path::Path::new(gitdir);
            // Walk up to find the .git directory (parent of "worktrees/<name>")
            let mut parent = gitdir_path;
            while let Some(p) = parent.parent() {
                if p.file_name().map(|n| n == ".git").unwrap_or(false) {
                    let repo_root = p.parent();
                    if let Some(root) = repo_root {
                        let repo_name = root.file_name()
                            .and_then(|n| n.to_str())
                            .map(|s| s.to_string());
                        let remote = detect_git_remote(&root.to_string_lossy());
                        let branch = std::process::Command::new("git")
                            .args(["branch", "--show-current"])
                            .current_dir(&directory)
                            .output()
                            .ok()
                            .and_then(|o| String::from_utf8(o.stdout).ok())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty());

                        return Ok(WorktreeInfo {
                            is_worktree: true,
                            parent_repo_path: Some(root.to_string_lossy().to_string()),
                            parent_repo_name: repo_name,
                            branch,
                            git_remote: remote,
                        });
                    }
                }
                parent = p;
            }
        }
    }

    // Not a worktree — check if it's a normal git repo
    if git_path.is_dir() {
        let repo_name = dir.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        let branch = std::process::Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(&directory)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let remote = detect_git_remote(&directory);

        return Ok(WorktreeInfo {
            is_worktree: false,
            parent_repo_path: Some(directory),
            parent_repo_name: repo_name,
            branch,
            git_remote: remote,
        });
    }

    Ok(WorktreeInfo {
        is_worktree: false,
        parent_repo_path: None,
        parent_repo_name: None,
        branch: None,
        git_remote: None,
    })
}

// ── App Setup ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("copilot-desktop")
        .join("copilot-desktop.db");

    let conn = open_db(&db_path).expect("Failed to initialize database");

    let poller = Arc::new(SessionPoller::new());

    let app_state = AppState {
        db: Mutex::new(conn),
        pty: PtyManager::new(),
        session_poller: poller.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            // Start the session stats poller background thread
            session_poller::start_poller(app.handle().clone(), poller);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Projects
            create_project,
            list_projects,
            update_project,
            delete_project,
            // Workstream
            create_workstream,
            list_workstreams,
            update_workstream,
            delete_workstream,
            // Tiles
            create_tile,
            list_tiles,
            delete_tile,
            // Layout
            get_layout,
            update_layout,
            // PTY
            spawn_terminal,
            write_to_pty,
            resize_pty,
            close_terminal,
            // Scrollback
            save_scrollback,
            load_scrollback,
            // Session enrichment
            get_copilot_sessions,
            link_copilot_session,
            get_copilot_link,
            // Session poller
            watch_session,
            unwatch_session,
            // File system
            read_file,
            list_directory,
            detect_git_info,
            detect_worktree_info,
            search_files,
            // Git diff
            git_diff_files,
            git_diff_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                state.pty.close_all();
            }
        });
}

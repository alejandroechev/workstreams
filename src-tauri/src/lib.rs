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
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{t}")
}

/// Create a git Command that doesn't show a console window on Windows
fn git_cmd() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
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

#[tauri::command]
fn update_tile_config(
    state: State<'_, AppState>,
    tile_id: String,
    config_json: String,
    title: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let ts = now();
    db.execute(
        "UPDATE tiles SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
        (&config_json, &ts, &tile_id),
    ).map_err(|e| format!("DB error: {e}"))?;
    if let Some(t) = title {
        db.execute("UPDATE tiles SET title = ?1 WHERE id = ?2", (&t, &tile_id))
            .map_err(|e| format!("DB error: {e}"))?;
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
    args: Option<Vec<String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<Option<u32>, String> {
    state.pty.spawn(
        &app,
        &tile_id,
        &cwd,
        command.as_deref(),
        args,
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
fn watch_session(
    state: State<'_, AppState>,
    tile_id: String,
    session_name: String,
    session_id: Option<String>,
    workstream_id: Option<String>,
) -> Result<(), String> {
    if let Some(ref sid) = session_id {
        state.session_poller.watch_with_id(&tile_id, &session_name, sid, workstream_id.as_deref());
    } else {
        state.session_poller.watch(&tile_id, &session_name);
    }
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
#[derive(Debug, Serialize, Deserialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
    modified_epoch: u64,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("Cannot read dir: {e}"))?;
    let mut dirs: Vec<DirEntry> = Vec::new();
    let mut files: Vec<DirEntry> = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let modified_epoch = entry.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d: std::time::Duration| d.as_secs())
                .unwrap_or(0);
            let entry = DirEntry { name: name.to_string(), is_dir, modified_epoch };
            if is_dir { dirs.push(entry); } else { files.push(entry); }
        }
    }
    // Folders first (alpha), then files (by modified time desc)
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| b.modified_epoch.cmp(&a.modified_epoch));
    dirs.extend(files);
    Ok(dirs)
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

// ── Git log / branch commands ─────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct GitCommit {
    hash: String,
    short_hash: String,
    message: String,
    author: String,
    date: String,
}

#[tauri::command]
fn git_log(directory: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let n = limit.unwrap_or(50);
    let output = git_cmd()
        .args(["log", &format!("--format=%H|%h|%s|%an|%ar"), "-n", &n.to_string()])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(5, '|').collect();
            if parts.len() == 5 {
                Some(GitCommit {
                    hash: parts[0].to_string(),
                    short_hash: parts[1].to_string(),
                    message: parts[2].to_string(),
                    author: parts[3].to_string(),
                    date: parts[4].to_string(),
                })
            } else {
                None
            }
        })
        .collect();
    Ok(commits)
}

#[tauri::command]
fn git_show_commit(directory: String, hash: String) -> Result<String, String> {
    let output = git_cmd()
        .args(["show", &hash, "--stat", "--patch"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn git_current_branch(directory: String) -> Result<String, String> {
    let output = git_cmd()
        .args(["branch", "--show-current"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git error: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Get list of changed files for a diff mode
#[tauri::command]
fn git_diff_files(directory: String, mode: String) -> Result<Vec<String>, String> {
    let args: Vec<&str> = match mode.as_str() {
        "unstaged" => vec!["diff", "--name-only"],
        "last_commit" => vec!["diff", "HEAD~1", "--name-only"],
        "branch_vs_master" => {
            // Try master first, fall back to main
            let output = git_cmd()
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

    let output = git_cmd()
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
            let output = git_cmd()
                .args(&args)
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            args = vec!["diff", "main...HEAD", "--", &file_path];
            let output2 = git_cmd()
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

    let output = git_cmd()
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
                        let branch = git_cmd()
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
        let branch = git_cmd()
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

// ── Copilot Config Discovery ───────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct CopilotConfigItem {
    name: String,
    category: String,
    source: String,
    path: String,
    description: Option<String>,
}

/// Read the first non-frontmatter line from a SKILL.md as description
fn read_skill_description(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut in_frontmatter = false;
    let mut past_frontmatter = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "---" {
            if !in_frontmatter && !past_frontmatter {
                in_frontmatter = true;
                continue;
            }
            if in_frontmatter {
                in_frontmatter = false;
                past_frontmatter = true;
                continue;
            }
        }
        if in_frontmatter {
            continue;
        }
        if past_frontmatter && !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    // No frontmatter — return first non-empty line
    content.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|s| s.to_string())
}

// ── Settings ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [&key],
        |row| row.get::<_, Option<String>>(0),
    );
    match result {
        Ok(val) => Ok(val),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        [&key, &value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Git Hooks Discovery ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHookEntry {
    pub name: String,
    pub path: String,
    pub content_preview: String,
}

#[tauri::command]
fn list_git_hooks(directory: String) -> Result<Vec<GitHookEntry>, String> {
    let dir = std::path::Path::new(&directory);

    // Find .git directory (could be a worktree file)
    let git_path = dir.join(".git");
    let hooks_dir = if git_path.is_dir() {
        git_path.join("hooks")
    } else if git_path.is_file() {
        // Worktree: .git file contains "gitdir: /path/to/.git/worktrees/<name>"
        let content = std::fs::read_to_string(&git_path)
            .map_err(|e| format!("Cannot read .git: {e}"))?;
        if let Some(gitdir) = content.trim().strip_prefix("gitdir: ") {
            std::path::PathBuf::from(gitdir).join("hooks")
        } else {
            return Ok(Vec::new());
        }
    } else {
        return Ok(Vec::new());
    };

    // Also check .husky directory (common hook manager)
    let husky_dir = dir.join(".husky");

    let mut hooks = Vec::new();

    // Scan standard git hooks
    for hooks_path in [&hooks_dir, &husky_dir] {
        if !hooks_path.is_dir() { continue; }
        if let Ok(entries) = std::fs::read_dir(hooks_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() { continue; }
                let name = entry.file_name().to_string_lossy().to_string();
                // Skip .sample files and underscore dirs
                if name.ends_with(".sample") || name.starts_with('_') || name.starts_with('.') {
                    continue;
                }

                // Read content and check if it has actual commands (not just comments)
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let has_commands = content.lines().any(|line| {
                        let trimmed = line.trim();
                        !trimmed.is_empty()
                            && !trimmed.starts_with('#')
                            && !trimmed.starts_with("#!/")
                    });
                    if !has_commands { continue; }

                    // Get first few non-comment lines as preview
                    let preview: String = content
                        .lines()
                        .filter(|l| {
                            let t = l.trim();
                            !t.is_empty() && !t.starts_with('#') && !t.starts_with("#!/")
                        })
                        .take(3)
                        .collect::<Vec<_>>()
                        .join(" | ");

                    let source = if hooks_path == &husky_dir { "husky" } else { "git" };
                    hooks.push(GitHookEntry {
                        name: format!("{} ({})", name, source),
                        path: path.to_string_lossy().to_string(),
                        content_preview: if preview.len() > 120 {
                            format!("{}…", &preview[..120])
                        } else {
                            preview
                        },
                    });
                }
            }
        }
    }

    hooks.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(hooks)
}

#[tauri::command]
fn discover_copilot_config(workstream_dir: Option<String>) -> Result<Vec<CopilotConfigItem>, String> {
    let mut items = Vec::new();
    let home = dirs::home_dir().ok_or("No home directory")?;
    let copilot_dir = home.join(".copilot");

    // ── Global skills ──
    let skills_dir = copilot_dir.join("skills");
    if skills_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&skills_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let skill_md = entry.path().join("SKILL.md");
                    // Only show folders that actually contain a SKILL.md
                    if !skill_md.exists() { continue; }
                    let name = entry.file_name().to_string_lossy().to_string();
                    let desc = read_skill_description(&skill_md);
                    items.push(CopilotConfigItem {
                        name,
                        category: "skill".into(),
                        source: "global".into(),
                        path: entry.path().to_string_lossy().to_string(),
                        description: desc,
                    });
                }
            }
        }
    }

    // ── Global extensions ──
    let ext_dir = copilot_dir.join("extensions");
    if ext_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&ext_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    items.push(CopilotConfigItem {
                        name: entry.file_name().to_string_lossy().to_string(),
                        category: "extension".into(),
                        source: "global".into(),
                        path: entry.path().to_string_lossy().to_string(),
                        description: None,
                    });
                }
            }
        }
    }

    // ── Global agents ──
    let agents_dir = copilot_dir.join("agents");
    if agents_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&agents_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".agent.md") {
                    items.push(CopilotConfigItem {
                        name: name.trim_end_matches(".agent.md").to_string(),
                        category: "agent".into(),
                        source: "global".into(),
                        path: entry.path().to_string_lossy().to_string(),
                        description: None,
                    });
                }
            }
        }
    }

    // ── Global MCP servers ──
    let mcp_config = copilot_dir.join("mcp-config.json");
    if mcp_config.is_file() {
        if let Ok(content) = std::fs::read_to_string(&mcp_config) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                // Traverse mcpServers or servers key
                let servers = json.get("mcpServers")
                    .or_else(|| json.get("servers"));
                if let Some(serde_json::Value::Object(map)) = servers {
                    for key in map.keys() {
                        items.push(CopilotConfigItem {
                            name: key.clone(),
                            category: "mcp_server".into(),
                            source: "global".into(),
                            path: mcp_config.to_string_lossy().to_string(),
                            description: None,
                        });
                    }
                }
            }
        }
    }

    // ── Global plugins (expand into skills/extensions/agents) ──
    let plugins_dir = copilot_dir.join("installed-plugins");
    if plugins_dir.is_dir() {
        // Walk into each plugin provider (e.g., copilot-plugins, rtmspi-marketplace)
        fn scan_plugin_dir(dir: &std::path::Path, items: &mut Vec<CopilotConfigItem>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() { continue; }

                    // Check for skills/ subdirectory
                    let skills_sub = path.join("skills");
                    if skills_sub.is_dir() {
                        if let Ok(skill_entries) = std::fs::read_dir(&skills_sub) {
                            for skill_entry in skill_entries.flatten() {
                                if skill_entry.path().is_dir() {
                                    let skill_md = skill_entry.path().join("SKILL.md");
                                    if skill_md.exists() {
                                        let name = skill_entry.file_name().to_string_lossy().to_string();
                                        let desc = read_skill_description(&skill_md);
                                        items.push(CopilotConfigItem {
                                            name,
                                            category: "skill".into(),
                                            source: "plugin".into(),
                                            path: skill_entry.path().to_string_lossy().to_string(),
                                            description: desc,
                                        });
                                    }
                                }
                            }
                        }
                    }

                    // Check for extensions/ subdirectory
                    let ext_sub = path.join("extensions");
                    if ext_sub.is_dir() {
                        if let Ok(ext_entries) = std::fs::read_dir(&ext_sub) {
                            for ext_entry in ext_entries.flatten() {
                                if ext_entry.path().is_dir() {
                                    items.push(CopilotConfigItem {
                                        name: ext_entry.file_name().to_string_lossy().to_string(),
                                        category: "extension".into(),
                                        source: "plugin".into(),
                                        path: ext_entry.path().to_string_lossy().to_string(),
                                        description: None,
                                    });
                                }
                            }
                        }
                    }

                    // Check for agents/ subdirectory
                    let agents_sub = path.join("agents");
                    if agents_sub.is_dir() {
                        if let Ok(agent_entries) = std::fs::read_dir(&agents_sub) {
                            for agent_entry in agent_entries.flatten() {
                                let aname = agent_entry.file_name().to_string_lossy().to_string();
                                if aname.ends_with(".agent.md") {
                                    items.push(CopilotConfigItem {
                                        name: aname.trim_end_matches(".agent.md").to_string(),
                                        category: "agent".into(),
                                        source: "plugin".into(),
                                        path: agent_entry.path().to_string_lossy().to_string(),
                                        description: None,
                                    });
                                }
                            }
                        }
                    }

                    // Recurse into subdirectories (providers contain multiple plugins)
                    scan_plugin_dir(&path, items);
                }
            }
        }
        scan_plugin_dir(&plugins_dir, &mut items);
    }

    // ── Global instructions ──
    let global_instructions = copilot_dir.join("copilot-instructions.md");
    if global_instructions.is_file() {
        items.push(CopilotConfigItem {
            name: "copilot-instructions.md".into(),
            category: "instruction".into(),
            source: "global".into(),
            path: global_instructions.to_string_lossy().to_string(),
            description: None,
        });
    }

    // ── Repo-level scanning ──
    if let Some(ref ws_dir) = workstream_dir {
        let ws_path = std::path::Path::new(ws_dir);

        // .github/extensions/
        let repo_ext = ws_path.join(".github").join("extensions");
        if repo_ext.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&repo_ext) {
                for entry in entries.flatten() {
                    if entry.path().is_dir() {
                        items.push(CopilotConfigItem {
                            name: entry.file_name().to_string_lossy().to_string(),
                            category: "extension".into(),
                            source: "repo".into(),
                            path: entry.path().to_string_lossy().to_string(),
                            description: None,
                        });
                    }
                }
            }
        }

        // .github/copilot-instructions.md
        let repo_instructions = ws_path.join(".github").join("copilot-instructions.md");
        if repo_instructions.is_file() {
            items.push(CopilotConfigItem {
                name: "copilot-instructions.md".into(),
                category: "instruction".into(),
                source: "repo".into(),
                path: repo_instructions.to_string_lossy().to_string(),
                description: None,
            });
        }

        // .github/instructions/**/*.instructions.md
        let instructions_dir = ws_path.join(".github").join("instructions");
        if instructions_dir.is_dir() {
            fn walk_instructions(dir: &std::path::Path, items: &mut Vec<CopilotConfigItem>) {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() {
                            walk_instructions(&path, items);
                        } else {
                            let name = entry.file_name().to_string_lossy().to_string();
                            if name.ends_with(".instructions.md") {
                                items.push(CopilotConfigItem {
                                    name: name.trim_end_matches(".instructions.md").to_string(),
                                    category: "instruction".into(),
                                    source: "repo".into(),
                                    path: path.to_string_lossy().to_string(),
                                    description: None,
                                });
                            }
                        }
                    }
                }
            }
            walk_instructions(&instructions_dir, &mut items);
        }

        // AGENTS.md
        let agents_md = ws_path.join("AGENTS.md");
        if agents_md.is_file() {
            items.push(CopilotConfigItem {
                name: "AGENTS.md".into(),
                category: "instruction".into(),
                source: "repo".into(),
                path: agents_md.to_string_lossy().to_string(),
                description: None,
            });
        }
    }

    Ok(items)
}

// ── Session Files & Todos from session-store.db ────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionFileEntry {
    pub file_path: String,
    pub tool_name: Option<String>,
    pub turn_index: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionTodoEntry {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
}

fn open_session_store_readonly() -> Result<Connection, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let db_path = home.join(".copilot").join("session-store.db");
    if !db_path.exists() {
        return Err("session-store.db not found".into());
    }
    Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn query_session_files(session_id: String) -> Result<Vec<SessionFileEntry>, String> {
    let conn = open_session_store_readonly()?;
    let mut stmt = conn
        .prepare(
            "SELECT file_path, tool_name, turn_index FROM session_files
             WHERE session_id = ?1
             ORDER BY first_seen_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([&session_id], |row| {
            Ok(SessionFileEntry {
                file_path: row.get(0)?,
                tool_name: row.get(1)?,
                turn_index: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        if let Ok(entry) = row {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[tauri::command]
fn query_session_todos(session_id: String) -> Result<Vec<SessionTodoEntry>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let session_db_path = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id)
        .join("session.db");

    if !session_db_path.exists() {
        return Ok(Vec::new());
    }

    let conn = Connection::open_with_flags(
        &session_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;

    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='todos'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if !table_exists {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare("SELECT id, title, description, status FROM todos ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SessionTodoEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        if let Ok(entry) = row {
            entries.push(entry);
        }
    }
    Ok(entries)
}

// ── Session DB Explorer ────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionDbTable {
    pub name: String,
    pub row_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionDbTableData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

fn open_session_db(session_id: &str) -> Result<Connection, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let session_db_path = home
        .join(".copilot")
        .join("session-state")
        .join(session_id)
        .join("session.db");

    if !session_db_path.exists() {
        return Err("No session.db found".into());
    }

    Connection::open_with_flags(
        &session_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_session_db_tables(session_id: String) -> Result<Vec<SessionDbTable>, String> {
    let conn = open_session_db(&session_id)?;
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| e.to_string())?;

    let table_names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut tables = Vec::new();
    for name in table_names {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM [{}]", name), [], |row| row.get(0))
            .unwrap_or(0);
        tables.push(SessionDbTable { name, row_count: count });
    }
    Ok(tables)
}

#[tauri::command]
fn query_session_db_table(session_id: String, table_name: String, limit: Option<i64>) -> Result<SessionDbTableData, String> {
    let conn = open_session_db(&session_id)?;
    let limit_val = limit.unwrap_or(100);

    // Get column names
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM [{}] LIMIT 0", table_name))
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    drop(stmt);

    // Get rows
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM [{}] LIMIT {}", table_name, limit_val))
        .map_err(|e| e.to_string())?;
    let col_count = columns.len();
    let mut rows_out = Vec::new();

    let mut db_rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = db_rows.next().map_err(|e| e.to_string())? {
        let mut row_vals = Vec::new();
        for i in 0..col_count {
            let val: rusqlite::types::Value = row.get_unwrap(i);
            let json_val = match val {
                rusqlite::types::Value::Null => serde_json::Value::Null,
                rusqlite::types::Value::Integer(n) => serde_json::Value::Number(n.into()),
                rusqlite::types::Value::Real(f) => serde_json::json!(f),
                rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                rusqlite::types::Value::Blob(_) => serde_json::Value::String("[blob]".into()),
            };
            row_vals.push(json_val);
        }
        rows_out.push(row_vals);
    }

    Ok(SessionDbTableData { columns, rows: rows_out })
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
            update_tile_config,
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
            // Copilot config
            discover_copilot_config,
            // Session files & todos & DB
            query_session_files,
            query_session_todos,
            list_session_db_tables,
            query_session_db_table,
            // Git log & branch
            git_log,
            git_show_commit,
            git_current_branch,
            // Settings
            get_setting,
            set_setting,
            // Git hooks
            list_git_hooks,
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

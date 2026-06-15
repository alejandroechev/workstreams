mod db;
mod diff_review;
mod file_comments;
mod file_io;
mod fs_watcher;
mod pty;
mod repo_create;
mod session_poller;

use db::open_db;
use fs_watcher::FsWatcher;
use pty::PtyManager;
use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use session_poller::SessionPoller;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

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

#[derive(Debug, Serialize)]
struct ChangeWorktreeResult {
    workstream: Workstream,
    affected_tile_ids: Vec<String>,
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
    fs_watcher: Arc<FsWatcher>,
    /// Monotonic counter shared by every search; bumping this cancels in-flight searches.
    search_epoch: Arc<std::sync::atomic::AtomicU64>,
    /// Per-session polling threads for the redesigned Plan tile. Stats
    /// `<session>/files/features/` + the session DB every 1s and emits
    /// `session-features-changed` when either advances. See ADR forthcoming.
    features_watchers: Arc<Mutex<std::collections::HashMap<String, FeaturesWatcherHandle>>>,
}

struct FeaturesWatcherHandle {
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for FeaturesWatcherHandle {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn now() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{t}")
}

pub fn rewrite_tile_cwd(
    config_json: &str,
    tile_type: &str,
    new_cwd: &str,
) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(config_json).map_err(|e| format!("Invalid tile config JSON: {e}"))?;

    if matches!(tile_type, "terminal" | "copilot_session") {
        let object = value.as_object_mut().ok_or_else(|| {
            format!("Tile type {tile_type} requires an object config to rewrite cwd")
        })?;
        object.insert(
            "cwd".to_string(),
            serde_json::Value::String(new_cwd.to_string()),
        );
    }

    serde_json::to_string(&value).map_err(|e| format!("Failed to serialize tile config JSON: {e}"))
}

fn workstream_from_row(row: &Row<'_>) -> rusqlite::Result<Workstream> {
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
}

fn get_workstream_by_id(db: &Connection, id: &str) -> Result<Workstream, String> {
    db.query_row(
        "SELECT id, name, description, directory, git_repo, git_branch, status,
                project_id, workstream_type, worktree_branch, created_at, updated_at
         FROM workstreams WHERE id = ?1",
        [id],
        workstream_from_row,
    )
    .map_err(|e| format!("DB error: {e}"))
}

/// Create a git Command that doesn't show a console window on Windows
fn git_cmd() -> std::process::Command {
    #[allow(unused_mut)]
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
        db.execute(
            "UPDATE projects SET name = ?1, updated_at = ?2 WHERE id = ?3",
            (&n, &ts, &id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    if let Some(c) = color {
        db.execute(
            "UPDATE projects SET color = ?1, updated_at = ?2 WHERE id = ?3",
            (&c, &ts, &id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    // Unlink workstreams first (don't delete them)
    db.execute(
        "UPDATE workstreams SET project_id = NULL WHERE project_id = ?1",
        [&id],
    )
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
             FROM workstreams ORDER BY created_at ASC",
        )
        .map_err(|e| format!("DB error: {e}"))?;

    let rows = stmt
        .query_map([], workstream_from_row)
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn change_workstream_worktree(
    app: AppHandle,
    state: State<'_, AppState>,
    ws_id: String,
    mode: String,
    directory: Option<String>,
    branch_name: Option<String>,
    folder_name: Option<String>,
    pull_base_first: Option<bool>,
) -> Result<ChangeWorktreeResult, String> {
    let (final_dir, final_branch) = match mode.as_str() {
        "switch_existing" => {
            let dir = directory.ok_or("directory is required for switch_existing")?;
            if !std::path::Path::new(&dir).exists() {
                return Err(format!("Directory does not exist: {dir}"));
            }
            let info = detect_worktree_info(dir.clone())?;
            (dir, info.branch)
        }
        "create_new" => {
            let branch = branch_name.ok_or("branch_name is required for create_new")?;
            let current_dir = {
                let db = state.db.lock().unwrap();
                get_workstream_by_id(&db, &ws_id)?
                    .directory
                    .ok_or("workstream has no directory, cannot create worktree")?
            };
            let info = detect_worktree_info(current_dir.clone())?;
            let repo_root = if info.is_worktree {
                info.parent_repo_path
                    .ok_or("worktree parent repo path was not detected")?
            } else if std::path::Path::new(&current_dir).join(".git").is_dir() {
                current_dir
            } else {
                return Err("workstream is not in a git repo, cannot create worktree".into());
            };
            let created_dir =
                create_worktree(app, repo_root, branch.clone(), folder_name, pull_base_first)?;
            (created_dir, Some(branch))
        }
        _ => return Err(format!("Unknown worktree change mode: {mode}")),
    };

    let ts = now();
    let mut db = state.db.lock().unwrap();
    let tx = db.transaction().map_err(|e| format!("DB error: {e}"))?;
    tx.execute(
        "UPDATE workstreams SET directory = ?1, worktree_branch = ?2, updated_at = ?3 WHERE id = ?4",
        (&final_dir, &final_branch, &ts, &ws_id),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    let tile_rows: Vec<(String, String, String)> = {
        let mut stmt = tx
            .prepare(
                "SELECT id, tile_type, config_json FROM tiles
                 WHERE workstream_id = ?1 AND tile_type IN ('terminal','copilot_session')",
            )
            .map_err(|e| format!("DB error: {e}"))?;
        let rows = stmt
            .query_map([&ws_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .map_err(|e| format!("DB error: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("DB error: {e}"))?;
        rows
    };

    let mut affected_tile_ids = Vec::new();
    for (tile_id, tile_type, config_json) in tile_rows {
        let rewritten = rewrite_tile_cwd(&config_json, &tile_type, &final_dir)?;
        tx.execute(
            "UPDATE tiles SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
            (&rewritten, &ts, &tile_id),
        )
        .map_err(|e| format!("DB error: {e}"))?;
        affected_tile_ids.push(tile_id);
    }

    tx.commit().map_err(|e| format!("DB error: {e}"))?;
    let workstream = get_workstream_by_id(&db, &ws_id)?;
    Ok(ChangeWorktreeResult {
        workstream,
        affected_tile_ids,
    })
}

// ── Tile Commands ──────────────────────────────────────────────────────

#[tauri::command]
fn create_tile(
    app: AppHandle,
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

    let tile = Tile {
        id,
        workstream_id,
        tile_type,
        title,
        config_json: config,
        created_at: ts.clone(),
        updated_at: ts,
    };
    drop(db);
    let _ = app.emit("tile-created", &tile);
    Ok(tile)
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
    )
    .map_err(|e| format!("DB error: {e}"))?;
    if let Some(t) = title {
        db.execute("UPDATE tiles SET title = ?1 WHERE id = ?2", (&t, &tile_id))
            .map_err(|e| format!("DB error: {e}"))?;
    }
    Ok(())
}

// ── Layout Commands ────────────────────────────────────────────────────

#[tauri::command]
fn get_layout(
    state: State<'_, AppState>,
    workstream_id: String,
) -> Result<WorkstreamLayout, String> {
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
    // Ensure a layout row exists for this workstream — protects against
    // workstreams created outside create_workstream (e.g. seeded directly
    // into the DB). Without this, all UPDATE statements below silently
    // no-op and tile order is never persisted.
    db.execute(
        "INSERT OR IGNORE INTO workstream_layouts (workstream_id, layout_mode, tile_order_json, updated_at)
         VALUES (?1, 'adaptive', '[]', ?2)",
        (&workstream_id, &ts),
    )
    .map_err(|e| format!("DB error: {e}"))?;
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

/// Builds a HashMap of env vars to inject into PTY-spawned child processes
/// so skills (notably diff-grok) can detect which workstream they belong to
/// and connect back to the Tauri command bridge.
///
/// Looks up the workstream id from the tile via the DB. Returns None if the
/// tile is not found — terminals can still spawn, the env var just won't
/// be present (matches dev behavior before this was added).
fn build_workstream_env(
    state: &State<'_, AppState>,
    tile_id: &str,
) -> Option<std::collections::HashMap<String, String>> {
    let db = state.db.lock().ok()?;
    workstream_env_from_db(&db, tile_id)
}

/// Pure helper: builds the env-var map from a DB connection + tile id.
/// Returns None when the tile is unknown.
fn workstream_env_from_db(
    db: &rusqlite::Connection,
    tile_id: &str,
) -> Option<std::collections::HashMap<String, String>> {
    let ws_id: String = db
        .query_row(
            "SELECT workstream_id FROM tiles WHERE id = ?1",
            [tile_id],
            |row| row.get(0),
        )
        .ok()?;
    let mut env = std::collections::HashMap::new();
    env.insert("WORKSTREAMS_ACTIVE_WS".to_string(), ws_id);
    env.insert("WORKSTREAMS_ACTIVE_TILE".to_string(), tile_id.to_string());
    Some(env)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    let env = build_workstream_env(&state, &tile_id);
    state.pty.spawn(
        &app,
        &tile_id,
        &cwd,
        command.as_deref(),
        args,
        rows.unwrap_or(30),
        cols.unwrap_or(120),
        env,
    )
}

/// Spawn a copilot session CLI and register a pending PID-based
/// correlation with the poller so it can find the resulting
/// `~/.copilot/session-state/<id>` directory by scanning `inuse.<pid>.lock`.
///
/// `command` (optional) is a full command line (e.g. `agency copilot --yolo`
/// or `copilot --yolo`). It is whitespace-split into program + args. When
/// `None`, the compiled-in default `agency copilot --yolo` is used so
/// existing callers keep working unchanged.
///
/// If `resume_session_id` is Some, the CLI is invoked with `--resume=<id>`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn spawn_copilot_session(
    app: AppHandle,
    state: State<'_, AppState>,
    tile_id: String,
    cwd: String,
    resume_session_id: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    command: Option<String>,
) -> Result<Option<u32>, String> {
    let template = command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("agency copilot --yolo");
    let mut parts = template.split_whitespace();
    let program = parts
        .next()
        .ok_or("empty copilot command template")?
        .to_string();
    let mut args: Vec<String> = parts.map(|s| s.to_string()).collect();
    if let Some(sid) = &resume_session_id {
        args.push(format!("--resume={sid}"));
    }
    let env = build_workstream_env(&state, &tile_id);
    let pid = state.pty.spawn(
        &app,
        &tile_id,
        &cwd,
        Some(program.as_str()),
        Some(args),
        rows.unwrap_or(30),
        cols.unwrap_or(120),
        env,
    )?;
    // Only register pending if we don't already know the session_id (resume
    // case has the id up front so the regular watch_with_id path is enough).
    if resume_session_id.is_none() {
        if let Some(p) = pid {
            state.session_poller.register_pending(&tile_id, p, &cwd);
        }
    }
    Ok(pid)
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
fn get_copilot_link(
    state: State<'_, AppState>,
    tile_id: String,
) -> Result<Option<CopilotSessionInfo>, String> {
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

// ── Filesystem Watcher Commands ────────────────────────────────────────

#[tauri::command]
fn watch_directory(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.fs_watcher.watch(&path)
}

#[tauri::command]
fn unwatch_directory(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.fs_watcher.unwatch(&path)
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
        state
            .session_poller
            .watch_with_id(&tile_id, &session_name, sid, workstream_id.as_deref());
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

/// Quick existence check for a path. Returns true when something exists at
/// the path (file or directory), false otherwise. Used by Workbench tiles
/// to surface stale entries that the user added but later deleted on disk.
#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

/// Read a binary file and return as base64
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read file: {e}"))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// List files in a directory (non-recursive, for file picker)
#[derive(Debug, Serialize, Deserialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
    modified_epoch: u64,
    /// Byte size for files; 0 for directories.
    size: u64,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| format!("Cannot read dir: {e}"))?;
    let mut dirs: Vec<DirEntry> = Vec::new();
    let mut files: Vec<DirEntry> = Vec::new();
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            let metadata = entry.metadata().ok();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let modified_epoch = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d: std::time::Duration| d.as_secs())
                .unwrap_or(0);
            let size = if is_dir {
                0
            } else {
                metadata.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            let entry = DirEntry {
                name: name.to_string(),
                is_dir,
                modified_epoch,
                size,
            };
            if is_dir {
                dirs.push(entry);
            } else {
                files.push(entry);
            }
        }
    }
    // Folders first (alpha), then files (alpha)
    dirs.sort_by_key(|a| a.name.to_lowercase());
    files.sort_by_key(|a| a.name.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}

// ── File search ─────────────────────────────────────────────────────────
//
// Both `search_files` (filename match) and `search_in_files` (content match)
// share:
//   • a skip-dirs set (node_modules, target, .git, dist, .next, …),
//   • cancellation via `AppState.search_epoch` — each new search bumps the
//     atomic counter, and the running walker bails on its next iteration if
//     its epoch is stale. This prevents a slow walk from blocking the IPC
//     queue and freezing the UI.
//   • for content search, an extension whitelist so we never `open()` a
//     2 GB sqlite blob just to read 0 lines from it.

const SEARCH_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".turbo",
    ".cargo",
    ".dev",
    "build",
    "out",
    ".vite",
    "coverage",
];

/// Extensions we consider safe (and worth) reading line-by-line. Anything
/// else is treated as binary/noise and skipped by the content search.
const CONTENT_SEARCH_EXTS: &[&str] = &[
    "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "rs", "go", "py", "rb", "php", "lua",
    "java", "kt", "scala", "swift", "dart", "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "cs",
    "csx", "json", "jsonc", "json5", "toml", "yaml", "yml", "xml", "html", "htm", "css", "scss",
    "sass", "less", "md", "mdx", "markdown", "txt", "log", "sh", "bash", "zsh", "fish", "ps1",
    "psm1", "bat", "cmd", "sql", "graphql", "gql", "proto", "ini", "conf", "env",
];

fn is_text_extension(name: &str) -> bool {
    let lower = name.to_lowercase();
    if let Some(dot) = lower.rfind('.') {
        let ext = &lower[dot + 1..];
        return CONTENT_SEARCH_EXTS.contains(&ext);
    }
    // Common extensionless config files
    matches!(
        lower.as_str(),
        "dockerfile" | "makefile" | "readme" | "license" | "agents.md"
    )
}

/// Cancel any in-flight searches. Call this before launching a new search
/// so the previous walker bails on its next iteration. Cheap; the running
/// walker just observes the bumped epoch and returns early.
#[tauri::command]
fn cancel_searches(state: State<'_, AppState>) -> Result<u64, String> {
    let new = state
        .search_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    Ok(new)
}

/// Trivial IPC ping for latency benchmarking. Returns the current epoch in ms.
#[tauri::command]
fn ping() -> Result<u64, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}

/// Recursively search for files matching a query (case-insensitive filename match).
/// Cancels on epoch bump. Returns whatever it has found at the cancellation point.
#[tauri::command]
fn search_files(
    state: State<'_, AppState>,
    directory: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let my_epoch = state
        .search_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let epoch_ref = state.search_epoch.clone();
    let is_cancelled = move || epoch_ref.load(std::sync::atomic::Ordering::Relaxed) != my_epoch;
    Ok(search_files_impl(
        &directory,
        &query,
        limit.unwrap_or(200) as usize,
        &is_cancelled,
    ))
}

/// Pure helper for `search_files`. Tested directly; the tauri command is a thin wrapper.
pub(crate) fn search_files_impl(
    directory: &str,
    query: &str,
    max: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> Vec<String> {
    use std::collections::VecDeque;
    let query_lower = query.to_lowercase();
    let skip_dirs: std::collections::HashSet<&str> = SEARCH_SKIP_DIRS.iter().copied().collect();

    let mut results = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(std::path::PathBuf::from(directory));

    while let Some(dir) = queue.pop_front() {
        if is_cancelled() || results.len() >= max {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if is_cancelled() || results.len() >= max {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if path.is_dir() {
                if !skip_dirs.contains(name_str.as_ref()) && !name_str.starts_with('.') {
                    queue.push_back(path);
                }
            } else if name_str.to_lowercase().contains(&query_lower) {
                results.push(path.to_string_lossy().to_string());
            }
        }
    }
    results
}

/// Result row for cross-file content search
#[derive(Debug, Serialize, Deserialize)]
struct FileSearchMatch {
    path: String,
    line_number: u32,
    line_text: String,
}

/// Recursively search for content matches inside files (case-insensitive substring).
/// Restricted to a text-file extension whitelist. Cancels on epoch bump.
#[tauri::command]
fn search_in_files(
    state: State<'_, AppState>,
    directory: String,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FileSearchMatch>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let my_epoch = state
        .search_epoch
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let epoch_ref = state.search_epoch.clone();
    let is_cancelled = move || epoch_ref.load(std::sync::atomic::Ordering::Relaxed) != my_epoch;
    Ok(search_in_files_impl(
        &directory,
        &query,
        limit.unwrap_or(200) as usize,
        &is_cancelled,
    ))
}

/// Pure helper for `search_in_files`. Tested directly; the tauri command is a thin wrapper.
pub(crate) fn search_in_files_impl(
    directory: &str,
    query: &str,
    max_total: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> Vec<FileSearchMatch> {
    use std::collections::VecDeque;
    use std::io::{BufRead, BufReader};

    if query.trim().is_empty() {
        return Vec::new();
    }
    let max_per_file = 5usize;
    let max_file_size = 1_048_576u64; // 1 MB
    let query_lower = query.to_lowercase();
    let skip_dirs: std::collections::HashSet<&str> = SEARCH_SKIP_DIRS.iter().copied().collect();

    let mut results: Vec<FileSearchMatch> = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(std::path::PathBuf::from(directory));

    while let Some(dir) = queue.pop_front() {
        if is_cancelled() || results.len() >= max_total {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if is_cancelled() || results.len() >= max_total {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if path.is_dir() {
                if !skip_dirs.contains(name_str.as_ref()) && !name_str.starts_with('.') {
                    queue.push_back(path);
                }
                continue;
            }
            if !is_text_extension(&name_str) {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if size > max_file_size {
                continue;
            }
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let reader = BufReader::new(file);
            let mut in_file_count = 0usize;
            for (idx, line) in reader.lines().enumerate() {
                if is_cancelled() {
                    return results;
                }
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if line.to_lowercase().contains(&query_lower) {
                    results.push(FileSearchMatch {
                        path: path.to_string_lossy().to_string(),
                        line_number: (idx + 1) as u32,
                        line_text: if line.len() > 240 {
                            line.chars().take(240).collect()
                        } else {
                            line
                        },
                    });
                    in_file_count += 1;
                    if in_file_count >= max_per_file || results.len() >= max_total {
                        break;
                    }
                }
            }
        }
    }
    results
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
        .args(["log", "--format=%H|%h|%s|%an|%ar", "-n", &n.to_string()])
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

/// Tracking info for the current branch against its origin counterpart.
/// Returns (ahead, behind, remote_head_short_hash). `remote_head_short_hash`
/// is empty if origin doesn't have the branch.
#[tauri::command]
fn git_branch_tracking_info(directory: String) -> Result<(u32, u32, String), String> {
    let branch_out = git_cmd()
        .args(["branch", "--show-current"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !branch_out.status.success() {
        return Ok((0, 0, String::new()));
    }
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        return Ok((0, 0, String::new()));
    }
    let remote_ref = format!("origin/{branch}");
    // Check origin/<branch> exists.
    let exists = git_cmd()
        .args(["rev-parse", "--verify", &remote_ref])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !exists.status.success() {
        return Ok((0, 0, String::new()));
    }
    let remote_hash = String::from_utf8_lossy(&exists.stdout).trim().to_string();
    let short = remote_hash.chars().take(7).collect::<String>();
    // ahead/behind via rev-list --left-right --count <remote>...<local>
    let counts = git_cmd()
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{remote_ref}...HEAD"),
        ])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !counts.status.success() {
        return Ok((0, 0, short));
    }
    let raw = String::from_utf8_lossy(&counts.stdout);
    let mut parts = raw.split_whitespace();
    let behind: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    Ok((ahead, behind, short))
}
#[tauri::command]
fn create_worktree(
    app: AppHandle,
    project_directory: String,
    branch_name: String,
    base_branch: Option<String>,
    pull_base_first: Option<bool>,
) -> Result<String, String> {
    let emit_step = |step: &str, detail: &str| {
        let _ = app.emit(
            "worktree-progress",
            serde_json::json!({ "step": step, "detail": detail }),
        );
    };
    emit_step("resolving", "Resolving repository root");

    // Determine worktree path: sibling of existing worktrees
    let project_dir = std::path::Path::new(&project_directory);

    // Use the parent directory of the project to place the new worktree alongside
    let parent = project_dir
        .parent()
        .ok_or("Cannot determine parent directory")?;
    // Derive folder name from branch: alejandroe/feature-x → feature-x
    let folder_name = branch_name
        .rsplit('/')
        .next()
        .unwrap_or(&branch_name)
        .to_string();
    let worktree_path = parent.join(&folder_name);

    if worktree_path.exists() {
        return Err(format!(
            "Directory already exists: {}",
            worktree_path.display()
        ));
    }

    // Find the git root (for running worktree commands)
    let git_root_output = git_cmd()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&project_directory)
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;

    let git_root = if git_root_output.status.success() {
        String::from_utf8_lossy(&git_root_output.stdout)
            .trim()
            .to_string()
    } else {
        project_directory.clone()
    };

    // Optionally fast-forward the local base branch to its remote tip
    // before creating the worktree, so the new branch starts from latest.
    // Failures here are non-fatal: we log a warning to stderr but still
    // proceed so a missing/offline remote doesn't block the workstream.
    if pull_base_first.unwrap_or(false) {
        let effective_base = base_branch
            .clone()
            .or_else(|| detect_default_remote_branch(&git_root))
            .or_else(|| detect_local_default_branch(&git_root));
        if let Some(base) = effective_base {
            emit_step(
                "pulling-base",
                &format!("Pulling latest {base} from origin"),
            );
            if let Err(e) = fetch_and_fast_forward_local_branch(&git_root, &base) {
                eprintln!("[create_worktree] base pull skipped: {e}");
                emit_step("pull-skipped", &e);
            } else {
                emit_step("pulled-base", &format!("Local {base} now at origin tip"));
            }
        }
    }

    emit_step(
        "creating",
        &format!("git worktree add → {}", worktree_path.display()),
    );

    // Build worktree add command
    let mut args = vec![
        "worktree".to_string(),
        "add".to_string(),
        worktree_path.to_string_lossy().to_string(),
        "-b".to_string(),
        branch_name.clone(),
    ];
    if let Some(base) = &base_branch {
        args.push(base.clone());
    }

    let output = git_cmd()
        .args(args.iter().map(|s| s.as_str()))
        .current_dir(&git_root)
        .output()
        .map_err(|e| format!("git worktree add failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {stderr}"));
    }

    emit_step("created", &worktree_path.to_string_lossy());
    Ok(worktree_path.to_string_lossy().to_string())
}

/// Resolves `origin/HEAD` to the remote's default branch name (e.g.
/// `master`, `main`, `trunk`). Returns None when there's no remote or
/// the ref isn't set (e.g. fresh clone without `git remote set-head`).
fn detect_default_remote_branch(git_root: &str) -> Option<String> {
    let out = git_cmd()
        .args([
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ])
        .current_dir(git_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // strip the "origin/" prefix
    raw.strip_prefix("origin/").map(String::from).or(Some(raw))
}

/// Falls back to local-only HEAD detection when no remote is set.
fn detect_local_default_branch(git_root: &str) -> Option<String> {
    // Try `main` then `master` — the two common defaults. We don't try
    // to read git config because it's the same answer in 99% of cases.
    for candidate in ["main", "master"] {
        let out = git_cmd()
            .args(["rev-parse", "--verify", "--quiet", candidate])
            .current_dir(git_root)
            .output()
            .ok()?;
        if out.status.success() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// `git fetch origin <branch>` then advance the local `<branch>` ref to
/// `origin/<branch>` if it's strictly fast-forwardable. Uses `update-ref`
/// directly so this works even when the branch isn't currently checked
/// out (the common case — we'll check out a different branch in the new
/// worktree). Diverged branches are left untouched (caller sees stderr).
fn fetch_and_fast_forward_local_branch(git_root: &str, branch: &str) -> Result<(), String> {
    let fetch = git_cmd()
        .args(["fetch", "origin", branch])
        .current_dir(git_root)
        .output()
        .map_err(|e| format!("git fetch failed: {e}"))?;
    if !fetch.status.success() {
        return Err(format!(
            "git fetch origin {branch} failed: {}",
            String::from_utf8_lossy(&fetch.stderr).trim()
        ));
    }
    // Check that origin/<branch> is an ancestor of itself (sanity) and
    // that local <branch> is reachable from origin/<branch>.
    let local_ref = format!("refs/heads/{branch}");
    let remote_ref = format!("refs/remotes/origin/{branch}");
    // If local doesn't exist, create it pointing at origin/<branch>.
    let local_exists = git_cmd()
        .args(["rev-parse", "--verify", "--quiet", &local_ref])
        .current_dir(git_root)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !local_exists {
        let create = git_cmd()
            .args(["branch", branch, &remote_ref])
            .current_dir(git_root)
            .output()
            .map_err(|e| format!("git branch failed: {e}"))?;
        if !create.status.success() {
            return Err(format!(
                "creating local {branch} failed: {}",
                String::from_utf8_lossy(&create.stderr).trim()
            ));
        }
        return Ok(());
    }
    // Local exists. Is it fast-forwardable to origin/<branch>?
    let merge_base = git_cmd()
        .args(["merge-base", "--is-ancestor", &local_ref, &remote_ref])
        .current_dir(git_root)
        .status()
        .map_err(|e| format!("git merge-base failed: {e}"))?;
    if !merge_base.success() {
        return Err(format!(
            "local {branch} diverged from origin/{branch}; skipping fast-forward"
        ));
    }
    // Fast-forward via update-ref so it works without checking out.
    let new_sha = git_cmd()
        .args(["rev-parse", &remote_ref])
        .current_dir(git_root)
        .output()
        .map_err(|e| format!("git rev-parse failed: {e}"))?;
    if !new_sha.status.success() {
        return Err("could not resolve remote sha".into());
    }
    let sha = String::from_utf8_lossy(&new_sha.stdout).trim().to_string();
    let update = git_cmd()
        .args(["update-ref", &local_ref, &sha])
        .current_dir(git_root)
        .output()
        .map_err(|e| format!("git update-ref failed: {e}"))?;
    if !update.status.success() {
        return Err(format!(
            "git update-ref failed: {}",
            String::from_utf8_lossy(&update.stderr).trim()
        ));
    }
    Ok(())
}

/// List branches for a git repository
#[tauri::command]
fn git_list_branches(directory: String) -> Result<Vec<String>, String> {
    let output = git_cmd()
        .args(["branch", "--list", "--format=%(refname:short)"])
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("git branch failed: {e}"))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect())
}

/// Get list of changed files for a diff mode
#[tauri::command]
fn git_diff_files(directory: String, mode: String) -> Result<Vec<String>, String> {
    let args: Vec<&str> = match mode.as_str() {
        "unstaged" => {
            let tracked = git_cmd()
                .args(["diff", "--name-only"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if !tracked.status.success() {
                let stderr = String::from_utf8_lossy(&tracked.stderr);
                return Err(format!("git error: {stderr}"));
            }
            let untracked = git_cmd()
                .args(["ls-files", "--others", "--exclude-standard"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if !untracked.status.success() {
                let stderr = String::from_utf8_lossy(&untracked.stderr);
                return Err(format!("git error: {stderr}"));
            }
            let mut files: Vec<String> = Vec::new();
            for chunk in [&tracked.stdout, &untracked.stdout] {
                for line in String::from_utf8_lossy(chunk).lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let owned = trimmed.to_string();
                    if !files.contains(&owned) {
                        files.push(owned);
                    }
                }
            }
            files.sort();
            return Ok(files);
        }
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
                return Ok(stdout
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|l| l.to_string())
                    .collect());
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
        "unstaged" => {
            let ls = git_cmd()
                .args([
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "--",
                    &file_path,
                ])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            let is_untracked =
                ls.status.success() && !String::from_utf8_lossy(&ls.stdout).trim().is_empty();
            if is_untracked {
                // `git diff --no-index` exits with status 1 when files differ;
                // that's not an error for us — just return stdout.
                let output = git_cmd()
                    .args(["diff", "--no-index", "--", "/dev/null", &file_path])
                    .current_dir(&directory)
                    .output()
                    .map_err(|e| format!("Failed to run git: {e}"))?;
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            vec!["diff"]
        }
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

/// Returns the full content of a file at a specific git revision, or empty
/// string if the file doesn't exist at that revision.
fn read_git_show(directory: &str, revision: &str, file_path: &str) -> Result<String, String> {
    let spec = format!("{revision}:{file_path}");
    let output = git_cmd()
        .args(["show", &spec])
        .current_dir(directory)
        .output()
        .map_err(|e| format!("Failed to run git show: {e}"))?;
    if !output.status.success() {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Returns both sides of a diff (before/after) as full file contents so the
/// frontend can render them in a regular DiffEditor without synthesising
/// from a unified-diff text.
#[tauri::command]
fn git_diff_file_sides(
    directory: String,
    file_path: String,
    mode: String,
) -> Result<(String, String), String> {
    match mode.as_str() {
        "unstaged" => {
            let before = read_git_show(&directory, "HEAD", &file_path)?;
            let abs = std::path::Path::new(&directory).join(&file_path);
            let after = std::fs::read_to_string(&abs).unwrap_or_default();
            Ok((before, after))
        }
        "last_commit" => {
            let before = read_git_show(&directory, "HEAD~1", &file_path)?;
            let after = read_git_show(&directory, "HEAD", &file_path)?;
            Ok((before, after))
        }
        "branch_vs_master" => {
            let mut before = read_git_show(&directory, "master", &file_path)?;
            if before.is_empty() {
                // Distinguish "no master branch" from "file not on master".
                // Try main; if that also empty, leave before as "".
                before = read_git_show(&directory, "main", &file_path)?;
            }
            let after = read_git_show(&directory, "HEAD", &file_path)?;
            Ok((before, after))
        }
        _ => Err(format!("Unknown diff mode: {mode}")),
    }
}

/// Returns the changed files along with their status: "A" added, "M"
/// modified, "D" deleted, "R" renamed.
#[tauri::command]
fn git_diff_files_with_status(
    directory: String,
    mode: String,
) -> Result<Vec<(String, String)>, String> {
    fn parse_name_status(out: &str) -> Vec<(String, String)> {
        let mut v = Vec::new();
        for line in out.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.split('\t');
            let raw_status = parts.next().unwrap_or("");
            let status_char = raw_status.chars().next().unwrap_or('M');
            let kind = match status_char {
                'A' => "A",
                'D' => "D",
                'R' => "R",
                'C' => "R",
                _ => "M",
            }
            .to_string();
            let path = if status_char == 'R' || status_char == 'C' {
                parts.nth(1).unwrap_or("").to_string()
            } else {
                parts.next().unwrap_or("").to_string()
            };
            if !path.is_empty() {
                v.push((path, kind));
            }
        }
        v
    }

    let args_owned: Vec<String> = match mode.as_str() {
        "unstaged" => {
            let tracked = git_cmd()
                .args(["diff", "--name-status"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if !tracked.status.success() {
                return Err(format!(
                    "git error: {}",
                    String::from_utf8_lossy(&tracked.stderr)
                ));
            }
            let mut files = parse_name_status(&String::from_utf8_lossy(&tracked.stdout));
            let untracked = git_cmd()
                .args(["ls-files", "--others", "--exclude-standard"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if untracked.status.success() {
                for line in String::from_utf8_lossy(&untracked.stdout).lines() {
                    let p = line.trim();
                    if !p.is_empty() && !files.iter().any(|(pp, _)| pp == p) {
                        files.push((p.to_string(), "A".to_string()));
                    }
                }
            }
            files.sort_by(|a, b| a.0.cmp(&b.0));
            return Ok(files);
        }
        "last_commit" => vec!["diff".into(), "HEAD~1".into(), "--name-status".into()],
        "branch_vs_master" => {
            let output = git_cmd()
                .args(["diff", "master...HEAD", "--name-status"])
                .current_dir(&directory)
                .output()
                .map_err(|e| format!("Failed to run git: {e}"))?;
            if output.status.success() {
                return Ok(parse_name_status(&String::from_utf8_lossy(&output.stdout)));
            }
            vec!["diff".into(), "main...HEAD".into(), "--name-status".into()]
        }
        _ => return Err(format!("Unknown diff mode: {mode}")),
    };
    let arg_refs: Vec<&str> = args_owned.iter().map(String::as_str).collect();
    let output = git_cmd()
        .args(&arg_refs)
        .current_dir(&directory)
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git error: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(parse_name_status(&String::from_utf8_lossy(&output.stdout)))
}
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
    let branch = std::fs::read_to_string(head_path).ok().and_then(|content| {
        content
            .strip_prefix("ref: refs/heads/")
            .map(|b| b.trim().to_string())
    });

    Ok((repo_name, branch))
}

/// Create a new git repository on disk (optionally with a GitHub remote).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn create_git_repo(
    parent: String,
    name: String,
    default_branch: String,
    create_readme: bool,
    create_gitignore: bool,
    initial_commit: bool,
    create_github_remote: bool,
    github_owner: Option<String>,
    github_visibility: Option<String>,
) -> Result<repo_create::CreateRepoResult, String> {
    let opts = repo_create::CreateRepoOptions {
        parent,
        name,
        default_branch,
        create_readme,
        create_gitignore,
        initial_commit,
        create_github_remote,
        github_owner,
        github_visibility,
    };
    let provider = repo_create::GhCliRemoteProvider;
    repo_create::create_git_repo_with(&opts, &provider)
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
        let content =
            std::fs::read_to_string(&git_path).map_err(|e| format!("Cannot read .git: {e}"))?;
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
                        let repo_name = root
                            .file_name()
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
        let repo_name = dir
            .file_name()
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
    content
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|s| s.to_string())
}

// ── Settings ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let result = db.query_row("SELECT value FROM settings WHERE key = ?1", [&key], |row| {
        row.get::<_, Option<String>>(0)
    });
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

    // Check core.hooksPath first (e.g., husky v9 sets this)
    let configured_hooks_dir = git_cmd()
        .args(["config", "core.hooksPath"])
        .current_dir(&directory)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let path_str = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !path_str.is_empty() {
                    // Resolve relative paths against repo root
                    let p = std::path::Path::new(&path_str);
                    if p.is_absolute() {
                        Some(p.to_path_buf())
                    } else {
                        Some(dir.join(&path_str))
                    }
                } else {
                    None
                }
            } else {
                None
            }
        });

    // Find .git/hooks directory (fallback)
    let git_path = dir.join(".git");
    let default_hooks_dir = if git_path.is_dir() {
        Some(git_path.join("hooks"))
    } else if git_path.is_file() {
        let content =
            std::fs::read_to_string(&git_path).map_err(|e| format!("Cannot read .git: {e}"))?;
        content
            .trim()
            .strip_prefix("gitdir: ")
            .map(|gitdir| std::path::PathBuf::from(gitdir).join("hooks"))
    } else {
        None
    };

    // Also check .husky directory (common hook manager)
    let husky_dir = dir.join(".husky");

    // Collect all hook directories to scan (deduplicated)
    let mut hook_dirs: Vec<(std::path::PathBuf, &str)> = Vec::new();
    if let Some(ref cfg_dir) = configured_hooks_dir {
        hook_dirs.push((cfg_dir.clone(), "active"));
    }
    if let Some(ref def_dir) = default_hooks_dir {
        if configured_hooks_dir.as_ref() != Some(def_dir) {
            hook_dirs.push((def_dir.clone(), "git"));
        }
    }
    if configured_hooks_dir.as_ref() != Some(&husky_dir) {
        hook_dirs.push((husky_dir, "husky"));
    }

    let mut hooks = Vec::new();

    for (hooks_path, source) in &hook_dirs {
        if !hooks_path.is_dir() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(hooks_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
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
                    if !has_commands {
                        continue;
                    }

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
fn discover_copilot_config(
    workstream_dir: Option<String>,
) -> Result<Vec<CopilotConfigItem>, String> {
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
                    if !skill_md.exists() {
                        continue;
                    }
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
                let servers = json.get("mcpServers").or_else(|| json.get("servers"));
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
                    if !path.is_dir() {
                        continue;
                    }

                    // Check for skills/ subdirectory
                    let skills_sub = path.join("skills");
                    if skills_sub.is_dir() {
                        if let Ok(skill_entries) = std::fs::read_dir(&skills_sub) {
                            for skill_entry in skill_entries.flatten() {
                                if skill_entry.path().is_dir() {
                                    let skill_md = skill_entry.path().join("SKILL.md");
                                    if skill_md.exists() {
                                        let name =
                                            skill_entry.file_name().to_string_lossy().to_string();
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
    /// Plan ownership (added for Plan tile). NULL on legacy DBs that
    /// haven't run the discipline-extension migration yet — we coerce
    /// to None on read so the frontend doesn't have to special-case
    /// missing column.
    pub plan_id: Option<String>,
}

/// Read a file from within a session-state directory
#[tauri::command]
fn read_session_file(session_id: String, relative_path: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let file_path = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id)
        .join(&relative_path);

    if !file_path.exists() {
        return Err(format!("File not found: {}", relative_path));
    }

    std::fs::read_to_string(&file_path).map_err(|e| format!("Cannot read {}: {}", relative_path, e))
}

/// Returns the absolute path of `~/.copilot/session-state/<id>` so the
/// frontend can list it with the regular list_directory + read_file APIs.
/// Errors if the directory doesn't exist.
#[tauri::command]
fn session_state_dir(session_id: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let dir = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id);
    if !dir.is_dir() {
        return Err(format!("session-state dir not found for {session_id}"));
    }
    Ok(dir.to_string_lossy().to_string())
}

/// List checkpoints for a session
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CheckpointEntry {
    pub number: i32,
    pub title: String,
    pub file_name: String,
}

#[tauri::command]
fn list_session_checkpoints(session_id: String) -> Result<Vec<CheckpointEntry>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let cp_dir = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id)
        .join("checkpoints");

    if !cp_dir.exists() {
        return Ok(Vec::new());
    }

    // Parse index.md for checkpoint list
    let index_path = cp_dir.join("index.md");
    if !index_path.exists() {
        return Ok(Vec::new());
    }

    let content =
        std::fs::read_to_string(&index_path).map_err(|e| format!("Cannot read index.md: {e}"))?;

    let mut entries = Vec::new();
    for line in content.lines() {
        // Parse table rows: "| 1 | Title | filename.md |"
        let parts: Vec<&str> = line.split('|').map(|s| s.trim()).collect();
        if parts.len() >= 4 {
            if let Ok(num) = parts[1].parse::<i32>() {
                entries.push(CheckpointEntry {
                    number: num,
                    title: parts[2].to_string(),
                    file_name: parts[3].to_string(),
                });
            }
        }
    }
    Ok(entries)
}

/// Read recent events from events.jsonl
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EventEntry {
    pub event_type: String,
    pub timestamp: String,
    pub tool: Option<String>,
    pub summary: Option<String>,
}

#[tauri::command]
fn list_session_events(
    session_id: String,
    limit: Option<usize>,
) -> Result<Vec<EventEntry>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let events_path = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id)
        .join("events.jsonl");

    if !events_path.exists() {
        return Ok(Vec::new());
    }

    let lines = crate::session_poller::tail_file(&events_path, limit.unwrap_or(200));
    let mut entries = Vec::new();

    for line in &lines {
        let event: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = event
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let timestamp = event
            .get("timestamp")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Skip hook events (too noisy)
        if event_type.starts_with("hook.") {
            continue;
        }

        let tool = event
            .get("data")
            .and_then(|d| d.get("toolName"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let summary = match event_type.as_str() {
            "tool.execution_start" => tool.as_ref().map(|t| format!("Running {t}")),
            "tool.execution_complete" => {
                let success = event
                    .get("data")
                    .and_then(|d| d.get("success"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                Some(if success {
                    "✓ Done".into()
                } else {
                    "✗ Failed".into()
                })
            }
            "assistant.message" => {
                let tools = event
                    .get("data")
                    .and_then(|d| d.get("toolRequests"))
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                if tools > 0 {
                    Some(format!(
                        "{tools} tool call{}",
                        if tools > 1 { "s" } else { "" }
                    ))
                } else {
                    Some("Response".into())
                }
            }
            "user.message" => Some("User prompt".into()),
            "subagent.started" => Some("Background agent started".into()),
            "subagent.completed" => Some("Background agent done".into()),
            "session.start" | "session.resume" => Some("Session started".into()),
            "skill.invoked" => event
                .get("data")
                .and_then(|d| d.get("skillName"))
                .and_then(|v| v.as_str())
                .map(|s| format!("Skill: {s}")),
            _ => None,
        };

        entries.push(EventEntry {
            event_type,
            timestamp,
            tool,
            summary,
        });
    }

    // Reverse so newest first
    entries.reverse();
    Ok(entries)
}

#[tauri::command]
fn query_session_files(session_id: String) -> Result<Vec<SessionFileEntry>, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let files_dir = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id)
        .join("files");

    if !files_dir.exists() || !files_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    fn walk_files(dir: &std::path::Path, entries: &mut Vec<SessionFileEntry>) {
        if let Ok(read) = std::fs::read_dir(dir) {
            for entry in read.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk_files(&path, entries);
                } else if path.is_file() {
                    let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                    entries.push(SessionFileEntry {
                        file_path: path.to_string_lossy().to_string(),
                        tool_name: Some(format_file_size(size)),
                        turn_index: None,
                    });
                }
            }
        }
    }
    walk_files(&files_dir, &mut entries);
    Ok(entries)
}

fn format_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
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

    // The `plan_id` column may or may not exist depending on whether
    // the discipline-guardian migration has run. Probe sqlite_master and
    // pick the right SELECT.
    let has_plan_id: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('todos') WHERE name='plan_id'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);
    let sql = if has_plan_id {
        "SELECT id, title, description, status, plan_id FROM todos ORDER BY created_at DESC"
    } else {
        "SELECT id, title, description, status, NULL AS plan_id FROM todos ORDER BY created_at DESC"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SessionTodoEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                plan_id: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for entry in rows.flatten() {
        entries.push(entry);
    }
    Ok(entries)
}

// ── Plan tile commands ─────────────────────────────────────────────────
//
// These read the session DB (RO) for the data the Plan tile needs:
//   - all plans (active + superseded) for the History tab
//   - which plan_id is current (singleton row in current_plan)
//   - todo dependency edges for the Graph tab
//
// They all gracefully return empty/None when the corresponding tables or
// columns are missing — older session DBs predate the discipline
// extension's migration.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlanEntry {
    pub id: String,
    pub title: Option<String>,
    pub status: String,
    pub created_at: String,
    pub superseded_at: Option<String>,
    pub plan_md_snapshot: Option<String>,
}

fn open_session_db_ro(session_id: &str) -> Option<Connection> {
    let home = dirs::home_dir()?;
    let path = home
        .join(".copilot")
        .join("session-state")
        .join(session_id)
        .join("session.db");
    if !path.exists() {
        return None;
    }
    Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name = ?1",
        [name],
        |row| row.get(0),
    )
    .unwrap_or(false)
}

/// All plans (active + superseded), most recent first.
#[tauri::command]
fn query_session_plans(session_id: String) -> Result<Vec<PlanEntry>, String> {
    let conn = match open_session_db_ro(&session_id) {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    query_session_plans_impl(&conn)
}

fn query_session_plans_impl(conn: &Connection) -> Result<Vec<PlanEntry>, String> {
    if !table_exists(conn, "plans") {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, title, status, created_at, superseded_at, plan_md_snapshot
             FROM plans ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(PlanEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                status: row.get(2)?,
                created_at: row.get(3)?,
                superseded_at: row.get(4)?,
                plan_md_snapshot: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for r in rows.flatten() {
        entries.push(r);
    }
    Ok(entries)
}

/// The id of the plan referenced by `current_plan` (singleton row id=1),
/// or None if the table is missing / empty.
#[tauri::command]
fn query_session_current_plan(session_id: String) -> Result<Option<String>, String> {
    let conn = match open_session_db_ro(&session_id) {
        Some(c) => c,
        None => return Ok(None),
    };
    Ok(query_session_current_plan_impl(&conn))
}

fn query_session_current_plan_impl(conn: &Connection) -> Option<String> {
    if !table_exists(conn, "current_plan") {
        return None;
    }
    conn.query_row("SELECT plan_id FROM current_plan WHERE id = 1", [], |row| {
        row.get(0)
    })
    .ok()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TodoDepEntry {
    pub todo_id: String,
    pub depends_on: String,
}

/// Edges in the todo dependency graph: `depends_on` must be done before
/// `todo_id` can be started.
#[tauri::command]
fn query_session_todo_deps(session_id: String) -> Result<Vec<TodoDepEntry>, String> {
    let conn = match open_session_db_ro(&session_id) {
        Some(c) => c,
        None => return Ok(Vec::new()),
    };
    query_session_todo_deps_impl(&conn)
}

fn query_session_todo_deps_impl(conn: &Connection) -> Result<Vec<TodoDepEntry>, String> {
    if !table_exists(conn, "todo_deps") {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT todo_id, depends_on FROM todo_deps")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TodoDepEntry {
                todo_id: row.get(0)?,
                depends_on: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for r in rows.flatten() {
        entries.push(r);
    }
    Ok(entries)
}

// ── Session features (Plan tile redesign) ──────────────────────────────

/// Per-feature summary the redesigned Plan tile renders. Joins folder
/// state under `<session>/files/features/<name>/` with the session's
/// `plans` + `todos` SQLite tables. Field names are camelCase via serde
/// to match the TS `FeatureSummary` interface.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureSummary {
    pub name: String,
    pub has_grill_me: bool,
    pub has_plan: bool,
    pub grill_me_path: Option<String>,
    pub plan_path: Option<String>,
    pub plan_id: Option<String>,
    pub plan_title: Option<String>,
    pub plan_status: Option<String>,
    pub plan_created_at: Option<String>,
    pub derived_status: String,
    pub todos_total: i64,
    pub todos_done: i64,
    pub todos_in_progress: i64,
    pub todos_blocked: i64,
    pub last_touched_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionFeaturesPayload {
    pub features: Vec<FeatureSummary>,
    pub current_plan_id: Option<String>,
}

/// Raw plan row read from the session DB. We keep the parsed shape
/// internal so the reconciliation logic can operate on simple types.
#[derive(Debug, Clone)]
struct RawPlanRow {
    id: String,
    feature_name: String,
    title: String,
    status: String,
    created_at: String,
    todos_last_updated_at: Option<String>,
    todos_total: i64,
    todos_done: i64,
    todos_in_progress: i64,
    todos_blocked: i64,
}

/// Raw folder row stat'd from disk.
#[derive(Debug, Clone)]
struct RawFolderRow {
    name: String,
    has_grill_me: bool,
    has_plan: bool,
    grill_me_path: Option<String>,
    plan_path: Option<String>,
    files_last_mtime: Option<String>,
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let q = format!(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('{}') WHERE name = ?1",
        table
    );
    conn.query_row(&q, [column], |row| row.get::<_, bool>(0))
        .unwrap_or(false)
}

/// Reads `plans` joined with todo status counts. Returns empty when the
/// `plans` table doesn't exist OR the `feature_name` column hasn't been
/// added yet (only the feature-plan skill creates it; pre-skill DBs
/// don't have it).
fn read_session_plans(conn: &Connection) -> Vec<RawPlanRow> {
    if !table_exists(conn, "plans") {
        return Vec::new();
    }
    if !column_exists(conn, "plans", "feature_name") {
        return Vec::new();
    }
    let has_todos = table_exists(conn, "todos");
    let mut stmt = match conn.prepare(
        "SELECT id, feature_name, title, status, created_at FROM plans WHERE feature_name IS NOT NULL",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    });
    let mut out = Vec::new();
    let iter = match rows {
        Ok(it) => it,
        Err(_) => return out,
    };
    for r in iter.flatten() {
        let (id, feature_name, title, status, created_at) = r;
        let Some(feature_name) = feature_name else {
            continue;
        };
        let row = RawPlanRow {
            id: id.clone(),
            feature_name,
            title: title.unwrap_or_else(|| id.clone()),
            status: status.unwrap_or_else(|| "active".to_string()),
            created_at: created_at.unwrap_or_default(),
            todos_last_updated_at: None,
            todos_total: 0,
            todos_done: 0,
            todos_in_progress: 0,
            todos_blocked: 0,
        };
        out.push(row);
    }
    if has_todos {
        for row in out.iter_mut() {
            populate_todo_counts(conn, row);
        }
    }
    out
}

fn populate_todo_counts(conn: &Connection, row: &mut RawPlanRow) {
    // status counts
    let mut stmt = match conn
        .prepare("SELECT status, COUNT(*) FROM todos WHERE plan_id = ?1 GROUP BY status")
    {
        Ok(s) => s,
        Err(_) => return,
    };
    let iter = stmt.query_map([&row.id], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))
    });
    if let Ok(it) = iter {
        for r in it.flatten() {
            let (status, count) = r;
            row.todos_total += count;
            match status.as_deref() {
                Some("done") => row.todos_done += count,
                Some("in_progress") => row.todos_in_progress += count,
                Some("blocked") => row.todos_blocked += count,
                _ => {}
            }
        }
    }
    // latest updated_at (column may not exist on legacy todos tables)
    if column_exists(conn, "todos", "updated_at") {
        if let Ok(latest) = conn.query_row::<Option<String>, _, _>(
            "SELECT MAX(updated_at) FROM todos WHERE plan_id = ?1",
            [&row.id],
            |r| r.get(0),
        ) {
            row.todos_last_updated_at = latest;
        }
    }
}

/// Resolves `current_plan_id` from `session_state` (feature-plan skill)
/// or falls back to `current_plan.plan_id` (legacy discipline extension).
fn read_current_plan_id(conn: &Connection) -> Option<String> {
    if table_exists(conn, "session_state") {
        if let Ok(v) = conn.query_row::<Option<String>, _, _>(
            "SELECT value FROM session_state WHERE key = 'current_plan_id'",
            [],
            |r| r.get(0),
        ) {
            if v.is_some() {
                return v;
            }
        }
    }
    query_session_current_plan_impl(conn)
}

/// Walks `<session>/files/features/*` and returns one row per directory.
fn list_feature_folders(features_dir: &std::path::Path) -> Vec<RawFolderRow> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(features_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        let grill = path.join("grill-me.md");
        let plan = path.join("plan.md");
        let has_grill_me = grill.is_file();
        let has_plan = plan.is_file();
        let grill_me_path = if has_grill_me {
            Some(grill.to_string_lossy().to_string())
        } else {
            None
        };
        let plan_path = if has_plan {
            Some(plan.to_string_lossy().to_string())
        } else {
            None
        };
        let files_last_mtime = newest_mtime_iso(&[&grill, &plan]);
        out.push(RawFolderRow {
            name,
            has_grill_me,
            has_plan,
            grill_me_path,
            plan_path,
            files_last_mtime,
        });
    }
    out
}

fn newest_mtime_iso(paths: &[&std::path::Path]) -> Option<String> {
    let mut newest: Option<std::time::SystemTime> = None;
    for p in paths {
        if let Ok(meta) = std::fs::metadata(p) {
            if let Ok(m) = meta.modified() {
                newest = Some(match newest {
                    Some(prev) if prev > m => prev,
                    _ => m,
                });
            }
        }
    }
    newest.and_then(system_time_to_iso)
}

fn system_time_to_iso(t: std::time::SystemTime) -> Option<String> {
    let dur = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    let secs = dur.as_secs() as i64;
    let nanos = dur.subsec_nanos();
    // Minimal ISO-8601 UTC; same string-compare ordering as the TS side.
    let (year, month, day, hour, min, sec) = epoch_to_ymd_hms(secs);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year,
        month,
        day,
        hour,
        min,
        sec,
        nanos / 1_000_000
    ))
}

/// Pure helper: epoch seconds → (year, month, day, hour, min, sec) in UTC.
/// Hand-rolled because we don't want a `chrono` dependency for one timestamp.
fn epoch_to_ymd_hms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let seconds_in_day = secs.rem_euclid(86_400) as u32;
    let hour = seconds_in_day / 3600;
    let min = (seconds_in_day % 3600) / 60;
    let sec = seconds_in_day % 60;
    // Days since 1970-01-01 → civil date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y } as i32;
    (year, m, d, hour, min, sec)
}

/// Reconciles folder list + plan list into the final summaries.
/// Mirrors the TS `reconcileFeatures` in `src/domain/feature-discovery.ts`.
fn reconcile_features(folders: Vec<RawFolderRow>, plans: Vec<RawPlanRow>) -> Vec<FeatureSummary> {
    // Latest-wins per feature_name.
    let mut latest: std::collections::HashMap<String, RawPlanRow> =
        std::collections::HashMap::new();
    for p in plans {
        let key = p.feature_name.clone();
        if let Some(existing) = latest.get(&key) {
            if p.created_at > existing.created_at {
                latest.insert(key, p);
            }
        } else {
            latest.insert(key, p);
        }
    }
    let folder_names: std::collections::HashSet<String> =
        folders.iter().map(|f| f.name.clone()).collect();

    let mut sorted_folders = folders;
    sorted_folders.sort_by(|a, b| a.name.cmp(&b.name));

    let mut out = Vec::new();
    for folder in &sorted_folders {
        let plan = latest.get(&folder.name).cloned();
        out.push(make_summary(folder, plan.as_ref()));
    }
    let mut orphans: Vec<RawPlanRow> = latest
        .into_values()
        .filter(|p| !folder_names.contains(&p.feature_name))
        .collect();
    orphans.sort_by(|a, b| a.feature_name.cmp(&b.feature_name));
    for p in orphans {
        out.push(make_orphan_summary(&p));
    }
    out
}

fn make_summary(folder: &RawFolderRow, plan: Option<&RawPlanRow>) -> FeatureSummary {
    let derived_status = match plan.map(|p| p.status.as_str()) {
        Some("completed") => "completed",
        Some("archived") => "archived",
        Some("active") | Some(_) if plan.is_some() => "active",
        _ => "drafting",
    }
    .to_string();
    let last_touched_at = compute_last_touched(folder.files_last_mtime.as_deref(), plan);
    FeatureSummary {
        name: folder.name.clone(),
        has_grill_me: folder.has_grill_me,
        has_plan: folder.has_plan,
        grill_me_path: folder.grill_me_path.clone(),
        plan_path: folder.plan_path.clone(),
        plan_id: plan.map(|p| p.id.clone()),
        plan_title: plan.map(|p| p.title.clone()),
        plan_status: plan.map(|p| p.status.clone()),
        plan_created_at: plan.map(|p| p.created_at.clone()),
        derived_status,
        todos_total: plan.map(|p| p.todos_total).unwrap_or(0),
        todos_done: plan.map(|p| p.todos_done).unwrap_or(0),
        todos_in_progress: plan.map(|p| p.todos_in_progress).unwrap_or(0),
        todos_blocked: plan.map(|p| p.todos_blocked).unwrap_or(0),
        last_touched_at,
    }
}

fn make_orphan_summary(p: &RawPlanRow) -> FeatureSummary {
    FeatureSummary {
        name: p.feature_name.clone(),
        has_grill_me: false,
        has_plan: false,
        grill_me_path: None,
        plan_path: None,
        plan_id: Some(p.id.clone()),
        plan_title: Some(p.title.clone()),
        plan_status: Some(p.status.clone()),
        plan_created_at: Some(p.created_at.clone()),
        derived_status: "orphan".to_string(),
        todos_total: p.todos_total,
        todos_done: p.todos_done,
        todos_in_progress: p.todos_in_progress,
        todos_blocked: p.todos_blocked,
        last_touched_at: p
            .todos_last_updated_at
            .clone()
            .unwrap_or_else(|| p.created_at.clone()),
    }
}

fn compute_last_touched(files_mtime: Option<&str>, plan: Option<&RawPlanRow>) -> String {
    let candidates: Vec<&str> = [
        files_mtime,
        plan.and_then(|p| p.todos_last_updated_at.as_deref()),
        plan.map(|p| p.created_at.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|s| !s.is_empty())
    .collect();
    if candidates.is_empty() {
        return String::new();
    }
    candidates
        .into_iter()
        .max()
        .map(String::from)
        .unwrap_or_default()
}

#[tauri::command]
fn list_session_features(session_id: String) -> Result<SessionFeaturesPayload, String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let session_dir = home
        .join(".copilot")
        .join("session-state")
        .join(&session_id);
    if !session_dir.is_dir() {
        return Ok(SessionFeaturesPayload {
            features: Vec::new(),
            current_plan_id: None,
        });
    }
    let features_dir = session_dir.join("files").join("features");
    let folders = if features_dir.is_dir() {
        list_feature_folders(&features_dir)
    } else {
        Vec::new()
    };
    let (plans, current_plan_id) = match open_session_db_ro(&session_id) {
        Some(conn) => (read_session_plans(&conn), read_current_plan_id(&conn)),
        None => (Vec::new(), None),
    };
    let features = reconcile_features(folders, plans);
    Ok(SessionFeaturesPayload {
        features,
        current_plan_id,
    })
}

/// Highest mtime across the features dir tree + the session DB. Used by
/// the per-session polling loop to detect "something changed".
fn session_features_signature(session_id: &str) -> Option<std::time::SystemTime> {
    let home = dirs::home_dir()?;
    let session_dir = home.join(".copilot").join("session-state").join(session_id);
    let mut newest: Option<std::time::SystemTime> = None;
    let mut bump = |t: std::time::SystemTime| {
        newest = Some(match newest {
            Some(prev) if prev > t => prev,
            _ => t,
        });
    };
    // Session DB mtime.
    let db = session_dir.join("session.db");
    if let Ok(meta) = std::fs::metadata(&db) {
        if let Ok(m) = meta.modified() {
            bump(m);
        }
    }
    // Features dir tree: just iterate the immediate folder + 1 level
    // of files (grill-me.md, plan.md). That covers the skill's writes
    // without paying for a recursive walk.
    let features_dir = session_dir.join("files").join("features");
    if let Ok(entries) = std::fs::read_dir(&features_dir) {
        for e in entries.flatten() {
            if let Ok(meta) = std::fs::metadata(e.path()) {
                if let Ok(m) = meta.modified() {
                    bump(m);
                }
            }
            if let Ok(inner) = std::fs::read_dir(e.path()) {
                for f in inner.flatten() {
                    if let Ok(meta) = std::fs::metadata(f.path()) {
                        if let Ok(m) = meta.modified() {
                            bump(m);
                        }
                    }
                }
            }
        }
    }
    newest
}

#[tauri::command]
fn watch_session_features(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut guard = state.features_watchers.lock().unwrap();
    if guard.contains_key(&session_id) {
        return Ok(()); // idempotent
    }
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_clone = stop.clone();
    let session = session_id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        // Baseline so the first tick doesn't emit if nothing has changed
        // since the watcher was started.
        let mut last = session_features_signature(&session);
        while !stop_clone.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if stop_clone.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            let current = session_features_signature(&session);
            if current != last {
                last = current;
                let _ = app_clone.emit(
                    "session-features-changed",
                    serde_json::json!({ "sessionId": session.clone() }),
                );
            }
        }
    });
    guard.insert(session_id, FeaturesWatcherHandle { stop });
    Ok(())
}

#[tauri::command]
fn unwatch_session_features(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut guard = state.features_watchers.lock().unwrap();
    guard.remove(&session_id); // Drop impl signals the thread to stop
    Ok(())
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

fn open_db_readonly(path: &std::path::Path) -> Result<Connection, String> {
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }
    Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())
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
    open_db_readonly(&session_db_path)
}

fn list_db_tables_at(conn: &Connection) -> Result<Vec<SessionDbTable>, String> {
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
            .query_row(&format!("SELECT COUNT(*) FROM [{}]", name), [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        tables.push(SessionDbTable {
            name,
            row_count: count,
        });
    }
    Ok(tables)
}

fn query_db_table_at(
    conn: &Connection,
    table_name: &str,
    limit: i64,
) -> Result<SessionDbTableData, String> {
    let col_stmt = conn
        .prepare(&format!("SELECT * FROM [{}] LIMIT 0", table_name))
        .map_err(|e| e.to_string())?;
    let columns: Vec<String> = col_stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    drop(col_stmt);

    let mut stmt = conn
        .prepare(&format!("SELECT * FROM [{}] LIMIT {}", table_name, limit))
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

    Ok(SessionDbTableData {
        columns,
        rows: rows_out,
    })
}

#[tauri::command]
fn list_session_db_tables(session_id: String) -> Result<Vec<SessionDbTable>, String> {
    let conn = open_session_db(&session_id)?;
    list_db_tables_at(&conn)
}

#[tauri::command]
fn query_session_db_table(
    session_id: String,
    table_name: String,
    limit: Option<i64>,
) -> Result<SessionDbTableData, String> {
    let conn = open_session_db(&session_id)?;
    query_db_table_at(&conn, &table_name, limit.unwrap_or(100))
}

/// Read-only SQLite browsing for arbitrary files (used by Repo Explorer).
#[tauri::command]
fn list_db_tables(path: String) -> Result<Vec<SessionDbTable>, String> {
    let conn = open_db_readonly(std::path::Path::new(&path))?;
    list_db_tables_at(&conn)
}

#[tauri::command]
fn query_db_table(
    path: String,
    table_name: String,
    limit: Option<i64>,
) -> Result<SessionDbTableData, String> {
    let conn = open_db_readonly(std::path::Path::new(&path))?;
    query_db_table_at(&conn, &table_name, limit.unwrap_or(100))
}

/// Sniff the SQLite magic header ("SQLite format 3\0") at offset 0 to
/// confirm whether a file is a SQLite database. Cheap (16 bytes read),
/// catches files with non-standard extensions.
#[tauri::command]
fn is_sqlite_file(path: String) -> Result<bool, String> {
    use std::io::Read;
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(false),
    };
    let mut header = [0u8; 16];
    match file.read_exact(&mut header) {
        Ok(()) => Ok(&header == b"SQLite format 3\0"),
        Err(_) => Ok(false),
    }
}

// ── App Setup ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = db::resolve_db_path();
    eprintln!("[workstreams] using DB: {}", db_path.display());

    let conn = open_db(&db_path).expect("Failed to initialize database");

    let poller = Arc::new(SessionPoller::new());
    let fs_watcher = Arc::new(FsWatcher::new());
    let fs_watcher_clone = fs_watcher.clone();

    let app_state = AppState {
        db: Mutex::new(conn),
        pty: PtyManager::new(),
        session_poller: poller.clone(),
        fs_watcher,
        search_epoch: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        features_watchers: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        .manage(file_io::WatcherState::new())
        .setup(move |app| {
            // Start the session stats poller background thread
            session_poller::start_poller(app.handle().clone(), poller);
            // Start the filesystem watcher
            fs_watcher_clone.start(app.handle().clone());
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
            change_workstream_worktree,
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
            spawn_copilot_session,
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
            read_file_base64,
            path_exists,
            list_directory,
            detect_git_info,
            create_git_repo,
            detect_worktree_info,
            search_files,
            search_in_files,
            cancel_searches,
            file_io::read_text_file,
            file_io::write_text_file,
            file_io::canonicalize_path,
            file_io::watch_file_changes,
            file_io::unwatch_file_changes,
            ping,
            // Git diff
            git_diff_files,
            git_diff_file,
            git_diff_files_with_status,
            git_diff_file_sides,
            // Copilot config
            discover_copilot_config,
            // Session files & todos & DB
            read_session_file,
            session_state_dir,
            list_session_checkpoints,
            list_session_events,
            query_session_files,
            query_session_todos,
            query_session_plans,
            query_session_current_plan,
            query_session_todo_deps,
            list_session_features,
            watch_session_features,
            unwatch_session_features,
            list_session_db_tables,
            query_session_db_table,
            list_db_tables,
            query_db_table,
            is_sqlite_file,
            // Git log & branch
            git_log,
            git_branch_tracking_info,
            git_show_commit,
            git_current_branch,
            create_worktree,
            git_list_branches,
            // Settings
            get_setting,
            set_setting,
            // Git hooks
            list_git_hooks,
            // Filesystem watcher
            watch_directory,
            unwatch_directory,
            // Diff Review (diff-grok)
            diff_review::create_diff_review,
            diff_review::set_review_plan,
            diff_review::get_review,
            diff_review::list_active_diff_reviews,
            diff_review::create_or_focus_diff_review_tile,
            diff_review::list_chunks,
            diff_review::get_chunk_details,
            diff_review::activate_chunk,
            diff_review::ack_chunk,
            diff_review::add_comment,
            diff_review::complete_review,
            diff_review::detect_drift,
            file_comments::list_file_comments,
            file_comments::add_file_comment,
            file_comments::update_file_comment,
            file_comments::delete_file_comment,
            file_comments::import_pr_comments,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rewrite_tile_cwd_updates_terminal_cwd() {
        let out = rewrite_tile_cwd(r#"{"cwd":"C:/old","shell":"pwsh"}"#, "terminal", "C:/new")
            .expect("terminal config should rewrite");
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["cwd"], "C:/new");
        assert_eq!(json["shell"], "pwsh");
    }

    #[test]
    fn rewrite_tile_cwd_adds_cwd_when_missing() {
        let out = rewrite_tile_cwd(r#"{"shell":"pwsh"}"#, "terminal", "C:/new")
            .expect("terminal config should rewrite");
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["cwd"], "C:/new");
        assert_eq!(json["shell"], "pwsh");
    }

    #[test]
    fn rewrite_tile_cwd_updates_copilot_session_cwd() {
        let out = rewrite_tile_cwd(
            r#"{"cwd":"C:/old","sessionName":"main"}"#,
            "copilot_session",
            "C:/new",
        )
        .expect("copilot session config should rewrite");
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["cwd"], "C:/new");
        assert_eq!(json["sessionName"], "main");
    }

    #[test]
    fn rewrite_tile_cwd_leaves_other_types_alone() {
        let out = rewrite_tile_cwd(r#"{"root":"C:/repo"}"#, "file_explorer", "C:/new")
            .expect("non-cwd tile config should parse");
        let json: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(json["root"], "C:/repo");
        assert!(json.get("cwd").is_none());
    }

    #[test]
    fn rewrite_tile_cwd_errors_on_malformed_json() {
        let err = rewrite_tile_cwd("{ not json", "terminal", "C:/new").unwrap_err();
        assert!(err.contains("Invalid tile config JSON"));
    }

    #[test]
    fn search_in_files_finds_matches_case_insensitive() {
        let tmp = std::env::temp_dir().join(format!("rxs-search-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f1 = tmp.join("alpha.txt");
        let f2 = tmp.join("beta.txt");
        {
            let mut h = std::fs::File::create(&f1).unwrap();
            writeln!(h, "Hello World").unwrap();
            writeln!(h, "another line").unwrap();
        }
        {
            let mut h = std::fs::File::create(&f2).unwrap();
            writeln!(h, "nothing here").unwrap();
            writeln!(h, "wOrLd peace").unwrap();
        }
        let never_cancel = || false;
        let res = search_in_files_impl(tmp.to_str().unwrap(), "world", 200, &never_cancel);
        assert_eq!(res.len(), 2, "should find two matches (case-insensitive)");
        assert!(res
            .iter()
            .any(|m| m.path.contains("alpha.txt") && m.line_number == 1));
        assert!(res
            .iter()
            .any(|m| m.path.contains("beta.txt") && m.line_number == 2));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn search_in_files_empty_query_returns_empty() {
        let never_cancel = || false;
        let res = search_in_files_impl(".", "", 200, &never_cancel);
        assert!(res.is_empty());
    }

    #[test]
    fn search_in_files_respects_cancellation() {
        let tmp = std::env::temp_dir().join(format!("rxs-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let f = tmp.join("alpha.txt");
        let mut h = std::fs::File::create(&f).unwrap();
        for i in 0..1000 {
            writeln!(h, "needle on line {i}").unwrap();
        }
        drop(h);
        // Cancel immediately
        let always_cancel = || true;
        let res = search_in_files_impl(tmp.to_str().unwrap(), "needle", 200, &always_cancel);
        assert!(res.is_empty(), "cancellation should yield empty results");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn search_in_files_skips_binary_extensions() {
        let tmp = std::env::temp_dir().join(format!("rxs-binskip-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let txt = tmp.join("text.txt");
        let bin = tmp.join("blob.bin");
        std::fs::write(&txt, "hello needle world").unwrap();
        std::fs::write(&bin, "hello needle world").unwrap();
        let never_cancel = || false;
        let res = search_in_files_impl(tmp.to_str().unwrap(), "needle", 200, &never_cancel);
        assert_eq!(
            res.len(),
            1,
            "only the .txt file should match; .bin is skipped"
        );
        assert!(res[0].path.contains("text.txt"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn search_files_skips_hidden_and_skip_dirs() {
        let tmp = std::env::temp_dir().join(format!("rxs-skipdirs-{}", std::process::id()));
        let nested = tmp.join("node_modules");
        let hidden = tmp.join(".git");
        let visible = tmp.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::create_dir_all(&visible).unwrap();
        std::fs::write(nested.join("needle.ts"), "").unwrap();
        std::fs::write(hidden.join("needle.txt"), "").unwrap();
        std::fs::write(visible.join("needle.rs"), "").unwrap();
        let never_cancel = || false;
        let res = search_files_impl(tmp.to_str().unwrap(), "needle", 50, &never_cancel);
        assert_eq!(res.len(), 1, "only src/needle.rs should be found");
        assert!(res[0].contains("needle.rs"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn is_text_extension_recognizes_common_code_files() {
        assert!(is_text_extension("foo.ts"));
        assert!(is_text_extension("Foo.CS"));
        assert!(is_text_extension("script.py"));
        assert!(is_text_extension("Dockerfile"));
        assert!(!is_text_extension("blob.bin"));
        assert!(!is_text_extension("image.png"));
        assert!(!is_text_extension("compiled.exe"));
    }

    #[test]
    fn now_returns_non_empty_string() {
        let n = now();
        assert!(!n.is_empty());
        // Should parse as a u64 (epoch seconds)
        assert!(n.parse::<u64>().is_ok());
    }

    #[test]
    fn now_is_recent() {
        let n: u64 = now().parse().unwrap();
        let actual = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Within 5 seconds
        assert!((actual as i64 - n as i64).abs() < 5);
    }

    #[test]
    fn format_file_size_bytes() {
        assert_eq!(format_file_size(0), "0B");
        assert_eq!(format_file_size(500), "500B");
        assert_eq!(format_file_size(1023), "1023B");
    }

    #[test]
    fn format_file_size_kilobytes() {
        assert_eq!(format_file_size(1024), "1.0KB");
        assert_eq!(format_file_size(2048), "2.0KB");
        assert_eq!(format_file_size(1024 * 1024 - 1), "1024.0KB");
    }

    #[test]
    fn format_file_size_megabytes() {
        assert_eq!(format_file_size(1024 * 1024), "1.0MB");
        assert_eq!(format_file_size(5 * 1024 * 1024), "5.0MB");
    }

    #[test]
    fn detect_git_remote_returns_none_for_missing_dir() {
        let result = detect_git_remote("/nonexistent/path/to/repo");
        assert!(result.is_none());
    }

    #[test]
    fn detect_git_remote_parses_origin_url() {
        let tmp = std::env::temp_dir().join(format!("ws_git_test_{}", std::process::id()));
        let git_dir = tmp.join(".git");
        std::fs::create_dir_all(&git_dir).ok();
        let config_content = r#"[remote "origin"]
    url = https://github.com/user/repo.git
    fetch = +refs/heads/*:refs/remotes/origin/*
"#;
        std::fs::write(git_dir.join("config"), config_content).ok();
        let result = detect_git_remote(tmp.to_str().unwrap());
        assert_eq!(result, Some("https://github.com/user/repo.git".to_string()));
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn detect_git_remote_returns_none_for_no_origin() {
        let tmp = std::env::temp_dir().join(format!("ws_git_no_origin_{}", std::process::id()));
        let git_dir = tmp.join(".git");
        std::fs::create_dir_all(&git_dir).ok();
        std::fs::write(git_dir.join("config"), "[core]\n").ok();
        let result = detect_git_remote(tmp.to_str().unwrap());
        assert!(result.is_none());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn read_skill_description_extracts_from_frontmatter() {
        let tmp = std::env::temp_dir().join(format!("ws_skill_{}.md", std::process::id()));
        let content = r#"---
name: test-skill
description: A test skill for unit tests
---
# Test Skill
Body here.
"#;
        std::fs::write(&tmp, content).ok();
        let desc = read_skill_description(&tmp);
        // Frontmatter parsing returns the first line after the closing ---
        assert!(desc.is_some());
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn read_skill_description_returns_none_for_missing_file() {
        let desc = read_skill_description(std::path::Path::new("/nonexistent/skill.md"));
        assert!(desc.is_none());
    }

    #[test]
    fn read_skill_description_falls_back_to_first_line() {
        let tmp = std::env::temp_dir().join(format!("ws_skill_no_fm_{}.md", std::process::id()));
        std::fs::write(&tmp, "# My Skill\nThis is the body").ok();
        let desc = read_skill_description(&tmp);
        assert_eq!(desc, Some("# My Skill".to_string()));
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn git_cmd_returns_git_command() {
        let cmd = git_cmd();
        assert_eq!(cmd.get_program(), "git");
    }

    #[test]
    fn list_session_checkpoints_returns_empty_for_missing_dir() {
        let result = list_session_checkpoints("nonexistent-session-id-12345".to_string());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn list_session_checkpoints_parses_index_md() {
        let session_id = format!("ws_cp_test_{}", std::process::id());
        let home = dirs::home_dir().expect("home dir");
        let cp_dir = home
            .join(".copilot")
            .join("session-state")
            .join(&session_id)
            .join("checkpoints");
        std::fs::create_dir_all(&cp_dir).ok();
        let content = r#"# Checkpoint History

| # | Title | File |
|---|-------|------|
| 1 | First checkpoint | 001-first.md |
| 2 | Second checkpoint | 002-second.md |
"#;
        std::fs::write(cp_dir.join("index.md"), content).ok();
        let result = list_session_checkpoints(session_id.clone()).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].number, 1);
        assert_eq!(result[0].title, "First checkpoint");
        assert_eq!(result[0].file_name, "001-first.md");
        assert_eq!(result[1].number, 2);
        // Cleanup
        std::fs::remove_dir_all(
            home.join(".copilot")
                .join("session-state")
                .join(&session_id),
        )
        .ok();
    }

    #[test]
    fn list_session_events_returns_empty_for_missing_file() {
        let result = list_session_events("nonexistent-session-id-12345".to_string(), Some(10));
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn list_session_events_parses_jsonl() {
        let session_id = format!("ws_events_test_{}", std::process::id());
        let home = dirs::home_dir().expect("home dir");
        let session_dir = home
            .join(".copilot")
            .join("session-state")
            .join(&session_id);
        std::fs::create_dir_all(&session_dir).ok();
        let events_path = session_dir.join("events.jsonl");
        let mut f = std::fs::File::create(&events_path).unwrap();
        writeln!(
            f,
            r#"{{"type":"user.message","timestamp":"2026-01-01T00:00:00Z"}}"#
        )
        .unwrap();
        writeln!(f, r#"{{"type":"tool.execution_start","timestamp":"2026-01-01T00:00:01Z","data":{{"toolName":"powershell"}}}}"#).unwrap();
        writeln!(
            f,
            r#"{{"type":"hook.start","timestamp":"2026-01-01T00:00:02Z"}}"#
        )
        .unwrap();
        drop(f);

        let events = list_session_events(session_id.clone(), Some(100)).unwrap();
        // Hook events filtered out
        assert!(events.iter().all(|e| !e.event_type.starts_with("hook.")));
        // Should have user.message and tool.execution_start
        assert!(events.iter().any(|e| e.event_type == "user.message"));
        let tool_evt = events
            .iter()
            .find(|e| e.event_type == "tool.execution_start");
        assert!(tool_evt.is_some());
        assert_eq!(tool_evt.unwrap().tool, Some("powershell".to_string()));
        std::fs::remove_dir_all(session_dir).ok();
    }

    #[test]
    fn query_session_files_lists_files_dir() {
        let session_id = format!("ws_files_test_{}", std::process::id());
        let home = dirs::home_dir().expect("home dir");
        let files_dir = home
            .join(".copilot")
            .join("session-state")
            .join(&session_id)
            .join("files");
        std::fs::create_dir_all(&files_dir).ok();
        std::fs::write(files_dir.join("notes.md"), "test content").ok();
        std::fs::write(files_dir.join("data.json"), "{}").ok();

        let files = query_session_files(session_id.clone()).unwrap();
        assert_eq!(files.len(), 2);
        let names: Vec<String> = files
            .iter()
            .map(|f| {
                f.file_path
                    .split(['\\', '/'])
                    .next_back()
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert!(names.contains(&"notes.md".to_string()));
        assert!(names.contains(&"data.json".to_string()));

        std::fs::remove_dir_all(
            home.join(".copilot")
                .join("session-state")
                .join(&session_id),
        )
        .ok();
    }

    #[test]
    fn query_session_files_returns_empty_for_missing_dir() {
        let result = query_session_files("nonexistent-session-id-67890".to_string());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    // ── Plan-tile backend tests ─────────────────────────────────────────
    //
    // We test the `_impl` helpers (which take a Connection directly) so
    // we don't depend on dirs::home_dir(). The integration with the file
    // path lives in the tauri command shells (untested here, exercised
    // by CDP + Playwright instead).

    fn fresh_mem_db() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    #[test]
    fn query_session_plans_returns_rows_newest_first() {
        let conn = fresh_mem_db();
        conn.execute_batch(
            "CREATE TABLE plans (id TEXT PRIMARY KEY, title TEXT, status TEXT NOT NULL,
             created_at TEXT NOT NULL, superseded_at TEXT, plan_md_snapshot TEXT);
             INSERT INTO plans VALUES ('plan-1','First','superseded','2026-01-01',NULL,'old md');
             INSERT INTO plans VALUES ('plan-2','Second','active','2026-02-01',NULL,'new md');",
        )
        .unwrap();
        let plans = query_session_plans_impl(&conn).unwrap();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].id, "plan-2"); // newest first
        assert_eq!(plans[0].status, "active");
        assert_eq!(plans[1].id, "plan-1");
        assert_eq!(plans[1].plan_md_snapshot.as_deref(), Some("old md"));
    }

    #[test]
    fn query_session_plans_returns_empty_when_table_missing() {
        let conn = fresh_mem_db();
        let plans = query_session_plans_impl(&conn).unwrap();
        assert!(plans.is_empty());
    }

    #[test]
    fn query_session_current_plan_returns_singleton_value() {
        let conn = fresh_mem_db();
        conn.execute_batch(
            "CREATE TABLE current_plan (id INTEGER PRIMARY KEY, plan_id TEXT);
             INSERT INTO current_plan (id, plan_id) VALUES (1, 'plan-abc');",
        )
        .unwrap();
        assert_eq!(
            query_session_current_plan_impl(&conn),
            Some("plan-abc".to_string())
        );
    }

    #[test]
    fn query_session_current_plan_returns_none_when_table_missing() {
        let conn = fresh_mem_db();
        assert_eq!(query_session_current_plan_impl(&conn), None);
    }

    #[test]
    fn query_session_current_plan_returns_none_when_table_empty() {
        let conn = fresh_mem_db();
        conn.execute_batch("CREATE TABLE current_plan (id INTEGER PRIMARY KEY, plan_id TEXT);")
            .unwrap();
        assert_eq!(query_session_current_plan_impl(&conn), None);
    }

    #[test]
    fn query_session_todo_deps_returns_edges() {
        let conn = fresh_mem_db();
        conn.execute_batch(
            "CREATE TABLE todo_deps (todo_id TEXT, depends_on TEXT);
             INSERT INTO todo_deps VALUES ('a','b');
             INSERT INTO todo_deps VALUES ('a','c');
             INSERT INTO todo_deps VALUES ('b','d');",
        )
        .unwrap();
        let deps = query_session_todo_deps_impl(&conn).unwrap();
        assert_eq!(deps.len(), 3);
        let edge_set: std::collections::HashSet<_> = deps
            .iter()
            .map(|d| (d.todo_id.clone(), d.depends_on.clone()))
            .collect();
        assert!(edge_set.contains(&("a".to_string(), "b".to_string())));
        assert!(edge_set.contains(&("a".to_string(), "c".to_string())));
        assert!(edge_set.contains(&("b".to_string(), "d".to_string())));
    }

    #[test]
    fn query_session_todo_deps_returns_empty_when_table_missing() {
        let conn = fresh_mem_db();
        let deps = query_session_todo_deps_impl(&conn).unwrap();
        assert!(deps.is_empty());
    }

    // ── PTY env injection ──────────────────────────────────────────────

    fn setup_tiles_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE tiles (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL);
             INSERT INTO tiles VALUES ('tile-1','ws-abc');
             INSERT INTO tiles VALUES ('tile-2','ws-xyz');",
        )
        .unwrap();
    }

    #[test]
    fn workstream_env_returns_active_ws_and_tile_for_known_tile() {
        let conn = fresh_mem_db();
        setup_tiles_table(&conn);
        let env = workstream_env_from_db(&conn, "tile-1").expect("env should be Some");
        assert_eq!(
            env.get("WORKSTREAMS_ACTIVE_WS").map(String::as_str),
            Some("ws-abc")
        );
        assert_eq!(
            env.get("WORKSTREAMS_ACTIVE_TILE").map(String::as_str),
            Some("tile-1")
        );
    }

    #[test]
    fn workstream_env_returns_none_for_unknown_tile() {
        let conn = fresh_mem_db();
        setup_tiles_table(&conn);
        assert!(workstream_env_from_db(&conn, "tile-missing").is_none());
    }

    #[test]
    fn workstream_env_returns_none_when_tiles_table_missing() {
        let conn = fresh_mem_db();
        assert!(workstream_env_from_db(&conn, "tile-1").is_none());
    }

    #[test]
    fn git_diff_files_unstaged_includes_untracked() {
        let tmp = std::env::temp_dir().join(format!(
            "ws-gitdiff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let dir_str = tmp.to_string_lossy().to_string();

        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .output()
                .expect("git invoke")
        };

        assert!(run(&["init", "-q"]).status.success());
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        // Commit a tracked file
        std::fs::write(tmp.join("kept.txt"), "v1\n").unwrap();
        run(&["add", "kept.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        // Modify tracked + add untracked
        std::fs::write(tmp.join("kept.txt"), "v2\n").unwrap();
        std::fs::write(tmp.join("brand-new.txt"), "hello\n").unwrap();

        let files =
            git_diff_files(dir_str.clone(), "unstaged".into()).expect("git_diff_files unstaged");
        assert!(
            files.iter().any(|f| f == "kept.txt"),
            "modified tracked should be listed: {files:?}"
        );
        assert!(
            files.iter().any(|f| f == "brand-new.txt"),
            "untracked file should be listed: {files:?}"
        );

        let diff = git_diff_file(dir_str, "brand-new.txt".into(), "unstaged".into())
            .expect("git_diff_file unstaged for untracked");
        assert!(
            diff.contains("brand-new.txt") && diff.contains("hello"),
            "untracked diff should contain filename + content; got: {diff}"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn git_diff_files_with_status_and_sides() {
        let tmp = std::env::temp_dir().join(format!(
            "ws-gitsides-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let dir_str = tmp.to_string_lossy().to_string();
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&tmp)
                .output()
                .expect("git invoke")
        };
        assert!(run(&["init", "-q"]).status.success());
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(tmp.join("kept.txt"), "v1\nshared\n").unwrap();
        run(&["add", "kept.txt"]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(tmp.join("kept.txt"), "v2\nshared\n").unwrap();
        std::fs::write(tmp.join("new.txt"), "brand new\n").unwrap();

        let files =
            git_diff_files_with_status(dir_str.clone(), "unstaged".into()).expect("with_status");
        let kept = files.iter().find(|(p, _)| p == "kept.txt").expect("kept");
        assert_eq!(kept.1, "M");
        let added = files.iter().find(|(p, _)| p == "new.txt").expect("new");
        assert_eq!(added.1, "A");

        let (before, after) =
            git_diff_file_sides(dir_str.clone(), "kept.txt".into(), "unstaged".into())
                .expect("sides");
        assert!(before.contains("v1") && !before.contains("v2"));
        assert!(after.contains("v2") && !after.contains("v1"));

        let (before2, after2) =
            git_diff_file_sides(dir_str.clone(), "new.txt".into(), "unstaged".into())
                .expect("sides untracked");
        assert_eq!(before2, "");
        assert!(after2.contains("brand new"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn git_branch_tracking_info_reports_ahead_behind_and_remote_head() {
        let tmp = std::env::temp_dir().join(format!(
            "ws-tracking-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        let dir_str = tmp.to_string_lossy().to_string();
        let run = |cwd: &std::path::Path, args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .expect("git invoke")
        };

        // Set up bare remote + local clone simulating "origin".
        let remote = tmp.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        assert!(run(&remote, &["init", "--bare", "-q"]).status.success());

        let local = tmp.join("local");
        std::fs::create_dir_all(&local).unwrap();
        assert!(run(&local, &["init", "-q", "-b", "main"]).status.success());
        run(&local, &["config", "user.email", "t@t"]);
        run(&local, &["config", "user.name", "t"]);
        std::fs::write(local.join("a.txt"), "1\n").unwrap();
        run(&local, &["add", "."]);
        run(&local, &["commit", "-q", "-m", "c1"]);
        run(
            &local,
            &["remote", "add", "origin", remote.to_string_lossy().as_ref()],
        );
        run(&local, &["push", "-q", "-u", "origin", "main"]);

        // Now local is even with origin/main.
        let (ahead, behind, short) =
            git_branch_tracking_info(local.to_string_lossy().to_string()).expect("tracking");
        assert_eq!(ahead, 0);
        assert_eq!(behind, 0);
        assert_eq!(short.len(), 7);

        // Add one local commit -> ahead 1, behind 0.
        std::fs::write(local.join("a.txt"), "2\n").unwrap();
        run(&local, &["add", "."]);
        run(&local, &["commit", "-q", "-m", "c2"]);
        let (ahead2, behind2, _) =
            git_branch_tracking_info(local.to_string_lossy().to_string()).expect("tracking");
        assert_eq!(ahead2, 1);
        assert_eq!(behind2, 0);

        // No-branch directory returns empty short hash.
        let empty = tmp.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        run(&empty, &["init", "-q"]);
        let (_, _, short_empty) =
            git_branch_tracking_info(empty.to_string_lossy().to_string()).expect("tracking");
        assert_eq!(short_empty, "");

        std::fs::remove_dir_all(&tmp).ok();
        let _ = dir_str; // silence unused warning
    }

    #[test]
    fn is_sqlite_file_detects_magic_header() {
        let tmp = std::env::temp_dir().join(format!(
            "ws-sqlite-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).unwrap();

        let real_db = tmp.join("real.db");
        std::fs::write(&real_db, b"SQLite format 3\0extra payload").unwrap();
        assert!(is_sqlite_file(real_db.to_string_lossy().to_string()).unwrap());

        let plain = tmp.join("plain.txt");
        std::fs::write(&plain, b"# just markdown\nhello").unwrap();
        assert!(!is_sqlite_file(plain.to_string_lossy().to_string()).unwrap());

        let too_short = tmp.join("short.bin");
        std::fs::write(&too_short, b"abc").unwrap();
        assert!(!is_sqlite_file(too_short.to_string_lossy().to_string()).unwrap());

        // Non-existent path returns Ok(false) instead of an error.
        assert!(!is_sqlite_file(tmp.join("missing").to_string_lossy().to_string()).unwrap());

        std::fs::remove_dir_all(&tmp).ok();
    }

    // ── list_session_features tests ────────────────────────────────────

    fn fresh_features_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // Mimics what the feature-plan skill creates on first run.
        conn.execute_batch(
            "CREATE TABLE plans (
                id TEXT PRIMARY KEY,
                title TEXT,
                status TEXT,
                created_at TEXT,
                superseded_at TEXT,
                plan_md_snapshot TEXT,
                feature_name TEXT,
                updated_at TEXT
             );
             CREATE TABLE todos (
                id TEXT PRIMARY KEY,
                title TEXT,
                description TEXT,
                status TEXT,
                plan_id TEXT,
                updated_at TEXT
             );
             CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE current_plan (id INTEGER PRIMARY KEY, plan_id TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn read_session_plans_returns_empty_when_table_missing() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(read_session_plans(&conn).is_empty());
    }

    #[test]
    fn read_session_plans_returns_empty_when_feature_name_column_missing() {
        let conn = Connection::open_in_memory().unwrap();
        // Schema that pre-dates the feature-plan skill ALTER.
        conn.execute_batch(
            "CREATE TABLE plans (id TEXT PRIMARY KEY, title TEXT, status TEXT,
             created_at TEXT, superseded_at TEXT, plan_md_snapshot TEXT);
             INSERT INTO plans VALUES ('legacy','x','active','2026-01-01',NULL,NULL);",
        )
        .unwrap();
        assert!(read_session_plans(&conn).is_empty());
    }

    #[test]
    fn read_session_plans_skips_rows_with_null_feature_name() {
        let conn = fresh_features_db();
        conn.execute_batch(
            "INSERT INTO plans (id,title,status,created_at,feature_name)
             VALUES ('a','tit','active','2026-01-01',NULL),
                    ('b','tit2','active','2026-01-02','beta');",
        )
        .unwrap();
        let rows = read_session_plans(&conn);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "b");
    }

    #[test]
    fn read_session_plans_populates_todo_counts() {
        let conn = fresh_features_db();
        conn.execute_batch(
            "INSERT INTO plans (id,title,status,created_at,feature_name)
                 VALUES ('p1','t','active','2026-01-01','alpha');
             INSERT INTO todos (id,title,status,plan_id,updated_at) VALUES
                 ('t1','a','pending','p1','2026-01-02'),
                 ('t2','b','done','p1','2026-01-03'),
                 ('t3','c','in_progress','p1','2026-01-04'),
                 ('t4','d','blocked','p1','2026-01-05');",
        )
        .unwrap();
        let rows = read_session_plans(&conn);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.todos_total, 4);
        assert_eq!(r.todos_done, 1);
        assert_eq!(r.todos_in_progress, 1);
        assert_eq!(r.todos_blocked, 1);
        assert_eq!(r.todos_last_updated_at.as_deref(), Some("2026-01-05"));
    }

    #[test]
    fn read_current_plan_id_prefers_session_state() {
        let conn = fresh_features_db();
        conn.execute_batch(
            "INSERT INTO session_state VALUES ('current_plan_id', 'new-plan');
             INSERT INTO current_plan VALUES (1, 'legacy-plan');",
        )
        .unwrap();
        assert_eq!(read_current_plan_id(&conn).as_deref(), Some("new-plan"));
    }

    #[test]
    fn read_current_plan_id_falls_back_to_legacy_current_plan() {
        let conn = fresh_features_db();
        conn.execute_batch("INSERT INTO current_plan VALUES (1, 'legacy-plan');")
            .unwrap();
        assert_eq!(read_current_plan_id(&conn).as_deref(), Some("legacy-plan"));
    }

    #[test]
    fn read_current_plan_id_returns_none_when_neither_set() {
        let conn = fresh_features_db();
        assert_eq!(read_current_plan_id(&conn), None);
    }

    #[test]
    fn reconcile_features_drafting_when_folder_only() {
        let folders = vec![RawFolderRow {
            name: "alpha".into(),
            has_grill_me: true,
            has_plan: false,
            grill_me_path: Some("/x/alpha/grill-me.md".into()),
            plan_path: None,
            files_last_mtime: Some("2026-06-01T00:00:00.000Z".into()),
        }];
        let out = reconcile_features(folders, Vec::new());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].derived_status, "drafting");
        assert!(out[0].plan_id.is_none());
    }

    #[test]
    fn reconcile_features_orphan_when_plan_only() {
        let plans = vec![RawPlanRow {
            id: "p1".into(),
            feature_name: "ghost".into(),
            title: "Ghost".into(),
            status: "active".into(),
            created_at: "2026-06-01T00:00:00.000Z".into(),
            todos_last_updated_at: None,
            todos_total: 3,
            todos_done: 1,
            todos_in_progress: 0,
            todos_blocked: 0,
        }];
        let out = reconcile_features(Vec::new(), plans);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].derived_status, "orphan");
        assert_eq!(out[0].todos_total, 3);
    }

    #[test]
    fn reconcile_features_mirrors_plan_status() {
        let folders = vec![
            RawFolderRow {
                name: "a".into(),
                has_grill_me: true,
                has_plan: true,
                grill_me_path: None,
                plan_path: None,
                files_last_mtime: None,
            },
            RawFolderRow {
                name: "b".into(),
                has_grill_me: true,
                has_plan: true,
                grill_me_path: None,
                plan_path: None,
                files_last_mtime: None,
            },
        ];
        let plans = vec![
            RawPlanRow {
                id: "pa".into(),
                feature_name: "a".into(),
                title: "A".into(),
                status: "completed".into(),
                created_at: "2026-01-01".into(),
                todos_last_updated_at: None,
                todos_total: 0,
                todos_done: 0,
                todos_in_progress: 0,
                todos_blocked: 0,
            },
            RawPlanRow {
                id: "pb".into(),
                feature_name: "b".into(),
                title: "B".into(),
                status: "archived".into(),
                created_at: "2026-01-02".into(),
                todos_last_updated_at: None,
                todos_total: 0,
                todos_done: 0,
                todos_in_progress: 0,
                todos_blocked: 0,
            },
        ];
        let out = reconcile_features(folders, plans);
        assert_eq!(out[0].derived_status, "completed");
        assert_eq!(out[1].derived_status, "archived");
    }

    #[test]
    fn reconcile_features_latest_wins_for_duplicate_feature_name() {
        let folders = vec![RawFolderRow {
            name: "alpha".into(),
            has_grill_me: true,
            has_plan: true,
            grill_me_path: None,
            plan_path: None,
            files_last_mtime: None,
        }];
        let plans = vec![
            RawPlanRow {
                id: "old".into(),
                feature_name: "alpha".into(),
                title: "old".into(),
                status: "active".into(),
                created_at: "2026-01-01".into(),
                todos_last_updated_at: None,
                todos_total: 0,
                todos_done: 0,
                todos_in_progress: 0,
                todos_blocked: 0,
            },
            RawPlanRow {
                id: "new".into(),
                feature_name: "alpha".into(),
                title: "new".into(),
                status: "active".into(),
                created_at: "2026-12-01".into(),
                todos_last_updated_at: None,
                todos_total: 0,
                todos_done: 0,
                todos_in_progress: 0,
                todos_blocked: 0,
            },
        ];
        let out = reconcile_features(folders, plans);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].plan_id.as_deref(), Some("new"));
        assert_eq!(out[0].plan_title.as_deref(), Some("new"));
    }

    #[test]
    fn reconcile_features_matches_feature_names_case_sensitively() {
        let folders = vec![RawFolderRow {
            name: "user-auth".into(),
            has_grill_me: true,
            has_plan: false,
            grill_me_path: None,
            plan_path: None,
            files_last_mtime: None,
        }];
        let plans = vec![RawPlanRow {
            id: "p".into(),
            feature_name: "User-Auth".into(),
            title: "X".into(),
            status: "active".into(),
            created_at: "2026-01-01".into(),
            todos_last_updated_at: None,
            todos_total: 0,
            todos_done: 0,
            todos_in_progress: 0,
            todos_blocked: 0,
        }];
        let out = reconcile_features(folders, plans);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "user-auth");
        assert_eq!(out[0].derived_status, "drafting");
        assert_eq!(out[1].name, "User-Auth");
        assert_eq!(out[1].derived_status, "orphan");
    }

    #[test]
    fn list_feature_folders_skips_files_and_handles_missing_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "ws-feat-folders-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&tmp).ok();
        // Missing features dir → empty list, no error.
        let missing = tmp.join("missing");
        assert!(list_feature_folders(&missing).is_empty());

        let features = tmp.join("features");
        std::fs::create_dir_all(features.join("alpha")).unwrap();
        std::fs::write(features.join("alpha").join("grill-me.md"), b"a").unwrap();
        std::fs::write(features.join("alpha").join("plan.md"), b"a").unwrap();
        std::fs::create_dir_all(features.join("beta")).unwrap();
        std::fs::write(features.join("beta").join("grill-me.md"), b"b").unwrap();
        // A bare file → ignored.
        std::fs::write(features.join("loose.md"), b"x").unwrap();

        let mut folders = list_feature_folders(&features);
        folders.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(folders.len(), 2);
        assert_eq!(folders[0].name, "alpha");
        assert!(folders[0].has_grill_me && folders[0].has_plan);
        assert_eq!(folders[1].name, "beta");
        assert!(folders[1].has_grill_me && !folders[1].has_plan);
        assert!(folders[1].plan_path.is_none());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn list_session_features_returns_empty_for_missing_session() {
        let out = list_session_features("nonexistent-session-id-xyz-99999".into()).unwrap();
        assert!(out.features.is_empty());
        assert!(out.current_plan_id.is_none());
    }

    #[test]
    fn epoch_to_ymd_hms_unix_epoch_is_1970_01_01() {
        assert_eq!(epoch_to_ymd_hms(0), (1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn epoch_to_ymd_hms_handles_year_2026_correctly() {
        // 2026-06-12T00:00:00Z is 1781481600
        let secs = 1_781_481_600;
        let (y, m, d, _, _, _) = epoch_to_ymd_hms(secs);
        assert_eq!((y, m, d), (2026, 6, 12));
    }
}

//! Code Review tile (ADR 014) — diff-first, session-DB backed, MCP-free.
//!
//! Storage lives in the **bound Copilot session's** SQLite DB
//! (`~/.copilot/session-state/<session-id>/session.db`), NOT the Workstreams
//! DB — so the agent can read/write review comments with its own native `sql`
//! tool (no MCP). This module owns the read-write access + schema bootstrap for
//! the two tables we add to that DB (`reviews`, `review_comments`); it must
//! never touch the Copilot CLI's own tables.
//!
//! Concurrency is safe (spike-proven): we open read-write with a busy timeout
//! and only ever `CREATE TABLE IF NOT EXISTS` / write our own tables while the
//! CLI holds the same DB open (WAL, one writer at a time).

// Access + schema land here first (this todo); the review commands that use
// them arrive in the review-store-backend phase.
#![allow(dead_code)]

pub mod git;

use crate::AppState;
use rusqlite::Connection;
use std::path::PathBuf;
use std::time::Duration;
use tauri::State;

/// How long a write blocks waiting for the CLI's write lock before erroring.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Absolute path to a Copilot session's `session.db`.
pub fn session_db_path(session_id: &str) -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(
        home.join(".copilot")
            .join("session-state")
            .join(session_id)
            .join("session.db"),
    )
}

/// Open a session's `session.db` **read-write** with a busy timeout, and ensure
/// our review tables exist. Errors clearly if the session (hence its DB) does
/// not exist yet — a linked session is a prerequisite for a code review.
pub fn open_session_db_rw(session_id: &str) -> Result<Connection, String> {
    let path = session_db_path(session_id).ok_or("no home directory")?;
    if !path.exists() {
        return Err(format!(
            "session.db not found for session {session_id} — open a Copilot session in this workstream first"
        ));
    }
    let conn = Connection::open(&path).map_err(|e| format!("open session.db: {e}"))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| format!("set busy_timeout: {e}"))?;
    ensure_review_schema(&conn)?;
    Ok(conn)
}

/// Create the two review tables if they don't exist. Idempotent; touches only
/// our tables. Safe to call on every open.
pub fn ensure_review_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL,
            diff_source TEXT NOT NULL,      -- 'working_tree' | 'last_commit' | 'branch'
            base_ref TEXT,                  -- e.g. 'master' (null for working_tree/last_commit)
            title TEXT,
            status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'completed'
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS review_comments (
            id TEXT PRIMARY KEY,
            review_id TEXT NOT NULL,
            file TEXT NOT NULL,             -- repo-relative path
            line INTEGER NOT NULL,          -- new-side line (old-side for pure deletions)
            side TEXT NOT NULL DEFAULT 'new',
            code TEXT,                      -- anchored line text (context)
            hunk_header TEXT,               -- '@@ -a,b +c,d @@' for agent locatability
            body TEXT NOT NULL,             -- markdown
            author TEXT NOT NULL,           -- 'reviewer' | 'agent'
            parent_id TEXT,                 -- reply threading
            status TEXT NOT NULL DEFAULT 'open',  -- open | addressed | resolved | wontfix
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_review_comments_review ON review_comments(review_id, file, line);",
    )
    .map_err(|e| format!("ensure review schema: {e}"))
}

/// Resolve a workstream's bound Copilot session (ADR 014 §6). The link a user
/// establishes lives in the `copilot_session` tile's `config_json`
/// (`copilot_session_id`, or legacy `resume_by_id`) — the same source the
/// frontend uses to show the "Linked" badge. We prefer the pinned session tile,
/// then the most-recently-updated tile. As a fallback we consult the
/// `copilot_session_links` enrichment table. Returns None when no linked session
/// exists yet (a linked session is a prerequisite to start a review).
pub fn resolve_bound_session(
    ws_db: &Connection,
    workstream_id: &str,
) -> rusqlite::Result<Option<String>> {
    // Primary source: the workstream's copilot_session tiles' config_json.
    let mut stmt = ws_db.prepare(
        "SELECT config_json
         FROM tiles
         WHERE workstream_id = ?1 AND tile_type = 'copilot_session'
         ORDER BY updated_at DESC",
    )?;
    let mut best: Option<String> = None;
    let mut best_pinned = false;
    let rows = stmt.query_map([workstream_id], |r| r.get::<_, String>(0))?;
    for cfg_json in rows {
        let cfg: serde_json::Value = match serde_json::from_str(&cfg_json.unwrap_or_default()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let session_id = cfg
            .get("copilot_session_id")
            .and_then(|v| v.as_str())
            .or_else(|| cfg.get("resume_by_id").and_then(|v| v.as_str()));
        let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
            continue;
        };
        let pinned = cfg.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false);
        // Rows are already ordered newest-first; take the first match, but let a
        // pinned tile win over a merely-newer non-pinned one.
        if best.is_none() || (pinned && !best_pinned) {
            best = Some(session_id.to_string());
            best_pinned = pinned;
            if pinned {
                break;
            }
        }
    }
    if best.is_some() {
        return Ok(best);
    }

    // Fallback: the copilot_session_links enrichment table.
    ws_db
        .query_row(
            "SELECT l.copilot_session_id
             FROM copilot_session_links l
             JOIN tiles t ON t.id = l.tile_id
             WHERE t.workstream_id = ?1 AND l.copilot_session_id IS NOT NULL
             ORDER BY l.linked_at DESC
             LIMIT 1",
            [workstream_id],
            |r| r.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

// ── Tauri command wrappers ────────────────────────────────────────────────

/// Changed files (repo-relative path + status char) for a review's diff source.
#[tauri::command]
pub fn code_review_diff_files(
    directory: String,
    diff_source: String,
    base_ref: Option<String>,
) -> Result<Vec<(String, String)>, String> {
    git::diff_files_with_status(&directory, &diff_source, base_ref.as_deref())
}

/// Both sides (before, after) of a file's diff for the Monaco DiffEditor.
#[tauri::command]
pub fn code_review_diff_file_sides(
    directory: String,
    file_path: String,
    diff_source: String,
    base_ref: Option<String>,
) -> Result<(String, String), String> {
    git::diff_file_sides(&directory, &file_path, &diff_source, base_ref.as_deref())
}

/// The workstream's bound Copilot session id (most-recently-linked), or None.
#[tauri::command]
pub fn resolve_workstream_session(
    state: State<'_, AppState>,
    workstream_id: String,
) -> Result<Option<String>, String> {
    let db = state.db.lock().unwrap();
    resolve_bound_session(&db, &workstream_id).map_err(|e| format!("DB error: {e}"))
}

// ── Review store (bound session.db) ───────────────────────────────────────

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Review {
    pub id: String,
    pub workstream_id: String,
    pub diff_source: String,
    pub base_ref: Option<String>,
    pub title: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReviewComment {
    pub id: String,
    pub review_id: String,
    pub file: String,
    pub line: i64,
    pub side: String,
    pub code: Option<String>,
    pub hunk_header: Option<String>,
    pub body: String,
    pub author: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

const REVIEW_COLS: &str =
    "id, workstream_id, diff_source, base_ref, title, status, created_at, updated_at, completed_at";
const COMMENT_COLS: &str =
    "id, review_id, file, line, side, code, hunk_header, body, author, parent_id, status, created_at, updated_at";

fn row_to_review(r: &rusqlite::Row<'_>) -> rusqlite::Result<Review> {
    Ok(Review {
        id: r.get(0)?,
        workstream_id: r.get(1)?,
        diff_source: r.get(2)?,
        base_ref: r.get(3)?,
        title: r.get(4)?,
        status: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        completed_at: r.get(8)?,
    })
}

fn row_to_comment(r: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewComment> {
    Ok(ReviewComment {
        id: r.get(0)?,
        review_id: r.get(1)?,
        file: r.get(2)?,
        line: r.get(3)?,
        side: r.get(4)?,
        code: r.get(5)?,
        hunk_header: r.get(6)?,
        body: r.get(7)?,
        author: r.get(8)?,
        parent_id: r.get(9)?,
        status: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

// ── Pure DB helpers (unit-tested against a schema'd Connection) ────────────

#[allow(clippy::too_many_arguments)]
pub fn create_review_row(
    db: &Connection,
    workstream_id: &str,
    diff_source: &str,
    base_ref: Option<&str>,
    title: Option<&str>,
) -> rusqlite::Result<Review> {
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO reviews (id, workstream_id, diff_source, base_ref, title, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?6)",
        rusqlite::params![id, workstream_id, diff_source, base_ref, title, ts],
    )?;
    get_review_row(db, &id).map(|o| o.expect("just inserted"))
}

pub fn get_review_row(db: &Connection, review_id: &str) -> rusqlite::Result<Option<Review>> {
    let sql = format!("SELECT {REVIEW_COLS} FROM reviews WHERE id = ?1");
    db.query_row(&sql, [review_id], row_to_review)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

/// Latest-created review for a workstream (the tile's active review), or None.
pub fn get_active_review_row(
    db: &Connection,
    workstream_id: &str,
) -> rusqlite::Result<Option<Review>> {
    let sql = format!(
        "SELECT {REVIEW_COLS} FROM reviews WHERE workstream_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1"
    );
    db.query_row(&sql, [workstream_id], row_to_review)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

pub fn list_reviews_rows(db: &Connection, workstream_id: &str) -> rusqlite::Result<Vec<Review>> {
    let sql = format!(
        "SELECT {REVIEW_COLS} FROM reviews WHERE workstream_id = ?1 ORDER BY created_at DESC, rowid DESC"
    );
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map([workstream_id], row_to_review)?;
    rows.collect()
}

#[allow(clippy::too_many_arguments)]
pub fn add_comment_row(
    db: &Connection,
    review_id: &str,
    file: &str,
    line: i64,
    side: &str,
    code: Option<&str>,
    hunk_header: Option<&str>,
    body: &str,
) -> rusqlite::Result<ReviewComment> {
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO review_comments (id, review_id, file, line, side, code, hunk_header, body, author, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reviewer', 'open', ?9, ?9)",
        rusqlite::params![id, review_id, file, line, side, code, hunk_header, body, ts],
    )?;
    let sql = format!("SELECT {COMMENT_COLS} FROM review_comments WHERE id = ?1");
    db.query_row(&sql, [id], row_to_comment)
}

pub fn list_comments_rows(
    db: &Connection,
    review_id: &str,
) -> rusqlite::Result<Vec<ReviewComment>> {
    let sql = format!(
        "SELECT {COMMENT_COLS} FROM review_comments WHERE review_id = ?1 ORDER BY file ASC, line ASC, created_at ASC"
    );
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map([review_id], row_to_comment)?;
    rows.collect()
}

/// Reviewer-driven status change on a root comment (resolve/reopen/wontfix).
/// Only touches root comments (parent_id IS NULL). Returns an error if unknown.
pub fn set_comment_status_row(
    db: &Connection,
    comment_id: &str,
    status: &str,
) -> Result<(), String> {
    let allowed = ["open", "addressed", "resolved", "wontfix"];
    if !allowed.contains(&status) {
        return Err(format!("invalid status '{status}'"));
    }
    let ts = now();
    let n = db
        .execute(
            "UPDATE review_comments SET status = ?2, updated_at = ?3 WHERE id = ?1 AND parent_id IS NULL",
            rusqlite::params![comment_id, status, ts],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    if n == 0 {
        return Err(format!("review comment {comment_id} not found"));
    }
    Ok(())
}

pub fn complete_review_row(db: &Connection, review_id: &str) -> Result<(), String> {
    let ts = now();
    let n = db
        .execute(
            "UPDATE reviews SET status = 'completed', completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            rusqlite::params![review_id, ts],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    if n == 0 {
        return Err(format!("review {review_id} not found"));
    }
    Ok(())
}

// ── Command wrappers (resolve bound session → open its session.db) ─────────

fn open_bound(state: &State<'_, AppState>, workstream_id: &str) -> Result<Connection, String> {
    let session_id = {
        let db = state.db.lock().unwrap();
        resolve_bound_session(&db, workstream_id)
            .map_err(|e| format!("DB error: {e}"))?
            .ok_or(
                "no Copilot session linked to this workstream — open one to start a code review",
            )?
    };
    open_session_db_rw(&session_id)
}

#[tauri::command]
pub fn create_review(
    state: State<'_, AppState>,
    workstream_id: String,
    diff_source: String,
    base_ref: Option<String>,
    title: Option<String>,
) -> Result<Review, String> {
    let conn = open_bound(&state, &workstream_id)?;
    create_review_row(
        &conn,
        &workstream_id,
        &diff_source,
        base_ref.as_deref(),
        title.as_deref(),
    )
    .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn get_active_review(
    state: State<'_, AppState>,
    workstream_id: String,
) -> Result<Option<Review>, String> {
    let conn = open_bound(&state, &workstream_id)?;
    get_active_review_row(&conn, &workstream_id).map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn list_reviews(
    state: State<'_, AppState>,
    workstream_id: String,
) -> Result<Vec<Review>, String> {
    let conn = open_bound(&state, &workstream_id)?;
    list_reviews_rows(&conn, &workstream_id).map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_review_comment(
    state: State<'_, AppState>,
    workstream_id: String,
    review_id: String,
    file: String,
    line: i64,
    side: String,
    code: Option<String>,
    hunk_header: Option<String>,
    body: String,
) -> Result<ReviewComment, String> {
    let conn = open_bound(&state, &workstream_id)?;
    add_comment_row(
        &conn,
        &review_id,
        &file,
        line,
        &side,
        code.as_deref(),
        hunk_header.as_deref(),
        &body,
    )
    .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn list_review_comments(
    state: State<'_, AppState>,
    workstream_id: String,
    review_id: String,
) -> Result<Vec<ReviewComment>, String> {
    let conn = open_bound(&state, &workstream_id)?;
    list_comments_rows(&conn, &review_id).map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn set_review_comment_status(
    state: State<'_, AppState>,
    workstream_id: String,
    comment_id: String,
    status: String,
) -> Result<(), String> {
    let conn = open_bound(&state, &workstream_id)?;
    set_comment_status_row(&conn, &comment_id, &status)
}

#[tauri::command]
pub fn complete_code_review(
    state: State<'_, AppState>,
    workstream_id: String,
    review_id: String,
) -> Result<(), String> {
    let conn = open_bound(&state, &workstream_id)?;
    complete_review_row(&conn, &review_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_conn() -> Connection {
        // Fresh in-memory DB standing in for a session.db that already has some
        // CLI-owned tables — prove we coexist and only add our own.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);
             INSERT INTO todos VALUES ('t1','cli-owned row');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn ensure_schema_creates_both_tables_idempotently() {
        let conn = temp_conn();
        ensure_review_schema(&conn).unwrap();
        // Idempotent.
        ensure_review_schema(&conn).unwrap();
        for table in ["reviews", "review_comments"] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "{table} should exist");
        }
        // CLI's own table untouched.
        let todos: i64 = conn
            .query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(todos, 1);
    }

    #[test]
    fn schema_round_trips_a_review_and_comment() {
        let conn = temp_conn();
        ensure_review_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO reviews (id,workstream_id,diff_source,base_ref,title,status,created_at,updated_at)
             VALUES ('rv1','w1','branch','master','spike','open','t','t')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_comments (id,review_id,file,line,side,code,hunk_header,body,author,status,created_at,updated_at)
             VALUES ('c1','rv1','src/a.js',4,'new','console.log(x)','@@ -3,3 +3,3 @@','remove this','reviewer','open','t','t')",
            [],
        )
        .unwrap();
        let (body, author): (String, String) = conn
            .query_row(
                "SELECT body, author FROM review_comments WHERE id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(body, "remove this");
        assert_eq!(author, "reviewer");
    }

    #[test]
    fn open_rw_errors_when_session_db_missing() {
        let err = open_session_db_rw("definitely-not-a-real-session-id-xyz").unwrap_err();
        assert!(err.contains("session.db not found"), "got: {err}");
    }

    #[test]
    fn resolve_bound_session_returns_most_recently_linked() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workstreams (id,name,status,workstream_type,created_at,updated_at)
                VALUES ('w1','WS','active','standalone','t','t');
             INSERT INTO tiles (id,workstream_id,tile_type,created_at,updated_at)
                VALUES ('t1','w1','copilot_session','t','t');
             INSERT INTO tiles (id,workstream_id,tile_type,created_at,updated_at)
                VALUES ('t2','w1','copilot_session','t','t');
             INSERT INTO copilot_session_links (tile_id,copilot_session_id,linked_at)
                VALUES ('t1','sess-old','2026-01-01T00:00:00Z');
             INSERT INTO copilot_session_links (tile_id,copilot_session_id,linked_at)
                VALUES ('t2','sess-new','2026-02-01T00:00:00Z');",
        )
        .unwrap();
        assert_eq!(
            resolve_bound_session(&conn, "w1").unwrap().as_deref(),
            Some("sess-new")
        );
        // Workstream with no linked session → None.
        conn.execute(
            "INSERT INTO workstreams (id,name,status,workstream_type,created_at,updated_at)
                VALUES ('w2','WS2','active','standalone','t','t')",
            [],
        )
        .unwrap();
        assert_eq!(resolve_bound_session(&conn, "w2").unwrap(), None);
    }

    #[test]
    fn resolve_bound_session_reads_tile_config_json() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workstreams (id,name,status,workstream_type,created_at,updated_at)
                VALUES ('w1','WS','active','standalone','t','t');
             -- Newer, non-pinned tile linked via config_json (legacy resume_by_id).
             INSERT INTO tiles (id,workstream_id,tile_type,config_json,created_at,updated_at)
                VALUES ('t2','w1','copilot_session','{\"resume_by_id\":\"sess-side\"}','t','2026-02-01');
             -- Older, PINNED tile linked via copilot_session_id → should win.
             INSERT INTO tiles (id,workstream_id,tile_type,config_json,created_at,updated_at)
                VALUES ('t1','w1','copilot_session','{\"copilot_session_id\":\"sess-pinned\",\"pinned\":true}','t','2026-01-01');",
        )
        .unwrap();
        // Pinned tile wins over the merely-newer non-pinned one.
        assert_eq!(
            resolve_bound_session(&conn, "w1").unwrap().as_deref(),
            Some("sess-pinned")
        );

        // Without a pinned tile, the most-recently-updated linked tile wins.
        let conn2 = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn2).unwrap();
        conn2
            .execute_batch(
                "INSERT INTO workstreams (id,name,status,workstream_type,created_at,updated_at)
                    VALUES ('w1','WS','active','standalone','t','t');
                 INSERT INTO tiles (id,workstream_id,tile_type,config_json,created_at,updated_at)
                    VALUES ('a','w1','copilot_session','{\"copilot_session_id\":\"old\"}','t','2026-01-01');
                 INSERT INTO tiles (id,workstream_id,tile_type,config_json,created_at,updated_at)
                    VALUES ('b','w1','copilot_session','{\"copilot_session_id\":\"new\"}','t','2026-03-01');",
            )
            .unwrap();
        assert_eq!(
            resolve_bound_session(&conn2, "w1").unwrap().as_deref(),
            Some("new")
        );
    }

    // ── Review store helpers ──────────────────────────────────────────────

    fn schema_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_review_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn create_and_get_active_review() {
        let conn = schema_conn();
        let r =
            create_review_row(&conn, "w1", "branch", Some("master"), Some("My review")).unwrap();
        assert_eq!(r.status, "open");
        assert_eq!(r.diff_source, "branch");
        assert_eq!(r.base_ref.as_deref(), Some("master"));
        // A second, later review becomes the active (latest-created) one.
        let r2 = create_review_row(&conn, "w1", "working_tree", None, None).unwrap();
        let active = get_active_review_row(&conn, "w1").unwrap().unwrap();
        assert_eq!(active.id, r2.id);
        assert_eq!(list_reviews_rows(&conn, "w1").unwrap().len(), 2);
        // Isolation by workstream.
        assert!(get_active_review_row(&conn, "w-other").unwrap().is_none());
    }

    #[test]
    fn add_list_and_resolve_comments() {
        let conn = schema_conn();
        let r = create_review_row(&conn, "w1", "working_tree", None, None).unwrap();
        let c = add_comment_row(
            &conn,
            &r.id,
            "src/a.js",
            4,
            "new",
            Some("console.log(x)"),
            Some("@@ -3,3 +3,3 @@"),
            "remove this",
        )
        .unwrap();
        assert_eq!(c.author, "reviewer");
        assert_eq!(c.status, "open");
        add_comment_row(&conn, &r.id, "src/a.js", 1, "new", None, None, "second").unwrap();
        let list = list_comments_rows(&conn, &r.id).unwrap();
        assert_eq!(list.len(), 2);
        // Ordered by file, then line: line 1 before line 4.
        assert_eq!(list[0].line, 1);
        assert_eq!(list[1].line, 4);

        // Reviewer resolves the first comment.
        set_comment_status_row(&conn, &c.id, "resolved").unwrap();
        let after = list_comments_rows(&conn, &r.id).unwrap();
        assert_eq!(
            after.iter().find(|x| x.id == c.id).unwrap().status,
            "resolved"
        );
        // Invalid status rejected; unknown id rejected.
        assert!(set_comment_status_row(&conn, &c.id, "bogus").is_err());
        assert!(set_comment_status_row(&conn, "nope", "resolved").is_err());
    }

    #[test]
    fn complete_flips_review_status() {
        let conn = schema_conn();
        let r = create_review_row(&conn, "w1", "branch", Some("master"), None).unwrap();
        complete_review_row(&conn, &r.id).unwrap();
        let done = get_review_row(&conn, &r.id).unwrap().unwrap();
        assert_eq!(done.status, "completed");
        assert!(done.completed_at.is_some());
        assert!(complete_review_row(&conn, "nope").is_err());
    }
}

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

/// Resolve a workstream's bound Copilot session = the **most-recently-linked**
/// session across the workstream's tiles (ADR 014 §6). Queries the Workstreams
/// DB. Returns None when the workstream has no linked session yet (a linked
/// session is a prerequisite to start a review).
pub fn resolve_bound_session(
    ws_db: &Connection,
    workstream_id: &str,
) -> rusqlite::Result<Option<String>> {
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
}

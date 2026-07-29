//! Inline **file comments** stored in the bound Copilot session's `session.db`
//! (unify-commenting). Sibling of the review store in `super`: same session-DB
//! plumbing (`open_session_db_rw`, `resolve_bound_session`), a dedicated
//! `file_comments` table, and the same reviewer↔agent reply/status model as
//! Code Review so the agent can read/reply via its native `sql` tool (no MCP).
//!
//! Repo-relative `file` paths (portable + what the agent sees). A linked
//! session is a prerequisite, exactly like Code Review.

use crate::AppState;
use rusqlite::Connection;
use tauri::State;

use super::{new_id, now, open_session_db_rw, resolve_bound_session};

/// Create the `file_comments` table in a session.db if absent. Idempotent;
/// touches only our table. Distinct from the workstreams.db `file_comments`
/// table (legacy, being retired) — this one lives in the session.db and carries
/// the reviewer↔agent columns.
pub fn ensure_file_comments_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS file_comments (
            id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL,
            file TEXT NOT NULL,                  -- repo-relative path
            anchor_line_start INTEGER NOT NULL,
            anchor_line_end INTEGER NOT NULL,
            anchor_text TEXT,                    -- drift snapshot of the anchored lines
            body TEXT NOT NULL,                  -- markdown
            author TEXT NOT NULL,                -- 'reviewer' | 'agent'
            parent_id TEXT,                      -- reply threading
            status TEXT NOT NULL DEFAULT 'open', -- open | addressed | resolved | wontfix
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_file_comments_ws_file
            ON file_comments(workstream_id, file, anchor_line_start);",
    )
    .map_err(|e| format!("ensure file_comments schema: {e}"))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileComment {
    pub id: String,
    pub workstream_id: String,
    pub file: String,
    pub anchor_line_start: i64,
    pub anchor_line_end: i64,
    pub anchor_text: Option<String>,
    pub body: String,
    pub author: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

const COLS: &str = "id, workstream_id, file, anchor_line_start, anchor_line_end, \
     anchor_text, body, author, parent_id, status, created_at, updated_at";

fn row_to_comment(r: &rusqlite::Row<'_>) -> rusqlite::Result<FileComment> {
    Ok(FileComment {
        id: r.get(0)?,
        workstream_id: r.get(1)?,
        file: r.get(2)?,
        anchor_line_start: r.get(3)?,
        anchor_line_end: r.get(4)?,
        anchor_text: r.get(5)?,
        body: r.get(6)?,
        author: r.get(7)?,
        parent_id: r.get(8)?,
        status: r.get(9)?,
        created_at: r.get(10)?,
        updated_at: r.get(11)?,
    })
}

// ── Pure DB helpers (unit-tested against a schema'd Connection) ────────────

pub fn list_file_comments_rows(
    db: &Connection,
    workstream_id: &str,
    file: &str,
) -> rusqlite::Result<Vec<FileComment>> {
    let sql = format!(
        "SELECT {COLS} FROM file_comments \
         WHERE workstream_id = ?1 AND file = ?2 \
         ORDER BY anchor_line_start ASC, created_at ASC"
    );
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params![workstream_id, file], row_to_comment)?;
    rows.collect()
}

pub fn get_file_comment_row(db: &Connection, id: &str) -> rusqlite::Result<Option<FileComment>> {
    let sql = format!("SELECT {COLS} FROM file_comments WHERE id = ?1");
    db.query_row(&sql, [id], row_to_comment)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

/// Add a reviewer note anchored to a line range.
pub fn add_file_comment_row(
    db: &Connection,
    workstream_id: &str,
    file: &str,
    anchor_line_start: i64,
    anchor_line_end: i64,
    anchor_text: Option<&str>,
    body: &str,
) -> rusqlite::Result<FileComment> {
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO file_comments \
            (id, workstream_id, file, anchor_line_start, anchor_line_end, anchor_text, \
             body, author, parent_id, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reviewer', NULL, 'open', ?8, ?8)",
        rusqlite::params![
            id,
            workstream_id,
            file,
            anchor_line_start,
            anchor_line_end,
            anchor_text,
            body,
            ts,
        ],
    )?;
    get_file_comment_row(db, &id).map(|o| o.expect("just inserted"))
}

/// Insert a **reviewer** reply threaded under a comment. This backs the
/// in-file "Reply" UI (the human reviewer). The agent replies via its own SQL
/// skill (`author='agent'`) and does not use this command. Copies the parent's
/// file/anchor so the reply renders next to the note.
pub fn reply_file_comment_row(
    db: &Connection,
    parent_id: &str,
    body: &str,
) -> rusqlite::Result<Option<FileComment>> {
    let Some(parent) = get_file_comment_row(db, parent_id)? else {
        return Ok(None);
    };
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO file_comments \
            (id, workstream_id, file, anchor_line_start, anchor_line_end, anchor_text, \
             body, author, parent_id, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'reviewer', ?7, 'open', ?8, ?8)",
        rusqlite::params![
            id,
            parent.workstream_id,
            parent.file,
            parent.anchor_line_start,
            parent.anchor_line_end,
            body,
            parent_id,
            ts,
        ],
    )?;
    get_file_comment_row(db, &id)
}

/// Edit a reviewer note's body (reviewer-owned only — agent replies are immutable here).
pub fn update_file_comment_row(
    db: &Connection,
    id: &str,
    body: &str,
) -> rusqlite::Result<Option<FileComment>> {
    let ts = now();
    let n = db.execute(
        "UPDATE file_comments SET body = ?2, updated_at = ?3 WHERE id = ?1 AND author = 'reviewer'",
        rusqlite::params![id, body, ts],
    )?;
    if n == 0 {
        return Ok(None);
    }
    get_file_comment_row(db, id)
}

/// Set a comment's status (open|addressed|resolved|wontfix).
pub fn set_file_comment_status_row(
    db: &Connection,
    id: &str,
    status: &str,
) -> rusqlite::Result<Option<FileComment>> {
    let ts = now();
    let n = db.execute(
        "UPDATE file_comments SET status = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, status, ts],
    )?;
    if n == 0 {
        return Ok(None);
    }
    get_file_comment_row(db, id)
}

/// Delete a reviewer note (and its agent replies via parent_id).
pub fn delete_file_comment_row(db: &Connection, id: &str) -> rusqlite::Result<bool> {
    let n = db.execute(
        "DELETE FROM file_comments WHERE (id = ?1 OR parent_id = ?1) AND \
         (author = 'reviewer' OR parent_id = ?1)",
        [id],
    )?;
    Ok(n > 0)
}

// ── Command wrappers (open the bound session.db RW + fc schema) ────────────

fn open_bound(state: &State<'_, AppState>, workstream_id: &str) -> Result<Connection, String> {
    let session_id = {
        let db = state.db.lock().unwrap();
        resolve_bound_session(&db, workstream_id)
            .map_err(|e| format!("DB error: {e}"))?
            .ok_or("no Copilot session linked to this workstream — open one to add file comments")?
    };
    let conn = open_session_db_rw(&session_id)?;
    ensure_file_comments_schema(&conn)?;
    Ok(conn)
}

#[tauri::command]
pub fn list_session_file_comments(
    state: State<'_, AppState>,
    workstream_id: String,
    file: String,
) -> Result<Vec<FileComment>, String> {
    let conn = open_bound(&state, &workstream_id)?;
    list_file_comments_rows(&conn, &workstream_id, &file).map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn add_session_file_comment(
    state: State<'_, AppState>,
    workstream_id: String,
    file: String,
    anchor_line_start: i64,
    anchor_line_end: i64,
    anchor_text: Option<String>,
    body: String,
) -> Result<FileComment, String> {
    if anchor_line_end < anchor_line_start {
        return Err("anchor_line_end must be >= anchor_line_start".to_string());
    }
    let conn = open_bound(&state, &workstream_id)?;
    add_file_comment_row(
        &conn,
        &workstream_id,
        &file,
        anchor_line_start,
        anchor_line_end,
        anchor_text.as_deref(),
        &body,
    )
    .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn reply_session_file_comment(
    state: State<'_, AppState>,
    workstream_id: String,
    parent_id: String,
    body: String,
) -> Result<FileComment, String> {
    let conn = open_bound(&state, &workstream_id)?;
    reply_file_comment_row(&conn, &parent_id, &body)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("comment {parent_id} not found"))
}

#[tauri::command]
pub fn update_session_file_comment(
    state: State<'_, AppState>,
    workstream_id: String,
    id: String,
    body: String,
) -> Result<FileComment, String> {
    let conn = open_bound(&state, &workstream_id)?;
    update_file_comment_row(&conn, &id, &body)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("comment {id} not found or not editable"))
}

#[tauri::command]
pub fn set_session_file_comment_status(
    state: State<'_, AppState>,
    workstream_id: String,
    id: String,
    status: String,
) -> Result<FileComment, String> {
    let conn = open_bound(&state, &workstream_id)?;
    set_file_comment_status_row(&conn, &id, &status)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("comment {id} not found"))
}

#[tauri::command]
pub fn delete_session_file_comment(
    state: State<'_, AppState>,
    workstream_id: String,
    id: String,
) -> Result<(), String> {
    let conn = open_bound(&state, &workstream_id)?;
    let deleted = delete_file_comment_row(&conn, &id).map_err(|e| format!("DB error: {e}"))?;
    if !deleted {
        return Err(format!("comment {id} not found or not deletable"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_file_comments_schema(&conn).unwrap();
        conn
    }

    /// Seed an agent-authored reply directly (mirrors what the file-comments
    /// skill does via raw SQL), since the reply command now authors 'reviewer'.
    fn insert_agent_reply(conn: &Connection, parent: &FileComment, body: &str) -> String {
        let id = new_id();
        let ts = now();
        conn.execute(
            "INSERT INTO file_comments \
                (id, workstream_id, file, anchor_line_start, anchor_line_end, anchor_text, \
                 body, author, parent_id, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'agent', ?7, 'open', ?8, ?8)",
            rusqlite::params![
                id,
                parent.workstream_id,
                parent.file,
                parent.anchor_line_start,
                parent.anchor_line_end,
                body,
                parent.id,
                ts,
            ],
        )
        .unwrap();
        id
    }

    #[test]
    fn add_list_orders_by_anchor_then_created() {
        let conn = schema_conn();
        add_file_comment_row(&conn, "ws-1", "src/a.ts", 10, 10, None, "second").unwrap();
        add_file_comment_row(&conn, "ws-1", "src/a.ts", 5, 7, Some("ctx"), "first").unwrap();
        add_file_comment_row(&conn, "ws-1", "src/b.ts", 1, 1, None, "other file").unwrap();
        let rows = list_file_comments_rows(&conn, "ws-1", "src/a.ts").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].body, "first");
        assert_eq!(rows[1].body, "second");
        assert_eq!(rows[0].author, "reviewer");
        assert_eq!(rows[0].status, "open");
    }

    #[test]
    fn isolates_by_workstream_and_file() {
        let conn = schema_conn();
        add_file_comment_row(&conn, "ws-1", "src/a.ts", 1, 1, None, "ws1").unwrap();
        add_file_comment_row(&conn, "ws-2", "src/a.ts", 1, 1, None, "ws2").unwrap();
        let r = list_file_comments_rows(&conn, "ws-1", "src/a.ts").unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].body, "ws1");
    }

    #[test]
    fn reply_threads_under_parent_and_copies_anchor() {
        let conn = schema_conn();
        let parent =
            add_file_comment_row(&conn, "ws-1", "src/a.ts", 4, 4, None, "please fix").unwrap();
        let reply = reply_file_comment_row(&conn, &parent.id, "done")
            .unwrap()
            .unwrap();
        assert_eq!(reply.author, "reviewer");
        assert_eq!(reply.parent_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(reply.file, "src/a.ts");
        assert_eq!(reply.anchor_line_start, 4);
        // Reply to a missing parent → None.
        assert!(reply_file_comment_row(&conn, "nope", "x")
            .unwrap()
            .is_none());
    }

    #[test]
    fn update_only_reviewer_notes() {
        let conn = schema_conn();
        let parent = add_file_comment_row(&conn, "ws-1", "src/a.ts", 4, 4, None, "orig").unwrap();
        // A reviewer reply (from the in-file Reply UI) is editable.
        let reviewer_reply = reply_file_comment_row(&conn, &parent.id, "reply")
            .unwrap()
            .unwrap();
        assert_eq!(reviewer_reply.author, "reviewer");
        // Reviewer note editable.
        let up = update_file_comment_row(&conn, &parent.id, "edited")
            .unwrap()
            .unwrap();
        assert_eq!(up.body, "edited");
        // Reviewer reply also editable.
        assert!(update_file_comment_row(&conn, &reviewer_reply.id, "reply-edited")
            .unwrap()
            .is_some());
        // Agent reply NOT editable via update (the mutability guard).
        let agent_id = insert_agent_reply(&conn, &parent, "agent says");
        assert!(update_file_comment_row(&conn, &agent_id, "hack")
            .unwrap()
            .is_none());
    }

    #[test]
    fn status_transitions_and_delete_cascades_replies() {
        let conn = schema_conn();
        let parent = add_file_comment_row(&conn, "ws-1", "src/a.ts", 4, 4, None, "note").unwrap();
        reply_file_comment_row(&conn, &parent.id, "reply").unwrap();
        let addressed = set_file_comment_status_row(&conn, &parent.id, "addressed")
            .unwrap()
            .unwrap();
        assert_eq!(addressed.status, "addressed");
        // Delete the reviewer note → also removes its threaded reply.
        assert!(delete_file_comment_row(&conn, &parent.id).unwrap());
        assert!(list_file_comments_rows(&conn, "ws-1", "src/a.ts")
            .unwrap()
            .is_empty());
    }
}

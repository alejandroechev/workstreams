// @test-skip: thin Tauri command wrappers; logic tested via *_with_conn units + anchor.rs + git.rs
//! Local Agent Review (ADR 013) — reviewer↔agent loop backend.
//!
//! `anchor` is the pure, unit-tested trackability engine (spike-proven).
//! `git` holds the impure git IO. This module wires them into Tauri commands
//! over the extended `file_comments` store + `agent_reviews` parent table.
//!
//! Non-blocking discipline (ADR 013 §8): `submit_review_round` performs the
//! per-comment re-anchor sweep on a background thread using its own DB
//! connection, so neither git nor the sweep blocks the UI/command thread.

// Some DTO fields (e.g. `deleted_only`, `moved`) are surfaced to the frontend /
// exercised by tests rather than read inside Rust; keep them without warning.
#![allow(dead_code)]

pub mod anchor;
pub mod git;

use crate::AppState;
use anchor::{capture_anchor, classify, Anchor, AnchorState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

pub mod events {
    pub const ROUND_READY: &str = "review:round-ready";
    pub const COMMENT_UPDATED: &str = "review:comment-updated";
}

// Thread lifecycle statuses (stored in file_comments.status for local-review).
pub const STATUS_OPEN: &str = "open";
pub const STATUS_ADDRESSED: &str = "addressed";
pub const STATUS_RESOLVED: &str = "resolved";
pub const STATUS_WONTFIX: &str = "wontfix";

pub const ORIGIN_LOCAL_REVIEW: &str = "local-review";

fn now() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{t}")
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ── DTOs ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentReview {
    pub id: String,
    pub workstream_id: String,
    pub base_ref: Option<String>,
    pub head_ref: Option<String>,
    pub round: i64,
    pub status: String,
    pub exported_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewComment {
    pub id: String,
    pub review_id: Option<String>,
    pub workstream_id: String,
    pub absolute_path: String,
    pub anchor_line_start: i64,
    pub anchor_line_end: i64,
    pub anchor_text: Option<String>,
    pub body_md: String,
    pub author: String,
    pub status: Option<String>,
    pub origin_parent_id: Option<String>,
    pub round: Option<i64>,
    pub anchor_state: Option<String>,
    pub fixing_commit: Option<String>,
    pub anchor_commit: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Computed on read for `changed` roots: the per-comment before/after hunk.
    #[serde(default)]
    pub fixing_hunk: Option<String>,
}

const COMMENT_COLS: &str = "id, review_id, workstream_id, absolute_path, anchor_line_start, \
     anchor_line_end, anchor_text, body_md, author, status, origin_parent_id, round, \
     anchor_state, fixing_commit, anchor_commit, created_at, updated_at";

fn row_to_comment(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewComment> {
    Ok(ReviewComment {
        id: row.get(0)?,
        review_id: row.get(1)?,
        workstream_id: row.get(2)?,
        absolute_path: row.get(3)?,
        anchor_line_start: row.get(4)?,
        anchor_line_end: row.get(5)?,
        anchor_text: row.get(6)?,
        body_md: row.get(7)?,
        author: row.get(8)?,
        status: row.get(9)?,
        origin_parent_id: row.get(10)?,
        round: row.get(11)?,
        anchor_state: row.get(12)?,
        fixing_commit: row.get(13)?,
        anchor_commit: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        fixing_hunk: None,
    })
}

fn row_to_review(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentReview> {
    Ok(AgentReview {
        id: row.get(0)?,
        workstream_id: row.get(1)?,
        base_ref: row.get(2)?,
        head_ref: row.get(3)?,
        round: row.get(4)?,
        status: row.get(5)?,
        exported_path: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        completed_at: row.get(9)?,
    })
}

const REVIEW_COLS: &str = "id, workstream_id, base_ref, head_ref, round, status, \
     exported_path, created_at, updated_at, completed_at";

// ── Review lifecycle (DB) ────────────────────────────────────────────────

pub fn get_active_review(
    db: &Connection,
    workstream_id: &str,
) -> rusqlite::Result<Option<AgentReview>> {
    let sql = format!(
        "SELECT {REVIEW_COLS} FROM agent_reviews \
         WHERE workstream_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    );
    db.query_row(&sql, params![workstream_id], row_to_review)
        .optional()
}

pub fn get_review(db: &Connection, review_id: &str) -> rusqlite::Result<Option<AgentReview>> {
    let sql = format!("SELECT {REVIEW_COLS} FROM agent_reviews WHERE id = ?1");
    db.query_row(&sql, params![review_id], row_to_review)
        .optional()
}

/// Insert a review row. One active review per workstream: returns the existing
/// active one if present (idempotent), else creates a new one.
pub fn create_review_with_conn(
    db: &Connection,
    workstream_id: &str,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
) -> rusqlite::Result<AgentReview> {
    if let Some(existing) = get_active_review(db, workstream_id)? {
        return Ok(existing);
    }
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO agent_reviews (id, workstream_id, base_ref, head_ref, round, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, 1, 'active', ?5, ?5)",
        params![id, workstream_id, base_ref, head_ref, ts],
    )?;
    Ok(get_review(db, &id)?.expect("just inserted"))
}

// ── Comments (DB) ────────────────────────────────────────────────────────

/// Insert a root review comment (author='me'). Anchor text/hash/commit are
/// captured by the command wrapper from git; here we only persist.
#[allow(clippy::too_many_arguments)]
pub fn add_comment_row(
    db: &Connection,
    review_id: &str,
    workstream_id: &str,
    absolute_path: &str,
    start: i64,
    end: i64,
    anchor_text: Option<&str>,
    anchor_hash: Option<&str>,
    anchor_commit: Option<&str>,
    body_md: &str,
    round: i64,
) -> rusqlite::Result<String> {
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO file_comments \
            (id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, anchor_text, \
             body_md, author, origin_type, status, review_id, round, anchor_hash, anchor_state, \
             anchor_commit, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'me', 'local-review', 'open', ?8, ?9, ?10, \
                 'unchanged', ?11, ?12, ?12)",
        params![
            id,
            workstream_id,
            absolute_path,
            start,
            end,
            anchor_text,
            body_md,
            review_id,
            round,
            anchor_hash,
            anchor_commit,
            ts
        ],
    )?;
    Ok(id)
}

/// Insert a reply on a thread. `author` is 'me' or 'agent'.
pub fn reply_comment_row(
    db: &Connection,
    parent_id: &str,
    body_md: &str,
    author: &str,
) -> rusqlite::Result<String> {
    // Inherit review_id / workstream_id / path / round from the parent.
    let sql = format!("SELECT {COMMENT_COLS} FROM file_comments WHERE id = ?1");
    let parent = db.query_row(&sql, params![parent_id], row_to_comment)?;
    let id = new_id();
    let ts = now();
    db.execute(
        "INSERT INTO file_comments \
            (id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, body_md, \
             author, origin_type, origin_parent_id, review_id, round, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'local-review', ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            parent.workstream_id,
            parent.absolute_path,
            parent.anchor_line_start,
            parent.anchor_line_end,
            body_md,
            author,
            parent_id,
            parent.review_id,
            parent.round,
            ts
        ],
    )?;
    Ok(id)
}

/// Set a thread's resolution with role enforcement (ADR 013 §3):
/// - `me` may set any status (open/resolved/wontfix/addressed).
/// - `agent` may set only `addressed` or `wontfix`; it can NOT resolve/reopen.
pub fn set_resolution_with_conn(
    db: &Connection,
    comment_id: &str,
    status: &str,
    actor: &str,
) -> Result<(), String> {
    let allowed_me = [
        STATUS_OPEN,
        STATUS_ADDRESSED,
        STATUS_RESOLVED,
        STATUS_WONTFIX,
    ];
    let allowed_agent = [STATUS_ADDRESSED, STATUS_WONTFIX];
    let ok = match actor {
        "me" => allowed_me.contains(&status),
        "agent" => allowed_agent.contains(&status),
        _ => false,
    };
    if !ok {
        return Err(format!("actor '{actor}' may not set status '{status}'"));
    }
    let ts = now();
    let n = db
        .execute(
            "UPDATE file_comments SET status = ?2, updated_at = ?3 \
             WHERE id = ?1 AND origin_type = 'local-review' AND origin_parent_id IS NULL",
            params![comment_id, status, ts],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    if n == 0 {
        return Err(format!("review thread {comment_id} not found"));
    }
    Ok(())
}

/// All local-review comments for a review, ordered by file, line, then time
/// (roots first, replies follow by created_at).
pub fn list_comments_with_conn(
    db: &Connection,
    review_id: &str,
) -> rusqlite::Result<Vec<ReviewComment>> {
    let sql = format!(
        "SELECT {COMMENT_COLS} FROM file_comments \
         WHERE review_id = ?1 AND origin_type = 'local-review' \
         ORDER BY absolute_path ASC, anchor_line_start ASC, created_at ASC"
    );
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(params![review_id], row_to_comment)?;
    rows.collect()
}

// ── Re-anchor sweep (git + pure engine) ──────────────────────────────────

/// Re-anchor every OPEN/ADDRESSED root comment of `review_id` against
/// `new_head`, using each comment's own `anchor_commit` as the diff base so
/// coordinates stay consistent across rounds. Updates the DB in place and
/// returns the ids whose code changed. Requires a real git `repo`.
pub fn reanchor_open_comments(
    db: &Connection,
    repo: &Path,
    repo_root: &str,
    review_id: &str,
    new_head: &str,
) -> Result<Vec<String>, String> {
    let comments = list_comments_with_conn(db, review_id).map_err(|e| format!("DB error: {e}"))?;
    let mut changed_ids = Vec::new();
    for c in comments {
        if c.origin_parent_id.is_some() {
            continue; // replies don't anchor
        }
        let status = c.status.as_deref().unwrap_or(STATUS_OPEN);
        if status == STATUS_RESOLVED || status == STATUS_WONTFIX {
            continue;
        }
        let from = match c.anchor_commit.as_deref() {
            Some(f) if !f.is_empty() => f,
            _ => continue,
        };
        let rel = git::rel_path(repo_root, &c.absolute_path);
        let new_text = git::file_at_ref(repo, new_head, &rel)?;
        let diff = git::diff_file(repo, from, new_head, &rel).unwrap_or_default();
        let anchor = Anchor {
            start: c.anchor_line_start.max(0) as usize,
            end: c.anchor_line_end.max(0) as usize,
            anchor_text: c.anchor_text.clone().unwrap_or_default(),
            hash: String::new(),
        };
        let cl = classify(&new_text, &diff, &anchor);
        let ts = now();
        match cl.state {
            AnchorState::Unchanged => {
                let new_start = cl.new_line.unwrap_or(c.anchor_line_start as usize) as i64;
                let span = c.anchor_line_end - c.anchor_line_start;
                db.execute(
                    "UPDATE file_comments SET anchor_line_start=?2, anchor_line_end=?3, \
                     anchor_commit=?4, anchor_state='unchanged', updated_at=?5 WHERE id=?1",
                    params![c.id, new_start, new_start + span, new_head, ts],
                )
                .map_err(|e| format!("DB error: {e}"))?;
            }
            AnchorState::Changed => {
                let fix = git::fixing_commit(repo, from, new_head, &rel);
                db.execute(
                    "UPDATE file_comments SET anchor_state='changed', fixing_commit=?2, \
                     updated_at=?3 WHERE id=?1",
                    params![c.id, fix, ts],
                )
                .map_err(|e| format!("DB error: {e}"))?;
                changed_ids.push(c.id);
            }
        }
    }
    Ok(changed_ids)
}

// ── Tauri command wrappers ───────────────────────────────────────────────

fn workstream_dir(db: &Connection, workstream_id: &str) -> Result<String, String> {
    db.query_row(
        "SELECT directory FROM workstreams WHERE id = ?1",
        params![workstream_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .map_err(|e| format!("DB error: {e}"))?
    .ok_or_else(|| "workstream has no directory".to_string())
}

#[tauri::command]
pub fn create_agent_review(
    state: State<'_, AppState>,
    workstream_id: String,
    base_ref: Option<String>,
    head_ref: Option<String>,
) -> Result<AgentReview, String> {
    let db = state.db.lock().unwrap();
    // Resolve base/head from git when not supplied.
    let (base, head) = match workstream_dir(&db, &workstream_id) {
        Ok(dir) => {
            let repo = Path::new(&dir);
            let head = head_ref.clone().or_else(|| git::head_sha(repo).ok());
            let base = base_ref.clone().or_else(|| {
                git::merge_base(repo, "master", "HEAD")
                    .or_else(|_| git::merge_base(repo, "main", "HEAD"))
                    .ok()
            });
            (base, head)
        }
        Err(_) => (base_ref.clone(), head_ref.clone()),
    };
    create_review_with_conn(&db, &workstream_id, base.as_deref(), head.as_deref())
        .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn list_review_comments(
    state: State<'_, AppState>,
    review_id: String,
) -> Result<Vec<ReviewComment>, String> {
    let db = state.db.lock().unwrap();
    let mut comments =
        list_comments_with_conn(&db, &review_id).map_err(|e| format!("DB error: {e}"))?;
    // For changed roots, compute the per-comment before/after hunk on read.
    if let Some(review) = get_review(&db, &review_id).map_err(|e| format!("DB error: {e}"))? {
        if let Ok(dir) = workstream_dir(&db, &review.workstream_id) {
            let repo = Path::new(&dir);
            if let (Ok(root), Some(head)) = (git::repo_root(repo), review.head_ref.clone()) {
                for c in comments.iter_mut() {
                    if c.origin_parent_id.is_none() && c.anchor_state.as_deref() == Some("changed")
                    {
                        if let Some(from) = c.anchor_commit.clone() {
                            let rel = git::rel_path(&root, &c.absolute_path);
                            c.fixing_hunk = git::diff_file(repo, &from, &head, &rel).ok();
                        }
                    }
                }
            }
        }
    }
    Ok(comments)
}

#[tauri::command]
pub fn add_review_comment(
    state: State<'_, AppState>,
    review_id: String,
    absolute_path: String,
    anchor_line_start: i64,
    anchor_line_end: i64,
    body_md: String,
) -> Result<ReviewComment, String> {
    if anchor_line_end < anchor_line_start {
        return Err("anchor_line_end must be >= anchor_line_start".into());
    }
    let db = state.db.lock().unwrap();
    let review = get_review(&db, &review_id)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or("review not found")?;
    let dir = workstream_dir(&db, &review.workstream_id)?;
    let repo = Path::new(&dir);
    let head = git::head_sha(repo).unwrap_or_default();
    let root = git::repo_root(repo).unwrap_or_else(|_| dir.clone());
    let rel = git::rel_path(&root, &absolute_path);
    let text = git::file_at_ref(repo, &head, &rel).unwrap_or_default();
    let anchor = capture_anchor(
        &text,
        anchor_line_start.max(0) as usize,
        anchor_line_end.max(0) as usize,
    );
    let id = add_comment_row(
        &db,
        &review_id,
        &review.workstream_id,
        &absolute_path,
        anchor_line_start,
        anchor_line_end,
        Some(&anchor.anchor_text),
        Some(&anchor.hash),
        Some(&head),
        &body_md,
        review.round,
    )
    .map_err(|e| format!("DB error: {e}"))?;
    let sql = format!("SELECT {COMMENT_COLS} FROM file_comments WHERE id = ?1");
    db.query_row(&sql, params![id], row_to_comment)
        .map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn reply_review_comment(
    app: AppHandle,
    state: State<'_, AppState>,
    parent_id: String,
    body_md: String,
    author: String,
) -> Result<ReviewComment, String> {
    if author != "me" && author != "agent" {
        return Err("author must be 'me' or 'agent'".into());
    }
    let db = state.db.lock().unwrap();
    let id = reply_comment_row(&db, &parent_id, &body_md, &author)
        .map_err(|e| format!("DB error: {e}"))?;
    let sql = format!("SELECT {COMMENT_COLS} FROM file_comments WHERE id = ?1");
    let comment = db
        .query_row(&sql, params![id], row_to_comment)
        .map_err(|e| format!("DB error: {e}"))?;
    let _ = app.emit(
        events::COMMENT_UPDATED,
        serde_json::json!({ "reviewId": comment.review_id, "commentId": parent_id }),
    );
    Ok(comment)
}

#[tauri::command]
pub fn set_comment_resolution(
    app: AppHandle,
    state: State<'_, AppState>,
    comment_id: String,
    status: String,
    actor: String,
) -> Result<(), String> {
    let review_id: Option<String> = {
        let db = state.db.lock().unwrap();
        set_resolution_with_conn(&db, &comment_id, &status, &actor)?;
        db.query_row(
            "SELECT review_id FROM file_comments WHERE id = ?1",
            params![comment_id],
            |r| r.get(0),
        )
        .ok()
    };
    let _ = app.emit(
        events::COMMENT_UPDATED,
        serde_json::json!({ "reviewId": review_id, "commentId": comment_id }),
    );
    Ok(())
}

/// Snapshot the current HEAD, bump the round, and re-anchor open comments on a
/// **background thread** (never blocks the UI). Emits `review:round-ready`.
#[tauri::command]
pub fn submit_review_round(
    app: AppHandle,
    state: State<'_, AppState>,
    review_id: String,
) -> Result<(), String> {
    let (dir, review) = {
        let db = state.db.lock().unwrap();
        let review = get_review(&db, &review_id)
            .map_err(|e| format!("DB error: {e}"))?
            .ok_or("review not found")?;
        let dir = workstream_dir(&db, &review.workstream_id)?;
        (dir, review)
    };
    let repo = std::path::PathBuf::from(&dir);
    let new_head = git::head_sha(&repo).map_err(|e| format!("git error: {e}"))?;
    let root = git::repo_root(&repo).unwrap_or(dir);
    let db_path = crate::db::resolve_db_path();
    let next_round = review.round + 1;
    std::thread::spawn(move || {
        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[agent_review] round sweep: open db failed: {e}");
                return;
            }
        };
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        if let Err(e) = reanchor_open_comments(&conn, &repo, &root, &review_id, &new_head) {
            eprintln!("[agent_review] re-anchor failed: {e}");
        }
        let ts = now();
        let _ = conn.execute(
            "UPDATE agent_reviews SET round=?2, head_ref=?3, updated_at=?4 WHERE id=?1",
            params![review_id, next_round, new_head, ts],
        );
        let _ = app.emit(
            events::ROUND_READY,
            serde_json::json!({ "reviewId": review_id, "round": next_round }),
        );
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    fn seed_ws(conn: &Connection, id: &str, dir: &str) {
        conn.execute(
            "INSERT INTO workstreams (id, name, status, workstream_type, directory, created_at, updated_at) \
             VALUES (?1, 'WS', 'active', 'standalone', ?2, 't', 't')",
            params![id, dir],
        )
        .unwrap();
    }

    #[test]
    fn create_review_is_idempotent_per_workstream() {
        let conn = open();
        seed_ws(&conn, "w1", "/tmp/x");
        let a = create_review_with_conn(&conn, "w1", Some("base"), Some("head")).unwrap();
        let b = create_review_with_conn(&conn, "w1", Some("base"), Some("head")).unwrap();
        assert_eq!(
            a.id, b.id,
            "second create returns the existing active review"
        );
        assert_eq!(a.round, 1);
    }

    #[test]
    fn add_and_list_comments_roundtrip() {
        let conn = open();
        seed_ws(&conn, "w1", "/tmp/x");
        let r = create_review_with_conn(&conn, "w1", None, None).unwrap();
        add_comment_row(
            &conn,
            &r.id,
            "w1",
            "/tmp/x/a.js",
            4,
            4,
            Some("console.log()"),
            Some("hash"),
            Some("headsha"),
            "remove this",
            1,
        )
        .unwrap();
        let list = list_comments_with_conn(&conn, &r.id).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].author, "me");
        assert_eq!(list[0].status.as_deref(), Some("open"));
        assert_eq!(list[0].anchor_state.as_deref(), Some("unchanged"));
        assert_eq!(list[0].anchor_commit.as_deref(), Some("headsha"));
    }

    #[test]
    fn reply_inherits_thread_and_orders_after_root() {
        let conn = open();
        seed_ws(&conn, "w1", "/tmp/x");
        let r = create_review_with_conn(&conn, "w1", None, None).unwrap();
        let root = add_comment_row(
            &conn,
            &r.id,
            "w1",
            "/tmp/x/a.js",
            4,
            4,
            Some("x"),
            Some("h"),
            Some("c"),
            "root",
            1,
        )
        .unwrap();
        reply_comment_row(&conn, &root, "agent reply", "agent").unwrap();
        let list = list_comments_with_conn(&conn, &r.id).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].origin_parent_id, None);
        assert_eq!(list[1].origin_parent_id.as_deref(), Some(root.as_str()));
        assert_eq!(list[1].author, "agent");
    }

    #[test]
    fn resolution_role_guard_enforced() {
        let conn = open();
        seed_ws(&conn, "w1", "/tmp/x");
        let r = create_review_with_conn(&conn, "w1", None, None).unwrap();
        let root = add_comment_row(
            &conn,
            &r.id,
            "w1",
            "/tmp/x/a.js",
            4,
            4,
            Some("x"),
            Some("h"),
            Some("c"),
            "root",
            1,
        )
        .unwrap();
        // Agent may address / wontfix, but not resolve or reopen.
        assert!(set_resolution_with_conn(&conn, &root, STATUS_ADDRESSED, "agent").is_ok());
        assert!(set_resolution_with_conn(&conn, &root, STATUS_RESOLVED, "agent").is_err());
        assert!(set_resolution_with_conn(&conn, &root, STATUS_OPEN, "agent").is_err());
        // Reviewer may resolve.
        assert!(set_resolution_with_conn(&conn, &root, STATUS_RESOLVED, "me").is_ok());
        let list = list_comments_with_conn(&conn, &r.id).unwrap();
        assert_eq!(list[0].status.as_deref(), Some("resolved"));
        // Unknown actor rejected.
        assert!(set_resolution_with_conn(&conn, &root, STATUS_OPEN, "bob").is_err());
    }
}

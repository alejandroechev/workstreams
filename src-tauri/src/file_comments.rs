//! Inline file comments — per-workstream, anchored to a line range in a file.
//!
//! Mirrors `src/domain/file-comments.ts`. See plan in `~/.copilot/session-state/.../plan.md`.

use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileComment {
    pub id: String,
    pub workstream_id: String,
    pub absolute_path: String,
    pub anchor_line_start: i64,
    pub anchor_line_end: i64,
    pub anchor_text: Option<String>,
    pub body_md: String,
    pub author: String,
    pub origin_type: String,
    pub origin_pr_id: Option<String>,
    pub origin_comment_id: Option<String>,
    pub origin_thread_id: Option<String>,
    pub origin_parent_id: Option<String>,
    pub origin_url: Option<String>,
    pub status: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportedCommentInput {
    pub absolute_path: String,
    pub anchor_line_start: i64,
    pub anchor_line_end: i64,
    pub anchor_text: Option<String>,
    pub body_md: String,
    pub author: String,
    pub origin_pr_id: String,
    pub origin_comment_id: String,
    pub origin_thread_id: Option<String>,
    pub origin_parent_id: Option<String>,
    pub origin_url: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportSummary {
    pub inserted: i64,
    pub skipped: i64,
}

fn row_to_comment(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileComment> {
    Ok(FileComment {
        id: row.get(0)?,
        workstream_id: row.get(1)?,
        absolute_path: row.get(2)?,
        anchor_line_start: row.get(3)?,
        anchor_line_end: row.get(4)?,
        anchor_text: row.get(5)?,
        body_md: row.get(6)?,
        author: row.get(7)?,
        origin_type: row.get(8)?,
        origin_pr_id: row.get(9)?,
        origin_comment_id: row.get(10)?,
        origin_thread_id: row.get(11)?,
        origin_parent_id: row.get(12)?,
        origin_url: row.get(13)?,
        status: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

const SELECT_COLUMNS: &str =
    "id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, \
     anchor_text, body_md, author, origin_type, origin_pr_id, origin_comment_id, \
     origin_thread_id, origin_parent_id, origin_url, status, created_at, updated_at";

#[tauri::command]
pub fn list_file_comments(
    state: State<'_, AppState>,
    workstream_id: String,
    absolute_path: String,
) -> Result<Vec<FileComment>, String> {
    let db = state.db.lock().unwrap();
    list_file_comments_with_conn(&db, &workstream_id, &absolute_path)
        .map_err(|e| format!("DB error: {e}"))
}

pub fn list_file_comments_with_conn(
    db: &Connection,
    workstream_id: &str,
    absolute_path: &str,
) -> rusqlite::Result<Vec<FileComment>> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM file_comments \
         WHERE workstream_id = ?1 AND absolute_path = ?2 \
         ORDER BY anchor_line_start ASC, created_at ASC"
    );
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(params![workstream_id, absolute_path], row_to_comment)?;
    rows.collect()
}

#[tauri::command]
pub fn add_file_comment(
    state: State<'_, AppState>,
    workstream_id: String,
    absolute_path: String,
    anchor_line_start: i64,
    anchor_line_end: i64,
    anchor_text: Option<String>,
    body_md: String,
) -> Result<FileComment, String> {
    if anchor_line_end < anchor_line_start {
        return Err("anchor_line_end must be >= anchor_line_start".to_string());
    }
    let id = new_id();
    let ts = now();
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO file_comments \
            (id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, \
             anchor_text, body_md, author, origin_type, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'me', 'user', ?8, ?8)",
        params![
            id,
            workstream_id,
            absolute_path,
            anchor_line_start,
            anchor_line_end,
            anchor_text,
            body_md,
            ts,
        ],
    )
    .map_err(|e| format!("DB error: {e}"))?;
    Ok(FileComment {
        id,
        workstream_id,
        absolute_path,
        anchor_line_start,
        anchor_line_end,
        anchor_text,
        body_md,
        author: "me".to_string(),
        origin_type: "user".to_string(),
        origin_pr_id: None,
        origin_comment_id: None,
        origin_thread_id: None,
        origin_parent_id: None,
        origin_url: None,
        status: None,
        created_at: ts.clone(),
        updated_at: ts,
    })
}

#[tauri::command]
pub fn update_file_comment(
    state: State<'_, AppState>,
    id: String,
    body_md: String,
) -> Result<FileComment, String> {
    let ts = now();
    let db = state.db.lock().unwrap();
    let updated = db
        .execute(
            "UPDATE file_comments SET body_md = ?2, updated_at = ?3 \
             WHERE id = ?1 AND origin_type = 'user'",
            params![id, body_md, ts],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    if updated == 0 {
        return Err(format!(
            "comment {id} not found or not editable (imported comments are read-only)"
        ));
    }
    let sql = format!("SELECT {SELECT_COLUMNS} FROM file_comments WHERE id = ?1");
    let comment = db
        .query_row(&sql, params![id], row_to_comment)
        .map_err(|e| format!("DB error: {e}"))?;
    Ok(comment)
}

#[tauri::command]
pub fn delete_file_comment(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    let deleted = db
        .execute(
            "DELETE FROM file_comments WHERE id = ?1 AND origin_type = 'user'",
            params![id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    if deleted == 0 {
        return Err(format!(
            "comment {id} not found or not deletable (imported comments are read-only)"
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn import_pr_comments(
    state: State<'_, AppState>,
    workstream_id: String,
    items: Vec<ImportedCommentInput>,
) -> Result<ImportSummary, String> {
    let ts = now();
    let mut db = state.db.lock().unwrap();
    let tx = db.transaction().map_err(|e| format!("DB error: {e}"))?;
    let mut inserted: i64 = 0;
    let mut skipped: i64 = 0;
    for item in items {
        if item.anchor_line_end < item.anchor_line_start {
            tx.rollback().ok();
            return Err(format!(
                "invalid anchor for {}:{}-{} (end < start)",
                item.absolute_path, item.anchor_line_start, item.anchor_line_end
            ));
        }
        let id = new_id();
        let result = tx.execute(
            "INSERT OR IGNORE INTO file_comments \
                (id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, \
                 anchor_text, body_md, author, origin_type, origin_pr_id, origin_comment_id, \
                 origin_thread_id, origin_parent_id, origin_url, status, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ado-pr', ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
            params![
                id,
                workstream_id,
                item.absolute_path,
                item.anchor_line_start,
                item.anchor_line_end,
                item.anchor_text,
                item.body_md,
                item.author,
                item.origin_pr_id,
                item.origin_comment_id,
                item.origin_thread_id,
                item.origin_parent_id,
                item.origin_url,
                item.status,
                ts,
            ],
        );
        match result {
            Ok(1) => inserted += 1,
            Ok(_) => skipped += 1,
            Err(e) => {
                tx.rollback().ok();
                return Err(format!("DB error: {e}"));
            }
        }
    }
    tx.commit().map_err(|e| format!("DB error: {e}"))?;
    Ok(ImportSummary { inserted, skipped })
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

    fn insert_user(
        conn: &Connection,
        ws: &str,
        path: &str,
        start: i64,
        end: i64,
        body: &str,
    ) -> String {
        let id = new_id();
        let ts = now();
        conn.execute(
            "INSERT INTO file_comments \
                (id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, \
                 anchor_text, body_md, author, origin_type, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 'me', 'user', ?7, ?7)",
            params![id, ws, path, start, end, body, ts],
        )
        .unwrap();
        id
    }

    #[test]
    fn list_returns_comments_ordered_by_anchor_then_created() {
        let conn = open();
        insert_user(&conn, "ws-1", "C:\\a.ts", 10, 10, "second");
        insert_user(&conn, "ws-1", "C:\\a.ts", 5, 7, "first");
        insert_user(&conn, "ws-1", "C:\\b.ts", 1, 1, "other file");
        let comments = list_file_comments_with_conn(&conn, "ws-1", "C:\\a.ts").unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].body_md, "first");
        assert_eq!(comments[1].body_md, "second");
    }

    #[test]
    fn list_isolates_by_workstream_and_path() {
        let conn = open();
        insert_user(&conn, "ws-1", "C:\\a.ts", 1, 1, "ws1-a");
        insert_user(&conn, "ws-2", "C:\\a.ts", 1, 1, "ws2-a");
        let r = list_file_comments_with_conn(&conn, "ws-1", "C:\\a.ts").unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].body_md, "ws1-a");
    }

    #[test]
    fn import_dedupes_by_origin_keys() {
        let conn = open();
        let ts = now();
        let insert = |comment_id: &str, body: &str| {
            let id = new_id();
            conn.execute(
                "INSERT OR IGNORE INTO file_comments \
                    (id, workstream_id, absolute_path, anchor_line_start, anchor_line_end, \
                     anchor_text, body_md, author, origin_type, origin_pr_id, origin_comment_id, \
                     origin_thread_id, origin_parent_id, origin_url, status, created_at, updated_at) \
                 VALUES (?1, 'ws-1', 'C:\\a.ts', 1, 1, NULL, ?2, 'bob', 'ado-pr', \
                         '42', ?3, NULL, NULL, NULL, 'active', ?4, ?4)",
                params![id, body, comment_id, ts],
            )
            .unwrap()
        };
        assert_eq!(insert("c-1", "first"), 1);
        assert_eq!(insert("c-1", "duplicate"), 0); // skipped by UNIQUE INDEX
        assert_eq!(insert("c-2", "second"), 1);
        let comments = list_file_comments_with_conn(&conn, "ws-1", "C:\\a.ts").unwrap();
        assert_eq!(comments.len(), 2);
    }

    #[test]
    fn dedup_index_does_not_block_two_user_comments_at_same_anchor() {
        // origin_pr_id + origin_comment_id are NULL for user comments,
        // and the unique index is partial (only origin_type='ado-pr').
        let conn = open();
        insert_user(&conn, "ws-1", "C:\\a.ts", 1, 1, "first");
        insert_user(&conn, "ws-1", "C:\\a.ts", 1, 1, "second");
        let r = list_file_comments_with_conn(&conn, "ws-1", "C:\\a.ts").unwrap();
        assert_eq!(r.len(), 2);
    }
}

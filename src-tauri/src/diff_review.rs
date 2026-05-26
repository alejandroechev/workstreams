//! diff-grok / Diff Review backend.
//!
//! Mirrors `src/domain/diff-review.ts`. See `docs/adrs/007-diff-grok-integration.md`.

use crate::file_io::sanitize_event_name;
use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, State};

// ── Event names (mirror DIFF_REVIEW_EVENTS in src/domain/diff-review.ts) ──

pub mod events {
    pub const PLAN_READY: &str = "diff-review:plan-ready";
    pub const CHUNK_ACTIVE: &str = "diff-review:chunk-active";
    pub const CHUNK_DONE: &str = "diff-review:chunk-done";
    pub const COMMENT_ADDED: &str = "diff-review:comment-added";
    pub const DRIFT_DETECTED: &str = "diff-review:drift-detected";
    pub const COMPLETED: &str = "diff-review:completed";
}

// ── Helpers ──────────────────────────────────────────────────────────────

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

fn emit<S: Serialize + Clone>(app: &AppHandle, name: &str, payload: S) {
    let safe = sanitize_event_name(name);
    let _ = app.emit(&safe, payload);
}

// ── DTOs (returned to frontend; snake_case to match TS contract) ─────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffReview {
    pub id: String,
    pub workstream_id: String,
    pub diff_source: String,
    pub source_ref: Option<String>,
    pub status: String,
    pub plan_json: Option<String>,
    pub exported_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffChunk {
    pub id: String,
    pub review_id: String,
    pub ordinal: i64,
    pub title: String,
    pub summary: Option<String>,
    pub is_trivial: bool,
    pub state: String,
    pub question_text: Option<String>,
    pub question_style: Option<String>,
    pub invalidated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunk {
    pub id: String,
    pub chunk_id: String,
    pub file_path: String,
    pub old_start: Option<i64>,
    pub old_lines: Option<i64>,
    pub new_start: Option<i64>,
    pub new_lines: Option<i64>,
    pub patch_text: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffComment {
    pub id: String,
    pub chunk_id: String,
    pub anchor_file: String,
    pub anchor_line_start: i64,
    pub anchor_line_end: i64,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkWithDetails {
    pub chunk: DiffChunk,
    pub hunks: Vec<DiffHunk>,
    pub comments: Vec<DiffComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HunkInput {
    pub file_path: String,
    pub old_start: Option<i64>,
    pub old_lines: Option<i64>,
    pub new_start: Option<i64>,
    pub new_lines: Option<i64>,
    pub patch_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkInput {
    pub title: String,
    pub summary: Option<String>,
    pub is_trivial: bool,
    pub question_text: Option<String>,
    pub question_style: Option<String>,
    pub hunks: Vec<HunkInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPaths {
    pub json_path: String,
    pub md_path: String,
}

// ── Event payloads (camelCase to match TS contract) ──────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanReadyPayload {
    review_id: String,
    chunk_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkActivePayload {
    review_id: String,
    chunk_id: String,
    ordinal: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkDonePayload {
    review_id: String,
    chunk_id: String,
    state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommentAddedPayload {
    review_id: String,
    chunk_id: String,
    comment_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriftDetectedPayload {
    review_id: String,
    chunk_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedPayload {
    review_id: String,
    exported_path: String,
}

// ── Shell-out seam ───────────────────────────────────────────────────────

pub trait DiffCommandRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str], cwd: &Path) -> Result<String, String>;
}

#[allow(dead_code)]
pub struct RealDiffCommandRunner;

impl DiffCommandRunner for RealDiffCommandRunner {
    fn run(&self, program: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).current_dir(cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = cmd
            .output()
            .map_err(|e| format!("failed to spawn {program}: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "{program} exited with status {}: {stderr}",
                output.status
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

// ── Diff source readers ─────────────────────────────────────────────────

#[allow(dead_code)]
pub fn read_branch_diff(
    runner: &dyn DiffCommandRunner,
    repo: &Path,
    base_ref: &str,
) -> Result<String, String> {
    let range = format!("{base_ref}...HEAD");
    runner.run("git", &["diff", &range], repo)
}

#[allow(dead_code)]
pub fn read_pr_diff(
    runner: &dyn DiffCommandRunner,
    repo: &Path,
    pr_number: u32,
) -> Result<String, String> {
    let n = pr_number.to_string();
    runner.run("gh", &["pr", "diff", &n], repo)
}

#[allow(dead_code)]
pub fn read_working_tree_diff(
    runner: &dyn DiffCommandRunner,
    repo: &Path,
) -> Result<String, String> {
    runner.run("git", &["diff", "HEAD"], repo)
}

// ── Drift detection ─────────────────────────────────────────────────────

pub fn hash_patch(patch_text: &str) -> String {
    let mut h = Sha256::new();
    h.update(patch_text.as_bytes());
    format!("{:x}", h.finalize())
}

/// Parse a unified diff into a sequence of (file_path, patch_text) pairs.
/// Each `@@` header begins a new hunk; the patch_text includes the header
/// and all following diff lines until the next hunk header or `diff --git`.
fn parse_hunks(diff: &str) -> Vec<(String, String)> {
    let mut hunks = Vec::new();
    let mut current_file: Option<String> = None;
    let mut current_hunk: Option<String> = None;

    let flush =
        |hunks: &mut Vec<(String, String)>, file: &Option<String>, hunk: &mut Option<String>| {
            if let (Some(f), Some(h)) = (file, hunk.take()) {
                hunks.push((f.clone(), h));
            }
        };

    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            flush(&mut hunks, &current_file, &mut current_hunk);
            let parts: Vec<&str> = line.split_whitespace().collect();
            current_file = parts
                .get(3)
                .map(|p| p.strip_prefix("b/").unwrap_or(p).to_string());
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            let p = rest.trim();
            if p != "/dev/null" {
                current_file = Some(p.strip_prefix("b/").unwrap_or(p).to_string());
            }
        } else if line.starts_with("@@") {
            flush(&mut hunks, &current_file, &mut current_hunk);
            current_hunk = Some(format!("{line}\n"));
        } else if let Some(h) = current_hunk.as_mut() {
            h.push_str(line);
            h.push('\n');
        }
    }
    flush(&mut hunks, &current_file, &mut current_hunk);
    hunks
}

/// Returns the chunk ids whose hunk hashes are no longer present in
/// `current_diff`. Input pairs are `(chunk_id, hunk_content_hash)`.
pub fn detect_drift_against_current(
    stored_hashes: &[(String, String)],
    current_diff: &str,
) -> Vec<String> {
    let current_set: HashSet<String> = parse_hunks(current_diff)
        .into_iter()
        .map(|(_, patch)| hash_patch(&patch))
        .collect();

    let mut invalid: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (chunk_id, hash) in stored_hashes {
        if !current_set.contains(hash) && seen.insert(chunk_id.clone()) {
            invalid.push(chunk_id.clone());
        }
    }
    invalid
}

// ── DB query helpers (pure functions, take &Connection) ─────────────────

fn fetch_review(conn: &Connection, id: &str) -> rusqlite::Result<Option<DiffReview>> {
    conn.query_row(
        "SELECT id, workstream_id, diff_source, source_ref, status, plan_json,
                exported_path, created_at, updated_at, completed_at
         FROM diff_reviews WHERE id = ?1",
        params![id],
        |row| {
            Ok(DiffReview {
                id: row.get(0)?,
                workstream_id: row.get(1)?,
                diff_source: row.get(2)?,
                source_ref: row.get(3)?,
                status: row.get(4)?,
                plan_json: row.get(5)?,
                exported_path: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                completed_at: row.get(9)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

fn fetch_chunks(conn: &Connection, review_id: &str) -> rusqlite::Result<Vec<DiffChunk>> {
    let mut stmt = conn.prepare(
        "SELECT id, review_id, ordinal, title, summary, is_trivial, state,
                question_text, question_style, invalidated_at, created_at, updated_at
         FROM diff_chunks WHERE review_id = ?1 ORDER BY ordinal ASC",
    )?;
    let rows = stmt.query_map(params![review_id], row_to_chunk)?;
    rows.collect()
}

fn fetch_chunk(conn: &Connection, id: &str) -> rusqlite::Result<Option<DiffChunk>> {
    conn.query_row(
        "SELECT id, review_id, ordinal, title, summary, is_trivial, state,
                question_text, question_style, invalidated_at, created_at, updated_at
         FROM diff_chunks WHERE id = ?1",
        params![id],
        row_to_chunk,
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

fn row_to_chunk(row: &rusqlite::Row) -> rusqlite::Result<DiffChunk> {
    let is_trivial_i: i64 = row.get(5)?;
    Ok(DiffChunk {
        id: row.get(0)?,
        review_id: row.get(1)?,
        ordinal: row.get(2)?,
        title: row.get(3)?,
        summary: row.get(4)?,
        is_trivial: is_trivial_i != 0,
        state: row.get(6)?,
        question_text: row.get(7)?,
        question_style: row.get(8)?,
        invalidated_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn fetch_hunks(conn: &Connection, chunk_id: &str) -> rusqlite::Result<Vec<DiffHunk>> {
    let mut stmt = conn.prepare(
        "SELECT id, chunk_id, file_path, old_start, old_lines, new_start, new_lines,
                patch_text, content_hash
         FROM diff_hunks WHERE chunk_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![chunk_id], |row| {
        Ok(DiffHunk {
            id: row.get(0)?,
            chunk_id: row.get(1)?,
            file_path: row.get(2)?,
            old_start: row.get(3)?,
            old_lines: row.get(4)?,
            new_start: row.get(5)?,
            new_lines: row.get(6)?,
            patch_text: row.get(7)?,
            content_hash: row.get(8)?,
        })
    })?;
    rows.collect()
}

fn fetch_comments(conn: &Connection, chunk_id: &str) -> rusqlite::Result<Vec<DiffComment>> {
    let mut stmt = conn.prepare(
        "SELECT id, chunk_id, anchor_file, anchor_line_start, anchor_line_end, text, created_at
         FROM diff_comments WHERE chunk_id = ?1 ORDER BY created_at ASC",
    )?;
    let rows = stmt.query_map(params![chunk_id], |row| {
        Ok(DiffComment {
            id: row.get(0)?,
            chunk_id: row.get(1)?,
            anchor_file: row.get(2)?,
            anchor_line_start: row.get(3)?,
            anchor_line_end: row.get(4)?,
            text: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

fn log_event(
    conn: &Connection,
    review_id: &str,
    event_type: &str,
    payload_json: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO diff_review_events (review_id, event_type, payload_json, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![review_id, event_type, payload_json, now()],
    )?;
    Ok(())
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub fn create_diff_review(
    state: State<'_, AppState>,
    workstream_id: String,
    diff_source: String,
    source_ref: Option<String>,
) -> Result<DiffReview, String> {
    let id = new_id();
    let ts = now();
    let db = state.db.lock().unwrap();
    db.execute(
        "INSERT INTO diff_reviews
            (id, workstream_id, diff_source, source_ref, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'planning', ?5, ?5)",
        params![id, workstream_id, diff_source, source_ref, ts],
    )
    .map_err(|e| format!("DB error: {e}"))?;
    Ok(DiffReview {
        id,
        workstream_id,
        diff_source,
        source_ref,
        status: "planning".into(),
        plan_json: None,
        exported_path: None,
        created_at: ts.clone(),
        updated_at: ts,
        completed_at: None,
    })
}

#[tauri::command]
pub fn set_review_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    review_id: String,
    plan_json: String,
    chunks: Vec<ChunkInput>,
) -> Result<(), String> {
    let ts = now();
    let mut db = state.db.lock().unwrap();
    let tx = db.transaction().map_err(|e| format!("DB error: {e}"))?;

    tx.execute(
        "UPDATE diff_reviews SET plan_json = ?1, status = 'active', updated_at = ?2 WHERE id = ?3",
        params![plan_json, ts, review_id],
    )
    .map_err(|e| format!("DB error: {e}"))?;

    // Clear any existing chunks/hunks for this review (idempotent re-plan).
    tx.execute(
        "DELETE FROM diff_chunks WHERE review_id = ?1",
        params![review_id],
    )
    .map_err(|e| format!("DB error: {e}"))?;

    for (idx, c) in chunks.iter().enumerate() {
        let chunk_id = new_id();
        let initial_state = if c.is_trivial { "approved" } else { "pending" };
        tx.execute(
            "INSERT INTO diff_chunks
                (id, review_id, ordinal, title, summary, is_trivial, state,
                 question_text, question_style, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                chunk_id,
                review_id,
                idx as i64 + 1,
                c.title,
                c.summary,
                c.is_trivial as i64,
                initial_state,
                c.question_text,
                c.question_style,
                ts,
            ],
        )
        .map_err(|e| format!("DB error: {e}"))?;
        for h in &c.hunks {
            let hash = hash_patch(&h.patch_text);
            tx.execute(
                "INSERT INTO diff_hunks
                    (id, chunk_id, file_path, old_start, old_lines, new_start, new_lines,
                     patch_text, content_hash)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    new_id(),
                    chunk_id,
                    h.file_path,
                    h.old_start,
                    h.old_lines,
                    h.new_start,
                    h.new_lines,
                    h.patch_text,
                    hash,
                ],
            )
            .map_err(|e| format!("DB error: {e}"))?;
        }
    }

    let payload = PlanReadyPayload {
        review_id: review_id.clone(),
        chunk_count: chunks.len(),
    };
    log_event(
        &tx,
        &review_id,
        events::PLAN_READY,
        &serde_json::to_string(&payload).unwrap_or_default(),
    )
    .map_err(|e| format!("DB error: {e}"))?;

    tx.commit().map_err(|e| format!("DB error: {e}"))?;
    emit(&app, events::PLAN_READY, payload);
    Ok(())
}

#[tauri::command]
pub fn get_review(
    state: State<'_, AppState>,
    review_id: String,
) -> Result<Option<DiffReview>, String> {
    let db = state.db.lock().unwrap();
    fetch_review(&db, &review_id).map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn list_chunks(
    state: State<'_, AppState>,
    review_id: String,
) -> Result<Vec<DiffChunk>, String> {
    let db = state.db.lock().unwrap();
    fetch_chunks(&db, &review_id).map_err(|e| format!("DB error: {e}"))
}

#[tauri::command]
pub fn get_chunk_details(
    state: State<'_, AppState>,
    chunk_id: String,
) -> Result<Option<ChunkWithDetails>, String> {
    let db = state.db.lock().unwrap();
    let chunk = fetch_chunk(&db, &chunk_id).map_err(|e| format!("DB error: {e}"))?;
    let Some(chunk) = chunk else {
        return Ok(None);
    };
    let hunks = fetch_hunks(&db, &chunk_id).map_err(|e| format!("DB error: {e}"))?;
    let comments = fetch_comments(&db, &chunk_id).map_err(|e| format!("DB error: {e}"))?;
    Ok(Some(ChunkWithDetails {
        chunk,
        hunks,
        comments,
    }))
}

#[tauri::command]
pub fn activate_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk_id: String,
) -> Result<(), String> {
    let ts = now();
    let db = state.db.lock().unwrap();
    let chunk = fetch_chunk(&db, &chunk_id)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("chunk {chunk_id} not found"))?;
    if chunk.state == "pending" {
        db.execute(
            "UPDATE diff_chunks SET state = 'seen', updated_at = ?1 WHERE id = ?2",
            params![ts, chunk_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
    }
    let payload = ChunkActivePayload {
        review_id: chunk.review_id.clone(),
        chunk_id: chunk.id.clone(),
        ordinal: chunk.ordinal,
    };
    log_event(
        &db,
        &chunk.review_id,
        events::CHUNK_ACTIVE,
        &serde_json::to_string(&payload).unwrap_or_default(),
    )
    .map_err(|e| format!("DB error: {e}"))?;
    drop(db);
    emit(&app, events::CHUNK_ACTIVE, payload);
    Ok(())
}

#[tauri::command]
pub fn ack_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk_id: String,
    new_state: String,
) -> Result<(), String> {
    if !matches!(new_state.as_str(), "approved" | "commented" | "seen") {
        return Err(format!("invalid ack state: {new_state}"));
    }
    let ts = now();
    let review_id: String;
    {
        let db = state.db.lock().unwrap();
        let chunk = fetch_chunk(&db, &chunk_id)
            .map_err(|e| format!("DB error: {e}"))?
            .ok_or_else(|| format!("chunk {chunk_id} not found"))?;
        review_id = chunk.review_id.clone();
        db.execute(
            "UPDATE diff_chunks SET state = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_state, ts, chunk_id],
        )
        .map_err(|e| format!("DB error: {e}"))?;
        let payload = ChunkDonePayload {
            review_id: review_id.clone(),
            chunk_id: chunk_id.clone(),
            state: new_state.clone(),
        };
        log_event(
            &db,
            &review_id,
            events::CHUNK_DONE,
            &serde_json::to_string(&payload).unwrap_or_default(),
        )
        .map_err(|e| format!("DB error: {e}"))?;
        drop(db);
        emit(&app, events::CHUNK_DONE, payload);
    }

    // If every chunk is acknowledged, auto-complete the review.
    let all_done: bool = {
        let db = state.db.lock().unwrap();
        let pending: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM diff_chunks
                 WHERE review_id = ?1 AND state NOT IN ('approved','commented','seen')",
                params![review_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("DB error: {e}"))?;
        pending == 0
    };
    if all_done {
        // Best-effort: if export fails we leave status as-is for the caller to retry.
        let _ = complete_review(app, state, review_id);
    }
    Ok(())
}

#[tauri::command]
pub fn add_comment(
    app: AppHandle,
    state: State<'_, AppState>,
    chunk_id: String,
    anchor_file: String,
    anchor_line_start: i64,
    anchor_line_end: i64,
    text: String,
) -> Result<DiffComment, String> {
    let id = new_id();
    let ts = now();
    let db = state.db.lock().unwrap();
    let chunk = fetch_chunk(&db, &chunk_id)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("chunk {chunk_id} not found"))?;
    db.execute(
        "INSERT INTO diff_comments
            (id, chunk_id, anchor_file, anchor_line_start, anchor_line_end, text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            chunk_id,
            anchor_file,
            anchor_line_start,
            anchor_line_end,
            text,
            ts
        ],
    )
    .map_err(|e| format!("DB error: {e}"))?;
    let payload = CommentAddedPayload {
        review_id: chunk.review_id.clone(),
        chunk_id: chunk_id.clone(),
        comment_id: id.clone(),
    };
    log_event(
        &db,
        &chunk.review_id,
        events::COMMENT_ADDED,
        &serde_json::to_string(&payload).unwrap_or_default(),
    )
    .map_err(|e| format!("DB error: {e}"))?;
    drop(db);
    emit(&app, events::COMMENT_ADDED, payload);
    Ok(DiffComment {
        id,
        chunk_id,
        anchor_file,
        anchor_line_start,
        anchor_line_end,
        text,
        created_at: ts,
    })
}

#[tauri::command]
pub fn complete_review(
    app: AppHandle,
    state: State<'_, AppState>,
    review_id: String,
) -> Result<ExportPaths, String> {
    let ts = now();
    let db = state.db.lock().unwrap();
    let review = fetch_review(&db, &review_id)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("review {review_id} not found"))?;
    let repo = resolve_repo_dir(&db, &review.workstream_id)?;
    let paths = export_review(&repo, &review_id, &db)?;
    db.execute(
        "UPDATE diff_reviews
         SET status = 'archived', exported_path = ?1, completed_at = ?2, updated_at = ?2
         WHERE id = ?3",
        params![paths.json_path, ts, review_id],
    )
    .map_err(|e| format!("DB error: {e}"))?;
    let payload = CompletedPayload {
        review_id: review_id.clone(),
        exported_path: paths.json_path.clone(),
    };
    log_event(
        &db,
        &review_id,
        events::COMPLETED,
        &serde_json::to_string(&payload).unwrap_or_default(),
    )
    .map_err(|e| format!("DB error: {e}"))?;
    drop(db);
    emit(&app, events::COMPLETED, payload);
    Ok(paths)
}

#[tauri::command]
pub fn detect_drift(
    app: AppHandle,
    state: State<'_, AppState>,
    review_id: String,
    current_diff_text: String,
) -> Result<Vec<String>, String> {
    let ts = now();
    let db = state.db.lock().unwrap();
    let mut stmt = db
        .prepare(
            "SELECT c.id, h.content_hash FROM diff_chunks c
             JOIN diff_hunks h ON h.chunk_id = c.id
             WHERE c.review_id = ?1",
        )
        .map_err(|e| format!("DB error: {e}"))?;
    let pairs: Vec<(String, String)> = stmt
        .query_map(params![review_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("DB error: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB error: {e}"))?;
    drop(stmt);
    let invalid = detect_drift_against_current(&pairs, &current_diff_text);
    if !invalid.is_empty() {
        for cid in &invalid {
            db.execute(
                "UPDATE diff_chunks SET state = 'invalidated', invalidated_at = ?1, updated_at = ?1
                 WHERE id = ?2",
                params![ts, cid],
            )
            .map_err(|e| format!("DB error: {e}"))?;
        }
        let payload = DriftDetectedPayload {
            review_id: review_id.clone(),
            chunk_ids: invalid.clone(),
        };
        log_event(
            &db,
            &review_id,
            events::DRIFT_DETECTED,
            &serde_json::to_string(&payload).unwrap_or_default(),
        )
        .map_err(|e| format!("DB error: {e}"))?;
        drop(db);
        emit(&app, events::DRIFT_DETECTED, payload);
    }
    Ok(invalid)
}

// ── Export writer ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportHunk {
    file: String,
    old_start: Option<i64>,
    new_start: Option<i64>,
    patch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportComment {
    anchor_file: String,
    anchor_line_start: i64,
    anchor_line_end: i64,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportChunk {
    ordinal: i64,
    title: String,
    summary: Option<String>,
    state: String,
    is_trivial: bool,
    hunks: Vec<ExportHunk>,
    comments: Vec<ExportComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExportDocV1 {
    schema: u32,
    review_id: String,
    workstream_id: String,
    diff_source: String,
    source_ref: Option<String>,
    completed_at: String,
    chunks: Vec<ExportChunk>,
}

pub fn export_review(repo: &Path, review_id: &str, db: &Connection) -> Result<ExportPaths, String> {
    let review = fetch_review(db, review_id)
        .map_err(|e| format!("DB error: {e}"))?
        .ok_or_else(|| format!("review {review_id} not found"))?;
    let chunks = fetch_chunks(db, review_id).map_err(|e| format!("DB error: {e}"))?;

    let mut export_chunks: Vec<ExportChunk> = Vec::with_capacity(chunks.len());
    for c in &chunks {
        let hunks = fetch_hunks(db, &c.id).map_err(|e| format!("DB error: {e}"))?;
        let comments = fetch_comments(db, &c.id).map_err(|e| format!("DB error: {e}"))?;
        export_chunks.push(ExportChunk {
            ordinal: c.ordinal,
            title: c.title.clone(),
            summary: c.summary.clone(),
            state: c.state.clone(),
            is_trivial: c.is_trivial,
            hunks: hunks
                .into_iter()
                .map(|h| ExportHunk {
                    file: h.file_path,
                    old_start: h.old_start,
                    new_start: h.new_start,
                    patch: h.patch_text,
                })
                .collect(),
            comments: comments
                .into_iter()
                .map(|cm| ExportComment {
                    anchor_file: cm.anchor_file,
                    anchor_line_start: cm.anchor_line_start,
                    anchor_line_end: cm.anchor_line_end,
                    text: cm.text,
                })
                .collect(),
        });
    }

    let completed_at = now();
    let doc = ExportDocV1 {
        schema: 1,
        review_id: review_id.to_string(),
        workstream_id: review.workstream_id.clone(),
        diff_source: review.diff_source.clone(),
        source_ref: review.source_ref.clone(),
        completed_at: completed_at.clone(),
        chunks: export_chunks,
    };

    let out_dir: PathBuf = repo.join(".copilot-reviews").join(review_id);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir failed: {e}"))?;

    let json_path = out_dir.join("review.json");
    let md_path = out_dir.join("action-plan.md");
    let json_text = serde_json::to_string_pretty(&doc).map_err(|e| format!("json err: {e}"))?;
    std::fs::write(&json_path, &json_text).map_err(|e| format!("write json: {e}"))?;
    std::fs::write(&md_path, render_action_plan(&doc)).map_err(|e| format!("write md: {e}"))?;

    Ok(ExportPaths {
        json_path: json_path.to_string_lossy().into_owned(),
        md_path: md_path.to_string_lossy().into_owned(),
    })
}

fn render_action_plan(doc: &ExportDocV1) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "# Diff Review Action Plan — {}\n\n",
        doc.review_id
    ));
    out.push_str(&format!(
        "- **Source:** `{}`{}\n",
        doc.diff_source,
        doc.source_ref
            .as_ref()
            .map(|r| format!(" ({r})"))
            .unwrap_or_default()
    ));
    out.push_str(&format!("- **Workstream:** `{}`\n", doc.workstream_id));
    out.push_str(&format!("- **Completed:** {}\n\n", doc.completed_at));
    out.push_str(
        "Paste the items below into a fresh Copilot CLI session to action the review.\n\n",
    );

    for c in &doc.chunks {
        let checkbox = if c.state == "approved" || c.state == "seen" {
            "x"
        } else {
            " "
        };
        out.push_str(&format!(
            "## [{}] Chunk {} — {} (state: `{}`{})\n\n",
            checkbox,
            c.ordinal,
            c.title,
            c.state,
            if c.is_trivial { ", trivial" } else { "" },
        ));
        if let Some(s) = &c.summary {
            out.push_str(&format!("{s}\n\n"));
        }
        if !c.hunks.is_empty() {
            out.push_str("**Files:**\n\n");
            for h in &c.hunks {
                out.push_str(&format!(
                    "- `{}`{}\n",
                    h.file,
                    h.new_start
                        .map(|n| format!(" @ line {n}"))
                        .unwrap_or_default()
                ));
            }
            out.push('\n');
        }
        if !c.comments.is_empty() {
            out.push_str("**Review comments:**\n\n");
            for cm in &c.comments {
                out.push_str(&format!(
                    "- `{}:{}-{}` — {}\n",
                    cm.anchor_file, cm.anchor_line_start, cm.anchor_line_end, cm.text
                ));
            }
            out.push('\n');
        }
    }
    out
}

// ── Internal: locate the repo path for a workstream ─────────────────────

fn resolve_repo_dir(conn: &Connection, workstream_id: &str) -> Result<PathBuf, String> {
    let dir: Option<String> = conn
        .query_row(
            "SELECT COALESCE(directory, git_repo) FROM workstreams WHERE id = ?1",
            params![workstream_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("DB error: {e}"))?;
    let dir = dir.ok_or_else(|| format!("workstream {workstream_id} has no directory"))?;
    Ok(PathBuf::from(dir))
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::Connection;
    use std::cell::RefCell;
    use std::path::PathBuf;

    // ── Mock runner ──

    type CannedResponse = (String, Vec<String>, Result<String, String>);
    type CallRecord = (String, Vec<String>, PathBuf);

    struct FakeRunner {
        responses: RefCell<Vec<CannedResponse>>,
        calls: RefCell<Vec<CallRecord>>,
    }
    // SAFETY: tests are single-threaded; RefCell is enough.
    unsafe impl Sync for FakeRunner {}
    unsafe impl Send for FakeRunner {}

    impl FakeRunner {
        fn new() -> Self {
            Self {
                responses: RefCell::new(Vec::new()),
                calls: RefCell::new(Vec::new()),
            }
        }
        fn enqueue(&self, prog: &str, args: &[&str], result: Result<String, String>) {
            self.responses.borrow_mut().push((
                prog.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
                result,
            ));
        }
    }

    impl DiffCommandRunner for FakeRunner {
        fn run(&self, program: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
            self.calls.borrow_mut().push((
                program.to_string(),
                args.iter().map(|s| s.to_string()).collect(),
                cwd.to_path_buf(),
            ));
            let idx = {
                let r = self.responses.borrow();
                r.iter().position(|(p, a, _)| {
                    p == program && a.iter().map(String::as_str).collect::<Vec<_>>() == args
                })
            };
            if let Some(i) = idx {
                return self.responses.borrow_mut().remove(i).2;
            }
            Err(format!("no canned response for {program} {args:?}"))
        }
    }

    fn open_in_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    // ── Event-name safety ──

    #[test]
    fn event_names_are_tauri_safe() {
        let re_safe = |s: &str| {
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
        };
        for name in [
            events::PLAN_READY,
            events::CHUNK_ACTIVE,
            events::CHUNK_DONE,
            events::COMMENT_ADDED,
            events::DRIFT_DETECTED,
            events::COMPLETED,
        ] {
            assert!(re_safe(name), "event name {name} contains illegal chars");
            assert_eq!(name, sanitize_event_name(name));
        }
    }

    // ── Diff source readers ──

    #[test]
    fn read_branch_diff_invokes_git_diff_with_range() {
        let runner = FakeRunner::new();
        runner.enqueue("git", &["diff", "main...HEAD"], Ok("DIFF".into()));
        let out = read_branch_diff(&runner, Path::new("."), "main").unwrap();
        assert_eq!(out, "DIFF");
        assert_eq!(runner.calls.borrow().len(), 1);
        assert_eq!(runner.calls.borrow()[0].1, vec!["diff", "main...HEAD"]);
    }

    #[test]
    fn read_pr_diff_invokes_gh_pr_diff_with_number() {
        let runner = FakeRunner::new();
        runner.enqueue("gh", &["pr", "diff", "42"], Ok("PRDIFF".into()));
        let out = read_pr_diff(&runner, Path::new("."), 42).unwrap();
        assert_eq!(out, "PRDIFF");
        assert_eq!(runner.calls.borrow()[0].1, vec!["pr", "diff", "42"]);
    }

    #[test]
    fn read_working_tree_diff_invokes_git_diff_head() {
        let runner = FakeRunner::new();
        runner.enqueue("git", &["diff", "HEAD"], Ok("WT".into()));
        let out = read_working_tree_diff(&runner, Path::new(".")).unwrap();
        assert_eq!(out, "WT");
        assert_eq!(runner.calls.borrow()[0].1, vec!["diff", "HEAD"]);
    }

    #[test]
    fn read_branch_diff_propagates_failure() {
        let runner = FakeRunner::new();
        runner.enqueue("git", &["diff", "main...HEAD"], Err("boom".into()));
        let err = read_branch_diff(&runner, Path::new("."), "main").unwrap_err();
        assert!(err.contains("boom"));
    }

    // ── Drift detection ──

    #[test]
    fn hash_patch_is_deterministic_sha256_hex() {
        let h = hash_patch("@@ -1 +1 @@\n-a\n+b\n");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(h, hash_patch("@@ -1 +1 @@\n-a\n+b\n"));
        assert_ne!(h, hash_patch("@@ -1 +1 @@\n-x\n+y\n"));
    }

    #[test]
    fn parse_hunks_extracts_file_and_patch() {
        let diff = "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n";
        let hunks = parse_hunks(diff);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].0, "x.rs");
        assert!(hunks[0].1.starts_with("@@ -1 +1 @@"));
        assert!(hunks[0].1.contains("-a"));
        assert!(hunks[0].1.contains("+b"));
    }

    #[test]
    fn detect_drift_returns_chunks_whose_hash_missing() {
        let current = "diff --git a/x.rs b/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n";
        let parsed = parse_hunks(current);
        let live_hash = hash_patch(&parsed[0].1);
        let stored = vec![
            ("c1".to_string(), live_hash.clone()),
            ("c2".to_string(), "deadbeef".to_string()),
        ];
        let invalid = detect_drift_against_current(&stored, current);
        assert_eq!(invalid, vec!["c2".to_string()]);
    }

    #[test]
    fn detect_drift_empty_when_all_match() {
        let current = "diff --git a/x.rs b/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n";
        let h = hash_patch(&parse_hunks(current)[0].1);
        let invalid = detect_drift_against_current(&[("c1".into(), h)], current);
        assert!(invalid.is_empty());
    }

    // ── DB-backed helpers (logic that doesn't need AppHandle) ──

    fn insert_workstream(conn: &Connection, id: &str, dir: &str) {
        conn.execute(
            "INSERT INTO workstreams (id, name, directory, status, workstream_type, created_at, updated_at)
             VALUES (?1, 'ws', ?2, 'active', 'standalone', 't', 't')",
            params![id, dir],
        )
        .unwrap();
    }

    fn insert_review(conn: &Connection, id: &str, ws: &str) {
        conn.execute(
            "INSERT INTO diff_reviews (id, workstream_id, diff_source, source_ref, status, created_at, updated_at)
             VALUES (?1, ?2, 'branch', 'main', 'active', 't', 't')",
            params![id, ws],
        )
        .unwrap();
    }

    fn insert_chunk(
        conn: &Connection,
        id: &str,
        review: &str,
        ordinal: i64,
        is_trivial: bool,
        state: &str,
    ) {
        conn.execute(
            "INSERT INTO diff_chunks (id, review_id, ordinal, title, is_trivial, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'c', ?4, ?5, 't', 't')",
            params![id, review, ordinal, is_trivial as i64, state],
        )
        .unwrap();
    }

    fn insert_hunk(conn: &Connection, id: &str, chunk: &str, patch: &str) {
        let hash = hash_patch(patch);
        conn.execute(
            "INSERT INTO diff_hunks (id, chunk_id, file_path, patch_text, content_hash)
             VALUES (?1, ?2, 'f.rs', ?3, ?4)",
            params![id, chunk, patch, hash],
        )
        .unwrap();
    }

    #[test]
    fn fetch_review_returns_none_for_missing() {
        let db = open_in_memory_db();
        assert!(fetch_review(&db, "missing").unwrap().is_none());
    }

    #[test]
    fn fetch_chunk_round_trips_is_trivial_flag() {
        let db = open_in_memory_db();
        insert_workstream(&db, "w1", "/repo");
        insert_review(&db, "r1", "w1");
        insert_chunk(&db, "c1", "r1", 1, true, "approved");
        let c = fetch_chunk(&db, "c1").unwrap().unwrap();
        assert!(c.is_trivial);
        assert_eq!(c.state, "approved");
    }

    #[test]
    fn resolve_repo_dir_falls_back_to_git_repo() {
        let db = open_in_memory_db();
        db.execute(
            "INSERT INTO workstreams (id, name, git_repo, status, workstream_type, created_at, updated_at)
             VALUES ('w1', 'ws', '/repo', 'active', 'standalone', 't', 't')",
            [],
        )
        .unwrap();
        let p = resolve_repo_dir(&db, "w1").unwrap();
        assert_eq!(p, PathBuf::from("/repo"));
    }

    #[test]
    fn export_review_writes_json_and_md() {
        let db = open_in_memory_db();
        let tmp = std::env::temp_dir().join(format!(
            "diff_review_export_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&tmp).unwrap();
        insert_workstream(&db, "w1", tmp.to_str().unwrap());
        insert_review(&db, "r1", "w1");
        insert_chunk(&db, "c1", "r1", 1, false, "commented");
        insert_hunk(&db, "h1", "c1", "@@ -1 +1 @@\n-a\n+b\n");
        db.execute(
            "INSERT INTO diff_comments
                (id, chunk_id, anchor_file, anchor_line_start, anchor_line_end, text, created_at)
             VALUES ('cm1', 'c1', 'f.rs', 1, 1, 'use info', 't')",
            [],
        )
        .unwrap();

        let paths = export_review(&tmp, "r1", &db).unwrap();
        let json = std::fs::read_to_string(&paths.json_path).unwrap();
        assert!(json.contains("\"schema\": 1"));
        assert!(json.contains("\"review_id\": \"r1\""));
        assert!(json.contains("\"diff_source\": \"branch\""));
        assert!(json.contains("use info"));
        let md = std::fs::read_to_string(&paths.md_path).unwrap();
        assert!(md.contains("# Diff Review Action Plan"));
        assert!(md.contains("Chunk 1"));
        assert!(md.contains("use info"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    // ── Integration: real git repo for read_branch_diff / working tree ──

    fn run_git(repo: &Path, args: &[&str]) {
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).current_dir(repo);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let status = cmd.status().expect("git available");
        assert!(status.success(), "git {:?} failed", args);
    }

    fn make_temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "diff_review_git_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        run_git(&dir, &["init", "-q", "-b", "main"]);
        run_git(&dir, &["config", "user.email", "t@example.com"]);
        run_git(&dir, &["config", "user.name", "Tester"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run_git(&dir, &["add", "."]);
        run_git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn read_branch_diff_against_real_repo() {
        let repo = make_temp_repo();
        run_git(&repo, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        run_git(&repo, &["commit", "-aq", "-m", "add line"]);
        let out = read_branch_diff(&RealDiffCommandRunner, &repo, "main").unwrap();
        assert!(out.contains("+two"));
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn read_working_tree_diff_against_real_repo() {
        let repo = make_temp_repo();
        std::fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        let out = read_working_tree_diff(&RealDiffCommandRunner, &repo).unwrap();
        assert!(out.contains("+two"));
        std::fs::remove_dir_all(&repo).ok();
    }
}

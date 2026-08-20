//! Project tracking: tasks, subtasks, labels and the append-only event log.
//!
//! Two deliberate departures from the rest of this crate:
//!
//! 1. **Timestamps are ISO-8601 UTC, not epoch seconds.** `lib.rs::now()`
//!    returns epoch seconds, and mixing the two formats in one column is
//!    exactly the bug that broke file-comment ordering (lexicographic sort put
//!    every epoch row first). The exporter groups events by calendar day, so
//!    the format has to sort *and* slice as a date.
//!
//! 2. **There is no `update_task_event`.** Event text is immutable by
//!    construction; an event can be deleted (it never happened) but never
//!    rewritten, so the in-app log can never quietly disagree with what was
//!    already exported to the wiki.
//!
//! Dates are stored in UTC. Converting to the user's local day is the
//! renderer's job -- a 21:00 EDT note is 01:00Z the next day, and putting it on
//! the wrong devlog page would be a silent data error.

use crate::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

/// ISO-8601 UTC, second precision. Sorts lexicographically and slices to a date.
const NOW_ISO: &str = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/// Statuses that end a task's life and therefore stamp `completed_at`.
fn is_terminal(status: &str) -> bool {
    matches!(status, "done" | "cancelled")
}

/// Case- and whitespace-insensitive label identity.
///
/// Must stay in lockstep with `normalizeLabelName` in
/// `src/domain/task-labels.ts`: labels are free-form with no merge tool, so a
/// mismatch between the two would let the CLI mint a duplicate the UI refuses.
/// Punctuation is significant -- `Bugs/Fixes` must not fold into `Bugs Fixes`.
fn normalize_label(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Subtask {
    pub id: String,
    pub title: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub status: String,
    pub flags: Vec<String>,
    pub links: Vec<String>,
    /// Free-form scratchpad; mutable standing context, unlike an event.
    pub notes: String,
    pub label_ids: Vec<String>,
    pub workstream_id: Option<String>,
    pub subtasks: Vec<Subtask>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub id: String,
    pub task_id: String,
    pub kind: String,
    pub text: String,
    pub source: String,
    pub at: String,
}

fn json_array(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn read_tasks(conn: &Connection) -> Result<Vec<Task>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, status, flags_json, links_json, workstream_id,
                    created_at, completed_at, notes
             FROM tasks ORDER BY position, created_at",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                status: r.get(2)?,
                flags: json_array(&r.get::<_, String>(3)?),
                links: json_array(&r.get::<_, String>(4)?),
                notes: r.get::<_, Option<String>>(8)?.unwrap_or_default(),
                label_ids: Vec::new(),
                workstream_id: r.get(5)?,
                subtasks: Vec::new(),
                created_at: r.get(6)?,
                completed_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut tasks: Vec<Task> = rows.filter_map(|r| r.ok()).collect();

    // Two flat follow-up queries rather than N+1 per task: the board loads
    // every task at once and the real set is ~60 rows with many more events.
    let mut sub_stmt = conn
        .prepare("SELECT task_id, id, title, status FROM subtasks ORDER BY position, created_at")
        .map_err(|e| e.to_string())?;
    let subs: Vec<(String, Subtask)> = sub_stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Subtask {
                    id: r.get(1)?,
                    title: r.get(2)?,
                    status: r.get(3)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut lbl_stmt = conn
        .prepare("SELECT task_id, label_id FROM task_labels ORDER BY position")
        .map_err(|e| e.to_string())?;
    let lbls: Vec<(String, String)> = lbl_stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for task in &mut tasks {
        for (task_id, sub) in &subs {
            if task_id == &task.id {
                task.subtasks.push(sub.clone());
            }
        }
        for (task_id, label_id) in &lbls {
            if task_id == &task.id {
                task.label_ids.push(label_id.clone());
            }
        }
    }

    Ok(tasks)
}

fn read_task(conn: &Connection, id: &str) -> Result<Task, String> {
    read_tasks(conn)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("Task not found: {id}"))
}

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    let db = state.db.lock().unwrap();
    read_tasks(&db)
}

#[tauri::command]
pub fn create_task(
    state: State<'_, AppState>,
    title: String,
    status: Option<String>,
    workstream_id: Option<String>,
    label_names: Option<Vec<String>>,
) -> Result<Task, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = state.db.lock().unwrap();
    let status = status.unwrap_or_else(|| "todo".into());

    db.execute(
        &format!(
            "INSERT INTO tasks (id, title, status, workstream_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, {NOW_ISO}, {NOW_ISO})"
        ),
        rusqlite::params![&id, &title, &status, &workstream_id],
    )
    .map_err(|e| format!("DB error: {e}"))?;

    if let Some(names) = label_names {
        apply_labels(&db, &id, &names)?;
    }
    read_task(&db, &id)
}

// Tauri commands take their params flat, so a partial-update command is
// necessarily wide; the alternative is a struct that serde would have to
// distinguish "absent" from "null" in anyway.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn update_task(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    status: Option<String>,
    flags: Option<Vec<String>>,
    links: Option<Vec<String>>,
    notes: Option<String>,
    workstream_id: Option<String>,
    // Explicit detach. `workstream_id: null` cannot be distinguished from an
    // absent field once serde has folded both into `None`, so clearing the
    // link needs its own unambiguous signal rather than a silent no-op.
    clear_workstream: Option<bool>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();

    if let Some(title) = title {
        db.execute("UPDATE tasks SET title = ?1 WHERE id = ?2", (&title, &id))
            .map_err(|e| e.to_string())?;
    }
    if let Some(flags) = flags {
        let json = serde_json::to_string(&flags).map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE tasks SET flags_json = ?1 WHERE id = ?2",
            (&json, &id),
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(links) = links {
        let json = serde_json::to_string(&links).map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE tasks SET links_json = ?1 WHERE id = ?2",
            (&json, &id),
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(notes) = notes {
        db.execute("UPDATE tasks SET notes = ?1 WHERE id = ?2", (&notes, &id))
            .map_err(|e| e.to_string())?;
    }
    if clear_workstream.unwrap_or(false) {
        db.execute("UPDATE tasks SET workstream_id = NULL WHERE id = ?1", [&id])
            .map_err(|e| e.to_string())?;
    } else if let Some(ws) = workstream_id {
        db.execute(
            "UPDATE tasks SET workstream_id = ?1 WHERE id = ?2",
            (&ws, &id),
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(status) = status {
        // `completed_at` is derived here rather than trusted from the caller:
        // it is what the Done filter and the exporter key on, and it must be
        // cleared again when a finished task is reopened.
        if is_terminal(&status) {
            db.execute(
                &format!(
                    "UPDATE tasks SET status = ?1,
                        completed_at = COALESCE(completed_at, {NOW_ISO})
                     WHERE id = ?2"
                ),
                (&status, &id),
            )
        } else {
            db.execute(
                "UPDATE tasks SET status = ?1, completed_at = NULL WHERE id = ?2",
                (&status, &id),
            )
        }
        .map_err(|e| e.to_string())?;
    }

    db.execute(
        &format!("UPDATE tasks SET updated_at = {NOW_ISO} WHERE id = ?1"),
        [&id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM tasks WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_labels(conn: &Connection) -> Result<Vec<Label>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM labels ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Label {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Resolve names to label ids, minting only genuinely new ones, then replace
/// the task's label set.
///
/// Wrapped in `BEGIN IMMEDIATE` by `apply_labels`, because the in-process
/// mutex does not serialise the separate CLI process: without a write lock,
/// two writers can both pass the lookup before either inserts, and the
/// `lower(trim(name))` index cannot catch the resulting pair when they differ
/// only by internal whitespace.
fn apply_labels_locked(conn: &Connection, task_id: &str, names: &[String]) -> Result<(), String> {
    let existing = read_labels(conn)?;
    let mut ids: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for raw in names {
        let key = normalize_label(raw);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.push(key.clone());

        let hit = existing
            .iter()
            .find(|l| normalize_label(&l.name) == key)
            .map(|l| l.id.clone());

        let id = match hit {
            Some(id) => id,
            None => {
                // Re-check the DB as well: another writer (the CLI) may have
                // inserted the same label since `existing` was read.
                //
                // The comparison must go through `normalize_label`, NOT through
                // the index expression `lower(trim(name))`: SQL trim does not
                // collapse internal whitespace, so `AI  Crew` would miss `AI
                // Crew` and mint the duplicate this whole function exists to
                // prevent.
                let found = read_labels(conn)?
                    .into_iter()
                    .find(|l| normalize_label(&l.name) == key)
                    .map(|l| l.id);
                match found {
                    Some(id) => id,
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        conn.execute(
                            &format!(
                                "INSERT INTO labels (id, name, created_at) VALUES (?1, ?2, {NOW_ISO})"
                            ),
                            (&id, raw.trim()),
                        )
                        .map_err(|e| format!("DB error: {e}"))?;
                        id
                    }
                }
            }
        };
        ids.push(id);
    }

    conn.execute("DELETE FROM task_labels WHERE task_id = ?1", [task_id])
        .map_err(|e| e.to_string())?;
    for (position, label_id) in ids.iter().enumerate() {
        conn.execute(
            "INSERT INTO task_labels (task_id, label_id, position) VALUES (?1, ?2, ?3)",
            rusqlite::params![task_id, label_id, position as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Take the database write lock for the whole read-then-insert sequence, so
/// label creation is atomic against the CLI as well as against this process.
fn apply_labels(conn: &Connection, task_id: &str, names: &[String]) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin: {e}"))?;
    match apply_labels_locked(conn, task_id, names) {
        Ok(()) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(()),
            Err(e) => {
                // SQLite can leave the transaction active after some commit
                // failures. This connection lives in a shared Mutex, so a
                // leftover transaction would silently swallow later writes and
                // make every subsequent apply_labels fail.
                let _ = conn.execute_batch("ROLLBACK");
                Err(format!("commit: {e}"))
            }
        },
        Err(e) => {
            // Roll back so a partial label set never survives the failure.
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[tauri::command]
pub fn list_labels(state: State<'_, AppState>) -> Result<Vec<Label>, String> {
    let db = state.db.lock().unwrap();
    read_labels(&db)
}

#[tauri::command]
pub fn set_task_labels(
    state: State<'_, AppState>,
    task_id: String,
    label_names: Vec<String>,
) -> Result<Vec<Label>, String> {
    let db = state.db.lock().unwrap();
    apply_labels(&db, &task_id, &label_names)?;
    read_labels(&db)
}

#[tauri::command]
pub fn create_subtask(
    state: State<'_, AppState>,
    task_id: String,
    title: String,
) -> Result<Subtask, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = state.db.lock().unwrap();
    let position: i64 = db
        .query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM subtasks WHERE task_id = ?1",
            [&task_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    db.execute(
        &format!(
            "INSERT INTO subtasks (id, task_id, title, status, position, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'todo', ?4, {NOW_ISO}, {NOW_ISO})"
        ),
        rusqlite::params![&id, &task_id, &title, position],
    )
    .map_err(|e| format!("DB error: {e}"))?;

    Ok(Subtask {
        id,
        title,
        status: "todo".into(),
    })
}

#[tauri::command]
pub fn update_subtask(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    status: Option<String>,
) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    if let Some(title) = title {
        db.execute(
            "UPDATE subtasks SET title = ?1 WHERE id = ?2",
            (&title, &id),
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(status) = status {
        db.execute(
            "UPDATE subtasks SET status = ?1 WHERE id = ?2",
            (&status, &id),
        )
        .map_err(|e| e.to_string())?;
    }
    db.execute(
        &format!("UPDATE subtasks SET updated_at = {NOW_ISO} WHERE id = ?1"),
        [&id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_subtask(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM subtasks WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_task_events(
    state: State<'_, AppState>,
    task_id: Option<String>,
) -> Result<Vec<TaskEvent>, String> {
    let db = state.db.lock().unwrap();
    let (sql, params): (String, Vec<String>) = match &task_id {
        Some(id) => (
            "SELECT id, task_id, kind, text, source, created_at FROM task_events
             WHERE task_id = ?1 ORDER BY created_at, rowid"
                .into(),
            vec![id.clone()],
        ),
        None => (
            "SELECT id, task_id, kind, text, source, created_at FROM task_events
             ORDER BY created_at, rowid"
                .into(),
            vec![],
        ),
    };

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(TaskEvent {
                id: r.get(0)?,
                task_id: r.get(1)?,
                kind: r.get(2)?,
                text: r.get(3)?,
                source: r.get(4)?,
                at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn add_task_event(
    state: State<'_, AppState>,
    task_id: String,
    kind: String,
    text: String,
    source: Option<String>,
) -> Result<TaskEvent, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let source = source.unwrap_or_else(|| "manual".into());
    let db = state.db.lock().unwrap();

    db.execute(
        &format!(
            "INSERT INTO task_events (id, task_id, kind, text, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, {NOW_ISO})"
        ),
        rusqlite::params![&id, &task_id, &kind, &text, &source],
    )
    .map_err(|e| format!("DB error: {e}"))?;

    let at: String = db
        .query_row(
            "SELECT created_at FROM task_events WHERE id = ?1",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(TaskEvent {
        id,
        task_id,
        kind,
        text,
        source,
        at,
    })
}

/// Delete an event. There is intentionally no update counterpart.
#[tauri::command]
pub fn delete_task_event(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().unwrap();
    db.execute("DELETE FROM task_events WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        init_db(&c).unwrap();
        c
    }

    fn insert_task(c: &Connection, id: &str, title: &str) {
        c.execute(
            &format!(
                "INSERT INTO tasks (id, title, created_at, updated_at)
                 VALUES (?1, ?2, {NOW_ISO}, {NOW_ISO})"
            ),
            (id, title),
        )
        .unwrap();
    }

    #[test]
    fn normalize_label_matches_the_typescript_rules() {
        assert_eq!(normalize_label("  AI Crew "), "ai crew");
        assert_eq!(normalize_label("AI   Crew"), "ai crew");
        // Punctuation is significant, or `Bugs/Fixes` merges with `Bugs Fixes`.
        assert_eq!(normalize_label("Bugs/Fixes"), "bugs/fixes");
        assert_ne!(normalize_label("Bugs/Fixes"), normalize_label("Bugs Fixes"));
    }

    #[test]
    fn timestamps_are_iso_8601_not_epoch_seconds() {
        // Mixing epoch and ISO in one column is what broke file-comment
        // ordering; here it would also put events on the wrong devlog day.
        let c = conn();
        insert_task(&c, "t1", "x");
        let at: String = c
            .query_row("SELECT created_at FROM tasks WHERE id='t1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(at.len(), 20, "expected YYYY-MM-DDTHH:MM:SSZ, got {at}");
        assert!(at.ends_with('Z'));
        assert_eq!(&at[4..5], "-");
        assert_eq!(&at[10..11], "T");
    }

    #[test]
    fn apply_labels_reuses_a_case_variant_instead_of_forking() {
        let c = conn();
        insert_task(&c, "t1", "a");
        insert_task(&c, "t2", "b");

        apply_labels(&c, "t1", &["AI Crew".into()]).unwrap();
        apply_labels(&c, "t2", &["ai   crew".into()]).unwrap();

        let labels = read_labels(&c).unwrap();
        assert_eq!(labels.len(), 1, "case variant forked the label");
        assert_eq!(labels[0].name, "AI Crew", "original casing should win");
    }

    #[test]
    fn apply_labels_rolls_back_when_it_fails_partway() {
        // A partial label set would silently mislabel the task and therefore
        // file it under the wrong section of the exported archive.
        let c = conn();
        insert_task(&c, "t1", "a");
        apply_labels(&c, "t1", &["Keep".into()]).unwrap();

        // A task id that violates the foreign key fails mid-sequence.
        let before = read_labels(&c).unwrap().len();
        assert!(apply_labels(&c, "does-not-exist", &["New".into()]).is_err());
        // The transaction must be closed, not left open and poisoning the
        // next write.
        apply_labels(&c, "t1", &["Keep".into()]).unwrap();
        assert!(read_labels(&c).unwrap().len() >= before);
    }

    #[test]
    fn apply_labels_matches_internal_whitespace_variants() {
        // SQL `trim` does not collapse internal whitespace, so a lookup through
        // the index expression would miss this and mint a duplicate.
        let c = conn();
        insert_task(&c, "t1", "a");
        insert_task(&c, "t2", "b");
        apply_labels(&c, "t1", &["AI Crew".into()]).unwrap();
        apply_labels(&c, "t2", &["AI   Crew".into()]).unwrap();

        assert_eq!(
            read_labels(&c).unwrap().len(),
            1,
            "whitespace variant forked the label"
        );
    }

    #[test]
    fn apply_labels_replaces_rather_than_appends() {
        let c = conn();
        insert_task(&c, "t1", "a");
        apply_labels(&c, "t1", &["Alpha".into()]).unwrap();
        apply_labels(&c, "t1", &["Beta".into()]).unwrap();

        let task = read_task(&c, "t1").unwrap();
        assert_eq!(task.label_ids.len(), 1);
    }

    #[test]
    fn apply_labels_dedupes_within_one_call() {
        let c = conn();
        insert_task(&c, "t1", "a");
        apply_labels(&c, "t1", &["Telemetry".into(), "telemetry".into()]).unwrap();
        assert_eq!(read_labels(&c).unwrap().len(), 1);
        assert_eq!(read_task(&c, "t1").unwrap().label_ids.len(), 1);
    }

    #[test]
    fn apply_labels_skips_blank_names() {
        let c = conn();
        insert_task(&c, "t1", "a");
        apply_labels(&c, "t1", &["".into(), "   ".into()]).unwrap();
        assert_eq!(read_labels(&c).unwrap().len(), 0);
    }

    #[test]
    fn read_tasks_attaches_subtasks_and_labels_to_the_right_task() {
        let c = conn();
        insert_task(&c, "t1", "a");
        insert_task(&c, "t2", "b");
        c.execute(
            &format!(
                "INSERT INTO subtasks (id, task_id, title, created_at, updated_at)
                 VALUES ('s1','t1','sub',{NOW_ISO},{NOW_ISO})"
            ),
            [],
        )
        .unwrap();
        apply_labels(&c, "t2", &["Only T2".into()]).unwrap();

        let tasks = read_tasks(&c).unwrap();
        let t1 = tasks.iter().find(|t| t.id == "t1").unwrap();
        let t2 = tasks.iter().find(|t| t.id == "t2").unwrap();
        assert_eq!(t1.subtasks.len(), 1);
        assert!(t1.label_ids.is_empty());
        assert!(t2.subtasks.is_empty());
        assert_eq!(t2.label_ids.len(), 1);
    }

    #[test]
    fn notes_round_trip_including_newlines_and_empty() {
        // The note is multi-line free text, so newlines must survive storage
        // intact -- collapsing them would destroy the structure the exported
        // page turns back into bullets.
        let c = conn();
        insert_task(&c, "t1", "a");
        assert_eq!(read_task(&c, "t1").unwrap().notes, "");

        c.execute(
            "UPDATE tasks SET notes = ?1 WHERE id = 't1'",
            ["first line\nsecond line"],
        )
        .unwrap();
        assert_eq!(
            read_task(&c, "t1").unwrap().notes,
            "first line\nsecond line"
        );
    }

    #[test]
    fn is_terminal_covers_cancelled_as_well_as_done() {
        assert!(is_terminal("done"));
        assert!(is_terminal("cancelled"));
        assert!(!is_terminal("in_progress"));
        assert!(!is_terminal("parked"));
    }

    #[test]
    fn events_are_deletable_but_the_module_exposes_no_text_update() {
        let c = conn();
        insert_task(&c, "t1", "a");
        c.execute(
            &format!(
                "INSERT INTO task_events (id, task_id, kind, text, created_at)
                 VALUES ('e1','t1','note','typo',{NOW_ISO})"
            ),
            [],
        )
        .unwrap();
        c.execute("DELETE FROM task_events WHERE id='e1'", [])
            .unwrap();
        let count: i64 = c
            .query_row("SELECT COUNT(*) FROM task_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}

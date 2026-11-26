//! The run log of a periodic session tile (ADR 046).
//!
//! One row per run — scheduled, Run now, a reply from the tile or the phone —
//! and per skipped slot, with its result, times, exit code, prompt, final
//! answer, needs-input question, tool calls and the path of its JSONL events
//! file. The newest `MAX_RUNS_PER_TILE` per tile are kept; the rest, and their
//! events files, are dropped. Runs go with their tile (`ON DELETE CASCADE`).

use crate::periodic_runner::{RunOutcome, ToolCall};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

pub const MAX_RUNS_PER_TILE: i64 = 50;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Run {
    pub id: String,
    pub schedule_id: String,
    pub tile_id: String,
    /// scheduled, manual (Run now), reply (the tile's reply box) or phone.
    pub kind: String,
    /// running, ok, failed, timed_out, needs_input, skipped or interrupted.
    pub status: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    /// What the user (or the schedule) asked, without the app's instruction.
    pub prompt: String,
    pub answer: Option<String>,
    pub question: Option<String>,
    pub error: Option<String>,
    pub tools: Vec<ToolCall>,
    pub events_path: Option<String>,
}

pub struct NewRun<'a> {
    pub id: &'a str,
    pub schedule_id: &'a str,
    pub tile_id: &'a str,
    pub kind: &'a str,
    pub prompt: &'a str,
    pub started_at: i64,
    pub events_path: Option<&'a str>,
}

const COLUMNS: &str = "id, schedule_id, tile_id, kind, status, started_at, ended_at, exit_code,
    prompt, answer, question, error, tools_json, events_path";

fn from_row(row: &Row) -> rusqlite::Result<Run> {
    let tools: String = row.get(12)?;
    Ok(Run {
        id: row.get(0)?,
        schedule_id: row.get(1)?,
        tile_id: row.get(2)?,
        kind: row.get(3)?,
        status: row.get(4)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        exit_code: row.get(7)?,
        prompt: row.get(8)?,
        answer: row.get(9)?,
        question: row.get(10)?,
        error: row.get(11)?,
        tools: serde_json::from_str(&tools).unwrap_or_default(),
        events_path: row.get(13)?,
    })
}

fn check_kind(kind: &str) -> Result<(), String> {
    if matches!(kind, "scheduled" | "manual" | "reply" | "phone") {
        Ok(())
    } else {
        Err(format!("Unknown run kind: {kind}"))
    }
}

/// Drops the tile's runs beyond the newest 50, with their events files.
fn prune(conn: &Connection, tile_id: &str) -> Result<(), String> {
    let old: Vec<(String, Option<String>)> = conn
        .prepare(
            "SELECT id, events_path FROM periodic_runs WHERE tile_id = ?1
             ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?2",
        )
        .and_then(|mut statement| {
            statement
                .query_map(params![tile_id, MAX_RUNS_PER_TILE], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect()
        })
        .map_err(|e| e.to_string())?;
    for (id, path) in old {
        conn.execute("DELETE FROM periodic_runs WHERE id = ?1", [&id])
            .map_err(|e| e.to_string())?;
        if let Some(path) = path {
            std::fs::remove_file(path).ok();
        }
    }
    Ok(())
}

fn insert(
    conn: &Connection,
    run: &NewRun,
    status: &str,
    ended_at: Option<i64>,
) -> Result<Run, String> {
    check_kind(run.kind)?;
    conn.execute(
        "INSERT INTO periodic_runs (id, schedule_id, tile_id, kind, status, started_at, ended_at, prompt, events_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            run.id,
            run.schedule_id,
            run.tile_id,
            run.kind,
            status,
            run.started_at,
            ended_at,
            run.prompt,
            run.events_path
        ],
    )
    .map_err(|e| e.to_string())?;
    prune(conn, run.tile_id)?;
    get(conn, run.id)?.ok_or_else(|| "The run was not stored.".into())
}

/// A run that is starting now.
pub fn insert_running(conn: &Connection, run: &NewRun) -> Result<Run, String> {
    insert(conn, run, "running", None)
}

/// A slot (or a Run now, or a reply) skipped because a run was going: recorded, nothing started.
pub fn insert_skipped(conn: &Connection, run: &NewRun) -> Result<Run, String> {
    insert(conn, run, "skipped", Some(run.started_at))
}

/// Stores how a run ended.
pub fn finish(
    conn: &Connection,
    id: &str,
    outcome: &RunOutcome,
    ended_at: i64,
) -> Result<Run, String> {
    let tools = serde_json::to_string(&outcome.tools).map_err(|e| e.to_string())?;
    let changed = conn
        .execute(
            "UPDATE periodic_runs SET status = ?2, ended_at = ?3, exit_code = ?4, answer = ?5,
               question = ?6, error = ?7, tools_json = ?8
             WHERE id = ?1 AND status = 'running'",
            params![
                id,
                outcome.status,
                ended_at,
                outcome.exit_code,
                outcome.answer,
                outcome.question,
                outcome.error,
                tools
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("No running run {id}"));
    }
    get(conn, id)?.ok_or_else(|| format!("No run {id}"))
}

/// Runs a previous app instance left running: nothing watches them any more.
pub fn interrupt_stale(conn: &Connection, now: i64) -> Result<usize, String> {
    conn.execute(
        "UPDATE periodic_runs SET status = 'interrupted', ended_at = ?1,
           error = 'The app closed while this run was going.'
         WHERE status = 'running'",
        [now],
    )
    .map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Run>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM periodic_runs WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// A tile's runs, newest first.
pub fn list_for_tile(conn: &Connection, tile_id: &str) -> Result<Vec<Run>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM periodic_runs WHERE tile_id = ?1 ORDER BY started_at DESC, rowid DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([tile_id], from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'W', 'x', 'x');
             INSERT INTO tiles (id, workstream_id, tile_type, config_json, created_at, updated_at) VALUES
               ('p1', 'w1', 'periodic_session', '{}', 'x', 'x'),
               ('p2', 'w1', 'periodic_session', '{}', 'x', 'x');",
        )
        .unwrap();
        conn
    }

    fn new<'a>(id: &'a str, tile: &'a str, at: i64, path: Option<&'a str>) -> NewRun<'a> {
        NewRun {
            id,
            schedule_id: "s1",
            tile_id: tile,
            kind: "scheduled",
            prompt: "Check CI",
            started_at: at,
            events_path: path,
        }
    }

    fn outcome(status: &str) -> RunOutcome {
        RunOutcome {
            status: status.into(),
            exit_code: Some(0),
            answer: Some("NEEDS INPUT: Which?".into()),
            question: Some("Which?".into()),
            error: None,
            tools: vec![ToolCall {
                id: "c1".into(),
                name: "bash".into(),
                status: "ok".into(),
            }],
            session_started: true,
        }
    }

    #[test]
    fn a_run_is_stored_running_then_finished() {
        let conn = db();
        let run = insert_running(&conn, &new("r1", "p1", 10, Some("/e/r1.jsonl"))).unwrap();
        assert_eq!(
            (run.status.as_str(), run.ended_at, run.kind.as_str()),
            ("running", None, "scheduled")
        );
        let done = finish(&conn, "r1", &outcome("needs_input"), 20).unwrap();
        assert_eq!(
            (
                done.status.as_str(),
                done.ended_at,
                done.exit_code,
                done.question.as_deref()
            ),
            ("needs_input", Some(20), Some(0), Some("Which?"))
        );
        assert_eq!(done.tools[0].name, "bash");
        assert_eq!(done.events_path.as_deref(), Some("/e/r1.jsonl"));
        // Finished once only.
        assert!(finish(&conn, "r1", &outcome("ok"), 30).is_err());
        let mut bad = new("r2", "p1", 11, None);
        bad.kind = "other";
        assert!(insert_running(&conn, &bad).unwrap_err().contains("kind"));
    }

    #[test]
    fn a_skip_is_recorded_without_a_process() {
        let conn = db();
        let skip = insert_skipped(&conn, &new("k1", "p1", 10, None)).unwrap();
        assert_eq!((skip.status.as_str(), skip.ended_at), ("skipped", Some(10)));
    }

    #[test]
    fn keeps_the_newest_fifty_runs_per_tile_with_their_files() {
        let conn = db();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/tmp")
            .join(format!("ws-runs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..55 {
            let path = dir.join(format!("r{i}.jsonl"));
            std::fs::write(&path, "{}").unwrap();
            let path = path.to_string_lossy().to_string();
            insert_running(&conn, &new(&format!("r{i}"), "p1", i, Some(&path))).unwrap();
        }
        insert_running(&conn, &new("other", "p2", 0, None)).unwrap();
        let runs = list_for_tile(&conn, "p1").unwrap();
        assert_eq!(runs.len(), 50);
        assert_eq!((runs[0].id.as_str(), runs[49].id.as_str()), ("r54", "r5"));
        assert!(!dir.join("r4.jsonl").exists());
        assert!(dir.join("r5.jsonl").exists());
        assert_eq!(list_for_tile(&conn, "p2").unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn runs_left_running_are_interrupted_and_runs_go_with_their_tile() {
        let conn = db();
        insert_running(&conn, &new("r1", "p1", 10, None)).unwrap();
        insert_skipped(&conn, &new("k1", "p1", 11, None)).unwrap();
        assert_eq!(interrupt_stale(&conn, 99).unwrap(), 1);
        let run = get(&conn, "r1").unwrap().unwrap();
        assert_eq!(
            (run.status.as_str(), run.ended_at),
            ("interrupted", Some(99))
        );
        conn.execute("DELETE FROM tiles WHERE id = 'p1'", [])
            .unwrap();
        assert!(list_for_tile(&conn, "p1").unwrap().is_empty());
    }

    #[test]
    fn runs_survive_a_restart() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/tmp")
            .join(format!("ws-runs-db-{}", uuid::Uuid::new_v4()));
        let path = dir.join("ws.db");
        {
            let conn = crate::db::open_db(&path).unwrap();
            conn.execute_batch(
                "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'W', 'x', 'x');
                 INSERT INTO tiles (id, workstream_id, tile_type, config_json, created_at, updated_at)
                   VALUES ('p1', 'w1', 'periodic_session', '{}', 'x', 'x');",
            )
            .unwrap();
            insert_running(&conn, &new("r1", "p1", 10, None)).unwrap();
            finish(&conn, "r1", &outcome("ok"), 20).unwrap();
        }
        let conn = crate::db::open_db(&path).unwrap();
        assert_eq!(list_for_tile(&conn, "p1").unwrap()[0].status, "ok");
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}

//! Periodic Copilot sessions (ADR 044): the stored schedules.
//!
//! The rules (next runs, skips, failure counting) live in the frontend's pure
//! model, `src/domain/periodic-schedules.ts`; this module stores schedules,
//! validates what an agent or the UI writes, and follows the lifecycle of
//! tiles and workstreams. A schedule goes with its tile (`ON DELETE CASCADE`).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

pub const MIN_INTERVAL_MINUTES: i64 = 5;
pub const MAX_PROMPT: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Schedule {
    pub id: String,
    pub tile_id: String,
    pub workstream_id: String,
    pub prompt: String,
    pub frequency: Value,
    pub notify_inbox: bool,
    pub notify_phone: bool,
    pub paused: bool,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub last_result: Option<String>,
    pub last_error: Option<String>,
    pub failures: i64,
    pub run_requested: bool,
    /// When "Run now" was asked for (ms epoch); an old request expires.
    pub run_requested_at: Option<i64>,
    pub created_at: i64,
    /// Bumped on every change, so the runner can claim a run against the row it read.
    pub revision: i64,
}

/// What creating a schedule needs; the rest starts empty.
pub struct NewSchedule<'a> {
    pub tile_id: &'a str,
    pub workstream_id: &'a str,
    pub prompt: &'a str,
    pub frequency: &'a Value,
    pub notify_inbox: bool,
    pub notify_phone: bool,
    /// `None`: the app plans the first run (at its first scheduled time).
    pub next_run_at: Option<i64>,
    pub created_at: i64,
}

fn is_time(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let (Ok(h), Ok(m)) = (text[..2].parse::<u32>(), text[3..].parse::<u32>()) else {
        return false;
    };
    text[..2].chars().all(|c| c.is_ascii_digit())
        && text[3..].chars().all(|c| c.is_ascii_digit())
        && h < 24
        && m < 60
}

/// Why a frequency is refused, with the same wording as the frontend.
pub fn validate_frequency(frequency: &Value) -> Result<(), String> {
    let time_ok = || {
        frequency
            .get("time")
            .and_then(Value::as_str)
            .is_some_and(is_time)
    };
    match frequency.get("kind").and_then(Value::as_str) {
        Some("interval") => {
            let minutes = frequency
                .get("minutes")
                .and_then(Value::as_f64)
                .ok_or("The interval must be a whole number of minutes.")?;
            if minutes < MIN_INTERVAL_MINUTES as f64 {
                return Err(format!(
                    "A schedule can't run more often than every {MIN_INTERVAL_MINUTES} minutes."
                ));
            }
            if minutes.fract() != 0.0 {
                return Err("The interval must be a whole number of minutes.".into());
            }
            Ok(())
        }
        Some("daily") if time_ok() => Ok(()),
        Some("daily") => Err("The time must be HH:MM (24-hour).".into()),
        Some("weekly") => {
            let day = frequency.get("day").and_then(Value::as_i64);
            if !matches!(day, Some(0..=6)) {
                return Err("The day must be 0 (Sunday) to 6 (Saturday).".into());
            }
            if time_ok() {
                Ok(())
            } else {
                Err("The time must be HH:MM (24-hour).".into())
            }
        }
        other => Err(format!("Unknown frequency: {}", other.unwrap_or("(none)"))),
    }
}

const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// Reads the agent command's frequency: `hourly`, `every:2h`, `every:30m`,
/// `daily:09:00` or `weekly:mon:09:00`, then validates it.
pub fn parse_frequency(text: &str) -> Result<Value, String> {
    const SHAPE: &str =
        "Use hourly, every:<N>h, every:<N>m, daily:HH:MM or weekly:<day>:HH:MM (day = sun..sat).";
    let text = text.trim().to_ascii_lowercase();
    let value = if text == "hourly" {
        serde_json::json!({ "kind": "interval", "minutes": 60 })
    } else if let Some(rest) = text.strip_prefix("every:") {
        let (number, scale) = if let Some(n) = rest.strip_suffix('h') {
            (n, 60)
        } else if let Some(n) = rest.strip_suffix('m') {
            (n, 1)
        } else {
            return Err(format!("Unknown frequency: {text}. {SHAPE}"));
        };
        let n: i64 = number
            .parse()
            .map_err(|_| format!("Unknown frequency: {text}. {SHAPE}"))?;
        serde_json::json!({ "kind": "interval", "minutes": n * scale })
    } else if let Some(time) = text.strip_prefix("daily:") {
        serde_json::json!({ "kind": "daily", "time": time })
    } else if let Some(rest) = text.strip_prefix("weekly:") {
        let (day, time) = rest
            .split_once(':')
            .ok_or_else(|| format!("Unknown frequency: {text}. {SHAPE}"))?;
        let day = DAYS
            .iter()
            .position(|d| day.starts_with(d))
            .ok_or_else(|| format!("Unknown day: {day}. {SHAPE}"))?;
        serde_json::json!({ "kind": "weekly", "day": day, "time": time })
    } else {
        return Err(format!("Unknown frequency: {text}. {SHAPE}"));
    };
    validate_frequency(&value)?;
    Ok(value)
}

fn check_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("The prompt is empty.".into());
    }
    if prompt.chars().count() > MAX_PROMPT {
        return Err(format!(
            "The prompt is longer than {MAX_PROMPT} characters."
        ));
    }
    Ok(())
}

const COLUMNS: &str =
    "id, tile_id, workstream_id, prompt, frequency, notify_inbox, notify_phone, paused,
    next_run_at, last_run_at, last_result, last_error, failures, run_requested, created_at,
    run_requested_at, revision";

fn from_row(row: &Row) -> rusqlite::Result<Schedule> {
    let frequency: String = row.get(4)?;
    Ok(Schedule {
        id: row.get(0)?,
        tile_id: row.get(1)?,
        workstream_id: row.get(2)?,
        prompt: row.get(3)?,
        frequency: serde_json::from_str(&frequency).unwrap_or(Value::Null),
        notify_inbox: row.get(5)?,
        notify_phone: row.get(6)?,
        paused: row.get(7)?,
        next_run_at: row.get(8)?,
        last_run_at: row.get(9)?,
        last_result: row.get(10)?,
        last_error: row.get(11)?,
        failures: row.get(12)?,
        run_requested: row.get(13)?,
        created_at: row.get(14)?,
        run_requested_at: row.get(15)?,
        revision: row.get(16)?,
    })
}

/// Stores a schedule for a Copilot session tile; one per tile.
pub fn create(conn: &Connection, new: &NewSchedule) -> Result<Schedule, String> {
    check_prompt(new.prompt)?;
    validate_frequency(new.frequency)?;
    let tile: Option<(String, String)> = conn
        .query_row(
            "SELECT workstream_id, tile_type FROM tiles WHERE id = ?1",
            [new.tile_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match tile {
        None => return Err(format!("No tile {}", new.tile_id)),
        Some((_, kind)) if kind != "copilot_session" => {
            return Err("Only a Copilot session tile can run periodically.".into())
        }
        Some((ws, _)) if ws != new.workstream_id => {
            return Err(format!(
                "Tile {} is not in workstream {}",
                new.tile_id, new.workstream_id
            ))
        }
        _ => {}
    }
    if for_tile(conn, new.tile_id)?.is_some() {
        return Err("This tile already has a schedule; edit it instead.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO periodic_schedules (id, tile_id, workstream_id, prompt, frequency, notify_inbox,
           notify_phone, next_run_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            new.tile_id,
            new.workstream_id,
            new.prompt,
            new.frequency.to_string(),
            new.notify_inbox,
            new.notify_phone,
            new.next_run_at,
            new.created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    get(conn, &id)?.ok_or_else(|| "The schedule was not stored.".into())
}

/// Every schedule, oldest first.
pub fn list(conn: &Connection) -> Result<Vec<Schedule>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {COLUMNS} FROM periodic_schedules ORDER BY created_at, rowid"
        ))
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Schedule>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM periodic_schedules WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn for_tile(conn: &Connection, tile_id: &str) -> Result<Option<Schedule>, String> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM periodic_schedules WHERE tile_id = ?1"),
        [tile_id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Applies the named fields of `patch` (a JSON object); unknown keys are refused.
pub fn update(conn: &Connection, id: &str, patch: &Value) -> Result<Schedule, String> {
    update_if(conn, id, patch, None)
}

/// As `update`, but only while the stored revision is still `expected`: a
/// run is claimed against the row the runner decided on, so a pause, edit or
/// archive in between wins.
pub fn update_if(
    conn: &Connection,
    id: &str,
    patch: &Value,
    expected: Option<i64>,
) -> Result<Schedule, String> {
    let fields = patch
        .as_object()
        .ok_or("The change must be a JSON object.")?;
    if get(conn, id)?.is_none() {
        return Err(format!("No schedule {id}"));
    }
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    use rusqlite::types::Value as Sql;
    for (key, value) in fields {
        let sql = match key.as_str() {
            "prompt" => {
                let text = value.as_str().ok_or("prompt must be text")?;
                check_prompt(text)?;
                Sql::Text(text.to_string())
            }
            "frequency" => {
                validate_frequency(value)?;
                Sql::Text(value.to_string())
            }
            "notify_inbox" | "notify_phone" | "paused" | "run_requested" => Sql::Integer(
                value
                    .as_bool()
                    .ok_or(format!("{key} must be true or false"))? as i64,
            ),
            "failures" => Sql::Integer(value.as_i64().ok_or("failures must be a number")?),
            "next_run_at" | "last_run_at" | "run_requested_at" => match value {
                Value::Null => Sql::Null,
                _ => Sql::Integer(value.as_i64().ok_or(format!("{key} must be a time"))?),
            },
            "last_result" | "last_error" => match value {
                Value::Null => Sql::Null,
                _ => Sql::Text(
                    value
                        .as_str()
                        .ok_or(format!("{key} must be text"))?
                        .to_string(),
                ),
            },
            other => return Err(format!("Unknown schedule field: {other}")),
        };
        sets.push(format!("{key} = ?{}", values.len() + 1));
        values.push(sql);
    }
    sets.push("revision = revision + 1".to_string());
    values.push(Sql::Text(id.to_string()));
    let mut sql = format!(
        "UPDATE periodic_schedules SET {} WHERE id = ?{}",
        sets.join(", "),
        values.len()
    );
    if let Some(expected) = expected {
        values.push(Sql::Integer(expected));
        sql.push_str(&format!(" AND revision = ?{}", values.len()));
    }
    let changed = conn
        .execute(&sql, rusqlite::params_from_iter(values))
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("The schedule changed since it was read.".into());
    }
    get(conn, id)?.ok_or_else(|| format!("No schedule {id}"))
}

/// The Inbox entry a schedule pausing itself posts (ADR 044).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Alert {
    pub title: String,
    pub body: String,
}

/// As `update_if`, storing `alert` as the schedule tile's Inbox entry in the
/// same transaction: an auto-pause and its entry are kept together or not at all.
pub fn update_with_alert(
    conn: &Connection,
    id: &str,
    patch: &Value,
    expected: Option<i64>,
    alert: Option<&Alert>,
) -> Result<Schedule, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let updated = update_if(&tx, id, patch, expected)?;
    if let Some(alert) = alert {
        crate::inbox_messages::post_from_app(
            &tx,
            &updated.workstream_id,
            &updated.tile_id,
            "error",
            &alert.title,
            &alert.body,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(updated)
}

/// Removes a schedule; the tile stays. False when there was none.
pub fn delete(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.execute("DELETE FROM periodic_schedules WHERE id = ?1", [id])
        .map(|n| n > 0)
        .map_err(|e| e.to_string())
}

/// Archiving a workstream pauses its schedules; unarchiving leaves them paused.
pub fn pause_workstream(conn: &Connection, workstream_id: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE periodic_schedules SET paused = 1, revision = revision + 1 WHERE workstream_id = ?1",
        [workstream_id],
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'Courses', 'x', 'x'), ('w2', 'Infra', 'x', 'x');
             INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at) VALUES
               ('t1', 'w1', 'copilot_session', 'Videos', '{\"copilot_session_id\":\"s1\"}', 'x', 'x'),
               ('t2', 'w2', 'copilot_session', 'CI', '{}', 'x', 'x'),
               ('term', 'w1', 'terminal', 'Shell', '{}', 'x', 'x');",
        )
        .unwrap();
        conn
    }

    fn new<'a>(tile: &'a str, ws: &'a str, frequency: &'a Value) -> NewSchedule<'a> {
        NewSchedule {
            tile_id: tile,
            workstream_id: ws,
            prompt: "Check for new videos",
            frequency,
            notify_inbox: false,
            notify_phone: false,
            next_run_at: None,
            created_at: 1,
        }
    }

    #[test]
    fn parses_every_preset_and_refuses_under_five_minutes() {
        assert_eq!(
            parse_frequency("hourly").unwrap(),
            json!({"kind":"interval","minutes":60})
        );
        assert_eq!(
            parse_frequency("every:2h").unwrap(),
            json!({"kind":"interval","minutes":120})
        );
        assert_eq!(
            parse_frequency("every:30m").unwrap(),
            json!({"kind":"interval","minutes":30})
        );
        assert_eq!(
            parse_frequency("daily:09:00").unwrap(),
            json!({"kind":"daily","time":"09:00"})
        );
        assert_eq!(
            parse_frequency("Weekly:Mon:09:00").unwrap(),
            json!({"kind":"weekly","day":1,"time":"09:00"})
        );
        let err = parse_frequency("every:1m").unwrap_err();
        assert!(err.contains("5 minutes"), "{err}");
        assert!(parse_frequency("daily:9am").unwrap_err().contains("HH:MM"));
        assert!(parse_frequency("weekly:xyz:09:00")
            .unwrap_err()
            .contains("Unknown day"));
        assert!(parse_frequency("monthly")
            .unwrap_err()
            .contains("Unknown frequency"));
        assert!(parse_frequency("every:5x").is_err());
        assert!(parse_frequency("every:xh").is_err());
        assert!(parse_frequency("weekly:mon").is_err());
    }

    #[test]
    fn validates_frequency_objects_like_the_frontend() {
        assert!(validate_frequency(&json!({"kind":"interval","minutes":5})).is_ok());
        assert!(
            validate_frequency(&json!({"kind":"interval","minutes":4.5}))
                .unwrap_err()
                .contains("5 minutes")
        );
        assert!(
            validate_frequency(&json!({"kind":"interval","minutes":7.5}))
                .unwrap_err()
                .contains("whole number")
        );
        assert!(validate_frequency(&json!({"kind":"interval"})).is_err());
        assert!(validate_frequency(&json!({"kind":"daily","time":"24:00"})).is_err());
        assert!(validate_frequency(&json!({"kind":"daily","time":"2:00"})).is_err());
        assert!(
            validate_frequency(&json!({"kind":"weekly","day":7,"time":"09:00"}))
                .unwrap_err()
                .contains("day")
        );
        assert!(validate_frequency(&json!({"kind":"weekly","day":6,"time":"x"})).is_err());
        assert!(validate_frequency(&json!({}))
            .unwrap_err()
            .contains("(none)"));
    }

    #[test]
    fn creates_one_schedule_per_copilot_tile() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let s = create(&conn, &new("t1", "w1", &freq)).unwrap();
        assert_eq!(
            (s.tile_id.as_str(), s.paused, s.failures, s.next_run_at),
            ("t1", false, 0, None)
        );
        assert!(!s.notify_inbox && !s.notify_phone);
        assert_eq!(s.frequency, freq);
        assert!(create(&conn, &new("t1", "w1", &freq))
            .unwrap_err()
            .contains("already has a schedule"));
        assert!(create(&conn, &new("term", "w1", &freq))
            .unwrap_err()
            .contains("Copilot session"));
        assert!(create(&conn, &new("t2", "w1", &freq))
            .unwrap_err()
            .contains("not in workstream"));
        assert!(create(&conn, &new("nope", "w1", &freq))
            .unwrap_err()
            .contains("No tile"));
        let fast = json!({"kind":"interval","minutes":1});
        assert!(create(&conn, &new("t2", "w2", &fast))
            .unwrap_err()
            .contains("5 minutes"));
        let mut empty = new("t2", "w2", &freq);
        empty.prompt = "  ";
        assert!(create(&conn, &empty).unwrap_err().contains("empty"));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn updates_state_and_edits_with_validation() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let s = create(&conn, &new("t1", "w1", &freq)).unwrap();
        let s = update(
            &conn,
            &s.id,
            &json!({"prompt":"New","frequency":{"kind":"interval","minutes":120},"notify_phone":true,
                "next_run_at":500,"last_run_at":400,"last_result":"could not start","last_error":"gone",
                "failures":2,"paused":true,"run_requested":true}),
        )
        .unwrap();
        assert_eq!(s.prompt, "New");
        assert_eq!(s.frequency["minutes"], 120);
        assert!(s.notify_phone && s.paused && s.run_requested);
        assert_eq!(
            (s.next_run_at, s.last_run_at, s.failures),
            (Some(500), Some(400), 2)
        );
        assert_eq!(s.last_error.as_deref(), Some("gone"));
        let s = update(&conn, &s.id, &json!({"next_run_at":null,"last_error":null})).unwrap();
        assert_eq!((s.next_run_at, s.last_error), (None, None));
        assert!(update(
            &conn,
            &s.id,
            &json!({"frequency":{"kind":"interval","minutes":2}})
        )
        .unwrap_err()
        .contains("5 minutes"));
        assert!(update(&conn, &s.id, &json!({"prompt":""})).is_err());
        assert!(update(&conn, &s.id, &json!({"tile_id":"x"}))
            .unwrap_err()
            .contains("Unknown"));
        assert!(update(&conn, &s.id, &json!({"paused":"yes"})).is_err());
        assert!(update(&conn, &s.id, &json!([])).is_err());
        assert!(update(&conn, "nope", &json!({})).is_err());
        assert_eq!(update(&conn, &s.id, &json!({})).unwrap().prompt, "New");
    }

    #[test]
    fn every_change_moves_the_revision_and_a_stale_revision_is_refused() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let s = create(&conn, &new("t1", "w1", &freq)).unwrap();
        assert_eq!(s.revision, 0);
        let claimed = update_if(&conn, &s.id, &json!({"last_result":"running"}), Some(0)).unwrap();
        assert_eq!(claimed.revision, 1);
        // A user's pause between the runner's read and its claim wins.
        update(&conn, &s.id, &json!({"paused":true})).unwrap();
        let err = update_if(&conn, &s.id, &json!({"last_result":"running"}), Some(1)).unwrap_err();
        assert!(err.contains("changed"), "{err}");
        assert!(get(&conn, &s.id).unwrap().unwrap().paused);
        pause_workstream(&conn, "w1").unwrap();
        assert_eq!(get(&conn, &s.id).unwrap().unwrap().revision, 3);
        let stamped = update(
            &conn,
            &s.id,
            &json!({"run_requested":true,"run_requested_at":1234}),
        )
        .unwrap();
        assert_eq!(stamped.run_requested_at, Some(1234));
    }

    #[test]
    fn an_auto_pause_and_its_inbox_entry_are_stored_together_or_not_at_all() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let s = create(&conn, &new("t1", "w1", &freq)).unwrap();
        let bad = Alert {
            title: "x".repeat(200),
            body: "b".into(),
        };
        assert!(update_with_alert(
            &conn,
            &s.id,
            &json!({"paused":true,"failures":3}),
            None,
            Some(&bad)
        )
        .is_err());
        assert!(!get(&conn, &s.id).unwrap().unwrap().paused);
        assert!(crate::inbox_messages::list(&conn).unwrap().is_empty());
        let alert = Alert {
            title: "Schedule paused: Check".into(),
            body: "3 failures".into(),
        };
        let paused = update_with_alert(
            &conn,
            &s.id,
            &json!({"paused":true,"failures":3}),
            None,
            Some(&alert),
        )
        .unwrap();
        assert!(paused.paused);
        let messages = crate::inbox_messages::list(&conn).unwrap();
        assert_eq!(
            (
                messages.len(),
                messages[0].tile_id.as_str(),
                messages[0].workstream_name.as_str(),
                messages[0].level.as_str()
            ),
            (1, "t1", "Courses", "error")
        );
    }

    #[test]
    fn follows_the_tile_and_the_workstream() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        create(&conn, &new("t1", "w1", &freq)).unwrap();
        let other = create(&conn, &new("t2", "w2", &freq)).unwrap();
        // Archiving pauses; unarchiving (a status change) leaves it paused.
        assert_eq!(pause_workstream(&conn, "w2").unwrap(), 1);
        conn.execute(
            "UPDATE workstreams SET status = 'active' WHERE id = 'w2'",
            [],
        )
        .unwrap();
        assert!(get(&conn, &other.id).unwrap().unwrap().paused);
        // Closing the tile deletes its schedule.
        conn.execute("DELETE FROM tiles WHERE id = 't1'", [])
            .unwrap();
        let left: Vec<_> = list(&conn)
            .unwrap()
            .into_iter()
            .map(|s| s.tile_id)
            .collect();
        assert_eq!(left, vec!["t2"]);
        // Deleting a schedule keeps the tile.
        assert!(delete(&conn, &other.id).unwrap());
        assert!(!delete(&conn, &other.id).unwrap());
        let tiles: i64 = conn
            .query_row("SELECT COUNT(*) FROM tiles WHERE id = 't2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(tiles, 1);
    }

    #[test]
    fn schedules_and_their_state_survive_a_restart() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/tmp")
            .join(format!("ws-sched-{}", uuid::Uuid::new_v4()));
        let path = dir.join("ws.db");
        let freq = json!({"kind":"weekly","day":1,"time":"09:00"});
        let before = {
            let conn = crate::db::open_db(&path).unwrap();
            conn.execute_batch(
                "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'W', 'x', 'x');
                 INSERT INTO tiles (id, workstream_id, tile_type, config_json, created_at, updated_at)
                   VALUES ('t1', 'w1', 'copilot_session', '{}', 'x', 'x');",
            )
            .unwrap();
            let s = create(&conn, &new("t1", "w1", &freq)).unwrap();
            update(
                &conn,
                &s.id,
                &json!({"paused":true,"last_result":"timed out","failures":2,"next_run_at":99,"last_run_at":42}),
            )
            .unwrap()
        };
        let conn = crate::db::open_db(&path).unwrap();
        assert_eq!(list(&conn).unwrap(), vec![before]);
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}

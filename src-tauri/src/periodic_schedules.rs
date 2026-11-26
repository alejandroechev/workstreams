//! Periodic sessions (ADR 044, ADR 046): the stored schedules.
//!
//! The rules (next runs, skips, failure counting) live in the frontend's pure
//! model, `src/domain/periodic-schedules.ts`; this module stores schedules,
//! validates what an agent or the UI writes, and follows the lifecycle of
//! tiles and workstreams. A schedule belongs to one Periodic session tile and
//! its Copilot session (`session_id`, assigned when it is made). The schedule
//! goes with its tile (`ON DELETE CASCADE`), and deleting it removes the tile.

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
    /// The tile's Copilot session: every run creates or resumes it.
    pub session_id: Option<String>,
    /// A run has created the session: later runs pass `--resume`, not `--session-id`.
    pub session_started: bool,
    /// An ordinary Copilot tile open on the same session: the schedule is
    /// paused while it is (ADR 046, "open interactively").
    pub interactive_tile_id: Option<String>,
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
    /// `None`: a fresh session id.
    pub session_id: Option<&'a str>,
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

/// Why a schedule's prompt is refused, or Ok.
pub fn validate_prompt(prompt: &str) -> Result<(), String> {
    check_prompt(prompt)
}

/// A Periodic session tile's title: the prompt's first line, clipped.
pub fn tile_title(prompt: &str) -> String {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("Periodic session");
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(59).collect::<String>())
    } else {
        line.to_string()
    }
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

/// The first ordinary Copilot tile linked to the schedule's session, in a
/// workstream that isn't archived. A tile whose config isn't JSON links nothing.
const INTERACTIVE: &str = "(SELECT t.id FROM tiles t JOIN workstreams w ON w.id = t.workstream_id
      WHERE t.tile_type = 'copilot_session' AND s.session_id IS NOT NULL
        AND w.status NOT IN ('archived', 'archiving')
        AND json_valid(t.config_json)
        AND s.session_id IN (json_extract(t.config_json, '$.copilot_session_id'),
                             json_extract(t.config_json, '$.resume_by_id'))
      ORDER BY t.created_at, t.rowid LIMIT 1)";

fn columns() -> String {
    format!(
        "s.id, s.tile_id, s.workstream_id, s.prompt, s.frequency, s.notify_inbox, s.notify_phone, s.paused,
        s.next_run_at, s.last_run_at, s.last_result, s.last_error, s.failures, s.run_requested, s.created_at,
        s.run_requested_at, s.revision, s.session_id, s.session_started, {INTERACTIVE}"
    )
}

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
        session_id: row.get(17)?,
        session_started: row.get(18)?,
        interactive_tile_id: row.get(19)?,
    })
}

/// Stores the schedule of a Periodic session tile; one per tile.
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
        Some((_, kind)) if kind != "periodic_session" => {
            return Err("Only a Periodic session tile can have a schedule.".into())
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
    let session_id = new
        .session_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    conn.execute(
        "INSERT INTO periodic_schedules (id, tile_id, workstream_id, prompt, frequency, notify_inbox,
           notify_phone, next_run_at, created_at, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            id,
            new.tile_id,
            new.workstream_id,
            new.prompt,
            new.frequency.to_string(),
            new.notify_inbox,
            new.notify_phone,
            new.next_run_at,
            new.created_at,
            session_id
        ],
    )
    .map_err(|e| e.to_string())?;
    get(conn, &id)?.ok_or_else(|| "The schedule was not stored.".into())
}

/// Every schedule, oldest first.
pub fn list(conn: &Connection) -> Result<Vec<Schedule>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {} FROM periodic_schedules s ORDER BY s.created_at, s.rowid",
            columns()
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
        &format!(
            "SELECT {} FROM periodic_schedules s WHERE s.id = ?1",
            columns()
        ),
        [id],
        from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn for_tile(conn: &Connection, tile_id: &str) -> Result<Option<Schedule>, String> {
    conn.query_row(
        &format!(
            "SELECT {} FROM periodic_schedules s WHERE s.tile_id = ?1",
            columns()
        ),
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

/// A run created the schedule's session: later runs resume it.
pub fn mark_session_started(conn: &Connection, id: &str) -> Result<Schedule, String> {
    conn.execute(
        "UPDATE periodic_schedules SET session_started = 1, revision = revision + 1 WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    get(conn, id)?.ok_or_else(|| format!("No schedule {id}"))
}

/// Removes a schedule with its Periodic session tile (and so its runs).
/// False when there was none.
pub fn delete(conn: &Connection, id: &str) -> Result<bool, String> {
    let Some(schedule) = get(conn, id)? else {
        return Ok(false);
    };
    crate::remove_tile_row(conn, &schedule.tile_id)?;
    conn.execute("DELETE FROM periodic_schedules WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Archiving a workstream pauses its schedules; unarchiving leaves them paused.
pub fn pause_workstream(conn: &Connection, workstream_id: &str) -> Result<usize, String> {
    conn.execute(
        "UPDATE periodic_schedules SET paused = 1, revision = revision + 1 WHERE workstream_id = ?1",
        [workstream_id],
    )
    .map_err(|e| e.to_string())
}

/// The one-time notice an old tile shows once its schedule moved (ADR 046).
pub fn moved_notice(title: &str) -> String {
    format!(
        "This tile's schedule moved to the Periodic session tile \"{title}\", which runs it on this same session. \
         It stays paused while this tile is open on the session; close this tile to let it run."
    )
}

/// One-time upgrade to ADR 046: each schedule still on an ordinary Copilot
/// tile becomes a new Periodic session tile in the same workstream, on the
/// same Copilot session (a fresh one when the old tile had none yet), keeping
/// its prompt, frequency, toggles, pause and history. The old tile stays an
/// ordinary Copilot tile and gets a `pending_notice` the app shows once.
/// Idempotent: a migrated schedule is on a Periodic session tile.
pub fn migrate_to_periodic_tiles(conn: &Connection) -> Result<usize, String> {
    let legacy: Vec<(String, String, String, String, String)> = conn
        .prepare(
            "SELECT s.id, s.tile_id, s.workstream_id, s.prompt, t.config_json FROM periodic_schedules s
             JOIN tiles t ON t.id = s.tile_id WHERE t.tile_type <> 'periodic_session'
             ORDER BY s.created_at, s.rowid",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect()
        })
        .map_err(|e| e.to_string())?;
    for (id, old_tile, workstream, prompt, config) in &legacy {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut config: Value =
            serde_json::from_str(config).unwrap_or_else(|_| serde_json::json!({}));
        let linked = ["copilot_session_id", "resume_by_id"]
            .iter()
            .filter_map(|key| config.get(*key).and_then(Value::as_str))
            .find(|v| !v.is_empty())
            .map(str::to_string);
        let session_started = linked.is_some();
        let session_id = linked.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let title = tile_title(prompt);
        let tile = crate::insert_tile(
            &tx,
            workstream,
            "periodic_session",
            Some(title.clone()),
            None,
        )?;
        tx.execute(
            "UPDATE periodic_schedules SET tile_id = ?2, session_id = ?3, session_started = ?4,
               last_result = CASE last_result WHEN 'could not start' THEN 'failed'
                 WHEN 'timed out' THEN 'timed_out' WHEN 'running' THEN 'interrupted' ELSE last_result END,
               run_requested = 0, run_requested_at = NULL, revision = revision + 1
             WHERE id = ?1",
            params![id, tile.id, session_id, session_started],
        )
        .map_err(|e| e.to_string())?;
        if let Some(object) = config.as_object_mut() {
            object.insert("pending_notice".into(), Value::from(moved_notice(&title)));
            object.remove("icon");
        }
        tx.execute(
            "UPDATE tiles SET config_json = ?2 WHERE id = ?1",
            params![old_tile, config.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(legacy.len())
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
               ('t1', 'w1', 'periodic_session', 'Videos', '{}', 'x', 'x'),
               ('t2', 'w2', 'periodic_session', 'CI', '{}', 'x', 'x'),
               ('c1', 'w1', 'copilot_session', 'Chat', '{\"copilot_session_id\":\"s1\"}', 'x', 'x'),
               ('term', 'w1', 'terminal', 'Shell', '{}', 'x', 'x');
             INSERT INTO workstream_layouts (workstream_id, layout_mode, tile_order_json, updated_at)
               VALUES ('w1', 'grid', '[\"t1\",\"c1\",\"term\"]', 'x');",
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
            session_id: None,
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
    fn a_schedule_gets_its_session_id_when_it_is_made() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let fresh = create(&conn, &new("t1", "w1", &freq)).unwrap();
        let id = fresh.session_id.clone().unwrap();
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().to_string(), id);
        assert!(!fresh.session_started);
        let mut given = new("t2", "w2", &freq);
        given.session_id = Some("s-given");
        assert_eq!(
            create(&conn, &given).unwrap().session_id.as_deref(),
            Some("s-given")
        );
        let started = mark_session_started(&conn, &fresh.id).unwrap();
        assert!(started.session_started);
        assert_eq!(started.revision, fresh.revision + 1);
    }

    #[test]
    fn an_open_copilot_tile_on_the_session_makes_it_interactive() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let mut on_s1 = new("t1", "w1", &freq);
        on_s1.session_id = Some("s1");
        let s = create(&conn, &on_s1).unwrap();
        assert_eq!(s.interactive_tile_id.as_deref(), Some("c1"));
        assert_eq!(
            list(&conn).unwrap()[0].interactive_tile_id.as_deref(),
            Some("c1")
        );
        // resume_by_id is a link too; a broken config is not.
        conn.execute_batch(
            "UPDATE tiles SET config_json = '{\"resume_by_id\":\"s1\"}' WHERE id = 'c1';
             INSERT INTO tiles (id, workstream_id, tile_type, config_json, created_at, updated_at)
               VALUES ('bad', 'w1', 'copilot_session', 'not json', 'x', 'x');",
        )
        .unwrap();
        assert_eq!(
            get(&conn, &s.id)
                .unwrap()
                .unwrap()
                .interactive_tile_id
                .as_deref(),
            Some("c1")
        );
        // In an archived workstream it doesn't count, nor once closed.
        conn.execute(
            "UPDATE workstreams SET status = 'archived' WHERE id = 'w1'",
            [],
        )
        .unwrap();
        assert_eq!(
            get(&conn, &s.id).unwrap().unwrap().interactive_tile_id,
            None
        );
        conn.execute(
            "UPDATE workstreams SET status = 'active' WHERE id = 'w1'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM tiles WHERE id = 'c1'", [])
            .unwrap();
        assert_eq!(
            get(&conn, &s.id).unwrap().unwrap().interactive_tile_id,
            None
        );
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
            .contains("Periodic session"));
        assert!(create(&conn, &new("c1", "w1", &freq))
            .unwrap_err()
            .contains("Periodic session"));
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

    /// Mute all (ADR 045): the schedule still pauses; its notice is dropped.
    #[test]
    fn an_auto_pause_while_the_inbox_is_muted_posts_no_notice() {
        let conn = db();
        let freq = json!({"kind":"daily","time":"09:00"});
        let s = create(&conn, &new("t1", "w1", &freq)).unwrap();
        crate::inbox_mute::mute(&conn, None).unwrap();
        let alert = Alert {
            title: "Schedule paused: Check".into(),
            body: "3 failures".into(),
        };
        let paused =
            update_with_alert(&conn, &s.id, &json!({"paused":true}), None, Some(&alert)).unwrap();
        assert!(paused.paused);
        assert!(crate::inbox_messages::list(&conn).unwrap().is_empty());
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
        // Deleting a schedule removes its tile, from the layout too.
        conn.execute_batch(
            "INSERT INTO tiles (id, workstream_id, tile_type, config_json, created_at, updated_at)
               VALUES ('t3', 'w1', 'periodic_session', '{}', 'x', 'x');
             UPDATE workstream_layouts SET tile_order_json = '[\"c1\",\"t3\",\"term\"]';",
        )
        .unwrap();
        let mine = create(&conn, &new("t3", "w1", &freq)).unwrap();
        assert!(delete(&conn, &mine.id).unwrap());
        assert!(!delete(&conn, &mine.id).unwrap());
        let tiles: i64 = conn
            .query_row("SELECT COUNT(*) FROM tiles WHERE id = 't3'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(tiles, 0);
        let order: String = conn
            .query_row(
                "SELECT tile_order_json FROM workstream_layouts WHERE workstream_id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(order, r#"["c1","term"]"#);
        assert!(delete(&conn, &other.id).unwrap());
    }

    /// AT-8 (US-7): a database from before ADR 046 — two schedules on
    /// ordinary Copilot tiles, one paused, on sessions S1 and S2, plus one on
    /// a tile with no session yet — migrates once, keeping each session.
    #[test]
    fn existing_schedules_move_to_periodic_tiles_once_on_the_same_session() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::init_db(&conn).unwrap();
        // The schema before this change.
        conn.execute_batch(
            "ALTER TABLE periodic_schedules DROP COLUMN session_id;
             ALTER TABLE periodic_schedules DROP COLUMN session_started;
             INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'Courses', 'x', 'x'), ('w2', 'Infra', 'x', 'x');
             INSERT INTO workstream_layouts (workstream_id, layout_mode, tile_order_json, updated_at)
               VALUES ('w1', 'grid', '[\"old1\",\"fresh\"]', 'x'), ('w2', 'grid', '[\"old2\"]', 'x');
             INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at) VALUES
               ('old1', 'w1', 'copilot_session', 'Videos', '{\"copilot_session_id\":\"S1\",\"cwd\":\"/c\"}', 'x', 'x'),
               ('old2', 'w2', 'copilot_session', 'CI', '{\"resume_by_id\":\"S2\"}', 'x', 'x'),
               ('fresh', 'w1', 'copilot_session', 'New', '{}', 'x', 'x');
             INSERT INTO periodic_schedules (id, tile_id, workstream_id, prompt, frequency, notify_inbox, notify_phone,
               paused, next_run_at, last_result, failures, created_at) VALUES
               ('a', 'old1', 'w1', 'Check videos', '{\"kind\":\"daily\",\"time\":\"09:00\"}', 1, 0, 0, 5, 'ok', 0, 1),
               ('b', 'old2', 'w2', 'Check CI', '{\"kind\":\"interval\",\"minutes\":120}', 0, 1, 1, NULL, 'timed out', 2, 2),
               ('c', 'fresh', 'w1', 'Fresh one', '{\"kind\":\"interval\",\"minutes\":60}', 0, 0, 0, NULL, 'could not start', 1, 3);",
        )
        .unwrap();
        crate::db::init_db(&conn).unwrap();
        let first = list(&conn).unwrap();
        let tile_of = |id: &str| -> (String, String, Option<String>, String) {
            conn.query_row(
                "SELECT tile_type, workstream_id, title, config_json FROM tiles WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
        };
        assert_eq!(first.len(), 3);
        let a = &first[0];
        let (kind, ws, title, _) = tile_of(&a.tile_id);
        assert_eq!(
            (kind.as_str(), ws.as_str(), title.as_deref()),
            ("periodic_session", "w1", Some("Check videos"))
        );
        assert_eq!(
            (a.session_id.as_deref(), a.session_started),
            (Some("S1"), true)
        );
        assert_eq!(
            (
                a.prompt.as_str(),
                a.notify_inbox,
                a.notify_phone,
                a.paused,
                a.next_run_at
            ),
            ("Check videos", true, false, false, Some(5))
        );
        assert_eq!(
            a.frequency,
            serde_json::json!({"kind":"daily","time":"09:00"})
        );
        // The old tile is open on S1: the new one is paused while it is.
        assert_eq!(a.interactive_tile_id.as_deref(), Some("old1"));
        let b = &first[1];
        assert_eq!(
            (
                b.session_id.as_deref(),
                b.paused,
                b.notify_phone,
                b.failures
            ),
            (Some("S2"), true, true, 2)
        );
        assert_eq!(b.last_result.as_deref(), Some("timed_out"));
        assert_eq!(tile_of(&b.tile_id).1, "w2");
        // No session yet: a fresh one, created by the first run.
        let c = &first[2];
        assert!(uuid::Uuid::parse_str(c.session_id.as_deref().unwrap()).is_ok());
        assert!(!c.session_started);
        assert_eq!(c.last_result.as_deref(), Some("failed"));
        // The old tiles stay ordinary Copilot tiles, each with one notice to show.
        for old in ["old1", "old2", "fresh"] {
            let (kind, _, _, config) = tile_of(old);
            assert_eq!(kind, "copilot_session");
            let config: Value = serde_json::from_str(&config).unwrap();
            assert!(
                config["pending_notice"].as_str().unwrap().contains("moved"),
                "{config}"
            );
        }
        assert_eq!(
            serde_json::from_str::<Value>(&tile_of("old1").3).unwrap()["cwd"],
            "/c"
        );
        let order: String = conn
            .query_row(
                "SELECT tile_order_json FROM workstream_layouts WHERE workstream_id = 'w1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(order.contains(&a.tile_id) && order.contains(&c.tile_id));
        // A second start changes nothing: no new tiles, no notice again once shown.
        conn.execute(
            "UPDATE tiles SET config_json = '{\"copilot_session_id\":\"S1\"}' WHERE id = 'old1'",
            [],
        )
        .unwrap();
        crate::db::init_db(&conn).unwrap();
        let second = list(&conn).unwrap();
        assert_eq!(
            second
                .iter()
                .map(|s| (&s.tile_id, &s.session_id))
                .collect::<Vec<_>>(),
            first
                .iter()
                .map(|s| (&s.tile_id, &s.session_id))
                .collect::<Vec<_>>()
        );
        let periodic: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tiles WHERE tile_type = 'periodic_session'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(periodic, 3);
        assert!(
            serde_json::from_str::<Value>(&tile_of("old1").3).unwrap()["pending_notice"].is_null()
        );
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
                   VALUES ('t1', 'w1', 'periodic_session', '{}', 'x', 'x');",
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

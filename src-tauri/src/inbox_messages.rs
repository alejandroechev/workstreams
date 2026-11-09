//! Messages agents send to the user's Inbox (ADR 041).
//!
//! A Copilot session in a Workstreams tile calls `inbox.message` once
//! something it was asked to watch for has happened. The message is tied to
//! the tile and its workstream; the workstream's name is copied so a message
//! outlives the workstream that sent it.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const LEVELS: [&str; 4] = ["info", "done", "needs-you", "error"];
pub const MAX_TITLE: usize = 120;
pub const MAX_BODY: usize = 20_000;
/// Messages one session may send per rolling hour.
pub const HOURLY_CAP: i64 = 20;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AgentMessage {
    pub id: String,
    pub workstream_id: String,
    pub workstream_name: String,
    pub tile_id: String,
    pub level: String,
    pub title: String,
    pub body: String,
    pub is_read: bool,
    pub created_at: String,
    /// Whether the sending tile (and so its workstream) still exists.
    pub available: bool,
}

/// Why a message was refused: a code for agents and a human sentence.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    Invalid(String),
    RateLimited,
}

pub fn check(level: &str, title: &str, body: &str) -> Result<(), String> {
    if !LEVELS.contains(&level) {
        return Err(format!(
            "level must be one of {}; got {level:?}",
            LEVELS.join(", ")
        ));
    }
    let title_len = title.trim().chars().count();
    if title_len == 0 {
        return Err("title is required".into());
    }
    if title_len > MAX_TITLE {
        return Err(format!(
            "title is {title_len} characters; the limit is {MAX_TITLE}"
        ));
    }
    let body_len = body.chars().count();
    if body_len > MAX_BODY {
        return Err(format!(
            "body is {body_len} characters; the limit is {MAX_BODY}"
        ));
    }
    Ok(())
}

/// Stores a message from `tile_id` in `workstream_id`, refusing invalid input
/// and a session over its hourly cap.
pub fn send(
    db: &Connection,
    workstream_id: &str,
    tile_id: &str,
    level: &str,
    title: &str,
    body: &str,
) -> Result<AgentMessage, Refusal> {
    check(level, title, body).map_err(Refusal::Invalid)?;
    let sent: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM agent_messages WHERE tile_id=?1
            AND julianday(created_at) > julianday('now') - 1.0/24",
            [tile_id],
            |r| r.get(0),
        )
        .map_err(|e| Refusal::Invalid(e.to_string()))?;
    if sent >= HOURLY_CAP {
        return Err(Refusal::RateLimited);
    }
    let name: String = db
        .query_row(
            "SELECT COALESCE((SELECT name FROM workstreams WHERE id=?1), '')",
            [workstream_id],
            |r| r.get(0),
        )
        .map_err(|e| Refusal::Invalid(e.to_string()))?;
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO agent_messages (id, workstream_id, workstream_name, tile_id, level, title, body, is_read, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![id, workstream_id, name, tile_id, level, title.trim(), body],
    )
    .map_err(|e| Refusal::Invalid(e.to_string()))?;
    Ok(list(db)
        .map_err(Refusal::Invalid)?
        .into_iter()
        .find(|m| m.id == id)
        .expect("just inserted"))
}

/// Every message, newest first.
pub fn list(db: &Connection) -> Result<Vec<AgentMessage>, String> {
    let mut stmt = db
        .prepare(
            "SELECT m.id, m.workstream_id, COALESCE(w.name, m.workstream_name), m.tile_id, m.level,
            m.title, m.body, m.is_read, m.created_at,
            EXISTS(SELECT 1 FROM tiles t WHERE t.id = m.tile_id) AND w.id IS NOT NULL
            FROM agent_messages m LEFT JOIN workstreams w ON w.id = m.workstream_id
            ORDER BY m.created_at DESC, m.rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AgentMessage {
                id: r.get(0)?,
                workstream_id: r.get(1)?,
                workstream_name: r.get(2)?,
                tile_id: r.get(3)?,
                level: r.get(4)?,
                title: r.get(5)?,
                body: r.get(6)?,
                is_read: r.get(7)?,
                created_at: r.get(8)?,
                available: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Sets a message's read state; false when there's no such message.
pub fn set_read(db: &Connection, id: &str, is_read: bool) -> Result<bool, String> {
    db.execute(
        "UPDATE agent_messages SET is_read=?2 WHERE id=?1",
        params![id, is_read],
    )
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
            INSERT INTO workstreams (id, name, directory, created_at, updated_at) VALUES ('w1', 'Bench', '/b', 'now', 'now');
            INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at) VALUES ('t1', 'w1', 'copilot_session', 'S', '{}', 'now', 'now');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_message_is_stored_against_its_tile_and_workstream() {
        let db = db();
        let m = send(
            &db,
            "w1",
            "t1",
            "done",
            " Benchmarks finished ",
            "p95 38 → 21",
        )
        .unwrap();
        assert_eq!(
            (
                m.workstream_name.as_str(),
                m.title.as_str(),
                m.level.as_str(),
                m.is_read,
                m.available
            ),
            ("Bench", "Benchmarks finished", "done", false, true)
        );
        assert!(set_read(&db, &m.id, true).unwrap());
        assert!(list(&db).unwrap()[0].is_read);
        assert!(!set_read(&db, "nope", true).unwrap());
    }

    #[test]
    fn invalid_messages_are_refused_with_the_rule_broken() {
        let db = db();
        let invalid = |level: &str, title: &str, body: &str| match send(
            &db, "w1", "t1", level, title, body,
        ) {
            Err(Refusal::Invalid(e)) => e,
            other => panic!("{other:?}"),
        };
        assert!(invalid("urgent", "t", "").contains("info, done, needs-you, error"));
        assert!(invalid("done", "  ", "").contains("title is required"));
        assert!(invalid("done", &"x".repeat(121), "").contains("limit is 120"));
        assert!(invalid("done", "t", &"x".repeat(20_001)).contains("limit is 20000"));
        assert!(send(
            &db,
            "w1",
            "t1",
            "info",
            &"x".repeat(120),
            &"x".repeat(20_000)
        )
        .is_ok());
    }

    #[test]
    fn a_session_may_send_twenty_an_hour() {
        let db = db();
        for _ in 0..20 {
            send(&db, "w1", "t1", "info", "t", "").unwrap();
        }
        assert_eq!(
            send(&db, "w1", "t1", "info", "t", ""),
            Err(Refusal::RateLimited)
        );
        assert!(send(&db, "w1", "t2", "info", "other session", "").is_ok());
        db.execute(
            "UPDATE agent_messages SET created_at = '2000-01-01T00:00:00Z' WHERE tile_id='t1'",
            [],
        )
        .unwrap();
        assert!(send(&db, "w1", "t1", "info", "an hour later", "").is_ok());
    }

    #[test]
    fn a_message_outlives_its_workstream_with_the_old_name() {
        let db = db();
        send(&db, "w1", "t1", "done", "t", "").unwrap();
        db.execute_batch("DELETE FROM tiles; DELETE FROM workstreams;")
            .unwrap();
        let m = &list(&db).unwrap()[0];
        assert_eq!((m.workstream_name.as_str(), m.available), ("Bench", false));
    }
}

//! Messages from phone-started sessions (ADR 033, "Messages from phone-started
//! sessions"). The laptop's SQLite copy is the source of truth; the companion
//! document only publishes it.
//!
//! The limits mirror `src/companion/protocol` (`MAX_MESSAGE_LENGTH`,
//! `MAX_MESSAGES_PER_SESSION`), which the phone reads them from.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const MAX_MESSAGE_LENGTH: usize = 20_000;
pub const MAX_MESSAGES_PER_SESSION: i64 = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub tile_id: String,
    pub workstream_id: String,
    pub request_id: String,
    pub prompt: String,
    pub created_at: i64,
    pub messages: Vec<StoredMessage>,
}

/// Records that the phone started this tile. Recording the same tile again is
/// a no-op: the first record wins.
pub fn record_session(
    conn: &Connection,
    tile_id: &str,
    workstream_id: &str,
    request_id: &str,
    prompt: &str,
    created_at: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO companion_sessions (tile_id, workstream_id, request_id, prompt, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![tile_id, workstream_id, request_id, prompt, created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Whether this tile is a phone session that may still send.
pub fn is_phone_session(conn: &Connection, tile_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM companion_sessions WHERE tile_id = ?1 AND can_send = 1",
        [tile_id],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| e.to_string())
}

/// Whether the user has the phone companion turned on in Settings.
pub fn companion_enabled(conn: &Connection) -> Result<bool, String> {
    let value: Option<Option<String>> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'companion.enabled'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value.flatten().as_deref() == Some("1"))
}

/// Why a message is refused; the text is shown to the agent as-is.
pub fn check_message(kind: &str, text: &str) -> Result<(), String> {
    if kind != "progress" && kind != "result" {
        return Err("The kind must be \"progress\" or \"result\".".into());
    }
    if text.trim().is_empty() {
        return Err("The message is empty.".into());
    }
    // Characters as JavaScript counts them (UTF-16 code units), so the limit
    // means the same on both sides.
    if text.encode_utf16().count() > MAX_MESSAGE_LENGTH {
        return Err(format!(
            "The message is longer than {MAX_MESSAGE_LENGTH} characters."
        ));
    }
    Ok(())
}

/// Stores a message for a phone session and keeps only its latest messages.
pub fn add_message(
    conn: &Connection,
    tile_id: &str,
    id: &str,
    kind: &str,
    text: &str,
    at: i64,
) -> Result<(), String> {
    check_message(kind, text)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM companion_sessions WHERE tile_id = ?1 AND can_send = 1",
            [tile_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if exists.is_none() {
        return Err("This session was not started from your phone.".into());
    }
    tx.execute(
        "INSERT INTO companion_messages (id, tile_id, kind, text, at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, tile_id, kind, text, at],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM companion_messages WHERE tile_id = ?1 AND id NOT IN (
           SELECT id FROM companion_messages WHERE tile_id = ?1 ORDER BY at DESC, seq DESC LIMIT ?2)",
        params![tile_id, MAX_MESSAGES_PER_SESSION],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Stops a tile from messaging the phone, keeping what it already sent: the
/// tile now runs a session the phone did not start.
pub fn revoke(conn: &Connection, tile_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE companion_sessions SET can_send = 0 WHERE tile_id = ?1",
        [tile_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Forgets a phone session that never started (its launch was refused).
pub fn delete(conn: &Connection, tile_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM companion_sessions WHERE tile_id = ?1",
        [tile_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every phone session with its messages, oldest message first.
pub fn list(conn: &Connection) -> Result<Vec<StoredSession>, String> {
    let mut sessions = conn
        .prepare(
            "SELECT tile_id, workstream_id, request_id, prompt, created_at
             FROM companion_sessions ORDER BY created_at DESC, tile_id",
        )
        .map_err(|e| e.to_string())?
        .query_map([], |row| {
            Ok(StoredSession {
                tile_id: row.get(0)?,
                workstream_id: row.get(1)?,
                request_id: row.get(2)?,
                prompt: row.get(3)?,
                created_at: row.get(4)?,
                messages: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT id, kind, text, at FROM companion_messages WHERE tile_id = ?1 ORDER BY at, seq",
        )
        .map_err(|e| e.to_string())?;
    for session in &mut sessions {
        session.messages = statement
            .query_map([&session.tile_id], |row| {
                Ok(StoredMessage {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    text: row.get(2)?,
                    at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    }
    Ok(sessions)
}

/// Removes sessions (and their messages) whose last activity — the latest
/// message, or the start if there is none — is older than `retention_ms`.
/// Returns how many sessions were removed.
pub fn prune(conn: &Connection, now: i64, retention_ms: i64) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM companion_sessions WHERE MAX(created_at,
           COALESCE((SELECT MAX(at) FROM companion_messages m WHERE m.tile_id = companion_sessions.tile_id), 0)
         ) < ?1",
        [now - retention_ms],
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 60 * 60_000;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w', 'W', 'x', 'x')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn records_a_phone_session_once() {
        let conn = db();
        assert!(!is_phone_session(&conn, "t1").unwrap());
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        record_session(&conn, "t1", "w", "r2", "Other", 2000).unwrap();
        assert!(is_phone_session(&conn, "t1").unwrap());
        let sessions = list(&conn).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].request_id, "r1");
        assert_eq!(sessions[0].prompt, "Do x");
    }

    #[test]
    fn stores_messages_in_order_for_phone_sessions_only() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        add_message(&conn, "t1", "m1", "progress", "working", 2000).unwrap();
        add_message(&conn, "t1", "m2", "result", "# Done", 3000).unwrap();
        let messages = &list(&conn).unwrap()[0].messages;
        assert_eq!(
            messages
                .iter()
                .map(|m| (m.id.as_str(), m.kind.as_str()))
                .collect::<Vec<_>>(),
            vec![("m1", "progress"), ("m2", "result")]
        );
        assert_eq!(
            add_message(&conn, "elsewhere", "m3", "result", "x", 4000).unwrap_err(),
            "This session was not started from your phone."
        );
    }

    #[test]
    fn refuses_bad_kinds_empty_and_overlong_text() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        assert!(add_message(&conn, "t1", "a", "question", "x", 1)
            .unwrap_err()
            .contains("kind"));
        assert!(add_message(&conn, "t1", "b", "result", "  \n", 1)
            .unwrap_err()
            .contains("empty"));
        let long = "x".repeat(MAX_MESSAGE_LENGTH + 1);
        assert!(add_message(&conn, "t1", "c", "result", &long, 1)
            .unwrap_err()
            .contains("20000"));
        let exact = "x".repeat(MAX_MESSAGE_LENGTH);
        add_message(&conn, "t1", "d", "result", &exact, 1).unwrap();
        // UTF-16 length, as on the phone: an emoji counts as two.
        let emoji = "😀".repeat(MAX_MESSAGE_LENGTH / 2 + 1);
        assert!(check_message("result", &emoji).is_err());
        assert_eq!(list(&conn).unwrap()[0].messages.len(), 1);
    }

    #[test]
    fn keeps_only_the_latest_messages_of_a_session() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 0).unwrap();
        for i in 0..=MAX_MESSAGES_PER_SESSION {
            add_message(&conn, "t1", &format!("m{i}"), "progress", "x", i).unwrap();
        }
        let messages = &list(&conn).unwrap()[0].messages;
        assert_eq!(messages.len() as i64, MAX_MESSAGES_PER_SESSION);
        assert_eq!(messages[0].id, "m1");
    }

    #[test]
    fn same_timestamp_messages_keep_their_order() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 0).unwrap();
        for i in 0..3 {
            add_message(&conn, "t1", &format!("z{i}"), "progress", "x", 5).unwrap();
        }
        let ids: Vec<_> = list(&conn).unwrap()[0]
            .messages
            .iter()
            .map(|m| m.id.clone())
            .collect();
        assert_eq!(ids, vec!["z0", "z1", "z2"]);
    }

    #[test]
    fn prunes_sessions_three_days_after_their_last_activity() {
        let conn = db();
        let now = 10 * DAY;
        record_session(&conn, "quiet", "w", "r1", "a", now - 3 * DAY - 60_000).unwrap();
        record_session(&conn, "old", "w", "r2", "b", now - 5 * DAY).unwrap();
        add_message(&conn, "old", "m1", "result", "x", now - 3 * DAY - 60_000).unwrap();
        record_session(&conn, "recent", "w", "r3", "c", now - 5 * DAY).unwrap();
        add_message(&conn, "recent", "m2", "result", "x", now - DAY).unwrap();
        assert_eq!(prune(&conn, now, 3 * DAY).unwrap(), 2);
        let left: Vec<_> = list(&conn)
            .unwrap()
            .into_iter()
            .map(|s| s.tile_id)
            .collect();
        assert_eq!(left, vec!["recent"]);
        let orphans: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM companion_messages WHERE tile_id = 'old'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn a_revoked_tile_keeps_its_history_but_can_no_longer_send() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        add_message(&conn, "t1", "m1", "result", "kept", 2000).unwrap();
        revoke(&conn, "t1").unwrap();
        assert!(!is_phone_session(&conn, "t1").unwrap());
        assert_eq!(
            add_message(&conn, "t1", "m2", "result", "x", 3000).unwrap_err(),
            "This session was not started from your phone."
        );
        assert_eq!(list(&conn).unwrap()[0].messages.len(), 1);
        // Re-recording the same tile does not restore the permission.
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        assert!(!is_phone_session(&conn, "t1").unwrap());
    }

    #[test]
    fn a_session_that_never_started_can_be_forgotten() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        delete(&conn, "t1").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn sessions_go_with_their_workstream() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        conn.execute("DELETE FROM workstreams WHERE id = 'w'", [])
            .unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }
}

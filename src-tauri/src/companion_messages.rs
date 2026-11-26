//! Messages from phone-started sessions (ADR 033, "Messages from phone-started
//! sessions"). The laptop's SQLite copy is the source of truth; the companion
//! document only publishes it.
//!
//! The limits mirror `src/companion/protocol` (`MAX_MESSAGE_LENGTH`,
//! `MAX_MESSAGES_PER_SESSION`), which the phone reads them from.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

pub const MAX_MESSAGE_LENGTH: usize = 20_000;
pub const MAX_MESSAGES_PER_SESSION: i64 = 200;
/// Messages one tile's agent may send the phone per rolling hour (ADR 044),
/// counted apart from the Inbox's cap.
pub const PHONE_HOURLY_CAP: i64 = 20;

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
    /// False once the tile was re-linked to a session the phone did not start.
    pub can_send: bool,
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

/// Makes a tile the phone just messaged a phone session (companion
/// conversations). An existing phone session is left as it is. A tile whose
/// permission was revoked (it was re-linked to another session) starts a fresh
/// conversation: the old one belonged to a different Copilot session.
pub fn claim_session(
    conn: &Connection,
    tile_id: &str,
    workstream_id: &str,
    request_id: &str,
    prompt: &str,
    created_at: i64,
    expected_session: &str,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Checked in the same transaction as the claim, so a laptop re-link can't
    // slip between the phone's revision check and the claim undoing its revocation.
    let config: Option<String> = tx
        .query_row(
            "SELECT config_json FROM tiles WHERE id = ?1",
            [tile_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if linked_session(config.as_deref()).as_deref() != Some(expected_session) {
        return Err("This tile now runs a different Copilot session, so the message was not delivered and nothing was restarted.".into());
    }
    tx.execute(
        "DELETE FROM companion_sessions WHERE tile_id = ?1 AND can_send = 0",
        [tile_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO companion_sessions (tile_id, workstream_id, request_id, prompt, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![tile_id, workstream_id, request_id, prompt, created_at],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Gives a laptop-started tile a phone thread on its agent's first message
/// (ADR 044: any session may message the phone), named after the tile. A
/// tile that already has one keeps it; a revoked one (re-linked since) starts
/// afresh, like a phone claim does.
pub fn open_laptop_thread(
    conn: &Connection,
    tile_id: &str,
    workstream_id: &str,
    created_at: i64,
) -> Result<(), String> {
    if is_phone_session(conn, tile_id)? {
        return Ok(());
    }
    let title: Option<Option<String>> = conn
        .query_row("SELECT title FROM tiles WHERE id = ?1", [tile_id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let title = title
        .flatten()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Copilot session".to_string());
    // Run inside the caller's transaction (send_from_agent), or on its own.
    conn.execute(
        "DELETE FROM companion_sessions WHERE tile_id = ?1 AND can_send = 0",
        [tile_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO companion_sessions (tile_id, workstream_id, request_id, prompt, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            tile_id,
            workstream_id,
            format!("laptop-{tile_id}-{created_at}"),
            title,
            created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

const HOUR_MS: i64 = 60 * 60_000;

/// How many messages this tile's agent sent the phone in the hour before
/// `now`, from the send ledger: replacing or pruning a thread doesn't reset it.
pub fn sent_last_hour(conn: &Connection, tile_id: &str, now: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM companion_send_log WHERE tile_id = ?1 AND at > ?2",
        params![tile_id, now - HOUR_MS],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Why an agent's message to the phone was refused.
#[derive(Debug, PartialEq)]
pub enum SendRefusal {
    RateLimited(i64),
    Store(String),
}

/// An agent's message to the phone, in one transaction: the hourly cap is
/// checked against the send ledger, the tile's thread opened if it has none
/// (named after the tile), the message stored, and the send logged.
pub fn send_from_agent(
    conn: &Connection,
    tile_id: &str,
    workstream_id: &str,
    id: &str,
    kind: &str,
    text: &str,
    at: i64,
) -> Result<(), SendRefusal> {
    check_message(kind, text).map_err(SendRefusal::Store)?;
    let store = |e: rusqlite::Error| SendRefusal::Store(e.to_string());
    let tx = conn.unchecked_transaction().map_err(store)?;
    tx.execute(
        "DELETE FROM companion_send_log WHERE tile_id = ?1 AND at <= ?2",
        params![tile_id, at - HOUR_MS],
    )
    .map_err(store)?;
    if sent_last_hour(&tx, tile_id, at).map_err(SendRefusal::Store)? >= PHONE_HOURLY_CAP {
        return Err(SendRefusal::RateLimited(PHONE_HOURLY_CAP));
    }
    open_laptop_thread(&tx, tile_id, workstream_id, at).map_err(SendRefusal::Store)?;
    insert_message_in(&tx, tile_id, id, kind, text, at).map_err(SendRefusal::Store)?;
    tx.execute(
        "INSERT INTO companion_send_log (tile_id, at) VALUES (?1, ?2)",
        params![tile_id, at],
    )
    .map_err(store)?;
    tx.commit().map_err(store)
}

/// The tile was re-linked to another Copilot session: revokes its thread and
/// bars the processes running now (they still run the old session) from the
/// phone. A process spawned later has another key and may send again.
pub fn revoke_tile(
    conn: &Connection,
    tile_id: &str,
    process_keys: &[String],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    revoke_tile_in(&tx, tile_id, process_keys)?;
    tx.commit().map_err(|e| e.to_string())
}

fn revoke_tile_in(conn: &Connection, tile_id: &str, process_keys: &[String]) -> Result<(), String> {
    conn.execute(
        "UPDATE companion_sessions SET can_send = 0 WHERE tile_id = ?1",
        [tile_id],
    )
    .map_err(|e| e.to_string())?;
    for key in process_keys {
        conn.execute(
            "INSERT OR IGNORE INTO companion_barred_processes (tile_id, process_key) VALUES (?1, ?2)",
            params![tile_id, key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Links a tile to another Copilot session in one transaction: its config
/// (and title) change, its thread is revoked, and the processes running the
/// old session are barred from the phone. A resume's claim checks the link
/// under the same lock, so it can't slip in between.
pub fn relink_tile(
    conn: &Connection,
    tile_id: &str,
    config_json: &str,
    title: Option<&str>,
    process_keys: &[String],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let changed = tx
        .execute(
            "UPDATE tiles SET config_json = ?2, title = COALESCE(?3, title),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
            params![tile_id, config_json, title],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("No tile {tile_id}"));
    }
    revoke_tile_in(&tx, tile_id, process_keys)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Refuses to start `session_id` in a tile linked to another session: a
/// resume that read the link before a re-link must not launch (and get a
/// token for) the old session. An unlinked or unknown tile may start any.
pub fn check_resume_target(
    conn: &Connection,
    tile_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let config: Option<String> = conn
        .query_row(
            "SELECT config_json FROM tiles WHERE id = ?1",
            [tile_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match linked_session(config.as_deref()) {
        Some(linked) if linked != session_id => Err(
            "This tile now runs a different Copilot session, so the old one was not started."
                .into(),
        ),
        _ => Ok(()),
    }
}

/// Whether this process of the tile was barred by a re-link.
pub fn is_barred(conn: &Connection, tile_id: &str, process_key: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM companion_barred_processes WHERE tile_id = ?1 AND process_key = ?2",
        params![tile_id, process_key],
        |_| Ok(()),
    )
    .optional()
    .map(|found| found.is_some())
    .map_err(|e| e.to_string())
}

/// Revokes a tile's thread only if it is still the one `request_id` claimed:
/// a resume rolling back must not revoke a thread a newer claim created.
/// Returns whether it revoked.
pub fn revoke_claim(conn: &Connection, tile_id: &str, request_id: &str) -> Result<bool, String> {
    conn.execute(
        "UPDATE companion_sessions SET can_send = 0 WHERE tile_id = ?1 AND request_id = ?2",
        params![tile_id, request_id],
    )
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

/// The Copilot session a tile's config links it to, as the app reads it.
fn linked_session(config_json: Option<&str>) -> Option<String> {
    let config: serde_json::Value = serde_json::from_str(config_json?).ok()?;
    ["copilot_session_id", "resume_by_id"]
        .iter()
        .filter_map(|key| config.get(*key).and_then(|v| v.as_str()))
        .find(|v| !v.is_empty())
        .map(str::to_string)
}

/// Records what you sent from the phone as a `prompt` message, so the thread
/// shows both sides. Counts towards the cap and the retention like any message.
pub fn add_prompt(
    conn: &Connection,
    tile_id: &str,
    id: &str,
    text: &str,
    at: i64,
) -> Result<(), String> {
    check_text(text)?;
    insert_message(conn, tile_id, id, "prompt", text, at)
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
    check_text(text)
}

fn check_text(text: &str) -> Result<(), String> {
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

/// A message the app itself posts to a tile's thread (ADR 046: a periodic
/// run's prompt or answer), opening the thread, named after the tile, if it
/// has none. Not an agent's send: no hourly cap.
pub fn post_app_message(
    conn: &Connection,
    tile_id: &str,
    workstream_id: &str,
    kind: &str,
    text: &str,
    at: i64,
) -> Result<(), String> {
    if kind != "prompt" && kind != "result" {
        return Err("The kind must be \"prompt\" or \"result\".".into());
    }
    check_text(text)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    open_laptop_thread(&tx, tile_id, workstream_id, at)?;
    let id = uuid::Uuid::new_v4().to_string();
    insert_message_in(&tx, tile_id, &id, kind, text, at)?;
    tx.commit().map_err(|e| e.to_string())
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
    insert_message(conn, tile_id, id, kind, text, at)
}

fn insert_message(
    conn: &Connection,
    tile_id: &str,
    id: &str,
    kind: &str,
    text: &str,
    at: i64,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    insert_message_in(&tx, tile_id, id, kind, text, at)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Stores a message inside the caller's transaction.
fn insert_message_in(
    tx: &Connection,
    tile_id: &str,
    id: &str,
    kind: &str,
    text: &str,
    at: i64,
) -> Result<(), String> {
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
    Ok(())
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
            "SELECT tile_id, workstream_id, request_id, prompt, created_at, can_send
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
                can_send: row.get(5)?,
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

    fn tile(conn: &Connection, id: &str, session: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO tiles (id, workstream_id, tile_type, config_json, created_at, updated_at)
             VALUES (?1, 'w', 'copilot_session', ?2, 'x', 'x')",
            params![id, format!(r#"{{"copilot_session_id":"{session}"}}"#)],
        )
        .unwrap();
    }

    /// ADR 046: the app posts a periodic run's prompt and answer itself,
    /// opening the tile's thread (named after it) on first use; not counted
    /// against the agent's hourly cap.
    #[test]
    fn the_app_posts_to_a_tiles_thread_opening_it_once() {
        let conn = db();
        conn.execute(
            "INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at)
             VALUES ('p', 'w', 'periodic_session', 'Check CI', '{}', 'x', 'x')",
            [],
        )
        .unwrap();
        post_app_message(&conn, "p", "w", "prompt", "Check CI", 10).unwrap();
        post_app_message(&conn, "p", "w", "result", "All green", 20).unwrap();
        let sessions = list(&conn).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].prompt, "Check CI");
        let texts: Vec<_> = sessions[0]
            .messages
            .iter()
            .map(|m| (m.kind.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(texts, vec![("prompt", "Check CI"), ("result", "All green")]);
        assert_eq!(sent_last_hour(&conn, "p", 30).unwrap(), 0);
        assert!(post_app_message(&conn, "p", "w", "progress", "x", 30).is_err());
        assert!(post_app_message(&conn, "p", "w", "result", "  ", 30).is_err());
    }

    #[test]
    fn claiming_checks_the_tile_still_runs_the_session_the_phone_saw() {
        let conn = db();
        tile(&conn, "lap", "s-new");
        let err = claim_session(&conn, "lap", "w", "r1", "Go", 1, "s-old").unwrap_err();
        assert!(err.contains("different Copilot session"), "{err}");
        assert!(!is_phone_session(&conn, "lap").unwrap());
        let err = claim_session(&conn, "gone", "w", "r1", "Go", 1, "s-old").unwrap_err();
        assert!(err.contains("different Copilot session"), "{err}");
        // resume_by_id counts as the link too.
        conn.execute(
            "UPDATE tiles SET config_json = '{\"resume_by_id\":\"s-old\"}' WHERE id = 'lap'",
            [],
        )
        .unwrap();
        claim_session(&conn, "lap", "w", "r1", "Go", 1, "s-old").unwrap();
        assert!(is_phone_session(&conn, "lap").unwrap());
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
    fn claiming_a_laptop_tile_makes_it_a_phone_session() {
        let conn = db();
        tile(&conn, "lap", "s");
        claim_session(&conn, "lap", "w", "r9", "Go on", 5000, "s").unwrap();
        assert!(is_phone_session(&conn, "lap").unwrap());
        let sessions = list(&conn).unwrap();
        assert_eq!(
            (
                sessions[0].request_id.as_str(),
                sessions[0].prompt.as_str(),
                sessions[0].can_send
            ),
            ("r9", "Go on", true)
        );
        // A phone session already claimed keeps its first record.
        claim_session(&conn, "lap", "w", "r10", "Again", 6000, "s").unwrap();
        assert_eq!(list(&conn).unwrap()[0].request_id, "r9");
    }

    #[test]
    fn claiming_a_revoked_tile_starts_a_fresh_conversation() {
        let conn = db();
        tile(&conn, "t1", "s");
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        add_message(&conn, "t1", "m1", "result", "old session", 2000).unwrap();
        revoke(&conn, "t1").unwrap();
        assert!(!list(&conn).unwrap()[0].can_send);
        claim_session(&conn, "t1", "w", "r2", "New topic", 3000, "s").unwrap();
        let sessions = list(&conn).unwrap();
        assert!(sessions[0].can_send);
        assert_eq!(sessions[0].request_id, "r2");
        assert_eq!(sessions[0].created_at, 3000);
        assert!(sessions[0].messages.is_empty());
    }

    #[test]
    fn records_prompts_for_phone_sessions_and_counts_them_towards_the_cap() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 0).unwrap();
        add_prompt(&conn, "t1", "p1", "Do x", 1).unwrap();
        add_message(&conn, "t1", "m1", "result", "done", 2).unwrap();
        add_prompt(&conn, "t1", "p2", "And y", 3).unwrap();
        let kinds: Vec<_> = list(&conn).unwrap()[0]
            .messages
            .iter()
            .map(|m| m.kind.clone())
            .collect();
        assert_eq!(kinds, vec!["prompt", "result", "prompt"]);
        assert_eq!(
            add_prompt(&conn, "elsewhere", "p3", "x", 4).unwrap_err(),
            "This session was not started from your phone."
        );
        assert!(add_prompt(&conn, "t1", "p4", " ", 4)
            .unwrap_err()
            .contains("empty"));
        let long = "x".repeat(MAX_MESSAGE_LENGTH + 1);
        assert!(add_prompt(&conn, "t1", "p5", &long, 4)
            .unwrap_err()
            .contains("20000"));
        for i in 0..MAX_MESSAGES_PER_SESSION {
            add_prompt(&conn, "t1", &format!("q{i}"), "x", 10 + i).unwrap();
        }
        let messages = &list(&conn).unwrap()[0].messages;
        assert_eq!(messages.len() as i64, MAX_MESSAGES_PER_SESSION);
        assert_eq!(MAX_MESSAGES_PER_SESSION, 200);
        assert_eq!(messages[0].id, "q0");
    }

    #[test]
    fn a_prompt_counts_as_activity_for_retention() {
        let conn = db();
        let now = 10 * DAY;
        record_session(&conn, "t1", "w", "r1", "a", now - 5 * DAY).unwrap();
        add_prompt(&conn, "t1", "p1", "b", now - 3 * DAY + 60_000).unwrap();
        assert_eq!(prune(&conn, now, 3 * DAY).unwrap(), 0);
        assert_eq!(prune(&conn, now + 120_000, 3 * DAY).unwrap(), 1);
    }

    #[test]
    fn a_session_that_never_started_can_be_forgotten() {
        let conn = db();
        record_session(&conn, "t1", "w", "r1", "Do x", 1000).unwrap();
        delete(&conn, "t1").unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_laptop_tile_gets_a_thread_named_after_it_on_its_first_message() {
        let conn = db();
        conn.execute(
            "INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at)
             VALUES ('lap', 'w', 'copilot_session', 'Summarise videos', '{}', 'x', 'x'),
                    ('blank', 'w', 'copilot_session', '', '{}', 'x', 'x')",
            [],
        )
        .unwrap();
        open_laptop_thread(&conn, "lap", "w", 10).unwrap();
        open_laptop_thread(&conn, "blank", "w", 11).unwrap();
        let sessions = list(&conn).unwrap();
        let lap = sessions.iter().find(|s| s.tile_id == "lap").unwrap();
        assert_eq!(
            (lap.prompt.as_str(), lap.request_id.as_str(), lap.can_send),
            ("Summarise videos", "laptop-lap-10", true)
        );
        assert_eq!(
            sessions
                .iter()
                .find(|s| s.tile_id == "blank")
                .unwrap()
                .prompt,
            "Copilot session"
        );
        // An existing thread is kept as it is.
        add_message(&conn, "lap", "m1", "result", "x", 12).unwrap();
        open_laptop_thread(&conn, "lap", "w", 20).unwrap();
        assert_eq!(
            list(&conn)
                .unwrap()
                .iter()
                .find(|s| s.tile_id == "lap")
                .unwrap()
                .messages
                .len(),
            1
        );
        // A revoked one starts afresh.
        revoke(&conn, "lap").unwrap();
        open_laptop_thread(&conn, "lap", "w", 30).unwrap();
        let fresh = list(&conn)
            .unwrap()
            .into_iter()
            .find(|s| s.tile_id == "lap")
            .unwrap();
        assert!(fresh.can_send && fresh.messages.is_empty());
        assert_eq!(fresh.created_at, 30);
    }

    #[test]
    fn the_send_ledger_counts_the_agents_sends_of_the_last_hour_whatever_happens_to_the_thread() {
        let conn = db();
        conn.execute(
            "INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at)
             VALUES ('t1', 'w', 'copilot_session', 'T', '{}', 'x', 'x')",
            [],
        )
        .unwrap();
        let now = 10 * HOUR_MS;
        send_from_agent(&conn, "t1", "w", "old", "result", "x", now - HOUR_MS).unwrap();
        add_prompt(&conn, "t1", "p", "x", now - 1).unwrap();
        send_from_agent(&conn, "t1", "w", "a", "progress", "x", now - 59 * 60_000).unwrap();
        send_from_agent(&conn, "t1", "w", "b", "result", "x", now).unwrap();
        assert_eq!(sent_last_hour(&conn, "t1", now).unwrap(), 2);
        assert_eq!(sent_last_hour(&conn, "nobody", now).unwrap(), 0);
        // Replacing and pruning the thread keeps the count.
        revoke(&conn, "t1").unwrap();
        open_laptop_thread(&conn, "t1", "w", now).unwrap();
        prune(&conn, now * 10, 0).unwrap();
        assert_eq!(sent_last_hour(&conn, "t1", now).unwrap(), 2);
        for i in 0..18 {
            send_from_agent(&conn, "t1", "w", &format!("m{i}"), "progress", "x", now).unwrap();
        }
        assert_eq!(
            send_from_agent(&conn, "t1", "w", "over", "result", "x", now),
            Err(SendRefusal::RateLimited(PHONE_HOURLY_CAP))
        );
        assert!(send_from_agent(&conn, "t1", "w", "bad", "question", "x", now + HOUR_MS).is_err());
    }

    #[test]
    fn relinking_updates_the_link_revokes_the_thread_and_bars_the_processes_together() {
        let conn = db();
        tile(&conn, "t1", "s-old");
        record_session(&conn, "t1", "w", "r1", "Do x", 1).unwrap();
        relink_tile(
            &conn,
            "t1",
            r#"{"copilot_session_id":"s-new"}"#,
            Some("New"),
            &["p-old".into()],
        )
        .unwrap();
        assert!(!list(&conn).unwrap()[0].can_send);
        assert!(is_barred(&conn, "t1", "p-old").unwrap());
        let (config, title): (String, String) = conn
            .query_row(
                "SELECT config_json, title FROM tiles WHERE id = 't1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (config.as_str(), title.as_str()),
            (r#"{"copilot_session_id":"s-new"}"#, "New")
        );
        // A claim for the old session now fails: it checks the link under the same lock.
        assert!(claim_session(&conn, "t1", "w", "r2", "Hi", 2, "s-old").is_err());
        assert!(relink_tile(&conn, "gone", "{}", None, &[])
            .unwrap_err()
            .contains("No tile"));
    }

    #[test]
    fn a_resume_may_only_start_the_session_the_tile_is_linked_to() {
        let conn = db();
        tile(&conn, "t1", "s-new");
        check_resume_target(&conn, "t1", "s-new").unwrap();
        assert!(check_resume_target(&conn, "t1", "s-old")
            .unwrap_err()
            .contains("different Copilot session"));
        // A tile not linked yet (a fresh session being linked) may start any.
        conn.execute("UPDATE tiles SET config_json = '{}' WHERE id = 't1'", [])
            .unwrap();
        check_resume_target(&conn, "t1", "s-any").unwrap();
        check_resume_target(&conn, "unknown", "s-any").unwrap();
    }

    #[test]
    fn a_rollback_revokes_only_the_thread_it_claimed() {
        let conn = db();
        record_session(&conn, "t1", "w", "newer", "Do y", 5).unwrap();
        assert!(!revoke_claim(&conn, "t1", "stale").unwrap());
        assert!(list(&conn).unwrap()[0].can_send);
        assert!(revoke_claim(&conn, "t1", "newer").unwrap());
        assert!(!list(&conn).unwrap()[0].can_send);
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

//! Mute all: silences every Inbox source (ADR 045).
//!
//! While muted, nothing new is recorded in the Inbox: PR events, pipeline
//! runs, daily digests, agent messages, schedule notices and sync alerts are
//! dropped, never held. Each writer asks [`is_muted`] before it records; its
//! watermarks still advance, so nothing replays on unmute. A mute can end by
//! itself at a chosen time, checked by the poller and whenever a writer asks.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

const KEY: &str = "inbox_mute";

/// Whether the Inbox is muted, and until when (`None`: until turned off).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct MuteState {
    pub muted: bool,
    pub until: Option<String>,
}

fn stored(db: &Connection) -> Result<MuteState, String> {
    let raw: Option<String> = db
        .query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(raw
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default())
}

fn save(db: &Connection, state: &MuteState) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![KEY, json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The mute as of `now`: a mute whose end has passed is lifted first.
pub fn state_at(db: &Connection, now: DateTime<Utc>) -> Result<MuteState, String> {
    let state = stored(db)?;
    let expired = state.muted
        && state
            .until
            .as_deref()
            .and_then(crate::pipeline_digest::parse_time)
            .is_some_and(|until| until <= now);
    if expired {
        unmute_at(db, now)?;
        return Ok(MuteState::default());
    }
    Ok(state)
}

pub fn state(db: &Connection) -> Result<MuteState, String> {
    state_at(db, Utc::now())
}

/// The one gate every Inbox writer checks before recording.
pub fn is_muted_at(db: &Connection, now: DateTime<Utc>) -> Result<bool, String> {
    Ok(state_at(db, now)?.muted)
}

pub fn is_muted(db: &Connection) -> Result<bool, String> {
    is_muted_at(db, Utc::now())
}

/// Mutes every Inbox source, until turned off or until `until` (RFC 3339, in
/// the future). Entries already in the Inbox are untouched.
pub fn mute_at(
    db: &Connection,
    until: Option<&str>,
    now: DateTime<Utc>,
) -> Result<MuteState, String> {
    let until = match until.map(str::trim).filter(|u| !u.is_empty()) {
        Some(text) => {
            let at = crate::pipeline_digest::parse_time(text).ok_or_else(|| {
                format!("until must be a date and time like 2026-12-01T08:00:00Z; got {text:?}")
            })?;
            if at <= now {
                return Err("until must be in the future".into());
            }
            Some(crate::pipeline_digest::stamp(at))
        }
        None => None,
    };
    let state = MuteState { muted: true, until };
    save(db, &state)?;
    Ok(state)
}

pub fn mute(db: &Connection, until: Option<&str>) -> Result<MuteState, String> {
    mute_at(db, until, Utc::now())
}

/// Turns notifications back on. Nothing from the muted time replays: every
/// pipeline's quiet period and digest window restart now.
pub fn unmute_at(db: &Connection, now: DateTime<Utc>) -> Result<MuteState, String> {
    let was = stored(db)?;
    save(db, &MuteState::default())?;
    if was.muted {
        let at = crate::pipeline_digest::stamp(now);
        db.execute(
            "UPDATE pipeline_watches SET notify_after=?1 WHERE julianday(notify_after) < julianday(?1)",
            [&at],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE pipeline_watches SET digest_since=?1 WHERE mode='daily_failures'",
            [&at],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "UPDATE pipeline_digest_runs SET digest_id='dropped' WHERE digest_id IS NULL",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(MuteState::default())
}

pub fn unmute(db: &Connection) -> Result<MuteState, String> {
    unmute_at(db, Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn
    }

    fn at(text: &str) -> DateTime<Utc> {
        crate::pipeline_digest::parse_time(text).unwrap()
    }

    #[test]
    fn mutes_until_turned_off_or_until_a_time_and_lifts_itself_then() {
        let db = db();
        assert_eq!(state(&db).unwrap(), MuteState::default());
        mute_at(&db, None, at("2026-03-01T10:00:00Z")).unwrap();
        assert!(is_muted_at(&db, at("2030-01-01T00:00:00Z")).unwrap());
        unmute_at(&db, at("2026-03-01T11:00:00Z")).unwrap();
        assert!(!is_muted_at(&db, at("2026-03-01T11:00:00Z")).unwrap());

        let until = mute_at(
            &db,
            Some("2026-03-02T08:00:00Z"),
            at("2026-03-01T22:00:00Z"),
        )
        .unwrap();
        assert_eq!(until.until.as_deref(), Some("2026-03-02T08:00:00.000Z"));
        assert!(is_muted_at(&db, at("2026-03-02T07:59:59Z")).unwrap());
        assert!(!is_muted_at(&db, at("2026-03-02T08:00:00Z")).unwrap());
        assert_eq!(
            stored(&db).unwrap(),
            MuteState::default(),
            "lifted, not just ignored"
        );
    }

    #[test]
    fn refuses_an_end_in_the_past_or_unreadable() {
        let db = db();
        let now = at("2026-03-01T10:00:00Z");
        assert!(mute_at(&db, Some("2026-03-01T09:00:00Z"), now)
            .unwrap_err()
            .contains("future"));
        assert!(mute_at(&db, Some("tomorrow"), now)
            .unwrap_err()
            .contains("date and time"));
        assert!(!is_muted_at(&db, now).unwrap());
    }
}

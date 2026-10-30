//! Sync server monitoring (ADR 040). Checks the shared sync server's `/health`
//! and, with a monitor key, its read-only `/health/vitals`; keeps 24 hours of
//! checks, the open problems and the alert events in SQLite. The alert rules
//! themselves live in TypeScript (`src/domain/sync-monitor.ts`); this side
//! does the network, the storage, and the agent commands.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const KEY_SETTING: &str = "sync_monitor.key";
const THRESHOLDS_SETTING: &str = "sync_monitor.thresholds";
const MUTES_SETTING: &str = "sync_monitor.mutes";
const SERVER_SETTING: &str = "companion.server_url";
const KEEP_MS: i64 = 24 * 60 * 60 * 1000;
/// A health answer slower than this is a bad check even when it succeeds.
pub const HEALTH_TIMEOUT_SECS: u64 = 10;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Check {
    /// Milliseconds since the epoch.
    pub at: i64,
    /// `/health` answered 200.
    pub reachable: bool,
    pub latency_ms: i64,
    pub error: Option<String>,
    /// The vitals, when a monitor key is set and they could be read.
    pub vitals: Option<Value>,
    /// Why vitals are missing despite a key (e.g. "Invalid monitor key").
    pub vitals_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Problem {
    /// "unreachable", "cpu", "memory", "disk", "logins", "doc_size:<doc>", "doc_growth:<doc>".
    pub kind: String,
    /// "critical" or "warning".
    pub severity: String,
    pub started_at: i64,
    pub message: String,
    pub hint: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub kind: String,
    /// "started" or "resolved".
    pub event: String,
    pub at: i64,
    pub message: String,
    pub hint: String,
    #[serde(default)]
    pub is_read: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct State {
    /// A sync server is set up (the companion's server URL).
    pub configured: bool,
    pub server_url: Option<String>,
    pub has_key: bool,
    /// JSON object; empty means the defaults.
    pub thresholds: Value,
    /// Base problem kind → muted until (ms since the epoch).
    pub mutes: std::collections::BTreeMap<String, i64>,
    pub checks: Vec<Check>,
    pub problems: Vec<Problem>,
    pub events: Vec<Event>,
}

/// What the network side does, so tests can stub it.
pub trait Probe {
    /// `/health`: Ok(latency ms) on a 200, Err(message) otherwise.
    fn health(&self, base: &str) -> Result<i64, String>;
    /// `/health/vitals` with the monitor key.
    fn vitals(&self, base: &str, key: &str) -> Result<Value, String>;
}

pub struct HttpProbe;

impl Probe for HttpProbe {
    fn health(&self, base: &str) -> Result<i64, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(HEALTH_TIMEOUT_SECS))
            .build()
            .map_err(|e| e.to_string())?;
        let start = std::time::Instant::now();
        let response = client
            .get(format!("{}/health", base.trim_end_matches('/')))
            .send()
            .map_err(|e| {
                if e.is_timeout() {
                    format!("No answer within {HEALTH_TIMEOUT_SECS} s")
                } else {
                    "Couldn't connect".to_string()
                }
            })?;
        let latency = start.elapsed().as_millis() as i64;
        if !response.status().is_success() {
            return Err(format!("Answered HTTP {}", response.status().as_u16()));
        }
        Ok(latency)
    }

    fn vitals(&self, base: &str, key: &str) -> Result<Value, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(HEALTH_TIMEOUT_SECS))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(format!("{}/health/vitals", base.trim_end_matches('/')))
            .bearer_auth(key)
            .send()
            .map_err(|_| "Couldn't read the vitals".to_string())?;
        match response.status().as_u16() {
            200 => response
                .json()
                .map_err(|_| "The vitals weren't valid JSON".to_string()),
            401 => Err("Invalid monitor key".into()),
            503 => Err("The server has no MONITOR_KEY configured".into()),
            code => Err(format!("Vitals answered HTTP {code}")),
        }
    }
}

// ── Settings ────────────────────────────────────────────────────────────

fn get(db: &Connection, key: &str) -> Result<Option<String>, String> {
    db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

fn set(db: &Connection, key: &str, value: &str) -> Result<(), String> {
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The sync server to watch: the companion's server, if set.
pub fn server_url(db: &Connection) -> Result<Option<String>, String> {
    Ok(get(db, SERVER_SETTING)?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

pub fn monitor_key(db: &Connection) -> Result<Option<String>, String> {
    Ok(get(db, KEY_SETTING)?.filter(|s| !s.trim().is_empty()))
}

pub fn set_monitor_key(db: &Connection, key: &str) -> Result<(), String> {
    set(db, KEY_SETTING, key.trim())
}

pub fn set_thresholds(db: &Connection, thresholds: &Value) -> Result<(), String> {
    if !thresholds.is_object() {
        return Err("Thresholds must be an object".into());
    }
    set(db, THRESHOLDS_SETTING, &thresholds.to_string())
}

fn mutes(db: &Connection) -> Result<std::collections::BTreeMap<String, i64>, String> {
    Ok(get(db, MUTES_SETTING)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

/// The base kind of a problem ("doc_size:abc" → "doc_size").
pub fn base_kind(kind: &str) -> &str {
    kind.split(':').next().unwrap_or(kind)
}

pub const KINDS: [&str; 7] = [
    "unreachable",
    "cpu",
    "memory",
    "disk",
    "logins",
    "doc_size",
    "doc_growth",
];

/// Mutes a problem kind's alerts for `hours` from `now`.
pub fn mute(db: &Connection, kind: &str, hours: u32, now: i64) -> Result<i64, String> {
    let base = base_kind(kind);
    if !KINDS.contains(&base) {
        return Err(format!(
            "Unknown problem kind {kind}; one of {}",
            KINDS.join(", ")
        ));
    }
    if hours == 0 || hours > 24 * 7 {
        return Err("Mute for 1 to 168 hours".into());
    }
    let mut all = mutes(db)?;
    all.retain(|_, until| *until > now);
    let until = now + i64::from(hours) * 3_600_000;
    all.insert(base.to_string(), until);
    set(
        db,
        MUTES_SETTING,
        &serde_json::to_string(&all).map_err(|e| e.to_string())?,
    )?;
    Ok(until)
}

// ── Checks ──────────────────────────────────────────────────────────────

/// Runs one check against a server: `/health`, then the vitals when a key is
/// set and the server answered.
pub fn run_check(probe: &dyn Probe, server: &str, key: Option<&str>, now: i64) -> Check {
    let (reachable, latency_ms, error) = match probe.health(server) {
        Ok(latency) => (true, latency, None),
        Err(e) => (false, 0, Some(e)),
    };
    let (vitals, vitals_error) = match (reachable, key) {
        (true, Some(key)) => match probe.vitals(server, key) {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(e)),
        },
        _ => (None, None),
    };
    Check {
        at: now,
        reachable,
        latency_ms,
        error,
        vitals,
        vitals_error,
    }
}

pub fn store_check(db: &Connection, check: &Check) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO sync_checks (at, reachable, latency_ms, error, vitals, vitals_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            check.at,
            check.reachable,
            check.latency_ms,
            check.error,
            check.vitals.as_ref().map(Value::to_string),
            check.vitals_error,
        ],
    )
    .map_err(|e| e.to_string())?;
    db.execute(
        "DELETE FROM sync_checks WHERE at < ?1",
        [check.at - KEEP_MS],
    )
    .map_err(|e| e.to_string())?;
    // Alerts older than a week are history nobody reads.
    db.execute(
        "DELETE FROM sync_events WHERE at < ?1",
        [check.at - 7 * KEEP_MS],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn checks_since(db: &Connection, since: i64) -> Result<Vec<Check>, String> {
    let mut stmt = db
        .prepare("SELECT at, reachable, latency_ms, error, vitals, vitals_error FROM sync_checks WHERE at >= ?1 ORDER BY at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([since], |r| {
            let vitals: Option<String> = r.get(4)?;
            Ok(Check {
                at: r.get(0)?,
                reachable: r.get(1)?,
                latency_ms: r.get(2)?,
                error: r.get(3)?,
                vitals: vitals.and_then(|v| serde_json::from_str(&v).ok()),
                vitals_error: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

// ── Problems and events ─────────────────────────────────────────────────

pub fn problems(db: &Connection) -> Result<Vec<Problem>, String> {
    let mut stmt = db
        .prepare("SELECT kind, severity, started_at, message, hint FROM sync_problems ORDER BY started_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Problem {
                kind: r.get(0)?,
                severity: r.get(1)?,
                started_at: r.get(2)?,
                message: r.get(3)?,
                hint: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn events(db: &Connection, limit: u32) -> Result<Vec<Event>, String> {
    let mut stmt = db
        .prepare("SELECT id, kind, event, at, message, hint, is_read FROM sync_events ORDER BY at DESC, id DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(Event {
                id: r.get(0)?,
                kind: r.get(1)?,
                event: r.get(2)?,
                at: r.get(3)?,
                message: r.get(4)?,
                hint: r.get(5)?,
                is_read: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Replaces the open problems and records new events, in one transaction.
/// An event id that exists already is ignored, so applying twice is harmless.
/// Returns the ids actually recorded, the only ones worth notifying.
pub fn apply(
    db: &mut Connection,
    open: &[Problem],
    new_events: &[Event],
) -> Result<Vec<String>, String> {
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sync_problems", [])
        .map_err(|e| e.to_string())?;
    for p in open {
        tx.execute(
            "INSERT INTO sync_problems (kind, severity, started_at, message, hint) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![p.kind, p.severity, p.started_at, p.message, p.hint],
        )
        .map_err(|e| e.to_string())?;
    }
    // Mutes are read inside the transaction, so one set while the
    // evaluation ran (by an agent) still suppresses the alert.
    let mutes: std::collections::BTreeMap<String, i64> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [MUTES_SETTING],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut inserted = Vec::new();
    for e in new_events {
        if mutes
            .get(base_kind(&e.kind))
            .is_some_and(|until| *until > e.at)
        {
            continue;
        }
        let added = tx
            .execute(
                "INSERT OR IGNORE INTO sync_events (id, kind, event, at, message, hint, is_read) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![e.id, e.kind, e.event, e.at, e.message, e.hint],
            )
            .map_err(|e| e.to_string())?;
        if added > 0 {
            inserted.push(e.id.clone());
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

pub fn set_read(db: &Connection, id: &str, is_read: bool) -> Result<(), String> {
    db.execute(
        "UPDATE sync_events SET is_read = ?2 WHERE id = ?1",
        params![id, is_read],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn state(db: &Connection, now: i64) -> Result<State, String> {
    let server_url = server_url(db)?;
    let mut active_mutes = mutes(db)?;
    active_mutes.retain(|_, until| *until > now);
    Ok(State {
        configured: server_url.is_some(),
        server_url,
        has_key: monitor_key(db)?.is_some(),
        thresholds: get(db, THRESHOLDS_SETTING)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| Value::Object(Default::default())),
        mutes: active_mutes,
        checks: checks_since(db, now - KEEP_MS)?,
        problems: problems(db)?,
        events: events(db, 100)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    struct Stub {
        health: RefCell<Result<i64, String>>,
        vitals: RefCell<Result<Value, String>>,
        calls: RefCell<Vec<String>>,
    }

    impl Probe for Stub {
        fn health(&self, base: &str) -> Result<i64, String> {
            self.calls.borrow_mut().push(format!("health {base}"));
            self.health.borrow().clone()
        }
        fn vitals(&self, base: &str, key: &str) -> Result<Value, String> {
            self.calls.borrow_mut().push(format!("vitals {base} {key}"));
            self.vitals.borrow().clone()
        }
    }

    fn stub() -> Stub {
        Stub {
            health: RefCell::new(Ok(90)),
            vitals: RefCell::new(Ok(json!({"box": {"cpuPercent": 2.0}}))),
            calls: RefCell::default(),
        }
    }

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        db
    }

    #[test]
    fn a_check_reads_vitals_only_with_a_key_and_a_reachable_server() {
        let s = stub();
        let c = run_check(&s, "https://sync.example", None, 1000);
        assert_eq!(
            (c.reachable, c.latency_ms, c.vitals.is_none()),
            (true, 90, true)
        );
        let c = run_check(&s, "https://sync.example", Some("k"), 2000);
        assert_eq!(c.vitals.unwrap()["box"]["cpuPercent"], 2.0);
        *s.health.borrow_mut() = Err("No answer within 10 s".into());
        let c = run_check(&s, "https://sync.example", Some("k"), 3000);
        assert_eq!(
            (c.reachable, c.error.as_deref(), c.vitals.is_none()),
            (false, Some("No answer within 10 s"), true)
        );
        assert_eq!(
            s.calls
                .borrow()
                .iter()
                .filter(|c| c.starts_with("vitals"))
                .count(),
            1
        );
        *s.health.borrow_mut() = Ok(50);
        *s.vitals.borrow_mut() = Err("Invalid monitor key".into());
        let c = run_check(&s, "https://sync.example", Some("bad"), 4000);
        assert_eq!(c.vitals_error.as_deref(), Some("Invalid monitor key"));
    }

    #[test]
    fn keeps_24_hours_of_checks_and_reads_them_back() {
        let db = db();
        let s = stub();
        let hour = 3_600_000;
        for i in 0..30 {
            store_check(&db, &run_check(&s, "u", Some("k"), i * hour)).unwrap();
        }
        let kept = checks_since(&db, 0).unwrap();
        assert_eq!(
            kept.first().unwrap().at,
            5 * hour,
            "older than 24 h are dropped"
        );
        assert_eq!(kept.len(), 25);
        assert_eq!(kept[0].vitals.as_ref().unwrap()["box"]["cpuPercent"], 2.0);
    }

    #[test]
    fn problems_and_events_are_applied_together_and_once() {
        let mut db = db();
        let p = Problem {
            kind: "cpu".into(),
            severity: "critical".into(),
            started_at: 5,
            message: "CPU 92%".into(),
            hint: "h".into(),
        };
        let e = Event {
            id: "cpu-5-started".into(),
            kind: "cpu".into(),
            event: "started".into(),
            at: 5,
            message: "CPU 92%".into(),
            hint: "h".into(),
            is_read: false,
        };
        assert_eq!(
            apply(&mut db, std::slice::from_ref(&p), std::slice::from_ref(&e)).unwrap(),
            vec!["cpu-5-started".to_string()]
        );
        assert!(
            apply(&mut db, std::slice::from_ref(&p), std::slice::from_ref(&e))
                .unwrap()
                .is_empty(),
            "nothing new to notify"
        );
        assert_eq!(problems(&db).unwrap(), vec![p]);
        assert_eq!(events(&db, 10).unwrap(), vec![e]);
        set_read(&db, "cpu-5-started", true).unwrap();
        // A mute set while an evaluation ran still wins.
        mute(&db, "disk", 24, 0).unwrap();
        let disk = Event {
            id: "disk-9-started".into(),
            kind: "disk".into(),
            event: "started".into(),
            at: 9,
            message: "m".into(),
            hint: "h".into(),
            is_read: false,
        };
        assert!(apply(&mut db, &[], std::slice::from_ref(&disk))
            .unwrap()
            .is_empty());
        assert_eq!(events(&db, 10).unwrap().len(), 1);
        assert!(events(&db, 10).unwrap()[0].is_read);
        apply(&mut db, &[], &[]).unwrap();
        assert!(problems(&db).unwrap().is_empty());
    }

    #[test]
    fn state_reports_the_server_key_thresholds_and_live_mutes() {
        let db = db();
        let now = 10_000_000;
        assert!(
            !state(&db, now).unwrap().configured,
            "no checks without a server"
        );
        set(&db, SERVER_SETTING, "https://sync.stormlab.app").unwrap();
        set_monitor_key(&db, " secret ").unwrap();
        set_thresholds(&db, &json!({"cpuPercent": 90})).unwrap();
        assert!(set_thresholds(&db, &json!(5)).is_err());
        mute(&db, "doc_size:abc", 24, now).unwrap();
        assert!(mute(&db, "weather", 24, now)
            .unwrap_err()
            .contains("Unknown problem kind"));
        assert!(mute(&db, "cpu", 0, now).is_err());
        let st = state(&db, now).unwrap();
        assert_eq!(st.server_url.as_deref(), Some("https://sync.stormlab.app"));
        assert!(st.has_key);
        assert_eq!(monitor_key(&db).unwrap().as_deref(), Some("secret"));
        assert_eq!(st.thresholds["cpuPercent"], 90);
        assert_eq!(st.mutes.get("doc_size"), Some(&(now + 24 * 3_600_000)));
        assert!(
            state(&db, now + 25 * 3_600_000).unwrap().mutes.is_empty(),
            "expired mutes are gone"
        );
    }
}

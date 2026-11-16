//! The learning job ledger and its worker (ADR 042).
//!
//! A check is recorded first, then run by one worker thread *without* holding
//! the database lock (a Serde build takes up to two minutes). A job is keyed by
//! the id of the attempt it grades, so a retried request returns the same job
//! instead of running twice. A job that was running when the app stopped is
//! marked interrupted on the next start; it is never rerun on its own.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::learning_runner::{CheckResult, Harness, Limits};

/// A request to check one answer, as the phone (or an agent) sends it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CheckRequest {
    /// The attempt id; the job's id.
    pub id: String,
    #[serde(default)]
    pub card_id: String,
    #[serde(default)]
    pub card_version: String,
    pub harness: Harness,
    pub source: String,
    /// The toolchain this content version needs, e.g. "1.98.0".
    #[serde(default)]
    pub toolchain: Option<String>,
}

impl CheckRequest {
    /// Identifies the request's content, so a reused id with other content is caught.
    pub fn hash(&self) -> String {
        let canonical = serde_json::to_string(self).unwrap_or_default();
        hex(&Sha256::digest(canonical.as_bytes()))
    }
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Job {
    pub id: String,
    pub card_id: String,
    pub card_version: String,
    /// queued | running | finished | interrupted
    pub status: String,
    pub origin: String,
    pub result: Option<CheckResult>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

pub fn init_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS learning_jobs (
            id TEXT PRIMARY KEY,
            request_hash TEXT NOT NULL,
            request_json TEXT NOT NULL,
            card_id TEXT NOT NULL,
            card_version TEXT NOT NULL,
            origin TEXT NOT NULL,
            status TEXT NOT NULL,
            result_json TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS learning_jobs_status_idx ON learning_jobs (status, created_at);",
    )
}

/// Records a check, or returns the job already recorded for this id. The same
/// id with different content is refused.
pub fn enqueue(db: &Connection, request: &CheckRequest, origin: &str) -> Result<Job, String> {
    let hash = request.hash();
    let existing: Option<String> = db
        .query_row(
            "SELECT request_hash FROM learning_jobs WHERE id=?1",
            [&request.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some(stored) if stored != hash => {
            return Err(format!(
                "Job {} already exists with different content",
                request.id
            ));
        }
        Some(_) => {}
        None => {
            let json = serde_json::to_string(request).map_err(|e| e.to_string())?;
            db.execute(
                "INSERT INTO learning_jobs (id, request_hash, request_json, card_id, card_version, origin, status, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', NOW)".replace("NOW", NOW).as_str(),
                params![request.id, hash, json, request.card_id, request.card_version, origin],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    get(db, &request.id)?.ok_or_else(|| "The job was not recorded".to_string())
}

/// The oldest queued job, now marked running, with its request.
pub fn claim_next(db: &Connection) -> Result<Option<(Job, CheckRequest)>, String> {
    let next: Option<(String, String)> = db
        .query_row(
            "SELECT id, request_json FROM learning_jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, json)) = next else {
        return Ok(None);
    };
    db.execute(
        &"UPDATE learning_jobs SET status='running', started_at=NOW WHERE id=?1"
            .replace("NOW", NOW),
        [&id],
    )
    .map_err(|e| e.to_string())?;
    let request: CheckRequest = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let job = get(db, &id)?.ok_or_else(|| "The job disappeared".to_string())?;
    Ok(Some((job, request)))
}

pub fn finish(db: &Connection, id: &str, result: &CheckResult) -> Result<(), String> {
    let json = serde_json::to_string(result).map_err(|e| e.to_string())?;
    db.execute(
        &"UPDATE learning_jobs SET status='finished', result_json=?2, finished_at=NOW WHERE id=?1"
            .replace("NOW", NOW),
        params![id, json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Jobs left running by a previous run of the app. Returns how many.
pub fn interrupt_running(db: &Connection) -> Result<usize, String> {
    db.execute(
        &"UPDATE learning_jobs SET status='interrupted', finished_at=NOW WHERE status='running'"
            .replace("NOW", NOW),
        [],
    )
    .map_err(|e| e.to_string())
}

pub fn get(db: &Connection, id: &str) -> Result<Option<Job>, String> {
    db.query_row(&format!("{SELECT} WHERE id=?1"), [id], row_to_job)
        .optional()
        .map_err(|e| e.to_string())
}

const SELECT: &str = "SELECT id, card_id, card_version, status, origin, result_json, created_at, finished_at FROM learning_jobs";

fn row_to_job(r: &rusqlite::Row) -> rusqlite::Result<Job> {
    let result: Option<String> = r.get(5)?;
    Ok(Job {
        id: r.get(0)?,
        card_id: r.get(1)?,
        card_version: r.get(2)?,
        status: r.get(3)?,
        origin: r.get(4)?,
        result: result.and_then(|json| serde_json::from_str(&json).ok()),
        created_at: r.get(6)?,
        finished_at: r.get(7)?,
    })
}

/// The most recent jobs, newest first.
pub fn list(db: &Connection, limit: usize) -> Result<Vec<Job>, String> {
    let mut stmt = db
        .prepare(&format!(
            "{SELECT} ORDER BY created_at DESC, rowid DESC LIMIT ?1"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], row_to_job)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Runs queued jobs one at a time until dropped.
pub struct LearningWorker {
    _stop: std::sync::mpsc::Sender<()>,
}

impl LearningWorker {
    pub fn start(db: std::sync::Arc<std::sync::Mutex<Connection>>) -> Self {
        if let Ok(conn) = db.lock() {
            if let Err(error) = interrupt_running(&conn) {
                eprintln!("[learning] Could not mark interrupted jobs: {error}");
            }
        }
        Self::start_with(
            db,
            std::env::temp_dir().join("workstreams-learning"),
            Limits::default(),
            crate::shell_env::resolved_path(&crate::pty::default_shell()),
            std::time::Duration::from_millis(500),
            Box::new(|_| {}),
        )
    }

    pub fn start_with(
        db: std::sync::Arc<std::sync::Mutex<Connection>>,
        root: std::path::PathBuf,
        limits: Limits,
        path: Option<String>,
        poll: std::time::Duration,
        on_finished: Box<dyn Fn(&Job) + Send>,
    ) -> Self {
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || loop {
            // The lock is held only to claim and to record, never while compiling.
            let claimed = db
                .lock()
                .map_err(|e| e.to_string())
                .and_then(|conn| claim_next(&conn));
            match claimed {
                Ok(Some((job, request))) => {
                    let limits = Limits {
                        toolchain: request
                            .toolchain
                            .clone()
                            .or_else(|| limits.toolchain.clone()),
                        ..limits.clone()
                    };
                    let result = crate::learning_runner::run_check(
                        &request.harness,
                        &request.source,
                        &root,
                        &limits,
                        path.as_deref(),
                    );
                    let finished = db.lock().map_err(|e| e.to_string()).and_then(|conn| {
                        finish(&conn, &job.id, &result)?;
                        get(&conn, &job.id)
                    });
                    match finished {
                        Ok(Some(job)) => on_finished(&job),
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!("[learning] Could not record job {}: {error}", job.id)
                        }
                    }
                    continue;
                }
                Ok(None) => {}
                Err(error) => eprintln!("[learning] Could not read the job queue: {error}"),
            }
            if !matches!(
                stopped.recv_timeout(poll),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                break;
            }
        });
        Self { _stop: stop }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::learning_runner::TestCase;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn
    }

    fn request(id: &str, source: &str) -> CheckRequest {
        CheckRequest {
            id: id.into(),
            card_id: "even".into(),
            card_version: "2".into(),
            harness: Harness {
                cases: Some(vec![TestCase {
                    name: "even_numbers".into(),
                    body: "assert!(is_even(2)); assert!(!is_even(3));".into(),
                }]),
                ..Default::default()
            },
            source: source.into(),
            toolchain: None,
        }
    }

    #[test]
    fn a_request_is_recorded_once_and_a_reused_id_with_other_content_is_refused() {
        let db = db();
        let first = enqueue(&db, &request("a1", "x"), "agent").unwrap();
        assert_eq!(
            (first.status.as_str(), first.card_version.as_str()),
            ("queued", "2")
        );
        let again = enqueue(&db, &request("a1", "x"), "phone").unwrap();
        assert_eq!(again, first, "a retried request is the same job");
        assert!(enqueue(&db, &request("a1", "y"), "agent")
            .unwrap_err()
            .contains("different content"));
    }

    #[test]
    fn jobs_are_claimed_oldest_first_and_finished_with_their_result() {
        let db = db();
        enqueue(&db, &request("a1", "one"), "agent").unwrap();
        enqueue(&db, &request("a2", "two"), "agent").unwrap();
        let (job, req) = claim_next(&db).unwrap().unwrap();
        assert_eq!(
            (job.id.as_str(), job.status.as_str(), req.source.as_str()),
            ("a1", "running", "one")
        );
        let result = CheckResult {
            status: "passed".into(),
            output: "ok".into(),
            toolchain: "rustc".into(),
            tests: None,
            constraints: None,
        };
        finish(&db, "a1", &result).unwrap();
        let done = get(&db, "a1").unwrap().unwrap();
        assert_eq!(
            (done.status.as_str(), done.result),
            ("finished", Some(result))
        );
        assert_eq!(claim_next(&db).unwrap().unwrap().0.id, "a2");
        assert!(claim_next(&db).unwrap().is_none());
        assert_eq!(
            list(&db, 10)
                .unwrap()
                .iter()
                .map(|j| j.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a2", "a1"]
        );
    }

    #[test]
    fn a_job_running_when_the_app_stopped_is_interrupted_not_rerun() {
        let db = db();
        enqueue(&db, &request("a1", "x"), "agent").unwrap();
        claim_next(&db).unwrap();
        assert_eq!(interrupt_running(&db).unwrap(), 1);
        assert_eq!(get(&db, "a1").unwrap().unwrap().status, "interrupted");
        assert!(claim_next(&db).unwrap().is_none());
    }

    #[test]
    fn the_worker_runs_a_queued_check_with_the_real_compiler() {
        if std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let shared = std::sync::Arc::new(std::sync::Mutex::new(db()));
        enqueue(
            &shared.lock().unwrap(),
            &request("w1", "pub fn is_even(n: i32) -> bool { n % 2 == 0 }"),
            "agent",
        )
        .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let root =
            std::env::temp_dir().join(format!("ws-learning-worker-{}", uuid::Uuid::new_v4()));
        let _worker = LearningWorker::start_with(
            shared.clone(),
            root.clone(),
            Limits {
                toolchain: None,
                ..Default::default()
            },
            None,
            std::time::Duration::from_millis(20),
            Box::new(move |job| {
                let _ = tx.send(job.clone());
            }),
        );
        let job = rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("the worker finished the job");
        assert_eq!(job.id, "w1");
        assert_eq!(job.result.unwrap().status, "passed");
        assert_eq!(
            get(&shared.lock().unwrap(), "w1").unwrap().unwrap().status,
            "finished"
        );
        std::fs::remove_dir_all(root).ok();
    }
}

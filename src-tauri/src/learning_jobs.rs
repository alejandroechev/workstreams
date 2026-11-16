//! The learning job ledger and its worker (ADR 042).
//!
//! A job (an answer check, or a tutor help request) is recorded first, then run by one worker thread *without* holding
//! the database lock (a Serde build takes up to two minutes). A job is keyed by
//! the id of the attempt it grades, so a retried request returns the same job
//! instead of running twice. A job that was running when the app stopped is
//! marked interrupted on the next start; it is never rerun on its own.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::learning_ai::{Assistant, HelpRequest};
use crate::learning_packs::PackRequest;
use crate::learning_runner::{Harness, Limits};

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

/// What a job does: check an answer, answer a help request, or draft and
/// validate a pack.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JobRequest {
    Check(CheckRequest),
    Help(HelpRequest),
    Pack(PackRequest),
}

impl JobRequest {
    pub fn id(&self) -> &str {
        match self {
            JobRequest::Check(r) => &r.id,
            JobRequest::Help(r) => &r.id,
            JobRequest::Pack(r) => &r.id,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            JobRequest::Check(_) => "check",
            JobRequest::Help(_) => "help",
            JobRequest::Pack(_) => "pack",
        }
    }
    fn card(&self) -> (String, String) {
        match self {
            JobRequest::Check(r) => (r.card_id.clone(), r.card_version.clone()),
            JobRequest::Help(r) => (r.card_id.clone(), r.card_version.clone()),
            // Listed under the pack it drafts.
            JobRequest::Pack(r) => (
                if r.pack_id.is_empty() {
                    crate::learning_packs::pack_id_for(&r.topic)
                } else {
                    r.pack_id.clone()
                },
                String::new(),
            ),
        }
    }
    fn hash(&self) -> String {
        match self {
            // Keeps the hash of checks recorded before job kinds.
            JobRequest::Check(r) => r.hash(),
            JobRequest::Help(r) => hex(&Sha256::digest(
                serde_json::to_string(r).unwrap_or_default().as_bytes(),
            )),
            JobRequest::Pack(r) => hex(&Sha256::digest(
                serde_json::to_string(r).unwrap_or_default().as_bytes(),
            )),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Job {
    pub id: String,
    /// check | help | pack
    pub kind: String,
    pub card_id: String,
    pub card_version: String,
    /// queued | running | finished | interrupted
    pub status: String,
    pub origin: String,
    /// A check's `CheckResult`, or help's `{reply, error}`.
    pub result: Option<serde_json::Value>,
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
    )?;
    let has_kind: bool = db.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('learning_jobs') WHERE name='kind'",
        [],
        |r| r.get::<_, i64>(0).map(|n| n > 0),
    )?;
    if !has_kind {
        db.execute(
            "ALTER TABLE learning_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'check'",
            [],
        )?;
    }
    Ok(())
}

/// Records a job, or returns the job already recorded for this id. The same
/// id with different content is refused.
pub fn enqueue(db: &Connection, request: &JobRequest, origin: &str) -> Result<Job, String> {
    let hash = request.hash();
    let id = request.id();
    let (card_id, card_version) = request.card();
    let existing: Option<String> = db
        .query_row(
            "SELECT request_hash FROM learning_jobs WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some(stored) if stored != hash => {
            return Err(format!("Job {id} already exists with different content"));
        }
        Some(_) => {}
        None => {
            let json = serde_json::to_string(request).map_err(|e| e.to_string())?;
            db.execute(
                "INSERT INTO learning_jobs (id, request_hash, request_json, card_id, card_version, origin, status, created_at, kind)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', NOW, ?7)".replace("NOW", NOW).as_str(),
                params![id, hash, json, card_id, card_version, origin, request.kind()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    get(db, id)?.ok_or_else(|| "The job was not recorded".to_string())
}

/// Queues a job the Rust Pocket relay received (already verified and fresh).
pub fn enqueue_json(db: &Connection, request: serde_json::Value) -> Result<Job, String> {
    let request: JobRequest =
        serde_json::from_value(request).map_err(|e| format!("Not a learning job: {e}"))?;
    enqueue(db, &request, "phone")
}

/// The oldest queued job, now marked running, with its request.
pub fn claim_next(db: &Connection) -> Result<Option<(Job, JobRequest)>, String> {
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
    // Rows from before job kinds hold a bare check.
    let request: JobRequest = serde_json::from_str(&json)
        .or_else(|_| serde_json::from_str::<CheckRequest>(&json).map(JobRequest::Check))
        .map_err(|e| e.to_string())?;
    let job = get(db, &id)?.ok_or_else(|| "The job disappeared".to_string())?;
    Ok(Some((job, request)))
}

pub fn finish(db: &Connection, id: &str, result: &serde_json::Value) -> Result<(), String> {
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

const SELECT: &str = "SELECT id, card_id, card_version, status, origin, result_json, created_at, finished_at, kind FROM learning_jobs";

fn row_to_job(r: &rusqlite::Row) -> rusqlite::Result<Job> {
    let result: Option<String> = r.get(5)?;
    Ok(Job {
        id: r.get(0)?,
        kind: r.get(8)?,
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
        let path = crate::shell_env::resolved_path(&crate::pty::default_shell());
        Self::start_with(
            db,
            std::env::temp_dir().join("workstreams-learning"),
            Limits::default(),
            path.clone(),
            std::sync::Arc::new(crate::learning_ai::CopilotCli {
                program: "copilot".into(),
                path,
                root: std::env::temp_dir().join("workstreams-learning").join("ai"),
                timeout_ms: 90_000,
            }),
            std::time::Duration::from_millis(500),
            Box::new(|_| {}),
        )
    }

    pub fn start_with(
        db: std::sync::Arc<std::sync::Mutex<Connection>>,
        root: std::path::PathBuf,
        limits: Limits,
        path: Option<String>,
        assistant: std::sync::Arc<dyn Assistant>,
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
                    let result = match &request {
                        JobRequest::Check(request) => {
                            let limits = Limits {
                                toolchain: request
                                    .toolchain
                                    .clone()
                                    .or_else(|| limits.toolchain.clone()),
                                ..limits.clone()
                            };
                            serde_json::to_value(crate::learning_runner::run_check(
                                &request.harness,
                                &request.source,
                                &root,
                                &limits,
                                path.as_deref(),
                            ))
                        }
                        JobRequest::Help(request) => serde_json::to_value(
                            crate::learning_ai::help(assistant.as_ref(), request),
                        ),
                        JobRequest::Pack(request) => {
                            let limits = Limits {
                                toolchain: request
                                    .toolchain
                                    .clone()
                                    .or_else(|| limits.toolchain.clone()),
                                ..limits.clone()
                            };
                            let check = |harness: &Harness, source: &str| {
                                crate::learning_runner::run_check(
                                    harness,
                                    source,
                                    &root,
                                    &limits,
                                    path.as_deref(),
                                )
                            };
                            Ok(crate::learning_packs::generate(
                                assistant.as_ref(),
                                request,
                                &check,
                            ))
                        }
                    }
                    .unwrap_or_default();
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
    use crate::learning_runner::{CheckResult, TestCase};

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

    fn check(id: &str, source: &str) -> JobRequest {
        JobRequest::Check(request(id, source))
    }

    #[test]
    fn a_request_is_recorded_once_and_a_reused_id_with_other_content_is_refused() {
        let db = db();
        let first = enqueue(&db, &check("a1", "x"), "agent").unwrap();
        assert_eq!(
            (
                first.status.as_str(),
                first.card_version.as_str(),
                first.kind.as_str()
            ),
            ("queued", "2", "check")
        );
        let again = enqueue(&db, &check("a1", "x"), "phone").unwrap();
        assert_eq!(again, first, "a retried request is the same job");
        assert!(enqueue(&db, &check("a1", "y"), "agent")
            .unwrap_err()
            .contains("different content"));
    }

    #[test]
    fn a_relayed_job_arrives_as_json_and_is_queued_from_the_phone() {
        let db = db();
        let job = enqueue_json(
            &db,
            serde_json::json!({
                "kind": "check", "id": "p1", "card_id": "even", "card_version": "2",
                "harness": {"tests": "assert!(is_even(2));"}, "source": "x"
            }),
        )
        .unwrap();
        assert_eq!(
            (job.id.as_str(), job.kind.as_str(), job.origin.as_str()),
            ("p1", "check", "phone")
        );
        assert!(
            enqueue_json(&db, serde_json::json!({"kind": "status", "id": "p2"}))
                .unwrap_err()
                .starts_with("Not a learning job")
        );
    }

    #[test]
    fn jobs_are_claimed_oldest_first_and_finished_with_their_result() {
        let db = db();
        enqueue(&db, &check("a1", "one"), "agent").unwrap();
        enqueue(&db, &check("a2", "two"), "agent").unwrap();
        let (job, req) = claim_next(&db).unwrap().unwrap();
        let JobRequest::Check(req) = req else {
            panic!("a check")
        };
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
        let result = serde_json::to_value(&result).unwrap();
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
        enqueue(&db, &check("a1", "x"), "agent").unwrap();
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
            &check("w1", "pub fn is_even(n: i32) -> bool { n % 2 == 0 }"),
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
            std::sync::Arc::new(crate::learning_ai::tests::Recorder {
                prompts: Default::default(),
                answer: Ok("unused".into()),
            }),
            std::time::Duration::from_millis(20),
            Box::new(move |job| {
                let _ = tx.send(job.clone());
            }),
        );
        let job = rx
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("the worker finished the job");
        assert_eq!(job.id, "w1");
        assert_eq!(job.result.unwrap()["status"], "passed");
        assert_eq!(
            get(&shared.lock().unwrap(), "w1").unwrap().unwrap().status,
            "finished"
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn the_worker_answers_help_through_the_assistant() {
        let shared = std::sync::Arc::new(std::sync::Mutex::new(db()));
        let help = crate::learning_ai::HelpRequest {
            id: "h1".into(),
            card_id: "borrow".into(),
            card_version: "1".into(),
            level: "nudge".into(),
            exercise: serde_json::json!({"prompt": "Borrow it"}),
            source: "&name".into(),
            summary: String::new(),
            diagnostic: String::new(),
        };
        let job = enqueue(&shared.lock().unwrap(), &JobRequest::Help(help), "phone").unwrap();
        assert_eq!(job.kind, "help");
        let assistant = std::sync::Arc::new(crate::learning_ai::tests::Recorder {
            prompts: Default::default(),
            answer: Ok("What does len take?".into()),
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let _worker = LearningWorker::start_with(
            shared.clone(),
            std::env::temp_dir().join("ws-learning-help"),
            Limits {
                toolchain: None,
                ..Default::default()
            },
            None,
            assistant.clone(),
            std::time::Duration::from_millis(20),
            Box::new(move |job| {
                let _ = tx.send(job.clone());
            }),
        );
        let done = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(
            done.result.unwrap(),
            serde_json::json!({"reply": "What does len take?", "error": null})
        );
        assert!(assistant.prompts.lock().unwrap()[0].contains("Borrow it"));
    }

    #[test]
    fn the_worker_drafts_and_validates_a_pack() {
        if std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let shared = std::sync::Arc::new(std::sync::Mutex::new(db()));
        let request = crate::learning_packs::PackRequest {
            id: "g1".into(),
            topic: "slices".into(),
            pack_id: String::new(),
            previous: None,
            notes: String::new(),
            toolchain: None,
        };
        let job = enqueue(&shared.lock().unwrap(), &JobRequest::Pack(request), "phone").unwrap();
        assert_eq!(
            (job.kind.as_str(), job.card_id.as_str()),
            ("pack", "pack-slices")
        );
        let draft = serde_json::json!({"title": "Slices", "cards": [{"slug": "first", "kind": "write",
            "solution": "pub fn first(v: &[i32]) -> i32 { v[0] }", "wrong": "pub fn first(v: &[i32]) -> i32 { v[1] }",
            "harness": {"cases": [{"name": "first_of_two", "body": "assert_eq!(first(&[3, 4]), 3);"}]}}]});
        let assistant = std::sync::Arc::new(crate::learning_ai::tests::Recorder {
            prompts: Default::default(),
            answer: Ok(draft.to_string()),
        });
        let (tx, rx) = std::sync::mpsc::channel();
        let root = std::env::temp_dir().join(format!("ws-learning-pack-{}", uuid::Uuid::new_v4()));
        let _worker = LearningWorker::start_with(
            shared.clone(),
            root.clone(),
            Limits {
                toolchain: None,
                ..Default::default()
            },
            None,
            assistant,
            std::time::Duration::from_millis(20),
            Box::new(move |job| {
                let _ = tx.send(job.clone());
            }),
        );
        let done = rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap();
        let result = done.result.unwrap();
        assert_eq!(result["valid"], true, "{result}");
        assert_eq!(result["pack"]["cards"][0]["id"], "pack-slices/first");
        std::fs::remove_dir_all(root).ok();
    }
}

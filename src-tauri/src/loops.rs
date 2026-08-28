use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use uuid::Uuid;

use crate::loop_agent::{
    AgentRequest, AgentResponse, AgentRole, AgentRuntimeEvent, LoopAgentRuntime,
};
use crate::loop_verifier::{run_verifier, VerificationResult, VerificationStatus, VerifierConfig};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopSpecInput {
    pub orchestrator_prompt: String,
    pub worker_prompt: String,
    pub evaluator_prompt: String,
    pub orchestrator_model: Option<String>,
    pub worker_model: Option<String>,
    pub evaluator_model: Option<String>,
    pub verifier_program: Option<String>,
    pub verifier_args: Vec<String>,
    pub verifier_cwd: Option<String>,
    pub run_timeout_seconds: u64,
    pub max_task_iterations: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopSpec {
    pub id: String,
    pub workstream_id: String,
    pub orchestrator_prompt: String,
    pub worker_prompt: String,
    pub evaluator_prompt: String,
    pub orchestrator_model: Option<String>,
    pub worker_model: Option<String>,
    pub evaluator_model: Option<String>,
    pub verifier_program: Option<String>,
    pub verifier_args: Vec<String>,
    pub verifier_cwd: Option<String>,
    pub run_timeout_seconds: u64,
    pub max_task_iterations: u32,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopRunState {
    Starting,
    Orchestrating,
    Working,
    Verifying,
    Evaluating,
    Paused,
    Stopping,
    Completed,
    Attention,
    Killed,
}

impl LoopRunState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Orchestrating => "orchestrating",
            Self::Working => "working",
            Self::Verifying => "verifying",
            Self::Evaluating => "evaluating",
            Self::Paused => "paused",
            Self::Stopping => "stopping",
            Self::Completed => "completed",
            Self::Attention => "attention",
            Self::Killed => "killed",
        }
    }

    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "starting" => Ok(Self::Starting),
            "orchestrating" => Ok(Self::Orchestrating),
            "working" => Ok(Self::Working),
            "verifying" => Ok(Self::Verifying),
            "evaluating" => Ok(Self::Evaluating),
            "paused" => Ok(Self::Paused),
            "stopping" => Ok(Self::Stopping),
            "completed" => Ok(Self::Completed),
            "attention" => Ok(Self::Attention),
            "killed" => Ok(Self::Killed),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown loop run state: {other}").into(),
            )),
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Attention | Self::Killed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopRun {
    pub id: String,
    pub loop_spec_id: String,
    pub state: LoopRunState,
    pub current_task_id: Option<String>,
    pub control_requested: String,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub deadline_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopTaskState {
    Queued,
    Working,
    Verifying,
    Evaluating,
    Accepted,
    Blocked,
    Attention,
    Interrupted,
}

impl LoopTaskState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Working => "working",
            Self::Verifying => "verifying",
            Self::Evaluating => "evaluating",
            Self::Accepted => "accepted",
            Self::Blocked => "blocked",
            Self::Attention => "attention",
            Self::Interrupted => "interrupted",
        }
    }

    fn parse(value: &str) -> rusqlite::Result<Self> {
        match value {
            "queued" => Ok(Self::Queued),
            "working" => Ok(Self::Working),
            "verifying" => Ok(Self::Verifying),
            "evaluating" => Ok(Self::Evaluating),
            "accepted" => Ok(Self::Accepted),
            "blocked" => Ok(Self::Blocked),
            "attention" => Ok(Self::Attention),
            "interrupted" => Ok(Self::Interrupted),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown loop task state: {other}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredTask {
    pub key: String,
    pub title: String,
    pub objective: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrchestratorOutput {
    tasks: Vec<DiscoveredTask>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorkerStatus {
    Completed,
    Blocked,
    Failed,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerOutput {
    status: WorkerStatus,
    summary: String,
    #[serde(default)]
    evidence: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluatorVerdict {
    Accepted,
    Revise,
    Blocked,
    Invalid,
}

impl EvaluatorVerdict {
    fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Revise => "revise",
            Self::Blocked => "blocked",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvaluatorOutput {
    verdict: EvaluatorVerdict,
    summary: String,
    feedback: Option<String>,
    #[serde(default)]
    evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopTask {
    pub id: String,
    pub loop_run_id: String,
    pub loop_spec_id: String,
    pub key: String,
    pub title: String,
    pub objective: String,
    pub state: LoopTaskState,
    pub worker_session_id: Option<String>,
    pub revision_count: u32,
    pub worker_result: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct LoopManager {
    runtimes: tokio::sync::Mutex<HashMap<String, Arc<dyn LoopAgentRuntime>>>,
}

impl LoopManager {
    pub fn new() -> Self {
        Self {
            runtimes: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn register(&self, run_id: &str, runtime: Arc<dyn LoopAgentRuntime>) {
        self.runtimes
            .lock()
            .await
            .insert(run_id.to_string(), runtime);
    }

    async fn unregister(&self, run_id: &str) {
        self.runtimes.lock().await.remove(run_id);
    }

    async fn abort(&self, run_id: &str) -> Result<(), String> {
        let runtime = self.runtimes.lock().await.get(run_id).cloned();
        if let Some(runtime) = runtime {
            runtime.abort_all().await
        } else {
            Ok(())
        }
    }
}

pub fn init_loop_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS loop_specs (
            id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL UNIQUE
                REFERENCES workstreams(id) ON DELETE CASCADE,
            orchestrator_prompt TEXT NOT NULL,
            worker_prompt TEXT NOT NULL,
            evaluator_prompt TEXT NOT NULL,
            orchestrator_model TEXT,
            worker_model TEXT,
            evaluator_model TEXT,
            verifier_program TEXT,
            verifier_args_json TEXT NOT NULL DEFAULT '[]',
            verifier_cwd TEXT,
            run_timeout_seconds INTEGER NOT NULL,
            max_task_iterations INTEGER NOT NULL DEFAULT 2,
            enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS loop_runs (
            id TEXT PRIMARY KEY,
            loop_spec_id TEXT NOT NULL REFERENCES loop_specs(id) ON DELETE CASCADE,
            state TEXT NOT NULL,
            current_task_id TEXT,
            control_requested TEXT NOT NULL DEFAULT 'none',
            error TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            deadline_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS loop_tasks (
            id TEXT PRIMARY KEY,
            loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
            loop_spec_id TEXT NOT NULL REFERENCES loop_specs(id) ON DELETE CASCADE,
            task_key TEXT NOT NULL,
            title TEXT NOT NULL,
            objective TEXT NOT NULL,
            state TEXT NOT NULL,
            worker_session_id TEXT,
            revision_count INTEGER NOT NULL DEFAULT 0,
            worker_result TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(loop_spec_id, task_key)
        );

        CREATE TABLE IF NOT EXISTS loop_verifications (
            id TEXT PRIMARY KEY,
            loop_task_id TEXT NOT NULL REFERENCES loop_tasks(id) ON DELETE CASCADE,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            program TEXT NOT NULL,
            args_json TEXT NOT NULL,
            cwd TEXT,
            program_hash TEXT,
            exit_code INTEGER,
            duration_ms INTEGER NOT NULL,
            stdout TEXT NOT NULL,
            stderr TEXT NOT NULL,
            truncated INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS loop_evaluations (
            id TEXT PRIMARY KEY,
            loop_task_id TEXT NOT NULL REFERENCES loop_tasks(id) ON DELETE CASCADE,
            attempt INTEGER NOT NULL,
            session_id TEXT,
            verdict TEXT NOT NULL,
            summary TEXT NOT NULL,
            feedback TEXT,
            evidence_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS loop_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            loop_spec_id TEXT NOT NULL REFERENCES loop_specs(id) ON DELETE CASCADE,
            loop_run_id TEXT REFERENCES loop_runs(id) ON DELETE CASCADE,
            loop_task_id TEXT REFERENCES loop_tasks(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS loop_runs_spec_idx
            ON loop_runs(loop_spec_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS loop_tasks_run_idx
            ON loop_tasks(loop_run_id, created_at);
        CREATE INDEX IF NOT EXISTS loop_events_run_idx
            ON loop_events(loop_run_id, id);
        ",
    )
}

fn validate_spec(input: &LoopSpecInput) -> Result<(), String> {
    if input.orchestrator_prompt.trim().is_empty()
        || input.worker_prompt.trim().is_empty()
        || input.evaluator_prompt.trim().is_empty()
    {
        return Err("All three role prompts are required".to_string());
    }
    if input.run_timeout_seconds == 0 {
        return Err("Run timeout must be greater than zero".to_string());
    }
    if input.max_task_iterations == 0 {
        return Err("Maximum task iterations must be greater than zero".to_string());
    }
    if input
        .verifier_program
        .as_deref()
        .is_some_and(|program| program.trim().is_empty())
    {
        return Err("Verifier program cannot be blank".to_string());
    }
    Ok(())
}

fn decode_spec_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoopSpec> {
    let args_json: String = row.get(9)?;
    let verifier_args = serde_json::from_str(&args_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(LoopSpec {
        id: row.get(0)?,
        workstream_id: row.get(1)?,
        orchestrator_prompt: row.get(2)?,
        worker_prompt: row.get(3)?,
        evaluator_prompt: row.get(4)?,
        orchestrator_model: row.get(5)?,
        worker_model: row.get(6)?,
        evaluator_model: row.get(7)?,
        verifier_program: row.get(8)?,
        verifier_args,
        verifier_cwd: row.get(10)?,
        run_timeout_seconds: row.get(11)?,
        max_task_iterations: row.get(12)?,
        enabled: row.get::<_, i64>(13)? != 0,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

const SPEC_COLUMNS: &str = "id, workstream_id, orchestrator_prompt, worker_prompt,
    evaluator_prompt, orchestrator_model, worker_model, evaluator_model,
    verifier_program, verifier_args_json, verifier_cwd, run_timeout_seconds,
    max_task_iterations, enabled, created_at, updated_at";

pub fn get_loop_spec(conn: &Connection, workstream_id: &str) -> Result<Option<LoopSpec>, String> {
    conn.query_row(
        &format!("SELECT {SPEC_COLUMNS} FROM loop_specs WHERE workstream_id = ?1"),
        [workstream_id],
        decode_spec_row,
    )
    .optional()
    .map_err(|error| format!("Failed to load loop specification: {error}"))
}

pub fn get_loop_spec_by_id(
    conn: &Connection,
    loop_spec_id: &str,
) -> Result<Option<LoopSpec>, String> {
    conn.query_row(
        &format!("SELECT {SPEC_COLUMNS} FROM loop_specs WHERE id = ?1"),
        [loop_spec_id],
        decode_spec_row,
    )
    .optional()
    .map_err(|error| format!("Failed to load loop specification: {error}"))
}

pub fn save_loop_spec(
    conn: &Connection,
    workstream_id: &str,
    input: LoopSpecInput,
) -> Result<LoopSpec, String> {
    validate_spec(&input)?;
    let existing = get_loop_spec(conn, workstream_id)?;
    if existing.as_ref().is_some_and(|spec| spec.enabled) {
        return Err("Disable the loop before changing its configuration".to_string());
    }
    let id = existing
        .as_ref()
        .map(|spec| spec.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = existing
        .as_ref()
        .map(|spec| spec.created_at.clone())
        .unwrap_or_else(crate::now);
    let updated_at = crate::now();
    let args_json = serde_json::to_string(&input.verifier_args)
        .map_err(|error| format!("Failed to encode verifier arguments: {error}"))?;

    conn.execute(
        "INSERT INTO loop_specs (
            id, workstream_id, orchestrator_prompt, worker_prompt, evaluator_prompt,
            orchestrator_model, worker_model, evaluator_model, verifier_program,
            verifier_args_json, verifier_cwd, run_timeout_seconds,
            max_task_iterations, enabled, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, ?14, ?15
         )
         ON CONFLICT(workstream_id) DO UPDATE SET
            orchestrator_prompt = excluded.orchestrator_prompt,
            worker_prompt = excluded.worker_prompt,
            evaluator_prompt = excluded.evaluator_prompt,
            orchestrator_model = excluded.orchestrator_model,
            worker_model = excluded.worker_model,
            evaluator_model = excluded.evaluator_model,
            verifier_program = excluded.verifier_program,
            verifier_args_json = excluded.verifier_args_json,
            verifier_cwd = excluded.verifier_cwd,
            run_timeout_seconds = excluded.run_timeout_seconds,
            max_task_iterations = excluded.max_task_iterations,
            updated_at = excluded.updated_at",
        params![
            id,
            workstream_id,
            input.orchestrator_prompt.trim(),
            input.worker_prompt.trim(),
            input.evaluator_prompt.trim(),
            input.orchestrator_model,
            input.worker_model,
            input.evaluator_model,
            input.verifier_program,
            args_json,
            input.verifier_cwd,
            input.run_timeout_seconds,
            input.max_task_iterations,
            created_at,
            updated_at,
        ],
    )
    .map_err(|error| format!("Failed to save loop specification: {error}"))?;
    get_loop_spec(conn, workstream_id)?
        .ok_or_else(|| "Saved loop specification could not be reloaded".to_string())
}

pub fn set_loop_enabled(
    conn: &Connection,
    loop_spec_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE loop_specs SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![i64::from(enabled), crate::now(), loop_spec_id],
        )
        .map_err(|error| format!("Failed to update loop state: {error}"))?;
    if changed == 0 {
        return Err(format!("Loop specification not found: {loop_spec_id}"));
    }
    Ok(())
}

fn decode_run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoopRun> {
    let state: String = row.get(2)?;
    Ok(LoopRun {
        id: row.get(0)?,
        loop_spec_id: row.get(1)?,
        state: LoopRunState::parse(&state)?,
        current_task_id: row.get(3)?,
        control_requested: row.get(4)?,
        error: row.get(5)?,
        started_at: row.get(6)?,
        finished_at: row.get(7)?,
        deadline_at: row.get(8)?,
    })
}

const RUN_COLUMNS: &str = "id, loop_spec_id, state, current_task_id,
    control_requested, error, started_at, finished_at, deadline_at";

pub fn create_loop_run(
    conn: &Connection,
    loop_spec_id: &str,
    timeout_seconds: u64,
) -> Result<LoopRun, String> {
    let spec = get_loop_spec_by_id(conn, loop_spec_id)?
        .ok_or_else(|| format!("Loop specification not found: {loop_spec_id}"))?;
    if !spec.enabled {
        return Err("Enable the loop before starting it".to_string());
    }
    let active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_runs
             WHERE loop_spec_id = ?1
               AND state NOT IN ('completed', 'attention', 'killed')",
            [loop_spec_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to check active loop runs: {error}"))?;
    if active > 0 {
        return Err("This loop already has an active run".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let started_at = crate::now();
    let deadline_at = std::time::SystemTime::now()
        .checked_add(Duration::from_secs(timeout_seconds))
        .and_then(|deadline| deadline.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs().to_string())
        .ok_or_else(|| "Failed to calculate the loop deadline".to_string())?;
    conn.execute(
        "INSERT INTO loop_runs (
            id, loop_spec_id, state, control_requested, started_at, deadline_at
         ) VALUES (?1, ?2, 'starting', 'none', ?3, ?4)",
        params![id, loop_spec_id, started_at, deadline_at],
    )
    .map_err(|error| format!("Failed to create loop run: {error}"))?;
    get_loop_run(conn, &id)?.ok_or_else(|| "Created loop run could not be reloaded".to_string())
}

fn remaining_run_timeout(db: &Arc<Mutex<Connection>>, run_id: &str) -> Result<Duration, String> {
    let run = get_loop_run(&db.lock().unwrap(), run_id)?
        .ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    let deadline = run
        .deadline_at
        .parse::<u64>()
        .map_err(|_| "Loop run has an invalid deadline".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))?
        .as_secs();
    if deadline <= now {
        return Err("Loop run exceeded its wall-time limit".to_string());
    }
    Ok(Duration::from_secs(deadline - now))
}

pub fn get_loop_run(conn: &Connection, run_id: &str) -> Result<Option<LoopRun>, String> {
    conn.query_row(
        &format!("SELECT {RUN_COLUMNS} FROM loop_runs WHERE id = ?1"),
        [run_id],
        decode_run_row,
    )
    .optional()
    .map_err(|error| format!("Failed to load loop run: {error}"))
}

pub fn set_run_state(
    conn: &Connection,
    run_id: &str,
    state: LoopRunState,
    error: Option<&str>,
) -> Result<(), String> {
    let finished_at = state.is_terminal().then(crate::now);
    let changed = conn
        .execute(
            "UPDATE loop_runs
             SET state = ?1, error = ?2, finished_at = COALESCE(?3, finished_at)
             WHERE id = ?4",
            params![state.as_str(), error, finished_at, run_id],
        )
        .map_err(|db_error| format!("Failed to update loop run: {db_error}"))?;
    if changed == 0 {
        return Err(format!("Loop run not found: {run_id}"));
    }
    Ok(())
}

pub(crate) fn set_run_control(
    conn: &Connection,
    run_id: &str,
    control: &str,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE loop_runs SET control_requested = ?1 WHERE id = ?2",
            params![control, run_id],
        )
        .map_err(|error| format!("Failed to request loop control: {error}"))?;
    if changed == 0 {
        return Err(format!("Loop run not found: {run_id}"));
    }
    Ok(())
}

fn apply_control_boundary(conn: &Connection, run_id: &str) -> Result<bool, String> {
    let run = get_loop_run(conn, run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    match run.control_requested.as_str() {
        "none" => Ok(true),
        "pause" => {
            set_run_state(conn, run_id, LoopRunState::Paused, None)?;
            Ok(false)
        }
        "stop" => {
            set_run_state(conn, run_id, LoopRunState::Stopping, None)?;
            conn.execute(
                "UPDATE loop_tasks
                 SET state = 'blocked', error = 'Loop stopped before this task started',
                     updated_at = ?1
                 WHERE loop_run_id = ?2 AND state = 'queued'",
                params![crate::now(), run_id],
            )
            .map_err(|error| format!("Failed to stop queued loop tasks: {error}"))?;
            set_run_state(conn, run_id, LoopRunState::Completed, None)?;
            Ok(false)
        }
        "kill" => Ok(false),
        other => Err(format!("Unknown loop control request: {other}")),
    }
}

fn decode_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LoopTask> {
    let state: String = row.get(6)?;
    Ok(LoopTask {
        id: row.get(0)?,
        loop_run_id: row.get(1)?,
        loop_spec_id: row.get(2)?,
        key: row.get(3)?,
        title: row.get(4)?,
        objective: row.get(5)?,
        state: LoopTaskState::parse(&state)?,
        worker_session_id: row.get(7)?,
        revision_count: row.get(8)?,
        worker_result: row.get(9)?,
        error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const TASK_COLUMNS: &str = "id, loop_run_id, loop_spec_id, task_key, title,
    objective, state, worker_session_id, revision_count, worker_result, error,
    created_at, updated_at";

pub fn enqueue_task(
    conn: &Connection,
    run_id: &str,
    loop_spec_id: &str,
    task: &DiscoveredTask,
) -> Result<Option<LoopTask>, String> {
    if task.key.trim().is_empty()
        || task.title.trim().is_empty()
        || task.objective.trim().is_empty()
    {
        return Err("Discovered tasks require a key, title, and objective".to_string());
    }
    let id = Uuid::new_v4().to_string();
    let now = crate::now();
    let changed = conn
        .execute(
            "INSERT INTO loop_tasks (
                id, loop_run_id, loop_spec_id, task_key, title, objective,
                state, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?7)
             ON CONFLICT(loop_spec_id, task_key) DO NOTHING",
            params![
                id,
                run_id,
                loop_spec_id,
                task.key.trim(),
                task.title.trim(),
                task.objective.trim(),
                now,
            ],
        )
        .map_err(|error| format!("Failed to enqueue loop task: {error}"))?;
    if changed == 0 {
        return Ok(None);
    }
    conn.query_row(
        &format!("SELECT {TASK_COLUMNS} FROM loop_tasks WHERE id = ?1"),
        [&id],
        decode_task_row,
    )
    .optional()
    .map_err(|error| format!("Failed to reload loop task: {error}"))
}

pub fn list_loop_tasks(conn: &Connection, run_id: &str) -> Result<Vec<LoopTask>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {TASK_COLUMNS} FROM loop_tasks
             WHERE loop_run_id = ?1 ORDER BY created_at, id"
        ))
        .map_err(|error| format!("Failed to prepare loop task query: {error}"))?;
    let rows = statement
        .query_map([run_id], decode_task_row)
        .map_err(|error| format!("Failed to query loop tasks: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode loop tasks: {error}"))
}

pub fn set_task_state(
    conn: &Connection,
    task_id: &str,
    state: LoopTaskState,
    worker_session_id: Option<&str>,
) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE loop_tasks
             SET state = ?1,
                 worker_session_id = COALESCE(?2, worker_session_id),
                 updated_at = ?3
             WHERE id = ?4",
            params![state.as_str(), worker_session_id, crate::now(), task_id],
        )
        .map_err(|error| format!("Failed to update loop task: {error}"))?;
    if changed == 0 {
        return Err(format!("Loop task not found: {task_id}"));
    }
    Ok(())
}

pub fn reconcile_interrupted_runs(conn: &Connection) -> Result<usize, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_runs
             WHERE state NOT IN ('completed', 'attention', 'killed')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count interrupted loop runs: {error}"))?;
    conn.execute(
        "UPDATE loop_tasks
         SET state = 'interrupted', error = 'Workstreams exited during this task',
             updated_at = ?1
         WHERE loop_run_id IN (
             SELECT id FROM loop_runs
             WHERE state NOT IN ('completed', 'attention', 'killed')
         )
         AND state IN ('queued', 'working', 'verifying', 'evaluating')",
        [crate::now()],
    )
    .map_err(|error| format!("Failed to reconcile loop tasks: {error}"))?;
    conn.execute(
        "UPDATE loop_runs
         SET state = 'attention',
             error = 'Workstreams exited before this run completed',
             finished_at = ?1
         WHERE state NOT IN ('completed', 'attention', 'killed')",
        [crate::now()],
    )
    .map_err(|error| format!("Failed to reconcile loop runs: {error}"))?;
    Ok(count as usize)
}

pub fn parse_discovered_tasks(content: &str) -> Result<Vec<DiscoveredTask>, String> {
    let output: OrchestratorOutput = serde_json::from_str(content.trim())
        .map_err(|error| format!("Orchestrator returned invalid task JSON: {error}"))?;
    for task in &output.tasks {
        if task.key.trim().is_empty()
            || task.title.trim().is_empty()
            || task.objective.trim().is_empty()
        {
            return Err(
                "Every orchestrator task requires a non-empty key, title, and objective"
                    .to_string(),
            );
        }
    }
    Ok(output.tasks)
}

fn parse_worker_output(content: &str) -> Result<WorkerOutput, String> {
    let output: WorkerOutput = serde_json::from_str(content.trim())
        .map_err(|error| format!("Worker returned invalid result JSON: {error}"))?;
    if output.summary.trim().is_empty() {
        return Err("Worker result requires a non-empty summary".to_string());
    }
    Ok(output)
}

fn parse_evaluator_output(content: &str) -> Result<EvaluatorOutput, String> {
    let output: EvaluatorOutput = serde_json::from_str(content.trim())
        .map_err(|error| format!("Evaluator returned invalid verdict JSON: {error}"))?;
    if output.summary.trim().is_empty() {
        return Err("Evaluator verdict requires a non-empty summary".to_string());
    }
    if output.verdict == EvaluatorVerdict::Revise
        && output
            .feedback
            .as_deref()
            .is_none_or(|feedback| feedback.trim().is_empty())
    {
        return Err("A revise verdict requires actionable feedback".to_string());
    }
    Ok(output)
}

fn append_loop_event(
    conn: &Connection,
    loop_spec_id: &str,
    run_id: &str,
    task_id: Option<&str>,
    event_type: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO loop_events (
            loop_spec_id, loop_run_id, loop_task_id, event_type, payload_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            loop_spec_id,
            run_id,
            task_id,
            event_type,
            payload.to_string(),
            crate::now()
        ],
    )
    .map_err(|error| format!("Failed to append loop event: {error}"))?;
    Ok(())
}

fn record_runtime_events(
    conn: &Connection,
    loop_spec_id: &str,
    run_id: &str,
    task_id: Option<&str>,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentRuntimeEvent>,
) -> Result<(), String> {
    while let Ok(event) = events.try_recv() {
        append_loop_event(
            conn,
            loop_spec_id,
            run_id,
            task_id,
            &format!("agent.{}", event.event_type),
            &event.data,
        )?;
    }
    Ok(())
}

async fn start_agent_stage(
    db: &Arc<Mutex<Connection>>,
    runtime: &Arc<dyn LoopAgentRuntime>,
    request: AgentRequest,
    loop_spec_id: &str,
    run_id: &str,
    task_id: Option<&str>,
) -> Result<AgentResponse, String> {
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let timeout = request.timeout;
    let operation = runtime.start(request, event_tx);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(operation);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result = &mut operation => {
                record_runtime_events(
                    &db.lock().unwrap(),
                    loop_spec_id,
                    run_id,
                    task_id,
                    &mut event_rx,
                )?;
                return result;
            }
            _ = &mut deadline => {
                let _ = runtime.abort_all().await;
                return Err(format!(
                    "{} agent exceeded its wall-time limit",
                    task_id.map_or("Orchestrator", |_| "Task")
                ));
            }
            event = event_rx.recv() => {
                if let Some(event) = event {
                    append_loop_event(
                        &db.lock().unwrap(),
                        loop_spec_id,
                        run_id,
                        task_id,
                        &format!("agent.{}", event.event_type),
                        &event.data,
                    )?;
                }
            }
        }
    }
}

async fn revise_worker_stage(
    db: &Arc<Mutex<Connection>>,
    runtime: &Arc<dyn LoopAgentRuntime>,
    session_id: &str,
    prompt: &str,
    timeout: Duration,
    identity: StageIdentity<'_>,
) -> Result<AgentResponse, String> {
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let operation = runtime.revise(session_id, prompt, timeout, event_tx);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(operation);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            result = &mut operation => {
                record_runtime_events(
                    &db.lock().unwrap(),
                    identity.loop_spec_id,
                    identity.run_id,
                    Some(identity.task_id),
                    &mut event_rx,
                )?;
                return result;
            }
            _ = &mut deadline => {
                let _ = runtime.abort_all().await;
                return Err("Worker revision exceeded its wall-time limit".to_string());
            }
            event = event_rx.recv() => {
                if let Some(event) = event {
                    append_loop_event(
                        &db.lock().unwrap(),
                        identity.loop_spec_id,
                        identity.run_id,
                        Some(identity.task_id),
                        &format!("agent.{}", event.event_type),
                        &event.data,
                    )?;
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct StageIdentity<'a> {
    loop_spec_id: &'a str,
    run_id: &'a str,
    task_id: &'a str,
}

fn update_run_current_task(
    conn: &Connection,
    run_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE loop_runs SET current_task_id = ?1 WHERE id = ?2",
        params![task_id, run_id],
    )
    .map_err(|error| format!("Failed to update current loop task: {error}"))?;
    Ok(())
}

fn store_worker_result(
    conn: &Connection,
    task_id: &str,
    session_id: &str,
    output: &WorkerOutput,
    revision_count: u32,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "status": match output.status {
            WorkerStatus::Completed => "completed",
            WorkerStatus::Blocked => "blocked",
            WorkerStatus::Failed => "failed",
        },
        "summary": output.summary,
        "evidence": output.evidence,
    });
    conn.execute(
        "UPDATE loop_tasks
         SET worker_session_id = ?1, worker_result = ?2, revision_count = ?3,
             updated_at = ?4
         WHERE id = ?5",
        params![
            session_id,
            payload.to_string(),
            revision_count,
            crate::now(),
            task_id
        ],
    )
    .map_err(|error| format!("Failed to store worker result: {error}"))?;
    Ok(())
}

fn record_evaluation(
    conn: &Connection,
    task_id: &str,
    attempt: u32,
    session_id: &str,
    output: &EvaluatorOutput,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO loop_evaluations (
            id, loop_task_id, attempt, session_id, verdict, summary, feedback,
            evidence_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            Uuid::new_v4().to_string(),
            task_id,
            attempt,
            session_id,
            output.verdict.as_str(),
            output.summary,
            output.feedback,
            serde_json::to_string(&output.evidence)
                .map_err(|error| format!("Failed to encode evaluator evidence: {error}"))?,
            crate::now(),
        ],
    )
    .map_err(|error| format!("Failed to record evaluator verdict: {error}"))?;
    Ok(())
}

fn record_verification(
    conn: &Connection,
    task_id: &str,
    attempt: u32,
    spec: &LoopSpec,
    result: &VerificationResult,
) -> Result<(), String> {
    let program = spec
        .verifier_program
        .as_deref()
        .ok_or_else(|| "Cannot record a verifier that is not configured".to_string())?;
    conn.execute(
        "INSERT INTO loop_verifications (
            id, loop_task_id, attempt, status, program, args_json, cwd,
            program_hash, exit_code, duration_ms, stdout, stderr, truncated,
            created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            Uuid::new_v4().to_string(),
            task_id,
            attempt,
            result.status.as_str(),
            program,
            serde_json::to_string(&spec.verifier_args)
                .map_err(|error| format!("Failed to encode verifier arguments: {error}"))?,
            spec.verifier_cwd,
            result.program_hash,
            result.exit_code,
            result.duration_ms,
            result.stdout,
            result.stderr,
            i64::from(result.truncated),
            crate::now(),
        ],
    )
    .map_err(|error| format!("Failed to record verification result: {error}"))?;
    Ok(())
}

async fn verify_task(
    db: &Arc<Mutex<Connection>>,
    spec: &LoopSpec,
    run_id: &str,
    task_id: &str,
    working_directory: &Path,
    attempt: u32,
) -> Result<Option<VerificationResult>, String> {
    let Some(program) = &spec.verifier_program else {
        return Ok(None);
    };
    {
        let conn = db.lock().unwrap();
        set_run_state(&conn, run_id, LoopRunState::Verifying, None)?;
        set_task_state(&conn, task_id, LoopTaskState::Verifying, None)?;
    }
    let result = run_verifier(VerifierConfig {
        program: program.clone(),
        args: spec.verifier_args.clone(),
        cwd: Some(
            spec.verifier_cwd
                .as_ref()
                .map(PathBuf::from)
                .unwrap_or_else(|| working_directory.to_path_buf()),
        ),
        timeout: remaining_run_timeout(db, run_id)?,
        output_limit_bytes: 256 * 1024,
    })
    .await;
    let conn = db.lock().unwrap();
    record_verification(&conn, task_id, attempt, spec, &result)?;
    append_loop_event(
        &conn,
        &spec.id,
        run_id,
        Some(task_id),
        "verification.completed",
        &serde_json::to_value(&result)
            .map_err(|error| format!("Failed to encode verification event: {error}"))?,
    )?;
    Ok(Some(result))
}

fn orchestrator_prompt(spec: &LoopSpec) -> String {
    format!(
        "{}\n\nReturn only JSON with this shape:\n\
         {{\"tasks\":[{{\"key\":\"stable-id\",\"title\":\"short title\",\
         \"objective\":\"complete coding objective\"}}]}}\n\
         Return {{\"tasks\":[]}} when no work is available.",
        spec.orchestrator_prompt
    )
}

fn worker_prompt(spec: &LoopSpec, task: &LoopTask) -> String {
    format!(
        "{}\n\nTask: {}\nObjective: {}\n\n\
         Complete the coding task in the current worktree. Return only JSON:\n\
         {{\"status\":\"completed|blocked|failed\",\"summary\":\"what happened\",\
         \"evidence\":[\"observable evidence\"]}}",
        spec.worker_prompt, task.title, task.objective
    )
}

fn evaluator_prompt(
    spec: &LoopSpec,
    task: &LoopTask,
    worker: &WorkerOutput,
    verification: Option<&VerificationResult>,
) -> String {
    format!(
        "{}\n\nTask: {}\nObjective: {}\nWorker summary: {}\nEvidence: {}\n\
         Deterministic verification: {}\n\n\
         Independently inspect the work with read-only actions. Return only JSON:\n\
         {{\"verdict\":\"accepted|revise|blocked|invalid\",\
         \"summary\":\"judgment\",\"feedback\":null,\"evidence\":[]}}.\n\
         A revise verdict must include actionable feedback.",
        spec.evaluator_prompt,
        task.title,
        task.objective,
        worker.summary,
        serde_json::to_string(&worker.evidence).unwrap_or_else(|_| "[]".to_string()),
        verification
            .map(|result| serde_json::to_string(result).unwrap_or_else(|_| "{}".to_string()))
            .unwrap_or_else(|| "not configured".to_string())
    )
}

fn revision_prompt(feedback: &str) -> String {
    format!(
        "The independent evaluator requested one revision:\n{feedback}\n\n\
         Address the feedback, re-run relevant checks, and return only JSON:\n\
         {{\"status\":\"completed|blocked|failed\",\"summary\":\"what changed\",\
         \"evidence\":[\"observable evidence\"]}}"
    )
}

struct EvaluationContext<'a> {
    db: &'a Arc<Mutex<Connection>>,
    runtime: &'a Arc<dyn LoopAgentRuntime>,
    spec: &'a LoopSpec,
    run_id: &'a str,
    task: &'a LoopTask,
    working_directory: &'a Path,
}

async fn evaluate_task(
    context: EvaluationContext<'_>,
    worker: &WorkerOutput,
    verification: Option<&VerificationResult>,
    attempt: u32,
) -> Result<EvaluatorOutput, String> {
    {
        let conn = context.db.lock().unwrap();
        set_run_state(&conn, context.run_id, LoopRunState::Evaluating, None)?;
        set_task_state(&conn, &context.task.id, LoopTaskState::Evaluating, None)?;
    }
    let response = start_agent_stage(
        context.db,
        context.runtime,
        AgentRequest {
            role: AgentRole::Evaluator,
            prompt: evaluator_prompt(context.spec, context.task, worker, verification),
            working_directory: context.working_directory.to_path_buf(),
            model: context.spec.evaluator_model.clone(),
            timeout: remaining_run_timeout(context.db, context.run_id)?,
            keep_session: false,
        },
        &context.spec.id,
        context.run_id,
        Some(&context.task.id),
    )
    .await?;
    let output = parse_evaluator_output(&response.content)?;
    record_evaluation(
        &context.db.lock().unwrap(),
        &context.task.id,
        attempt,
        &response.session_id,
        &output,
    )?;
    Ok(output)
}

async fn execute_manual_loop_inner(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
) -> Result<(), String> {
    let run = get_loop_run(&db.lock().unwrap(), run_id)?
        .ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    let spec = get_loop_spec_by_id(&db.lock().unwrap(), &run.loop_spec_id)?
        .ok_or_else(|| format!("Loop specification not found: {}", run.loop_spec_id))?;
    let tasks = if run.state == LoopRunState::Paused {
        let conn = db.lock().unwrap();
        set_run_control(&conn, run_id, "none")?;
        list_loop_tasks(&conn, run_id)?
            .into_iter()
            .filter(|task| task.state == LoopTaskState::Queued)
            .collect::<Vec<_>>()
    } else {
        {
            let conn = db.lock().unwrap();
            set_run_state(&conn, run_id, LoopRunState::Orchestrating, None)?;
            append_loop_event(
                &conn,
                &spec.id,
                run_id,
                None,
                "run.started",
                &serde_json::json!({}),
            )?;
        }

        let orchestrator = start_agent_stage(
            &db,
            &runtime,
            AgentRequest {
                role: AgentRole::Orchestrator,
                prompt: orchestrator_prompt(&spec),
                working_directory: working_directory.clone(),
                model: spec.orchestrator_model.clone(),
                timeout: remaining_run_timeout(&db, run_id)?,
                keep_session: false,
            },
            &spec.id,
            run_id,
            None,
        )
        .await?;
        let discovered = parse_discovered_tasks(&orchestrator.content)?;
        let mut tasks = Vec::new();
        {
            let conn = db.lock().unwrap();
            for candidate in discovered {
                if let Some(task) = enqueue_task(&conn, run_id, &spec.id, &candidate)? {
                    tasks.push(task);
                }
            }
        }
        tasks
    };

    let mut needs_attention = false;
    for task in tasks {
        {
            let conn = db.lock().unwrap();
            if !apply_control_boundary(&conn, run_id)? {
                return Ok(());
            }
            update_run_current_task(&conn, run_id, Some(&task.id))?;
            set_run_state(&conn, run_id, LoopRunState::Working, None)?;
            set_task_state(&conn, &task.id, LoopTaskState::Working, None)?;
        }
        let worker_response = start_agent_stage(
            &db,
            &runtime,
            AgentRequest {
                role: AgentRole::Worker,
                prompt: worker_prompt(&spec, &task),
                working_directory: working_directory.clone(),
                model: spec.worker_model.clone(),
                timeout: remaining_run_timeout(&db, run_id)?,
                keep_session: true,
            },
            &spec.id,
            run_id,
            Some(&task.id),
        )
        .await?;
        let mut worker_output = parse_worker_output(&worker_response.content)?;
        store_worker_result(
            &db.lock().unwrap(),
            &task.id,
            &worker_response.session_id,
            &worker_output,
            0,
        )?;

        if worker_output.status != WorkerStatus::Completed {
            let state = if worker_output.status == WorkerStatus::Blocked {
                LoopTaskState::Blocked
            } else {
                LoopTaskState::Attention
            };
            set_task_state(&db.lock().unwrap(), &task.id, state, None)?;
            runtime.disconnect(&worker_response.session_id).await?;
            needs_attention = true;
            continue;
        }
        let first_verification =
            verify_task(&db, &spec, run_id, &task.id, &working_directory, 1).await?;
        if first_verification
            .as_ref()
            .is_some_and(|result| result.status != VerificationStatus::Passed)
        {
            set_task_state(
                &db.lock().unwrap(),
                &task.id,
                LoopTaskState::Attention,
                None,
            )?;
            runtime.disconnect(&worker_response.session_id).await?;
            needs_attention = true;
            continue;
        }

        let first_verdict = evaluate_task(
            EvaluationContext {
                db: &db,
                runtime: &runtime,
                spec: &spec,
                run_id,
                task: &task,
                working_directory: &working_directory,
            },
            &worker_output,
            first_verification.as_ref(),
            1,
        )
        .await?;
        let final_verdict = if first_verdict.verdict == EvaluatorVerdict::Revise {
            let feedback = first_verdict
                .feedback
                .as_deref()
                .ok_or_else(|| "Evaluator revision feedback was missing".to_string())?;
            {
                let conn = db.lock().unwrap();
                if !apply_control_boundary(&conn, run_id)? {
                    return Ok(());
                }
                set_run_state(&conn, run_id, LoopRunState::Working, None)?;
                set_task_state(&conn, &task.id, LoopTaskState::Working, None)?;
            }
            let revised_response = revise_worker_stage(
                &db,
                &runtime,
                &worker_response.session_id,
                &revision_prompt(feedback),
                remaining_run_timeout(&db, run_id)?,
                StageIdentity {
                    loop_spec_id: &spec.id,
                    run_id,
                    task_id: &task.id,
                },
            )
            .await?;
            worker_output = parse_worker_output(&revised_response.content)?;
            store_worker_result(
                &db.lock().unwrap(),
                &task.id,
                &worker_response.session_id,
                &worker_output,
                1,
            )?;
            let revised_verification =
                verify_task(&db, &spec, run_id, &task.id, &working_directory, 2).await?;
            if revised_verification
                .as_ref()
                .is_some_and(|result| result.status != VerificationStatus::Passed)
            {
                set_task_state(
                    &db.lock().unwrap(),
                    &task.id,
                    LoopTaskState::Attention,
                    None,
                )?;
                runtime.disconnect(&worker_response.session_id).await?;
                needs_attention = true;
                continue;
            }
            evaluate_task(
                EvaluationContext {
                    db: &db,
                    runtime: &runtime,
                    spec: &spec,
                    run_id,
                    task: &task,
                    working_directory: &working_directory,
                },
                &worker_output,
                revised_verification.as_ref(),
                2,
            )
            .await?
        } else {
            first_verdict
        };

        let task_state = match final_verdict.verdict {
            EvaluatorVerdict::Accepted => LoopTaskState::Accepted,
            EvaluatorVerdict::Blocked => {
                needs_attention = true;
                LoopTaskState::Blocked
            }
            EvaluatorVerdict::Revise | EvaluatorVerdict::Invalid => {
                needs_attention = true;
                LoopTaskState::Attention
            }
        };
        set_task_state(&db.lock().unwrap(), &task.id, task_state, None)?;
        runtime.disconnect(&worker_response.session_id).await?;
    }

    let conn = db.lock().unwrap();
    update_run_current_task(&conn, run_id, None)?;
    if needs_attention {
        set_run_state(
            &conn,
            run_id,
            LoopRunState::Attention,
            Some("One or more tasks require human attention"),
        )
    } else {
        set_run_state(&conn, run_id, LoopRunState::Completed, None)
    }
}

pub async fn execute_manual_loop(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
) -> Result<(), String> {
    let result =
        execute_manual_loop_inner(Arc::clone(&db), runtime, run_id, working_directory).await;
    if let Err(error) = &result {
        let conn = db.lock().unwrap();
        let preserve_control_state =
            get_loop_run(&conn, run_id)
                .ok()
                .flatten()
                .is_some_and(|run| {
                    matches!(
                        run.state,
                        LoopRunState::Killed | LoopRunState::Paused | LoopRunState::Completed
                    )
                });
        if !preserve_control_state {
            let _ = set_run_state(&conn, run_id, LoopRunState::Attention, Some(error));
        }
    }
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopVerificationRecord {
    pub id: String,
    pub loop_task_id: String,
    pub attempt: u32,
    pub status: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub program_hash: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopEvaluationRecord {
    pub id: String,
    pub loop_task_id: String,
    pub attempt: u32,
    pub session_id: Option<String>,
    pub verdict: String,
    pub summary: String,
    pub feedback: Option<String>,
    pub evidence: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopEventRecord {
    pub id: i64,
    pub loop_spec_id: String,
    pub loop_run_id: Option<String>,
    pub loop_task_id: Option<String>,
    pub event_type: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopSnapshot {
    pub spec: Option<LoopSpec>,
    pub latest_run: Option<LoopRun>,
    pub tasks: Vec<LoopTask>,
    pub verifications: Vec<LoopVerificationRecord>,
    pub evaluations: Vec<LoopEvaluationRecord>,
    pub events: Vec<LoopEventRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopSummary {
    pub workstream_id: String,
    pub loop_spec_id: String,
    pub enabled: bool,
    pub run_id: Option<String>,
    pub run_state: Option<LoopRunState>,
    pub control_requested: Option<String>,
    pub current_task_id: Option<String>,
    pub started_at: Option<String>,
}

fn latest_loop_run(conn: &Connection, loop_spec_id: &str) -> Result<Option<LoopRun>, String> {
    conn.query_row(
        &format!(
            "SELECT {RUN_COLUMNS} FROM loop_runs
             WHERE loop_spec_id = ?1 ORDER BY rowid DESC LIMIT 1"
        ),
        [loop_spec_id],
        decode_run_row,
    )
    .optional()
    .map_err(|error| format!("Failed to load latest loop run: {error}"))
}

fn list_verifications(
    conn: &Connection,
    run_id: &str,
) -> Result<Vec<LoopVerificationRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT v.id, v.loop_task_id, v.attempt, v.status, v.program,
                    v.args_json, v.cwd, v.program_hash, v.exit_code, v.duration_ms,
                    v.stdout, v.stderr, v.truncated, v.created_at
             FROM loop_verifications v
             JOIN loop_tasks t ON t.id = v.loop_task_id
             WHERE t.loop_run_id = ?1
             ORDER BY t.created_at, v.attempt",
        )
        .map_err(|error| format!("Failed to prepare verification query: {error}"))?;
    let rows = statement
        .query_map([run_id], |row| {
            let args_json: String = row.get(5)?;
            let args = serde_json::from_str(&args_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(LoopVerificationRecord {
                id: row.get(0)?,
                loop_task_id: row.get(1)?,
                attempt: row.get(2)?,
                status: row.get(3)?,
                program: row.get(4)?,
                args,
                cwd: row.get(6)?,
                program_hash: row.get(7)?,
                exit_code: row.get(8)?,
                duration_ms: row.get(9)?,
                stdout: row.get(10)?,
                stderr: row.get(11)?,
                truncated: row.get::<_, i64>(12)? != 0,
                created_at: row.get(13)?,
            })
        })
        .map_err(|error| format!("Failed to query verifications: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode verifications: {error}"))
}

fn list_evaluations(conn: &Connection, run_id: &str) -> Result<Vec<LoopEvaluationRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT e.id, e.loop_task_id, e.attempt, e.session_id, e.verdict,
                    e.summary, e.feedback, e.evidence_json, e.created_at
             FROM loop_evaluations e
             JOIN loop_tasks t ON t.id = e.loop_task_id
             WHERE t.loop_run_id = ?1
             ORDER BY t.created_at, e.attempt",
        )
        .map_err(|error| format!("Failed to prepare evaluation query: {error}"))?;
    let rows = statement
        .query_map([run_id], |row| {
            let evidence_json: String = row.get(7)?;
            let evidence = serde_json::from_str(&evidence_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(LoopEvaluationRecord {
                id: row.get(0)?,
                loop_task_id: row.get(1)?,
                attempt: row.get(2)?,
                session_id: row.get(3)?,
                verdict: row.get(4)?,
                summary: row.get(5)?,
                feedback: row.get(6)?,
                evidence,
                created_at: row.get(8)?,
            })
        })
        .map_err(|error| format!("Failed to query evaluations: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode evaluations: {error}"))
}

fn list_loop_events(conn: &Connection, run_id: &str) -> Result<Vec<LoopEventRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, loop_spec_id, loop_run_id, loop_task_id, event_type,
                    payload_json, created_at
             FROM loop_events WHERE loop_run_id = ?1 ORDER BY id",
        )
        .map_err(|error| format!("Failed to prepare loop event query: {error}"))?;
    let rows = statement
        .query_map([run_id], |row| {
            let payload_json: String = row.get(5)?;
            let payload = serde_json::from_str(&payload_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(LoopEventRecord {
                id: row.get(0)?,
                loop_spec_id: row.get(1)?,
                loop_run_id: row.get(2)?,
                loop_task_id: row.get(3)?,
                event_type: row.get(4)?,
                payload,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Failed to query loop events: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode loop events: {error}"))
}

pub(crate) fn loop_snapshot(
    conn: &Connection,
    workstream_id: &str,
) -> Result<LoopSnapshot, String> {
    let spec = get_loop_spec(conn, workstream_id)?;
    let Some(spec_ref) = spec.as_ref() else {
        return Ok(LoopSnapshot {
            spec: None,
            latest_run: None,
            tasks: Vec::new(),
            verifications: Vec::new(),
            evaluations: Vec::new(),
            events: Vec::new(),
        });
    };
    let latest_run = latest_loop_run(conn, &spec_ref.id)?;
    let Some(run) = latest_run.as_ref() else {
        return Ok(LoopSnapshot {
            spec,
            latest_run: None,
            tasks: Vec::new(),
            verifications: Vec::new(),
            evaluations: Vec::new(),
            events: Vec::new(),
        });
    };
    let run_id = run.id.clone();
    Ok(LoopSnapshot {
        spec,
        latest_run,
        tasks: list_loop_tasks(conn, &run_id)?,
        verifications: list_verifications(conn, &run_id)?,
        evaluations: list_evaluations(conn, &run_id)?,
        events: list_loop_events(conn, &run_id)?,
    })
}

#[tauri::command]
pub fn get_workstream_loop_snapshot(
    state: tauri::State<'_, crate::AppState>,
    workstream_id: String,
) -> Result<LoopSnapshot, String> {
    loop_snapshot(&state.db.lock().unwrap(), &workstream_id)
}

#[tauri::command]
pub fn save_workstream_loop(
    state: tauri::State<'_, crate::AppState>,
    workstream_id: String,
    input: LoopSpecInput,
) -> Result<LoopSpec, String> {
    save_loop_spec(&state.db.lock().unwrap(), &workstream_id, input)
}

#[tauri::command]
pub fn set_workstream_loop_enabled(
    state: tauri::State<'_, crate::AppState>,
    loop_spec_id: String,
    enabled: bool,
) -> Result<(), String> {
    set_loop_enabled(&state.db.lock().unwrap(), &loop_spec_id, enabled)
}

#[tauri::command]
pub fn list_workstream_loop_summaries(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<LoopSummary>, String> {
    let conn = state.db.lock().unwrap();
    let mut statement = conn
        .prepare(
            "SELECT s.workstream_id, s.id, s.enabled,
                    r.id, r.state, r.control_requested, r.current_task_id, r.started_at
             FROM loop_specs s
             LEFT JOIN loop_runs r ON r.id = (
                 SELECT id FROM loop_runs
                 WHERE loop_spec_id = s.id ORDER BY rowid DESC LIMIT 1
             )
             ORDER BY s.created_at",
        )
        .map_err(|error| format!("Failed to prepare loop summary query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let state: Option<String> = row.get(4)?;
            Ok(LoopSummary {
                workstream_id: row.get(0)?,
                loop_spec_id: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                run_id: row.get(3)?,
                run_state: state.as_deref().map(LoopRunState::parse).transpose()?,
                control_requested: row.get(5)?,
                current_task_id: row.get(6)?,
                started_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Failed to query loop summaries: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode loop summaries: {error}"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopUpdatedEvent {
    workstream_id: String,
    run_id: String,
}

async fn run_with_sdk(
    db_path: PathBuf,
    manager: Arc<LoopManager>,
    app: tauri::AppHandle,
    workstream_id: String,
    run_id: String,
    working_directory: PathBuf,
) {
    use crate::loop_agent::SdkAgentRuntime;
    use tauri::Emitter;

    let runtime = match SdkAgentRuntime::connect().await {
        Ok(runtime) => Arc::new(runtime) as Arc<dyn LoopAgentRuntime>,
        Err(error) => {
            if let Ok(conn) = crate::db::open_db(&db_path) {
                let _ = set_run_state(&conn, &run_id, LoopRunState::Attention, Some(&error));
            }
            let _ = app.emit(
                "loop-updated",
                LoopUpdatedEvent {
                    workstream_id,
                    run_id,
                },
            );
            return;
        }
    };
    manager.register(&run_id, Arc::clone(&runtime)).await;
    match crate::db::open_db(&db_path) {
        Ok(conn) => {
            let db = Arc::new(Mutex::new(conn));
            let _ = execute_manual_loop(db, Arc::clone(&runtime), &run_id, working_directory).await;
        }
        Err(error) => {
            eprintln!("[loop] Failed to open database for run {run_id}: {error}");
        }
    }
    if let Err(error) = runtime.shutdown().await {
        eprintln!("[loop] Failed to shut down runtime for {run_id}: {error}");
    }
    manager.unregister(&run_id).await;
    let _ = app.emit(
        "loop-updated",
        LoopUpdatedEvent {
            workstream_id,
            run_id,
        },
    );
}

fn workstream_directory_for_spec(
    conn: &Connection,
    loop_spec_id: &str,
) -> Result<(String, PathBuf), String> {
    conn.query_row(
        "SELECT s.workstream_id, w.directory
         FROM loop_specs s
         JOIN workstreams w ON w.id = s.workstream_id
         WHERE s.id = ?1",
        [loop_spec_id],
        |row| {
            let workstream_id: String = row.get(0)?;
            let directory: Option<String> = row.get(1)?;
            Ok((workstream_id, directory))
        },
    )
    .map_err(|error| format!("Failed to resolve loop workstream: {error}"))
    .and_then(|(workstream_id, directory)| {
        let directory = directory
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "The loop workstream has no directory".to_string())?;
        Ok((workstream_id, PathBuf::from(directory)))
    })
}

#[tauri::command]
pub fn run_workstream_loop_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    workstream_id: String,
) -> Result<LoopRun, String> {
    let (run, directory) = {
        let conn = state.db.lock().unwrap();
        let spec = get_loop_spec(&conn, &workstream_id)?
            .ok_or_else(|| "Configure this workstream's loop first".to_string())?;
        let (_, directory) = workstream_directory_for_spec(&conn, &spec.id)?;
        (
            create_loop_run(&conn, &spec.id, spec.run_timeout_seconds)?,
            directory,
        )
    };
    let run_id = run.id.clone();
    tauri::async_runtime::spawn(run_with_sdk(
        state.db_path.clone(),
        Arc::clone(&state.loop_manager),
        app,
        workstream_id,
        run_id,
        directory,
    ));
    Ok(run)
}

#[tauri::command]
pub fn resume_workstream_loop(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
) -> Result<LoopRun, String> {
    let (run, workstream_id, directory) = {
        let conn = state.db.lock().unwrap();
        let run =
            get_loop_run(&conn, &run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
        if run.state != LoopRunState::Paused {
            return Err("Only a paused loop run can be resumed".to_string());
        }
        let (workstream_id, directory) = workstream_directory_for_spec(&conn, &run.loop_spec_id)?;
        set_run_control(&conn, &run_id, "none")?;
        (run, workstream_id, directory)
    };
    tauri::async_runtime::spawn(run_with_sdk(
        state.db_path.clone(),
        Arc::clone(&state.loop_manager),
        app,
        workstream_id,
        run_id,
        directory,
    ));
    Ok(run)
}

#[tauri::command]
pub async fn control_workstream_loop(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
    action: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let workstream_id = {
        let conn = state.db.lock().unwrap();
        let run =
            get_loop_run(&conn, &run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
        let (workstream_id, _) = workstream_directory_for_spec(&conn, &run.loop_spec_id)?;
        match action.as_str() {
            "pause" | "stop" => set_run_control(&conn, &run_id, &action)?,
            "kill" => {
                set_run_control(&conn, &run_id, "kill")?;
                if let Some(task_id) = &run.current_task_id {
                    set_task_state(&conn, task_id, LoopTaskState::Interrupted, None)?;
                }
                set_run_state(&conn, &run_id, LoopRunState::Killed, None)?;
            }
            _ => return Err("Loop action must be pause, stop, or kill".to_string()),
        }
        workstream_id
    };
    if action == "kill" {
        state.loop_manager.abort(&run_id).await?;
    }
    let _ = app.emit(
        "loop-updated",
        LoopUpdatedEvent {
            workstream_id,
            run_id,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        crate::db::init_db(&conn).expect("initialize base schema");
        conn.execute(
            "INSERT INTO workstreams (
                id, name, directory, status, workstream_type, created_at, updated_at
             ) VALUES ('ws-1', 'Loop test', '/tmp/repo', 'active', 'worktree', '1', '1')",
            [],
        )
        .expect("seed workstream");
        init_loop_schema(&conn).expect("initialize loop schema");
        conn
    }

    fn spec_input() -> LoopSpecInput {
        LoopSpecInput {
            orchestrator_prompt: "Find coding work".to_string(),
            worker_prompt: "Implement the task".to_string(),
            evaluator_prompt: "Evaluate the result".to_string(),
            orchestrator_model: None,
            worker_model: None,
            evaluator_model: None,
            verifier_program: Some("cargo".to_string()),
            verifier_args: vec!["test".to_string()],
            verifier_cwd: Some("/tmp/repo".to_string()),
            run_timeout_seconds: 600,
            max_task_iterations: 2,
        }
    }

    #[test]
    fn saves_one_loop_spec_per_workstream() {
        let conn = test_db();

        let created = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        let loaded = get_loop_spec(&conn, "ws-1")
            .expect("load loop spec")
            .expect("spec exists");

        assert_eq!(loaded, created);
        assert_eq!(loaded.verifier_args, vec!["test"]);
        assert!(!loaded.enabled);
    }

    #[test]
    fn enabled_loop_configuration_is_frozen_until_disabled() {
        let conn = test_db();
        let created = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &created.id, true).expect("enable loop");
        let mut changed = spec_input();
        changed.worker_prompt = "Different worker".to_string();

        let error = save_loop_spec(&conn, "ws-1", changed)
            .expect_err("enabled loop configuration must be immutable");

        assert!(error.to_lowercase().contains("disable"));
    }

    #[test]
    fn task_keys_are_deduplicated_across_runs_of_the_same_loop() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let first_run = create_loop_run(&conn, &spec.id, 600).expect("create first run");
        let task = DiscoveredTask {
            key: "issue-42".to_string(),
            title: "Fix issue 42".to_string(),
            objective: "Reproduce and fix issue 42".to_string(),
        };
        let inserted =
            enqueue_task(&conn, &first_run.id, &spec.id, &task).expect("enqueue first task");
        assert!(inserted.is_some());

        set_run_state(&conn, &first_run.id, LoopRunState::Completed, None)
            .expect("finish first run");
        let second_run = create_loop_run(&conn, &spec.id, 600).expect("create second run");
        let duplicate =
            enqueue_task(&conn, &second_run.id, &spec.id, &task).expect("deduplicate task");

        assert!(duplicate.is_none());
    }

    #[test]
    fn restart_reconciliation_marks_nonterminal_runs_and_tasks_interrupted() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let task = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "task-1".to_string(),
                title: "Task".to_string(),
                objective: "Change code".to_string(),
            },
        )
        .expect("enqueue task")
        .expect("task inserted");
        set_task_state(&conn, &task.id, LoopTaskState::Working, Some("session-1"))
            .expect("start task");

        let reconciled = reconcile_interrupted_runs(&conn).expect("reconcile");

        assert_eq!(reconciled, 1);
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Attention
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].state,
            LoopTaskState::Interrupted
        );
    }

    #[tokio::test]
    async fn manual_run_executes_orchestrator_worker_and_evaluator() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = None;
        input.verifier_args.clear();
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![
            ScriptedAgentResponse {
                role: AgentRole::Orchestrator,
                session_id: "orchestrator-1".to_string(),
                content: r#"{"tasks":[{"key":"task-1","title":"Fix bug","objective":"Fix the bug and test it"}]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"Fixed and tested","evidence":["diff"]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-1".to_string(),
                content: r#"{"verdict":"accepted","summary":"The fix satisfies the task"}"#.to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("execute manual loop");

        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Completed
        );
        let tasks = list_loop_tasks(&conn, &run.id).expect("list tasks");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].state, LoopTaskState::Accepted);
        assert_eq!(tasks[0].worker_session_id.as_deref(), Some("worker-1"));
    }

    #[tokio::test]
    async fn evaluator_can_request_exactly_one_worker_revision() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = None;
        input.verifier_args.clear();
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![
            ScriptedAgentResponse {
                role: AgentRole::Orchestrator,
                session_id: "orchestrator-1".to_string(),
                content: r#"{"tasks":[{"key":"task-1","title":"Fix bug","objective":"Fix the bug"}]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"First attempt","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-1".to_string(),
                content: r#"{"verdict":"revise","summary":"A test is missing","feedback":"Add the regression test","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"Added regression test","evidence":["test passes"]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-2".to_string(),
                content: r#"{"verdict":"accepted","summary":"The regression is covered","evidence":["test passes"]}"#.to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("execute revised loop");

        let conn = db.lock().unwrap();
        let tasks = list_loop_tasks(&conn, &run.id).expect("list tasks");
        assert_eq!(tasks[0].state, LoopTaskState::Accepted);
        assert_eq!(tasks[0].revision_count, 1);
        let evaluations: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM loop_evaluations WHERE loop_task_id = ?1",
                [&tasks[0].id],
                |row| row.get(0),
            )
            .expect("count evaluations");
        assert_eq!(evaluations, 2);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_verification_blocks_evaluation_and_requires_attention() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = Some("/bin/sh".to_string());
        input.verifier_args = vec!["-c".to_string(), "printf failed >&2; exit 3".to_string()];
        input.verifier_cwd = None;
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![
            ScriptedAgentResponse {
                role: AgentRole::Orchestrator,
                session_id: "orchestrator-1".to_string(),
                content:
                    r#"{"tasks":[{"key":"task-1","title":"Fix bug","objective":"Fix the bug"}]}"#
                        .to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"Claimed success","evidence":[]}"#
                    .to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::env::current_dir().expect("current directory"),
        )
        .await
        .expect("verification failure is a handled loop outcome");

        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Attention
        );
        let task = &list_loop_tasks(&conn, &run.id).expect("list tasks")[0];
        assert_eq!(task.state, LoopTaskState::Attention);
        let verification: (String, Option<i32>, String) = conn
            .query_row(
                "SELECT status, exit_code, stderr FROM loop_verifications
                 WHERE loop_task_id = ?1",
                [&task.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("verification row");
        assert_eq!(verification.0, "nonzero");
        assert_eq!(verification.1, Some(3));
        assert_eq!(verification.2, "failed");
        let evaluations: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM loop_evaluations WHERE loop_task_id = ?1",
                [&task.id],
                |row| row.get(0),
            )
            .expect("count evaluations");
        assert_eq!(evaluations, 0);
    }

    #[test]
    fn pause_and_stop_are_applied_at_task_boundaries() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let paused_run = create_loop_run(&conn, &spec.id, 600).expect("create paused run");
        set_run_control(&conn, &paused_run.id, "pause").expect("request pause");
        assert!(!apply_control_boundary(&conn, &paused_run.id).expect("apply pause"));
        assert_eq!(
            get_loop_run(&conn, &paused_run.id)
                .expect("load paused run")
                .expect("run exists")
                .state,
            LoopRunState::Paused
        );

        set_run_state(&conn, &paused_run.id, LoopRunState::Killed, None)
            .expect("make room for next run");
        let stopped_run = create_loop_run(&conn, &spec.id, 600).expect("create stopped run");
        let task = enqueue_task(
            &conn,
            &stopped_run.id,
            &spec.id,
            &DiscoveredTask {
                key: "stop-task".to_string(),
                title: "Queued".to_string(),
                objective: "Never starts".to_string(),
            },
        )
        .expect("enqueue task")
        .expect("insert task");
        set_run_control(&conn, &stopped_run.id, "stop").expect("request stop");
        assert!(!apply_control_boundary(&conn, &stopped_run.id).expect("apply stop"));
        assert_eq!(
            get_loop_run(&conn, &stopped_run.id)
                .expect("load stopped run")
                .expect("run exists")
                .state,
            LoopRunState::Completed
        );
        assert_eq!(
            list_loop_tasks(&conn, &stopped_run.id).expect("list tasks")[0].state,
            LoopTaskState::Blocked
        );
        assert_eq!(
            list_loop_tasks(&conn, &stopped_run.id).expect("list tasks")[0].id,
            task.id
        );
    }

    #[tokio::test]
    async fn resuming_a_paused_run_continues_its_queued_tasks_without_orchestration() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = None;
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "queued-task".to_string(),
                title: "Queued".to_string(),
                objective: "Complete queued task".to_string(),
            },
        )
        .expect("enqueue task");
        set_run_state(&conn, &run.id, LoopRunState::Paused, None).expect("pause run");
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"Done","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-1".to_string(),
                content: r#"{"verdict":"accepted","summary":"Accepted","evidence":[]}"#.to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("resume queued task");

        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Completed
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].state,
            LoopTaskState::Accepted
        );
    }

    #[tokio::test]
    async fn blocked_evaluator_verdict_requires_human_attention() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = None;
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![
            ScriptedAgentResponse {
                role: AgentRole::Orchestrator,
                session_id: "orchestrator-1".to_string(),
                content: r#"{"tasks":[{"key":"task-1","title":"Task","objective":"Do work"}]}"#
                    .to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"Done","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-1".to_string(),
                content: r#"{"verdict":"blocked","summary":"Needs human input","evidence":[]}"#
                    .to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("blocked is a handled outcome");

        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Attention
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].state,
            LoopTaskState::Blocked
        );
    }

    #[test]
    fn malformed_orchestrator_tasks_are_rejected_without_guessing() {
        let error =
            parse_discovered_tasks(r#"{"tasks":[{"title":"Missing key","objective":"Do work"}]}"#)
                .expect_err("missing key must fail");

        assert!(error.contains("key"));
    }
}

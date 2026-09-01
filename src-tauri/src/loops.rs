use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub evaluator_prompt: Option<String>,
    pub orchestrator_model: Option<String>,
    pub worker_model: Option<String>,
    pub evaluator_model: Option<String>,
    pub human_approval_prompt: Option<String>,
    pub verifier_program: Option<String>,
    pub verifier_args: Vec<String>,
    pub verifier_cwd: Option<String>,
    pub verifier_timeout_seconds: Option<u64>,
    pub run_timeout_seconds: u64,
    pub max_task_iterations: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoopSpec {
    pub id: String,
    pub workstream_id: String,
    pub orchestrator_prompt: String,
    pub worker_prompt: String,
    pub evaluator_prompt: Option<String>,
    pub orchestrator_model: Option<String>,
    pub worker_model: Option<String>,
    pub evaluator_model: Option<String>,
    pub human_approval_prompt: Option<String>,
    pub verifier_program: Option<String>,
    pub verifier_args: Vec<String>,
    pub verifier_cwd: Option<String>,
    pub verifier_timeout_seconds: Option<u64>,
    pub run_timeout_seconds: u64,
    pub max_task_iterations: u32,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub definition_id: Option<String>,
    pub definition_path: Option<String>,
    pub definition_hash: Option<String>,
    pub definition_name: Option<String>,
    pub objective: Option<String>,
    pub portable: Option<bool>,
    pub definition_yaml: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopRunState {
    Starting,
    Resuming,
    Orchestrating,
    Working,
    Verifying,
    Evaluating,
    AwaitingApproval,
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
            Self::Resuming => "resuming",
            Self::Orchestrating => "orchestrating",
            Self::Working => "working",
            Self::Verifying => "verifying",
            Self::Evaluating => "evaluating",
            Self::AwaitingApproval => "awaiting_approval",
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
            "resuming" => Ok(Self::Resuming),
            "orchestrating" => Ok(Self::Orchestrating),
            "working" => Ok(Self::Working),
            "verifying" => Ok(Self::Verifying),
            "evaluating" => Ok(Self::Evaluating),
            "awaiting_approval" => Ok(Self::AwaitingApproval),
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
    pub definition_hash: Option<String>,
    pub definition_yaml: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopTaskState {
    Queued,
    Working,
    Verifying,
    Evaluating,
    AwaitingApproval,
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
            Self::AwaitingApproval => "awaiting_approval",
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
            "awaiting_approval" => Ok(Self::AwaitingApproval),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HumanApprovalDecision {
    Approve,
    Revise,
    Reject,
}

impl HumanApprovalDecision {
    fn as_status(self) -> &'static str {
        match self {
            Self::Approve => "approved",
            Self::Revise => "revision_requested",
            Self::Reject => "rejected",
        }
    }
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
    runtimes: tokio::sync::Mutex<HashMap<String, ActiveLoopRuntime>>,
}

#[derive(Clone)]
struct ActiveLoopRuntime {
    runtime: Arc<dyn LoopAgentRuntime>,
    cancelled: Arc<AtomicBool>,
}

impl LoopManager {
    pub fn new() -> Self {
        Self {
            runtimes: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn register(
        &self,
        run_id: &str,
        runtime: Arc<dyn LoopAgentRuntime>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut runtimes = self.runtimes.lock().await;
        if runtimes.contains_key(run_id) {
            return Err(format!("Loop run already has an executor: {run_id}"));
        }
        runtimes.insert(run_id.to_string(), ActiveLoopRuntime { runtime, cancelled });
        Ok(())
    }

    async fn unregister(&self, run_id: &str) {
        self.runtimes.lock().await.remove(run_id);
    }

    async fn abort(&self, run_id: &str) -> Result<(), String> {
        let active = self.runtimes.lock().await.get(run_id).cloned();
        if let Some(active) = active {
            active.cancelled.store(true, Ordering::Release);
            active.runtime.abort_all().await
        } else {
            Ok(())
        }
    }

    pub(crate) async fn abort_all(&self) -> Result<(), String> {
        let active = self
            .runtimes
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for run in active {
            run.cancelled.store(true, Ordering::Release);
            if let Err(error) = run.runtime.abort_all().await {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    async fn is_active(&self, run_id: &str) -> bool {
        self.runtimes.lock().await.contains_key(run_id)
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
            human_approval_prompt TEXT,
            verifier_program TEXT,
            verifier_args_json TEXT NOT NULL DEFAULT '[]',
            verifier_cwd TEXT,
            verifier_timeout_seconds INTEGER,
            run_timeout_seconds INTEGER NOT NULL,
            max_task_iterations INTEGER NOT NULL DEFAULT 2,
            enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
            ,definition_id TEXT
            ,definition_path TEXT
            ,definition_hash TEXT
            ,definition_name TEXT
            ,objective TEXT
            ,portable INTEGER
            ,definition_yaml TEXT
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
            ,definition_hash TEXT
            ,definition_yaml TEXT
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
            ordinal INTEGER NOT NULL,
            worker_result TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            definition_id TEXT NOT NULL DEFAULT ''
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

        CREATE TABLE IF NOT EXISTS loop_approvals (
            id TEXT PRIMARY KEY,
            loop_task_id TEXT NOT NULL REFERENCES loop_tasks(id) ON DELETE CASCADE,
            attempt INTEGER NOT NULL,
            status TEXT NOT NULL,
            prompt TEXT NOT NULL,
            feedback TEXT,
            created_at TEXT NOT NULL,
            decided_at TEXT
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
            ON loop_tasks(loop_run_id, ordinal);
        CREATE INDEX IF NOT EXISTS loop_events_run_idx
            ON loop_events(loop_run_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS loop_approvals_task_attempt_idx
            ON loop_approvals(loop_task_id, attempt);
        ",
    )?;
    for migration in [
        "ALTER TABLE loop_tasks ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE loop_specs ADD COLUMN definition_id TEXT",
        "ALTER TABLE loop_specs ADD COLUMN definition_path TEXT",
        "ALTER TABLE loop_specs ADD COLUMN definition_hash TEXT",
        "ALTER TABLE loop_specs ADD COLUMN definition_name TEXT",
        "ALTER TABLE loop_specs ADD COLUMN objective TEXT",
        "ALTER TABLE loop_specs ADD COLUMN portable INTEGER",
        "ALTER TABLE loop_specs ADD COLUMN definition_yaml TEXT",
        "ALTER TABLE loop_specs ADD COLUMN verifier_timeout_seconds INTEGER",
        "ALTER TABLE loop_runs ADD COLUMN definition_hash TEXT",
        "ALTER TABLE loop_runs ADD COLUMN definition_yaml TEXT",
        "ALTER TABLE loop_tasks ADD COLUMN definition_id TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE loop_specs ADD COLUMN human_approval_prompt TEXT",
    ] {
        let _ = conn.execute_batch(migration);
    }
    conn.execute_batch(
        "DROP INDEX IF EXISTS loop_tasks_occupied_key_unique;
         CREATE UNIQUE INDEX loop_tasks_occupied_key_unique
         ON loop_tasks(loop_spec_id, definition_id, task_key)
         WHERE state IN ('queued', 'working', 'verifying', 'evaluating', 'awaiting_approval', 'accepted');",
    )?;
    Ok(())
}

fn validate_spec(input: &LoopSpecInput) -> Result<(), String> {
    if input.orchestrator_prompt.trim().is_empty() || input.worker_prompt.trim().is_empty() {
        return Err("Orchestrator and worker prompts are required".to_string());
    }
    if input
        .evaluator_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.trim().is_empty())
    {
        return Err("Evaluator prompt cannot be blank".to_string());
    }
    if input.evaluator_prompt.is_none() && input.evaluator_model.is_some() {
        return Err("Evaluator model requires an evaluator prompt".to_string());
    }
    if input
        .human_approval_prompt
        .as_deref()
        .is_some_and(|prompt| prompt.trim().is_empty())
    {
        return Err("Human approval prompt cannot be blank".to_string());
    }
    if input.evaluator_prompt.is_none()
        && input.verifier_program.is_none()
        && input.human_approval_prompt.is_none()
    {
        return Err(
            "At least one verification, evaluator, or human approval must be configured"
                .to_string(),
        );
    }
    if input.run_timeout_seconds == 0 {
        return Err("Run timeout must be greater than zero".to_string());
    }
    if input.max_task_iterations != 2 {
        return Err("MVP1 supports exactly two task attempts".to_string());
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
    let args_json: String = row.get(10)?;
    let verifier_args = serde_json::from_str(&args_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(LoopSpec {
        id: row.get(0)?,
        workstream_id: row.get(1)?,
        orchestrator_prompt: row.get(2)?,
        worker_prompt: row.get(3)?,
        evaluator_prompt: {
            let prompt: String = row.get(4)?;
            (!prompt.trim().is_empty()).then_some(prompt)
        },
        orchestrator_model: row.get(5)?,
        worker_model: row.get(6)?,
        evaluator_model: row.get(7)?,
        human_approval_prompt: row.get(8)?,
        verifier_program: row.get(9)?,
        verifier_args,
        verifier_cwd: row.get(11)?,
        verifier_timeout_seconds: row.get(12)?,
        run_timeout_seconds: row.get(13)?,
        max_task_iterations: row.get(14)?,
        enabled: row.get::<_, i64>(15)? != 0,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        definition_id: row.get(18)?,
        definition_path: row.get(19)?,
        definition_hash: row.get(20)?,
        definition_name: row.get(21)?,
        objective: row.get(22)?,
        portable: row.get::<_, Option<i64>>(23)?.map(|value| value != 0),
        definition_yaml: row.get(24)?,
    })
}

const SPEC_COLUMNS: &str = "id, workstream_id, orchestrator_prompt, worker_prompt,
    evaluator_prompt, orchestrator_model, worker_model, evaluator_model,
    human_approval_prompt, verifier_program, verifier_args_json, verifier_cwd, verifier_timeout_seconds,
    run_timeout_seconds, max_task_iterations, enabled, created_at, updated_at, definition_id,
    definition_path, definition_hash, definition_name, objective, portable,
    definition_yaml";

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
            orchestrator_model, worker_model, evaluator_model, human_approval_prompt, verifier_program,
            verifier_args_json, verifier_cwd, run_timeout_seconds,
            verifier_timeout_seconds, max_task_iterations, enabled, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 0, ?16, ?17
         )
         ON CONFLICT(workstream_id) DO UPDATE SET
            orchestrator_prompt = excluded.orchestrator_prompt,
            worker_prompt = excluded.worker_prompt,
            evaluator_prompt = excluded.evaluator_prompt,
            orchestrator_model = excluded.orchestrator_model,
            worker_model = excluded.worker_model,
            evaluator_model = excluded.evaluator_model,
            human_approval_prompt = excluded.human_approval_prompt,
            verifier_program = excluded.verifier_program,
            verifier_args_json = excluded.verifier_args_json,
            verifier_cwd = excluded.verifier_cwd,
            verifier_timeout_seconds = excluded.verifier_timeout_seconds,
            run_timeout_seconds = excluded.run_timeout_seconds,
            max_task_iterations = excluded.max_task_iterations,
            updated_at = excluded.updated_at",
        params![
            id,
            workstream_id,
            input.orchestrator_prompt.trim(),
            input.worker_prompt.trim(),
            input
                .evaluator_prompt
                .as_deref()
                .map(str::trim)
                .unwrap_or(""),
            input.orchestrator_model,
            input.worker_model,
            input.evaluator_model,
            input.human_approval_prompt.as_deref().map(str::trim),
            input.verifier_program,
            args_json,
            input.verifier_cwd,
            input.run_timeout_seconds,
            input.verifier_timeout_seconds,
            input.max_task_iterations,
            created_at,
            updated_at,
        ],
    )
    .map_err(|error| format!("Failed to save loop specification: {error}"))?;
    get_loop_spec(conn, workstream_id)?
        .ok_or_else(|| "Saved loop specification could not be reloaded".to_string())
}

pub struct MaterializedLoopDefinition {
    pub definition_id: String,
    pub definition_path: String,
    pub definition_hash: String,
    pub definition_name: String,
    pub objective: String,
    pub portable: bool,
    pub yaml: String,
    pub spec: LoopSpecInput,
}

fn inherited_model(value: &str) -> Option<String> {
    (!value.eq_ignore_ascii_case("inherit")).then(|| value.to_string())
}

fn worker_prompt_from_definition(fields: &crate::loop_definition::LoopSpecInputFields) -> String {
    let mut sections = vec![fields.worker_prompt.clone()];
    if !fields.worker_skills.is_empty() {
        sections.push(format!(
            "Required skills:\n{}",
            fields
                .worker_skills
                .iter()
                .map(|skill| format!("- {skill}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !fields.worker_context_files.is_empty() {
        sections.push(format!(
            "Read these context files before editing:\n{}",
            fields
                .worker_context_files
                .iter()
                .map(|path| format!("- {path}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !fields.worker_golden_patterns.is_empty() {
        sections.push(format!(
            "Follow these golden pattern files:\n{}",
            fields
                .worker_golden_patterns
                .iter()
                .map(|path| format!("- {path}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    sections.join("\n\n")
}

pub(crate) fn definition_to_materialized(
    definition: crate::loop_definition::ValidatedLoopDefinition,
    yaml: String,
) -> MaterializedLoopDefinition {
    let fields = definition.to_loop_spec_input_fields();
    MaterializedLoopDefinition {
        definition_id: fields.definition_id.clone(),
        definition_path: definition.path.to_string_lossy().into_owned(),
        definition_hash: definition.hash.clone(),
        definition_name: fields.name.clone(),
        objective: fields.objective.clone(),
        portable: definition.portable,
        yaml,
        spec: LoopSpecInput {
            orchestrator_prompt: format!(
                "{}\n\nReturn at most {} task.",
                fields.orchestrator_prompt, fields.max_tasks_per_run
            ),
            worker_prompt: worker_prompt_from_definition(&fields),
            evaluator_prompt: fields.evaluator_prompt,
            orchestrator_model: inherited_model(&fields.orchestrator_model),
            worker_model: inherited_model(&fields.worker_model),
            evaluator_model: fields.evaluator_model.as_deref().and_then(inherited_model),
            human_approval_prompt: fields.human_approval_prompt,
            verifier_program: fields.verifier_program,
            verifier_args: fields.verifier_args.unwrap_or_default(),
            verifier_cwd: fields.verifier_cwd,
            verifier_timeout_seconds: fields.verifier_timeout_seconds,
            run_timeout_seconds: fields.run_timeout_seconds,
            max_task_iterations: fields.task_attempts,
        },
    }
}

pub fn materialize_loop_definition(
    conn: &Connection,
    workstream_id: &str,
    definition: MaterializedLoopDefinition,
) -> Result<LoopSpec, String> {
    validate_spec(&definition.spec)?;
    let active: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_runs r
             JOIN loop_specs s ON s.id = r.loop_spec_id
             WHERE s.workstream_id = ?1
               AND r.state NOT IN ('completed', 'attention', 'killed')",
            [workstream_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to check active definition run: {error}"))?;
    if active > 0 {
        return Err("Stop the active loop run before selecting another definition".to_string());
    }

    let existing = get_loop_spec(conn, workstream_id)?;
    let id = existing
        .as_ref()
        .map(|spec| spec.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = existing
        .as_ref()
        .map(|spec| spec.created_at.clone())
        .unwrap_or_else(crate::now);
    let updated_at = crate::now();
    let args_json = serde_json::to_string(&definition.spec.verifier_args)
        .map_err(|error| format!("Failed to encode verifier arguments: {error}"))?;
    conn.execute(
        "INSERT INTO loop_specs (
            id, workstream_id, orchestrator_prompt, worker_prompt, evaluator_prompt,
            orchestrator_model, worker_model, evaluator_model, human_approval_prompt, verifier_program,
            verifier_args_json, verifier_cwd, run_timeout_seconds,
            verifier_timeout_seconds, max_task_iterations, enabled, created_at, updated_at, definition_id,
            definition_path, definition_hash, definition_name, objective, portable,
            definition_yaml
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1,
            ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
         )
         ON CONFLICT(workstream_id) DO UPDATE SET
            orchestrator_prompt = excluded.orchestrator_prompt,
            worker_prompt = excluded.worker_prompt,
            evaluator_prompt = excluded.evaluator_prompt,
            orchestrator_model = excluded.orchestrator_model,
            worker_model = excluded.worker_model,
            evaluator_model = excluded.evaluator_model,
            human_approval_prompt = excluded.human_approval_prompt,
            verifier_program = excluded.verifier_program,
            verifier_args_json = excluded.verifier_args_json,
            verifier_cwd = excluded.verifier_cwd,
            verifier_timeout_seconds = excluded.verifier_timeout_seconds,
            run_timeout_seconds = excluded.run_timeout_seconds,
            max_task_iterations = excluded.max_task_iterations,
            enabled = 1,
            definition_id = excluded.definition_id,
            definition_path = excluded.definition_path,
            definition_hash = excluded.definition_hash,
            definition_name = excluded.definition_name,
            objective = excluded.objective,
            portable = excluded.portable,
            definition_yaml = excluded.definition_yaml,
            updated_at = excluded.updated_at",
        params![
            id,
            workstream_id,
            definition.spec.orchestrator_prompt.trim(),
            definition.spec.worker_prompt.trim(),
            definition
                .spec
                .evaluator_prompt
                .as_deref()
                .map(str::trim)
                .unwrap_or(""),
            definition.spec.orchestrator_model,
            definition.spec.worker_model,
            definition.spec.evaluator_model,
            definition.spec.human_approval_prompt.as_deref().map(str::trim),
            definition.spec.verifier_program,
            args_json,
            definition.spec.verifier_cwd,
            definition.spec.run_timeout_seconds,
            definition.spec.verifier_timeout_seconds,
            definition.spec.max_task_iterations,
            created_at,
            updated_at,
            definition.definition_id,
            definition.definition_path,
            definition.definition_hash,
            definition.definition_name,
            definition.objective,
            i64::from(definition.portable),
            definition.yaml,
        ],
    )
    .map_err(|error| format!("Failed to bind loop definition: {error}"))?;
    get_loop_spec(conn, workstream_id)?
        .ok_or_else(|| "Bound loop definition could not be reloaded".to_string())
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
        definition_hash: row.get(9)?,
        definition_yaml: row.get(10)?,
    })
}

const RUN_COLUMNS: &str = "id, loop_spec_id, state, current_task_id,
    control_requested, error, started_at, finished_at, deadline_at,
    definition_hash, definition_yaml";

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
            id, loop_spec_id, state, control_requested, started_at, deadline_at,
            definition_hash, definition_yaml
         ) VALUES (?1, ?2, 'starting', 'none', ?3, ?4, ?5, ?6)",
        params![
            id,
            loop_spec_id,
            started_at,
            deadline_at,
            spec.definition_hash,
            spec.definition_yaml
        ],
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
             WHERE id = ?4
               AND (state NOT IN ('completed', 'attention', 'killed') OR state = ?1)",
            params![state.as_str(), error, finished_at, run_id],
        )
        .map_err(|db_error| format!("Failed to update loop run: {db_error}"))?;
    if changed == 0 {
        let current: Option<String> = conn
            .query_row(
                "SELECT state FROM loop_runs WHERE id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|db_error| format!("Failed to inspect loop run: {db_error}"))?;
        return match current {
            Some(current) => Err(format!(
                "Loop run {run_id} is terminal ({current}) and cannot transition to {}",
                state.as_str()
            )),
            None => Err(format!("Loop run not found: {run_id}")),
        };
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

fn claim_paused_run(conn: &Connection, run_id: &str) -> Result<LoopRun, String> {
    let claimed = conn
        .execute(
            "UPDATE loop_runs
             SET state = 'resuming', control_requested = 'none'
             WHERE id = ?1 AND state = 'paused'",
            [run_id],
        )
        .map_err(|error| format!("Failed to claim paused loop run: {error}"))?;
    if claimed != 1 {
        return Err("This loop run is not paused or is already resuming".to_string());
    }
    get_loop_run(conn, run_id)?
        .ok_or_else(|| format!("Loop run not found after resume claim: {run_id}"))
}

pub(crate) fn transition_unfinished_tasks(
    conn: &Connection,
    run_id: &str,
    state: LoopTaskState,
    error: &str,
) -> Result<usize, String> {
    conn.execute(
        "UPDATE loop_tasks
         SET state = ?1, error = ?2, updated_at = ?3
         WHERE loop_run_id = ?4
           AND state IN ('queued', 'working', 'verifying', 'evaluating', 'awaiting_approval')",
        params![state.as_str(), error, crate::now(), run_id],
    )
    .map_err(|db_error| format!("Failed to transition unfinished loop tasks: {db_error}"))
}

fn finish_run_from_persisted_tasks(conn: &Connection, run_id: &str) -> Result<(), String> {
    let attention_tasks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_tasks
             WHERE loop_run_id = ?1
               AND state IN ('blocked', 'attention', 'interrupted')",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to derive loop disposition: {error}"))?;
    if attention_tasks > 0 {
        set_run_state(
            conn,
            run_id,
            LoopRunState::Attention,
            Some("One or more tasks require human attention"),
        )
    } else {
        set_run_state(conn, run_id, LoopRunState::Completed, None)
    }
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
            transition_unfinished_tasks(
                conn,
                run_id,
                LoopTaskState::Blocked,
                "Loop stopped before this task started",
            )?;
            finish_run_from_persisted_tasks(conn, run_id)?;
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
    let definition_id: String = conn
        .query_row(
            "SELECT COALESCE(definition_id, '') FROM loop_specs WHERE id = ?1",
            [loop_spec_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to load loop definition identity: {error}"))?;
    let occupied: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_tasks
             WHERE loop_spec_id = ?1 AND definition_id = ?2 AND task_key = ?3
               AND state IN ('queued', 'working', 'verifying', 'evaluating', 'accepted')",
            params![loop_spec_id, definition_id, task.key.trim()],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to check loop task identity: {error}"))?;
    if occupied > 0 {
        append_loop_event(
            conn,
            loop_spec_id,
            run_id,
            None,
            "task.deduplicated",
            &serde_json::json!({ "key": task.key.trim() }),
        )?;
        return Ok(None);
    }
    let ordinal: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM loop_tasks WHERE loop_run_id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to allocate loop task order: {error}"))?;
    let id = Uuid::new_v4().to_string();
    let now = crate::now();
    let changed = conn
        .execute(
            "INSERT INTO loop_tasks (
                id, loop_run_id, loop_spec_id, task_key, title, objective,
                state, ordinal, created_at, updated_at, definition_id
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', ?7, ?8, ?8, ?9)",
            params![
                id,
                run_id,
                loop_spec_id,
                task.key.trim(),
                task.title.trim(),
                task.objective.trim(),
                ordinal,
                now,
                definition_id,
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
             WHERE loop_run_id = ?1 ORDER BY ordinal"
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
             WHERE id = ?4
               AND (
                   state NOT IN ('accepted', 'blocked', 'attention', 'interrupted')
                   OR state = ?1
               )",
            params![state.as_str(), worker_session_id, crate::now(), task_id],
        )
        .map_err(|error| format!("Failed to update loop task: {error}"))?;
    if changed == 0 {
        let current: Option<String> = conn
            .query_row(
                "SELECT state FROM loop_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("Failed to inspect loop task: {error}"))?;
        return match current {
            Some(current) => Err(format!(
                "Loop task {task_id} is terminal ({current}) and cannot transition to {}",
                state.as_str()
            )),
            None => Err(format!("Loop task not found: {task_id}")),
        };
    }
    Ok(())
}

pub fn reconcile_interrupted_runs(conn: &Connection) -> Result<usize, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_runs
             WHERE state NOT IN ('completed', 'attention', 'killed', 'awaiting_approval')",
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
             WHERE state NOT IN ('completed', 'attention', 'killed', 'awaiting_approval')
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
         WHERE state NOT IN ('completed', 'attention', 'killed', 'awaiting_approval')",
        [crate::now()],
    )
    .map_err(|error| format!("Failed to reconcile loop runs: {error}"))?;
    Ok(count as usize)
}

fn parse_structured_agent_json<T: DeserializeOwned>(
    content: &str,
    role: &str,
) -> Result<T, String> {
    let trimmed = content.trim();
    match serde_json::from_str(trimmed) {
        Ok(output) => Ok(output),
        Err(raw_error) => {
            let mut spans = Vec::new();
            let mut start = None;
            let mut depth = 0_u32;
            let mut in_string = false;
            let mut escaped = false;
            for (index, character) in trimmed.char_indices() {
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if character == '\\' {
                        escaped = true;
                    } else if character == '"' {
                        in_string = false;
                    }
                    continue;
                }
                match character {
                    '"' if depth > 0 => in_string = true,
                    '{' => {
                        if depth == 0 {
                            start = Some(index);
                        }
                        depth += 1;
                    }
                    '}' if depth > 0 => {
                        depth -= 1;
                        if depth == 0 {
                            spans.push((start.take().expect("object start"), index + 1));
                        }
                    }
                    _ => {}
                }
            }
            if depth != 0 || in_string {
                return Err(format!(
                    "{role} returned malformed embedded JSON ({raw_error})"
                ));
            }
            let mut candidates = Vec::new();
            for (start, end) in spans {
                if let Ok(value) = serde_json::from_str::<T>(&trimmed[start..end]) {
                    candidates.push(value);
                }
            }
            if candidates.len() != 1 {
                return Err(format!(
                    "{role} returned invalid JSON ({raw_error}); expected raw JSON or exactly one matching JSON object"
                ));
            }
            Ok(candidates.remove(0))
        }
    }
}

pub fn parse_discovered_tasks(content: &str) -> Result<Vec<DiscoveredTask>, String> {
    let output: OrchestratorOutput = parse_structured_agent_json(content, "Orchestrator")
        .map_err(|error| error.replace("invalid JSON", "invalid task JSON"))?;
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
    let output: WorkerOutput = parse_structured_agent_json(content, "Worker")
        .map_err(|error| error.replace("invalid JSON", "invalid result JSON"))?;
    if output.summary.trim().is_empty() {
        return Err("Worker result requires a non-empty summary".to_string());
    }
    Ok(output)
}

fn parse_evaluator_output(content: &str) -> Result<EvaluatorOutput, String> {
    let output: EvaluatorOutput = parse_structured_agent_json(content, "Evaluator")
        .map_err(|error| error.replace("invalid JSON", "invalid verdict JSON"))?;
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
    const MAX_EVENT_PAYLOAD_BYTES: usize = 16 * 1024;
    let encoded = payload.to_string();
    let payload_json = if encoded.len() <= MAX_EVENT_PAYLOAD_BYTES {
        encoded
    } else {
        let preview_end = encoded
            .char_indices()
            .take_while(|(index, _)| *index < MAX_EVENT_PAYLOAD_BYTES / 2)
            .map(|(index, character)| index + character.len_utf8())
            .last()
            .unwrap_or(0);
        serde_json::json!({
            "truncated": true,
            "original_bytes": encoded.len(),
            "preview": &encoded[..preview_end],
        })
        .to_string()
    };
    conn.execute(
        "INSERT INTO loop_events (
            loop_spec_id, loop_run_id, loop_task_id, event_type, payload_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            loop_spec_id,
            run_id,
            task_id,
            event_type,
            payload_json,
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
        if !should_persist_agent_event(&event.event_type) {
            continue;
        }
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

fn should_persist_agent_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "session.started"
            | "session.idle"
            | "session.task_complete"
            | "session.error"
            | "assistant.message"
            | "assistant.turn_start"
            | "assistant.turn_end"
            | "tool.execution_start"
            | "tool.execution_complete"
            | "model.call_failure"
            | "abort"
            | "events.lagged"
    )
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
                    if should_persist_agent_event(&event.event_type) {
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
                    if should_persist_agent_event(&event.event_type) {
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
) -> Result<String, String> {
    let program = spec
        .verifier_program
        .as_deref()
        .ok_or_else(|| "Cannot record a verifier that is not configured".to_string())?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO loop_verifications (
            id, loop_task_id, attempt, status, program, args_json, cwd,
            program_hash, exit_code, duration_ms, stdout, stderr, truncated,
            created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
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
    Ok(id)
}

async fn verify_task(
    db: &Arc<Mutex<Connection>>,
    spec: &LoopSpec,
    run_id: &str,
    task_id: &str,
    working_directory: &Path,
    attempt: u32,
    cancelled: Option<Arc<AtomicBool>>,
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
        timeout: Duration::from_secs(
            spec.verifier_timeout_seconds
                .unwrap_or(remaining_run_timeout(db, run_id)?.as_secs())
                .min(remaining_run_timeout(db, run_id)?.as_secs()),
        ),
        output_limit_bytes: 256 * 1024,
        cancelled,
    })
    .await;
    let conn = db.lock().unwrap();
    let verification_id = record_verification(&conn, task_id, attempt, spec, &result)?;
    append_loop_event(
        &conn,
        &spec.id,
        run_id,
        Some(task_id),
        "verification.completed",
        &serde_json::json!({
            "verification_id": verification_id,
            "status": result.status,
            "attempt": attempt,
        }),
    )?;
    Ok(Some(result))
}

fn orchestrator_prompt(spec: &LoopSpec) -> String {
    format!(
        "{}\n\nReturn only JSON with this shape:\n\
         {{\"tasks\":[{{\"key\":\"stable-id\",\"title\":\"short title\",\
         \"objective\":\"complete coding objective\"}}]}}\n\
         Return {{\"tasks\":[]}} when no work is available.\n\
         Do not include Markdown code fences or explanatory prose.",
        spec.orchestrator_prompt
    )
}

fn worker_prompt(spec: &LoopSpec, task: &LoopTask) -> String {
    format!(
        "{}\n\nTask: {}\nObjective: {}\n\n\
         Complete the coding task in the current worktree. Return only JSON:\n\
         {{\"status\":\"completed|blocked|failed\",\"summary\":\"what happened\",\
         \"evidence\":[\"observable evidence\"]}}\n\
         Do not include Markdown code fences or explanatory prose.",
        spec.worker_prompt, task.title, task.objective
    )
}

fn evaluator_prompt(
    spec: &LoopSpec,
    task: &LoopTask,
    worker: &WorkerOutput,
    verification: Option<&VerificationResult>,
) -> String {
    let evaluator_instructions = spec
        .evaluator_prompt
        .as_deref()
        .expect("evaluator_prompt is checked before evaluating");
    format!(
        "{}\n\nTask: {}\nObjective: {}\nWorker summary: {}\nEvidence: {}\n\
         Deterministic verification: {}\n\n\
         Independently inspect the work with read-only actions. Return only JSON:\n\
         {{\"verdict\":\"accepted|revise|blocked|invalid\",\
         \"summary\":\"judgment\",\"feedback\":null,\"evidence\":[]}}.\n\
         A revise verdict must include actionable feedback.\n\
         Do not include Markdown code fences or explanatory prose.",
        evaluator_instructions,
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

fn human_revision_prompt(spec: &LoopSpec, task: &LoopTask, feedback: &str) -> String {
    format!(
        "{}\n\nTask: {}\nObjective: {}\n\n\
         The human reviewer requested one revision:\n{}\n\n\
         Address the feedback, re-run relevant checks, and return only JSON:\n\
         {{\"status\":\"completed|blocked|failed\",\"summary\":\"what changed\",\
         \"evidence\":[\"observable evidence\"]}}",
        spec.worker_prompt, task.title, task.objective, feedback
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

fn enter_human_approval(
    conn: &Connection,
    spec: &LoopSpec,
    run_id: &str,
    task: &LoopTask,
) -> Result<(), String> {
    let prompt = spec
        .human_approval_prompt
        .as_deref()
        .ok_or_else(|| "Human approval is not configured".to_string())?;
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("Failed to start human approval request: {error}"))?;
    let revision_count: u32 = transaction
        .query_row(
            "SELECT revision_count FROM loop_tasks WHERE id = ?1",
            [&task.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to load approval attempt: {error}"))?;
    let attempt = revision_count + 1;
    set_task_state(
        &transaction,
        &task.id,
        LoopTaskState::AwaitingApproval,
        None,
    )?;
    set_run_state(&transaction, run_id, LoopRunState::AwaitingApproval, None)?;
    transaction
        .execute(
            "INSERT INTO loop_approvals (
            id, loop_task_id, attempt, status, prompt, created_at
         ) VALUES (?1, ?2, ?3, 'pending', ?4, ?5)",
            params![
                Uuid::new_v4().to_string(),
                task.id,
                attempt,
                prompt,
                crate::now(),
            ],
        )
        .map_err(|error| format!("Failed to create human approval request: {error}"))?;
    append_loop_event(
        &transaction,
        &spec.id,
        run_id,
        Some(&task.id),
        "approval.requested",
        &serde_json::json!({ "attempt": attempt }),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit human approval request: {error}"))
}

pub fn decide_human_approval(
    conn: &Connection,
    run_id: &str,
    decision: HumanApprovalDecision,
    feedback: Option<&str>,
) -> Result<LoopRun, String> {
    let feedback = feedback.map(str::trim).filter(|value| !value.is_empty());
    if decision == HumanApprovalDecision::Revise && feedback.is_none() {
        return Err("Revision feedback is required".to_string());
    }
    let transaction = conn
        .unchecked_transaction()
        .map_err(|error| format!("Failed to start approval decision: {error}"))?;
    let run = get_loop_run(&transaction, run_id)?
        .ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    if run.state != LoopRunState::AwaitingApproval {
        return Err("This loop run is not awaiting human approval".to_string());
    }
    let task_id = run
        .current_task_id
        .as_deref()
        .ok_or_else(|| "Human approval run has no active task".to_string())?;
    let task = transaction
        .query_row(
            &format!("SELECT {TASK_COLUMNS} FROM loop_tasks WHERE id = ?1"),
            [task_id],
            decode_task_row,
        )
        .map_err(|error| format!("Failed to load approval task: {error}"))?;
    if task.state != LoopTaskState::AwaitingApproval {
        return Err("The active task is not awaiting human approval".to_string());
    }
    if decision == HumanApprovalDecision::Revise && task.revision_count + 1 >= 2 {
        return Err("Human approval supports at most one revision".to_string());
    }
    let approval_id: String = transaction
        .query_row(
            "SELECT id FROM loop_approvals
             WHERE loop_task_id = ?1 AND status = 'pending'
             ORDER BY attempt DESC LIMIT 1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Pending human approval was not found: {error}"))?;
    let decided_at = crate::now();
    let changed = transaction
        .execute(
            "UPDATE loop_approvals
             SET status = ?1, feedback = ?2, decided_at = ?3
             WHERE id = ?4 AND status = 'pending'",
            params![decision.as_status(), feedback, decided_at, approval_id],
        )
        .map_err(|error| format!("Failed to record approval decision: {error}"))?;
    if changed != 1 {
        return Err("Human approval was already decided".to_string());
    }

    match decision {
        HumanApprovalDecision::Approve => {
            transaction
                .execute(
                    "UPDATE loop_tasks SET state = 'accepted', error = NULL, updated_at = ?1
                     WHERE id = ?2",
                    params![decided_at, task_id],
                )
                .map_err(|error| format!("Failed to accept approved task: {error}"))?;
            let queued_tasks: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM loop_tasks
                     WHERE loop_run_id = ?1 AND state = 'queued'",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Failed to count queued approval tasks: {error}"))?;
            if queued_tasks > 0 {
                let timeout_seconds: u64 = transaction
                    .query_row(
                        "SELECT s.run_timeout_seconds
                         FROM loop_specs s JOIN loop_runs r ON r.loop_spec_id = s.id
                         WHERE r.id = ?1",
                        [run_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("Failed to load continuation timeout: {error}"))?;
                let deadline_at = std::time::SystemTime::now()
                    .checked_add(Duration::from_secs(timeout_seconds))
                    .and_then(|deadline| deadline.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs().to_string())
                    .ok_or_else(|| "Failed to calculate the continuation deadline".to_string())?;
                transaction
                    .execute(
                        "UPDATE loop_runs
                         SET state = 'resuming', current_task_id = NULL,
                             control_requested = 'none', error = NULL, finished_at = NULL,
                             deadline_at = ?1
                         WHERE id = ?2",
                        params![deadline_at, run_id],
                    )
                    .map_err(|error| format!("Failed to continue approved run: {error}"))?;
            } else {
                transaction
                    .execute(
                        "UPDATE loop_runs
                         SET current_task_id = NULL, control_requested = 'none', error = NULL
                         WHERE id = ?1",
                        [run_id],
                    )
                    .map_err(|error| format!("Failed to finalize approved run: {error}"))?;
                finish_run_from_persisted_tasks(&transaction, run_id)?;
            }
        }
        HumanApprovalDecision::Reject => {
            transaction
                .execute(
                    "UPDATE loop_tasks
                     SET state = 'blocked', error = ?1, updated_at = ?2
                     WHERE id = ?3",
                    params![
                        feedback.unwrap_or("Human reviewer rejected the task"),
                        decided_at,
                        task_id
                    ],
                )
                .map_err(|error| format!("Failed to reject approval task: {error}"))?;
            transaction
                .execute(
                    "UPDATE loop_runs
                     SET state = 'attention', control_requested = 'none', error = ?1,
                         finished_at = ?2
                     WHERE id = ?3",
                    params![
                        feedback.unwrap_or("Human reviewer rejected the task"),
                        decided_at,
                        run_id
                    ],
                )
                .map_err(|error| format!("Failed to reject approval run: {error}"))?;
        }
        HumanApprovalDecision::Revise => {
            let timeout_seconds: u64 = transaction
                .query_row(
                    "SELECT s.run_timeout_seconds
                     FROM loop_specs s JOIN loop_runs r ON r.loop_spec_id = s.id
                     WHERE r.id = ?1",
                    [run_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("Failed to load revision timeout: {error}"))?;
            let deadline_at = std::time::SystemTime::now()
                .checked_add(Duration::from_secs(timeout_seconds))
                .and_then(|deadline| deadline.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs().to_string())
                .ok_or_else(|| "Failed to calculate the revision deadline".to_string())?;
            transaction
                .execute(
                    "UPDATE loop_tasks
                     SET state = 'working', revision_count = revision_count + 1,
                         worker_session_id = NULL, error = NULL, updated_at = ?1
                     WHERE id = ?2",
                    params![decided_at, task_id],
                )
                .map_err(|error| format!("Failed to claim approval revision task: {error}"))?;
            transaction
                .execute(
                    "UPDATE loop_runs
                     SET state = 'resuming', control_requested = 'none', error = NULL,
                         finished_at = NULL, deadline_at = ?1
                     WHERE id = ?2",
                    params![deadline_at, run_id],
                )
                .map_err(|error| format!("Failed to claim approval revision run: {error}"))?;
        }
    }
    append_loop_event(
        &transaction,
        &task.loop_spec_id,
        run_id,
        Some(task_id),
        "approval.decided",
        &serde_json::json!({
            "decision": decision,
            "approval_id": approval_id,
        }),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit approval decision: {error}"))?;
    get_loop_run(conn, run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))
}

async fn execute_human_revision_inner(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
    feedback: &str,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let run = get_loop_run(&db.lock().unwrap(), run_id)?
        .ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    if run.state != LoopRunState::Resuming {
        return Err("Human revision run is not claimed".to_string());
    }
    let spec = get_loop_spec_by_id(&db.lock().unwrap(), &run.loop_spec_id)?
        .ok_or_else(|| format!("Loop specification not found: {}", run.loop_spec_id))?;
    let task_id = run
        .current_task_id
        .as_deref()
        .ok_or_else(|| "Human revision run has no active task".to_string())?;
    let task = list_loop_tasks(&db.lock().unwrap(), run_id)?
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| "Human revision task was not found".to_string())?;
    if !apply_human_revision_control_boundary(&db.lock().unwrap(), run_id)? {
        return Ok(());
    }
    let response = start_agent_stage(
        &db,
        &runtime,
        AgentRequest {
            role: AgentRole::Worker,
            prompt: human_revision_prompt(&spec, &task, feedback),
            working_directory: working_directory.clone(),
            model: spec.worker_model.clone(),
            timeout: remaining_run_timeout(&db, run_id)?,
            keep_session: false,
        },
        &spec.id,
        run_id,
        Some(&task.id),
    )
    .await?;
    let worker = parse_worker_output(&response.content)?;
    store_worker_result(
        &db.lock().unwrap(),
        &task.id,
        &response.session_id,
        &worker,
        task.revision_count,
    )?;
    if worker.status != WorkerStatus::Completed {
        let state = if worker.status == WorkerStatus::Blocked {
            LoopTaskState::Blocked
        } else {
            LoopTaskState::Attention
        };
        set_task_state(&db.lock().unwrap(), &task.id, state, None)?;
        finish_run_from_persisted_tasks(&db.lock().unwrap(), run_id)?;
        return Ok(());
    }
    if !apply_human_revision_control_boundary(&db.lock().unwrap(), run_id)? {
        return Ok(());
    }
    let verification = verify_task(
        &db,
        &spec,
        run_id,
        &task.id,
        &working_directory,
        task.revision_count + 1,
        cancelled,
    )
    .await?;
    if verification
        .as_ref()
        .is_some_and(|result| result.status != VerificationStatus::Passed)
    {
        set_task_state(
            &db.lock().unwrap(),
            &task.id,
            LoopTaskState::Attention,
            None,
        )?;
        finish_run_from_persisted_tasks(&db.lock().unwrap(), run_id)?;
        return Ok(());
    }
    if !apply_human_revision_control_boundary(&db.lock().unwrap(), run_id)? {
        return Ok(());
    }
    if spec.evaluator_prompt.is_some() {
        let verdict = evaluate_task(
            EvaluationContext {
                db: &db,
                runtime: &runtime,
                spec: &spec,
                run_id,
                task: &task,
                working_directory: &working_directory,
            },
            &worker,
            verification.as_ref(),
            task.revision_count + 1,
        )
        .await?;
        if verdict.verdict != EvaluatorVerdict::Accepted {
            let state = if verdict.verdict == EvaluatorVerdict::Blocked {
                LoopTaskState::Blocked
            } else {
                LoopTaskState::Attention
            };
            set_task_state(&db.lock().unwrap(), &task.id, state, None)?;
            finish_run_from_persisted_tasks(&db.lock().unwrap(), run_id)?;
            return Ok(());
        }
    }
    if !apply_human_revision_control_boundary(&db.lock().unwrap(), run_id)? {
        return Ok(());
    }
    enter_human_approval(&db.lock().unwrap(), &spec, run_id, &task)
}

fn apply_human_revision_control_boundary(conn: &Connection, run_id: &str) -> Result<bool, String> {
    let run = get_loop_run(conn, run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    match run.control_requested.as_str() {
        "none" => Ok(true),
        "pause" => {
            if let Some(task_id) = run.current_task_id.as_deref() {
                set_task_state(conn, task_id, LoopTaskState::Working, None)?;
            }
            set_run_state(conn, run_id, LoopRunState::Paused, None)?;
            Ok(false)
        }
        "stop" => {
            transition_unfinished_tasks(
                conn,
                run_id,
                LoopTaskState::Blocked,
                "Loop stopped during human-requested revision",
            )?;
            set_run_control(conn, run_id, "none")?;
            finish_run_from_persisted_tasks(conn, run_id)?;
            Ok(false)
        }
        "kill" => Ok(false),
        other => Err(format!("Unknown loop control request: {other}")),
    }
}

fn apply_pre_approval_control_boundary(conn: &Connection, run_id: &str) -> Result<bool, String> {
    let run = get_loop_run(conn, run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    match run.control_requested.as_str() {
        "none" => Ok(true),
        "pause" => {
            set_run_control(conn, run_id, "none")?;
            Ok(true)
        }
        "stop" => {
            transition_unfinished_tasks(
                conn,
                run_id,
                LoopTaskState::Blocked,
                "Loop stopped before human approval",
            )?;
            set_run_control(conn, run_id, "none")?;
            finish_run_from_persisted_tasks(conn, run_id)?;
            Ok(false)
        }
        "kill" => Ok(false),
        other => Err(format!("Unknown loop control request: {other}")),
    }
}

fn human_revision_feedback(conn: &Connection, run_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT a.feedback
         FROM loop_approvals a
         JOIN loop_tasks t ON t.id = a.loop_task_id
         WHERE t.loop_run_id = ?1
           AND a.status = 'revision_requested'
           AND a.feedback IS NOT NULL
         ORDER BY a.attempt DESC
         LIMIT 1",
        [run_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| format!("Failed to load human revision feedback: {error}"))
}

pub async fn execute_human_revision(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
    feedback: String,
) -> Result<(), String> {
    execute_human_revision_with_cancel(db, runtime, run_id, working_directory, feedback, None).await
}

async fn execute_human_revision_with_cancel(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
    feedback: String,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let result = execute_human_revision_inner(
        Arc::clone(&db),
        runtime,
        run_id,
        working_directory,
        &feedback,
        cancelled,
    )
    .await;
    if let Err(error) = &result {
        let conn = db.lock().unwrap();
        let preserve_control_state =
            get_loop_run(&conn, run_id)
                .ok()
                .flatten()
                .is_some_and(|run| {
                    matches!(
                        run.state,
                        LoopRunState::Killed
                            | LoopRunState::Paused
                            | LoopRunState::Completed
                            | LoopRunState::AwaitingApproval
                    )
                });
        if !preserve_control_state {
            let _ = transition_unfinished_tasks(&conn, run_id, LoopTaskState::Interrupted, error);
            let _ = set_run_state(&conn, run_id, LoopRunState::Attention, Some(error));
        }
    }
    result
}

async fn execute_manual_loop_inner(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let run = get_loop_run(&db.lock().unwrap(), run_id)?
        .ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    let spec = get_loop_spec_by_id(&db.lock().unwrap(), &run.loop_spec_id)?
        .ok_or_else(|| format!("Loop specification not found: {}", run.loop_spec_id))?;
    let tasks = if run.state == LoopRunState::Paused || run.state == LoopRunState::Resuming {
        let conn = db.lock().unwrap();
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
        if spec.definition_id.is_some() && discovered.len() > 1 {
            return Err("YAML v1 loops may emit at most one task per run".to_string());
        }
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
            continue;
        }
        let first_verification = verify_task(
            &db,
            &spec,
            run_id,
            &task.id,
            &working_directory,
            1,
            cancelled.clone(),
        )
        .await?;
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
            continue;
        }
        if spec.evaluator_prompt.is_none() {
            if spec.human_approval_prompt.is_some() {
                runtime.disconnect(&worker_response.session_id).await?;
                if !apply_pre_approval_control_boundary(&db.lock().unwrap(), run_id)? {
                    return Ok(());
                }
                enter_human_approval(&db.lock().unwrap(), &spec, run_id, &task)?;
                return Ok(());
            }
            set_task_state(&db.lock().unwrap(), &task.id, LoopTaskState::Accepted, None)?;
            runtime.disconnect(&worker_response.session_id).await?;
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
            if worker_output.status != WorkerStatus::Completed {
                let state = if worker_output.status == WorkerStatus::Blocked {
                    LoopTaskState::Blocked
                } else {
                    LoopTaskState::Attention
                };
                set_task_state(&db.lock().unwrap(), &task.id, state, None)?;
                runtime.disconnect(&worker_response.session_id).await?;
                continue;
            }
            let revised_verification = verify_task(
                &db,
                &spec,
                run_id,
                &task.id,
                &working_directory,
                2,
                cancelled.clone(),
            )
            .await?;
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

        if final_verdict.verdict == EvaluatorVerdict::Accepted
            && spec.human_approval_prompt.is_some()
        {
            runtime.disconnect(&worker_response.session_id).await?;
            if !apply_pre_approval_control_boundary(&db.lock().unwrap(), run_id)? {
                return Ok(());
            }
            enter_human_approval(&db.lock().unwrap(), &spec, run_id, &task)?;
            return Ok(());
        }
        let task_state = match final_verdict.verdict {
            EvaluatorVerdict::Accepted => LoopTaskState::Accepted,
            EvaluatorVerdict::Blocked => LoopTaskState::Blocked,
            EvaluatorVerdict::Revise | EvaluatorVerdict::Invalid => LoopTaskState::Attention,
        };
        set_task_state(&db.lock().unwrap(), &task.id, task_state, None)?;
        runtime.disconnect(&worker_response.session_id).await?;
    }

    let conn = db.lock().unwrap();
    if !apply_control_boundary(&conn, run_id)? {
        return Ok(());
    }
    update_run_current_task(&conn, run_id, None)?;
    finish_run_from_persisted_tasks(&conn, run_id)
}

pub async fn execute_manual_loop(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
) -> Result<(), String> {
    execute_manual_loop_with_cancel(db, runtime, run_id, working_directory, None).await
}

async fn execute_manual_loop_with_cancel(
    db: Arc<Mutex<Connection>>,
    runtime: Arc<dyn LoopAgentRuntime>,
    run_id: &str,
    working_directory: PathBuf,
    cancelled: Option<Arc<AtomicBool>>,
) -> Result<(), String> {
    let result = execute_manual_loop_inner(
        Arc::clone(&db),
        runtime,
        run_id,
        working_directory,
        cancelled,
    )
    .await;
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
            let _ = transition_unfinished_tasks(&conn, run_id, LoopTaskState::Interrupted, error);
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
pub struct LoopApprovalRecord {
    pub id: String,
    pub loop_task_id: String,
    pub attempt: u32,
    pub status: String,
    pub prompt: String,
    pub feedback: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
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
    pub approvals: Vec<LoopApprovalRecord>,
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

fn list_approvals(conn: &Connection, run_id: &str) -> Result<Vec<LoopApprovalRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT a.id, a.loop_task_id, a.attempt, a.status, a.prompt,
                    a.feedback, a.created_at, a.decided_at
             FROM loop_approvals a
             JOIN loop_tasks t ON t.id = a.loop_task_id
             WHERE t.loop_run_id = ?1
             ORDER BY t.created_at, a.attempt",
        )
        .map_err(|error| format!("Failed to prepare approval query: {error}"))?;
    let rows = statement
        .query_map([run_id], |row| {
            Ok(LoopApprovalRecord {
                id: row.get(0)?,
                loop_task_id: row.get(1)?,
                attempt: row.get(2)?,
                status: row.get(3)?,
                prompt: row.get(4)?,
                feedback: row.get(5)?,
                created_at: row.get(6)?,
                decided_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Failed to query approvals: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode approvals: {error}"))
}

fn list_loop_events(conn: &Connection, run_id: &str) -> Result<Vec<LoopEventRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, loop_spec_id, loop_run_id, loop_task_id, event_type,
                    payload_json, created_at
             FROM (
                 SELECT id, loop_spec_id, loop_run_id, loop_task_id, event_type,
                        payload_json, created_at
                 FROM loop_events
                 WHERE loop_run_id = ?1
                 ORDER BY id DESC
                 LIMIT 500
             )
             ORDER BY id",
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
            approvals: Vec::new(),
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
            approvals: Vec::new(),
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
        approvals: list_approvals(conn, &run_id)?,
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

fn workstream_loop_paths(
    conn: &Connection,
    workstream_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let workstream_root = workstream_directory(conn, workstream_id)?;
    let session_id = crate::code_review::resolve_bound_session(conn, workstream_id)
        .map_err(|error| format!("Failed to resolve loop session: {error}"))?
        .ok_or_else(|| {
            "Open or link a Copilot session in this workstream before using loops".to_string()
        })?;
    let session_dir = crate::code_review::session_state_dir_path(&session_id)
        .map_err(|error| format!("Failed to resolve loop session directory: {error}"))?;
    let loops_dir = session_loop_directory(&session_dir)?;
    Ok((workstream_root, loops_dir))
}

pub(crate) fn session_loop_directory(session_dir: &Path) -> Result<PathBuf, String> {
    let session_dir = session_dir
        .canonicalize()
        .map_err(|error| format!("Failed to resolve session-state directory: {error}"))?;
    if !session_dir.join("workspace.yaml").is_file() && !session_dir.join("session.db").is_file() {
        return Err("Session-state directory has no session metadata".to_string());
    }
    let configured_loops_dir = session_dir.join("files").join("loops");
    let loops_dir = if configured_loops_dir.exists() {
        let canonical = configured_loops_dir
            .canonicalize()
            .map_err(|error| format!("Failed to resolve loop definitions directory: {error}"))?;
        if !canonical.starts_with(&session_dir) {
            return Err("Loop definitions directory escapes the bound session".to_string());
        }
        canonical
    } else {
        configured_loops_dir
    };
    Ok(loops_dir)
}

#[tauri::command]
pub fn list_loop_definitions(
    state: tauri::State<'_, crate::AppState>,
    workstream_id: String,
) -> Result<crate::loop_definition::LoopCatalog, String> {
    let (workstream_root, loops_dir) =
        match workstream_loop_paths(&state.db.lock().unwrap(), &workstream_id) {
            Ok(paths) => paths,
            Err(error) => {
                return Ok(crate::loop_definition::LoopCatalog {
                    definitions: Vec::new(),
                    invalid: vec![crate::loop_definition::InvalidLoopCatalogDefinition {
                        path: "files/loops".to_string(),
                        error,
                    }],
                });
            }
        };
    crate::loop_definition::catalog_for_directory(&workstream_root, &loops_dir)
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

fn loop_progress_version(conn: &Connection, workstream_id: &str) -> Result<String, String> {
    let spec = get_loop_spec(conn, workstream_id)?;
    let Some(spec) = spec else {
        return Ok("unconfigured".to_string());
    };
    let run = latest_loop_run(conn, &spec.id)?;
    let Some(run) = run else {
        return Ok(format!("{}:idle", spec.updated_at));
    };
    let mut statement = conn
        .prepare(
            "SELECT id, state, revision_count, updated_at
             FROM loop_tasks WHERE loop_run_id = ?1 ORDER BY ordinal",
        )
        .map_err(|error| format!("Failed to prepare loop progress query: {error}"))?;
    let task_versions = statement
        .query_map([&run.id], |row| {
            Ok(format!(
                "{}:{}:{}:{}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, u32>(2)?,
                row.get::<_, String>(3)?
            ))
        })
        .map_err(|error| format!("Failed to query loop progress: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to decode loop progress: {error}"))?;
    let verification_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_verifications v
             JOIN loop_tasks t ON t.id = v.loop_task_id
             WHERE t.loop_run_id = ?1",
            [&run.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count loop verifications: {error}"))?;
    let evaluation_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_evaluations e
             JOIN loop_tasks t ON t.id = e.loop_task_id
             WHERE t.loop_run_id = ?1",
            [&run.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count loop evaluations: {error}"))?;
    let approval_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM loop_approvals a
             JOIN loop_tasks t ON t.id = a.loop_task_id
             WHERE t.loop_run_id = ?1",
            [&run.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to count loop approvals: {error}"))?;
    let latest_event_id: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(id), 0) FROM loop_events WHERE loop_run_id = ?1",
            [&run.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to read loop event version: {error}"))?;
    Ok(format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        run.id,
        run.state.as_str(),
        run.control_requested,
        task_versions.join("|"),
        verification_count,
        evaluation_count,
        approval_count,
        latest_event_id
    ))
}

#[tauri::command]
pub fn get_workstream_loop_progress_version(
    state: tauri::State<'_, crate::AppState>,
    workstream_id: String,
) -> Result<String, String> {
    loop_progress_version(&state.db.lock().unwrap(), &workstream_id)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoopUpdatedEvent {
    workstream_id: String,
    run_id: String,
}

async fn run_with_sdk(
    db: Arc<Mutex<Connection>>,
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
            let conn = db.lock().unwrap();
            let _ = transition_unfinished_tasks(&conn, &run_id, LoopTaskState::Interrupted, &error);
            let _ = set_run_state(&conn, &run_id, LoopRunState::Attention, Some(&error));
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
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Err(error) = manager
        .register(&run_id, Arc::clone(&runtime), Arc::clone(&cancelled))
        .await
    {
        {
            let conn = db.lock().unwrap();
            let is_resume_claim = get_loop_run(&conn, &run_id)
                .ok()
                .flatten()
                .is_some_and(|run| run.state == LoopRunState::Resuming);
            if is_resume_claim {
                let _ = conn.execute(
                    "UPDATE loop_runs
                     SET state = 'paused', control_requested = 'none'
                     WHERE id = ?1 AND state = 'resuming'",
                    [&run_id],
                );
            } else {
                let _ = set_run_state(&conn, &run_id, LoopRunState::Attention, Some(&error));
            }
        }
        let _ = runtime.shutdown().await;
        let _ = app.emit(
            "loop-updated",
            LoopUpdatedEvent {
                workstream_id,
                run_id,
            },
        );
        return;
    }
    let _ = execute_manual_loop_with_cancel(
        db,
        Arc::clone(&runtime),
        &run_id,
        working_directory,
        Some(cancelled),
    )
    .await;
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

async fn run_human_revision_with_sdk(
    db: Arc<Mutex<Connection>>,
    manager: Arc<LoopManager>,
    app: tauri::AppHandle,
    workstream_id: String,
    run_id: String,
    working_directory: PathBuf,
    feedback: String,
) {
    use crate::loop_agent::SdkAgentRuntime;
    use tauri::Emitter;

    let runtime = match SdkAgentRuntime::connect().await {
        Ok(runtime) => Arc::new(runtime) as Arc<dyn LoopAgentRuntime>,
        Err(error) => {
            let conn = db.lock().unwrap();
            let _ = transition_unfinished_tasks(&conn, &run_id, LoopTaskState::Interrupted, &error);
            let _ = set_run_state(&conn, &run_id, LoopRunState::Attention, Some(&error));
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
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Err(error) = manager
        .register(&run_id, Arc::clone(&runtime), Arc::clone(&cancelled))
        .await
    {
        {
            let conn = db.lock().unwrap();
            let _ = transition_unfinished_tasks(&conn, &run_id, LoopTaskState::Interrupted, &error);
            let _ = set_run_state(&conn, &run_id, LoopRunState::Attention, Some(&error));
        }
        let _ = runtime.shutdown().await;
        let _ = app.emit(
            "loop-updated",
            LoopUpdatedEvent {
                workstream_id,
                run_id,
            },
        );
        return;
    }
    let _ = execute_human_revision_with_cancel(
        db,
        Arc::clone(&runtime),
        &run_id,
        working_directory,
        feedback,
        Some(cancelled),
    )
    .await;
    if let Err(error) = runtime.shutdown().await {
        eprintln!("[loop] Failed to shut down revision runtime for {run_id}: {error}");
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

fn workstream_directory(conn: &Connection, workstream_id: &str) -> Result<PathBuf, String> {
    let directory: Option<String> = conn
        .query_row(
            "SELECT directory FROM workstreams WHERE id = ?1",
            [workstream_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to resolve loop workstream: {error}"))?;
    directory
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "The loop workstream has no directory".to_string())
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
        Arc::clone(&state.db),
        Arc::clone(&state.loop_manager),
        app,
        workstream_id,
        run_id,
        directory,
    ));
    Ok(run)
}

#[tauri::command]
pub fn run_loop_definition_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    workstream_id: String,
    definition_path: String,
) -> Result<LoopRun, String> {
    let (run, directory) = {
        let conn = state.db.lock().unwrap();
        let (directory, loops_dir) = workstream_loop_paths(&conn, &workstream_id)?;
        let (definition, yaml) = crate::loop_definition::load_validated_definition(
            &directory,
            &loops_dir,
            Path::new(&definition_path),
        )?;
        let materialized = materialize_loop_definition(
            &conn,
            &workstream_id,
            definition_to_materialized(definition, yaml),
        )?;
        (
            create_loop_run(&conn, &materialized.id, materialized.run_timeout_seconds)?,
            directory,
        )
    };
    let run_id = run.id.clone();
    tauri::async_runtime::spawn(run_with_sdk(
        Arc::clone(&state.db),
        Arc::clone(&state.loop_manager),
        app,
        workstream_id,
        run_id,
        directory,
    ));
    Ok(run)
}

#[tauri::command]
pub async fn resume_workstream_loop(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
) -> Result<LoopRun, String> {
    if state.loop_manager.is_active(&run_id).await {
        return Err("The paused loop executor is still shutting down; retry Resume".to_string());
    }
    let (run, workstream_id, directory, revision_feedback) = {
        let conn = state.db.lock().unwrap();
        let run =
            get_loop_run(&conn, &run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
        if run.state != LoopRunState::Paused {
            return Err("Only a paused loop run can be resumed".to_string());
        }
        let (workstream_id, directory) = workstream_directory_for_spec(&conn, &run.loop_spec_id)?;
        let revision_feedback = human_revision_feedback(&conn, &run_id)?;
        let claimed_run = claim_paused_run(&conn, &run_id)?;
        (claimed_run, workstream_id, directory, revision_feedback)
    };
    if let Some(feedback) = revision_feedback {
        tauri::async_runtime::spawn(run_human_revision_with_sdk(
            Arc::clone(&state.db),
            Arc::clone(&state.loop_manager),
            app,
            workstream_id,
            run_id,
            directory,
            feedback,
        ));
    } else {
        tauri::async_runtime::spawn(run_with_sdk(
            Arc::clone(&state.db),
            Arc::clone(&state.loop_manager),
            app,
            workstream_id,
            run_id,
            directory,
        ));
    }
    Ok(run)
}

#[tauri::command]
pub async fn decide_loop_human_approval(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
    decision: HumanApprovalDecision,
    feedback: Option<String>,
) -> Result<LoopRun, String> {
    use tauri::Emitter;

    if state.loop_manager.is_active(&run_id).await {
        return Err(
            "The previous loop executor is still shutting down; retry the approval decision"
                .to_string(),
        );
    }
    let (run, workstream_id, directory) = {
        let conn = state.db.lock().unwrap();
        let current =
            get_loop_run(&conn, &run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
        let (workstream_id, directory) =
            workstream_directory_for_spec(&conn, &current.loop_spec_id)?;
        let run = decide_human_approval(&conn, &run_id, decision, feedback.as_deref())?;
        (run, workstream_id, directory)
    };
    if decision == HumanApprovalDecision::Revise {
        tauri::async_runtime::spawn(run_human_revision_with_sdk(
            Arc::clone(&state.db),
            Arc::clone(&state.loop_manager),
            app,
            workstream_id,
            run_id,
            directory,
            feedback.expect("revision feedback was validated"),
        ));
    } else if run.state == LoopRunState::Resuming {
        tauri::async_runtime::spawn(run_with_sdk(
            Arc::clone(&state.db),
            Arc::clone(&state.loop_manager),
            app,
            workstream_id,
            run_id,
            directory,
        ));
    } else {
        let _ = app.emit(
            "loop-updated",
            LoopUpdatedEvent {
                workstream_id,
                run_id,
            },
        );
    }
    Ok(run)
}

pub(crate) fn apply_control_request(
    conn: &Connection,
    run: &LoopRun,
    action: &str,
) -> Result<bool, String> {
    match action {
        "pause" if run.state == LoopRunState::AwaitingApproval => {
            Err("A loop awaiting approval is already paused for human input".to_string())
        }
        "pause" => {
            if run.state != LoopRunState::Paused {
                set_run_control(conn, &run.id, "pause")?;
            }
            Ok(false)
        }
        "stop"
            if matches!(
                run.state,
                LoopRunState::Paused | LoopRunState::AwaitingApproval
            ) =>
        {
            if run.state == LoopRunState::AwaitingApproval {
                conn.execute(
                    "UPDATE loop_approvals
                     SET status = 'cancelled', feedback = 'Loop stopped',
                         decided_at = ?1
                     WHERE loop_task_id IN (
                         SELECT id FROM loop_tasks WHERE loop_run_id = ?2
                     ) AND status = 'pending'",
                    params![crate::now(), run.id],
                )
                .map_err(|error| format!("Failed to cancel pending approval: {error}"))?;
            }
            transition_unfinished_tasks(
                conn,
                &run.id,
                LoopTaskState::Blocked,
                "Loop stopped while paused",
            )?;
            set_run_control(conn, &run.id, "none")?;
            finish_run_from_persisted_tasks(conn, &run.id)?;
            Ok(false)
        }
        "stop" => {
            set_run_control(conn, &run.id, "stop")?;
            Ok(false)
        }
        "kill" => {
            conn.execute(
                "UPDATE loop_approvals
                 SET status = 'cancelled', feedback = 'Loop killed', decided_at = ?1
                 WHERE loop_task_id IN (
                     SELECT id FROM loop_tasks WHERE loop_run_id = ?2
                 ) AND status = 'pending'",
                params![crate::now(), run.id],
            )
            .map_err(|error| format!("Failed to cancel pending approval: {error}"))?;
            set_run_control(conn, &run.id, "kill")?;
            transition_unfinished_tasks(conn, &run.id, LoopTaskState::Interrupted, "Loop killed")?;
            set_run_state(conn, &run.id, LoopRunState::Killed, None)?;
            Ok(true)
        }
        _ => Err("Loop action must be pause, stop, or kill".to_string()),
    }
}

#[tauri::command]
pub async fn control_workstream_loop(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
    action: String,
) -> Result<(), String> {
    use tauri::Emitter;

    let (workstream_id, abort_runtime) = {
        let conn = state.db.lock().unwrap();
        let run =
            get_loop_run(&conn, &run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
        let (workstream_id, _) = workstream_directory_for_spec(&conn, &run.loop_spec_id)?;
        let abort_runtime = apply_control_request(&conn, &run, &action)?;
        (workstream_id, abort_runtime)
    };
    if abort_runtime {
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
            evaluator_prompt: Some("Evaluate the result".to_string()),
            orchestrator_model: None,
            worker_model: None,
            evaluator_model: None,
            human_approval_prompt: None,
            verifier_program: Some("cargo".to_string()),
            verifier_args: vec!["test".to_string()],
            verifier_cwd: Some("/tmp/repo".to_string()),
            verifier_timeout_seconds: Some(300),
            run_timeout_seconds: 600,
            max_task_iterations: 2,
        }
    }

    fn pending_approval_run(conn: &Connection, key: &str) -> (LoopSpec, LoopRun, LoopTask) {
        let spec = match get_loop_spec(conn, "ws-1").expect("load spec") {
            Some(spec) => spec,
            None => {
                let mut input = spec_input();
                input.human_approval_prompt = Some("Review the evidence".to_string());
                save_loop_spec(conn, "ws-1", input).expect("save approval loop")
            }
        };
        set_loop_enabled(conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(conn, &spec.id, 600).expect("create run");
        let task = enqueue_task(
            conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: key.to_string(),
                title: "Task".to_string(),
                objective: "Work".to_string(),
            },
        )
        .expect("enqueue")
        .expect("task");
        update_run_current_task(conn, &run.id, Some(&task.id)).expect("set active task");
        enter_human_approval(conn, &spec, &run.id, &task).expect("request approval");
        (
            spec,
            get_loop_run(conn, &run.id)
                .expect("load approval run")
                .expect("approval run"),
            task,
        )
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
    fn loop_catalog_requires_a_bound_copilot_session() {
        let conn = test_db();

        let error = workstream_loop_paths(&conn, "ws-1").expect_err("unbound workstream must fail");

        assert!(error.contains("Open or link a Copilot session"));
    }

    #[cfg(unix)]
    #[test]
    fn session_loop_directory_rejects_an_escaping_symlink() {
        use std::os::unix::fs::symlink;

        let root =
            std::env::temp_dir().join(format!("workstreams-loop-session-{}", Uuid::new_v4()));
        let session = root.join("session");
        let outside = root.join("outside");
        std::fs::create_dir_all(&session).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(session.join("workspace.yaml"), "id: session\n").unwrap();
        std::fs::create_dir_all(session.join("files")).unwrap();
        symlink(&outside, session.join("files/loops")).unwrap();

        let error =
            session_loop_directory(&session).expect_err("escaping loop directory must fail");

        assert!(error.contains("escapes the bound session"));
        std::fs::remove_dir_all(root).ok();
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
    fn retryable_task_states_release_their_identity_key() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let first_run = create_loop_run(&conn, &spec.id, 600).expect("create first run");
        let candidate = DiscoveredTask {
            key: "retryable".to_string(),
            title: "Retryable task".to_string(),
            objective: "Try the task again".to_string(),
        };
        let first = enqueue_task(&conn, &first_run.id, &spec.id, &candidate)
            .expect("enqueue first task")
            .expect("insert first task");
        set_task_state(&conn, &first.id, LoopTaskState::Attention, None).expect("mark retryable");
        set_run_state(&conn, &first_run.id, LoopRunState::Attention, None)
            .expect("finish first run");

        let second_run = create_loop_run(&conn, &spec.id, 600).expect("create retry run");
        let retried =
            enqueue_task(&conn, &second_run.id, &spec.id, &candidate).expect("enqueue retry");

        assert!(retried.is_some());
    }

    #[test]
    fn task_ordinals_preserve_orchestrator_order() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        for key in ["first", "second", "third"] {
            enqueue_task(
                &conn,
                &run.id,
                &spec.id,
                &DiscoveredTask {
                    key: key.to_string(),
                    title: key.to_string(),
                    objective: "Work".to_string(),
                },
            )
            .expect("enqueue task");
        }

        assert_eq!(
            list_loop_tasks(&conn, &run.id)
                .expect("list tasks")
                .into_iter()
                .map(|task| task.key)
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"]
        );
    }

    #[test]
    fn materialized_definition_is_pinned_and_scopes_task_deduplication() {
        let conn = test_db();
        let mut first_input = spec_input();
        first_input.human_approval_prompt = Some("Review first".to_string());
        let first = materialize_loop_definition(
            &conn,
            "ws-1",
            MaterializedLoopDefinition {
                definition_id: "first-loop".to_string(),
                definition_path: "/session/files/loops/first.loop.yaml".to_string(),
                definition_hash: "hash-1".to_string(),
                definition_name: "First loop".to_string(),
                objective: "First objective".to_string(),
                portable: true,
                yaml: "first yaml".to_string(),
                spec: first_input,
            },
        )
        .expect("materialize first definition");
        let first_run = create_loop_run(&conn, &first.id, 600).expect("create first run");
        let task = DiscoveredTask {
            key: "same-key".to_string(),
            title: "Task".to_string(),
            objective: "Work".to_string(),
        };
        enqueue_task(&conn, &first_run.id, &first.id, &task)
            .expect("enqueue first")
            .expect("insert first");
        set_run_state(&conn, &first_run.id, LoopRunState::Completed, None)
            .expect("complete first run");
        assert_eq!(first.definition_id.as_deref(), Some("first-loop"));
        assert_eq!(first.definition_hash.as_deref(), Some("hash-1"));
        let pinned = get_loop_run(&conn, &first_run.id)
            .expect("load run")
            .expect("run exists");
        assert_eq!(pinned.definition_hash.as_deref(), Some("hash-1"));
        assert_eq!(pinned.definition_yaml.as_deref(), Some("first yaml"));

        let second = materialize_loop_definition(
            &conn,
            "ws-1",
            MaterializedLoopDefinition {
                definition_id: "second-loop".to_string(),
                definition_path: "/session/files/loops/second.loop.yaml".to_string(),
                definition_hash: "hash-2".to_string(),
                definition_name: "Second loop".to_string(),
                objective: "Second objective".to_string(),
                portable: true,
                yaml: "second yaml".to_string(),
                spec: spec_input(),
            },
        )
        .expect("materialize second definition");
        assert_eq!(second.human_approval_prompt, None);
        let second_run = create_loop_run(&conn, &second.id, 600).expect("create second run");
        assert!(
            enqueue_task(&conn, &second_run.id, &second.id, &task)
                .expect("enqueue second")
                .is_some(),
            "the same task key in another definition must not be deduplicated"
        );
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
    async fn loop_manager_refuses_a_second_executor_for_one_run() {
        use crate::loop_agent::ScriptedAgentRuntime;
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let manager = LoopManager::new();
        let first = Arc::new(ScriptedAgentRuntime::new(vec![])) as Arc<dyn LoopAgentRuntime>;
        let second = Arc::new(ScriptedAgentRuntime::new(vec![])) as Arc<dyn LoopAgentRuntime>;
        manager
            .register("run-1", first, Arc::new(AtomicBool::new(false)))
            .await
            .expect("register first executor");

        let error = manager
            .register("run-1", second, Arc::new(AtomicBool::new(false)))
            .await
            .expect_err("duplicate executor must fail");

        assert!(error.contains("already has an executor"));
        manager.unregister("run-1").await;
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

    #[tokio::test]
    async fn blocked_worker_revision_does_not_reach_a_second_evaluator() {
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
                content:
                    r#"{"tasks":[{"key":"task-1","title":"Task","objective":"Do work"}]}"#
                        .to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"First","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-1".to_string(),
                content: r#"{"verdict":"revise","summary":"Revise","feedback":"Try again","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"blocked","summary":"Cannot continue","evidence":[]}"#
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
        .expect("blocked revision is handled");

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
        let evaluations: i64 = conn
            .query_row("SELECT COUNT(*) FROM loop_evaluations", [], |row| {
                row.get(0)
            })
            .expect("count evaluations");
        assert_eq!(evaluations, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_during_verification_cancels_it_and_preserves_terminal_state() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = Some("/bin/sh".to_string());
        input.verifier_args = vec!["-c".to_string(), "sleep 30".to_string()];
        input.verifier_cwd = None;
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 60).expect("create run");
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
        ])) as Arc<dyn LoopAgentRuntime>;
        let db = Arc::new(Mutex::new(conn));
        let cancelled = Arc::new(AtomicBool::new(false));

        let executor = execute_manual_loop_with_cancel(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::env::current_dir().expect("current directory"),
            Some(Arc::clone(&cancelled)),
        );
        let killer = async {
            loop {
                let task = {
                    let conn = db.lock().unwrap();
                    list_loop_tasks(&conn, &run.id)
                        .expect("list tasks")
                        .into_iter()
                        .next()
                };
                if task
                    .as_ref()
                    .is_some_and(|task| task.state == LoopTaskState::Verifying)
                {
                    let task = task.expect("verifying task");
                    let conn = db.lock().unwrap();
                    set_run_control(&conn, &run.id, "kill").expect("request kill");
                    set_task_state(&conn, &task.id, LoopTaskState::Interrupted, None)
                        .expect("interrupt task");
                    set_run_state(&conn, &run.id, LoopRunState::Killed, None).expect("kill run");
                    cancelled.store(true, Ordering::Release);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };

        let (result, ()) = tokio::join!(executor, killer);
        assert!(
            result.is_err(),
            "the cancelled verifier must stop the executor"
        );
        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Killed
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].state,
            LoopTaskState::Interrupted
        );
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

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_only_loop_accepts_without_starting_an_evaluator() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = Some("/bin/sh".to_string());
        input.verifier_args = vec!["-c".to_string(), "printf verified".to_string()];
        input.verifier_cwd = None;
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save verification-only spec");
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
        ]));
        let db = Arc::new(Mutex::new(conn));

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::env::current_dir().expect("current directory"),
        )
        .await
        .expect("execute verification-only loop");

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
        let evaluations: i64 = conn
            .query_row("SELECT COUNT(*) FROM loop_evaluations", [], |row| {
                row.get(0)
            })
            .expect("count evaluations");
        assert_eq!(evaluations, 0);
    }

    #[tokio::test]
    async fn human_approval_only_loop_waits_with_a_persisted_request() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
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
                content: r#"{"status":"completed","summary":"Done","evidence":["diff"]}"#
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
        .expect("execute approval loop");

        let snapshot = loop_snapshot(&db.lock().unwrap(), "ws-1").expect("load snapshot");
        assert_eq!(
            snapshot.latest_run.as_ref().unwrap().state,
            LoopRunState::AwaitingApproval
        );
        assert_eq!(snapshot.tasks[0].state, LoopTaskState::AwaitingApproval);
        assert_eq!(snapshot.approvals.len(), 1);
        assert_eq!(snapshot.approvals[0].status, "pending");
        assert_eq!(snapshot.approvals[0].prompt, "Review the evidence");
    }

    #[tokio::test]
    async fn human_approval_decisions_are_persisted_and_revision_rechecks_evidence() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let first_runtime = Arc::new(ScriptedAgentRuntime::new(vec![
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
                content: r#"{"status":"completed","summary":"First","evidence":[]}"#.to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));
        execute_manual_loop(
            Arc::clone(&db),
            first_runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("reach approval");

        let feedback = "Add the missing edge case";
        decide_human_approval(
            &db.lock().unwrap(),
            &run.id,
            HumanApprovalDecision::Revise,
            Some(feedback),
        )
        .expect("request revision");
        let revision_runtime = Arc::new(ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
            role: AgentRole::Worker,
            session_id: "worker-2".to_string(),
            content: r#"{"status":"completed","summary":"Revised","evidence":["edge case"]}"#
                .to_string(),
            events: vec![],
        }]));
        execute_human_revision(
            Arc::clone(&db),
            revision_runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
            feedback.to_string(),
        )
        .await
        .expect("execute human revision");

        let awaiting = loop_snapshot(&db.lock().unwrap(), "ws-1").expect("load revised snapshot");
        assert_eq!(
            awaiting.latest_run.as_ref().unwrap().state,
            LoopRunState::AwaitingApproval
        );
        assert_eq!(awaiting.tasks[0].revision_count, 1);
        assert_eq!(awaiting.approvals.len(), 2);
        assert_eq!(awaiting.approvals[0].status, "revision_requested");
        assert_eq!(awaiting.approvals[0].feedback.as_deref(), Some(feedback));
        let second_revision = decide_human_approval(
            &db.lock().unwrap(),
            &run.id,
            HumanApprovalDecision::Revise,
            Some("Revise again"),
        )
        .expect_err("a task can only be revised once");
        assert!(second_revision.contains("at most one revision"));

        decide_human_approval(
            &db.lock().unwrap(),
            &run.id,
            HumanApprovalDecision::Approve,
            None,
        )
        .expect("approve revision");
        let approved = loop_snapshot(&db.lock().unwrap(), "ws-1").expect("load approved snapshot");
        assert_eq!(
            approved.latest_run.as_ref().unwrap().state,
            LoopRunState::Completed
        );
        assert_eq!(approved.tasks[0].state, LoopTaskState::Accepted);
        assert_eq!(approved.approvals[1].status, "approved");
    }

    #[tokio::test]
    async fn approval_attempt_matches_an_evaluator_requested_revision() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
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
                content: r#"{"status":"completed","summary":"First","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-1".to_string(),
                content:
                    r#"{"verdict":"revise","summary":"Revise","feedback":"Fix it","evidence":[]}"#
                        .to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: r#"{"status":"completed","summary":"Second","evidence":[]}"#.to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Evaluator,
                session_id: "evaluator-2".to_string(),
                content: r#"{"verdict":"accepted","summary":"Good","evidence":[]}"#.to_string(),
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
        .expect("execute evaluator revision");

        let snapshot = loop_snapshot(&db.lock().unwrap(), "ws-1").expect("load snapshot");
        assert_eq!(snapshot.tasks[0].revision_count, 1);
        assert_eq!(snapshot.approvals[0].attempt, 2);
    }

    #[test]
    fn pending_human_approval_survives_restart_reconciliation() {
        let conn = test_db();
        let mut input = spec_input();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let task = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "task".to_string(),
                title: "Task".to_string(),
                objective: "Work".to_string(),
            },
        )
        .expect("enqueue")
        .expect("task");
        update_run_current_task(&conn, &run.id, Some(&task.id)).expect("set active task");
        enter_human_approval(&conn, &spec, &run.id, &task).expect("request approval");

        let reconciled = reconcile_interrupted_runs(&conn).expect("reconcile");

        assert_eq!(reconciled, 0);
        assert_eq!(
            get_loop_run(&conn, &run.id).unwrap().unwrap().state,
            LoopRunState::AwaitingApproval
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).unwrap()[0].state,
            LoopTaskState::AwaitingApproval
        );
    }

    #[test]
    fn reject_and_controls_close_pending_human_approvals() {
        let conn = test_db();
        let (_spec, rejected_run, _rejected_task) = pending_approval_run(&conn, "reject");

        decide_human_approval(
            &conn,
            &rejected_run.id,
            HumanApprovalDecision::Reject,
            Some("The result is unsafe"),
        )
        .expect("reject approval");
        let rejected = loop_snapshot(&conn, "ws-1").expect("load rejected snapshot");
        assert_eq!(
            rejected.latest_run.as_ref().unwrap().state,
            LoopRunState::Attention
        );
        assert_eq!(rejected.tasks[0].state, LoopTaskState::Blocked);
        assert_eq!(rejected.approvals[0].status, "rejected");
        assert_eq!(
            rejected.approvals[0].feedback.as_deref(),
            Some("The result is unsafe")
        );

        let (_spec, stopped_run, _task) = pending_approval_run(&conn, "stop");
        apply_control_request(&conn, &stopped_run, "stop").expect("stop approval");
        let stopped_approval: String = conn
            .query_row(
                "SELECT status FROM loop_approvals
                 WHERE loop_task_id IN (
                     SELECT id FROM loop_tasks WHERE loop_run_id = ?1
                 )",
                [&stopped_run.id],
                |row| row.get(0),
            )
            .expect("stopped approval");
        assert_eq!(stopped_approval, "cancelled");

        let (_spec, killed_run, _task) = pending_approval_run(&conn, "kill");
        apply_control_request(&conn, &killed_run, "kill").expect("kill approval");
        let killed_approval: String = conn
            .query_row(
                "SELECT status FROM loop_approvals
                 WHERE loop_task_id IN (
                     SELECT id FROM loop_tasks WHERE loop_run_id = ?1
                 )",
                [&killed_run.id],
                |row| row.get(0),
            )
            .expect("killed approval");
        assert_eq!(killed_approval, "cancelled");
        assert_eq!(
            get_loop_run(&conn, &killed_run.id).unwrap().unwrap().state,
            LoopRunState::Killed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_during_human_revision_preserves_killed_state() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.human_approval_prompt = Some("Review the evidence".to_string());
        input.verifier_program = Some("/bin/sh".to_string());
        input.verifier_args = vec!["-c".to_string(), "sleep 30".to_string()];
        input.verifier_cwd = None;
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
        let (_spec, run, task) = pending_approval_run(&conn, "kill-revision");
        decide_human_approval(
            &conn,
            &run.id,
            HumanApprovalDecision::Revise,
            Some("Revise it"),
        )
        .expect("request revision");
        let db = Arc::new(Mutex::new(conn));
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
            role: AgentRole::Worker,
            session_id: "worker-2".to_string(),
            content: r#"{"status":"completed","summary":"Revised","evidence":[]}"#.to_string(),
            events: vec![],
        }])) as Arc<dyn LoopAgentRuntime>;
        let cancelled = Arc::new(AtomicBool::new(false));

        let executor = execute_human_revision_with_cancel(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::env::current_dir().expect("current directory"),
            "Revise it".to_string(),
            Some(Arc::clone(&cancelled)),
        );
        let killer = async {
            loop {
                let current_task = list_loop_tasks(&db.lock().unwrap(), &run.id)
                    .expect("list tasks")
                    .into_iter()
                    .next()
                    .expect("task");
                if current_task.state == LoopTaskState::Verifying {
                    let current_run = get_loop_run(&db.lock().unwrap(), &run.id)
                        .expect("load run")
                        .expect("run");
                    apply_control_request(&db.lock().unwrap(), &current_run, "kill")
                        .expect("kill revision");
                    cancelled.store(true, Ordering::Release);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };

        let (result, ()) = tokio::join!(executor, killer);
        assert!(result.is_err());
        assert_eq!(
            get_loop_run(&db.lock().unwrap(), &run.id)
                .unwrap()
                .unwrap()
                .state,
            LoopRunState::Killed
        );
        assert_eq!(
            list_loop_tasks(&db.lock().unwrap(), &run.id).unwrap()[0].state,
            LoopTaskState::Interrupted
        );
        assert_eq!(task.loop_spec_id, spec.id);
    }

    #[tokio::test]
    async fn paused_human_revision_resumes_from_persisted_feedback() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
        let (_spec, run, _task) = pending_approval_run(&conn, "pause-revision");
        decide_human_approval(
            &conn,
            &run.id,
            HumanApprovalDecision::Revise,
            Some("Persist this feedback"),
        )
        .expect("request revision");
        set_run_control(&conn, &run.id, "pause").expect("pause revision");
        let db = Arc::new(Mutex::new(conn));

        execute_human_revision(
            Arc::clone(&db),
            Arc::new(ScriptedAgentRuntime::new(vec![])),
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
            "Persist this feedback".to_string(),
        )
        .await
        .expect("pause before worker");
        assert_eq!(
            get_loop_run(&db.lock().unwrap(), &run.id)
                .unwrap()
                .unwrap()
                .state,
            LoopRunState::Paused
        );
        let feedback = human_revision_feedback(&db.lock().unwrap(), &run.id)
            .expect("load feedback")
            .expect("revision feedback");
        claim_paused_run(&db.lock().unwrap(), &run.id).expect("claim paused revision");
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
            role: AgentRole::Worker,
            session_id: "worker-resumed".to_string(),
            content: r#"{"status":"completed","summary":"Resumed","evidence":[]}"#.to_string(),
            events: vec![],
        }]));

        execute_human_revision(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
            feedback,
        )
        .await
        .expect("resume revision");

        let snapshot = loop_snapshot(&db.lock().unwrap(), "ws-1").expect("load snapshot");
        assert_eq!(
            snapshot.latest_run.as_ref().unwrap().state,
            LoopRunState::AwaitingApproval
        );
        assert_eq!(snapshot.approvals.len(), 2);
    }

    #[tokio::test]
    async fn approval_continues_queued_tasks_and_honors_pre_boundary_stop() {
        use crate::loop_agent::{AgentRole, ScriptedAgentResponse, ScriptedAgentRuntime};
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let first = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "first".to_string(),
                title: "First".to_string(),
                objective: "First task".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "second".to_string(),
                title: "Second".to_string(),
                objective: "Second task".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        update_run_current_task(&conn, &run.id, Some(&first.id)).unwrap();
        enter_human_approval(&conn, &spec, &run.id, &first).unwrap();
        conn.execute(
            "UPDATE loop_runs SET deadline_at = '1' WHERE id = ?1",
            [&run.id],
        )
        .unwrap();

        let continued = decide_human_approval(&conn, &run.id, HumanApprovalDecision::Approve, None)
            .expect("approve first task");
        assert_eq!(continued.state, LoopRunState::Resuming);
        assert_ne!(continued.deadline_at, "1");
        let db = Arc::new(Mutex::new(conn));
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
            role: AgentRole::Worker,
            session_id: "worker-second".to_string(),
            content: r#"{"status":"completed","summary":"Second done","evidence":[]}"#.to_string(),
            events: vec![],
        }]));
        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("continue queued task");
        let awaiting = loop_snapshot(&db.lock().unwrap(), "ws-1").unwrap();
        assert_eq!(
            awaiting.latest_run.as_ref().unwrap().state,
            LoopRunState::AwaitingApproval
        );
        decide_human_approval(
            &db.lock().unwrap(),
            &run.id,
            HumanApprovalDecision::Approve,
            None,
        )
        .expect("approve second task");
        assert_eq!(
            get_loop_run(&db.lock().unwrap(), &run.id)
                .unwrap()
                .unwrap()
                .state,
            LoopRunState::Completed
        );

        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let stop_spec = save_loop_spec(&conn, "ws-1", input).expect("save stop loop");
        set_loop_enabled(&conn, &stop_spec.id, true).unwrap();
        let stopped_run = create_loop_run(&conn, &stop_spec.id, 600).unwrap();
        let task = enqueue_task(
            &conn,
            &stopped_run.id,
            &stop_spec.id,
            &DiscoveredTask {
                key: "stop-before-approval".to_string(),
                title: "Stop".to_string(),
                objective: "Stop task".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        update_run_current_task(&conn, &stopped_run.id, Some(&task.id)).unwrap();
        set_task_state(&conn, &task.id, LoopTaskState::Working, None).unwrap();
        set_run_state(&conn, &stopped_run.id, LoopRunState::Working, None).unwrap();
        set_run_control(&conn, &stopped_run.id, "stop").unwrap();
        assert!(!apply_pre_approval_control_boundary(&conn, &stopped_run.id).unwrap());
        assert_eq!(
            get_loop_run(&conn, &stopped_run.id).unwrap().unwrap().state,
            LoopRunState::Attention
        );
    }

    #[test]
    fn final_human_approval_preserves_earlier_task_failures() {
        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();
        input.human_approval_prompt = Some("Review the evidence".to_string());
        let spec = save_loop_spec(&conn, "ws-1", input).expect("save approval loop");
        set_loop_enabled(&conn, &spec.id, true).unwrap();
        let run = create_loop_run(&conn, &spec.id, 600).unwrap();
        let failed = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "failed".to_string(),
                title: "Failed".to_string(),
                objective: "Fail".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        set_task_state(&conn, &failed.id, LoopTaskState::Blocked, None).unwrap();
        let approved = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "approved".to_string(),
                title: "Approved".to_string(),
                objective: "Approve".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        update_run_current_task(&conn, &run.id, Some(&approved.id)).unwrap();
        enter_human_approval(&conn, &spec, &run.id, &approved).unwrap();

        let decided = decide_human_approval(&conn, &run.id, HumanApprovalDecision::Approve, None)
            .expect("approve final task");

        assert_eq!(decided.state, LoopRunState::Attention);
        assert!(decided
            .error
            .as_deref()
            .is_some_and(|error| error.contains("require human attention")));
    }

    #[test]
    fn loop_requires_at_least_one_sensor() {
        let conn = test_db();
        let mut input = spec_input();
        input.evaluator_prompt = None;
        input.verifier_program = None;
        input.verifier_args.clear();

        let error =
            save_loop_spec(&conn, "ws-1", input).expect_err("unverified loop must be rejected");

        assert!(error.contains("verification, evaluator, or human approval"));
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
            LoopRunState::Attention
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

    #[test]
    fn a_paused_run_can_be_claimed_for_resume_only_once() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        set_run_state(&conn, &run.id, LoopRunState::Paused, None).expect("pause run");

        let claimed = claim_paused_run(&conn, &run.id).expect("claim paused run");
        assert_eq!(claimed.state, LoopRunState::Resuming);
        assert_eq!(claimed.control_requested, "none");
        assert!(claim_paused_run(&conn, &run.id).is_err());
    }

    #[test]
    fn kill_preserves_terminal_tasks_and_releases_unfinished_keys() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let accepted = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "accepted".to_string(),
                title: "Accepted".to_string(),
                objective: "Already done".to_string(),
            },
        )
        .expect("enqueue accepted")
        .expect("accepted inserted");
        set_task_state(&conn, &accepted.id, LoopTaskState::Accepted, None).expect("accept task");
        let queued = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "queued".to_string(),
                title: "Queued".to_string(),
                objective: "Not started".to_string(),
            },
        )
        .expect("enqueue queued")
        .expect("queued inserted");
        conn.execute(
            "UPDATE loop_runs SET current_task_id = ?1 WHERE id = ?2",
            params![accepted.id, run.id],
        )
        .expect("point at terminal task");
        let current = get_loop_run(&conn, &run.id)
            .expect("load run")
            .expect("run exists");

        assert!(apply_control_request(&conn, &current, "kill").expect("kill run"));

        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load killed run")
                .expect("run exists")
                .state,
            LoopRunState::Killed
        );
        let tasks = list_loop_tasks(&conn, &run.id).expect("list tasks");
        assert_eq!(
            tasks
                .iter()
                .find(|task| task.id == accepted.id)
                .unwrap()
                .state,
            LoopTaskState::Accepted
        );
        assert_eq!(
            tasks
                .iter()
                .find(|task| task.id == queued.id)
                .unwrap()
                .state,
            LoopTaskState::Interrupted
        );
    }

    #[test]
    fn stop_is_applied_immediately_to_a_paused_run() {
        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "queued".to_string(),
                title: "Queued".to_string(),
                objective: "Not started".to_string(),
            },
        )
        .expect("enqueue queued");
        set_run_state(&conn, &run.id, LoopRunState::Paused, None).expect("pause run");
        let paused = get_loop_run(&conn, &run.id)
            .expect("load run")
            .expect("run exists");

        assert!(!apply_control_request(&conn, &paused, "stop").expect("stop paused run"));
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load stopped run")
                .expect("run exists")
                .state,
            LoopRunState::Attention
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].state,
            LoopTaskState::Blocked
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
    async fn pause_requested_while_resuming_is_not_cleared() {
        use crate::loop_agent::ScriptedAgentRuntime;
        use std::sync::{Arc, Mutex};

        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        let task = enqueue_task(
            &conn,
            &run.id,
            &spec.id,
            &DiscoveredTask {
                key: "queued".to_string(),
                title: "Queued".to_string(),
                objective: "Do not start while pausing".to_string(),
            },
        )
        .expect("enqueue task")
        .expect("task inserted");
        set_run_state(&conn, &run.id, LoopRunState::Paused, None).expect("pause run");
        let claimed = claim_paused_run(&conn, &run.id).expect("claim resume");
        assert_eq!(claimed.state, LoopRunState::Resuming);
        set_run_control(&conn, &run.id, "pause").expect("request pause during startup");
        let db = Arc::new(Mutex::new(conn));
        let runtime = Arc::new(ScriptedAgentRuntime::new(vec![])) as Arc<dyn LoopAgentRuntime>;

        execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect("honor pause before starting worker");

        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Paused
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].id,
            task.id
        );
        assert_eq!(
            list_loop_tasks(&conn, &run.id).expect("list tasks")[0].state,
            LoopTaskState::Queued
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

    #[tokio::test]
    async fn executor_error_releases_current_and_queued_task_keys() {
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
                content: r#"{"tasks":[
                    {"key":"first","title":"First","objective":"Fail parsing"},
                    {"key":"second","title":"Second","objective":"Wait in queue"}
                ]}"#
                .to_string(),
                events: vec![],
            },
            ScriptedAgentResponse {
                role: AgentRole::Worker,
                session_id: "worker-1".to_string(),
                content: "not-json".to_string(),
                events: vec![],
            },
        ]));
        let db = Arc::new(Mutex::new(conn));

        let error = execute_manual_loop(
            Arc::clone(&db),
            runtime,
            &run.id,
            std::path::PathBuf::from("/tmp/repo"),
        )
        .await
        .expect_err("malformed worker result must fail");

        assert!(error.contains("invalid result JSON"));
        let conn = db.lock().unwrap();
        assert_eq!(
            get_loop_run(&conn, &run.id)
                .expect("load run")
                .expect("run exists")
                .state,
            LoopRunState::Attention
        );
        assert!(list_loop_tasks(&conn, &run.id)
            .expect("list tasks")
            .iter()
            .all(|task| task.state == LoopTaskState::Interrupted));
    }

    #[test]
    fn malformed_orchestrator_tasks_are_rejected_without_guessing() {
        let error =
            parse_discovered_tasks(r#"{"tasks":[{"title":"Missing key","objective":"Do work"}]}"#)
                .expect_err("missing key must fail");

        assert!(error.contains("key"));
    }

    #[test]
    fn structured_agent_outputs_accept_one_markdown_json_block() {
        let tasks = parse_discovered_tasks(
            "Smallest useful task:\n\n```json\n\
             {\"tasks\":[{\"key\":\"chapter-1\",\"title\":\"Translate\",\
             \"objective\":\"Create the English chapter\"}]}\n```",
        )
        .expect("parse fenced orchestrator JSON");
        assert_eq!(tasks[0].key, "chapter-1");

        let worker = parse_worker_output(
            "Done.\n```json\n\
             {\"status\":\"completed\",\"summary\":\"Translated\",\
             \"evidence\":[\"output file\"]}\n```",
        )
        .expect("parse fenced worker JSON");
        assert_eq!(worker.status, WorkerStatus::Completed);

        let evaluator = parse_evaluator_output(
            "Verdict:\n```json\n\
             {\"verdict\":\"accepted\",\"summary\":\"Correct\",\
             \"feedback\":null,\"evidence\":[]}\n```",
        )
        .expect("parse fenced evaluator JSON");
        assert_eq!(evaluator.verdict, EvaluatorVerdict::Accepted);
    }

    #[test]
    fn structured_agent_outputs_accept_one_json_object_after_prose() {
        let tasks = parse_discovered_tasks(
            "No English counterparts exist, so translate chapter one.\n\n\
             {\"tasks\":[{\"key\":\"chapter-1\",\"title\":\"Translate\",\
             \"objective\":\"Create the English chapter\"}]}",
        )
        .expect("parse JSON after prose");

        assert_eq!(tasks[0].key, "chapter-1");
    }

    #[test]
    fn structured_agent_outputs_reject_ambiguous_json_objects() {
        let error = parse_discovered_tasks(
            "```json\n{\"tasks\":[]}\n```\n\
             ```json\n{\"tasks\":[]}\n```",
        )
        .expect_err("multiple JSON objects must be rejected");

        assert!(error.contains("exactly one matching JSON object"));
    }

    #[test]
    fn structured_agent_outputs_reject_valid_nested_json_inside_malformed_outer_json() {
        let error = parse_discovered_tasks("Result: {\"wrapper\":{\"tasks\":[]}")
            .expect_err("malformed outer JSON must not expose its nested object");

        assert!(error.contains("malformed embedded JSON"));
    }

    #[test]
    fn token_deltas_are_not_persisted_and_event_reads_are_bounded() {
        assert!(!should_persist_agent_event("assistant.message_delta"));
        assert!(!should_persist_agent_event("assistant.reasoning_delta"));
        assert!(!should_persist_agent_event("tool.execution_partial_result"));
        assert!(!should_persist_agent_event("tool.execution_progress"));
        assert!(should_persist_agent_event("assistant.message"));

        let conn = test_db();
        let spec = save_loop_spec(&conn, "ws-1", spec_input()).expect("save loop spec");
        set_loop_enabled(&conn, &spec.id, true).expect("enable loop");
        let run = create_loop_run(&conn, &spec.id, 600).expect("create run");
        for index in 0..510 {
            append_loop_event(
                &conn,
                &spec.id,
                &run.id,
                None,
                "agent.tool",
                &serde_json::json!({ "index": index }),
            )
            .expect("append event");
        }

        let events = list_loop_events(&conn, &run.id).expect("list events");
        assert_eq!(events.len(), 500);
        assert_eq!(
            events
                .first()
                .and_then(|event| event.payload["index"].as_i64()),
            Some(10)
        );
        assert_eq!(
            events
                .last()
                .and_then(|event| event.payload["index"].as_i64()),
            Some(509)
        );

        append_loop_event(
            &conn,
            &spec.id,
            &run.id,
            None,
            "agent.tool.execution_complete",
            &serde_json::json!({ "output": "x".repeat(32 * 1024) }),
        )
        .expect("append bounded event");
        let events = list_loop_events(&conn, &run.id).expect("list bounded events");
        assert_eq!(
            events
                .last()
                .and_then(|event| event.payload["truncated"].as_bool()),
            Some(true)
        );
    }
}

use crate::loop_agent::{
    AgentRole, LoopAgentRuntime, ScriptedAgentResponse, ScriptedAgentRuntime, SdkAgentRuntime,
};
use crate::loops::{
    create_loop_run, execute_manual_loop, get_loop_run, get_loop_spec, loop_snapshot,
    save_loop_spec, set_loop_enabled, set_run_control, set_run_state, LoopRunState, LoopSnapshot,
    LoopSpecInput,
};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const USAGE: &str = "Usage:
  workstreams-loop configure <db-path> <workstream-id> <spec-json-file>
  workstreams-loop enable <db-path> <workstream-id> <true|false>
  workstreams-loop run <db-path> <workstream-id>
  workstreams-loop status <db-path> <workstream-id>
  workstreams-loop control <db-path> <run-id> <pause|stop|kill>
  workstreams-loop scenario <db-path> <workspace>";

fn open(path: &Path) -> Result<Connection, String> {
    crate::db::open_db(path).map_err(|error| format!("Failed to open Workstreams DB: {error}"))
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .map_err(|error| format!("Failed to encode CLI output: {error}"))?
    );
    Ok(())
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|error| format!("Failed to start async runtime: {error}"))
}

fn workstream_directory(conn: &Connection, workstream_id: &str) -> Result<PathBuf, String> {
    let directory: Option<String> = conn
        .query_row(
            "SELECT directory FROM workstreams WHERE id = ?1",
            [workstream_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Failed to load workstream: {error}"))?;
    directory
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "The workstream has no directory".to_string())
}

fn run_real_loop(db_path: &Path, workstream_id: &str) -> Result<LoopSnapshot, String> {
    let conn = open(db_path)?;
    let spec = get_loop_spec(&conn, workstream_id)?
        .ok_or_else(|| "Configure this workstream's loop first".to_string())?;
    let directory = workstream_directory(&conn, workstream_id)?;
    let run = create_loop_run(&conn, &spec.id, spec.run_timeout_seconds)?;
    drop(conn);

    let db = Arc::new(Mutex::new(open(db_path)?));
    runtime()?.block_on(async {
        let runtime = Arc::new(SdkAgentRuntime::connect().await?) as Arc<dyn LoopAgentRuntime>;
        let result =
            execute_manual_loop(Arc::clone(&db), Arc::clone(&runtime), &run.id, directory).await;
        let shutdown = runtime.shutdown().await;
        result?;
        shutdown
    })?;
    let conn = db.lock().unwrap();
    loop_snapshot(&conn, workstream_id)
}

fn configure(args: &[String]) -> Result<(), String> {
    let [db_path, workstream_id, spec_path] = args else {
        return Err(USAGE.to_string());
    };
    let input: LoopSpecInput = serde_json::from_str(
        &std::fs::read_to_string(spec_path)
            .map_err(|error| format!("Failed to read loop spec: {error}"))?,
    )
    .map_err(|error| format!("Invalid loop spec JSON: {error}"))?;
    let spec = save_loop_spec(&open(Path::new(db_path))?, workstream_id, input)?;
    print_json(&spec)
}

fn enable(args: &[String]) -> Result<(), String> {
    let [db_path, workstream_id, enabled] = args else {
        return Err(USAGE.to_string());
    };
    let enabled = enabled
        .parse::<bool>()
        .map_err(|_| "Enabled must be true or false".to_string())?;
    let conn = open(Path::new(db_path))?;
    let spec = get_loop_spec(&conn, workstream_id)?
        .ok_or_else(|| "Configure this workstream's loop first".to_string())?;
    set_loop_enabled(&conn, &spec.id, enabled)?;
    print_json(&loop_snapshot(&conn, workstream_id)?)
}

fn status(args: &[String]) -> Result<(), String> {
    let [db_path, workstream_id] = args else {
        return Err(USAGE.to_string());
    };
    print_json(&loop_snapshot(&open(Path::new(db_path))?, workstream_id)?)
}

fn control(args: &[String]) -> Result<(), String> {
    let [db_path, run_id, action] = args else {
        return Err(USAGE.to_string());
    };
    if !matches!(action.as_str(), "pause" | "stop" | "kill") {
        return Err("Control action must be pause, stop, or kill".to_string());
    }
    let conn = open(Path::new(db_path))?;
    let run =
        get_loop_run(&conn, run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?;
    set_run_control(&conn, run_id, action)?;
    if action == "kill" {
        if let Some(task_id) = run.current_task_id {
            conn.execute(
                "UPDATE loop_tasks
                 SET state = 'interrupted', error = 'Loop killed from CLI', updated_at = ?1
                 WHERE id = ?2",
                params![crate::now(), task_id],
            )
            .map_err(|error| format!("Failed to interrupt loop task: {error}"))?;
        }
        set_run_state(&conn, run_id, LoopRunState::Killed, None)?;
    }
    print_json(
        &get_loop_run(&conn, run_id)?.ok_or_else(|| format!("Loop run not found: {run_id}"))?,
    )
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let Some((command, rest)) = args.split_first() else {
        return Err(USAGE.to_string());
    };
    match command.as_str() {
        "configure" => configure(rest),
        "enable" => enable(rest),
        "status" => status(rest),
        "control" => control(rest),
        "run" => {
            let [db_path, workstream_id] = rest else {
                return Err(USAGE.to_string());
            };
            print_json(&run_real_loop(Path::new(db_path), workstream_id)?)
        }
        "scenario" => {
            let [db_path, workspace] = rest else {
                return Err(USAGE.to_string());
            };
            print_json(&run_scenario(Path::new(db_path), Path::new(workspace))?)
        }
        _ => Err(USAGE.to_string()),
    }
}

#[derive(Debug, Serialize)]
struct ScenarioResult {
    first_run_state: String,
    first_run_tasks: usize,
    accepted_tasks: usize,
    verification_status: String,
    second_run_tasks: usize,
}

fn run_scenario(db_path: &Path, workspace: &Path) -> Result<ScenarioResult, String> {
    let conn = open(db_path)?;
    conn.execute(
        "INSERT OR IGNORE INTO workstreams (
            id, name, directory, status, workstream_type, created_at, updated_at
         ) VALUES ('cli-loop-scenario', 'CLI Loop Scenario', ?1, 'active', 'worktree', ?2, ?2)",
        params![workspace.to_string_lossy(), crate::now()],
    )
    .map_err(|error| format!("Failed to seed CLI scenario: {error}"))?;

    #[cfg(unix)]
    let (program, verifier_args) = (
        "/bin/sh".to_string(),
        vec![
            "-c".to_string(),
            "test -d . && printf CLI_VERIFIED".to_string(),
        ],
    );
    #[cfg(windows)]
    let (program, verifier_args) = (
        "cmd.exe".to_string(),
        vec![
            "/C".to_string(),
            "if exist . (echo CLI_VERIFIED) else exit /b 1".to_string(),
        ],
    );

    let spec = save_loop_spec(
        &conn,
        "cli-loop-scenario",
        LoopSpecInput {
            orchestrator_prompt: "Return one deterministic coding task".to_string(),
            worker_prompt: "Complete the deterministic fixture task".to_string(),
            evaluator_prompt: "Accept only with passing verifier evidence".to_string(),
            orchestrator_model: None,
            worker_model: None,
            evaluator_model: None,
            verifier_program: Some(program),
            verifier_args,
            verifier_cwd: Some(workspace.to_string_lossy().into_owned()),
            run_timeout_seconds: 30,
            max_task_iterations: 2,
        },
    )?;
    set_loop_enabled(&conn, &spec.id, true)?;
    let first_run = create_loop_run(&conn, &spec.id, 30)?;
    drop(conn);

    let first_runtime = Arc::new(ScriptedAgentRuntime::new(vec![
        ScriptedAgentResponse {
            role: AgentRole::Orchestrator,
            session_id: "scenario-orchestrator".to_string(),
            content: r#"{"tasks":[{"key":"fixture-task","title":"Fixture task","objective":"Complete the fixture coding task"}]}"#.to_string(),
            events: vec![],
        },
        ScriptedAgentResponse {
            role: AgentRole::Worker,
            session_id: "scenario-worker".to_string(),
            content: r#"{"status":"completed","summary":"Fixture completed","evidence":["workspace"]}"#.to_string(),
            events: vec![],
        },
        ScriptedAgentResponse {
            role: AgentRole::Evaluator,
            session_id: "scenario-evaluator".to_string(),
            content: r#"{"verdict":"accepted","summary":"Verifier passed","evidence":["CLI_VERIFIED"]}"#.to_string(),
            events: vec![],
        },
    ])) as Arc<dyn LoopAgentRuntime>;
    let db = Arc::new(Mutex::new(open(db_path)?));
    runtime()?.block_on(execute_manual_loop(
        Arc::clone(&db),
        first_runtime,
        &first_run.id,
        workspace.to_path_buf(),
    ))?;
    let first_snapshot = loop_snapshot(&db.lock().unwrap(), "cli-loop-scenario")?;

    let second_run = {
        let conn = db.lock().unwrap();
        create_loop_run(&conn, &spec.id, 30)?
    };
    let second_runtime = Arc::new(ScriptedAgentRuntime::new(vec![ScriptedAgentResponse {
        role: AgentRole::Orchestrator,
        session_id: "scenario-orchestrator-2".to_string(),
        content: r#"{"tasks":[{"key":"fixture-task","title":"Fixture task","objective":"Complete the fixture coding task"}]}"#.to_string(),
        events: vec![],
    }])) as Arc<dyn LoopAgentRuntime>;
    runtime()?.block_on(execute_manual_loop(
        Arc::clone(&db),
        second_runtime,
        &second_run.id,
        workspace.to_path_buf(),
    ))?;
    let second_snapshot = loop_snapshot(&db.lock().unwrap(), "cli-loop-scenario")?;

    Ok(ScenarioResult {
        first_run_state: format!(
            "{:?}",
            first_snapshot
                .latest_run
                .as_ref()
                .map(|run| run.state)
                .unwrap_or(LoopRunState::Attention)
        )
        .to_lowercase(),
        first_run_tasks: first_snapshot.tasks.len(),
        accepted_tasks: first_snapshot
            .tasks
            .iter()
            .filter(|task| task.state.as_str() == "accepted")
            .count(),
        verification_status: first_snapshot
            .verifications
            .first()
            .map(|verification| verification.status.clone())
            .unwrap_or_else(|| "missing".to_string()),
        second_run_tasks: second_snapshot.tasks.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_commands_with_usage() {
        let error = run(vec!["unknown".to_string()]).expect_err("unknown command");
        assert!(error.contains("Usage:"));
    }

    #[test]
    fn deterministic_scenario_runs_verifier_evaluator_and_deduplication() {
        let root =
            std::env::temp_dir().join(format!("workstreams-loop-cli-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create scenario directory");
        let db_path = root.join("scenario.db");

        let result = run_scenario(&db_path, &root).expect("run CLI scenario");

        assert_eq!(result.first_run_state, "completed");
        assert_eq!(result.first_run_tasks, 1);
        assert_eq!(result.accepted_tasks, 1);
        assert_eq!(result.verification_status, "passed");
        assert_eq!(result.second_run_tasks, 0);
        std::fs::remove_dir_all(root).ok();
    }
}

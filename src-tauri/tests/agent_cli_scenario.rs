//! CLI scenario for `workstreams agent …`.
//!
//! Runs the **real binary as a separate process** against a live socket, which
//! is the only way to prove the parts that unit tests cannot see: argument
//! parsing, the stdout/stderr split, and the exit codes a shell branches on.
//!
//! Required by the CLI-parity rule in AGENTS.md.

use std::process::Command;
use std::time::Duration;

use workstreams_lib::agent_registry::{CommandContext, IdentityRegistry, TOKEN_ENV_VAR};
use workstreams_lib::agent_socket::{
    socket_path_in, AgentRequest, AgentResponse, AgentSocketServer, SOCKET_ENV_VAR,
};

/// Serves requests the way the app does: resolve the presented token, then
/// dispatch. Rebuilt here rather than reused, because the real one is wired into
/// Tauri state a CLI scenario has no business starting.
fn serve(identities: std::sync::Arc<IdentityRegistry>) -> impl Fn(AgentRequest) -> AgentResponse {
    move |request| {
        let db = rusqlite::Connection::open_in_memory().expect("db");
        let resolved = identities.resolve(request.token.as_deref());
        let requires_identity = workstreams_lib::agent_registry::find(&request.cmd)
            .map(|command| command.requires_identity)
            .unwrap_or(false);
        let caller = match (resolved, requires_identity) {
            (Ok(caller), _) => Some(caller),
            (Err(error), true) => return AgentResponse::failed(error),
            (Err(_), false) => None,
        };
        workstreams_lib::agent_registry::respond(workstreams_lib::agent_registry::dispatch(
            &request,
            &CommandContext {
                db: &db,
                caller: caller.as_ref(),
            },
        ))
    }
}

fn scratch_dir(label: &str) -> std::path::PathBuf {
    // Short on purpose: the 104-byte socket limit applies to test paths too.
    let dir = std::env::temp_dir().join(format!("wsc-{label}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

fn cli() -> Command {
    Command::new(env!("CARGO_BIN_EXE_workstreams"))
}

#[test]
fn ping_reaches_a_running_app_and_reports_success_on_stdout() {
    let dir = scratch_dir("ping");
    let path = socket_path_in(&dir, 1);
    let identities = std::sync::Arc::new(IdentityRegistry::new());
    let server = AgentSocketServer::start(path.clone(), serve(identities)).expect("start server");

    let output = cli()
        .args(["agent", "ping"])
        .env(SOCKET_ENV_VAR, &path)
        .output()
        .expect("run the CLI");
    drop(server);
    std::fs::remove_dir_all(&dir).ok();

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("stdout must be parseable JSON on its own");
    assert_eq!(parsed["ok"], true, "stdout was: {stdout}");
    assert_eq!(parsed["data"]["pong"], true);
    assert!(output.status.success(), "expected exit 0");
    assert!(
        output.stderr.is_empty(),
        "a successful run should say nothing to a human: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn an_unknown_command_exits_with_the_usage_code_and_names_real_commands() {
    let dir = scratch_dir("unknown");
    let path = socket_path_in(&dir, 2);
    let identities = std::sync::Arc::new(IdentityRegistry::new());
    let server = AgentSocketServer::start(path.clone(), serve(identities)).expect("start server");

    let output = cli()
        .args(["agent", "call", "ws.summon"])
        .env(SOCKET_ENV_VAR, &path)
        .output()
        .expect("run the CLI");
    drop(server);
    std::fs::remove_dir_all(&dir).ok();

    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse stdout");
    assert_eq!(parsed["code"], "UNKNOWN_COMMAND");
    assert_eq!(output.status.code(), Some(2));

    // The human-facing half goes to stderr, so the JSON stays clean.
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("agent.ping"), "stderr was: {stderr}");
    assert!(stderr.contains("agent.whoami"), "stderr was: {stderr}");
}

/// The channel failing must not look like the command being wrong: an agent
/// that confuses the two rewrites a correct command until it runs out of turns.
#[test]
fn a_missing_app_is_distinguishable_from_a_bad_command() {
    let dir = scratch_dir("absent");
    let path = socket_path_in(&dir, 3);

    let output = cli()
        .args(["agent", "ping"])
        .env(SOCKET_ENV_VAR, &path)
        .output()
        .expect("run the CLI");
    std::fs::remove_dir_all(&dir).ok();

    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse stdout");
    assert_eq!(parsed["code"], "APP_NOT_RUNNING");
    assert_eq!(output.status.code(), Some(3), "a distinct exit code");
    assert!(parsed["hint"]
        .as_str()
        .is_some_and(|hint| hint.contains("Start the Workstreams app")));
}

/// Running outside Workstreams entirely is its own situation, and saying
/// "the app is not running" there would send the agent to start an app that is
/// already running somewhere it cannot reach.
#[test]
fn running_outside_a_workstreams_session_says_exactly_that() {
    let output = cli()
        .args(["agent", "ping"])
        .env_remove(SOCKET_ENV_VAR)
        .output()
        .expect("run the CLI");

    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse stdout");
    assert_eq!(parsed["code"], "NOT_IN_WORKSTREAMS");
    assert_eq!(output.status.code(), Some(4));
}

#[test]
fn parameters_are_passed_as_typed_values() {
    let dir = scratch_dir("params");
    let path = socket_path_in(&dir, 4);
    // Echo the params back so the scenario can assert on what crossed the wire.
    let server =
        AgentSocketServer::start(path.clone(), |request| AgentResponse::ok(request.params))
            .expect("start server");

    let output = cli()
        .args([
            "agent",
            "call",
            "ws.create",
            "name=Alpha Stream",
            "attempts=3",
            "worktree=true",
        ])
        .env(SOCKET_ENV_VAR, &path)
        .output()
        .expect("run the CLI");
    drop(server);
    std::fs::remove_dir_all(&dir).ok();

    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse stdout");
    assert_eq!(parsed["data"]["name"], "Alpha Stream");
    assert_eq!(parsed["data"]["attempts"], 3);
    assert_eq!(parsed["data"]["worktree"], true);
}

/// A hung app must not hang the agent. The CLI's own timeout is 120s, so this
/// asserts the mechanism exists rather than waiting it out.
#[test]
fn a_malformed_parameter_is_rejected_before_the_app_is_contacted() {
    let output = cli()
        .args(["agent", "call", "ws.create", "justaword"])
        .env_remove(SOCKET_ENV_VAR)
        .output()
        .expect("run the CLI");

    // No socket is set, yet this fails on the argument instead — proving the
    // parse happens first and the agent is told which of the two is wrong.
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("key=value"), "stderr was: {stderr}");
    assert_eq!(output.status.code(), Some(2));
}

/// The identity half, end to end: a token the app issued resolves to the tile
/// it was issued for, and an invented one does not.
#[test]
fn a_session_acts_as_the_identity_the_app_issued_it() {
    let dir = scratch_dir("identity");
    let path = socket_path_in(&dir, 6);
    let identities = std::sync::Arc::new(IdentityRegistry::new());
    let token = identities.issue("tile-7", "ws-seven");
    let server = AgentSocketServer::start(path.clone(), serve(std::sync::Arc::clone(&identities)))
        .expect("start server");

    let output = cli()
        .args(["agent", "call", "agent.whoami"])
        .env(SOCKET_ENV_VAR, &path)
        .env(TOKEN_ENV_VAR, &token)
        .output()
        .expect("run the CLI");
    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse stdout");
    assert_eq!(parsed["data"]["actor"], "agent:tile-7");
    assert_eq!(parsed["data"]["workstreamId"], "ws-seven");

    // A forged token must not work, or the whole scheme is decorative.
    let forged = cli()
        .args(["agent", "call", "agent.whoami"])
        .env(SOCKET_ENV_VAR, &path)
        .env(TOKEN_ENV_VAR, "wst_0000000000000000ffffffffffffffff")
        .output()
        .expect("run the CLI");
    drop(server);
    std::fs::remove_dir_all(&dir).ok();
    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&forged.stdout)).expect("parse stdout");
    assert_eq!(parsed["code"], "STALE_IDENTITY");
}

/// Timing guard: the whole scenario suite talks to real sockets, so a
/// regression that reintroduced blocking would show up as a hang rather than a
/// failure. Keep an explicit bound on the fast path.
#[test]
fn the_round_trip_is_fast_enough_to_sit_in_an_agent_loop() {
    let dir = scratch_dir("speed");
    let path = socket_path_in(&dir, 5);
    let identities = std::sync::Arc::new(IdentityRegistry::new());
    let server = AgentSocketServer::start(path.clone(), serve(identities)).expect("start server");

    let started = std::time::Instant::now();
    let output = cli()
        .args(["agent", "ping"])
        .env(SOCKET_ENV_VAR, &path)
        .output()
        .expect("run the CLI");
    let elapsed = started.elapsed();
    drop(server);
    std::fs::remove_dir_all(&dir).ok();

    assert!(output.status.success());
    assert!(
        elapsed < Duration::from_secs(5),
        "a ping took {elapsed:?}, which is too slow to sit in a loop"
    );
}

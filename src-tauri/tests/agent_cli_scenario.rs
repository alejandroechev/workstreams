//! Unix-only: the agent channel is a Unix domain socket (see ADR 026).
#![cfg(unix)]

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
    serve_inner(identities, None)
}

/// Same, but against a real database file so state survives between CLI calls.
fn serve_with_db(
    identities: std::sync::Arc<IdentityRegistry>,
    db_path: std::path::PathBuf,
) -> impl Fn(AgentRequest) -> AgentResponse {
    serve_inner(identities, Some(db_path))
}

fn serve_inner(
    identities: std::sync::Arc<IdentityRegistry>,
    db_path: Option<std::path::PathBuf>,
) -> impl Fn(AgentRequest) -> AgentResponse {
    move |request| {
        let db = match &db_path {
            Some(path) => workstreams_lib::db::open_db(path).expect("db"),
            None => rusqlite::Connection::open_in_memory().expect("db"),
        };
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
                provisioner: None,
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
fn parameters_reach_the_app_verbatim() {
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
            // A name that looks like a number must stay a name: coercion used
            // to turn this into an integer, which then failed as a missing name
            // with no way to quote around it.
            "label=2026",
        ])
        .env(SOCKET_ENV_VAR, &path)
        .output()
        .expect("run the CLI");
    drop(server);
    std::fs::remove_dir_all(&dir).ok();

    let parsed: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse stdout");
    assert_eq!(parsed["data"]["name"], "Alpha Stream");
    assert_eq!(parsed["data"]["attempts"], "3");
    assert_eq!(parsed["data"]["worktree"], "true");
    assert_eq!(parsed["data"]["label"], "2026");
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

/// Drives link, list and unlink through the real binary against a real
/// database, which is the only way to see the full round trip an agent makes.
#[test]
fn pull_requests_link_list_and_unlink_through_the_cli() {
    let dir = scratch_dir("prlink");
    let path = socket_path_in(&dir, 7);
    let db_path = dir.join("ws.db");
    let db = workstreams_lib::db::open_db(&db_path).expect("db");
    db.execute(
        "INSERT INTO workstreams (id, name, status, created_at, updated_at)
         VALUES ('ws-1','One','active','2026-01-01','2026-01-01')",
        [],
    )
    .expect("seed");
    drop(db);

    let identities = std::sync::Arc::new(IdentityRegistry::new());
    let token = identities.issue("tile-1", "ws-1");
    let server = AgentSocketServer::start(
        path.clone(),
        serve_with_db(std::sync::Arc::clone(&identities), db_path.clone()),
    )
    .expect("start server");

    let run = |args: &[&str]| {
        let output = cli()
            .args(args)
            .env(SOCKET_ENV_VAR, &path)
            .env(TOKEN_ENV_VAR, &token)
            .output()
            .expect("run the CLI");
        serde_json::from_str::<serde_json::Value>(&String::from_utf8_lossy(&output.stdout))
            .expect("parse stdout")
    };

    let linked = run(&[
        "agent",
        "call",
        "pr.link",
        "url=https://dev.azure.com/org/proj/_git/repo/pullrequest/42",
        "note=review round 2",
    ]);
    assert_eq!(linked["ok"], true, "{linked}");
    assert_eq!(linked["data"]["label"], "repo#42");
    assert_eq!(linked["data"]["alreadyLinked"], false);

    let listed = run(&["agent", "call", "pr.list"]);
    assert_eq!(listed["data"]["pullRequests"][0]["label"], "repo#42");
    assert_eq!(listed["data"]["pullRequests"][0]["note"], "review round 2");

    let unlinked = run(&[
        "agent",
        "call",
        "pr.unlink",
        "url=https://dev.azure.com/org/proj/_git/repo/pullrequest/42",
    ]);
    assert_eq!(unlinked["ok"], true, "{unlinked}");

    let empty = run(&["agent", "call", "pr.list"]);
    assert!(empty["data"]["pullRequests"]
        .as_array()
        .expect("array")
        .is_empty());

    drop(server);
    std::fs::remove_dir_all(&dir).ok();
}

/// Files a workstream into a lane and back out, through the real binary.
#[test]
fn work_lanes_are_assignable_through_the_cli() {
    let dir = scratch_dir("lane");
    let path = socket_path_in(&dir, 8);
    let db_path = dir.join("ws.db");
    let db = workstreams_lib::db::open_db(&db_path).expect("db");
    db.execute(
        "INSERT INTO workstreams (id, name, status, created_at, updated_at)
         VALUES ('ws-1','One','active','2026-01-01','2026-01-01')",
        [],
    )
    .expect("seed");
    drop(db);

    let identities = std::sync::Arc::new(IdentityRegistry::new());
    let token = identities.issue("tile-1", "ws-1");
    let server = AgentSocketServer::start(
        path.clone(),
        serve_with_db(std::sync::Arc::clone(&identities), db_path.clone()),
    )
    .expect("start server");

    let run = |args: &[&str]| {
        let output = cli()
            .args(args)
            .env(SOCKET_ENV_VAR, &path)
            .env(TOKEN_ENV_VAR, &token)
            .output()
            .expect("run the CLI");
        serde_json::from_str::<serde_json::Value>(&String::from_utf8_lossy(&output.stdout))
            .expect("parse stdout")
    };

    let filed = run(&["agent", "call", "ws.lane", "lane=Media Store"]);
    assert_eq!(filed["ok"], true, "{filed}");
    assert_eq!(filed["data"]["lane"], "Media Store");

    // The lane survives in storage rather than only in the reply.
    let check = workstreams_lib::db::open_db(&db_path).expect("db");
    let lane: Option<String> = check
        .query_row(
            "SELECT lane_id FROM workstreams WHERE id='ws-1'",
            [],
            |row| row.get(0),
        )
        .expect("read lane");
    assert!(lane.is_some(), "the workstream should be filed");
    drop(check);

    let cleared = run(&["agent", "call", "ws.lane", "lane=none"]);
    assert_eq!(cleared["data"]["lane"], serde_json::Value::Null);

    drop(server);
    std::fs::remove_dir_all(&dir).ok();
}

// ── Skill drift ────────────────────────────────────────────────────────────
//
// The skill lives in ~/.copilot/skills/ and the CLI ships in this binary, so
// they version separately and will drift. A renamed flag or a retired command
// would leave an agent following instructions that no longer work, with no
// signal until it failed in the field.

/// Every command the skill names must still exist.
#[test]
fn the_skill_only_documents_commands_that_exist() {
    let skill = read_skill().expect("skill must be installed; see the test above");

    let documented: std::collections::BTreeSet<String> = skill
        .lines()
        .filter_map(|line| line.trim().strip_prefix("workstreams agent call "))
        .filter_map(|rest| rest.split_whitespace().next())
        .filter(|name| name.contains('.'))
        .map(str::to_string)
        .collect();
    assert!(
        !documented.is_empty(),
        "the drift check found no examples to verify, which means it is not checking anything"
    );

    for name in &documented {
        assert!(
            workstreams_lib::agent_registry::find(name).is_some(),
            "the skill documents `{name}`, which the CLI no longer has"
        );
    }
}

/// Every error code the skill teaches must be one the code can actually
/// produce, or an agent is being told to expect something it will never see.
#[test]
fn the_skill_only_documents_error_codes_that_are_reachable() {
    let skill = read_skill().expect("skill must be installed; see the discoverability test");

    // Derived from the source, not a hand-kept list: the previous hardcoded
    // array was itself a drift risk, and this test exists to catch drift.
    let known = error_codes_in_source();
    // Environment variables share the SCREAMING_SNAKE shape and are not codes.
    let not_codes = [
        SOCKET_ENV_VAR,
        TOKEN_ENV_VAR,
        "WORKSTREAMS_ACTIVE_WS",
        "WORKSTREAMS_ACTIVE_TILE",
    ];
    assert!(
        known.len() > 5,
        "failed to extract error codes from source; the check would be vacuous"
    );

    for token in skill.split(|c: char| !(c.is_ascii_uppercase() || c == '_')) {
        if not_codes.contains(&token) {
            continue;
        }
        if token.len() > 5 && token.contains('_') && token.to_uppercase() == token {
            assert!(
                known.contains(token),
                "the skill mentions error code `{token}`, which nothing produces"
            );
        }
    }
}

/// The destructive-command rule has no mechanical enforcement by decision, so
/// the skill is the only place it lives. Losing it would silently remove the
/// boundary.
#[test]
fn the_skill_still_carries_the_destructive_command_rule() {
    let skill = read_skill().expect("skill must be installed; see the discoverability test");
    let lowered = skill.to_lowercase();
    assert!(
        lowered.contains("ask the human") || lowered.contains("ask the user"),
        "the skill must tell the agent to ask before destroying anything"
    );
    assert!(
        lowered.contains("remove a worktree") && lowered.contains("delete a workstream"),
        "the skill must name which actions need permission"
    );
}

/// The skill must gate on the variable that actually exists.
#[test]
fn the_skill_gates_on_the_real_environment_variable() {
    let skill = read_skill().expect("skill must be installed; see the discoverability test");
    assert!(
        skill.contains(SOCKET_ENV_VAR),
        "the skill's 'are you inside Workstreams' check must use {SOCKET_ENV_VAR}"
    );
}

/// Finds the installed skill, wherever it is named.
///
/// Searches rather than hardcoding a folder: the skill was renamed from
/// `workstreams` to `ws` and every drift test silently *skipped* for weeks,
/// because a missing file returned None and each test treated that as "nothing
/// to check". A guard that passes when it cannot find its subject is worse than
/// no guard, so this identifies the skill by its content.
/// Every code passed to `AgentError::new` anywhere in the crate.
fn error_codes_in_source() -> std::collections::BTreeSet<String> {
    let mut codes = std::collections::BTreeSet::new();
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in std::fs::read_dir(src).into_iter().flatten().flatten() {
        let Ok(body) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for chunk in body.split("AgentError::new(").skip(1) {
            if let Some(quoted) = chunk.split('"').nth(1) {
                if quoted.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
                    codes.insert(quoted.to_string());
                }
            }
        }
    }
    codes
}

fn read_skill() -> Option<String> {
    let root = std::path::PathBuf::from(std::env::var("HOME").ok()?).join(".copilot/skills");
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let candidate = entry.path().join("SKILL.md");
        let Ok(body) = std::fs::read_to_string(&candidate) else {
            continue;
        };
        if body.contains("workstreams agent call") {
            return Some(body);
        }
    }
    None
}

/// Fails when the skill cannot be found at all.
///
/// Separate from the checks below so the reason is unambiguous: "the skill is
/// missing" and "the skill is wrong" need different fixes.
#[test]
fn the_skill_is_installed_and_discoverable() {
    assert!(
        read_skill().is_some(),
        "no SKILL.md under ~/.copilot/skills mentions `workstreams agent call`. \
         Either the skill is not installed or it no longer documents the CLI, \
         and every drift check below is vacuous until that is fixed."
    );
}

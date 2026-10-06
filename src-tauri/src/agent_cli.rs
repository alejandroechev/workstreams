//! The `workstreams agent …` CLI: how an agent drives the running app.
//!
//! Ships in the same binary as the app so the two can never disagree about
//! which commands exist — a separate artifact would advertise capabilities the
//! running instance might not have.
//!
//! Output contract: **JSON on stdout, human-readable text on stderr, non-zero
//! exit on failure.** Agents parse the first, people read the second, and
//! neither has to tolerate the other's format.

use crate::agent_socket::{
    client_socket_path, send_request, AgentError, AgentRequest, AgentResponse, SOCKET_ENV_VAR,
};
use std::time::Duration;

pub const USAGE: &str = "Usage:
  workstreams agent ping
  workstreams agent call <command> [key=value ...]

Output: JSON on stdout, diagnostics on stderr, non-zero exit on failure.

Commands act on the Workstreams app that spawned this session, found via
$WORKSTREAMS_SOCKET. The app must be running.

Destructive commands (anything that deletes a workstream, removes a worktree,
or writes to a workstream you did not create) require the human's agreement
first. Ask before running one.";

/// Reads the identity the app issued to this session.
///
/// Absent when the process was not spawned by Workstreams; the app answers that
/// case, so the CLI does not need to guess at it here.
fn agent_token() -> Option<String> {
    std::env::var(crate::agent_registry::TOKEN_ENV_VAR)
        .ok()
        .filter(|token| !token.trim().is_empty())
}

/// How long to wait for the app before giving up.
///
/// Generous because the slowest command creates a git worktree, which is
/// seconds on a large repository — but bounded, so a wedged app cannot wedge
/// the agent with it.
const TIMEOUT: Duration = Duration::from_secs(120);

/// Exit codes, so a shell can branch without parsing the JSON.
const EXIT_COMMAND_FAILED: i32 = 1;
const EXIT_USAGE: i32 = 2;
const EXIT_APP_NOT_RUNNING: i32 = 3;
const EXIT_NOT_IN_WORKSTREAMS: i32 = 4;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let Some((command, rest)) = args.split_first() else {
        return Err(USAGE.to_string());
    };
    match command.as_str() {
        "ping" => dispatch_and_report(AgentRequest {
            cmd: "agent.ping".to_string(),
            params: serde_json::Value::Null,
            token: agent_token(),
        }),
        "call" => {
            let Some((name, pairs)) = rest.split_first() else {
                return Err(USAGE.to_string());
            };
            let params = parse_params_with(pairs, &mut std::io::stdin().lock())?;
            dispatch_and_report(AgentRequest {
                cmd: name.clone(),
                params,
                token: agent_token(),
            })
        }
        _ => Err(USAGE.to_string()),
    }
}

/// Parses `key=value` arguments into request parameters.
///
/// Flags rather than a JSON blob on argv: shell quoting is a real failure mode
/// for an agent composing a command line, and nested JSON invites it on every
/// call. JSON stays the wire format, where no shell is involved.
#[cfg(test)]
fn parse_params(pairs: &[String]) -> Result<serde_json::Value, String> {
    parse_params_with(pairs, &mut std::io::empty())
}

/// As `parse_params`, where a value of exactly `@-` is read from `stdin`.
///
/// Long or multi-line text (a markdown result for the phone) cannot survive
/// shell quoting reliably; a heredoc on stdin carries it byte for byte.
fn parse_params_with(
    pairs: &[String],
    stdin: &mut dyn std::io::Read,
) -> Result<serde_json::Value, String> {
    let mut map = serde_json::Map::new();
    let mut stdin_used = false;
    for pair in pairs {
        let Some((key, value)) = pair.split_once('=') else {
            return Err(format!(
                "Expected key=value, got: {pair}\n\nHint: quote values containing spaces, e.g. name=\"My workstream\"."
            ));
        };
        if key.is_empty() {
            return Err(format!("Empty parameter name in: {pair}"));
        }
        // Values stay strings. Coercing anything that *looks* numeric silently
        // breaks real input: `name=2026` became the number 2026 and then failed
        // as a missing name, with no way to quote around it because the shell
        // has already removed the quotes. A command that wants a number can
        // parse one; a command that wants a name cannot recover a mangled one.
        let value = if value == "@-" {
            if stdin_used {
                return Err("Only one parameter can be read from stdin (=@-)".to_string());
            }
            stdin_used = true;
            let mut text = String::new();
            stdin
                .read_to_string(&mut text)
                .map_err(|e| format!("Could not read {key} from stdin: {e}"))?;
            text
        } else {
            value.to_string()
        };
        map.insert(key.to_string(), serde_json::Value::String(value));
    }
    Ok(serde_json::Value::Object(map))
}

fn dispatch_and_report(request: AgentRequest) -> Result<(), String> {
    // Never derive a path here. The app names the socket it owns and injects it
    // per session; a client that guessed would probe somewhere nothing has
    // bound and blame the app for being absent.
    let socket = match client_socket_path(std::env::var(SOCKET_ENV_VAR).ok().as_deref()) {
        Ok(socket) => socket,
        Err(error) => {
            report_error(&error);
            std::process::exit(exit_code_for(&error.code));
        }
    };
    match send_request(&socket, &request, TIMEOUT) {
        Ok(response) => report(&response, &socket),
        Err(error) => {
            report_error(&error);
            std::process::exit(exit_code_for(&error.code));
        }
    }
}

fn report(response: &AgentResponse, socket: &std::path::Path) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string_pretty(response)
            .map_err(|error| format!("Failed to encode the response: {error}"))?
    );
    if response.ok {
        return Ok(());
    }
    eprintln!(
        "{}: {}",
        response.code.as_deref().unwrap_or("ERROR"),
        response.message.as_deref().unwrap_or("Command failed")
    );
    if let Some(hint) = response.hint.as_deref() {
        eprintln!("Hint: {hint}");
    }
    eprintln!("Socket: {}", socket.display());
    // Map the app's error code, not a blanket failure: an agent that can tell
    // "wrong command" from "command failed" retries very differently.
    std::process::exit(exit_code_for(response.code.as_deref().unwrap_or("")));
}

fn report_error(error: &AgentError) {
    // The JSON goes to stdout even on failure so an agent has one place to look
    // regardless of outcome.
    println!(
        "{}",
        serde_json::to_string_pretty(&AgentResponse::failed(error.clone()))
            .unwrap_or_else(|_| r#"{"ok":false,"code":"ENCODE_FAILED"}"#.to_string())
    );
    eprintln!("{}: {}", error.code, error.message);
    eprintln!("Hint: {}", error.hint);
}

fn exit_code_for(code: &str) -> i32 {
    match code {
        "APP_NOT_RUNNING" => EXIT_APP_NOT_RUNNING,
        // Not a failure of the app or the command: the caller is somewhere this
        // command cannot work at all, which deserves its own signal.
        "NOT_IN_WORKSTREAMS" => EXIT_NOT_IN_WORKSTREAMS,
        "UNKNOWN_COMMAND" | "BAD_REQUEST" => EXIT_USAGE,
        _ => EXIT_COMMAND_FAILED,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_value_pairs_are_passed_through_as_strings() {
        let params = parse_params(&[
            "name=alpha".to_string(),
            "count=3".to_string(),
            "worktree=true".to_string(),
        ])
        .expect("parse");
        assert_eq!(params["name"], "alpha");
        assert_eq!(params["count"], "3");
        assert_eq!(params["worktree"], "true");
    }

    /// A name that happens to look like a number is still a name. Coercing it
    /// made `ws.create name=2026` fail as if no name had been given, and shell
    /// quoting could not work around it.
    #[test]
    fn a_numeric_looking_value_survives_as_text() {
        let params = parse_params(&["name=2026".to_string(), "description=false".to_string()])
            .expect("parse");
        assert_eq!(params["name"], "2026");
        assert_eq!(params["description"], "false");
    }

    /// A value containing `=` must survive: branch names and paths routinely do.
    #[test]
    fn only_the_first_equals_separates_the_pair() {
        let params = parse_params(&["branch=feature=x".to_string()]).expect("parse");
        assert_eq!(params["branch"], "feature=x");
    }

    #[test]
    fn a_malformed_pair_explains_the_expected_shape() {
        let error = parse_params(&["justaword".to_string()]).expect_err("should fail");
        assert!(error.contains("key=value"), "{error}");
        assert!(error.contains("Hint"), "an agent needs the repair: {error}");
    }

    #[test]
    fn an_empty_parameter_name_is_rejected() {
        assert!(parse_params(&["=value".to_string()]).is_err());
    }

    /// The exit code is what a shell branches on, so "the app is not running"
    /// must be distinguishable from "the command was wrong" without parsing.
    #[test]
    fn exit_codes_separate_channel_failures_from_command_failures() {
        assert_eq!(exit_code_for("APP_NOT_RUNNING"), EXIT_APP_NOT_RUNNING);
        assert_eq!(exit_code_for("UNKNOWN_COMMAND"), EXIT_USAGE);
        assert_eq!(exit_code_for("WORKTREE_EXISTS"), EXIT_COMMAND_FAILED);
        assert_eq!(exit_code_for("NOT_IN_WORKSTREAMS"), EXIT_NOT_IN_WORKSTREAMS);
    }

    #[test]
    fn usage_is_returned_for_an_unknown_or_missing_subcommand() {
        assert!(run(vec![]).is_err());
        assert!(run(vec!["summon".to_string()]).is_err());
        assert!(run(vec!["call".to_string()]).is_err());
    }

    /// The destructive-command rule has no mechanical enforcement by design, so
    /// the usage text is where an agent is told about it. If this disappears,
    /// the boundary disappears with it.
    #[test]
    fn usage_states_the_destructive_command_rule() {
        assert!(USAGE.contains("Destructive"));
        assert!(USAGE.contains("Ask before"));
    }

    #[test]
    fn a_value_of_at_dash_is_read_from_stdin_verbatim() {
        let mut input = std::io::Cursor::new("# Result\n\n- it's \"quoted\" $HOME\n".as_bytes());
        let params = parse_params_with(
            &["kind=result".to_string(), "text=@-".to_string()],
            &mut input,
        )
        .expect("parse");
        assert_eq!(params["text"], "# Result\n\n- it's \"quoted\" $HOME\n");
        assert_eq!(params["kind"], "result");
    }

    #[test]
    fn only_one_value_can_come_from_stdin() {
        let error = parse_params_with(
            &["a=@-".to_string(), "b=@-".to_string()],
            &mut std::io::Cursor::new(b"x".to_vec()),
        )
        .expect_err("should fail");
        assert!(error.contains("Only one"));
    }
}

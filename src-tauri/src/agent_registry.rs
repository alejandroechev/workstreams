//! Named commands an agent may run, and the identity that bounds them.
//!
//! # Why a token
//!
//! The socket is per app *instance*, so every session of that app shares it.
//! That means a request cannot be trusted to say who sent it — an agent could
//! simply name a workstream it does not own. The app therefore mints a token
//! when it spawns a session, injects it into that session's environment, and
//! keeps the mapping to itself. A request proves its identity by presenting a
//! token the app issued; it can never name an identity directly.
//!
//! This is the mechanical half of the authority model. The other half — asking
//! a human before running a destructive command — is deliberately social: there
//! is no confirmation UI, so [`Command::destructive`] exists to be *stated* in
//! the CLI help and the skill, not to block.

use crate::agent_socket::{AgentError, AgentRequest, AgentResponse};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

/// Who is making a request, as far as the app can prove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// The app's own UI. Not reachable over the socket.
    Human,
    /// A session the app spawned, identified by a token it issued.
    Agent {
        tile_id: String,
        workstream_id: String,
    },
}

impl Caller {
    /// How this caller is recorded in the command log.
    ///
    /// Deliberately what the app can prove rather than what the caller claims:
    /// a command typed by hand inside a session tile is recorded as that
    /// session's agent, because the app genuinely cannot tell the difference and
    /// a confident lie in an audit trail is worse than a coarse truth.
    pub fn actor(&self) -> String {
        match self {
            Caller::Human => "human".to_string(),
            Caller::Agent { tile_id, .. } => format!("agent:{tile_id}"),
        }
    }

    pub fn workstream_id(&self) -> Option<&str> {
        match self {
            Caller::Human => None,
            Caller::Agent { workstream_id, .. } => Some(workstream_id),
        }
    }
}

/// Environment variable carrying the token the app issued to a session.
pub const TOKEN_ENV_VAR: &str = "WORKSTREAMS_AGENT_TOKEN";

/// Tokens the app has issued, mapped to the identity each one stands for.
///
/// In-memory on purpose: a token is meaningless once the app that minted it has
/// exited, and persisting one would outlive the session it names.
#[derive(Default)]
pub struct IdentityRegistry {
    tokens: Mutex<HashMap<String, Caller>>,
}

impl IdentityRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues a token for a session tile, replacing any previous one.
    ///
    /// Re-spawning a tile invalidates the old token, so a stale process holding
    /// it cannot keep acting on the workstream.
    pub fn issue(&self, tile_id: &str, workstream_id: &str) -> String {
        let token = format!("wst_{}", uuid_like(tile_id));
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, caller| !matches!(caller, Caller::Agent { tile_id: existing, .. } if existing == tile_id));
        tokens.insert(
            token.clone(),
            Caller::Agent {
                tile_id: tile_id.to_string(),
                workstream_id: workstream_id.to_string(),
            },
        );
        token
    }

    /// Resolves a presented token, or explains that it is not usable.
    pub fn resolve(&self, token: Option<&str>) -> Result<Caller, AgentError> {
        let Some(token) = token.filter(|value| !value.trim().is_empty()) else {
            return Err(AgentError::new(
                "NO_IDENTITY",
                format!("{TOKEN_ENV_VAR} is not set"),
                "Run this from a Copilot session tile inside Workstreams; the app sets this itself.",
            ));
        };
        self.tokens
            .lock()
            .unwrap()
            .get(token)
            .cloned()
            .ok_or_else(|| {
                AgentError::new(
                    "STALE_IDENTITY",
                    "That token was not issued by this app instance",
                    "The app restarted, or the session was respawned. Open a fresh session tile.",
                )
            })
    }

    pub fn forget_tile(&self, tile_id: &str) {
        self.tokens.lock().unwrap().retain(
            |_, caller| !matches!(caller, Caller::Agent { tile_id: existing, .. } if existing == tile_id),
        );
    }
}

/// Builds a token that is unguessable in practice without pulling in a crate.
///
/// Combines the tile, the clock and the address of a fresh allocation, so two
/// tokens issued in the same millisecond for the same tile still differ.
fn uuid_like(tile_id: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    tile_id.hash(&mut hasher);
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default()
        .hash(&mut hasher);
    let scratch = Box::new(0u8);
    (Box::into_raw(scratch) as usize).hash(&mut hasher);
    let high = hasher.finish();
    // Hash again so the two halves do not share an obvious relationship.
    high.hash(&mut hasher);
    format!("{high:016x}{:016x}", hasher.finish())
}

/// Everything a command handler is allowed to touch.
pub struct CommandContext<'a> {
    pub db: &'a Connection,
    /// `None` only for commands that declared they do not need one.
    pub caller: Option<&'a Caller>,
}

impl CommandContext<'_> {
    /// The identity behind this request.
    ///
    /// Infallible for any command with `requires_identity`, which the dispatcher
    /// checks before the handler runs.
    pub fn caller(&self) -> Result<&Caller, AgentError> {
        self.caller.ok_or_else(|| {
            AgentError::new(
                "NO_IDENTITY",
                "This command needs to know which session is asking",
                "Run it from a Copilot session tile inside Workstreams.",
            )
        })
    }
}

type Handler = fn(&CommandContext, &serde_json::Value) -> Result<serde_json::Value, AgentError>;

/// One named thing an agent can ask the app to do.
pub struct Command {
    pub id: &'static str,
    /// One line, shown when a command is not found and in the CLI help.
    pub summary: &'static str,
    /// Whether this command needs to know which session is asking.
    ///
    /// A connectivity check must not, or an agent whose token is stale cannot
    /// tell "the app is unreachable" from "my identity expired" — two problems
    /// with different fixes.
    pub requires_identity: bool,
    /// Whether this needs the human's agreement first.
    ///
    /// Nothing enforces it — by decision there is no confirmation UI — so this
    /// flag exists to be surfaced in the help and the skill. It is a label on a
    /// social rule, not a lock.
    pub destructive: bool,
    pub handler: Handler,
}

/// The command surface.
///
/// Curated rather than a mirror of the app's ~120 Tauri commands: an agent that
/// can see `resize_pty` and `save_scrollback` has a harder job, and exposing
/// them would make them public API by accident.
pub const COMMANDS: &[Command] = &[
    Command {
        id: "agent.ping",
        summary: "Check that the app is reachable",
        requires_identity: false,
        destructive: false,
        handler: ping,
    },
    Command {
        id: "agent.whoami",
        summary: "Report the workstream and tile this session is acting as",
        requires_identity: true,
        destructive: false,
        handler: whoami,
    },
];

fn ping(
    _context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<serde_json::Value, AgentError> {
    Ok(serde_json::json!({ "pong": true, "pid": std::process::id() }))
}

fn whoami(
    context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<serde_json::Value, AgentError> {
    let caller = context.caller()?;
    Ok(serde_json::json!({
        "actor": caller.actor(),
        "workstreamId": caller.workstream_id(),
    }))
}

pub fn find(id: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|command| command.id == id)
}

/// Routes a request to its handler.
pub fn dispatch(
    request: &AgentRequest,
    context: &CommandContext,
) -> Result<serde_json::Value, AgentError> {
    let Some(command) = find(&request.cmd) else {
        return Err(unknown_command(&request.cmd));
    };
    if command.requires_identity && context.caller.is_none() {
        return Err(AgentError::new(
            "NO_IDENTITY",
            format!("{} needs to know which session is asking", command.id),
            "Run it from a Copilot session tile inside Workstreams; the app sets the identity itself.",
        ));
    }
    (command.handler)(context, &request.params)
}

/// The error an agent sees when it names a command that does not exist.
///
/// Lists what *is* available, because an agent given only "unknown command"
/// guesses, and guessing is how a session burns its turns.
pub fn unknown_command(attempted: &str) -> AgentError {
    let available = COMMANDS
        .iter()
        .map(|command| command.id)
        .collect::<Vec<_>>()
        .join(", ");
    AgentError::new(
        "UNKNOWN_COMMAND",
        format!("No such command: {attempted}"),
        format!("Available commands: {available}"),
    )
}

/// Turns a handler result into a response.
pub fn respond(result: Result<serde_json::Value, AgentError>) -> AgentResponse {
    match result {
        Ok(data) => AgentResponse::ok(data),
        Err(error) => AgentResponse::failed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        Connection::open_in_memory().expect("open in-memory db")
    }

    fn agent(tile: &str, workstream: &str) -> Caller {
        Caller::Agent {
            tile_id: tile.to_string(),
            workstream_id: workstream.to_string(),
        }
    }

    #[test]
    fn a_token_resolves_to_the_identity_the_app_issued_it_for() {
        let registry = IdentityRegistry::new();
        let token = registry.issue("tile-1", "ws-abc");
        assert_eq!(
            registry.resolve(Some(&token)).expect("resolve"),
            agent("tile-1", "ws-abc")
        );
    }

    /// The property the whole scheme exists for: an agent cannot name an
    /// identity, only present one the app handed it.
    #[test]
    fn an_invented_token_is_refused() {
        let registry = IdentityRegistry::new();
        registry.issue("tile-1", "ws-abc");
        let error = registry
            .resolve(Some("wst_deadbeefdeadbeefdeadbeefdeadbeef"))
            .expect_err("a forged token must not resolve");
        assert_eq!(error.code, "STALE_IDENTITY");
        assert!(!error.hint.is_empty());
    }

    #[test]
    fn a_missing_token_is_a_different_failure_from_a_wrong_one() {
        let registry = IdentityRegistry::new();
        assert_eq!(registry.resolve(None).unwrap_err().code, "NO_IDENTITY");
        assert_eq!(
            registry.resolve(Some("  ")).unwrap_err().code,
            "NO_IDENTITY"
        );
    }

    /// A respawned tile must invalidate its old token, or a process left over
    /// from the previous spawn keeps acting on the workstream.
    #[test]
    fn respawning_a_tile_retires_its_previous_token() {
        let registry = IdentityRegistry::new();
        let first = registry.issue("tile-1", "ws-abc");
        let second = registry.issue("tile-1", "ws-abc");
        assert_ne!(first, second, "each spawn gets its own token");
        assert!(registry.resolve(Some(&first)).is_err());
        assert!(registry.resolve(Some(&second)).is_ok());
    }

    #[test]
    fn closing_a_tile_revokes_its_token() {
        let registry = IdentityRegistry::new();
        let token = registry.issue("tile-1", "ws-abc");
        registry.forget_tile("tile-1");
        assert!(registry.resolve(Some(&token)).is_err());
    }

    #[test]
    fn tokens_are_distinct_across_tiles() {
        let registry = IdentityRegistry::new();
        let first = registry.issue("tile-1", "ws-abc");
        let second = registry.issue("tile-2", "ws-xyz");
        assert_ne!(first, second);
        assert_eq!(
            registry.resolve(Some(&second)).expect("resolve"),
            agent("tile-2", "ws-xyz")
        );
    }

    #[test]
    fn the_actor_label_names_the_session_rather_than_the_person() {
        assert_eq!(agent("tile-1", "ws-abc").actor(), "agent:tile-1");
        assert_eq!(Caller::Human.actor(), "human");
    }

    #[test]
    fn dispatch_routes_to_the_named_handler() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-abc");
        let data = dispatch(
            &AgentRequest {
                cmd: "agent.whoami".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            &CommandContext {
                db: &db,
                caller: Some(&caller),
            },
        )
        .expect("dispatch");
        assert_eq!(data["actor"], "agent:tile-1");
        assert_eq!(data["workstreamId"], "ws-abc");
    }

    /// A connectivity check must survive a missing identity: an agent whose
    /// token went stale needs to separate "cannot reach the app" from "the app
    /// no longer knows me", because only one of them is fixed by restarting.
    #[test]
    fn ping_answers_without_an_identity_but_whoami_does_not() {
        let db = memory_db();
        let anonymous = CommandContext {
            db: &db,
            caller: None,
        };

        assert_eq!(
            dispatch(
                &AgentRequest {
                    cmd: "agent.ping".to_string(),
                    params: serde_json::Value::Null,
                    token: None,
                },
                &anonymous,
            )
            .expect("ping needs no identity")["pong"],
            true
        );

        let error = dispatch(
            &AgentRequest {
                cmd: "agent.whoami".to_string(),
                params: serde_json::Value::Null,
                token: None,
            },
            &anonymous,
        )
        .expect_err("whoami must refuse");
        assert_eq!(error.code, "NO_IDENTITY");
    }

    #[test]
    fn an_unknown_command_lists_the_real_ones() {
        let error = unknown_command("ws.summon");
        assert_eq!(error.code, "UNKNOWN_COMMAND");
        for command in COMMANDS {
            assert!(
                error.hint.contains(command.id),
                "{} missing from the hint",
                command.id
            );
        }
    }

    /// Guards the contract every error is supposed to keep, across the whole
    /// table rather than for the one command that happened to be tested.
    #[test]
    fn every_command_is_documented_and_uniquely_named() {
        let mut seen = std::collections::HashSet::new();
        for command in COMMANDS {
            assert!(
                seen.insert(command.id),
                "duplicate command id: {}",
                command.id
            );
            assert!(
                command.id.contains('.'),
                "{} should be namespaced, e.g. ws.create",
                command.id
            );
            assert!(
                !command.summary.trim().is_empty(),
                "{} needs a summary: it is what an agent reads when lost",
                command.id
            );
        }
    }
}

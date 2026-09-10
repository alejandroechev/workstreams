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

// From the protocol module, not the transport: the registry is
// platform-independent and must keep compiling where the socket does not exist.
use crate::agent_protocol::{AgentError, AgentRequest, AgentResponse};
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

/// Whether this caller may act on `workstream_id`.
///
/// An agent owns the workstream it runs in, plus any it created. The second
/// clause is what makes handoff and parallel runs possible: an agent has to be
/// able to follow up on the workstream it just provisioned.
///
/// Checked here, against `created_by_session` in the database, rather than
/// against anything the request said — the caller was resolved from a token the
/// app issued, so this is the app checking its own records.
pub fn may_act_on(db: &Connection, caller: &Caller, workstream_id: &str) -> Result<(), AgentError> {
    let Caller::Agent {
        tile_id,
        workstream_id: own,
    } = caller
    else {
        return Ok(()); // The UI is not fenced.
    };
    if own == workstream_id {
        return Ok(());
    }
    let created_by: Option<String> = db
        .query_row(
            "SELECT created_by_session FROM workstreams WHERE id = ?1",
            [workstream_id],
            |row| row.get(0),
        )
        .map_err(|_| {
            AgentError::new(
                "NO_SUCH_WORKSTREAM",
                format!("No workstream with id {workstream_id}"),
                "Use ws.list to see the workstreams you can act on.",
            )
        })?;
    if created_by.as_deref() == Some(tile_id.as_str()) {
        return Ok(());
    }
    Err(AgentError::new(
        "OUT_OF_SCOPE",
        format!("This session may not act on workstream {workstream_id}"),
        "You can act on your own workstream and ones you created. Ask the human to do this one.",
    ))
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
        let token = mint_token();
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

/// Builds a token.
///
/// Two v4 UUIDs rather than a hash of the clock and an allocation address: the
/// earlier version derived entropy from things an attacker can observe or
/// influence, and leaked the allocation it used as a source.
fn mint_token() -> String {
    format!(
        "wst_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
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

type Handler = fn(&CommandContext, &serde_json::Value) -> Result<CommandOutcome, AgentError>;

/// What changed, so the UI can refresh without polling.
///
/// The app does not watch its own database — it listens for one event and polls
/// loop summaries — so a write from outside the UI is invisible until the user
/// happens to click something. Handlers return this and the caller turns it into
/// a Tauri event.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StateChange {
    pub entity: String,
    pub id: String,
    pub action: String,
}

impl StateChange {
    pub fn new(entity: &str, id: impl Into<String>, action: &str) -> Self {
        Self {
            entity: entity.to_string(),
            id: id.into(),
            action: action.to_string(),
        }
    }
}

/// What a handler produces: a payload, and optionally news of a change.
#[derive(Debug)]
pub struct CommandOutcome {
    pub data: serde_json::Value,
    pub change: Option<StateChange>,
}

impl CommandOutcome {
    /// A read: nothing changed, so nothing to announce.
    pub fn read(data: serde_json::Value) -> Self {
        Self { data, change: None }
    }

    pub fn changed(data: serde_json::Value, change: StateChange) -> Self {
        Self {
            data,
            change: Some(change),
        }
    }
}

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
    Command {
        id: "ws.list",
        summary: "List workstreams this session may act on",
        requires_identity: true,
        destructive: false,
        handler: ws_list,
    },
    Command {
        id: "ws.create",
        summary: "Create a workstream (params: name, description, directory, projectId)",
        requires_identity: true,
        destructive: false,
        handler: ws_create,
    },
    Command {
        id: "ws.update",
        summary: "Rename or re-describe a workstream (params: id, name, description)",
        requires_identity: true,
        destructive: false,
        handler: ws_update,
    },
];

/// Reads a required string parameter, explaining the shape when it is absent.
fn required_str(params: &serde_json::Value, key: &str) -> Result<String, AgentError> {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AgentError::new(
                "MISSING_PARAM",
                format!("Missing required parameter: {key}"),
                format!("Add {key}=<value> to the command."),
            )
        })
}

fn optional_str(params: &serde_json::Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn ws_list(
    context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let Caller::Agent {
        tile_id,
        workstream_id,
    } = caller
    else {
        return Ok(CommandOutcome::read(
            serde_json::json!({ "workstreams": [] }),
        ));
    };
    // Only what this session may act on. Listing everything would tell an agent
    // about work it cannot touch and invite it to try.
    let mut statement = context
        .db
        .prepare(
            "SELECT id, name, status, created_by_session FROM workstreams
             WHERE id = ?1 OR created_by_session = ?2 ORDER BY created_at DESC",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([workstream_id, tile_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "status": row.get::<_, String>(2)?,
                "createdBySession": row.get::<_, Option<String>>(3)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(CommandOutcome::read(
        serde_json::json!({ "workstreams": rows }),
    ))
}

fn ws_create(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let name = required_str(params, "name")?;
    let created_by_session = match caller {
        Caller::Agent { tile_id, .. } => Some(tile_id.clone()),
        Caller::Human => None,
    };
    let workstream = crate::insert_workstream(
        context.db,
        crate::NewWorkstream {
            name,
            directory: optional_str(params, "directory"),
            description: optional_str(params, "description"),
            project_id: optional_str(params, "projectId"),
            workstream_type: optional_str(params, "type"),
            worktree_branch: optional_str(params, "branch"),
            // Recorded here rather than taken from the request: provenance is
            // what scope checks rely on, so it must come from the resolved
            // identity and never from a parameter.
            created_by_session,
        },
    )
    .map_err(|error| {
        AgentError::new(
            "CREATE_FAILED",
            error,
            "Check the name and project id, then retry.",
        )
    })?;
    let change = StateChange::new("workstream", &workstream.id, "created");
    Ok(CommandOutcome::changed(
        serde_json::json!({
            "id": workstream.id,
            "name": workstream.name,
            "status": workstream.status,
        }),
        change,
    ))
}

fn ws_update(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let id = required_str(params, "id")?;
    may_act_on(context.db, caller, &id)?;

    let name = optional_str(params, "name");
    let description = optional_str(params, "description");
    if name.is_none() && description.is_none() {
        return Err(AgentError::new(
            "NOTHING_TO_UPDATE",
            "No updatable field was given",
            "Pass name=<value> or description=<value>.",
        ));
    }
    context
        .db
        .execute(
            "UPDATE workstreams
             SET name = COALESCE(?2, name),
                 description = COALESCE(?3, description),
                 updated_at = ?4
             WHERE id = ?1",
            rusqlite::params![id, name, description, crate::now()],
        )
        .map_err(db_error)?;
    let change = StateChange::new("workstream", &id, "updated");
    Ok(CommandOutcome::changed(
        serde_json::json!({ "id": id, "updated": true }),
        change,
    ))
}

fn db_error(error: rusqlite::Error) -> AgentError {
    AgentError::new(
        "DB_ERROR",
        format!("Database error: {error}"),
        "This is likely a bug; report it with the command you ran.",
    )
}

fn ping(
    _context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    Ok(CommandOutcome::read(
        serde_json::json!({ "pong": true, "pid": std::process::id() }),
    ))
}

fn whoami(
    context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    Ok(CommandOutcome::read(serde_json::json!({
        "actor": caller.actor(),
        "workstreamId": caller.workstream_id(),
    })))
}

pub fn find(id: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|command| command.id == id)
}

/// Routes a request to its handler.
pub fn dispatch(
    request: &AgentRequest,
    context: &CommandContext,
) -> Result<CommandOutcome, AgentError> {
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

/// Records a command in the audit log.
///
/// Best-effort: a logging failure must not turn a command that worked into one
/// that reports failure. The log is evidence, not a participant.
pub fn log_command(
    db: &Connection,
    command: &str,
    caller: Option<&Caller>,
    params: &serde_json::Value,
    result: &Result<CommandOutcome, AgentError>,
    duration_ms: u128,
) {
    let (outcome, error_code) = match result {
        Ok(_) => ("ok", None),
        Err(error) => ("error", Some(error.code.clone())),
    };
    let _ = db.execute(
        "INSERT INTO command_log
            (id, command, actor, workstream_id, params_json, outcome, error_code, duration_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            command,
            caller.map(Caller::actor).unwrap_or_else(|| "anonymous".to_string()),
            caller.and_then(|caller| caller.workstream_id().map(str::to_string)),
            redact(params),
            outcome,
            error_code,
            duration_ms as i64,
            crate::now(),
        ],
    );
}

/// Keys whose values are free text and must never reach the log.
///
/// The rule is "command ids and structured parameters only". A handoff brief or
/// a description is prose written by a person or an agent, and logging it would
/// quietly turn an audit trail into a transcript.
const REDACTED_KEYS: &[&str] = &[
    "description",
    "prompt",
    "body",
    "content",
    "context",
    "notes",
];

/// How deep a nested parameter may go before the subtree is summarised.
///
/// Bounds the walk so a pathological payload cannot make logging expensive.
const MAX_REDACT_DEPTH: usize = 6;

/// Longest string kept verbatim under a key that is not known free text.
///
/// Identifiers, names and branches are short; anything longer is prose by
/// another name, whatever key it arrived under.
const MAX_LOGGED_STRING: usize = 120;

/// Replaces free-text values with their length, keeping the shape of the call
/// visible without storing what was said.
///
/// Walks the whole structure. A top-level-only pass leaves prose one level down
/// -- `{"metadata": {"description": "..."}}` -- in the log verbatim, which is
/// exactly what the rule exists to prevent. Long strings are summarised wherever
/// they appear, because a caller can put prose under a key this code has never
/// heard of.
/// `sensitive` marks a subtree that arrived under a known free-text key.
///
/// It has to be carried down rather than re-derived per level: replacing the
/// inherited key with each child's name meant `{"prompt": {"text": "..."}}`
/// evaluated the string under `text`, which is not a free-text key, and logged
/// the prose in full. The whole subtree under a sensitive key is sensitive,
/// whatever its children are called.
fn redact_value(value: &serde_json::Value, sensitive: bool, depth: usize) -> serde_json::Value {
    if depth >= MAX_REDACT_DEPTH {
        return serde_json::json!("<redacted:deep>");
    }
    match value {
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .iter()
                .map(|(name, nested)| {
                    let nested_sensitive = sensitive || REDACTED_KEYS.contains(&name.as_str());
                    (
                        name.clone(),
                        redact_value(nested, nested_sensitive, depth + 1),
                    )
                })
                .collect(),
        ),
        serde_json::Value::Array(items) => serde_json::Value::Array(
            items
                .iter()
                .map(|item| redact_value(item, sensitive, depth + 1))
                .collect(),
        ),
        serde_json::Value::String(text) => {
            if sensitive || text.len() > MAX_LOGGED_STRING {
                serde_json::json!(format!("<redacted:{}>", text.len()))
            } else {
                value.clone()
            }
        }
        // A number or boolean under a sensitive key carries little, but keeping
        // it would still leak a choice the caller made in prose-adjacent input.
        other if sensitive => serde_json::json!(format!("<redacted:{}>", other.to_string().len())),
        other => other.clone(),
    }
}

fn redact(params: &serde_json::Value) -> String {
    if !params.is_object() {
        return "{}".to_string();
    }
    serde_json::to_string(&redact_value(params, false, 0)).unwrap_or_else(|_| "{}".to_string())
}

/// Turns a handler result into a response.
pub fn respond(result: Result<CommandOutcome, AgentError>) -> AgentResponse {
    match result {
        Ok(outcome) => AgentResponse::ok(outcome.data),
        Err(error) => AgentResponse::failed(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::init_db(&conn).expect("schema");
        conn
    }

    fn call(
        db: &Connection,
        caller: &Caller,
        cmd: &str,
        params: serde_json::Value,
    ) -> Result<CommandOutcome, AgentError> {
        dispatch(
            &AgentRequest {
                cmd: cmd.to_string(),
                params,
                token: None,
            },
            &CommandContext {
                db,
                caller: Some(caller),
            },
        )
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
        .expect("dispatch")
        .data;
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
            .expect("ping needs no identity")
            .data["pong"],
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

    // ── Scope ──────────────────────────────────────────────────────────────

    /// The fence in one test: own workstream yes, one it created yes, a
    /// stranger's no.
    #[test]
    fn an_agent_reaches_its_own_and_its_offspring_but_not_a_strangers() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        for (id, creator) in [
            ("ws-own", None),
            ("ws-made-by-me", Some("tile-1")),
            ("ws-someone-else", Some("tile-9")),
            ("ws-made-in-ui", None),
        ] {
            db.execute(
                "INSERT INTO workstreams (id, name, status, created_by_session, created_at, updated_at)
                 VALUES (?1, ?1, 'active', ?2, '2026-01-01', '2026-01-01')",
                rusqlite::params![id, creator],
            )
            .unwrap();
        }

        assert!(may_act_on(&db, &caller, "ws-own").is_ok());
        assert!(
            may_act_on(&db, &caller, "ws-made-by-me").is_ok(),
            "handoff depends on this"
        );

        for forbidden in ["ws-someone-else", "ws-made-in-ui"] {
            let error = may_act_on(&db, &caller, forbidden)
                .expect_err("a workstream this session did not create is out of scope");
            assert_eq!(error.code, "OUT_OF_SCOPE", "{forbidden}");
            assert!(error.hint.contains("Ask the human"));
        }

        let missing = may_act_on(&db, &caller, "ws-nope").expect_err("unknown id");
        assert_eq!(missing.code, "NO_SUCH_WORKSTREAM");
    }

    /// The UI is not fenced: a person acting through the app is the authority
    /// the fence exists to protect.
    #[test]
    fn the_human_is_not_fenced() {
        let db = memory_db();
        assert!(may_act_on(&db, &Caller::Human, "anything-at-all").is_ok());
    }

    // ── Entity commands ────────────────────────────────────────────────────

    /// Provenance must come from the resolved identity, never from the request,
    /// or an agent could grant itself scope over what it creates for others.
    #[test]
    fn creating_a_workstream_records_the_session_that_asked() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let created = call(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({ "name": "Alpha", "createdBySession": "tile-impostor" }),
        )
        .expect("create")
        .data;

        let id = created["id"].as_str().expect("id").to_string();
        let recorded: Option<String> = db
            .query_row(
                "SELECT created_by_session FROM workstreams WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            recorded.as_deref(),
            Some("tile-1"),
            "a parameter must not be able to forge provenance"
        );

        // The shared core ran, so the workstream is complete rather than a bare
        // row: the layout the UI relies on exists too.
        let layouts: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM workstream_layouts WHERE workstream_id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            layouts, 1,
            "an agent-made workstream must not be half-built"
        );

        // And it is immediately actionable by its creator.
        assert!(may_act_on(&db, &caller, &id).is_ok());
    }

    #[test]
    fn creating_without_a_name_says_which_parameter_is_missing() {
        let db = memory_db();
        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.create",
            serde_json::json!({}),
        )
        .expect_err("name is required");
        assert_eq!(error.code, "MISSING_PARAM");
        assert!(error.hint.contains("name="), "{}", error.hint);
    }

    #[test]
    fn listing_shows_only_what_this_session_may_touch() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        db.execute(
            "INSERT INTO workstreams (id, name, status, created_at, updated_at)
             VALUES ('ws-own', 'Mine', 'active', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO workstreams (id, name, status, created_by_session, created_at, updated_at)
             VALUES ('ws-other', 'Theirs', 'active', 'tile-9', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        call(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({ "name": "Made by me" }),
        )
        .expect("create");

        let listed = call(&db, &caller, "ws.list", serde_json::Value::Null)
            .expect("list")
            .data;
        let names: Vec<&str> = listed["workstreams"]
            .as_array()
            .expect("array")
            .iter()
            .map(|entry| entry["name"].as_str().unwrap_or_default())
            .collect();
        assert!(names.contains(&"Mine"));
        assert!(names.contains(&"Made by me"));
        assert!(
            !names.contains(&"Theirs"),
            "listing work an agent cannot touch only invites it to try: {names:?}"
        );
    }

    #[test]
    fn updating_a_workstream_out_of_scope_is_refused() {
        let db = memory_db();
        db.execute(
            "INSERT INTO workstreams (id, name, status, created_by_session, created_at, updated_at)
             VALUES ('ws-other', 'Theirs', 'active', 'tile-9', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.update",
            serde_json::json!({ "id": "ws-other", "name": "Hijacked" }),
        )
        .expect_err("out of scope");
        assert_eq!(error.code, "OUT_OF_SCOPE");

        let name: String = db
            .query_row(
                "SELECT name FROM workstreams WHERE id = 'ws-other'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            name, "Theirs",
            "the refusal must actually prevent the write"
        );
    }

    #[test]
    fn updating_with_nothing_to_change_says_so() {
        let db = memory_db();
        db.execute(
            "INSERT INTO workstreams (id, name, status, created_at, updated_at)
             VALUES ('ws-own', 'Mine', 'active', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.update",
            serde_json::json!({ "id": "ws-own" }),
        )
        .expect_err("nothing to update");
        assert_eq!(error.code, "NOTHING_TO_UPDATE");
    }

    // ── State change + log ─────────────────────────────────────────────────

    /// Writes must announce themselves; the UI has no other way to notice.
    #[test]
    fn writes_report_a_change_and_reads_do_not() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");

        let created = call(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({ "name": "Alpha" }),
        )
        .expect("create");
        let change = created.change.expect("a create must announce itself");
        assert_eq!(change.entity, "workstream");
        assert_eq!(change.action, "created");
        assert_eq!(change.id, created.data["id"].as_str().unwrap());

        let listed = call(&db, &caller, "ws.list", serde_json::Value::Null).expect("list");
        assert!(
            listed.change.is_none(),
            "a read that announced a change would refresh the UI for nothing"
        );
    }

    #[test]
    fn the_log_records_the_actor_the_app_resolved() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let params = serde_json::json!({ "name": "Alpha" });
        let result = call(&db, &caller, "ws.create", params.clone());
        log_command(&db, "ws.create", Some(&caller), &params, &result, 12);

        let (command, actor, workstream, outcome): (String, String, Option<String>, String) = db
            .query_row(
                "SELECT command, actor, workstream_id, outcome FROM command_log",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(command, "ws.create");
        assert_eq!(actor, "agent:tile-1");
        assert_eq!(workstream.as_deref(), Some("ws-own"));
        assert_eq!(outcome, "ok");
    }

    #[test]
    fn a_failure_is_logged_with_its_code_rather_than_dropped() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let params = serde_json::json!({});
        let result = call(&db, &caller, "ws.create", params.clone());
        log_command(&db, "ws.create", Some(&caller), &params, &result, 3);

        let (outcome, code): (String, Option<String>) = db
            .query_row("SELECT outcome, error_code FROM command_log", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!(outcome, "error");
        assert_eq!(code.as_deref(), Some("MISSING_PARAM"));
    }

    /// The log is an audit trail, not a transcript. Prose must not land in it,
    /// but the shape of the call should still be readable.
    #[test]
    fn free_text_parameters_are_redacted_but_structure_survives() {
        let redacted = redact(&serde_json::json!({
            "name": "Alpha",
            "description": "a long private explanation of the work",
            "count": 3,
        }));
        assert!(!redacted.contains("private explanation"), "{redacted}");
        assert!(redacted.contains("\"name\":\"Alpha\""), "{redacted}");
        assert!(redacted.contains("\"count\":3"), "{redacted}");
        assert!(
            !redacted.contains("private explanation"),
            "prose leaked into the log: {redacted}"
        );
        assert!(redacted.contains("<redacted:"), "{redacted}");
    }

    /// A top-level-only pass would leave all of this in the log verbatim.
    /// Commands accept unknown parameters, so prose can arrive anywhere.
    #[test]
    fn prose_is_redacted_however_deeply_it_is_nested() {
        let redacted = redact(&serde_json::json!({
            "metadata": { "description": "private text in a nested object" },
            "items": [{ "prompt": "private prompt inside an array" }],
            "unnamed": "x".repeat(400),
            "name": "Alpha",
        }));
        for leaked in ["private text", "private prompt", &"x".repeat(400)] {
            assert!(!redacted.contains(leaked), "leaked {leaked:?}: {redacted}");
        }
        // Shape survives, so the log still shows what kind of call was made.
        assert!(redacted.contains("metadata"), "{redacted}");
        assert!(redacted.contains("\"name\":\"Alpha\""), "{redacted}");
    }

    /// A sensitive key whose value is an object or array must stay sensitive
    /// all the way down. Re-deriving sensitivity from each child's own name let
    /// `{"prompt": {"text": "..."}}` through in full.
    #[test]
    fn a_sensitive_key_protects_everything_beneath_it() {
        let redacted = redact(&serde_json::json!({
            "prompt": { "text": "private short message" },
            "notes": [{ "text": "private array message" }],
            "deep": { "context": { "inner": { "text": "private nested message" } } },
        }));
        for leaked in ["private short", "private array", "private nested"] {
            assert!(!redacted.contains(leaked), "leaked {leaked:?}: {redacted}");
        }
    }

    #[test]
    fn a_pathological_nesting_depth_does_not_run_away() {
        let mut value = serde_json::json!("leaf");
        for _ in 0..50 {
            value = serde_json::json!({ "next": value });
        }
        let redacted = redact(&value);
        assert!(redacted.contains("<redacted:deep>"), "{redacted}");
    }

    #[test]
    fn tokens_do_not_repeat_across_many_issuances() {
        let registry = IdentityRegistry::new();
        let tokens: std::collections::HashSet<String> = (0..500)
            .map(|i| registry.issue(&format!("tile-{i}"), "ws"))
            .collect();
        assert_eq!(tokens.len(), 500, "token collision");
    }

    /// Logging is evidence, not a participant: if it fails, the command that
    /// already succeeded must still be reported as succeeding.
    #[test]
    fn a_broken_log_does_not_fail_the_command() {
        let db = Connection::open_in_memory().expect("db"); // no schema at all
        let caller = agent("tile-1", "ws-own");
        let result: Result<CommandOutcome, AgentError> =
            Ok(CommandOutcome::read(serde_json::json!({})));
        log_command(
            &db,
            "ws.create",
            Some(&caller),
            &serde_json::json!({}),
            &result,
            1,
        );
        assert!(result.is_ok());
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

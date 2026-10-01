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
use rusqlite::{Connection, OptionalExtension};
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

/// Side effects that live outside the database.
///
/// A seam rather than a direct call into the app: creating a worktree is git
/// work, and the registry has to stay testable without a Tauri handle or a real
/// repository. The app supplies the real implementation; tests supply a fake.
pub trait Provisioner: Send + Sync {
    /// Where a worktree for `branch` off `project_directory` would live.
    fn derive_worktree_path(
        &self,
        project_directory: &str,
        branch: &str,
    ) -> Result<DerivedWorktree, String>;

    /// Creates the worktree and returns its path.
    fn create_worktree(
        &self,
        project_directory: &str,
        branch: &str,
        base_branch: Option<&str>,
    ) -> Result<String, String>;
}

/// Where a worktree would go, and whether something is already there.
pub struct DerivedWorktree {
    pub path: String,
    pub exists: bool,
}

/// Everything a command handler is allowed to touch.
pub struct CommandContext<'a> {
    pub db: &'a Connection,
    /// `None` only for commands that declared they do not need one.
    pub caller: Option<&'a Caller>,
    /// `None` in tests that exercise no provisioning command.
    pub provisioner: Option<&'a dyn Provisioner>,
}

impl CommandContext<'_> {
    /// The identity behind this request.
    ///
    /// Infallible for any command with `requires_identity`, which the dispatcher
    /// checks before the handler runs.
    fn provisioner(&self) -> Result<&dyn Provisioner, AgentError> {
        self.provisioner.ok_or_else(|| {
            AgentError::new(
                "NO_PROVISIONER",
                "This build cannot create worktrees",
                "Report this as a bug.",
            )
        })
    }

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
    /// Parameter names safe to record verbatim in the audit log.
    ///
    /// An allowlist, not a blocklist. Length was tried as a proxy for prose and
    /// failed: "Patient has HIV" is 15 bytes. Anything not named here is counted
    /// rather than recorded, so an undeclared parameter cannot smuggle content
    /// into the log under a key nobody anticipated.
    ///
    /// Only structured, non-prose names belong here -- ids, flags, branches.
    pub log_params: &'static [&'static str],
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
        id: "inbox.list",
        log_params: &[],
        summary: "List PR notifications, read state and repo connection status",
        requires_identity: true,
        destructive: false,
        handler: inbox_list,
    },
    Command {
        id: "inbox.configure",
        log_params: &["repo", "enabled"],
        summary: "Enable or disable ADO reviewer notifications (params: repo, enabled=true|false)",
        requires_identity: true,
        destructive: false,
        handler: inbox_configure,
    },
    Command {
        id: "inbox.read",
        log_params: &["id", "read"],
        summary: "Mark a notification read or unread (params: id, read=true|false)",
        requires_identity: true,
        destructive: false,
        handler: inbox_read,
    },
    Command {
        id: "agent.ping",
        log_params: &[],
        summary: "Check that the app is reachable",
        requires_identity: false,
        destructive: false,
        handler: ping,
    },
    Command {
        id: "agent.whoami",
        log_params: &[],
        summary: "Report the workstream and tile this session is acting as",
        requires_identity: true,
        destructive: false,
        handler: whoami,
    },
    Command {
        id: "repo.list",
        log_params: &["filter"],
        summary: "List repositories (params: filter=not_archived|non_dormant|all; default not_archived)",
        requires_identity: true,
        destructive: false,
        handler: repo_list,
    },
    Command {
        id: "repo.archive",
        log_params: &["repo"],
        summary: "Archive a repository without deleting it (params: repo)",
        requires_identity: true,
        destructive: false,
        handler: repo_archive,
    },
    Command {
        id: "repo.unarchive",
        log_params: &["repo"],
        summary: "Restore an archived repository (params: repo)",
        requires_identity: true,
        destructive: false,
        handler: repo_unarchive,
    },
    Command {
        id: "ws.get",
        log_params: &["id"],
        summary: "Show one workstream in full: directory, repo, branch, type, status",
        requires_identity: true,
        destructive: false,
        handler: ws_get,
    },
    Command {
        id: "ws.list",
        log_params: &[],
        summary: "List workstreams this session may act on",
        requires_identity: true,
        destructive: false,
        handler: ws_list,
    },
    Command {
        id: "ws.create",
        log_params: &["projectId", "type", "branch"],
        summary: "Create a workstream. type=worktree needs repo+branch; type=base_repo needs repo; type=standalone needs directory",
        requires_identity: true,
        destructive: false,
        handler: ws_create,
    },
    Command {
        id: "ws.lanes",
        log_params: &[],
        summary: "List the work lanes that exist",
        requires_identity: true,
        destructive: false,
        handler: ws_lanes,
    },
    Command {
        id: "ws.lane",
        log_params: &["ws"],
        summary: "Put a workstream in a work lane (params: lane, ws; lane=none to clear)",
        requires_identity: true,
        destructive: false,
        handler: ws_lane,
    },
    Command {
        id: "pr.link",
        log_params: &["ws"],
        summary: "Link a pull request to a workstream (params: url, note, ws)",
        requires_identity: true,
        destructive: false,
        handler: pr_link,
    },
    Command {
        id: "pr.unlink",
        log_params: &["ws"],
        summary: "Remove a pull request link (params: url or id, ws)",
        requires_identity: true,
        // Removes a link, not the pull request. Reversible with pr.link, so it
        // does not need the human's agreement first.
        destructive: false,
        handler: pr_unlink,
    },
    Command {
        id: "pr.list",
        log_params: &["ws"],
        summary: "List pull requests linked to a workstream (params: ws)",
        requires_identity: true,
        destructive: false,
        handler: pr_list,
    },
    Command {
        id: "diff.order.set",
        log_params: &["mode", "target"],
        summary: "Save a recommended reading order for this workstream's diff (params: mode, target, paths=a,b,c)",
        requires_identity: true,
        // Replaces only the previous order for the same diff, which the agent
        // can regenerate at any time.
        destructive: false,
        handler: diff_order_set,
    },
    Command {
        id: "diff.order.get",
        log_params: &["mode", "target"],
        summary: "Read this workstream's saved reading order and whether it still matches (params: mode, target)",
        requires_identity: true,
        destructive: false,
        handler: diff_order_get,
    },
    Command {
        id: "ws.update",
        log_params: &["id"],
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

fn inbox_error(error: String) -> AgentError {
    AgentError::new("INBOX_ERROR", error, "Use inbox.list to inspect connection status. Configure an ADO repo and run az login if authentication fails.")
}

fn inbox_bool(params: &serde_json::Value, key: &str) -> Result<bool, AgentError> {
    match params.get(key) {
        Some(serde_json::Value::Bool(value)) => Ok(*value),
        Some(serde_json::Value::String(value)) if value == "true" => Ok(true),
        Some(serde_json::Value::String(value)) if value == "false" => Ok(false),
        _ => Err(AgentError::new(
            "INVALID_PARAM",
            format!("{key} must be true or false"),
            format!("Pass {key}=true or {key}=false."),
        )),
    }
}

fn inbox_list(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let snapshot = crate::pr_inbox::snapshot(context.db).map_err(inbox_error)?;
    Ok(CommandOutcome::read(serde_json::json!(snapshot)))
}

fn inbox_configure(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let repo = required_str(params, "repo")?;
    let id: String = context
        .db
        .query_row(
            "SELECT id FROM projects WHERE id=?1 OR name=?1 ORDER BY id=?1 DESC LIMIT 1",
            [&repo],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    let mode = crate::pr_inbox::WatchMode::parse(&required_str(params, "mode")?).map_err(|e| {
        AgentError::new(
            "INVALID_PARAM",
            e,
            "Pass mode=off, mode=reviewer, mode=author or mode=both.",
        )
    })?;
    crate::pr_inbox::configure(context.db, &id, mode).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"project_id":id,"mode":mode}),
        StateChange::new("pr_inbox", id, "configured"),
    ))
}

fn inbox_read(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "id")?;
    let read = inbox_bool(params, "read")?;
    crate::pr_inbox::set_read(context.db, &id, read).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"id":id,"is_read":read}),
        StateChange::new("pr_inbox", id, "read"),
    ))
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

/// Workstream kinds an agent may create.
const WORKSTREAM_TYPES: &[&str] = &["worktree", "base_repo", "standalone"];

fn ws_create(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let name = required_str(params, "name")?;

    // Explicit rather than inferred. The first version defaulted to
    // "standalone" and passed `branch` straight through to a column, so a
    // request that asked for a worktree got a workstream that merely *recorded*
    // a branch name: no worktree, no directory, nothing to open.
    let kind = optional_str(params, "type").unwrap_or_else(|| "worktree".to_string());
    if !WORKSTREAM_TYPES.contains(&kind.as_str()) {
        return Err(AgentError::new(
            "BAD_TYPE",
            format!("Unknown workstream type: {kind}"),
            format!("Use one of: {}.", WORKSTREAM_TYPES.join(", ")),
        ));
    }

    let branch = optional_str(params, "branch");
    if branch.is_some() && kind != "worktree" {
        return Err(AgentError::new(
            "BRANCH_NEEDS_WORKTREE",
            format!("branch was given but type is {kind}"),
            "Pass type=worktree to get a worktree on that branch, or drop branch=.",
        ));
    }

    let created_by_session = match caller {
        Caller::Agent { tile_id, .. } => Some(tile_id.clone()),
        Caller::Human => None,
    };

    let (directory, project_id, worktree_branch) = match kind.as_str() {
        "worktree" => {
            let repo = required_str(params, "repo").map_err(|_| {
                AgentError::new(
                    "MISSING_PARAM",
                    "A worktree workstream needs a repository",
                    "Run repo.list, then pass repo=<id>.",
                )
            })?;
            let branch = branch.clone().ok_or_else(|| {
                AgentError::new(
                    "MISSING_PARAM",
                    "A worktree workstream needs a branch",
                    "Pass branch=<name>. An existing branch is checked out; a new one is created.",
                )
            })?;
            let project = load_project(context.db, &repo)?;
            let provisioner = context.provisioner()?;

            let derived = provisioner
                .derive_worktree_path(&project.directory, &branch)
                .map_err(|error| {
                    AgentError::new("WORKTREE_PATH_FAILED", error, "Check the repository path.")
                })?;
            if derived.exists {
                return Err(AgentError::new(
                    "WORKTREE_EXISTS",
                    format!("There is already a directory at {}", derived.path),
                    "Use a different branch, or ask the human whether to reuse that worktree.",
                ));
            }

            // Provision before recording. The failure this replaces left a
            // workstream row pointing at a worktree that was never created, so
            // it opened empty; if git fails now, nothing is written at all.
            let path = provisioner
                .create_worktree(
                    &project.directory,
                    &branch,
                    optional_str(params, "base").as_deref(),
                )
                .map_err(|error| {
                    AgentError::new(
                        "WORKTREE_FAILED",
                        error,
                        "Check the branch name and that the repository is clean.",
                    )
                })?;
            (Some(path), Some(project.id), Some(branch))
        }
        "base_repo" => {
            let repo = required_str(params, "repo").map_err(|_| {
                AgentError::new(
                    "MISSING_PARAM",
                    "A base_repo workstream needs a repository",
                    "Run repo.list, then pass repo=<id>.",
                )
            })?;
            let project = load_project(context.db, &repo)?;
            (Some(project.directory), Some(project.id), None)
        }
        _ => {
            let directory = required_str(params, "directory").map_err(|_| {
                AgentError::new(
                    "MISSING_PARAM",
                    "A standalone workstream needs a directory",
                    "Pass directory=<absolute path>, or use type=worktree with repo= and branch=.",
                )
            })?;
            (Some(directory), optional_str(params, "repo"), None)
        }
    };

    let workstream = crate::insert_workstream(
        context.db,
        crate::NewWorkstream {
            name: name.clone(),
            directory: directory.clone(),
            description: optional_str(params, "description"),
            project_id: project_id.clone(),
            workstream_type: Some(kind.clone()),
            worktree_branch: worktree_branch.clone(),
            // From the resolved identity, never a parameter: provenance is what
            // scope checks read.
            created_by_session,
        },
    )
    .map_err(|error| {
        AgentError::new(
            "CREATE_FAILED",
            error,
            "Check the name and repository, then retry.",
        )
    })?;

    // A workstream with no tile opens blank. The UI always creates a pinned
    // session tile here, so an agent-made one gets the same.
    let tile_config = serde_json::json!({
        "session_name": name,
        "cwd": directory,
        "is_resumed": false,
        "pinned": true,
        "created_at": crate::now(),
    })
    .to_string();
    let tile = crate::insert_tile(
        context.db,
        &workstream.id,
        "copilot_session",
        Some(name.clone()),
        Some(tile_config),
    )
    .map_err(|error| {
        AgentError::new(
            "TILE_FAILED",
            error,
            "The workstream exists but has no session tile; open it in the app.",
        )
    })?;

    let change = StateChange::new("workstream", &workstream.id, "created");
    Ok(CommandOutcome::changed(
        serde_json::json!({
            "id": workstream.id,
            "name": workstream.name,
            "type": kind,
            "status": workstream.status,
            "directory": directory,
            "repoId": project_id,
            "branch": worktree_branch,
            "tileId": tile.id,
        }),
        change,
    ))
}

/// A repository the app knows about.
struct ProjectRow {
    id: String,
    directory: String,
}

fn load_project(db: &Connection, repo: &str) -> Result<ProjectRow, AgentError> {
    // Accept an id or a name, because an agent reading repo.list output has
    // both in front of it and either is a reasonable thing to type.
    db.query_row(
        "SELECT id, directory FROM projects
         WHERE (id = ?1 OR name = ?1) AND archived = 0",
        [repo],
        |row| {
            Ok(ProjectRow {
                id: row.get(0)?,
                directory: row.get(1)?,
            })
        },
    )
    .map_err(|_| {
        AgentError::new(
            "NO_SUCH_REPO",
            format!("No repository matches {repo}"),
            "Run repo.list to see the available repositories and their ids.",
        )
    })
}

fn repo_list(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    context.caller()?;
    let filter = optional_str(params, "filter").unwrap_or_else(|| "not_archived".to_string());
    let where_clause = match filter.as_str() {
        "not_archived" => "WHERE p.archived = 0",
        "non_dormant" => {
            "WHERE p.archived = 0
             AND EXISTS (
                 SELECT 1 FROM workstreams w
                 WHERE w.project_id = p.id
                   AND w.status NOT IN ('archived', 'archiving')
             )"
        }
        "all" => "",
        _ => {
            return Err(AgentError::new(
                "INVALID_FILTER",
                format!("Unknown repository filter: {filter}"),
                "Use filter=not_archived, filter=non_dormant, or filter=all.",
            ))
        }
    };
    let query = format!(
        "SELECT p.id, p.name, p.directory, p.archived,
                (
                    SELECT COUNT(*) FROM workstreams w
                    WHERE w.project_id = p.id
                      AND w.status NOT IN ('archived', 'archiving')
                )
         FROM projects p
         {where_clause}
         ORDER BY p.name"
    );
    let mut statement = context.db.prepare(&query).map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "directory": row.get::<_, String>(2)?,
                "archived": row.get::<_, i64>(3)? != 0,
                "activeWorkstreamCount": row.get::<_, i64>(4)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(CommandOutcome::read(serde_json::json!({ "repos": rows })))
}

fn set_repo_archived(
    context: &CommandContext,
    params: &serde_json::Value,
    archived: bool,
) -> Result<CommandOutcome, AgentError> {
    context.caller()?;
    let repo = required_str(params, "repo")?;
    let id = context
        .db
        .query_row(
            "SELECT id FROM projects WHERE id = ?1 OR name = ?1",
            [&repo],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| {
            AgentError::new(
                "NO_SUCH_REPO",
                format!("No repository matches {repo}"),
                "Run repo.list to see non-archived repositories, or open Repos in the app to inspect archived ones.",
            )
        })?;
    context
        .db
        .execute(
            "UPDATE projects SET archived = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![archived, crate::now(), id],
        )
        .map_err(db_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({
            "id": id,
            "archived": archived,
        }),
        StateChange::new(
            "project",
            &id,
            if archived { "archived" } else { "unarchived" },
        ),
    ))
}

fn repo_archive(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    set_repo_archived(context, params, true)
}

fn repo_unarchive(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    set_repo_archived(context, params, false)
}

fn ws_get(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let id = required_str(params, "id")?;
    may_act_on(context.db, caller, &id)?;
    // Enough to verify the result of a create without opening the app, which
    // the previous id/name/status listing could not do.
    let detail = context
        .db
        .query_row(
            "SELECT w.id, w.name, w.status, w.directory, w.workstream_type,
                    w.worktree_branch, w.project_id, p.name,
                    (SELECT COUNT(*) FROM tiles t WHERE t.workstream_id = w.id)
             FROM workstreams w LEFT JOIN projects p ON p.id = w.project_id
             WHERE w.id = ?1",
            [&id],
            |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "status": row.get::<_, String>(2)?,
                    "directory": row.get::<_, Option<String>>(3)?,
                    "type": row.get::<_, Option<String>>(4)?,
                    "branch": row.get::<_, Option<String>>(5)?,
                    "repoId": row.get::<_, Option<String>>(6)?,
                    "repoName": row.get::<_, Option<String>>(7)?,
                    "tileCount": row.get::<_, i64>(8)?,
                }))
            },
        )
        .map_err(|_| {
            AgentError::new(
                "NO_SUCH_WORKSTREAM",
                format!("No workstream with id {id}"),
                "Run ws.list to see the workstreams you can act on.",
            )
        })?;
    Ok(CommandOutcome::read(detail))
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

/// Resolves which workstream a `pr.*` command acts on.
///
/// Defaults to the caller's own, because "link this PR" almost always means the
/// workstream the agent is sitting in, and making it type an id it already
/// implicitly knows is friction that invites mistakes. An explicit `ws=` is
/// still scope-checked.
fn target_workstream(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<String, AgentError> {
    let caller = context.caller()?;
    let id = match optional_str(params, "ws") {
        Some(explicit) => explicit,
        None => caller
            .workstream_id()
            .ok_or_else(|| {
                AgentError::new(
                    "NO_WORKSTREAM",
                    "This session is not attached to a workstream",
                    "Pass ws=<id> to say which workstream you mean.",
                )
            })?
            .to_string(),
    };
    may_act_on(context.db, caller, &id)?;
    Ok(id)
}

fn parse_pr(
    params: &serde_json::Value,
) -> Result<crate::pull_requests::PullRequestRef, AgentError> {
    let url = required_str(params, "url")?;
    crate::pull_requests::parse_pull_request_url(&url).map_err(|error| {
        AgentError::new(
            "BAD_PR_URL",
            error,
            "Paste the pull request URL from the browser, e.g. https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>",
        )
    })
}

fn pr_link(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let workstream_id = target_workstream(context, params)?;
    let pr = parse_pr(params)?;
    let note = optional_str(params, "note");
    let now = crate::now();

    // Ask first purely so the answer can say whether this was new. The insert
    // below is still ON CONFLICT rather than conditional, so two agents racing
    // cannot both insert; this read only affects the wording of the reply.
    let already_linked: bool = context
        .db
        .query_row(
            "SELECT 1 FROM workstream_pull_requests WHERE workstream_id = ?1 AND identity = ?2",
            rusqlite::params![workstream_id, pr.identity()],
            |_| Ok(true),
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or(false);

    // Idempotent: an agent that retries, or links a PR someone already linked,
    // should get the existing link rather than an error it has to interpret.
    context
        .db
        .execute(
            "INSERT INTO workstream_pull_requests
                (id, workstream_id, url, organization, project, repository, number,
                 identity, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(workstream_id, identity) DO UPDATE SET
                url = excluded.url,
                note = COALESCE(excluded.note, workstream_pull_requests.note),
                updated_at = excluded.updated_at",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                workstream_id,
                pr.url,
                pr.organization,
                pr.project,
                pr.repository,
                pr.number,
                pr.identity(),
                note,
                now,
            ],
        )
        .map_err(db_error)?;

    let id: String = context
        .db
        .query_row(
            "SELECT id FROM workstream_pull_requests WHERE workstream_id = ?1 AND identity = ?2",
            rusqlite::params![workstream_id, pr.identity()],
            |row| row.get(0),
        )
        .map_err(db_error)?;

    Ok(CommandOutcome::changed(
        serde_json::json!({
            "id": id,
            "workstreamId": workstream_id,
            "label": pr.label(),
            "url": pr.url,
            "number": pr.number,
            "repository": pr.repository,
            "alreadyLinked": already_linked,
        }),
        StateChange::new("workstream", &workstream_id, "pr_linked"),
    ))
}

fn pr_unlink(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let workstream_id = target_workstream(context, params)?;
    // By URL or by the link id from pr.list -- an agent has whichever is to
    // hand, and requiring the other is needless friction.
    let identity = match optional_str(params, "url") {
        Some(_) => Some(parse_pr(params)?.identity()),
        None => None,
    };
    let link_id = optional_str(params, "id");
    if identity.is_none() && link_id.is_none() {
        return Err(AgentError::new(
            "MISSING_PARAM",
            "Say which link to remove",
            "Pass url=<pull request url>, or id=<link id from pr.list>.",
        ));
    }

    let removed = context
        .db
        .execute(
            "DELETE FROM workstream_pull_requests
             WHERE workstream_id = ?1 AND (identity = ?2 OR id = ?3)",
            rusqlite::params![workstream_id, identity, link_id],
        )
        .map_err(db_error)?;
    if removed == 0 {
        return Err(AgentError::new(
            "NO_SUCH_LINK",
            "That pull request is not linked to this workstream",
            "Run pr.list to see what is linked.",
        ));
    }

    Ok(CommandOutcome::changed(
        serde_json::json!({ "workstreamId": workstream_id, "removed": removed }),
        StateChange::new("workstream", &workstream_id, "pr_unlinked"),
    ))
}

fn pr_list(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let workstream_id = target_workstream(context, params)?;
    let mut statement = context
        .db
        .prepare(
            "SELECT id, url, repository, number, note, created_at
             FROM workstream_pull_requests
             WHERE workstream_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([&workstream_id], |row| {
            let repository: String = row.get(2)?;
            let number: i64 = row.get(3)?;
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "url": row.get::<_, String>(1)?,
                // Precomputed so a listing is readable without the caller
                // having to reassemble it from parts.
                "label": format!("{repository}#{number}"),
                "repository": repository,
                "number": number,
                "note": row.get::<_, Option<String>>(4)?,
                "linkedAt": row.get::<_, String>(5)?,
            }))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    Ok(CommandOutcome::read(serde_json::json!({
        "workstreamId": workstream_id,
        "pullRequests": rows,
    })))
}

/// Sentinel for "take this workstream out of its lane".
///
/// Reserved as a lane name so the two can never mean different things: the app
/// refuses to create a lane called this.
pub const CLEAR_LANE: &str = "none";

fn ws_lane(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let workstream_id = target_workstream(context, params)?;
    let lane = required_str(params, "lane")?;

    // "none" clears rather than naming a lane, because an agent that can file a
    // workstream should be able to unfile it without a second command. Trimmed
    // first so " none " means the same thing as "none".
    let (lane_id, lane_name) = if lane.trim().eq_ignore_ascii_case(CLEAR_LANE) {
        (None, None)
    } else {
        // Look up, never create. An agent may file a workstream into a lane;
        // deciding what the lanes *are* is the operator's call, and a create-on
        // -assign would let a single typo add a permanent folder nobody chose.
        let existing = crate::find_lane_by_name(context.db, &lane)
            .map_err(|error| AgentError::new("LANE_LOOKUP_FAILED", error, "Retry once."))?;
        let found = existing.ok_or_else(|| {
            AgentError::new(
                "NO_SUCH_LANE",
                format!("There is no lane named {lane}"),
                "Run ws.lanes to see the lanes that exist. Ask the human to create one if you need a new lane.",
            )
        })?;
        (Some(found.id), Some(found.name))
    };

    crate::set_workstream_lane(context.db, &workstream_id, lane_id.as_deref()).map_err(
        |error| {
            AgentError::new(
                "LANE_ASSIGN_FAILED",
                error,
                "Run ws.list to see the workstreams you can act on.",
            )
        },
    )?;

    Ok(CommandOutcome::changed(
        serde_json::json!({
            "workstreamId": workstream_id,
            "lane": lane_name,
        }),
        StateChange::new("workstream", &workstream_id, "lane_changed"),
    ))
}

fn ws_lanes(
    context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    context.caller()?;
    let mut statement = context
        .db
        .prepare("SELECT name FROM work_lanes")
        .map_err(db_error)?;
    let mut names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    names.sort_by_key(|name| name.to_lowercase());
    Ok(CommandOutcome::read(serde_json::json!({ "lanes": names })))
}

/// The diff a `diff.order.*` call is about, and where it lives on disk.
///
/// The workstream always comes from the caller's own identity (A2): there is
/// no `ws=` override, so one session cannot order another's diff.
fn own_diff(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<(crate::diff_order::DiffKey, String), AgentError> {
    let caller = context.caller()?;
    let workstream_id = caller.workstream_id().ok_or_else(|| {
        AgentError::new(
            "NO_WORKSTREAM",
            "Only a session tile of a workstream can order that workstream's diff",
            "Run this from the workstream's Copilot session.",
        )
    })?;
    if let Some(named) = optional_str(params, "ws") {
        if named != workstream_id {
            return Err(AgentError::new(
                "FOREIGN_WORKSTREAM",
                format!("A session can only order its own workstream's diff, not {named}"),
                "Drop ws=, or run this from that workstream's session.",
            ));
        }
    }
    let key = crate::diff_order::DiffKey::new(
        workstream_id,
        &required_str(params, "mode")?,
        optional_str(params, "target").as_deref(),
    )
    .map_err(|e| AgentError::new("BAD_DIFF", e, "Use mode=unstaged|last_commit|branch_vs_master, or mode=custom_branch target=<branch>."))?;
    let directory: Option<String> = context
        .db
        .query_row(
            "SELECT directory FROM workstreams WHERE id = ?1",
            [workstream_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .flatten();
    let directory = directory.filter(|d| !d.trim().is_empty()).ok_or_else(|| {
        AgentError::new(
            "NO_DIRECTORY",
            "This workstream has no directory, so it has no diff",
            "Attach the workstream to a repo first.",
        )
    })?;
    Ok((key, directory))
}

fn diff_error(error: String) -> AgentError {
    AgentError::new(
        "DIFF_ERROR",
        error,
        "Check that the workstream directory is a git repo and the mode/target exist.",
    )
}

/// Accepts `paths=a.ts,b.ts` from the CLI and a JSON array on the wire.
fn order_paths(params: &serde_json::Value) -> Result<Vec<String>, AgentError> {
    let paths: Vec<String> = match params.get("paths") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str())
            .map(|path| path.trim().to_string())
            .collect(),
        Some(serde_json::Value::String(list)) => list
            .split(',')
            .map(|path| path.trim().to_string())
            .collect(),
        _ => Vec::new(),
    };
    let paths: Vec<String> = paths.into_iter().filter(|path| !path.is_empty()).collect();
    if paths.is_empty() {
        return Err(AgentError::new(
            "MISSING_PARAM",
            "Missing required parameter: paths",
            "Add paths=<file1>,<file2>,... listing every changed file in reading order.",
        ));
    }
    Ok(paths)
}

fn diff_order_set(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let (key, directory) = own_diff(context, params)?;
    let paths = order_paths(params)?;
    // The fingerprint is always the app's own (C3); anything the caller sent
    // under that name is ignored.
    let snapshot = crate::diff_order::snapshot(&directory, &key).map_err(diff_error)?;
    if let Err(mismatch) = crate::diff_order::check_paths(&snapshot, &paths) {
        let mut parts = Vec::new();
        for (label, list) in [
            ("unknown", &mismatch.unknown),
            ("missing", &mismatch.missing),
            ("duplicated", &mismatch.duplicates),
        ] {
            if !list.is_empty() {
                parts.push(format!("{label}: {}", list.join(", ")));
            }
        }
        return Err(AgentError::new(
            "ORDER_MISMATCH",
            format!(
                "The order must list every changed file exactly once ({})",
                parts.join("; ")
            ),
            format!(
                "Run diff.order.get mode={} for the exact changed_files, then list each once.",
                key.mode
            ),
        ));
    }
    crate::diff_order::save(context.db, &key, &paths, &snapshot).map_err(diff_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({
            "mode": key.mode,
            "target": key.target,
            "count": paths.len(),
        }),
        StateChange::new("diff_order", key.workstream_id.clone(), "saved"),
    ))
}

fn diff_order_get(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let (key, directory) = own_diff(context, params)?;
    let current = crate::diff_order::snapshot(&directory, &key).map_err(diff_error)?;
    // The changed files are always returned: they are exactly the set
    // diff.order.set will validate against, which the agent needs before it
    // has ever saved an order.
    let order = crate::diff_order::load(context.db, &key)
        .map_err(diff_error)?
        .map(|stored| {
            serde_json::json!({
                "paths": stored.paths,
                "saved_at": stored.saved_at,
                "file_set_fingerprint": stored.file_set_fingerprint,
                "content_fingerprint": stored.content_fingerprint,
                "freshness": crate::diff_order::freshness(&stored, &current),
            })
        });
    Ok(CommandOutcome::read(serde_json::json!({
        "mode": key.mode,
        "target": key.target,
        "changed_files": current
            .files
            .iter()
            .map(|(path, status)| serde_json::json!({"path": path, "status": status}))
            .collect::<Vec<_>>(),
        "order": order,
    })))
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
            summarise_params(find(command), params),
            outcome,
            error_code,
            duration_ms as i64,
            crate::now(),
        ],
    );
}

/// Summarises a call's parameters without recording any caller-supplied bytes.
///
/// Six rounds of review converged on this. Every earlier attempt tried to decide
/// which caller data was safe, and each one was wrong in a new way:
///
/// | Attempt | What it trusted | How it leaked |
/// | --- | --- | --- |
/// | Top-level keys | nested values | `{"a":{"description":…}}` |
/// | Per-level sensitivity | each child's own key | `{"prompt":{"text":…}}` |
/// | Sensitive-value flag | keys around values | `{"notes":{"<diagnosis>":true}}` |
/// | Length limits | short input | `"Patient has HIV"` is 15 bytes |
/// | Name allowlist | values under allowed names | `branch` is user-authored |
///
/// The last one is the instructive failure: allowlisting a *name* says nothing
/// about its *value*. A branch name is written by a person, and a rejected
/// `projectId` is simply whatever was typed.
///
/// So no caller bytes are recorded at all. What remains is which parameters were
/// present — a fact about the shape of the call rather than its content — and
/// how many were not recognised. Everything else in the row (command, actor,
/// workstream, outcome, duration) is derived by the app.
fn summarise_params(command: Option<&Command>, params: &serde_json::Value) -> String {
    let Some(object) = params.as_object() else {
        return "{}".to_string();
    };
    let allowed = command.map(|command| command.log_params).unwrap_or(&[]);

    // Sorted for stable rows, and drawn from the static allowlist rather than
    // from the request, so not one byte of caller input is echoed back.
    let mut present: Vec<&str> = allowed
        .iter()
        .copied()
        .filter(|name| object.contains_key(*name))
        .collect();
    present.sort_unstable();
    let withheld = object.len() - present.len();

    let mut summary = serde_json::Map::new();
    summary.insert("params".to_string(), serde_json::json!(present));
    if withheld > 0 {
        summary.insert("_withheld".to_string(), serde_json::json!(withheld));
    }
    serde_json::to_string(&summary).unwrap_or_else(|_| "{}".to_string())
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

    /// Records what it was asked to provision, so a test can assert the git
    /// work actually happened rather than trusting the response.
    #[derive(Default)]
    struct FakeProvisioner {
        created: Mutex<Vec<(String, String, Option<String>)>>,
        path_exists: bool,
        fail_with: Option<String>,
    }

    impl Provisioner for FakeProvisioner {
        fn derive_worktree_path(
            &self,
            project_directory: &str,
            branch: &str,
        ) -> Result<DerivedWorktree, String> {
            Ok(DerivedWorktree {
                path: format!("{project_directory}-{}", branch.replace('/', "-")),
                exists: self.path_exists,
            })
        }

        fn create_worktree(
            &self,
            project_directory: &str,
            branch: &str,
            base_branch: Option<&str>,
        ) -> Result<String, String> {
            if let Some(error) = &self.fail_with {
                return Err(error.clone());
            }
            self.created.lock().unwrap().push((
                project_directory.to_string(),
                branch.to_string(),
                base_branch.map(str::to_string),
            ));
            Ok(format!("{project_directory}-{}", branch.replace('/', "-")))
        }
    }

    fn call(
        db: &Connection,
        caller: &Caller,
        cmd: &str,
        params: serde_json::Value,
    ) -> Result<CommandOutcome, AgentError> {
        call_with(db, caller, cmd, params, &FakeProvisioner::default())
    }

    fn call_with(
        db: &Connection,
        caller: &Caller,
        cmd: &str,
        params: serde_json::Value,
        provisioner: &dyn Provisioner,
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
                provisioner: Some(provisioner),
            },
        )
    }

    fn seed_repo(db: &Connection, id: &str, directory: &str) {
        db.execute(
            "INSERT INTO projects (id, name, directory, color, created_at, updated_at)
             VALUES (?1, ?1, ?2, '#fff', '2026-01-01', '2026-01-01')",
            rusqlite::params![id, directory],
        )
        .unwrap();
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
                provisioner: None,
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
            provisioner: None,
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
            serde_json::json!({
                "name": "Alpha",
                "type": "standalone",
                "directory": "/tmp/alpha",
                "createdBySession": "tile-impostor",
            }),
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

    /// The reported failure, end to end: a worktree request produced a
    /// workstream with no directory, no repo and no tile -- so it had no colour
    /// and opened empty -- while recording a branch whose worktree was never
    /// created.
    #[test]
    fn a_worktree_workstream_is_fully_provisioned() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let caller = agent("tile-1", "ws-own");
        let provisioner = FakeProvisioner::default();

        let created = call_with(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({
                "name": "MediaStore Read Chunks",
                "type": "worktree",
                "repo": "repo-1",
                "branch": "eralvare/add-read-chunks",
            }),
            &provisioner,
        )
        .expect("create")
        .data;

        // The worktree was actually created, not merely named.
        assert_eq!(
            provisioner.created.lock().unwrap().as_slice(),
            &[(
                "/code/waimea".to_string(),
                "eralvare/add-read-chunks".to_string(),
                None
            )]
        );

        let id = created["id"].as_str().expect("id");
        let (directory, project, kind, branch): (
            Option<String>,
            Option<String>,
            String,
            Option<String>,
        ) = db
            .query_row(
                "SELECT directory, project_id, workstream_type, worktree_branch
                 FROM workstreams WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        // A directory, so the workstream opens on something.
        assert_eq!(
            directory.as_deref(),
            Some("/code/waimea-eralvare-add-read-chunks")
        );
        // A repository, which is where the sidebar colour comes from.
        assert_eq!(project.as_deref(), Some("repo-1"));
        assert_eq!(kind, "worktree");
        assert_eq!(branch.as_deref(), Some("eralvare/add-read-chunks"));

        // And a pinned session tile, or it opens blank.
        let tiles: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM tiles WHERE workstream_id = ?1 AND tile_type = 'copilot_session'",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tiles, 1);
    }

    /// If git fails, nothing is recorded. The earlier version wrote the row
    /// first, so a failed provision left a workstream pointing nowhere.
    #[test]
    fn a_failed_worktree_leaves_no_workstream_behind() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let provisioner = FakeProvisioner {
            fail_with: Some("git worktree add failed: branch is checked out".to_string()),
            ..Default::default()
        };

        let error = call_with(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.create",
            serde_json::json!({
                "name": "Doomed", "type": "worktree", "repo": "repo-1", "branch": "x",
            }),
            &provisioner,
        )
        .expect_err("git failed");
        assert_eq!(error.code, "WORKTREE_FAILED");

        let rows: i64 = db
            .query_row("SELECT COUNT(*) FROM workstreams", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            rows, 0,
            "a failed provision must not leave a half-built workstream"
        );
    }

    #[test]
    fn an_occupied_worktree_path_is_refused_before_anything_is_written() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let provisioner = FakeProvisioner {
            path_exists: true,
            ..Default::default()
        };
        let error = call_with(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.create",
            serde_json::json!({
                "name": "Clash", "type": "worktree", "repo": "repo-1", "branch": "x",
            }),
            &provisioner,
        )
        .expect_err("path taken");
        assert_eq!(error.code, "WORKTREE_EXISTS");
        assert!(provisioner.created.lock().unwrap().is_empty());
    }

    /// A base-repo workstream points at the repository itself and still carries
    /// the project, so it is coloured and opens on the code.
    #[test]
    fn a_base_repo_workstream_points_at_the_repository() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let created = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.create",
            serde_json::json!({ "name": "Waimea", "type": "base_repo", "repo": "repo-1" }),
        )
        .expect("create")
        .data;
        assert_eq!(created["directory"], "/code/waimea");
        assert_eq!(created["repoId"], "repo-1");
        assert_eq!(created["branch"], serde_json::Value::Null);
    }

    /// The silent failure that started this: `branch` was accepted by a create
    /// that could not act on it, and recorded as if it had.
    #[test]
    fn a_branch_without_a_worktree_type_is_refused_rather_than_recorded() {
        let db = memory_db();
        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.create",
            serde_json::json!({
                "name": "Alpha", "type": "standalone", "directory": "/tmp/a", "branch": "feature",
            }),
        )
        .expect_err("branch is meaningless here");
        assert_eq!(error.code, "BRANCH_NEEDS_WORKTREE");
        assert!(error.hint.contains("type=worktree"), "{}", error.hint);
    }

    #[test]
    fn a_worktree_without_a_repo_or_branch_says_which_is_missing() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let caller = agent("tile-1", "ws-own");

        let error = call(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({ "name": "A" }),
        )
        .expect_err("no repo");
        assert_eq!(error.code, "MISSING_PARAM");
        assert!(error.hint.contains("repo.list"), "{}", error.hint);

        let error = call(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({ "name": "A", "repo": "repo-1" }),
        )
        .expect_err("no branch");
        assert!(error.message.contains("branch"), "{}", error.message);

        let error = call(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({ "name": "A", "repo": "nope", "branch": "b" }),
        )
        .expect_err("unknown repo");
        assert_eq!(error.code, "NO_SUCH_REPO");
    }

    #[test]
    fn repos_are_listable_so_an_agent_can_find_one() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let listed = call(
            &db,
            &agent("tile-1", "ws-own"),
            "repo.list",
            serde_json::Value::Null,
        )
        .expect("list")
        .data;
        assert_eq!(listed["repos"][0]["id"], "repo-1");
        assert_eq!(listed["repos"][0]["directory"], "/code/waimea");
    }

    #[test]
    fn inbox_commands_configure_list_and_validate_read_updates() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/repo");
        db.execute(
            "UPDATE projects SET git_remote='https://dev.azure.com/org/project/_git/repo'",
            [],
        )
        .unwrap();
        let caller = agent("tile-1", "ws-own");
        call(
            &db,
            &caller,
            "inbox.configure",
            serde_json::json!({"repo":"repo-1","mode":"both"}),
        )
        .unwrap();
        let listed = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(listed.data["repos"][0]["enabled"], true);
        assert_eq!(listed.data["repos"][0]["mode"], "both");
        assert!(call(
            &db,
            &caller,
            "inbox.read",
            serde_json::json!({"id":"missing","read":true})
        )
        .is_err());
        assert!(call(
            &db,
            &caller,
            "inbox.configure",
            serde_json::json!({"repo":"repo-1","mode":"sometimes"})
        )
        .is_err());
        call(
            &db,
            &caller,
            "inbox.configure",
            serde_json::json!({"repo":"repo-1","mode":"off"}),
        )
        .unwrap();
        assert!(crate::pr_inbox::targets(&db).unwrap().is_empty());
    }

    #[test]
    fn archived_repos_are_hidden_from_the_default_agent_list() {
        let db = memory_db();
        seed_repo(&db, "active", "/code/active");
        seed_repo(&db, "archived", "/code/archived");
        db.execute("UPDATE projects SET archived = 1 WHERE id = 'archived'", [])
            .unwrap();

        let listed = call(
            &db,
            &agent("tile-1", "ws-own"),
            "repo.list",
            serde_json::Value::Null,
        )
        .expect("list")
        .data;

        assert_eq!(listed["repos"].as_array().unwrap().len(), 1);
        assert_eq!(listed["repos"][0]["id"], "active");
    }

    #[test]
    fn repo_list_supports_all_and_non_dormant_filters() {
        let db = memory_db();
        seed_repo(&db, "active", "/code/active");
        seed_repo(&db, "dormant", "/code/dormant");
        seed_repo(&db, "archived", "/code/archived");
        db.execute("UPDATE projects SET archived = 1 WHERE id = 'archived'", [])
            .unwrap();
        db.execute(
            "INSERT INTO workstreams
             (id, name, status, project_id, created_at, updated_at)
             VALUES ('ws-1', 'One', 'active', 'active', 't', 't')",
            [],
        )
        .unwrap();
        let caller = agent("tile-1", "ws-own");

        let non_dormant = call(
            &db,
            &caller,
            "repo.list",
            serde_json::json!({ "filter": "non_dormant" }),
        )
        .expect("non-dormant")
        .data;
        assert_eq!(
            non_dormant["repos"],
            serde_json::json!([{
                "id": "active",
                "name": "active",
                "directory": "/code/active",
                "archived": false,
                "activeWorkstreamCount": 1,
            }])
        );

        let all = call(
            &db,
            &caller,
            "repo.list",
            serde_json::json!({ "filter": "all" }),
        )
        .expect("all")
        .data;
        assert_eq!(all["repos"].as_array().unwrap().len(), 3);
        assert!(all["repos"]
            .as_array()
            .unwrap()
            .iter()
            .any(|repo| repo["id"] == "archived" && repo["archived"] == true));
    }

    #[test]
    fn repo_archive_and_restore_preserve_the_repo() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let caller = agent("tile-1", "ws-own");

        call(
            &db,
            &caller,
            "repo.archive",
            serde_json::json!({ "repo": "repo-1" }),
        )
        .expect("archive");
        let archived: i64 = db
            .query_row(
                "SELECT archived FROM projects WHERE id = 'repo-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived, 1);

        call(
            &db,
            &caller,
            "repo.unarchive",
            serde_json::json!({ "repo": "repo-1" }),
        )
        .expect("restore");
        let archived: i64 = db
            .query_row(
                "SELECT archived FROM projects WHERE id = 'repo-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived, 0);
    }

    /// ws.list returns only id/name/status, which is why the agent that hit this
    /// bug could not tell whether its request had worked.
    #[test]
    fn ws_get_reports_enough_to_verify_a_create() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/code/waimea");
        let caller = agent("tile-1", "ws-own");
        let created = call_with(
            &db,
            &caller,
            "ws.create",
            serde_json::json!({
                "name": "Alpha", "type": "worktree", "repo": "repo-1", "branch": "feature/x",
            }),
            &FakeProvisioner::default(),
        )
        .expect("create")
        .data;

        let detail = call(
            &db,
            &caller,
            "ws.get",
            serde_json::json!({ "id": created["id"] }),
        )
        .expect("get")
        .data;
        assert_eq!(detail["directory"], "/code/waimea-feature-x");
        assert_eq!(detail["repoName"], "repo-1");
        assert_eq!(detail["branch"], "feature/x");
        assert_eq!(detail["type"], "worktree");
        assert_eq!(detail["tileCount"], 1);
    }

    // ── Work lanes ─────────────────────────────────────────────────────────

    fn seed_lane(db: &Connection, name: &str) -> String {
        crate::upsert_lane(db, name).expect("lane").id
    }

    #[test]
    fn an_agent_can_file_a_workstream_in_an_existing_lane_and_unfile_it() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let lane_id = seed_lane(&db, "Media Store");
        let caller = agent("tile-1", "ws-own");

        let filed = call(
            &db,
            &caller,
            "ws.lane",
            serde_json::json!({ "lane": "media store" }),
        )
        .expect("file")
        .data;
        assert_eq!(
            filed["lane"], "Media Store",
            "the lane's own casing is kept"
        );
        let placed: Option<String> = db
            .query_row(
                "SELECT lane_id FROM workstreams WHERE id='ws-own'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(placed.as_deref(), Some(lane_id.as_str()));

        // "none" is the inverse, so filing and unfiling are one command.
        for sentinel in ["none", " NONE "] {
            call(
                &db,
                &caller,
                "ws.lane",
                serde_json::json!({ "lane": sentinel }),
            )
            .unwrap_or_else(|error| panic!("{sentinel:?}: {error:?}"));
            let after: Option<String> = db
                .query_row(
                    "SELECT lane_id FROM workstreams WHERE id='ws-own'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(after, None, "{sentinel:?} should clear the lane");
            call(
                &db,
                &caller,
                "ws.lane",
                serde_json::json!({ "lane": "Media Store" }),
            )
            .expect("refile");
        }
    }

    /// Assignment only, by decision: one typo should not add a permanent folder
    /// to someone's sidebar.
    #[test]
    fn filing_into_a_lane_that_does_not_exist_creates_nothing() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        seed_lane(&db, "Media Store");

        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.lane",
            serde_json::json!({ "lane": "Media Stor" }),
        )
        .expect_err("typo");
        assert_eq!(error.code, "NO_SUCH_LANE");
        assert!(error.hint.contains("ws.lanes"), "{}", error.hint);

        let lanes: i64 = db
            .query_row("SELECT COUNT(*) FROM work_lanes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(lanes, 1, "a typo must not create a lane");
    }

    #[test]
    fn an_agent_can_see_which_lanes_exist() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        seed_lane(&db, "Tooling");
        seed_lane(&db, "Media Store");

        let listed = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.lanes",
            serde_json::Value::Null,
        )
        .expect("list")
        .data;
        assert_eq!(
            listed["lanes"],
            serde_json::json!(["Media Store", "Tooling"])
        );
    }

    #[test]
    fn filing_a_workstream_out_of_scope_is_refused() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        seed_workstream(&db, "ws-stranger", Some("tile-9"));

        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.lane",
            serde_json::json!({ "lane": "Mine", "ws": "ws-stranger" }),
        )
        .expect_err("out of scope");
        assert_eq!(error.code, "OUT_OF_SCOPE");

        let moved: Option<String> = db
            .query_row(
                "SELECT lane_id FROM workstreams WHERE id='ws-stranger'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(moved, None, "the refusal must prevent the write");
    }

    #[test]
    fn filing_without_a_lane_name_says_so() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "ws.lane",
            serde_json::json!({}),
        )
        .expect_err("no lane");
        assert_eq!(error.code, "MISSING_PARAM");
    }

    /// The log records which workstream moved, never the lane name -- that is
    /// caller-supplied text like any other.
    #[test]
    fn filing_records_the_workstream_but_not_the_lane_name() {
        let logged = summarise_params(
            find("ws.lane"),
            &serde_json::json!({ "ws": "ws-1", "lane": "A private codename" }),
        );
        assert!(!logged.contains("private codename"), "{logged}");
        assert!(logged.contains("\"ws\""), "{logged}");
    }

    // ── Pull request links ─────────────────────────────────────────────────

    fn seed_workstream(db: &Connection, id: &str, creator: Option<&str>) {
        db.execute(
            "INSERT INTO workstreams (id, name, status, created_by_session, created_at, updated_at)
             VALUES (?1, ?1, 'active', ?2, '2026-01-01', '2026-01-01')",
            rusqlite::params![id, creator],
        )
        .unwrap();
    }

    const PR_ONE: &str = "https://dev.azure.com/org/proj/_git/repo/pullrequest/1";
    const PR_TWO: &str = "https://dev.azure.com/org/proj/_git/repo/pullrequest/2";

    /// The relationship the feature exists for: many PRs per workstream, and the
    /// same PR on more than one workstream.
    #[test]
    fn links_are_many_to_many() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        seed_workstream(&db, "ws-other", Some("tile-1"));
        let caller = agent("tile-1", "ws-own");

        call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_ONE }),
        )
        .expect("link 1");
        call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_TWO }),
        )
        .expect("link 2");
        // Same PR, different workstream.
        call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_ONE, "ws": "ws-other" }),
        )
        .expect("link across workstreams");

        let own = call(&db, &caller, "pr.list", serde_json::Value::Null)
            .expect("list")
            .data;
        let labels: Vec<&str> = own["pullRequests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["label"].as_str().unwrap())
            .collect();
        assert_eq!(labels.len(), 2, "{labels:?}");
        assert!(labels.contains(&"repo#1") && labels.contains(&"repo#2"));

        let other = call(
            &db,
            &caller,
            "pr.list",
            serde_json::json!({ "ws": "ws-other" }),
        )
        .expect("list other")
        .data;
        assert_eq!(other["pullRequests"].as_array().unwrap().len(), 1);
    }

    /// An agent retries. Linking the same PR twice must be a no-op that says so,
    /// not an error it has to interpret.
    #[test]
    fn linking_the_same_pull_request_twice_is_idempotent() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let caller = agent("tile-1", "ws-own");

        let first = call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_ONE }),
        )
        .expect("first")
        .data;
        assert_eq!(first["alreadyLinked"], false);

        // Same PR, pasted in the other host shape and different casing.
        let again = call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": "https://dev.azure.com/Org/Proj/_git/Repo/pullrequest/1?_a=files" }),
        )
        .expect("second")
        .data;
        assert_eq!(again["alreadyLinked"], true);
        assert_eq!(again["id"], first["id"], "must reuse the existing link");

        let listed = call(&db, &caller, "pr.list", serde_json::Value::Null)
            .expect("list")
            .data;
        assert_eq!(
            listed["pullRequests"].as_array().unwrap().len(),
            1,
            "a re-link must not create a second row"
        );
    }

    #[test]
    fn a_note_survives_and_is_not_erased_by_a_relink() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let caller = agent("tile-1", "ws-own");
        call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_ONE, "note": "fixes review round 2" }),
        )
        .expect("link");
        // Re-linking without a note must not silently discard the old one.
        call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_ONE }),
        )
        .expect("relink");

        let listed = call(&db, &caller, "pr.list", serde_json::Value::Null)
            .expect("list")
            .data;
        assert_eq!(listed["pullRequests"][0]["note"], "fixes review round 2");
    }

    #[test]
    fn unlinking_works_by_url_or_by_link_id() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let caller = agent("tile-1", "ws-own");
        let first = call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_ONE }),
        )
        .expect("link")
        .data;
        call(
            &db,
            &caller,
            "pr.link",
            serde_json::json!({ "url": PR_TWO }),
        )
        .expect("link");

        call(
            &db,
            &caller,
            "pr.unlink",
            serde_json::json!({ "id": first["id"] }),
        )
        .expect("unlink by id");
        call(
            &db,
            &caller,
            "pr.unlink",
            serde_json::json!({ "url": PR_TWO }),
        )
        .expect("unlink by url");

        let listed = call(&db, &caller, "pr.list", serde_json::Value::Null)
            .expect("list")
            .data;
        assert!(listed["pullRequests"].as_array().unwrap().is_empty());
    }

    #[test]
    fn unlinking_something_that_is_not_linked_says_so() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let caller = agent("tile-1", "ws-own");

        let error = call(
            &db,
            &caller,
            "pr.unlink",
            serde_json::json!({ "url": PR_ONE }),
        )
        .expect_err("not linked");
        assert_eq!(error.code, "NO_SUCH_LINK");

        let error =
            call(&db, &caller, "pr.unlink", serde_json::Value::Null).expect_err("nothing named");
        assert_eq!(error.code, "MISSING_PARAM");
    }

    /// The same fence as every other command: an agent cannot reach a
    /// workstream it neither owns nor created.
    #[test]
    fn linking_to_a_workstream_out_of_scope_is_refused() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        seed_workstream(&db, "ws-stranger", Some("tile-9"));
        let caller = agent("tile-1", "ws-own");

        for command in ["pr.link", "pr.list", "pr.unlink"] {
            let error = call(
                &db,
                &caller,
                command,
                serde_json::json!({ "url": PR_ONE, "ws": "ws-stranger" }),
            )
            .expect_err("out of scope");
            assert_eq!(error.code, "OUT_OF_SCOPE", "{command}");
        }

        let leaked: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM workstream_pull_requests WHERE workstream_id = 'ws-stranger'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaked, 0, "the refusal must actually prevent the write");
    }

    #[test]
    fn a_malformed_pull_request_url_is_refused_with_an_example() {
        let db = memory_db();
        seed_workstream(&db, "ws-own", None);
        let error = call(
            &db,
            &agent("tile-1", "ws-own"),
            "pr.link",
            serde_json::json!({ "url": "https://github.com/owner/repo/pull/1" }),
        )
        .expect_err("not an ADO url");
        assert_eq!(error.code, "BAD_PR_URL");
        assert!(error.hint.contains("dev.azure.com"), "{}", error.hint);
    }

    /// The log must record which workstream was touched, never the PR URL --
    /// that is caller-supplied content.
    #[test]
    fn linking_records_the_workstream_but_not_the_url() {
        let logged = summarise_params(
            find("pr.link"),
            &serde_json::json!({ "ws": "ws-1", "url": PR_ONE, "note": "private context" }),
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&logged).unwrap()["params"],
            serde_json::json!(["ws"])
        );
        assert!(!logged.contains("pullrequest"), "{logged}");
        assert!(!logged.contains("private context"), "{logged}");
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
            serde_json::json!({ "name": "Made by me", "type": "standalone", "directory": "/tmp/x" }),
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
            serde_json::json!({ "name": "Alpha", "type": "standalone", "directory": "/tmp/a" }),
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
        let params = serde_json::json!({
            "name": "Alpha", "type": "standalone", "directory": "/tmp/alpha",
        });
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

    /// The terminal property: no caller-supplied byte reaches the log, whatever
    /// its name, length, nesting or encoding.
    #[test]
    fn no_caller_supplied_content_reaches_the_log() {
        let prose = "Patient has HIV. Do not disclose.";
        for (command, payload) in [
            // Under an allowlisted name, which is where the previous attempt failed.
            (
                "ws.create",
                serde_json::json!({ "projectId": prose, "branch": prose }),
            ),
            ("ws.update", serde_json::json!({ "id": prose })),
            // As a key.
            ("ws.create", serde_json::json!({ prose: true })),
            // Nested, and in an array.
            ("ws.create", serde_json::json!({ "meta": [{ "x": prose }] })),
            // Unicode.
            (
                "ws.create",
                serde_json::json!({ "branch": "患者はHIV陽性です。" }),
            ),
            // Against a command that declares nothing.
            ("agent.ping", serde_json::json!({ "projectId": prose })),
        ] {
            let logged = summarise_params(find(command), &payload);
            for leaked in [prose, "Patient", "患者"] {
                assert!(
                    !logged.contains(leaked),
                    "{command} leaked {leaked:?} from {payload}: {logged}"
                );
            }
        }
    }

    /// Still useful: the row says which recognised parameters were present and
    /// how many were not, which is what an audit trail needs.
    #[test]
    fn the_shape_of_a_call_is_still_recorded() {
        let logged = summarise_params(
            find("ws.create"),
            &serde_json::json!({
                "projectId": "proj-1",
                "branch": "feature/x",
                "name": "Alpha",
                "description": "prose",
            }),
        );
        let parsed: serde_json::Value = serde_json::from_str(&logged).expect("parse");
        assert_eq!(parsed["params"], serde_json::json!(["branch", "projectId"]));
        assert_eq!(parsed["_withheld"], 2);
    }

    /// The marker is app-generated, so a caller cannot forge or overwrite it.
    #[test]
    fn a_caller_cannot_influence_the_withheld_count() {
        let logged = summarise_params(
            find("ws.update"),
            &serde_json::json!({ "id": "ws-1", "_withheld": 99, "params": ["forged"] }),
        );
        let parsed: serde_json::Value = serde_json::from_str(&logged).expect("parse");
        assert_eq!(parsed["params"], serde_json::json!(["id"]));
        assert_eq!(parsed["_withheld"], 2, "the count is ours, not theirs");
        assert!(!logged.contains("forged"), "{logged}");
    }

    #[test]
    fn an_unknown_command_records_nothing_but_a_count() {
        let logged = summarise_params(None, &serde_json::json!({ "anything": "private" }));
        assert!(!logged.contains("private"), "{logged}");
        assert!(logged.contains("\"_withheld\":1"), "{logged}");
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

    // ── diff.order.* ──────────────────────────────────────────────────────

    /// A workstream whose directory is a real repo with an Unstaged diff of
    /// `a.ts`, `b.ts` and `c.ts`.
    fn diff_order_fixture() -> (Connection, crate::diff_order::test_repo::Repo) {
        let repo = crate::diff_order::test_repo::Repo::new();
        repo.write("a.ts", "a1\n");
        repo.write("b.ts", "b1\n");
        repo.commit_all("init");
        repo.write("a.ts", "a2\n");
        repo.write("b.ts", "b2\n");
        repo.write("c.ts", "c\n");
        let db = memory_db();
        seed_workstream(&db, "w1", None);
        seed_workstream(&db, "w2", None);
        db.execute(
            "UPDATE workstreams SET directory = ?1 WHERE id IN ('w1', 'w2')",
            [repo.dir()],
        )
        .unwrap();
        (db, repo)
    }

    #[test]
    fn diff_order_set_stores_an_exact_order_with_app_computed_fingerprints() {
        let (db, _repo) = diff_order_fixture();
        let me = agent("tile-1", "w1");
        let saved = call(
            &db,
            &me,
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths":"c.ts, a.ts,b.ts","fingerprint":"deadbeef"}),
        )
        .unwrap();
        assert_eq!(saved.data["count"], 3);
        assert!(saved.change.is_some(), "the UI must hear about it");
        let read = call(
            &db,
            &me,
            "diff.order.get",
            serde_json::json!({"mode":"unstaged"}),
        )
        .unwrap();
        assert_eq!(
            read.data["order"]["paths"],
            serde_json::json!(["c.ts", "a.ts", "b.ts"])
        );
        assert_eq!(read.data["order"]["freshness"], "current");
        assert_ne!(read.data["order"]["file_set_fingerprint"], "deadbeef");
        assert_eq!(
            read.data["order"]["file_set_fingerprint"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
    }

    #[test]
    fn diff_order_set_accepts_a_json_array_of_paths_on_the_wire() {
        let (db, _repo) = diff_order_fixture();
        call(
            &db,
            &agent("tile-1", "w1"),
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths":["b.ts","c.ts","a.ts"]}),
        )
        .unwrap();
    }

    /// C4: a partial or padded order must never be stored, and the agent must
    /// be told exactly what to fix.
    #[test]
    fn diff_order_set_rejects_unknown_and_missing_paths_by_name() {
        let (db, _repo) = diff_order_fixture();
        let me = agent("tile-1", "w1");
        let err = call(
            &db,
            &me,
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths":"a.ts,b.ts,z.ts"}),
        )
        .unwrap_err();
        assert_eq!(err.code, "ORDER_MISMATCH");
        assert!(err.message.contains("unknown: z.ts"), "{}", err.message);
        assert!(err.message.contains("missing: c.ts"), "{}", err.message);
        let read = call(
            &db,
            &me,
            "diff.order.get",
            serde_json::json!({"mode":"unstaged"}),
        )
        .unwrap();
        assert_eq!(read.data["order"], serde_json::Value::Null);
        // The exact set to order is always available, before any save.
        assert_eq!(
            read.data["changed_files"],
            serde_json::json!([
                {"path":"a.ts","status":"M"},
                {"path":"b.ts","status":"M"},
                {"path":"c.ts","status":"A"},
            ])
        );
    }

    /// A2: only the workstream's own session. There is no `ws=` override, and
    /// a caller with no workstream (the CLI outside a session) is refused.
    #[test]
    fn diff_order_set_only_acts_on_the_callers_own_workstream() {
        let (db, _repo) = diff_order_fixture();
        let other = agent("tile-2", "w2");
        let err = call(
            &db,
            &other,
            "diff.order.set",
            serde_json::json!({"ws":"w1","mode":"unstaged","paths":"a.ts,b.ts,c.ts"}),
        )
        .unwrap_err();
        assert_eq!(err.code, "FOREIGN_WORKSTREAM");
        let err = call(
            &db,
            &Caller::Human,
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths":"a.ts,b.ts,c.ts"}),
        )
        .unwrap_err();
        assert_eq!(err.code, "NO_WORKSTREAM");
        let read = call(
            &db,
            &agent("tile-1", "w1"),
            "diff.order.get",
            serde_json::json!({"mode":"unstaged"}),
        )
        .unwrap();
        assert_eq!(read.data["order"], serde_json::Value::Null);
    }

    #[test]
    fn diff_order_get_reports_drift_after_the_diff_moves_on() {
        let (db, repo) = diff_order_fixture();
        let me = agent("tile-1", "w1");
        call(
            &db,
            &me,
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths":"a.ts,b.ts,c.ts"}),
        )
        .unwrap();
        repo.write("a.ts", "a3\n");
        let read = call(
            &db,
            &me,
            "diff.order.get",
            serde_json::json!({"mode":"unstaged"}),
        )
        .unwrap();
        assert_eq!(read.data["order"]["freshness"], "content_changed");
        repo.write("d.ts", "d\n");
        let read = call(
            &db,
            &me,
            "diff.order.get",
            serde_json::json!({"mode":"unstaged"}),
        )
        .unwrap();
        assert_eq!(read.data["order"]["freshness"], "files_changed");
    }

    #[test]
    fn diff_order_set_validates_the_mode_and_target() {
        let (db, _repo) = diff_order_fixture();
        let me = agent("tile-1", "w1");
        for params in [
            serde_json::json!({"mode":"staged","paths":"a.ts"}),
            serde_json::json!({"mode":"custom_branch","paths":"a.ts"}),
            serde_json::json!({"mode":"unstaged"}),
        ] {
            let err = call(&db, &me, "diff.order.set", params.clone()).unwrap_err();
            assert!(
                ["BAD_DIFF", "MISSING_PARAM"].contains(&err.code.as_str()),
                "{params}: {}",
                err.code
            );
        }
    }
}

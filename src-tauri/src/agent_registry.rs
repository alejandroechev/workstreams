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
        /// Names the process this token was issued to (a respawn gets a new
        /// one). Re-linking the tile bars its running processes from the phone
        /// in the database (ADR 044), checked under the lock at send time.
        process_key: String,
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
        ..
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
                process_key: uuid::Uuid::new_v4().to_string(),
            },
        );
        token
    }

    /// The processes currently holding a token for `tile_id` (normally one).
    pub fn process_keys(&self, tile_id: &str) -> Vec<String> {
        self.tokens
            .lock()
            .unwrap()
            .values()
            .filter_map(|caller| match caller {
                Caller::Agent {
                    tile_id: t,
                    process_key,
                    ..
                } if t == tile_id => Some(process_key.clone()),
                _ => None,
            })
            .collect()
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

    /// Fetches `branch` from origin into `project_directory`'s repo, so a
    /// worktree can start from `origin/<branch>`. Fakes need not fetch.
    fn fetch_branch(&self, _project_directory: &str, _branch: &str) -> Result<(), String> {
        Ok(())
    }

    /// Whether `branch` exists locally or on a remote of `project_directory`'s repo.
    fn branch_exists(&self, _project_directory: &str, _branch: &str) -> bool {
        false
    }

    /// The repo's default branch name (`main`), when it can be told.
    fn default_branch(&self, _project_directory: &str) -> Option<String> {
        None
    }

    /// Removes a worktree an investigation made but won't use, and its branch
    /// when the branch has no commits of its own. Fakes need not.
    fn rollback_worktree(
        &self,
        _project_directory: &str,
        _path: &str,
        _branch: &str,
    ) -> Result<(), String> {
        Ok(())
    }
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
    /// Resolves pasted pipeline links (ADR 038). Asks ADO, so like
    /// worktree creation it runs while the request holds the DB lock.
    pub pipelines: Option<&'a dyn crate::pipeline_inbox::PipelineResolver>,
    /// Reads and publishes Planning data (ADR 039); asks ADO under the lock,
    /// like worktree creation.
    pub planning: Option<&'a dyn crate::ado_planning::PlanningGateway>,
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
        id: "inbox.mute",
        log_params: &["id"],
        summary: "Stop tracking events like this notification, in every repo; marks existing ones read (params: id)",
        requires_identity: true,
        destructive: false,
        handler: inbox_mute,
    },
    Command {
        id: "inbox.unmute_all",
        log_params: &[],
        summary: "Track every kind of PR event again (clears all mutes)",
        requires_identity: true,
        destructive: false,
        handler: inbox_unmute_all,
    },
    Command {
        id: "planning.sprint",
        log_params: &[],
        summary: "Your user stories in Planning's selected sprint, with committed / done / to-go story points (ADR 039)",
        requires_identity: true,
        destructive: false,
        handler: planning_sprint,
    },
    Command {
        id: "planning.features",
        log_params: &[],
        summary: "Your open features: target date, done and pending story points, sprints left, at risk",
        requires_identity: true,
        destructive: false,
        handler: planning_features,
    },
    Command {
        id: "planning.feature",
        log_params: &["id"],
        summary: "One feature and its stories (params: id)",
        requires_identity: true,
        destructive: false,
        handler: planning_feature,
    },
    Command {
        id: "planning.move",
        log_params: &["story", "sprint"],
        summary: "Draft: move a story to a sprint (params: story, sprint = name or path); nothing reaches ADO until planning.publish",
        requires_identity: true,
        destructive: false,
        handler: planning_move,
    },
    Command {
        id: "planning.estimate",
        log_params: &["story", "points"],
        summary: "Draft: set a story's story points (params: story, points)",
        requires_identity: true,
        destructive: false,
        handler: planning_estimate,
    },
    Command {
        id: "sync.status",
        log_params: &[],
        summary: "The sync server's monitored state (ADR 040): whether one is configured, the latest check and vitals, open problems and active mutes",
        requires_identity: true,
        destructive: false,
        handler: sync_status,
    },
    Command {
        id: "sync.history",
        log_params: &["hours"],
        summary: "Stored sync server checks of the last hours (params: hours = 1..24, default 24)",
        requires_identity: true,
        destructive: false,
        handler: sync_history,
    },
    Command {
        id: "sync.mute",
        log_params: &["kind", "hours"],
        summary: "Mute a sync server problem kind's alerts (params: kind = unreachable | cpu | memory | disk | logins | doc_size | doc_growth, hours = default 24)",
        requires_identity: true,
        destructive: false,
        handler: sync_mute,
    },
    Command {
        id: "planning.orphan_prs",
        log_params: &["days"],
        summary: "Your PRs with no linked work item, across Planning's organization (params: days = 7 | 30 | 90, default the tab's range); hidden ones are flagged",
        requires_identity: true,
        destructive: false,
        handler: planning_orphan_prs,
    },
    Command {
        id: "planning.hide_pr",
        log_params: &["pr"],
        summary: "Hide an orphaned PR from the Orphaned PRs tab (params: pr)",
        requires_identity: true,
        destructive: false,
        handler: planning_hide_pr,
    },
    Command {
        id: "planning.unhide_pr",
        log_params: &["pr"],
        summary: "Show a hidden PR again (params: pr)",
        requires_identity: true,
        destructive: false,
        handler: planning_unhide_pr,
    },
    Command {
        id: "planning.hide_repo",
        log_params: &["repo"],
        summary: "Hide every orphaned PR of a repo (params: repo = \"Project/repo\" or repository id)",
        requires_identity: true,
        destructive: false,
        handler: planning_hide_repo,
    },
    Command {
        id: "planning.unhide_repo",
        log_params: &["repo"],
        summary: "Show a hidden repo's PRs again (params: repo)",
        requires_identity: true,
        destructive: false,
        handler: planning_unhide_repo,
    },
    Command {
        id: "planning.link_pr",
        log_params: &["pr", "item"],
        summary: "Draft: link an orphaned PR to one of your stories, a task of a sprint story, or a drafted story's temporary id (params: pr, item); written on planning.publish",
        requires_identity: true,
        destructive: false,
        handler: planning_link_pr,
    },
    Command {
        id: "planning.task_state",
        log_params: &["task", "state"],
        summary: "Draft: set a task's state (params: task = id of a task under a story in the selected sprint, state = New | Active | Blocked | Resolved | Closed); its state in ADO again drops the pending change",
        requires_identity: true,
        destructive: false,
        handler: planning_task_state,
    },
    Command {
        id: "planning.add_story",
        log_params: &["feature", "points"],
        summary: "Draft: add a user story to a feature (params: feature, title, points optional)",
        requires_identity: true,
        destructive: false,
        handler: planning_add_story,
    },
    Command {
        id: "planning.ktlo",
        log_params: &[],
        summary: "This semester's KTLO feature as ADO has it now (id, title, state, url, problem), or null when none is set",
        requires_identity: true,
        destructive: false,
        handler: planning_ktlo,
    },
    Command {
        id: "planning.set_ktlo",
        log_params: &["link"],
        summary: "Set the KTLO feature from its link (params: link = …/_workitems/edit/<id>); refused unless it's an open Feature in Planning's organization and project",
        requires_identity: true,
        destructive: false,
        handler: planning_set_ktlo,
    },
    Command {
        id: "planning.ktlo_story",
        log_params: &["pr", "points", "sprint"],
        summary: "Draft: a new story under the KTLO feature with an orphaned PR linked to it (params: pr, title = default the PR's title, points = default 1, sprint = name or path, default the sprint after the current one); returns its temporary id, which planning.link_pr accepts for more PRs",
        requires_identity: true,
        destructive: false,
        handler: planning_ktlo_story,
    },
    Command {
        id: "planning.publish",
        log_params: &[],
        summary: "Publish the planning draft to ADO; reports what was written and what changed in ADO meanwhile",
        requires_identity: true,
        destructive: false,
        handler: planning_publish,
    },
    Command {
        id: "inbox.pipelines",
        log_params: &[],
        summary: "List watched ADO pipelines: mode, last result, error, and repo (ado_repo = what ADO says it builds; repos = its Workstreams repos; repo_source = auto | manual)",
        requires_identity: true,
        destructive: false,
        handler: inbox_pipelines,
    },
    Command {
        id: "inbox.pipeline_add",
        log_params: &["mode"],
        summary: "Watch the ADO pipeline a link points at (params: url = a pipeline or run link, mode=off|failures|successes|both|daily_failures, default failures)",
        requires_identity: true,
        destructive: false,
        handler: inbox_pipeline_add,
    },
    Command {
        id: "inbox.pipeline_mode",
        log_params: &["id", "mode"],
        summary: "Change what a watched pipeline notifies (params: id, mode=off|failures|successes|both|daily_failures; daily_failures posts one digest entry per day instead of one per failed run)",
        requires_identity: true,
        destructive: false,
        handler: inbox_pipeline_mode,
    },
    Command {
        id: "inbox.pipeline_branches",
        log_params: &["id", "branches"],
        summary: "Choose whose runs of a watched pipeline notify: the repo's default branch, or every branch (params: id, branches=default|all)",
        requires_identity: true,
        destructive: false,
        handler: inbox_pipeline_branches,
    },
    Command {
        id: "inbox.investigate",
        log_params: &["item"],
        summary: "Investigate a failed pipeline run or a daily digest (params: item = a run notification id, a digest id, or drun:<digest>:<run> for one run of a digest): makes a workstream for it (a worktree of its repo from the run's branch, or for a digest one worktree from the default branch's tip; else standalone) whose Copilot session the app starts with the context; returns {workstream_id, created}, or the existing investigation",
        requires_identity: true,
        destructive: false,
        handler: inbox_investigate,
    },
    Command {
        id: "inbox.mute_all_on",
        log_params: &["until"],
        summary: "Mute all: record nothing new in the Inbox from any source (PRs, pipelines, digests, agent messages, schedule notices, sync alerts) until turned off, or until a time (params: until = RFC 3339, e.g. 2026-12-01T08:00:00Z, optional). Muted events are dropped, never replayed. Not inbox.mute, which silences one kind of PR event",
        requires_identity: true,
        destructive: false,
        handler: inbox_mute_all_on,
    },
    Command {
        id: "inbox.mute_all_off",
        log_params: &[],
        summary: "Turn Mute all off: the Inbox records new events again; nothing from the muted time replays. Not inbox.unmute_all, which clears PR mute rules",
        requires_identity: true,
        destructive: false,
        handler: inbox_mute_all_off,
    },
    Command {
        id: "inbox.pipeline_auto_investigate",
        log_params: &["pipeline", "value"],
        summary: "Whether a Daily-failures pipeline's daily digest also starts its batch investigation (params: pipeline = its id, value=off|digest); refused for a pipeline in any other mode. An existing investigation gets the new runs as a follow-up instead; at most 3 new ones start in any 24 hours",
        requires_identity: true,
        destructive: false,
        handler: inbox_pipeline_auto_investigate,
    },
    Command {
        id: "inbox.digest_time",
        log_params: &["time"],
        summary: "Read or set the global time Daily-failures pipelines post their digest (params: time=HH:MM, 24-hour local; omit to read; default 09:00)",
        requires_identity: true,
        destructive: false,
        handler: inbox_digest_time,
    },
    Command {
        id: "inbox.pipeline_set_repo",
        log_params: &["pipeline", "repo"],
        summary: "Set a watched pipeline's repo by hand (params: pipeline = its id, repo = a repo id, none, or auto to follow ADO again)",
        requires_identity: true,
        destructive: false,
        handler: inbox_pipeline_set_repo,
    },
    Command {
        id: "inbox.pipeline_remove",
        log_params: &["id"],
        summary: "Stop watching a pipeline and drop its notifications (params: id)",
        requires_identity: true,
        destructive: true,
        handler: inbox_pipeline_remove,
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
        id: "diagram.list",
        log_params: &[],
        summary: "List this workstream's Diagram boards (id, name, tile, shape count, pending additions)",
        requires_identity: true,
        destructive: false,
        handler: diagram_list,
    },
    Command {
        id: "diagram.get",
        log_params: &["board"],
        summary: "Read a Diagram board as text: labelled shapes and connections (params: board = id or name)",
        requires_identity: true,
        destructive: false,
        handler: diagram_get,
    },
    Command {
        id: "diagram.add",
        log_params: &["board"],
        summary: "Add a Mermaid diagram (flowchart, sequence, class, state) to a board as editable shapes, next to what is there (params: board = id or name, mermaid; mermaid=@- reads stdin). Never deletes or moves existing shapes",
        requires_identity: true,
        // Only appends shapes; the user's own shapes are never touched.
        destructive: false,
        handler: diagram_add,
    },
    Command {
        id: "learning.check",
        log_params: &[],
        summary: "Queue a Rust Pocket check on this Mac (params: request = JSON {card_id, card_version, harness {before, after, cases|tests, constraints, serde}, source, toolchain?}; request=@- reads stdin). Returns the job; read its result with learning.jobs",
        requires_identity: true,
        destructive: false,
        handler: learning_check,
    },
    Command {
        id: "learning.help",
        log_params: &[],
        summary: "Queue a Rust Pocket tutor answer from Copilot, with no tools (params: request = JSON {card_id, card_version, level nudge|hint|solution, exercise, source, summary?, diagnostic?}; request=@- reads stdin). Returns the job; read its reply with learning.jobs",
        requires_identity: true,
        destructive: false,
        handler: learning_help,
    },
    Command {
        id: "learning.pack",
        log_params: &[],
        summary: "Queue a Rust Pocket pack draft: Copilot (no tools) writes it, then each card's reference solution must pass and its wrong answer must fail with the real compiler (params: request = JSON {topic, pack_id?, previous?, notes?}; request=@- reads stdin). Returns the job; read {pack, validation, valid, error} with learning.jobs",
        requires_identity: true,
        destructive: false,
        handler: learning_pack,
    },
    Command {
        id: "learning.jobs",
        log_params: &["id"],
        summary: "Rust Pocket check, help and pack jobs, newest first, or one job with its result (params: id = a job id, optional)",
        requires_identity: true,
        destructive: false,
        handler: learning_jobs,
    },
    Command {
        id: "inbox.message",
        // Never the body: it can be long, and it is the user's business.
        log_params: &["level", "title"],
        summary: "Send the user a message in the Workstreams Inbox (params: level=info|done|needs-you|error, title (≤120 chars), body (markdown, ≤20000 chars; body=@- reads stdin)). At most 20 per session per hour",
        requires_identity: true,
        destructive: false,
        handler: inbox_message,
    },
    Command {
        id: "companion.send",
        // Never the text: it can be long, and it is the user's business.
        log_params: &["kind"],
        summary: "Send a message to your phone from this session; a session the phone didn't start gets its own thread, named after the tile (params: kind=progress|result, text; text=@- reads stdin). At most 20 per session per hour; needs the phone companion on",
        requires_identity: true,
        destructive: false,
        handler: companion_send,
    },
    Command {
        id: "schedule.create",
        // Never the prompt: it is the user's business.
        log_params: &["tile", "frequency", "notify_inbox", "notify_phone"],
        summary: "Run a Copilot session tile periodically: at each due time the app resumes its session with the prompt, verbatim (params: prompt (prompt=@- reads stdin), frequency=hourly|every:<N>h|every:<N>m|daily:HH:MM|weekly:<day>:HH:MM (laptop time, at least every 5 minutes), tile = a session tile in your workstream (default: yours), notify_inbox=true|false, notify_phone=true|false). One schedule per tile; the first run is at the first scheduled time (ADR 044)",
        requires_identity: true,
        destructive: false,
        handler: schedule_create,
    },
    Command {
        id: "schedule.list",
        log_params: &[],
        summary: "Every periodic schedule: tile, workstream, prompt, frequency, paused, next and last run, last result, consecutive failures",
        requires_identity: true,
        destructive: false,
        handler: schedule_list,
    },
    Command {
        id: "schedule.run",
        log_params: &["id", "tile"],
        summary: "Run a schedule now (params: id, or tile); skipped if its agent is mid-turn",
        requires_identity: true,
        destructive: false,
        handler: schedule_run,
    },
    Command {
        id: "schedule.pause",
        log_params: &["id", "tile"],
        summary: "Pause a schedule (params: id, or tile)",
        requires_identity: true,
        destructive: false,
        handler: schedule_pause,
    },
    Command {
        id: "schedule.resume",
        log_params: &["id", "tile"],
        summary: "Resume a paused schedule from now, clearing its failure count (params: id, or tile)",
        requires_identity: true,
        destructive: false,
        handler: schedule_resume,
    },
    Command {
        id: "schedule.delete",
        log_params: &["id", "tile"],
        summary: "Delete a schedule; the tile and its session stay (params: id, or tile)",
        requires_identity: true,
        destructive: true,
        handler: schedule_delete,
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

fn pipeline_mode_param(
    params: &serde_json::Value,
) -> Result<Option<crate::pipeline_inbox::PipelineMode>, AgentError> {
    params
        .get("mode")
        .and_then(|value| value.as_str())
        .map(|mode| {
            crate::pipeline_inbox::PipelineMode::parse(mode).map_err(|e| {
                AgentError::new(
                    "INVALID_PARAM",
                    e,
                    "Pass mode=off, mode=failures, mode=successes, mode=both or mode=daily_failures.",
                )
            })
        })
        .transpose()
}

fn inbox_pipelines(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let rows = crate::pipeline_inbox::list(context.db).map_err(inbox_error)?;
    Ok(CommandOutcome::read(serde_json::json!(rows)))
}

fn inbox_pipeline_add(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let url = required_str(params, "url")?;
    let mode = pipeline_mode_param(params)?;
    let resolver = context.pipelines.ok_or_else(|| {
        AgentError::new(
            "NO_RESOLVER",
            "This build cannot read ADO pipelines",
            "Report this as a bug.",
        )
    })?;
    let pipeline = resolver.resolve(&url).map_err(inbox_error)?;
    let added = crate::pipeline_inbox::add(context.db, &pipeline, mode).map_err(inbox_error)?;
    let id = added.id.clone();
    Ok(CommandOutcome::changed(
        serde_json::json!(added),
        StateChange::new("pr_inbox", id, "pipeline_added"),
    ))
}

fn inbox_pipeline_mode(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "id")?;
    let mode = pipeline_mode_param(params)?.ok_or_else(|| {
        AgentError::new(
            "INVALID_PARAM",
            "mode is required",
            "Pass mode=off, mode=failures, mode=successes, mode=both or mode=daily_failures.",
        )
    })?;
    crate::pipeline_inbox::set_mode(context.db, &id, mode).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"id":id,"mode":mode}),
        StateChange::new("pr_inbox", id, "pipeline_mode"),
    ))
}

fn inbox_pipeline_branches(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "id")?;
    let branches = crate::pipeline_inbox::BranchScope::parse(&required_str(params, "branches")?)
        .map_err(|e| {
            AgentError::new("INVALID_PARAM", e, "Pass branches=default or branches=all.")
        })?;
    crate::pipeline_inbox::set_branches(context.db, &id, branches).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"id":id,"branches":branches}),
        StateChange::new("pr_inbox", id, "pipeline_branches"),
    ))
}

fn inbox_investigate(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    use crate::pipeline_investigate as investigate;
    let item = required_str(params, "item")?;
    let subject = investigate::subject(context.db, &item).map_err(inbox_error)?;
    let _claim = investigate::claim(&item).map_err(inbox_error)?;
    let started = match investigate::existing(context.db, &item).map_err(inbox_error)? {
        Some(id) => investigate::Started {
            workstream_id: id,
            created: false,
        },
        None => {
            // Holds the lock while git runs, like ws.create's worktrees.
            let placement =
                investigate::place_subject(context.provisioner, &subject, &investigate::home_dir());
            let created_by = match context.caller {
                Some(Caller::Agent { tile_id, .. }) => Some(tile_id.clone()),
                _ => None,
            };
            investigate::record_subject(context.db, &subject, &placement, created_by, false)
                .map_err(inbox_error)?
        }
    };
    Ok(CommandOutcome::changed(
        serde_json::json!(started),
        StateChange::new("pipeline_investigation", &started.workstream_id, "started"),
    ))
}

fn inbox_pipeline_auto_investigate(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "pipeline")?;
    let value = crate::pipeline_digest::AutoInvestigate::parse(&required_str(params, "value")?)
        .map_err(|e| AgentError::new("INVALID_PARAM", e, "Pass value=off or value=digest."))?;
    crate::pipeline_digest::set_auto_investigate(context.db, &id, value).map_err(|e| {
        AgentError::new(
            "INBOX_ERROR",
            e,
            "Set the pipeline to Daily failures first: inbox.pipeline_mode id=<pipeline> mode=daily_failures.",
        )
    })?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"id": id, "auto_investigate": value}),
        StateChange::new("pr_inbox", id, "pipeline_auto_investigate"),
    ))
}

fn inbox_mute_all_on(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let until = optional_str(params, "until");
    let state = crate::inbox_mute::mute(context.db, until.as_deref()).map_err(|e| {
        AgentError::new(
            "INVALID_PARAM",
            e,
            "Omit until to mute until turned off, or pass a future time like until=2026-12-01T08:00:00Z.",
        )
    })?;
    Ok(CommandOutcome::changed(
        serde_json::json!(state),
        StateChange::new("pr_inbox", "mute", "muted"),
    ))
}

fn inbox_mute_all_off(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let state = crate::inbox_mute::unmute(context.db).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!(state),
        StateChange::new("pr_inbox", "mute", "unmuted"),
    ))
}

fn inbox_digest_time(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    match optional_str(params, "time") {
        None => {
            let time = crate::pipeline_digest::digest_time(context.db).map_err(inbox_error)?;
            Ok(CommandOutcome::read(serde_json::json!({"time": time})))
        }
        Some(time) => {
            let time = crate::pipeline_digest::set_digest_time(context.db, &time).map_err(|e| {
                AgentError::new(
                    "INVALID_PARAM",
                    e,
                    "Pass time=HH:MM, for example time=09:00.",
                )
            })?;
            Ok(CommandOutcome::changed(
                serde_json::json!({"time": time}),
                StateChange::new("pr_inbox", "digest_time", "digest_time"),
            ))
        }
    }
}

fn inbox_pipeline_set_repo(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "pipeline")?;
    let repo = required_str(params, "repo")?;
    crate::pipeline_inbox::set_repo(context.db, &id, &repo).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"id": id, "repo": repo}),
        StateChange::new("pr_inbox", id, "pipeline_repo"),
    ))
}

fn inbox_pipeline_remove(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "id")?;
    crate::pipeline_inbox::remove(context.db, &id).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"id":id,"removed":true}),
        StateChange::new("pr_inbox", id, "pipeline_removed"),
    ))
}

fn planning_error(error: String) -> AgentError {
    AgentError::new(
        "PLANNING_ERROR",
        error,
        "Connect Planning to your team in the app (paste a sprint or backlog link) and run az login if ADO refuses.",
    )
}

/// The planning gateway and fresh data for the selected sprint.
fn planning_data(
    context: &CommandContext,
) -> Result<crate::ado_planning::PlanningData, AgentError> {
    let gateway = context.planning.ok_or_else(|| {
        AgentError::new(
            "NO_PLANNING",
            "This build cannot read ADO planning data",
            "Report this as a bug.",
        )
    })?;
    let conn = crate::ado_planning::load_connection(context.db)
        .map_err(planning_error)?
        .ok_or_else(|| planning_error("Planning isn't connected to a team yet".into()))?;
    let selected = crate::ado_planning::selected_sprint(context.db).map_err(planning_error)?;
    let data = gateway
        .fetch(&conn, selected.as_deref())
        .map_err(planning_error)?;
    if selected.is_none() {
        crate::ado_planning::remember_default_sprint(context.db, &conn, &data.selected_sprint)
            .map_err(planning_error)?;
    }
    Ok(data)
}

fn param_i64(params: &serde_json::Value, key: &str) -> Result<i64, AgentError> {
    params
        .get(key)
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| {
            AgentError::new(
                "INVALID_PARAM",
                format!("{key} must be a work item id"),
                format!("Pass {key}=<id>."),
            )
        })
}

fn param_points(params: &serde_json::Value) -> Result<Option<f64>, AgentError> {
    match params.get("points") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => v
            .as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            .filter(|p| p.is_finite() && *p >= 0.0)
            .map(Some)
            .ok_or_else(|| {
                AgentError::new(
                    "INVALID_PARAM",
                    "points must be a number of story points",
                    "Pass points=3, for example.",
                )
            }),
    }
}

fn planning_sprint(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let data = planning_data(context)?;
    Ok(CommandOutcome::read(serde_json::json!(
        crate::ado_planning::sprint_summary(&data)
    )))
}

fn planning_features(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let data = planning_data(context)?;
    // The KTLO feature is left out, as in the Features tab.
    let ktlo = crate::ado_planning::ktlo_id(context.db).map_err(planning_error)?;
    let features: Vec<_> = crate::ado_planning::feature_summaries(&data)
        .into_iter()
        .filter(|f| Some(f.feature.id) != ktlo)
        .collect();
    Ok(CommandOutcome::read(serde_json::json!(features)))
}

fn planning_feature(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = param_i64(params, "id")?;
    let data = planning_data(context)?;
    let feature = crate::ado_planning::feature_summaries(&data)
        .into_iter()
        .find(|f| f.feature.id == id)
        .ok_or_else(|| planning_error(format!("Feature {id} isn't one of your open features")))?;
    Ok(CommandOutcome::read(serde_json::json!(feature)))
}

fn planning_story(
    data: &crate::ado_planning::PlanningData,
    id: i64,
) -> Result<crate::ado_planning::PlanItem, AgentError> {
    data.items
        .iter()
        .find(|i| i.id == id && i.kind == "User Story")
        .cloned()
        .ok_or_else(|| {
            planning_error(format!(
                "Story {id} isn't one of your stories or your features' stories"
            ))
        })
}

fn planning_add(
    context: &CommandContext,
    change: crate::ado_planning::Change,
) -> Result<CommandOutcome, AgentError> {
    let draft = crate::ado_planning::add_to_draft(context.db, change).map_err(planning_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({ "draft": draft.len() }),
        StateChange::new("planning", "draft", "changed"),
    ))
}

fn planning_move(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let story = param_i64(params, "story")?;
    let sprint = required_str(params, "sprint")?;
    let data = planning_data(context)?;
    let item = planning_story(&data, story)?;
    let path = data
        .iterations
        .iter()
        .find(|i| i.path == sprint || i.name.eq_ignore_ascii_case(&sprint))
        .map(|i| i.path.clone())
        .ok_or_else(|| planning_error(format!("No sprint named {sprint} in the team's sprints")))?;
    planning_add(
        context,
        crate::ado_planning::Change::Move {
            id: item.id,
            rev: item.rev,
            to_iteration: path,
            assign_to_me: item.assigned_to.is_none(),
        },
    )
}

fn planning_estimate(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let story = param_i64(params, "story")?;
    let points = param_points(params)?;
    let data = planning_data(context)?;
    let item = planning_story(&data, story)?;
    planning_add(
        context,
        crate::ado_planning::Change::Estimate {
            id: item.id,
            rev: item.rev,
            points,
        },
    )
}

fn sync_error(message: String) -> AgentError {
    AgentError::new(
        "SYNC_MONITOR",
        message,
        "Check Settings → Sync server monitoring.",
    )
}

fn sync_status(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let state =
        crate::sync_monitor::state(context.db, crate::sync_monitor_now()).map_err(sync_error)?;
    Ok(CommandOutcome::read(serde_json::json!({
        "configured": state.configured,
        "server_url": state.server_url,
        "has_key": state.has_key,
        "latest": state.checks.last(),
        "problems": state.problems,
        "mutes": state.mutes,
    })))
}

fn sync_history(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let hours = match params.get("hours") {
        None | Some(serde_json::Value::Null) => 24,
        Some(_) => param_i64(params, "hours")?.clamp(1, 24),
    };
    let since = crate::sync_monitor_now() - hours * 3_600_000;
    let checks = crate::sync_monitor::checks_since(context.db, since).map_err(sync_error)?;
    Ok(CommandOutcome::read(
        serde_json::json!({ "hours": hours, "checks": checks }),
    ))
}

fn sync_mute(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let kind = required_str(params, "kind")?;
    let hours = match params.get("hours") {
        None | Some(serde_json::Value::Null) => 24,
        Some(_) => param_i64(params, "hours")?.clamp(0, i64::from(u32::MAX)) as u32,
    };
    let until = crate::sync_monitor::mute(context.db, &kind, hours, crate::sync_monitor_now())
        .map_err(sync_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({ "kind": crate::sync_monitor::base_kind(&kind), "until": until }),
        StateChange::new("sync", "mutes", "changed"),
    ))
}

fn planning_orphan_list(
    context: &CommandContext,
    days: Option<u32>,
) -> Result<
    (
        Vec<crate::orphan_prs::OrphanPr>,
        crate::orphan_prs::Hidden,
        u32,
    ),
    AgentError,
> {
    let gateway = context.planning.ok_or_else(|| {
        AgentError::new(
            "NO_PLANNING",
            "This build cannot read ADO planning data",
            "Report this as a bug.",
        )
    })?;
    let conn = crate::ado_planning::load_connection(context.db)
        .map_err(planning_error)?
        .ok_or_else(|| planning_error("Planning isn't connected to a team yet".into()))?;
    let days = match days {
        Some(d) if crate::orphan_prs::RANGES.contains(&d) => d,
        Some(d) => {
            return Err(planning_error(format!(
                "The range is 7, 30 or 90 days, not {d}"
            )))
        }
        None => crate::orphan_prs::load_days(context.db).map_err(planning_error)?,
    };
    let prs = gateway
        .orphans(&conn.organization, days)
        .map_err(planning_error)?;
    let hidden = crate::orphan_prs::load_hidden(context.db).map_err(planning_error)?;
    Ok((prs, hidden, days))
}

fn planning_orphan_prs(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let days = match params.get("days") {
        None | Some(serde_json::Value::Null) => None,
        Some(_) => Some(param_i64(params, "days")?.clamp(0, i64::from(u32::MAX)) as u32),
    };
    let (prs, hidden, days) = planning_orphan_list(context, days)?;
    let prs: Vec<serde_json::Value> = prs
        .iter()
        .map(|p| {
            let mut v = serde_json::json!(p);
            v["hidden"] = serde_json::json!(p.is_hidden(&hidden));
            v
        })
        .collect();
    Ok(CommandOutcome::read(
        serde_json::json!({ "days": days, "prs": prs, "hidden": hidden }),
    ))
}

fn planning_find_orphan(
    context: &CommandContext,
    id: i64,
) -> Result<crate::orphan_prs::OrphanPr, AgentError> {
    let (prs, _, _) = planning_orphan_list(context, None)?;
    prs.into_iter().find(|p| p.id == id).ok_or_else(|| {
        planning_error(format!(
            "{id} isn't one of your orphaned PRs in the tab's range"
        ))
    })
}

fn planning_hidden_changed(hidden: crate::orphan_prs::Hidden) -> CommandOutcome {
    CommandOutcome::changed(
        serde_json::json!({ "hidden": hidden }),
        StateChange::new("planning", "orphans", "changed"),
    )
}

fn planning_hide_pr(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let pr = planning_find_orphan(context, param_i64(params, "pr")?)?;
    let entry = crate::orphan_prs::HiddenEntry {
        id: pr.id.to_string(),
        label: pr.title,
    };
    crate::orphan_prs::hide(context.db, "pr", entry)
        .map(planning_hidden_changed)
        .map_err(planning_error)
}

fn planning_unhide_pr(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = param_i64(params, "pr")?.to_string();
    crate::orphan_prs::unhide(context.db, "pr", &id)
        .map(planning_hidden_changed)
        .map_err(planning_error)
}

fn planning_hide_repo(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let repo = required_str(params, "repo")?;
    let (prs, _, _) = planning_orphan_list(context, None)?;
    let found = prs
        .iter()
        .find(|p| p.repo_id == repo || p.repo.eq_ignore_ascii_case(&repo))
        .ok_or_else(|| {
            planning_error(format!("No orphaned PR of yours is in a repo named {repo}"))
        })?;
    let entry = crate::orphan_prs::HiddenEntry {
        id: found.repo_id.clone(),
        label: found.repo.clone(),
    };
    crate::orphan_prs::hide(context.db, "repo", entry)
        .map(planning_hidden_changed)
        .map_err(planning_error)
}

fn planning_unhide_repo(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let repo = required_str(params, "repo")?;
    let hidden = crate::orphan_prs::load_hidden(context.db).map_err(planning_error)?;
    let id = hidden
        .repos
        .iter()
        .find(|h| h.id == repo || h.label.eq_ignore_ascii_case(&repo))
        .map(|h| h.id.clone())
        .unwrap_or(repo);
    crate::orphan_prs::unhide(context.db, "repo", &id)
        .map(planning_hidden_changed)
        .map_err(planning_error)
}

/// Links an orphaned PR to one of your stories or a task of a sprint story.
fn planning_link_pr(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let pr = planning_find_orphan(context, param_i64(params, "pr")?)?;
    let item = param_i64(params, "item")?;
    if item < 0 {
        // A drafted story: add_to_draft refuses a temporary id it doesn't hold.
        return planning_add(
            context,
            crate::ado_planning::Change::LinkPr {
                id: item,
                rev: 0,
                pr: crate::ado_planning::PrRef {
                    id: pr.id,
                    project_id: pr.project_id,
                    repo_id: pr.repo_id,
                    title: pr.title,
                },
            },
        );
    }
    let data = planning_data(context)?;
    let rev = data
        .items
        .iter()
        .filter(|i| i.kind == "User Story" && i.state != "Removed")
        .find(|i| i.id == item)
        .map(|i| i.rev)
        .or_else(|| {
            // Tasks of every story in the selected sprint, as the tab offers them.
            data.items
                .iter()
                .filter(|s| {
                    s.kind == "User Story"
                        && s.state != "Removed"
                        && s.iteration_path == data.selected_sprint
                })
                .flat_map(|s| s.tasks.iter())
                .find(|t| t.id == item)
                .map(|t| t.rev)
        })
        .ok_or_else(|| {
            planning_error(format!(
                "{item} isn't one of your stories or a task of a sprint story"
            ))
        })?;
    planning_add(
        context,
        crate::ado_planning::Change::LinkPr {
            id: item,
            rev,
            pr: crate::ado_planning::PrRef {
                id: pr.id,
                project_id: pr.project_id,
                repo_id: pr.repo_id,
                title: pr.title,
            },
        },
    )
}

fn planning_gateway<'a>(
    context: &CommandContext<'a>,
) -> Result<
    (
        &'a dyn crate::ado_planning::PlanningGateway,
        crate::ado_planning::PlanningConnection,
    ),
    AgentError,
> {
    let gateway = context.planning.ok_or_else(|| {
        AgentError::new(
            "NO_PLANNING",
            "This build cannot read ADO planning data",
            "Report this as a bug.",
        )
    })?;
    let conn = crate::ado_planning::load_connection(context.db)
        .map_err(planning_error)?
        .ok_or_else(|| planning_error("Planning isn't connected to a team yet".into()))?;
    Ok((gateway, conn))
}

fn planning_ktlo(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let (gateway, conn) = planning_gateway(context)?;
    let feature = match crate::ado_planning::ktlo_id(context.db).map_err(planning_error)? {
        Some(id) => Some(gateway.ktlo(&conn, id).map_err(planning_error)?),
        None => None,
    };
    Ok(CommandOutcome::read(serde_json::json!({ "ktlo": feature })))
}

fn planning_set_ktlo(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let link = required_str(params, "link")?;
    let (gateway, conn) = planning_gateway(context)?;
    let feature = gateway.check_ktlo(&conn, &link).map_err(planning_error)?;
    crate::ado_planning::save_ktlo(context.db, feature.id).map_err(planning_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({ "ktlo": feature }),
        StateChange::new("planning", "ktlo", "changed"),
    ))
}

/// Drafts a new story under the KTLO feature, with the PR linked to it.
fn planning_ktlo_story(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    use crate::ado_planning::{Change, PrRef};
    let (gateway, conn) = planning_gateway(context)?;
    let id = crate::ado_planning::ktlo_id(context.db)
        .map_err(planning_error)?
        .ok_or_else(|| {
            planning_error("Set the KTLO feature first (planning.set_ktlo link=…)".into())
        })?;
    let feature = gateway.ktlo(&conn, id).map_err(planning_error)?;
    if let Some(problem) = feature.problem {
        return Err(planning_error(problem));
    }
    let pr = planning_find_orphan(context, param_i64(params, "pr")?)?;
    let title = match params.get("title") {
        None | Some(serde_json::Value::Null) => pr.title.clone(),
        Some(_) => required_str(params, "title")?,
    };
    if title.trim().is_empty() {
        return Err(planning_error("A KTLO story needs a title".into()));
    }
    let points = match params.get("points") {
        None | Some(serde_json::Value::Null) => Some(1.0),
        Some(_) => param_points(params)?,
    };
    let data = planning_data(context)?;
    let sprints = crate::ado_planning::sprints_from_current(&data.iterations);
    let iteration = match params.get("sprint") {
        None | Some(serde_json::Value::Null) => crate::ado_planning::next_sprint(&data.iterations)
            .map(|i| i.path.clone())
            .ok_or_else(|| planning_error("ADO lists no current or future sprint".into()))?,
        Some(_) => {
            let wanted = required_str(params, "sprint")?;
            sprints
                .iter()
                .find(|i| {
                    i.path.eq_ignore_ascii_case(&wanted) || i.name.eq_ignore_ascii_case(&wanted)
                })
                .map(|i| i.path.clone())
                .ok_or_else(|| {
                    planning_error(format!(
                        "{wanted} isn't a sprint from the current one on: {}",
                        sprints
                            .iter()
                            .map(|i| i.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?
        }
    };
    let draft = crate::ado_planning::load_draft(context.db).map_err(planning_error)?;
    let temp_id = draft
        .iter()
        .filter_map(|c| match c {
            Change::CreateFeature { temp_id, .. } | Change::CreateStory { temp_id, .. } => {
                Some(*temp_id)
            }
            _ => None,
        })
        .min()
        .unwrap_or(0)
        .min(0)
        - 1;
    crate::ado_planning::add_to_draft(
        context.db,
        Change::CreateStory {
            temp_id,
            parent: feature.id,
            title: title.trim().to_string(),
            points,
            description: None,
            iteration: Some(iteration.clone()),
            order: None,
        },
    )
    .map_err(planning_error)?;
    let draft = crate::ado_planning::add_to_draft(
        context.db,
        Change::LinkPr {
            id: temp_id,
            rev: 0,
            pr: PrRef {
                id: pr.id,
                project_id: pr.project_id,
                repo_id: pr.repo_id,
                title: pr.title,
            },
        },
    )
    .map_err(planning_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({ "draft": draft.len(), "story": temp_id, "sprint": iteration, "points": points }),
        StateChange::new("planning", "draft", "changed"),
    ))
}

fn planning_task_state(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    use crate::ado_planning::Change;
    let id = param_i64(params, "task")?;
    let state = required_str(params, "state")?;
    if !crate::ado_planning::SETTABLE_STATES.contains(&state.as_str()) {
        return Err(planning_error(format!(
            "\"{state}\" isn't a state Planning sets; use New, Active, Blocked, Resolved or Closed"
        )));
    }
    let data = planning_data(context)?;
    let task = crate::ado_planning::sprint_summary(&data)
        .stories
        .into_iter()
        .flat_map(|s| s.tasks)
        .find(|t| t.id == id)
        .ok_or_else(|| {
            planning_error(format!(
                "{id} isn't a task of a story in the selected sprint"
            ))
        })?;
    if task.state == state {
        let base = crate::ado_planning::load_draft(context.db).map_err(planning_error)?;
        let next: Vec<Change> = base
            .iter()
            .filter(|c| !matches!(c, Change::SetState { id: t, .. } if *t == id))
            .cloned()
            .collect();
        crate::ado_planning::replace_draft(context.db, &next, Some(&base))
            .map_err(planning_error)?;
        return Ok(CommandOutcome::changed(
            serde_json::json!({ "draft": next.len() }),
            StateChange::new("planning", "draft", "changed"),
        ));
    }
    planning_add(
        context,
        Change::SetState {
            id,
            rev: task.rev,
            state,
        },
    )
}

fn planning_add_story(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let feature = param_i64(params, "feature")?;
    let title = required_str(params, "title")?;
    if title.trim().is_empty() {
        return Err(planning_error("A story needs a title".into()));
    }
    let points = param_points(params)?;
    let draft = crate::ado_planning::load_draft(context.db).map_err(planning_error)?;
    let known_new_feature = draft.iter().any(|c| matches!(c, crate::ado_planning::Change::CreateFeature { temp_id, .. } if *temp_id == feature));
    if !known_new_feature {
        let data = planning_data(context)?;
        if !data
            .items
            .iter()
            .any(|i| i.id == feature && i.kind == "Feature")
        {
            return Err(planning_error(format!(
                "Feature {feature} isn't one of your open features"
            )));
        }
    }
    let temp_id = draft
        .iter()
        .filter_map(|c| match c {
            crate::ado_planning::Change::CreateFeature { temp_id, .. }
            | crate::ado_planning::Change::CreateStory { temp_id, .. } => Some(*temp_id),
            _ => None,
        })
        .min()
        .unwrap_or(0)
        .min(0)
        - 1;
    planning_add(
        context,
        crate::ado_planning::Change::CreateStory {
            temp_id,
            parent: feature,
            title: title.trim().to_string(),
            points,
            description: None,
            iteration: None,
            order: None,
        },
    )
}

fn planning_publish(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let (_guard, draft) = crate::ado_planning::start_publish(context.db).map_err(planning_error)?;
    let data = planning_data(context)?;
    let gateway = context.planning.expect("checked by planning_data");
    let result = gateway.publish(&data, &draft).map_err(planning_error)?;
    crate::ado_planning::save_draft(context.db, &result.remaining).map_err(planning_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!(result),
        StateChange::new("planning", "draft", "published"),
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

fn inbox_mute(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let id = required_str(params, "id")?;
    let rule = crate::pr_inbox::mute(context.db, &id).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!(rule),
        StateChange::new("pr_inbox", id, "muted"),
    ))
}

fn inbox_unmute_all(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let cleared = crate::pr_inbox::reset_mutes(context.db).map_err(inbox_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({"cleared": cleared}),
        StateChange::new("pr_inbox", "mutes", "reset"),
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
        ..
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

/// Accepts `paths=a.ts,b.ts` from the CLI, a JSON array on the wire, or
/// `paths_json=["a.ts","b, odd.ts"]` for names a comma split would break.
fn order_paths(params: &serde_json::Value) -> Result<Vec<String>, AgentError> {
    let bad = |message: &str| {
        AgentError::new(
            "BAD_PARAM",
            message.to_string(),
            "Pass paths_json as a JSON array of strings, e.g. paths_json='[\"a.ts\",\"b.ts\"]'.",
        )
    };
    if let Some(raw) = params.get("paths_json") {
        if params.get("paths").is_some() {
            return Err(bad("Pass either paths or paths_json, not both"));
        }
        let raw = raw
            .as_str()
            .ok_or_else(|| bad("paths_json must be a JSON array of strings"))?;
        let parsed: Vec<String> = serde_json::from_str(raw)
            .map_err(|_| bad("paths_json must be a JSON array of strings"))?;
        // Exact names: no trimming, so a name with significant spaces survives.
        return if parsed.is_empty() {
            Err(bad("paths_json is empty; list every changed file"))
        } else {
            Ok(parsed)
        };
    }
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

/// Sends a message from any Copilot session tile to the phone (ADR 033, widened by ADR 044).
///
/// The session is always the caller's own tile, resolved from the token the
/// app issued: there is no parameter naming a session.
fn companion_store_error(error: String) -> AgentError {
    AgentError::new(
        "STORE_ERROR",
        error,
        "Try again; if it keeps failing, give your result in the terminal.",
    )
}

fn learning_error(error: String) -> AgentError {
    AgentError::new(
        "LEARNING_FAILED",
        error,
        "Try again; if it persists, restart Workstreams.",
    )
}

fn learning_check(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    learning_enqueue(
        context,
        params,
        "check",
        "Send {card_id, card_version, harness: {before, after, cases or tests, constraints, serde}, source}.",
    )
}

fn learning_help(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    learning_enqueue(
        context,
        params,
        "help",
        "Send {card_id, card_version, level: nudge|hint|solution, exercise, source}.",
    )
}

fn learning_pack(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    learning_enqueue(
        context,
        params,
        "pack",
        "Send {topic}, or {topic, pack_id, previous, notes} to update an installed pack.",
    )
}

fn learning_enqueue(
    context: &CommandContext,
    params: &serde_json::Value,
    kind: &str,
    shape: &str,
) -> Result<CommandOutcome, AgentError> {
    let raw = required_str(params, "request")?;
    let mut value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        AgentError::new(
            "BAD_REQUEST",
            format!("request is not JSON: {e}"),
            "Pass request=@- with a JSON object.",
        )
    })?;
    if !value.is_object() {
        return Err(AgentError::new(
            "BAD_REQUEST",
            "request is not a JSON object",
            shape,
        ));
    }
    if value.get("id").is_none() {
        value["id"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
    }
    value["kind"] = serde_json::json!(kind);
    let request: crate::learning_jobs::JobRequest = serde_json::from_value(value).map_err(|e| {
        AgentError::new(
            "BAD_REQUEST",
            format!("request is not a {kind}: {e}"),
            shape,
        )
    })?;
    let job = crate::learning_jobs::enqueue(context.db, &request, "agent")
        .map_err(|e| AgentError::new("BAD_REQUEST", e, "Use a new id for a different request."))?;
    let id = job.id.clone();
    Ok(CommandOutcome::changed(
        serde_json::json!(job),
        StateChange::new("learning_job", id, "queued"),
    ))
}

fn learning_jobs(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    if let Some(id) = optional_str(params, "id") {
        let job = crate::learning_jobs::get(context.db, &id)
            .map_err(learning_error)?
            .ok_or_else(|| {
                AgentError::new(
                    "NOT_FOUND",
                    format!("No learning job {id}"),
                    "Run learning.jobs to list them.",
                )
            })?;
        return Ok(CommandOutcome::read(serde_json::json!(job)));
    }
    let jobs = crate::learning_jobs::list(context.db, 50).map_err(learning_error)?;
    Ok(CommandOutcome::read(serde_json::json!({ "jobs": jobs })))
}

fn inbox_message(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    const FALLBACK: &str = "Give the message in the terminal instead.";
    let Caller::Agent {
        tile_id,
        workstream_id,
        ..
    } = context.caller()?
    else {
        return Err(AgentError::new(
            "NOT_A_SESSION",
            "Only a Copilot session in Workstreams can message the Inbox",
            FALLBACK,
        ));
    };
    let text = |key: &str| {
        params
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string()
    };
    use crate::inbox_messages::{send, Refusal};
    let message = match send(
        context.db,
        workstream_id,
        tile_id,
        &text("level"),
        &text("title"),
        &text("body"),
    ) {
        Ok(message) => message,
        // Mute all (ADR 045): dropped, not an error the agent should retry.
        Err(Refusal::Muted) => {
            return Ok(CommandOutcome::read(serde_json::json!({
                "dropped": true,
                "reason": "The user muted the Inbox (Mute all), so the message was not recorded. Give your result in the terminal instead."
            })))
        }
        Err(Refusal::Invalid(error)) => return Err(AgentError::new(
            "BAD_MESSAGE",
            error,
            "Send level=info|done|needs-you|error, a title of at most 120 characters and a body of at most 20000.",
        )),
        Err(Refusal::RateLimited) => return Err(AgentError::new(
            "RATE_LIMITED",
            "This session has sent 20 messages in the last hour",
            "Wait, or put the rest in one message.",
        )),
    };
    let id = message.id.clone();
    Ok(CommandOutcome::changed(
        serde_json::json!(message),
        StateChange::new("agent_message", id, "added"),
    ))
}

fn companion_send(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    const FALLBACK: &str = "Give your result in the terminal instead.";
    let Caller::Agent {
        tile_id,
        workstream_id,
        process_key,
    } = context.caller()?
    else {
        return Err(AgentError::new(
            "NOT_A_SESSION",
            "Only a Copilot session can send to the phone",
            FALLBACK,
        ));
    };
    if !crate::companion_messages::companion_enabled(context.db).map_err(companion_store_error)? {
        return Err(AgentError::new(
            "COMPANION_OFF",
            "The phone companion is off, so nothing was sent",
            FALLBACK,
        ));
    }
    // Terminal tiles get a token too: only a Copilot session tile of the
    // caller's own workstream may message the phone.
    let tile: Option<(String, String)> = context
        .db
        .query_row(
            "SELECT workstream_id, tile_type FROM tiles WHERE id = ?1",
            [tile_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| companion_store_error(e.to_string()))?;
    if !matches!(&tile, Some((ws, kind)) if ws == workstream_id && kind == "copilot_session") {
        return Err(AgentError::new(
            "NOT_A_SESSION",
            "Only a Copilot session tile can send to the phone",
            FALLBACK,
        ));
    }
    if crate::companion_messages::is_barred(context.db, tile_id, process_key)
        .map_err(companion_store_error)?
    {
        return Err(AgentError::new(
            "SESSION_RELINKED",
            "This tile was linked to another Copilot session, so this session can no longer send to the phone",
            FALLBACK,
        ));
    }
    let kind = required_str(params, "kind")?;
    let text = params
        .get("text")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    crate::companion_messages::check_message(&kind, &text).map_err(|error| {
        AgentError::new(
            "BAD_MESSAGE",
            error,
            "Send kind=progress or kind=result with a non-empty text of at most 20000 characters.",
        )
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    // Any session may message the phone (ADR 044): a laptop tile's first
    // message opens its thread, which the phone can then message back. The
    // cap is checked and counted in the same transaction as the send.
    use crate::companion_messages::{send_from_agent, SendRefusal};
    send_from_agent(context.db, tile_id, workstream_id, &id, &kind, &text, at).map_err(
        |refusal| match refusal {
            SendRefusal::RateLimited(cap) => AgentError::new(
                "RATE_LIMITED",
                format!("This session has sent {cap} messages to your phone in the last hour"),
                "Wait, or put the rest in one message; give anything urgent in the terminal.",
            ),
            SendRefusal::Store(error) => companion_store_error(error),
        },
    )?;
    Ok(CommandOutcome::changed(
        serde_json::json!({ "id": id, "kind": kind, "sent": true }),
        StateChange::new("companion_message", tile_id.clone(), "added"),
    ))
}

// ── Periodic schedules (ADR 044) ────────────────────────────────────

fn schedule_error(error: String) -> AgentError {
    AgentError::new(
        "BAD_SCHEDULE",
        error,
        "Use frequency=hourly|every:<N>h|every:<N>m|daily:HH:MM|weekly:<day>:HH:MM, at least 5 minutes apart, on a Copilot session tile without a schedule.",
    )
}

fn schedule_store_error(error: String) -> AgentError {
    AgentError::new(
        "STORE_ERROR",
        error,
        "Try again; if it keeps failing, ask the human.",
    )
}

fn optional_bool(params: &serde_json::Value, key: &str) -> Result<bool, AgentError> {
    if params.get(key).is_none() {
        return Ok(false);
    }
    inbox_bool(params, key)
}

/// A schedule with its tile's and workstream's names, for an agent reading it.
fn schedule_view(
    db: &Connection,
    schedule: &crate::periodic_schedules::Schedule,
) -> serde_json::Value {
    let names: (Option<String>, Option<String>) = db
        .query_row(
            "SELECT (SELECT title FROM tiles WHERE id = ?1), (SELECT name FROM workstreams WHERE id = ?2)",
            [&schedule.tile_id, &schedule.workstream_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap_or((None, None));
    let mut value = serde_json::json!(schedule);
    value["tile_title"] = serde_json::json!(names.0);
    value["workstream_name"] = serde_json::json!(names.1);
    value
}

/// The schedule named by `id` or `tile`, once the caller may act on its workstream.
fn schedule_target(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<crate::periodic_schedules::Schedule, AgentError> {
    let found = if let Some(id) = optional_str(params, "id") {
        crate::periodic_schedules::get(context.db, &id)
    } else if let Some(tile) = optional_str(params, "tile") {
        crate::periodic_schedules::for_tile(context.db, &tile)
    } else {
        return Err(AgentError::new(
            "MISSING_PARAM",
            "Missing required parameter: id",
            "Add id=<schedule id> (see schedule.list), or tile=<tile id>.",
        ));
    }
    .map_err(schedule_store_error)?
    .ok_or_else(|| {
        AgentError::new(
            "NO_SUCH_SCHEDULE",
            "No such schedule",
            "Use schedule.list to see the schedules.",
        )
    })?;
    may_act_on(context.db, context.caller()?, &found.workstream_id)?;
    Ok(found)
}

/// Run now and Resume wait for the workstream to be unarchived.
fn refuse_archived(
    context: &CommandContext,
    schedule: &crate::periodic_schedules::Schedule,
) -> Result<(), AgentError> {
    let status: Option<String> = context
        .db
        .query_row(
            "SELECT status FROM workstreams WHERE id = ?1",
            [&schedule.workstream_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| schedule_store_error(e.to_string()))?;
    if matches!(status.as_deref(), Some("archived" | "archiving")) {
        return Err(AgentError::new(
            "WORKSTREAM_ARCHIVED",
            "This schedule's workstream is archived",
            "Unarchive the workstream first; its schedules stay paused until resumed.",
        ));
    }
    Ok(())
}

fn schedule_create(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let Caller::Agent { tile_id: own, .. } = caller else {
        return Err(AgentError::new(
            "NOT_A_SESSION",
            "Only a Copilot session in Workstreams can create a schedule here",
            "Use \"Run periodically…\" in the tile's menu.",
        ));
    };
    let prompt = required_str(params, "prompt")?;
    let frequency_text = required_str(params, "frequency")?;
    let notify_inbox = optional_bool(params, "notify_inbox")?;
    let notify_phone = optional_bool(params, "notify_phone")?;
    let tile = optional_str(params, "tile").unwrap_or_else(|| own.clone());
    let workstream: Option<String> = context
        .db
        .query_row(
            "SELECT workstream_id FROM tiles WHERE id = ?1",
            [&tile],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| schedule_store_error(e.to_string()))?;
    let workstream = workstream.ok_or_else(|| {
        AgentError::new(
            "NO_SUCH_TILE",
            format!("No tile {tile}"),
            "Leave tile out to schedule your own session, or name a session tile in your workstream.",
        )
    })?;
    may_act_on(context.db, caller, &workstream)?;
    let frequency =
        crate::periodic_schedules::parse_frequency(&frequency_text).map_err(schedule_error)?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let schedule = crate::periodic_schedules::create(
        context.db,
        &crate::periodic_schedules::NewSchedule {
            tile_id: &tile,
            workstream_id: &workstream,
            prompt: &prompt,
            frequency: &frequency,
            notify_inbox,
            notify_phone,
            next_run_at: None,
            created_at,
        },
    )
    .map_err(schedule_error)?;
    let id = schedule.id.clone();
    Ok(CommandOutcome::changed(
        schedule_view(context.db, &schedule),
        StateChange::new("schedule", id, "created"),
    ))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn schedule_list(
    context: &CommandContext,
    _: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let caller = context.caller()?;
    let schedules = crate::periodic_schedules::list(context.db).map_err(schedule_store_error)?;
    // Only schedules the caller may act on: another workstream's prompts are not its business.
    let views: Vec<_> = schedules
        .iter()
        .filter(|schedule| may_act_on(context.db, caller, &schedule.workstream_id).is_ok())
        .map(|schedule| schedule_view(context.db, schedule))
        .collect();
    Ok(CommandOutcome::read(
        serde_json::json!({ "schedules": views }),
    ))
}

fn schedule_patch(
    context: &CommandContext,
    params: &serde_json::Value,
    patch: serde_json::Value,
    action: &str,
) -> Result<CommandOutcome, AgentError> {
    let target = schedule_target(context, params)?;
    if action == "run" || action == "resumed" {
        refuse_archived(context, &target)?;
    }
    let updated = crate::periodic_schedules::update(context.db, &target.id, &patch)
        .map_err(schedule_store_error)?;
    Ok(CommandOutcome::changed(
        schedule_view(context.db, &updated),
        StateChange::new("schedule", target.id, action),
    ))
}

fn schedule_run(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    // The app's runner picks the request up at once (state-changed) and runs it.
    schedule_patch(
        context,
        params,
        serde_json::json!({"run_requested": true, "run_requested_at": now_ms()}),
        "run",
    )
}

fn schedule_pause(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    schedule_patch(
        context,
        params,
        serde_json::json!({"paused": true}),
        "paused",
    )
}

fn schedule_resume(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    // next_run_at NULL: the app plans the next run from now, as for a new schedule.
    schedule_patch(
        context,
        params,
        serde_json::json!({"paused": false, "failures": 0, "next_run_at": null}),
        "resumed",
    )
}

fn schedule_delete(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let target = schedule_target(context, params)?;
    crate::periodic_schedules::delete(context.db, &target.id).map_err(schedule_store_error)?;
    Ok(CommandOutcome::changed(
        serde_json::json!({ "id": target.id, "deleted": true }),
        StateChange::new("schedule", target.id, "deleted"),
    ))
}

/// The caller's own workstream: diagram commands never reach another one.
fn own_workstream(context: &CommandContext) -> Result<String, AgentError> {
    let caller = context.caller()?;
    caller.workstream_id().map(str::to_string).ok_or_else(|| {
        AgentError::new(
            "NO_WORKSTREAM",
            "Only a session tile of a workstream can use its diagrams",
            "Run this from the workstream's Copilot session.",
        )
    })
}

fn diagram_error(message: String) -> AgentError {
    AgentError::new(
        "DIAGRAM",
        message,
        "Run diagram.list for this workstream's boards.",
    )
}

fn own_board(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<crate::diagrams::BoardRef, AgentError> {
    let workstream_id = own_workstream(context)?;
    let board = required_str(params, "board")?;
    crate::diagrams::find_board(context.db, &workstream_id, &board).map_err(diagram_error)
}

fn diagram_list(
    context: &CommandContext,
    _params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let workstream_id = own_workstream(context)?;
    let boards =
        crate::diagrams::workstream_boards(context.db, &workstream_id).map_err(diagram_error)?;
    let mut out = Vec::new();
    for b in boards {
        let board = crate::diagrams::get_board(context.db, &b.id).map_err(diagram_error)?;
        let summary =
            crate::diagrams::summarize(board.map(|x| x.scene_json).as_deref().unwrap_or("{}"));
        let additions = crate::diagrams::additions(context.db, &b.id).map_err(diagram_error)?;
        out.push(serde_json::json!({
            "id": b.id,
            "name": b.name,
            "tile_id": b.tile_id,
            "tile_title": b.tile_title,
            "shapes": summary.shapes.len(),
            "connections": summary.connections.len(),
            "pending_additions": additions.iter().filter(|a| a.status == "pending").count(),
        }));
    }
    Ok(CommandOutcome::read(serde_json::json!({ "boards": out })))
}

fn diagram_get(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let b = own_board(context, params)?;
    let board = crate::diagrams::get_board(context.db, &b.id)
        .map_err(diagram_error)?
        .ok_or_else(|| diagram_error(format!("No board {}", b.id)))?;
    let summary = crate::diagrams::summarize(&board.scene_json);
    let additions = crate::diagrams::additions(context.db, &b.id).map_err(diagram_error)?;
    let pending = additions.iter().filter(|a| a.status == "pending").count();
    let failed: Vec<_> = additions
        .iter()
        .filter(|a| a.status == "failed")
        .cloned()
        .collect();
    Ok(CommandOutcome::read(serde_json::json!({
        "id": board.id,
        "name": board.name,
        "text": crate::diagrams::summary_text(&board.name, &summary, pending, &failed),
        "shapes": summary.shapes,
        "connections": summary.connections,
        "images": summary.images,
        "pending_additions": pending,
        "failed_additions": failed,
    })))
}

fn diagram_add(
    context: &CommandContext,
    params: &serde_json::Value,
) -> Result<CommandOutcome, AgentError> {
    let b = own_board(context, params)?;
    let mermaid = required_str(params, "mermaid")?;
    let id = uuid::Uuid::new_v4().to_string();
    let addition = crate::diagrams::queue_addition(context.db, &id, &b.id, &mermaid, &crate::now())
        .map_err(|e| {
            AgentError::new(
                "BAD_MERMAID",
                e,
                "Send the diagram text as mermaid=@- on stdin.",
            )
        })?;
    Ok(CommandOutcome::changed(
        serde_json::json!({
            "addition_id": addition.id,
            "board": b.id,
            "status": "pending",
            "note": "Drawn when the board's Diagram tile is open; diagram.get shows it pending until then, or the parse error if the Mermaid is invalid.",
        }),
        StateChange::new("diagram", b.id, "addition_queued"),
    ))
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

    /// Resolves any well-formed pipeline link without ADO: a run id N belongs
    /// to pipeline N / 1000, named "pipeline-<id>".
    struct FakeResolver;
    impl crate::pipeline_inbox::PipelineResolver for FakeResolver {
        fn resolve(&self, link: &str) -> Result<crate::pipeline_inbox::ResolvedPipeline, String> {
            use crate::pipeline_inbox::LinkTarget;
            let link = crate::pipeline_inbox::parse_link(link)?;
            let definition_id = match link.target {
                LinkTarget::Definition(id) => id,
                LinkTarget::Run(run) => run / 1000,
            };
            Ok(crate::pipeline_inbox::ResolvedPipeline {
                repository: Some(crate::pipeline_inbox::AdoRepoRef {
                    id: format!("repo-{definition_id}-guid"),
                    kind: "azure".into(),
                    organization: link.organization.clone(),
                    project: link.project.clone(),
                    name: format!("repo-{definition_id}"),
                }),
                organization: link.organization,
                project_id: "guid".into(),
                project_name: link.project,
                definition_id,
                name: format!("pipeline-{definition_id}"),
                default_branch: None,
            })
        }
    }

    /// A tiny ADO: sprint S22 (current) and S23, feature 100 with stories 1
    /// (mine, Closed, 1 SP), 2 (mine, New, 3 SP in S22) and 3 (unassigned, 5 SP).
    struct FakePlanning;
    impl crate::ado_planning::PlanningGateway for FakePlanning {
        fn connect(&self, link: &str) -> Result<crate::ado_planning::PlanningConnection, String> {
            let l = crate::ado_planning::parse_team_link(link)?;
            Ok(crate::ado_planning::PlanningConnection {
                organization: l.organization,
                project: l.project,
                team: l.team,
                team_id: "t".into(),
                area_path: "P\\A".into(),
                backlog_iteration: "P\\CY26".into(),
                order_field: "Microsoft.VSTS.Common.StackRank".into(),
                effort_field: "Microsoft.VSTS.Scheduling.StoryPoints".into(),
            })
        }
        fn fetch(
            &self,
            conn: &crate::ado_planning::PlanningConnection,
            selected: Option<&str>,
        ) -> Result<crate::ado_planning::PlanningData, String> {
            use crate::ado_planning::{Iteration, Me, PlanItem, PlanningData};
            let item = |id: i64,
                        kind: &str,
                        state: &str,
                        mine: bool,
                        iteration: &str,
                        points: Option<f64>,
                        parent: Option<i64>| PlanItem {
                id,
                rev: 1,
                kind: kind.into(),
                title: format!("item {id}"),
                state: state.into(),
                assigned_to: mine.then(|| "Me".to_string()),
                assigned_to_me: mine,
                iteration_path: iteration.into(),
                story_points: points,
                order: None,
                target_date: (kind == "Feature").then(|| "2026-11-22".to_string()),
                parent_id: parent,
                tasks_done: 0,
                tasks_total: 0,
                url: format!("u/{id}"),
                tasks: Vec::new(),
            };
            let task = |id: i64, state: &str, mine: bool| crate::ado_planning::PlanTask {
                id,
                rev: 4,
                title: format!("task {id}"),
                state: state.into(),
                assigned_to: Some(if mine { "Me" } else { "Erwin" }.into()),
                assigned_to_me: mine,
                order: None,
                url: format!("u/{id}"),
            };
            let iterations = vec![
                Iteration {
                    name: "S22".into(),
                    path: "P\\S22".into(),
                    start: Some("2026-10-26".into()),
                    finish: Some("2026-11-08".into()),
                    timeframe: "current".into(),
                },
                Iteration {
                    name: "S23".into(),
                    path: "P\\S23".into(),
                    start: Some("2026-11-09".into()),
                    finish: Some("2026-11-22".into()),
                    timeframe: "future".into(),
                },
            ];
            Ok(PlanningData {
                connection: conn.clone(),
                me: Me {
                    id: "me".into(),
                    display_name: "Me".into(),
                    unique_name: "me@x.com".into(),
                },
                selected_sprint: selected.unwrap_or("P\\S22").into(),
                previous_sprint: None,
                iterations,
                items: vec![
                    item(100, "Feature", "Active", true, "P\\Q4", None, None),
                    item(
                        1,
                        "User Story",
                        "Closed",
                        true,
                        "P\\S22",
                        Some(1.0),
                        Some(100),
                    ),
                    PlanItem {
                        tasks: vec![task(20, "Active", true), task(21, "Closed", false)],
                        ..item(2, "User Story", "New", true, "P\\S22", Some(3.0), Some(100))
                    },
                    PlanItem {
                        tasks: vec![task(30, "New", true)],
                        ..item(3, "User Story", "New", false, "P\\Q4", Some(5.0), Some(100))
                    },
                    // A teammate's story in the sprint: its tasks can be link targets.
                    PlanItem {
                        tasks: vec![task(50, "Active", false)],
                        ..item(5, "User Story", "Active", false, "P\\S22", Some(2.0), None)
                    },
                ],
            })
        }
        fn publish(
            &self,
            _: &crate::ado_planning::PlanningData,
            draft: &[crate::ado_planning::Change],
        ) -> Result<crate::ado_planning::PublishResult, String> {
            use crate::ado_planning::{Change, Conflict, PublishResult};
            let mut result = PublishResult::default();
            for c in draft {
                match c {
                    Change::Move { id: 3, .. } => {
                        result.conflicts.push(Conflict {
                            id: 3,
                            title: "item 3".into(),
                            field: "System.IterationPath".into(),
                            ado_value: "P\\S24".into(),
                        });
                        result.remaining.push(c.clone());
                    }
                    Change::Move { id, .. } | Change::Estimate { id, .. } => {
                        result.written.push(*id)
                    }
                    Change::CreateStory { .. } => result.written.push(9001),
                    _ => {}
                }
            }
            Ok(result)
        }
        /// Feature 4533022 is the open KTLO feature, 4533000 last semester's
        /// (Closed); anything else is a User Story.
        fn ktlo(
            &self,
            conn: &crate::ado_planning::PlanningConnection,
            id: i64,
        ) -> Result<crate::ado_planning::KtloFeature, String> {
            let (state, problem) = match id {
                4533022 => ("Active", None),
                4533000 => (
                    "Closed",
                    Some("This KTLO feature is Closed — set this semester's.".to_string()),
                ),
                _ => (
                    "New",
                    Some(format!("#{id} is a User Story, not a Feature.")),
                ),
            };
            Ok(crate::ado_planning::KtloFeature {
                id,
                title: format!("KTLO {id}"),
                state: state.into(),
                url: format!(
                    "https://dev.azure.com/{}/{}/_workitems/edit/{id}",
                    conn.organization, conn.project
                ),
                problem,
            })
        }
        fn check_ktlo(
            &self,
            conn: &crate::ado_planning::PlanningConnection,
            link: &str,
        ) -> Result<crate::ado_planning::KtloFeature, String> {
            let link = crate::ado_planning::parse_work_item_link(link)?;
            let feature = self.ktlo(conn, link.id)?;
            match feature.problem.clone() {
                Some(p) => Err(p),
                None => Ok(feature),
            }
        }
        fn orphans(&self, _: &str, days: u32) -> Result<Vec<crate::orphan_prs::OrphanPr>, String> {
            let pr = |id: i64, repo: &str| crate::orphan_prs::OrphanPr {
                id,
                title: format!("PR {id}"),
                project: "SCC".into(),
                project_id: "scc-id".into(),
                repo: format!("SCC/{repo}"),
                repo_id: format!("{repo}-id"),
                state: "completed".into(),
                created: "2026-10-29T10:00:00Z".into(),
                url: format!("u/pr/{id}"),
            };
            Ok(if days >= 30 {
                vec![
                    pr(70, "engaine"),
                    pr(71, "engaine"),
                    pr(72, "media_components"),
                ]
            } else {
                vec![pr(70, "engaine")]
            })
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
                pipelines: Some(&FakeResolver),
                planning: Some(&FakePlanning),
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
            process_key: process_key(tile),
        }
    }

    fn schedule_db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::init_db(&db).unwrap();
        db.execute_batch(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'Courses', 'x', 'x'), ('w2', 'Infra', 'x', 'x');
             INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at) VALUES
               ('me', 'w1', 'copilot_session', 'Videos', '{}', 'x', 'x'),
               ('other', 'w1', 'copilot_session', 'Digest', '{}', 'x', 'x'),
               ('term', 'w1', 'terminal', 'Shell', '{}', 'x', 'x'),
               ('far', 'w2', 'copilot_session', 'CI', '{}', 'x', 'x');",
        )
        .unwrap();
        db
    }

    #[test]
    fn schedule_create_stores_a_schedule_for_the_callers_tile_or_another_in_its_workstream() {
        let db = schedule_db();
        let me = agent("me", "w1");
        let created = call(
            &db,
            &me,
            "schedule.create",
            serde_json::json!({"prompt":"Check videos","frequency":"daily:09:00"}),
        )
        .unwrap();
        assert_eq!(created.data["tile_id"], "me");
        assert_eq!(created.data["frequency"]["kind"], "daily");
        assert_eq!(created.data["notify_inbox"], false);
        assert!(
            created.data["next_run_at"].is_null(),
            "the app plans the first run"
        );
        assert_eq!(created.change.as_ref().unwrap().entity, "schedule");
        let other = call(
            &db,
            &me,
            "schedule.create",
            serde_json::json!({"tile":"other","prompt":"Digest","frequency":"every:2h","notify_phone":"true"}),
        )
        .unwrap();
        assert_eq!(other.data["frequency"]["minutes"], 120);
        assert_eq!(other.data["notify_phone"], true);
        let listed = call(&db, &me, "schedule.list", serde_json::json!({})).unwrap();
        let rows = listed.data["schedules"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["workstream_name"], "Courses");
        assert_eq!(rows[0]["tile_title"], "Videos");
        let again = call(
            &db,
            &me,
            "schedule.create",
            serde_json::json!({"prompt":"x","frequency":"hourly"}),
        )
        .unwrap_err();
        assert_eq!(again.code, "BAD_SCHEDULE");
        assert!(again.message.contains("already has a schedule"));
    }

    #[test]
    fn schedule_create_refuses_under_five_minutes_and_stores_nothing() {
        let db = schedule_db();
        let error = call(
            &db,
            &agent("me", "w1"),
            "schedule.create",
            serde_json::json!({"prompt":"x","frequency":"every:1m"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "BAD_SCHEDULE");
        assert!(error.message.contains("5 minutes"), "{}", error.message);
        for params in [
            serde_json::json!({"prompt":"x","frequency":"often"}),
            serde_json::json!({"prompt":"x","frequency":"hourly","tile":"term"}),
            serde_json::json!({"prompt":"x","frequency":"hourly","notify_inbox":"maybe"}),
        ] {
            assert!(call(&db, &agent("me", "w1"), "schedule.create", params).is_err());
        }
        assert_eq!(
            call(
                &db,
                &agent("me", "w1"),
                "schedule.create",
                serde_json::json!({"frequency":"hourly"})
            )
            .unwrap_err()
            .code,
            "MISSING_PARAM"
        );
        assert!(crate::periodic_schedules::list(&db).unwrap().is_empty());
    }

    #[test]
    fn schedule_commands_stay_in_the_callers_workstreams() {
        let db = schedule_db();
        let error = call(
            &db,
            &agent("me", "w1"),
            "schedule.create",
            serde_json::json!({"tile":"far","prompt":"x","frequency":"hourly"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "OUT_OF_SCOPE");
        let theirs = call(
            &db,
            &agent("far", "w2"),
            "schedule.create",
            serde_json::json!({"prompt":"x","frequency":"hourly"}),
        )
        .unwrap();
        let id = theirs.data["id"].as_str().unwrap().to_string();
        for cmd in [
            "schedule.run",
            "schedule.pause",
            "schedule.resume",
            "schedule.delete",
        ] {
            assert_eq!(
                call(&db, &agent("me", "w1"), cmd, serde_json::json!({"id": id}))
                    .unwrap_err()
                    .code,
                "OUT_OF_SCOPE",
                "{cmd}"
            );
        }
        assert_eq!(
            call(
                &db,
                &agent("me", "w1"),
                "schedule.run",
                serde_json::json!({"id":"nope"})
            )
            .unwrap_err()
            .code,
            "NO_SUCH_SCHEDULE"
        );
        assert_eq!(
            call(
                &db,
                &agent("me", "w1"),
                "schedule.create",
                serde_json::json!({"tile":"nope","prompt":"x","frequency":"hourly"})
            )
            .unwrap_err()
            .code,
            "NO_SUCH_TILE"
        );
    }

    #[test]
    fn schedule_list_shows_only_the_callers_workstreams() {
        let db = schedule_db();
        call(
            &db,
            &agent("me", "w1"),
            "schedule.create",
            serde_json::json!({"prompt":"mine","frequency":"hourly"}),
        )
        .unwrap();
        call(
            &db,
            &agent("far", "w2"),
            "schedule.create",
            serde_json::json!({"prompt":"secret plan","frequency":"hourly"}),
        )
        .unwrap();
        let listed = call(
            &db,
            &agent("me", "w1"),
            "schedule.list",
            serde_json::json!({}),
        )
        .unwrap();
        let prompts: Vec<_> = listed.data["schedules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["prompt"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(prompts, vec!["mine"]);
    }

    #[test]
    fn schedule_run_and_resume_are_refused_for_an_archived_workstream_and_run_is_timestamped() {
        let db = schedule_db();
        let me = agent("me", "w1");
        let created = call(
            &db,
            &me,
            "schedule.create",
            serde_json::json!({"prompt":"x","frequency":"hourly"}),
        )
        .unwrap();
        let id = created.data["id"].as_str().unwrap().to_string();
        let ran = call(&db, &me, "schedule.run", serde_json::json!({"id": id})).unwrap();
        assert!(ran.data["run_requested_at"].as_i64().unwrap() > 1_700_000_000_000);
        db.execute(
            "UPDATE workstreams SET status = 'archived' WHERE id = 'w1'",
            [],
        )
        .unwrap();
        for cmd in ["schedule.run", "schedule.resume"] {
            assert_eq!(
                call(&db, &me, cmd, serde_json::json!({"id": id}))
                    .unwrap_err()
                    .code,
                "WORKSTREAM_ARCHIVED",
                "{cmd}"
            );
        }
        // Pausing and deleting stay possible.
        call(&db, &me, "schedule.pause", serde_json::json!({"id": id})).unwrap();
    }

    #[test]
    fn schedule_controls_ask_for_a_run_pause_resume_and_delete() {
        let db = schedule_db();
        let me = agent("me", "w1");
        let created = call(
            &db,
            &me,
            "schedule.create",
            serde_json::json!({"prompt":"x","frequency":"hourly"}),
        )
        .unwrap();
        let id = created.data["id"].as_str().unwrap().to_string();
        let ran = call(&db, &me, "schedule.run", serde_json::json!({"id": id})).unwrap();
        assert_eq!(ran.data["run_requested"], true);
        assert_eq!(
            ran.change,
            Some(StateChange::new("schedule", id.clone(), "run"))
        );
        crate::periodic_schedules::update(
            &db,
            &id,
            &serde_json::json!({"failures":3,"next_run_at":5}),
        )
        .unwrap();
        let paused = call(&db, &me, "schedule.pause", serde_json::json!({"id": id})).unwrap();
        assert_eq!(paused.data["paused"], true);
        // By tile too.
        let resumed = call(
            &db,
            &me,
            "schedule.resume",
            serde_json::json!({"tile":"me"}),
        )
        .unwrap();
        assert_eq!(resumed.data["paused"], false);
        assert_eq!(resumed.data["failures"], 0);
        assert!(
            resumed.data["next_run_at"].is_null(),
            "re-planned by the app from now"
        );
        call(&db, &me, "schedule.delete", serde_json::json!({"id": id})).unwrap();
        assert!(crate::periodic_schedules::list(&db).unwrap().is_empty());
        let tiles: i64 = db
            .query_row("SELECT COUNT(*) FROM tiles WHERE id = 'me'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(tiles, 1, "the tile stays");
        assert_eq!(
            call(&db, &me, "schedule.pause", serde_json::json!({}))
                .unwrap_err()
                .code,
            "MISSING_PARAM"
        );
    }

    fn phone_session_db(enabled: bool) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        db.execute(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w1', 'W', 'x', 'x')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO settings (key, value) VALUES ('companion.enabled', ?1)",
            [if enabled { "1" } else { "0" }],
        )
        .unwrap();
        db.execute_batch(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w2', 'Other', 'x', 'x');
             INSERT INTO tiles (id, workstream_id, tile_type, title, config_json, created_at, updated_at) VALUES
               ('phone-tile', 'w1', 'copilot_session', 'Phone', '{}', 'x', 'x'),
               ('laptop-tile', 'w1', 'copilot_session', 'Laptop', '{}', 'x', 'x'),
               ('term', 'w1', 'terminal', 'Shell', '{}', 'x', 'x'),
               ('elsewhere', 'w2', 'copilot_session', 'Elsewhere', '{}', 'x', 'x');",
        )
        .unwrap();
        crate::companion_messages::record_session(&db, "phone-tile", "w1", "r1", "Do x", 1)
            .unwrap();
        db
    }

    /// The tile is re-linked as the app does it: under the DB lock, revoking
    /// its thread and barring the processes running now.
    fn relink(db: &Connection, tile: &str) {
        crate::companion_messages::revoke_tile(db, tile, &[process_key(tile)]).unwrap();
    }

    fn process_key(tile: &str) -> String {
        format!("proc-{tile}")
    }

    #[test]
    fn companion_send_refuses_a_terminal_tile_or_a_tile_outside_the_callers_workstream() {
        let db = phone_session_db(true);
        for caller in [
            agent("term", "w1"),
            agent("elsewhere", "w1"),
            agent("gone", "w1"),
        ] {
            let error = call(
                &db,
                &caller,
                "companion.send",
                serde_json::json!({"kind":"result","text":"x"}),
            )
            .unwrap_err();
            assert_eq!(error.code, "NOT_A_SESSION");
        }
        let threads: Vec<_> = crate::companion_messages::list(&db)
            .unwrap()
            .into_iter()
            .map(|s| s.tile_id)
            .collect();
        assert_eq!(threads, vec!["phone-tile"]);
    }

    #[test]
    fn companion_send_refuses_the_old_process_of_a_relinked_tile() {
        let db = phone_session_db(true);
        for tile in ["phone-tile", "laptop-tile"] {
            // The caller (token) was resolved before the re-link landed: the
            // permission is decided under the lock, at send time.
            let resolved_earlier = agent(tile, "w1");
            relink(&db, tile);
            let error = call(
                &db,
                &resolved_earlier,
                "companion.send",
                serde_json::json!({"kind":"result","text":"from the old session"}),
            )
            .unwrap_err();
            assert_eq!(error.code, "SESSION_RELINKED", "{tile}");
        }
        let sessions = crate::companion_messages::list(&db).unwrap();
        assert_eq!(sessions.len(), 1, "no thread opened for the laptop tile");
        assert!(!sessions[0].can_send && sessions[0].messages.is_empty());
    }

    #[test]
    fn the_phone_cap_survives_a_thread_being_replaced() {
        let db = phone_session_db(true);
        for i in 0..20 {
            call(
                &db,
                &agent("phone-tile", "w1"),
                "companion.send",
                serde_json::json!({"kind":"progress","text":format!("m{i}")}),
            )
            .unwrap();
        }
        // Re-linked, then a fresh process: the thread is replaced, the count is not.
        crate::companion_messages::revoke(&db, "phone-tile").unwrap();
        let error = call(
            &db,
            &agent("phone-tile", "w1"),
            "companion.send",
            serde_json::json!({"kind":"result","text":"x"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "RATE_LIMITED");
        crate::companion_messages::prune(&db, i64::MAX / 2, 0).unwrap();
        assert_eq!(
            crate::companion_messages::sent_last_hour(&db, "phone-tile", now_ms()).unwrap(),
            20
        );
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    #[test]
    fn each_token_names_its_own_process_and_only_the_current_ones_are_listed() {
        let registry = IdentityRegistry::new();
        let old = registry.issue("tile-1", "ws");
        let Caller::Agent {
            process_key: old_key,
            ..
        } = registry.resolve(Some(&old)).unwrap()
        else {
            unreachable!()
        };
        let fresh = registry.issue("tile-1", "ws");
        let Caller::Agent { process_key, .. } = registry.resolve(Some(&fresh)).unwrap() else {
            unreachable!()
        };
        assert_ne!(process_key, old_key);
        assert_eq!(registry.process_keys("tile-1"), vec![process_key]);
        assert!(registry.process_keys("nobody").is_empty());
    }

    #[test]
    fn a_new_process_after_a_relink_may_message_the_phone_and_a_rollback_never_bars_one() {
        let db = phone_session_db(true);
        relink(&db, "phone-tile");
        let respawned = Caller::Agent {
            tile_id: "phone-tile".into(),
            workstream_id: "w1".into(),
            process_key: "proc-new".into(),
        };
        call(
            &db,
            &respawned,
            "companion.send",
            serde_json::json!({"kind":"result","text":"new"}),
        )
        .unwrap();
        // A delayed rollback of an older claim touches neither the thread nor the process.
        assert!(!crate::companion_messages::revoke_claim(&db, "phone-tile", "r1").unwrap());
        call(
            &db,
            &respawned,
            "companion.send",
            serde_json::json!({"kind":"result","text":"again"}),
        )
        .unwrap();
    }

    #[test]
    fn companion_send_stores_a_message_for_the_calling_phone_session() {
        let db = phone_session_db(true);
        let sent = call(
            &db,
            &agent("phone-tile", "w1"),
            "companion.send",
            serde_json::json!({"kind":"result","text":"# Done\n- a"}),
        )
        .unwrap();
        assert_eq!(sent.data["sent"], true);
        assert_eq!(
            sent.change,
            Some(StateChange::new("companion_message", "phone-tile", "added"))
        );
        let sessions = crate::companion_messages::list(&db).unwrap();
        assert_eq!(sessions[0].messages[0].text, "# Done\n- a");
        assert_eq!(sessions[0].messages[0].kind, "result");
    }

    #[test]
    fn learning_check_queues_a_job_and_learning_jobs_reports_it() {
        let db = memory_db();
        let caller = agent("t1", "w1");
        let request = serde_json::json!({
            "card_id": "even", "card_version": "2",
            "harness": {"cases": [{"name": "even_numbers", "body": "assert!(is_even(2));"}]},
            "source": "pub fn is_even(n: i32) -> bool { n % 2 == 0 }"
        });
        let queued = call(
            &db,
            &caller,
            "learning.check",
            serde_json::json!({"request": request.to_string()}),
        )
        .unwrap();
        let id = queued.data["id"].as_str().unwrap().to_string();
        assert_eq!(queued.data["status"], "queued");
        assert_eq!(queued.data["card_version"], "2");

        let one = call(&db, &caller, "learning.jobs", serde_json::json!({"id": id})).unwrap();
        assert_eq!(one.data["id"], id);
        let all = call(&db, &caller, "learning.jobs", serde_json::json!({})).unwrap();
        assert_eq!(all.data["jobs"].as_array().unwrap().len(), 1);

        let bad = call(
            &db,
            &caller,
            "learning.check",
            serde_json::json!({"request": "{\"source\": 1}"}),
        )
        .unwrap_err();
        assert_eq!(bad.code, "BAD_REQUEST");
        let missing = call(
            &db,
            &caller,
            "learning.jobs",
            serde_json::json!({"id": "nope"}),
        )
        .unwrap_err();
        assert_eq!(missing.code, "NOT_FOUND");
    }

    #[test]
    fn learning_pack_queues_a_pack_job() {
        let db = memory_db();
        let caller = agent("t1", "w1");
        let queued = call(
            &db,
            &caller,
            "learning.pack",
            serde_json::json!({"request": "{\"topic\": \"Slices\"}"}),
        )
        .unwrap();
        assert_eq!(
            (&queued.data["kind"], &queued.data["card_id"]),
            (
                &serde_json::json!("pack"),
                &serde_json::json!("pack-slices")
            )
        );
        let bad = call(
            &db,
            &caller,
            "learning.pack",
            serde_json::json!({"request": "{\"topic\": 3}"}),
        )
        .unwrap_err();
        assert_eq!(bad.code, "BAD_REQUEST");
    }

    #[test]
    fn learning_help_queues_a_help_job() {
        let db = memory_db();
        let caller = agent("t1", "w1");
        let request = serde_json::json!({
            "id": "h1", "card_id": "borrow", "card_version": "1", "level": "hint",
            "exercise": {"prompt": "Borrow it"}, "source": "&name"
        });
        let queued = call(
            &db,
            &caller,
            "learning.help",
            serde_json::json!({"request": request.to_string()}),
        )
        .unwrap();
        assert_eq!(
            (
                &queued.data["id"],
                &queued.data["kind"],
                &queued.data["status"]
            ),
            (
                &serde_json::json!("h1"),
                &serde_json::json!("help"),
                &serde_json::json!("queued")
            )
        );
        let bad = call(
            &db,
            &caller,
            "learning.help",
            serde_json::json!({"request": "{\"level\": 1}"}),
        )
        .unwrap_err();
        assert_eq!(bad.code, "BAD_REQUEST");
    }

    #[test]
    fn inbox_message_posts_to_the_inbox_and_enforces_its_contract() {
        let db = memory_db();
        db.execute_batch(
            "PRAGMA foreign_keys = OFF;
            INSERT INTO workstreams (id, name, directory, created_at, updated_at) VALUES ('w1', 'Bench', '/b', 'now', 'now');",
        )
        .unwrap();
        let caller = agent("t1", "w1");
        let sent = call(
            &db,
            &caller,
            "inbox.message",
            serde_json::json!({"level":"done","title":"Benchmarks finished","body":"# p95\n- 38 → 21"}),
        )
        .unwrap();
        let id = sent.data["id"].as_str().unwrap().to_string();
        assert_eq!(sent.data["workstream_name"], "Bench");
        assert_eq!(
            sent.change,
            Some(StateChange::new("agent_message", &id, "added"))
        );
        let listed = call(&db, &caller, "inbox.list", serde_json::json!({})).unwrap();
        let message = &listed.data["agent_messages"][0];
        assert_eq!(
            (
                &message["id"],
                &message["title"],
                &message["level"],
                &message["is_read"]
            ),
            (
                &serde_json::json!(id),
                &serde_json::json!("Benchmarks finished"),
                &serde_json::json!("done"),
                &serde_json::json!(false)
            )
        );
        call(
            &db,
            &caller,
            "inbox.read",
            serde_json::json!({"id": id, "read": true}),
        )
        .unwrap();
        let listed = call(&db, &caller, "inbox.list", serde_json::json!({})).unwrap();
        assert_eq!(listed.data["agent_messages"][0]["is_read"], true);

        let refused = |params: serde_json::Value, who: &Caller| {
            call(&db, who, "inbox.message", params).unwrap_err()
        };
        let bad = refused(serde_json::json!({"level":"urgent","title":"t"}), &caller);
        assert_eq!(bad.code, "BAD_MESSAGE");
        assert!(bad.message.contains("info, done, needs-you, error"));
        assert!(refused(
            serde_json::json!({"level":"done","title":"x".repeat(121)}),
            &caller
        )
        .message
        .contains("120"));
        assert!(refused(serde_json::json!({"level":"done"}), &caller)
            .message
            .contains("title"));
        assert!(refused(
            serde_json::json!({"level":"done","title":"t","body":"x".repeat(20_001)}),
            &caller
        )
        .message
        .contains("20000"));
        assert_eq!(
            refused(
                serde_json::json!({"level":"done","title":"t"}),
                &Caller::Human
            )
            .code,
            "NOT_A_SESSION"
        );
        for _ in 0..19 {
            call(
                &db,
                &caller,
                "inbox.message",
                serde_json::json!({"level":"info","title":"t"}),
            )
            .unwrap();
        }
        assert_eq!(
            refused(serde_json::json!({"level":"info","title":"t"}), &caller).code,
            "RATE_LIMITED"
        );
    }

    #[test]
    fn companion_send_from_a_laptop_tile_opens_a_phone_thread_named_after_the_tile() {
        let db = phone_session_db(true);
        db.execute(
            "UPDATE tiles SET title = 'Summarise videos' WHERE id = 'laptop-tile'",
            [],
        )
        .unwrap();
        let sent = call(
            &db,
            &agent("laptop-tile", "w1"),
            "companion.send",
            serde_json::json!({"kind":"result","text":"3 new videos"}),
        )
        .unwrap();
        assert_eq!(sent.data["sent"], true);
        let sessions = crate::companion_messages::list(&db).unwrap();
        let thread = sessions
            .iter()
            .find(|s| s.tile_id == "laptop-tile")
            .expect("a thread for the laptop tile");
        assert_eq!(
            (
                thread.workstream_id.as_str(),
                thread.prompt.as_str(),
                thread.can_send
            ),
            ("w1", "Summarise videos", true)
        );
        assert_eq!(thread.messages.len(), 1);
        assert_eq!(thread.messages[0].text, "3 new videos");
        // The phone session is untouched, and the Inbox too.
        assert!(sessions
            .iter()
            .find(|s| s.tile_id == "phone-tile")
            .unwrap()
            .messages
            .is_empty());
        assert!(crate::inbox_messages::list(&db).unwrap().is_empty());
    }

    #[test]
    fn companion_send_caps_a_tile_at_20_phone_messages_an_hour_apart_from_the_inbox_cap() {
        let db = phone_session_db(true);
        let me = agent("phone-tile", "w1");
        // The Inbox's own cap is used up; the phone's is separate.
        for i in 0..20 {
            crate::inbox_messages::send(&db, "w1", "phone-tile", "info", &format!("i{i}"), "")
                .unwrap();
        }
        // What the phone sent (prompts) doesn't count.
        crate::companion_messages::add_prompt(&db, "phone-tile", "p1", "Do x", 1).unwrap();
        for i in 0..20 {
            call(
                &db,
                &me,
                "companion.send",
                serde_json::json!({"kind":"progress","text":format!("m{i}")}),
            )
            .unwrap();
        }
        for _ in 20..25 {
            let error = call(
                &db,
                &me,
                "companion.send",
                serde_json::json!({"kind":"result","text":"too many"}),
            )
            .unwrap_err();
            assert_eq!(error.code, "RATE_LIMITED");
            assert!(error.message.contains("20"), "{}", error.message);
        }
        let messages = &crate::companion_messages::list(&db).unwrap()[0].messages;
        assert_eq!(
            messages.len(),
            21,
            "20 sent plus the prompt; refused ones add nothing"
        );
    }

    #[test]
    fn companion_send_refuses_while_the_companion_is_off_and_queues_nothing() {
        let db = phone_session_db(false);
        let error = call(
            &db,
            &agent("phone-tile", "w1"),
            "companion.send",
            serde_json::json!({"kind":"result","text":"x"}),
        )
        .unwrap_err();
        assert_eq!(error.code, "COMPANION_OFF");
        assert!(error.message.contains("phone companion is off"));
        db.execute(
            "UPDATE settings SET value = '1' WHERE key = 'companion.enabled'",
            [],
        )
        .unwrap();
        assert!(crate::companion_messages::list(&db).unwrap()[0]
            .messages
            .is_empty());
    }

    #[test]
    fn companion_send_refuses_bad_kinds_and_sizes() {
        let db = phone_session_db(true);
        let me = agent("phone-tile", "w1");
        for params in [
            serde_json::json!({"kind":"question","text":"x"}),
            serde_json::json!({"kind":"result","text":"x".repeat(20_001)}),
            serde_json::json!({"kind":"result"}),
        ] {
            assert_eq!(
                call(&db, &me, "companion.send", params).unwrap_err().code,
                "BAD_MESSAGE"
            );
        }
        assert_eq!(
            call(&db, &me, "companion.send", serde_json::json!({"text":"x"}))
                .unwrap_err()
                .code,
            "MISSING_PARAM"
        );
        call(
            &db,
            &me,
            "companion.send",
            serde_json::json!({"kind":"progress","text":"x".repeat(20_000)}),
        )
        .unwrap();
        assert_eq!(
            crate::companion_messages::list(&db).unwrap()[0]
                .messages
                .len(),
            1
        );
    }

    #[test]
    fn companion_send_from_a_relinked_tile_respawned_on_its_new_session_starts_a_fresh_thread() {
        let db = phone_session_db(true);
        crate::companion_messages::add_message(
            &db,
            "phone-tile",
            "old",
            "result",
            "old session",
            1,
        )
        .unwrap();
        crate::companion_messages::revoke(&db, "phone-tile").unwrap();
        call(
            &db,
            &agent("phone-tile", "w1"),
            "companion.send",
            serde_json::json!({"kind":"result","text":"new session"}),
        )
        .unwrap();
        let sessions = crate::companion_messages::list(&db).unwrap();
        assert!(sessions[0].can_send);
        assert_eq!(
            sessions[0]
                .messages
                .iter()
                .map(|m| m.text.as_str())
                .collect::<Vec<_>>(),
            vec!["new session"]
        );
    }

    #[test]
    fn companion_send_ignores_any_session_named_in_the_request() {
        let db = phone_session_db(true);
        call(
            &db,
            &agent("laptop-tile", "w1"),
            "companion.send",
            serde_json::json!({"kind":"result","text":"x","tile":"phone-tile","session":"phone-tile"}),
        )
        .unwrap();
        let sessions = crate::companion_messages::list(&db).unwrap();
        let phone = sessions.iter().find(|s| s.tile_id == "phone-tile").unwrap();
        assert!(phone.messages.is_empty(), "sent as the caller's own tile");
        assert_eq!(
            sessions
                .iter()
                .find(|s| s.tile_id == "laptop-tile")
                .unwrap()
                .messages
                .len(),
            1
        );
    }

    #[test]
    fn a_token_resolves_to_the_identity_the_app_issued_it_for() {
        let registry = IdentityRegistry::new();
        let token = registry.issue("tile-1", "ws-abc");
        assert_eq!(
            registry.resolve(Some(&token)).expect("resolve").actor(),
            agent("tile-1", "ws-abc").actor()
        );
        assert_eq!(
            registry
                .resolve(Some(&token))
                .expect("resolve")
                .workstream_id(),
            Some("ws-abc")
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
            registry.resolve(Some(&second)).expect("resolve").actor(),
            agent("tile-2", "ws-xyz").actor()
        );
        assert_eq!(
            registry
                .resolve(Some(&second))
                .expect("resolve")
                .workstream_id(),
            Some("ws-xyz")
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
                pipelines: None,
                planning: None,
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
    fn sync_commands_report_history_and_mute() {
        let mut db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let off = call(&db, &caller, "sync.status", serde_json::Value::Null)
            .unwrap()
            .data;
        assert_eq!(off["configured"], false);
        db.execute(
            "INSERT INTO settings (key, value) VALUES ('companion.server_url', 'https://sync.example')",
            [],
        )
        .unwrap();
        let now = crate::sync_monitor_now();
        for (i, cpu) in [5.0, 92.0].iter().enumerate() {
            crate::sync_monitor::store_check(
                &db,
                &crate::sync_monitor::Check {
                    at: now - 60_000 * (2 - i as i64),
                    reachable: true,
                    latency_ms: 80,
                    error: None,
                    vitals: Some(serde_json::json!({"box": {"cpuPercent": cpu}})),
                    vitals_error: None,
                },
            )
            .unwrap();
        }
        crate::sync_monitor::store_check(
            &db,
            &crate::sync_monitor::Check {
                at: now - 3 * 3_600_000,
                reachable: true,
                latency_ms: 70,
                error: None,
                vitals: None,
                vitals_error: None,
            },
        )
        .unwrap();
        let problem = crate::sync_monitor::Problem {
            kind: "cpu".into(),
            severity: "critical".into(),
            started_at: now,
            message: "CPU 92%".into(),
            hint: "h".into(),
        };
        crate::sync_monitor::apply(&mut db, &[problem], &[]).unwrap();

        let status = call(&db, &caller, "sync.status", serde_json::Value::Null)
            .unwrap()
            .data;
        assert_eq!(status["configured"], true);
        assert_eq!(status["latest"]["vitals"]["box"]["cpuPercent"], 92.0);
        assert_eq!(status["problems"][0]["kind"], "cpu");
        let history = call(
            &db,
            &caller,
            "sync.history",
            serde_json::json!({"hours": 1}),
        )
        .unwrap()
        .data;
        assert_eq!(history["checks"].as_array().unwrap().len(), 2);
        let muted = call(
            &db,
            &caller,
            "sync.mute",
            serde_json::json!({"kind": "cpu", "hours": 24}),
        )
        .unwrap();
        assert!(muted.data["until"].as_i64().unwrap() > now);
        let status = call(&db, &caller, "sync.status", serde_json::Value::Null)
            .unwrap()
            .data;
        assert!(status["mutes"]["cpu"].as_i64().is_some());
        assert!(call(
            &db,
            &caller,
            "sync.mute",
            serde_json::json!({"kind": "weather"})
        )
        .is_err());
    }

    #[test]
    fn planning_orphan_commands_list_hide_and_link() {
        let _serial = crate::ado_planning::PUBLISH_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        use crate::ado_planning::{Change, PlanningGateway, PrRef};
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        crate::ado_planning::save_connection(
            &db,
            &FakePlanning
                .connect("https://dev.azure.com/o/P/_backlogs/backlog/T/Features")
                .unwrap(),
        )
        .unwrap();
        let list = |params: serde_json::Value| {
            call(&db, &caller, "planning.orphan_prs", params)
                .unwrap()
                .data
        };
        let all = list(serde_json::Value::Null);
        assert_eq!(all["days"], 30);
        assert_eq!(all["prs"].as_array().unwrap().len(), 3);
        for field in ["id", "title", "repo", "state", "created", "url", "hidden"] {
            assert!(all["prs"][0].get(field).is_some(), "{field}");
        }
        assert_eq!(
            list(serde_json::json!({"days": 7}))["prs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(call(
            &db,
            &caller,
            "planning.orphan_prs",
            serde_json::json!({"days": 45})
        )
        .is_err());

        call(
            &db,
            &caller,
            "planning.hide_pr",
            serde_json::json!({"pr": 72}),
        )
        .unwrap();
        call(
            &db,
            &caller,
            "planning.hide_repo",
            serde_json::json!({"repo": "SCC/engaine"}),
        )
        .unwrap();
        let hidden = list(serde_json::Value::Null);
        assert!(hidden["prs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["hidden"] == true));
        assert_eq!(hidden["hidden"]["repos"][0]["label"], "SCC/engaine");
        call(
            &db,
            &caller,
            "planning.unhide_repo",
            serde_json::json!({"repo": "SCC/engaine"}),
        )
        .unwrap();
        call(
            &db,
            &caller,
            "planning.unhide_pr",
            serde_json::json!({"pr": 72}),
        )
        .unwrap();
        assert!(list(serde_json::Value::Null)["prs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["hidden"] == false));

        let linked = call(
            &db,
            &caller,
            "planning.link_pr",
            serde_json::json!({"pr": 70, "item": 20}),
        )
        .unwrap()
        .data;
        assert_eq!(linked["draft"], 1);
        assert_eq!(
            crate::ado_planning::load_draft(&db).unwrap(),
            vec![Change::LinkPr {
                id: 20,
                rev: 4,
                pr: PrRef {
                    id: 70,
                    project_id: "scc-id".into(),
                    repo_id: "engaine-id".into(),
                    title: "PR 70".into()
                }
            }],
            "a task of a sprint story, at its revision"
        );
        call(
            &db,
            &caller,
            "planning.link_pr",
            serde_json::json!({"pr": 71, "item": 2}),
        )
        .unwrap();
        call(
            &db,
            &caller,
            "planning.link_pr",
            serde_json::json!({"pr": 72, "item": 50}),
        )
        .unwrap();
        for (params, expect) in [
            (
                serde_json::json!({"pr": 404, "item": 2}),
                "isn't one of your orphaned PRs",
            ),
            (
                serde_json::json!({"pr": 72, "item": 100}),
                "isn't one of your stories or a task of a sprint story",
            ),
            (
                serde_json::json!({"pr": 72, "item": 30}),
                "isn't one of your stories or a task of a sprint story",
            ),
        ] {
            let err = call(&db, &caller, "planning.link_pr", params.clone()).unwrap_err();
            assert!(err.message.contains(expect), "{params}: {}", err.message);
        }
        assert_eq!(crate::ado_planning::load_draft(&db).unwrap().len(), 3);
    }

    #[test]
    fn planning_ktlo_commands_set_the_feature_and_draft_ktlo_stories() {
        let _serial = crate::ado_planning::PUBLISH_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        use crate::ado_planning::{Change, PlanningGateway};
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        crate::ado_planning::save_connection(
            &db,
            &FakePlanning
                .connect("https://dev.azure.com/o/P/_backlogs/backlog/T/Features")
                .unwrap(),
        )
        .unwrap();
        let link = |id: i64| format!("https://o.visualstudio.com/P/_workitems/edit/{id}");

        assert_eq!(
            call(&db, &caller, "planning.ktlo", serde_json::Value::Null)
                .unwrap()
                .data["ktlo"],
            serde_json::Value::Null
        );
        let err = call(
            &db,
            &caller,
            "planning.ktlo_story",
            serde_json::json!({"pr": 70}),
        )
        .unwrap_err();
        assert!(err.message.contains("KTLO feature"), "{}", err.message);
        let err = call(
            &db,
            &caller,
            "planning.set_ktlo",
            serde_json::json!({"link": link(2)}),
        )
        .unwrap_err();
        assert!(err.message.contains("not a Feature"), "{}", err.message);
        let set = call(
            &db,
            &caller,
            "planning.set_ktlo",
            serde_json::json!({"link": link(4533022)}),
        )
        .unwrap();
        assert_eq!(set.data["ktlo"]["id"], 4533022);
        let shown = call(&db, &caller, "planning.ktlo", serde_json::Value::Null)
            .unwrap()
            .data;
        assert_eq!(
            (
                shown["ktlo"]["id"].as_i64(),
                shown["ktlo"]["state"].as_str()
            ),
            (Some(4533022), Some("Active"))
        );

        let drafted = call(
            &db,
            &caller,
            "planning.ktlo_story",
            serde_json::json!({"pr": 70, "title": "Deps"}),
        )
        .unwrap();
        assert_eq!(drafted.data["story"], -1);
        call(
            &db,
            &caller,
            "planning.link_pr",
            serde_json::json!({"pr": 71, "item": -1}),
        )
        .unwrap();
        let draft = crate::ado_planning::load_draft(&db).unwrap();
        assert_eq!(
            draft[0],
            Change::CreateStory {
                temp_id: -1,
                parent: 4533022,
                title: "Deps".into(),
                points: Some(1.0),
                description: None,
                iteration: Some("P\\S23".into()),
                order: None,
            },
            "1 point and the sprint after the current one by default"
        );
        assert!(matches!(&draft[1], Change::LinkPr { id: -1, pr, .. } if pr.id == 70));
        assert!(matches!(&draft[2], Change::LinkPr { id: -1, pr, .. } if pr.id == 71));

        let titled = call(
            &db,
            &caller,
            "planning.ktlo_story",
            serde_json::json!({"pr": 72, "points": 2, "sprint": "S22"}),
        )
        .unwrap();
        assert_eq!(titled.data["story"], -2);
        let draft = crate::ado_planning::load_draft(&db).unwrap();
        assert!(matches!(
            &draft[3],
            Change::CreateStory { title, points: Some(p), iteration: Some(i), .. }
                if title == "PR 72" && *p == 2.0 && i == "P\\S22"
        ));

        for (params, expect) in [
            (
                serde_json::json!({"pr": 99}),
                "isn't one of your orphaned PRs",
            ),
            (
                serde_json::json!({"pr": 70, "sprint": "S21"}),
                "isn't a sprint from the current one on",
            ),
            (serde_json::json!({"pr": 70, "title": "  "}), "title"),
        ] {
            let err = call(&db, &caller, "planning.ktlo_story", params.clone()).unwrap_err();
            assert!(err.message.contains(expect), "{params}: {}", err.message);
        }
        let err = call(
            &db,
            &caller,
            "planning.link_pr",
            serde_json::json!({"pr": 70, "item": -9}),
        )
        .unwrap_err();
        assert!(err.message.contains("drafted"), "{}", err.message);

        // planning.features leaves the KTLO feature out (feature 100 is mine).
        crate::ado_planning::save_ktlo(&db, 100).unwrap();
        let features = call(&db, &caller, "planning.features", serde_json::Value::Null)
            .unwrap()
            .data;
        assert!(features.as_array().unwrap().is_empty(), "{features}");

        // Last semester's feature, closed: no new KTLO stories.
        crate::ado_planning::save_ktlo(&db, 4533000).unwrap();
        let err = call(
            &db,
            &caller,
            "planning.ktlo_story",
            serde_json::json!({"pr": 70}),
        )
        .unwrap_err();
        assert!(err.message.contains("Closed"), "{}", err.message);
    }

    #[test]
    fn planning_task_state_reads_tasks_and_drafts_their_state() {
        let _serial = crate::ado_planning::PUBLISH_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        use crate::ado_planning::{Change, PlanningGateway};
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        crate::ado_planning::save_connection(
            &db,
            &FakePlanning
                .connect("https://dev.azure.com/o/P/_backlogs/backlog/T/Features")
                .unwrap(),
        )
        .unwrap();
        let sprint = call(&db, &caller, "planning.sprint", serde_json::Value::Null)
            .unwrap()
            .data;
        let tasks = &sprint["stories"][1]["tasks"];
        assert_eq!(tasks[0]["id"], 20);
        assert_eq!(tasks[0]["title"], "task 20");
        assert_eq!(tasks[0]["state"], "Active");
        assert_eq!(tasks[1]["assigned_to"], "Erwin");

        let set = |task: i64, state: &str| {
            call(
                &db,
                &caller,
                "planning.task_state",
                serde_json::json!({"task": task, "state": state}),
            )
        };
        let outcome = set(20, "Closed").unwrap();
        assert_eq!(outcome.data["draft"], 1);
        assert_eq!(
            crate::ado_planning::load_draft(&db).unwrap(),
            vec![Change::SetState {
                id: 20,
                rev: 4,
                state: "Closed".into()
            }]
        );
        for (task, state, expect) in [
            (20, "Removed", "New, Active, Blocked, Resolved or Closed"),
            (20, "Done-ish", "New, Active, Blocked, Resolved or Closed"),
            (
                30,
                "Closed",
                "isn't a task of a story in the selected sprint",
            ),
            (
                2,
                "Closed",
                "isn't a task of a story in the selected sprint",
            ),
        ] {
            let err = set(task, state).unwrap_err();
            assert!(
                err.message.contains(expect),
                "{task} {state}: {}",
                err.message
            );
        }
        assert_eq!(crate::ado_planning::load_draft(&db).unwrap().len(), 1);
        // Back to its state in ADO: the pending change goes away.
        assert_eq!(set(20, "Active").unwrap().data["draft"], 0);
        assert!(crate::ado_planning::load_draft(&db).unwrap().is_empty());
    }

    #[test]
    fn planning_commands_read_and_change_the_ui_draft_and_publish_it() {
        let _serial = crate::ado_planning::PUBLISH_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        use crate::ado_planning::PlanningGateway;
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let unconnected =
            call(&db, &caller, "planning.sprint", serde_json::Value::Null).unwrap_err();
        assert!(
            unconnected.message.contains("isn't connected"),
            "{}",
            unconnected.message
        );
        crate::ado_planning::save_connection(
            &db,
            &FakePlanning
                .connect("https://dev.azure.com/o/P/_backlogs/backlog/T/Features")
                .unwrap(),
        )
        .unwrap();

        let sprint = call(&db, &caller, "planning.sprint", serde_json::Value::Null)
            .unwrap()
            .data;
        assert_eq!(
            (
                sprint["committed"].as_f64(),
                sprint["done"].as_f64(),
                sprint["to_go"].as_f64()
            ),
            (Some(4.0), Some(1.0), Some(3.0))
        );
        assert_eq!(sprint["stories"].as_array().unwrap().len(), 2);
        let features = call(&db, &caller, "planning.features", serde_json::Value::Null)
            .unwrap()
            .data;
        assert_eq!(
            (
                features[0]["done"].as_f64(),
                features[0]["pending"].as_f64()
            ),
            (Some(1.0), Some(8.0))
        );
        let feature = call(
            &db,
            &caller,
            "planning.feature",
            serde_json::json!({"id": 100}),
        )
        .unwrap()
        .data;
        assert_eq!(feature["stories"].as_array().unwrap().len(), 3);
        assert!(call(
            &db,
            &caller,
            "planning.feature",
            serde_json::json!({"id": 5})
        )
        .is_err());

        call(
            &db,
            &caller,
            "planning.move",
            serde_json::json!({"story": 2, "sprint": "S23"}),
        )
        .unwrap();
        call(
            &db,
            &caller,
            "planning.move",
            serde_json::json!({"story": 3, "sprint": "P\\S23"}),
        )
        .unwrap();
        call(
            &db,
            &caller,
            "planning.estimate",
            serde_json::json!({"story": 2, "points": 5}),
        )
        .unwrap();
        let added = call(
            &db,
            &caller,
            "planning.add_story",
            serde_json::json!({"feature": 100, "title": "New one", "points": 2.5}),
        )
        .unwrap()
        .data;
        assert_eq!(added["draft"], 4);
        assert!(call(
            &db,
            &caller,
            "planning.move",
            serde_json::json!({"story": 2, "sprint": "S99"})
        )
        .is_err());
        assert!(call(
            &db,
            &caller,
            "planning.move",
            serde_json::json!({"story": 404, "sprint": "S23"})
        )
        .is_err());
        let draft = crate::ado_planning::load_draft(&db).unwrap();
        assert!(
            draft.contains(&crate::ado_planning::Change::Move {
                id: 3,
                rev: 1,
                to_iteration: "P\\S23".into(),
                assign_to_me: true
            }),
            "picking up an unassigned story assigns it"
        );

        let published = call(&db, &caller, "planning.publish", serde_json::Value::Null)
            .unwrap()
            .data;
        assert_eq!(published["written"].as_array().unwrap().len(), 3);
        assert_eq!(published["conflicts"][0]["ado_value"], "P\\S24");
        assert_eq!(
            crate::ado_planning::load_draft(&db).unwrap().len(),
            1,
            "the conflicting change stays in the draft"
        );
    }

    #[test]
    fn inbox_investigate_creates_or_reuses_an_investigation() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        db.execute(
            "INSERT INTO projects (id, name, directory, git_remote, color, created_at, updated_at) VALUES ('mc', 'media_components', '/code/mc', 'https://dev.azure.com/skype/SCC/_git/repo-33770', '#fff', 'now', 'now')",
            [],
        )
        .unwrap();
        let added = call(
            &db,
            &caller,
            "inbox.pipeline_add",
            serde_json::json!({"url":"https://dev.azure.com/skype/SCC/_build?definitionId=33770"}),
        )
        .unwrap();
        let watch = added.data["id"].as_str().unwrap().to_string();
        for (id, result) in [("n1", "failed"), ("n2", "succeeded")] {
            db.execute(
                "INSERT INTO pipeline_events (id, watch_id, run_id, run_number, result, branch, trigger_label, finished_at, created_at)
                VALUES (?1, ?2, 7, '20261105.3', ?3, 'release/2.4', 'Scheduled', '2026-11-05T08:10:44Z', 'now')",
                rusqlite::params![id, watch, result],
            )
            .unwrap();
        }
        let git = FakeProvisioner::default();
        let first = call_with(
            &db,
            &caller,
            "inbox.investigate",
            serde_json::json!({"item": "n1"}),
            &git,
        )
        .unwrap();
        assert_eq!(first.data["created"], true);
        let ws = first.data["workstream_id"].as_str().unwrap().to_string();
        assert_eq!(
            *git.created.lock().unwrap(),
            vec![(
                "/code/mc".to_string(),
                "investigate/pipeline-33770-20261105.3".to_string(),
                Some("origin/release/2.4".to_string())
            )]
        );
        let again = call(
            &db,
            &caller,
            "inbox.investigate",
            serde_json::json!({"item": "n1"}),
        )
        .unwrap();
        assert_eq!(
            (
                again.data["workstream_id"].as_str(),
                again.data["created"].as_bool()
            ),
            (Some(ws.as_str()), Some(false))
        );
        assert_eq!(
            crate::pipeline_investigate::pending_sessions(&db)
                .unwrap()
                .len(),
            1
        );

        let err = call(
            &db,
            &caller,
            "inbox.investigate",
            serde_json::json!({"item": "n2"}),
        )
        .unwrap_err();
        assert!(err.message.contains("Only failed runs"), "{}", err.message);
        let err = call(
            &db,
            &caller,
            "inbox.investigate",
            serde_json::json!({"item": "nope"}),
        )
        .unwrap_err();
        assert!(
            err.message
                .contains("No pipeline notification with id nope"),
            "{}",
            err.message
        );
    }

    #[test]
    fn inbox_investigate_takes_a_digest_as_one_batch() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let digest = crate::pipeline_investigate::tests::seed_digest(&db);
        let git = FakeProvisioner::default();
        let first = call_with(
            &db,
            &caller,
            "inbox.investigate",
            serde_json::json!({"item": digest.id}),
            &git,
        )
        .unwrap();
        assert_eq!(first.data["created"], true);
        let again = call(
            &db,
            &caller,
            "inbox.investigate",
            serde_json::json!({"item": digest.id}),
        )
        .unwrap();
        assert_eq!(again.data["created"], false);
        let listed = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(
            listed.data["pipeline_digests"][0]["investigation"],
            first.data["workstream_id"]
        );
        let pending = crate::pipeline_investigate::pending_sessions(&db).unwrap();
        assert!(pending[0].prompt.contains("Group the runs by root cause"));
    }

    #[test]
    fn pipeline_repo_commands_show_and_override_the_repo() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        for (id, name, remote) in [
            (
                "mc",
                "media_components",
                "https://dev.azure.com/skype/SCC/_git/repo-33770",
            ),
            (
                "acs",
                "acs_media_sdk",
                "https://dev.azure.com/skype/SCC/_git/acs_media_sdk",
            ),
        ] {
            db.execute(
                "INSERT INTO projects (id, name, directory, git_remote, color, created_at, updated_at) VALUES (?1, ?2, '/x', ?3, '#fff', 'now', 'now')",
                rusqlite::params![id, name, remote],
            )
            .unwrap();
        }
        let added = call(
            &db,
            &caller,
            "inbox.pipeline_add",
            serde_json::json!({"url":"https://dev.azure.com/skype/SCC/_build?definitionId=33770"}),
        )
        .unwrap();
        let id = added.data["id"].as_str().unwrap().to_string();
        let shown = |db: &Connection| {
            call(db, &caller, "inbox.pipelines", serde_json::Value::Null)
                .unwrap()
                .data[0]
                .clone()
        };
        let first = shown(&db);
        assert_eq!(first["ado_repo"]["name"], "repo-33770");
        assert_eq!(first["repos"][0]["id"], "mc");
        assert_eq!(first["repo_source"], "auto");

        let set = |repo: &str| {
            call(
                &db,
                &caller,
                "inbox.pipeline_set_repo",
                serde_json::json!({"pipeline": id, "repo": repo}),
            )
        };
        set("acs").unwrap();
        let manual = shown(&db);
        assert_eq!(
            (
                manual["repos"][0]["id"].as_str(),
                manual["repo_source"].as_str()
            ),
            (Some("acs"), Some("manual"))
        );
        set("none").unwrap();
        assert_eq!(shown(&db)["repos"].as_array().unwrap().len(), 0);
        set("auto").unwrap();
        assert_eq!(shown(&db), first);

        let err = call(
            &db,
            &caller,
            "inbox.pipeline_set_repo",
            serde_json::json!({"pipeline": "ghost", "repo": "auto"}),
        )
        .unwrap_err();
        assert!(err.message.contains("isn't watched"), "{}", err.message);
        let err = set("nope").unwrap_err();
        assert!(
            err.message.contains("No repo with id nope"),
            "{}",
            err.message
        );
    }

    #[test]
    fn pipeline_commands_do_what_the_inbox_ui_does() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let added = call(&db, &caller, "inbox.pipeline_add",
            serde_json::json!({"url":"https://dev.azure.com/skype/SCC/_build/results?buildId=33770001&view=logs"})).unwrap();
        assert_eq!(added.data["name"], "pipeline-33770");
        assert_eq!(added.data["project"], "SCC");
        assert_eq!(added.data["mode"], "failures");
        let id = added.data["id"].as_str().unwrap().to_string();

        let duplicate = call(&db, &caller, "inbox.pipeline_add",
            serde_json::json!({"url":"https://skype.visualstudio.com/SCC/_build?definitionId=33770"})).unwrap_err();
        assert!(
            duplicate.message.contains("Already watching"),
            "{}",
            duplicate.message
        );
        let bad = call(
            &db,
            &caller,
            "inbox.pipeline_add",
            serde_json::json!({"url":"https://github.com/o/r/actions/runs/1"}),
        )
        .unwrap_err();
        assert!(
            bad.message.contains("pipeline or run link"),
            "{}",
            bad.message
        );
        let with_mode = call(&db, &caller, "inbox.pipeline_add",
            serde_json::json!({"url":"https://dev.azure.com/skype/SCC/_build?definitionId=7","mode":"both"})).unwrap();
        assert_eq!(with_mode.data["mode"], "both");

        call(
            &db,
            &caller,
            "inbox.pipeline_mode",
            serde_json::json!({"id":id,"mode":"successes"}),
        )
        .unwrap();
        let daily = call(
            &db,
            &caller,
            "inbox.pipeline_mode",
            serde_json::json!({"id":with_mode.data["id"],"mode":"daily_failures"}),
        )
        .unwrap();
        assert_eq!(daily.data["mode"], "daily_failures");
        let wrong = call(
            &db,
            &caller,
            "inbox.pipeline_mode",
            serde_json::json!({"id":id,"mode":"sometimes"}),
        )
        .unwrap_err();
        assert!(wrong.hint.contains("daily_failures"), "{}", wrong.hint);
        let scoped = call(
            &db,
            &caller,
            "inbox.pipeline_branches",
            serde_json::json!({"id":id,"branches":"all"}),
        )
        .unwrap();
        assert!(scoped.change.is_some());
        let bad_scope = call(
            &db,
            &caller,
            "inbox.pipeline_branches",
            serde_json::json!({"id":id,"branches":"feature/x"}),
        )
        .unwrap_err();
        assert_eq!(bad_scope.code, "INVALID_PARAM");
        let listed = call(&db, &caller, "inbox.pipelines", serde_json::Value::Null).unwrap();
        let rows = listed.data.as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|r| r["id"] == id.as_str() && r["mode"] == "successes" && r["branches"] == "all"));
        assert!(rows
            .iter()
            .any(|r| r["id"] != id.as_str() && r["branches"] == "default"));

        // A notification for it shows in inbox.list and can be read.
        db.execute(
            "UPDATE pipeline_watches SET notify_after='2000-01-01T00:00:00Z'",
            [],
        )
        .unwrap();
        let target = crate::pipeline_inbox::targets(&db)
            .unwrap()
            .into_iter()
            .find(|t| t.id == id)
            .unwrap();
        crate::pipeline_inbox::apply_runs(
            &db,
            &target,
            &[crate::pipeline_inbox::Run {
                id: 33770001,
                number: "1".into(),
                result: "succeeded".into(),
                branch: "main".into(),
                trigger: "Scheduled".into(),
                finished_at: "2026-01-01T00:00:00Z".into(),
                repository: None,
                commit: String::new(),
            }],
        )
        .unwrap();
        let inbox = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        let item = &inbox.data["pipeline_items"][0];
        assert_eq!(item["pipeline_name"], "pipeline-33770");
        assert_eq!(item["is_read"], false);
        let event = item["id"].as_str().unwrap().to_string();
        call(
            &db,
            &caller,
            "inbox.read",
            serde_json::json!({"id":event,"read":true}),
        )
        .unwrap();
        let inbox = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(inbox.data["pipeline_items"][0]["is_read"], true);

        call(
            &db,
            &caller,
            "inbox.pipeline_remove",
            serde_json::json!({"id":id}),
        )
        .unwrap();
        assert!(call(
            &db,
            &caller,
            "inbox.pipeline_remove",
            serde_json::json!({"id":id})
        )
        .is_err());
        let inbox = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(inbox.data["pipelines"].as_array().unwrap().len(), 1);
        assert!(inbox.data["pipeline_items"].as_array().unwrap().is_empty());
    }

    #[test]
    fn ping_answers_without_an_identity_but_whoami_does_not() {
        let db = memory_db();
        let anonymous = CommandContext {
            db: &db,
            caller: None,
            provisioner: None,
            pipelines: None,
            planning: None,
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
    fn inbox_mute_and_unmute_all_round_trip_through_the_agent_channel() {
        let db = memory_db();
        seed_repo(&db, "repo-1", "/repo");
        db.execute(
            "INSERT INTO pr_inbox_events (id,project_id,source,identity,pr_id,kind,title,author,summary,url,created_at,dedupe_key,subject,outcome)
            VALUES ('ev','repo-1','s','me',1,'policy','t','a','CI passed','u','t','k','CI','approved')",
            [],
        )
        .unwrap();
        let caller = agent("tile-1", "ws-own");
        let muted = call(&db, &caller, "inbox.mute", serde_json::json!({"id":"ev"})).unwrap();
        assert_eq!(muted.data["subject"], "CI");
        assert_eq!(muted.data["outcome"], "approved");
        let listed = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(listed.data["mutes"].as_array().unwrap().len(), 1);
        assert!(call(
            &db,
            &caller,
            "inbox.mute",
            serde_json::json!({"id":"missing"})
        )
        .is_err());
        let reset = call(&db, &caller, "inbox.unmute_all", serde_json::Value::Null).unwrap();
        assert_eq!(reset.data["cleared"], 1);
    }

    #[test]
    fn the_digest_time_is_read_and_set_through_the_agent_channel() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let read = call(&db, &caller, "inbox.digest_time", serde_json::Value::Null).unwrap();
        assert_eq!(read.data["time"], "09:00");
        assert!(read.change.is_none());
        let set = call(
            &db,
            &caller,
            "inbox.digest_time",
            serde_json::json!({"time":"17:30"}),
        )
        .unwrap();
        assert_eq!(set.data["time"], "17:30");
        assert!(set.change.is_some());
        let bad = call(
            &db,
            &caller,
            "inbox.digest_time",
            serde_json::json!({"time":"5pm"}),
        )
        .unwrap_err();
        assert_eq!(bad.code, "INVALID_PARAM");
        let listed = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(listed.data["digest_time"], "17:30");
        assert!(listed.data["pipeline_digests"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn auto_investigate_is_set_through_the_agent_channel_only_in_daily_failures() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let daily = call(&db, &caller, "inbox.pipeline_add",
            serde_json::json!({"url":"https://dev.azure.com/skype/SCC/_build?definitionId=1","mode":"daily_failures"})).unwrap();
        let other = call(
            &db,
            &caller,
            "inbox.pipeline_add",
            serde_json::json!({"url":"https://dev.azure.com/skype/SCC/_build?definitionId=2"}),
        )
        .unwrap();
        let set = call(
            &db,
            &caller,
            "inbox.pipeline_auto_investigate",
            serde_json::json!({"pipeline": daily.data["id"], "value": "digest"}),
        )
        .unwrap();
        assert_eq!(set.data["auto_investigate"], "digest");
        let refused = call(
            &db,
            &caller,
            "inbox.pipeline_auto_investigate",
            serde_json::json!({"pipeline": other.data["id"], "value": "digest"}),
        )
        .unwrap_err();
        assert!(
            refused.message.contains("Daily failures"),
            "{}",
            refused.message
        );
        let bad = call(
            &db,
            &caller,
            "inbox.pipeline_auto_investigate",
            serde_json::json!({"pipeline": daily.data["id"], "value": "first"}),
        )
        .unwrap_err();
        assert_eq!(bad.code, "INVALID_PARAM");
        let listed = call(&db, &caller, "inbox.pipelines", serde_json::Value::Null).unwrap();
        let rows = listed.data.as_array().unwrap();
        assert!(rows
            .iter()
            .any(|r| r["mode"] == "daily_failures" && r["auto_investigate"] == "digest"));
        assert!(rows
            .iter()
            .any(|r| r["mode"] == "failures" && r["auto_investigate"] == "off"));
    }

    #[test]
    fn mute_all_turns_on_and_off_through_the_agent_channel_apart_from_pr_mutes() {
        let db = memory_db();
        let caller = agent("tile-1", "ws-own");
        let on = call(
            &db,
            &caller,
            "inbox.mute_all_on",
            serde_json::json!({"until":"2999-01-01T08:00:00Z"}),
        )
        .unwrap();
        assert_eq!(on.data["muted"], true);
        assert_eq!(on.data["until"], "2999-01-01T08:00:00.000Z");
        assert!(on.change.is_some());
        let bad = call(
            &db,
            &caller,
            "inbox.mute_all_on",
            serde_json::json!({"until":"2000-01-01T00:00:00Z"}),
        )
        .unwrap_err();
        assert_eq!(bad.code, "INVALID_PARAM");
        // inbox.unmute_all clears PR mute rules only.
        call(&db, &caller, "inbox.unmute_all", serde_json::Value::Null).unwrap();
        let listed = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(listed.data["mute"]["muted"], true);
        let dropped = call(
            &db,
            &caller,
            "inbox.message",
            serde_json::json!({"level":"done","title":"Finished"}),
        )
        .unwrap();
        assert_eq!(dropped.data["dropped"], true);
        let off = call(&db, &caller, "inbox.mute_all_off", serde_json::Value::Null).unwrap();
        assert_eq!(off.data["muted"], false);
        let listed = call(&db, &caller, "inbox.list", serde_json::Value::Null).unwrap();
        assert_eq!(listed.data["mute"]["muted"], false);
        assert!(listed.data["agent_messages"].as_array().unwrap().is_empty());
        let forever = call(&db, &caller, "inbox.mute_all_on", serde_json::Value::Null).unwrap();
        assert_eq!(forever.data["until"], serde_json::Value::Null);
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

    // ── diagram.* ─────────────────────────────────────────────────────────

    fn diagram_fixture() -> Connection {
        let db = memory_db();
        seed_workstream(&db, "w1", None);
        seed_workstream(&db, "w2", None);
        db.execute_batch(
            "INSERT INTO tiles (id, workstream_id, tile_type, title, created_at, updated_at) VALUES ('d1','w1','diagram','Diagram','t','t');
             INSERT INTO tiles (id, workstream_id, tile_type, title, created_at, updated_at) VALUES ('d2','w2','diagram','Theirs','t','t');",
        )
        .unwrap();
        crate::diagrams::create_board(&db, "b1", "d1", "Flow", "1").unwrap();
        crate::diagrams::create_board(&db, "b2", "d2", "Secret", "1").unwrap();
        crate::diagrams::save_scene(
            &db,
            "b1",
            r#"{"elements":[{"id":"a","type":"rectangle"},{"id":"ta","type":"text","containerId":"a","text":"API"}],"files":{}}"#,
            "2",
        )
        .unwrap();
        db
    }

    #[test]
    fn diagram_list_and_get_read_only_the_callers_workstream() {
        let db = diagram_fixture();
        let me = agent("tile-1", "w1");
        let list = call(&db, &me, "diagram.list", serde_json::json!({})).unwrap();
        assert_eq!(list.data["boards"].as_array().unwrap().len(), 1);
        assert_eq!(list.data["boards"][0]["name"], "Flow");
        assert_eq!(list.data["boards"][0]["shapes"], 1);
        let got = call(
            &db,
            &me,
            "diagram.get",
            serde_json::json!({"board": "flow"}),
        )
        .unwrap();
        assert_eq!(got.data["shapes"][0]["label"], "API");
        assert!(got.data["text"]
            .as_str()
            .unwrap()
            .contains("rectangle \"API\""));
        let err = call(&db, &me, "diagram.get", serde_json::json!({"board": "b2"})).unwrap_err();
        assert_eq!(err.code, "DIAGRAM");
    }

    #[test]
    fn diagram_add_queues_mermaid_for_the_tile_and_announces_it() {
        let db = diagram_fixture();
        let me = agent("tile-1", "w1");
        let added = call(
            &db,
            &me,
            "diagram.add",
            serde_json::json!({"board": "b1", "mermaid": "flowchart LR\nA-->B"}),
        )
        .unwrap();
        assert_eq!(added.data["status"], "pending");
        let change = added.change.expect("the open tile must hear about it");
        assert_eq!(
            (change.entity.as_str(), change.id.as_str()),
            ("diagram", "b1")
        );
        let got = call(&db, &me, "diagram.get", serde_json::json!({"board": "b1"})).unwrap();
        assert_eq!(got.data["pending_additions"], 1);
        assert!(got.data["text"].as_str().unwrap().contains("pending"));
        let scene = crate::diagrams::get_board(&db, "b1")
            .unwrap()
            .unwrap()
            .scene_json;
        assert!(scene.contains("\"API\""), "queueing never edits the scene");
        let empty = call(
            &db,
            &me,
            "diagram.add",
            serde_json::json!({"board": "b1", "mermaid": " "}),
        )
        .unwrap_err();
        assert!(["MISSING_PARAM", "BAD_MERMAID"].contains(&empty.code.as_str()));
        let foreign = call(
            &db,
            &me,
            "diagram.add",
            serde_json::json!({"board": "Secret", "mermaid": "flowchart LR\nA-->B"}),
        )
        .unwrap_err();
        assert_eq!(foreign.code, "DIAGRAM");
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

    /// Review r1-f3: `paths=` splits on commas, so a file whose name holds one
    /// needs a lossless form the CLI can pass as a single string.
    #[test]
    fn diff_order_set_takes_a_lossless_json_list_for_awkward_names() {
        let (db, repo) = diff_order_fixture();
        repo.write("odd, name.ts", "x\n");
        let me = agent("tile-1", "w1");
        call(
            &db,
            &me,
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths_json":"[\"odd, name.ts\",\"a.ts\",\"b.ts\",\"c.ts\"]"}),
        )
        .unwrap();
        let read = call(
            &db,
            &me,
            "diff.order.get",
            serde_json::json!({"mode":"unstaged"}),
        )
        .unwrap();
        assert_eq!(read.data["order"]["paths"][0], "odd, name.ts");

        for bad in ["not json", "[1, 2]", "{\"a\":1}"] {
            let err = call(
                &db,
                &me,
                "diff.order.set",
                serde_json::json!({"mode":"unstaged","paths_json": bad}),
            )
            .unwrap_err();
            assert_eq!(err.code, "BAD_PARAM", "{bad}");
        }
        let err = call(
            &db,
            &me,
            "diff.order.set",
            serde_json::json!({"mode":"unstaged","paths":"a.ts","paths_json":"[\"a.ts\"]"}),
        )
        .unwrap_err();
        assert_eq!(err.code, "BAD_PARAM", "both forms at once are ambiguous");
    }
}

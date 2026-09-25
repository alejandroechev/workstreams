use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct AdoRepo {
    organization: String,
    project: String,
    repository: String,
}

impl AdoRepo {
    pub fn parse(remote: &str) -> Result<Self, String> {
        let remote = remote.trim();
        let ssh = remote
            .strip_prefix("git@ssh.dev.azure.com:v3/")
            .or_else(|| remote.strip_prefix("ssh://git@ssh.dev.azure.com/v3/"));
        let parts: Vec<String>;
        if let Some(path) = ssh {
            parts = path
                .split('/')
                .map(crate::pull_requests::percent_decode)
                .collect();
        } else {
            let url =
                reqwest::Url::parse(remote).map_err(|_| "A valid ADO clone URL is required")?;
            if url.scheme() != "https"
                || url.port().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Use an HTTPS or SSH Azure DevOps clone URL".into());
            }
            let path: Vec<_> = url
                .path()
                .trim_end_matches('/')
                .trim_start_matches('/')
                .split('/')
                .map(crate::pull_requests::percent_decode)
                .collect();
            let host = url.host_str().unwrap_or("");
            parts = if host == "dev.azure.com" && path.len() == 4 && path[2] == "_git" {
                vec![path[0].clone(), path[1].clone(), path[3].clone()]
            } else if let Some(org) = host.strip_suffix(".visualstudio.com") {
                if org.contains('.') || path.len() != 3 || path[1] != "_git" {
                    return Err("Unsupported Azure DevOps clone URL".into());
                }
                vec![org.into(), path[0].clone(), path[2].clone()]
            } else {
                return Err(
                    "PR notifications currently support Azure DevOps repositories only".into(),
                );
            };
        }
        if parts.len() != 3
            || parts.iter().any(|s| {
                s.is_empty()
                    || s == "."
                    || s == ".."
                    || s.contains(['/', '\\'])
                    || s.chars().any(char::is_control)
            })
        {
            return Err("Invalid Azure DevOps organization, project, or repository".into());
        }
        Ok(Self {
            organization: parts[0].clone(),
            project: parts[1].clone(),
            repository: parts[2].clone(),
        })
    }

    pub(super) fn url(&self, segments: &[&str]) -> reqwest::Url {
        let mut url = reqwest::Url::parse("https://dev.azure.com/").expect("constant URL");
        url.path_segments_mut()
            .expect("HTTPS base")
            .pop_if_empty()
            .push(&self.organization)
            .extend(segments.iter().copied());
        url
    }

    pub fn web_url(&self, id: u64) -> String {
        self.url(&[
            &self.project,
            "_git",
            &self.repository,
            "pullrequest",
            &id.to_string(),
        ])
        .to_string()
    }
}

#[derive(Clone, Debug)]
pub struct Target {
    pub project_id: String,
    pub remote: String,
    pub mode: WatchMode,
    revision: i64,
}

/// Which pull requests a repository is watched for.
///
/// Stored as text rather than a pair of booleans because the roles are not
/// independent in the UI -- "off" is a mode, not an unchecked pair -- and
/// because each role keeps its own silent baseline, so widening a repo has to
/// be a legible transition rather than an inferred one.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WatchMode {
    Off,
    Reviewer,
    Author,
    Both,
}

impl WatchMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" | "none" | "" => Ok(Self::Off),
            "reviewer" => Ok(Self::Reviewer),
            "author" | "authored" => Ok(Self::Author),
            "both" | "all" => Ok(Self::Both),
            other => Err(format!(
                "Unknown watch mode '{other}'; expected off, reviewer, author or both"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Reviewer => "reviewer",
            Self::Author => "author",
            Self::Both => "both",
        }
    }

    pub fn watches(self, role: PrRole) -> bool {
        matches!(
            (self, role),
            (Self::Both, _) | (Self::Reviewer, PrRole::Reviewer) | (Self::Author, PrRole::Author)
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrRole {
    Reviewer,
    Author,
}

impl PrRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Reviewer => "reviewer",
            Self::Author => "author",
        }
    }
}

/// One pull request as observed in a single poll.
///
/// `deep` is absent when the pass did not spend requests on this PR -- either
/// it fell outside the deep-poll cap or it is no longer active. An absent
/// `deep` leaves the stored comment/vote/policy watermarks untouched, so a
/// skipped pass delays notifications rather than losing them.
#[derive(Clone, Debug)]
pub struct WatchedPr {
    pub id: u64,
    pub title: String,
    pub author: String,
    pub role: PrRole,
    pub status: String,
    pub deep: Option<PrDetail>,
}

#[derive(Clone, Debug, Default)]
pub struct PrDetail {
    pub comments: Vec<PrComment>,
    pub votes: Vec<PrVote>,
    pub policies: Vec<PrPolicy>,
}

#[derive(Clone, Debug)]
pub struct PrComment {
    pub thread_id: i64,
    pub id: i64,
    /// ADO comment ids restart at 1 inside every thread, so the watermark that
    /// separates "already seen" from "new" has to be the publication time.
    pub published_at: String,
    pub author_id: String,
    pub author: String,
    pub text: String,
    /// ADO writes vote changes, pushes and policy prose into the same thread
    /// list as human discussion. Those are reported through their own events.
    pub is_system: bool,
}

#[derive(Clone, Debug)]
pub struct PrVote {
    pub reviewer_id: String,
    pub reviewer: String,
    /// ADO scale: 10 approved, 5 approved with suggestions, 0 none,
    /// -5 waiting for author, -10 rejected.
    pub vote: i64,
}

#[derive(Clone, Debug)]
pub struct PrPolicy {
    pub id: String,
    pub name: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InboxItem {
    pub id: String,
    pub project_id: String,
    pub repo_name: String,
    pub pr_id: u64,
    pub kind: String,
    pub title: String,
    pub author: String,
    pub summary: String,
    pub url: String,
    pub is_read: bool,
    pub discovered_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoStatus {
    pub project_id: String,
    pub repo_name: String,
    pub enabled: bool,
    pub mode: WatchMode,
    pub last_checked: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct InboxSnapshot {
    pub items: Vec<InboxItem>,
    pub repos: Vec<RepoStatus>,
}

pub fn configure(db: &Connection, project_id: &str, mode: WatchMode) -> Result<(), String> {
    let remote: Option<String> = db
        .query_row(
            "SELECT git_remote FROM projects WHERE id=?1",
            [project_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("Cannot configure repo: {e}"))?;
    if mode != WatchMode::Off {
        AdoRepo::parse(remote.as_deref().ok_or("Repository has no remote URL")?)?;
    }
    db.execute("INSERT INTO pr_inbox_config(project_id,enabled,watch_mode) VALUES (?1,?2,?3)
        ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled, watch_mode=excluded.watch_mode,
        revision=revision+1, error=NULL",
        params![project_id, mode != WatchMode::Off, mode.as_str()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn targets(db: &Connection) -> Result<Vec<Target>, String> {
    let mut stmt = db
        .prepare(
            "SELECT p.id, COALESCE(p.git_remote,''), c.revision, c.watch_mode FROM projects p
        JOIN pr_inbox_config c ON c.project_id=p.id WHERE c.enabled=1 ORDER BY p.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let mode: String = r.get(3)?;
            Ok(Target {
                project_id: r.get(0)?,
                remote: r.get(1)?,
                revision: r.get(2)?,
                mode: WatchMode::parse(&mode).unwrap_or(WatchMode::Reviewer),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn still_current(db: &Connection, target: &Target) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects p JOIN pr_inbox_config c ON c.project_id=p.id
        WHERE p.id=?1 AND c.enabled=1 AND c.revision=?2 AND COALESCE(p.git_remote,'')=?3)",
        params![target.project_id, target.revision, target.remote],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Which PRs this repo is already following, for the current account.
///
/// Read before the network pass so the provider can tell a PR that was merged
/// from one that merely fell out of the active search.
pub fn watching(db: &Connection, target: &Target) -> Result<Vec<u64>, String> {
    let mut stmt = db
        .prepare(
            "SELECT s.pr_id FROM pr_inbox_seen s JOIN pr_inbox_config c ON c.project_id=s.project_id
        WHERE s.project_id=?1 AND s.identity=c.current_identity AND s.source=c.current_source
        AND s.pr_status='active' ORDER BY s.pr_id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&target.project_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// State carried between polls for a single watched PR.
struct StoredPr {
    deep_synced: bool,
    status: String,
    comment_watermark: String,
    votes: std::collections::BTreeMap<String, i64>,
    policies: std::collections::BTreeMap<String, String>,
}

fn decode_map<V: serde::de::DeserializeOwned + Ord>(
    raw: &str,
) -> std::collections::BTreeMap<String, V> {
    serde_json::from_str(raw).unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn record_event(
    tx: &rusqlite::Transaction<'_>,
    target: &Target,
    source: &str,
    identity: &str,
    pr: &WatchedPr,
    url: &str,
    kind: &str,
    dedupe_key: &str,
    summary: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO pr_inbox_events
        (id,project_id,source,identity,pr_id,kind,title,author,summary,url,created_at,dedupe_key)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,strftime('%Y-%m-%dT%H:%M:%SZ','now'),?11)
        ON CONFLICT(project_id,source,identity,pr_id,kind,dedupe_key) DO NOTHING",
        params![
            uuid::Uuid::new_v4().to_string(),
            target.project_id,
            source,
            identity,
            pr.id,
            kind,
            pr.title,
            pr.author,
            summary,
            url,
            dedupe_key
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Turns one poll's observations into notifications.
///
/// Silence is layered, because there are two different "first times". A role
/// baseline per (repo, account, role) stops the first successful check from
/// announcing every PR that already exists -- and because it is keyed by role,
/// switching a repo from reviewer to both does not announce the user's entire
/// back catalogue of authored PRs. A per-PR `deep_synced` flag then does the
/// same for the inside of a PR: the first time its comments, votes and gates
/// are read, they are recorded rather than reported.
pub fn apply_snapshot(
    db: &mut Connection,
    target: &Target,
    identity: &str,
    prs: &[WatchedPr],
) -> Result<(), String> {
    if identity.trim().is_empty() {
        return Err("ADO did not identify the acting user".into());
    }
    let repo = AdoRepo::parse(&target.remote)?;
    let source = repo.web_url(0).to_lowercase();
    let identity = identity.to_lowercase();
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if !still_current(&tx, target)? {
        return Ok(());
    }
    for pr in prs {
        let url = repo.web_url(pr.id);
        let baseline: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pr_inbox_baselines
            WHERE project_id=?1 AND source=?2 AND identity=?3 AND role=?4)",
                params![target.project_id, source, identity, pr.role.as_str()],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let stored = tx
            .query_row(
                "SELECT deep_synced,pr_status,comment_watermark,votes_json,policies_json
                FROM pr_inbox_seen WHERE project_id=?1 AND source=?2 AND identity=?3 AND pr_id=?4",
                params![target.project_id, source, identity, pr.id],
                |r| {
                    let votes: String = r.get(3)?;
                    let policies: String = r.get(4)?;
                    Ok(StoredPr {
                        deep_synced: r.get(0)?,
                        status: r.get(1)?,
                        comment_watermark: r.get(2)?,
                        votes: decode_map(&votes),
                        policies: decode_map(&policies),
                    })
                },
            )
            .ok();

        if stored.is_none() {
            tx.execute(
                "INSERT INTO pr_inbox_seen
                (id,project_id,source,identity,pr_id,title,author,url,notified,discovered_at,role,pr_status)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,strftime('%Y-%m-%dT%H:%M:%SZ','now'),?9,?10)
                ON CONFLICT(project_id,source,identity,pr_id) DO NOTHING",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    target.project_id,
                    source,
                    identity,
                    pr.id,
                    pr.title,
                    pr.author,
                    url,
                    pr.role.as_str(),
                    pr.status
                ],
            )
            .map_err(|e| e.to_string())?;
            // Only a review assignment is an arrival worth announcing. The user
            // opening their own PR is not news to them.
            if baseline && pr.role == PrRole::Reviewer {
                record_event(
                    &tx,
                    target,
                    &source,
                    &identity,
                    pr,
                    &url,
                    "assigned",
                    "",
                    "Assigned to you as reviewer",
                )?;
            }
        } else {
            tx.execute(
                "UPDATE pr_inbox_seen SET title=?5,pr_status=?6 WHERE project_id=?1
                AND source=?2 AND identity=?3 AND pr_id=?4",
                params![
                    target.project_id,
                    source,
                    identity,
                    pr.id,
                    pr.title,
                    pr.status
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        let previous = stored.unwrap_or(StoredPr {
            deep_synced: false,
            status: pr.status.clone(),
            comment_watermark: String::new(),
            votes: Default::default(),
            policies: Default::default(),
        });

        if !previous.status.eq_ignore_ascii_case(&pr.status)
            && !pr.status.eq_ignore_ascii_case("active")
        {
            let summary = if pr.status.eq_ignore_ascii_case("completed") {
                "Pull request completed"
            } else {
                "Pull request abandoned"
            };
            record_event(
                &tx, target, &source, &identity, pr, &url, "closed", &pr.status, summary,
            )?;
        }

        let Some(detail) = pr.deep.as_ref() else {
            continue;
        };

        // The watermark advances past filtered entries too. Otherwise a system
        // note or the user's own reply sitting at the head of the thread would
        // be re-examined on every poll forever.
        let watermark = detail
            .comments
            .iter()
            .map(|c| c.published_at.clone())
            .max()
            .filter(|latest| latest > &previous.comment_watermark)
            .unwrap_or_else(|| previous.comment_watermark.clone());
        let votes: std::collections::BTreeMap<String, i64> = detail
            .votes
            .iter()
            .map(|v| (v.reviewer_id.to_lowercase(), v.vote))
            .collect();
        let policies: std::collections::BTreeMap<String, String> = detail
            .policies
            .iter()
            .map(|p| (p.id.clone(), p.status.clone()))
            .collect();

        if previous.deep_synced {
            for comment in &detail.comments {
                if comment.published_at > previous.comment_watermark
                    && !comment.is_system
                    && !comment.author_id.eq_ignore_ascii_case(&identity)
                {
                    record_event(
                        &tx,
                        target,
                        &source,
                        &identity,
                        pr,
                        &url,
                        "comment",
                        &format!("{}:{}", comment.thread_id, comment.id),
                        &format!("{} commented: {}", comment.author, excerpt(&comment.text)),
                    )?;
                }
            }
            for vote in &detail.votes {
                let key = vote.reviewer_id.to_lowercase();
                if previous.votes.get(&key).copied().unwrap_or(0) == vote.vote || vote.vote == 0 {
                    continue;
                }
                record_event(
                    &tx,
                    target,
                    &source,
                    &identity,
                    pr,
                    &url,
                    "vote",
                    &format!("{key}:{}", vote.vote),
                    &format!("{} {}", vote.reviewer, vote_label(vote.vote)),
                )?;
            }
            for policy in &detail.policies {
                let settled = matches!(
                    policy.status.to_ascii_lowercase().as_str(),
                    "approved" | "rejected" | "broken"
                );
                if !settled || previous.policies.get(&policy.id) == Some(&policy.status) {
                    continue;
                }
                record_event(
                    &tx,
                    target,
                    &source,
                    &identity,
                    pr,
                    &url,
                    "policy",
                    &format!("{}:{}", policy.id, policy.status),
                    &format!("{} {}", policy.name, policy_label(&policy.status)),
                )?;
            }
        }

        tx.execute(
            "UPDATE pr_inbox_seen SET deep_synced=1,comment_watermark=?5,votes_json=?6,policies_json=?7
            WHERE project_id=?1 AND source=?2 AND identity=?3 AND pr_id=?4",
            params![
                target.project_id,
                source,
                identity,
                pr.id,
                watermark,
                serde_json::to_string(&votes).unwrap_or_else(|_| "{}".into()),
                serde_json::to_string(&policies).unwrap_or_else(|_| "{}".into())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for role in [PrRole::Reviewer, PrRole::Author] {
        if target.mode.watches(role) {
            tx.execute(
                "INSERT INTO pr_inbox_baselines(project_id,source,identity,role)
                VALUES (?1,?2,?3,?4) ON CONFLICT DO NOTHING",
                params![target.project_id, source, identity, role.as_str()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "UPDATE pr_inbox_config SET current_identity=?2,current_source=?3,
        last_checked=strftime('%Y-%m-%dT%H:%M:%SZ','now'),error=NULL WHERE project_id=?1",
        params![target.project_id, identity, source],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn vote_label(vote: i64) -> &'static str {
    match vote {
        10 => "approved",
        5 => "approved with suggestions",
        -5 => "is waiting for the author",
        -10 => "rejected the changes",
        _ => "reset their vote",
    }
}

fn policy_label(status: &str) -> &'static str {
    match status.to_ascii_lowercase().as_str() {
        "approved" => "passed",
        "rejected" => "failed",
        "broken" => "errored",
        _ => "changed",
    }
}

/// Comment bodies are unbounded Markdown; the inbox shows one line per event.
fn excerpt(text: &str) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flattened.chars().count() <= 140 {
        return flattened;
    }
    let cut: String = flattened.chars().take(139).collect();
    format!("{}…", cut.trim_end())
}

pub fn record_error(db: &Connection, target: &Target, error: &str) -> Result<(), String> {
    if still_current(db, target)? {
        db.execute(
            "UPDATE pr_inbox_config SET error=?2 WHERE project_id=?1",
            params![target.project_id, error],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn set_read(db: &Connection, id: &str, is_read: bool) -> Result<(), String> {
    let changed = db
        .execute(
            "UPDATE pr_inbox_events SET is_read=?2 WHERE id=?1",
            params![id, is_read],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Notification not found".into());
    }
    Ok(())
}

pub fn snapshot(db: &Connection) -> Result<InboxSnapshot, String> {
    let mut stmt = db
        .prepare(
            "SELECT e.id,e.project_id,p.name,e.pr_id,e.kind,e.title,e.author,e.summary,
        e.url,e.is_read,e.created_at
        FROM pr_inbox_events e JOIN projects p ON p.id=e.project_id
        JOIN pr_inbox_config c ON c.project_id=p.id
        WHERE e.identity=c.current_identity AND e.source=c.current_source
        ORDER BY e.created_at DESC,e.pr_id DESC,e.rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    let items = stmt
        .query_map([], |r| {
            Ok(InboxItem {
                id: r.get(0)?,
                project_id: r.get(1)?,
                repo_name: r.get(2)?,
                pr_id: r.get(3)?,
                kind: r.get(4)?,
                title: r.get(5)?,
                author: r.get(6)?,
                summary: r.get(7)?,
                url: r.get(8)?,
                is_read: r.get(9)?,
                discovered_at: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut stmt = db
        .prepare(
            "SELECT p.id,p.name,c.enabled,c.watch_mode,c.last_checked,c.error
        FROM pr_inbox_config c JOIN projects p ON p.id=c.project_id ORDER BY p.name",
        )
        .map_err(|e| e.to_string())?;
    let repos = stmt
        .query_map([], |r| {
            let mode: String = r.get(3)?;
            Ok(RepoStatus {
                project_id: r.get(0)?,
                repo_name: r.get(1)?,
                enabled: r.get(2)?,
                mode: WatchMode::parse(&mode).unwrap_or(WatchMode::Reviewer),
                last_checked: r.get(4)?,
                error: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(InboxSnapshot { items, repos })
}

trait JsonTransport {
    fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String>;
}

struct AdoTransport {
    client: reqwest::blocking::Client,
    token: String,
}

impl AdoTransport {
    fn connect() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Could not initialize the ADO connection")?,
            token: azure_token()?,
        })
    }
}

impl JsonTransport for AdoTransport {
    fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
        use std::io::Read;
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .map_err(|_| "ADO connection failed or timed out. Check your network and VPN.")?;
        let status = response.status();
        if matches!(status.as_u16(), 401 | 403) {
            return Err(
                "ADO access denied. Run az login for the account with access to this repo.".into(),
            );
        }
        if !status.is_success() {
            return Err(format!(
                "ADO returned HTTP {}. Check repository access and retry.",
                status.as_u16()
            ));
        }
        // Bound the response and never include provider bodies or credentials in errors.
        let mut bytes = Vec::new();
        response
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read the ADO response")?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("ADO response exceeded the size limit; sync was not applied".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "ADO returned an invalid JSON response".into())
    }
}

fn azure_token() -> Result<String, String> {
    read_azure_token(
        &mut azure_cli_command(cfg!(windows)),
        std::time::Duration::from_secs(30),
    )
}

fn azure_cli_command(windows: bool) -> std::process::Command {
    let mut command = if windows {
        let mut cmd = crate::hidden_command("cmd.exe");
        // Azure CLI ships an az.cmd launcher. Only fixed arguments enter the shell.
        cmd.args(["/D", "/C", "az"]);
        cmd
    } else {
        crate::hidden_command("az")
    };
    command.args([
        "account",
        "get-access-token",
        "--resource",
        "499b84ac-1321-427f-aa17-267ca6975798",
        "--output",
        "json",
    ]);
    command
}

fn read_azure_token(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let guidance =
        "Azure CLI authentication failed. Install az and run az login for your ADO account.";
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| guidance)?;
    let stdout = child.stdout.take().ok_or(guidance)?;
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(65537).read_to_end(&mut bytes).map(|_| bytes);
        let _ = send.send(result);
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(guidance.into());
                }
                break;
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "Azure CLI timed out or could not be read. Run az login and try again.".into(),
                );
            }
        }
    }
    let bytes = receive
        .recv_timeout(Duration::from_secs(1))
        .map_err(|_| guidance)?
        .map_err(|_| guidance)?;
    if bytes.len() > 65536 {
        return Err(guidance.into());
    }
    let payload: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| guidance)?;
    payload
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|token| !token.is_empty() && !token.chars().any(char::is_whitespace))
        .map(str::to_owned)
        .ok_or_else(|| guidance.into())
}

/// How many PRs per repo get their comments and gates read each pass.
///
/// The list search costs one request per repo per role; everything else costs
/// two more per PR. Without a cap a repo where the user has forty open PRs
/// would spend well over a hundred requests every two minutes. PRs are ranked
/// newest-id-first, which is the closest thing to "most recently opened" the
/// list payload offers without a second round trip.
const DEEP_POLL_CAP: usize = 25;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireReviewer {
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    vote: i64,
    #[serde(default)]
    is_container: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAuthor {
    #[serde(default)]
    id: String,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProject {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRepository {
    project: WireProject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePr {
    pull_request_id: u64,
    title: String,
    created_by: WireAuthor,
    status: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    reviewers: Vec<WireReviewer>,
    repository: WireRepository,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireComment {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    author: Option<WireAuthor>,
    #[serde(default)]
    content: String,
    #[serde(default)]
    comment_type: String,
    #[serde(default)]
    published_date: String,
    #[serde(default)]
    is_deleted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireThread {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    is_deleted: bool,
    #[serde(default)]
    comments: Vec<WireComment>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEvaluation {
    #[serde(default)]
    evaluation_id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    configuration: Option<WireEvaluationConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEvaluationConfig {
    #[serde(default)]
    settings: Option<serde_json::Value>,
    #[serde(default)]
    r#type: Option<WirePolicyType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePolicyType {
    #[serde(default)]
    display_name: String,
}

fn fetch_identity(http: &dyn JsonTransport, repo: &AdoRepo) -> Result<String, String> {
    let mut identity_url = repo.url(&["_apis", "connectionData"]);
    identity_url
        .query_pairs_mut()
        .append_pair("api-version", "7.1-preview.1");
    let connection = http.get(identity_url)?;
    connection
        .pointer("/authenticatedUser/id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "ADO did not identify the authenticated user".to_string())
}

/// Pages one active-PR search to completion.
///
/// A partial page set is never returned: a mid-pagination failure or a repeated
/// id means the list shifted under us, and half a list read as "these are all
/// the PRs" would silently close out everything missing from it.
fn search_prs(
    http: &dyn JsonTransport,
    repo: &AdoRepo,
    criterion: &str,
    identity: &str,
) -> Result<Vec<WirePr>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    let mut skip = 0;
    for _ in 0..100 {
        let mut url = repo.url(&[
            &repo.project,
            "_apis",
            "git",
            "repositories",
            &repo.repository,
            "pullrequests",
        ]);
        url.query_pairs_mut()
            .append_pair("api-version", "7.1")
            .append_pair("searchCriteria.status", "active")
            .append_pair(criterion, identity)
            .append_pair("$top", "100")
            .append_pair("$skip", &skip.to_string());
        let page = http.get(url)?;
        let values = page
            .get("value")
            .and_then(|v| v.as_array())
            .ok_or("ADO returned an invalid PR page")?;
        if values.is_empty() {
            return Ok(result);
        }
        skip += values.len();
        for value in values {
            let pr: WirePr = serde_json::from_value(value.clone())
                .map_err(|_| "ADO returned an invalid PR entry")?;
            if !seen.insert(pr.pull_request_id) {
                return Err("ADO pagination changed during sync; retrying on the next poll".into());
            }
            result.push(pr);
        }
    }
    Err("ADO pagination limit reached; no partial sync was applied".into())
}

fn fetch_pr(http: &dyn JsonTransport, repo: &AdoRepo, id: u64) -> Result<WirePr, String> {
    let mut url = repo.url(&[
        &repo.project,
        "_apis",
        "git",
        "repositories",
        &repo.repository,
        "pullrequests",
        &id.to_string(),
    ]);
    url.query_pairs_mut().append_pair("api-version", "7.1");
    serde_json::from_value(http.get(url)?).map_err(|_| "ADO returned an invalid PR entry".into())
}

fn fetch_comments(
    http: &dyn JsonTransport,
    repo: &AdoRepo,
    id: u64,
) -> Result<Vec<PrComment>, String> {
    let mut url = repo.url(&[
        &repo.project,
        "_apis",
        "git",
        "repositories",
        &repo.repository,
        "pullRequests",
        &id.to_string(),
        "threads",
    ]);
    url.query_pairs_mut().append_pair("api-version", "7.1");
    let payload = http.get(url)?;
    let threads = payload
        .get("value")
        .and_then(|v| v.as_array())
        .ok_or("ADO returned an invalid comment thread page")?;
    let mut comments = Vec::new();
    for thread in threads {
        let thread: WireThread = serde_json::from_value(thread.clone())
            .map_err(|_| "ADO returned an invalid comment thread")?;
        if thread.is_deleted {
            continue;
        }
        for comment in thread.comments {
            if comment.is_deleted || comment.published_date.is_empty() {
                continue;
            }
            let author = comment.author.unwrap_or(WireAuthor {
                id: String::new(),
                display_name: "Azure DevOps".into(),
            });
            comments.push(PrComment {
                thread_id: thread.id,
                id: comment.id,
                published_at: comment.published_date,
                author_id: author.id,
                author: author.display_name,
                text: comment.content,
                // Everything ADO writes on the user's behalf -- vote changes,
                // pushes, policy prose -- arrives as `system`. Those transitions
                // are reported as vote and policy events instead, so counting
                // them as discussion would notify twice for one thing.
                is_system: !comment.comment_type.is_empty()
                    && !comment.comment_type.eq_ignore_ascii_case("text"),
            });
        }
    }
    Ok(comments)
}

fn fetch_policies(
    http: &dyn JsonTransport,
    repo: &AdoRepo,
    project_guid: &str,
    id: u64,
) -> Result<Vec<PrPolicy>, String> {
    if project_guid.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = repo.url(&[&repo.project, "_apis", "policy", "evaluations"]);
    url.query_pairs_mut()
        .append_pair("api-version", "7.1-preview.1")
        .append_pair(
            "artifactId",
            &format!("vstfs:///CodeReview/CodeReviewId/{project_guid}/{id}"),
        );
    let payload = http.get(url)?;
    let values = payload
        .get("value")
        .and_then(|v| v.as_array())
        .ok_or("ADO returned an invalid policy evaluation page")?;
    let mut policies = Vec::new();
    for value in values {
        let evaluation: WireEvaluation = serde_json::from_value(value.clone())
            .map_err(|_| "ADO returned an invalid policy evaluation")?;
        if evaluation.evaluation_id.is_empty() {
            continue;
        }
        let configuration = evaluation.configuration;
        let display = configuration
            .as_ref()
            .and_then(|c| c.settings.as_ref())
            .and_then(|s| s.get("displayName"))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .or_else(|| {
                configuration
                    .as_ref()
                    .and_then(|c| c.r#type.as_ref())
                    .map(|t| t.display_name.clone())
            })
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Policy".into());
        policies.push(PrPolicy {
            id: evaluation.evaluation_id,
            name: display,
            status: evaluation.status,
        });
    }
    Ok(policies)
}

fn to_votes(reviewers: &[WireReviewer]) -> Vec<PrVote> {
    reviewers
        .iter()
        .filter(|r| !r.is_container && !r.id.is_empty())
        .map(|r| PrVote {
            reviewer_id: r.id.clone(),
            reviewer: if r.display_name.is_empty() {
                "A reviewer".into()
            } else {
                r.display_name.clone()
            },
            vote: r.vote,
        })
        .collect()
}

/// Reads one repository's watched pull requests.
///
/// `watching` is the set this repo was already following. PRs in that set which
/// no longer appear in the active search are fetched individually, because the
/// only way to learn that a PR was completed or abandoned is to look at the PR
/// that just stopped being active.
fn fetch_watched(
    http: &dyn JsonTransport,
    repo: &AdoRepo,
    mode: WatchMode,
    watching: &[u64],
) -> Result<(String, Vec<WatchedPr>), String> {
    let identity = fetch_identity(http, repo)?;
    // Authored first, so a PR the user both opened and was added to as reviewer
    // keeps the role that explains why they care about it.
    let mut candidates: Vec<(PrRole, WirePr)> = Vec::new();
    if mode.watches(PrRole::Author) {
        for pr in search_prs(http, repo, "searchCriteria.creatorId", &identity)? {
            candidates.push((PrRole::Author, pr));
        }
    }
    if mode.watches(PrRole::Reviewer) {
        for pr in search_prs(http, repo, "searchCriteria.reviewerId", &identity)? {
            // A group's membership is not a direct assignment, and a draft is
            // not yet a request -- both stay silent until they become real.
            let direct = pr
                .reviewers
                .iter()
                .any(|r| !r.is_container && r.id.eq_ignore_ascii_case(&identity));
            if direct && !pr.is_draft {
                candidates.push((PrRole::Reviewer, pr));
            }
        }
    }

    let mut merged: Vec<(PrRole, WirePr)> = Vec::new();
    let mut claimed = std::collections::HashSet::new();
    for (role, pr) in candidates {
        if claimed.insert(pr.pull_request_id) {
            merged.push((role, pr));
        }
    }
    merged.sort_by_key(|a| std::cmp::Reverse(a.1.pull_request_id));

    let active: std::collections::HashSet<u64> =
        merged.iter().map(|(_, pr)| pr.pull_request_id).collect();
    let mut watched = Vec::new();
    for (index, (role, pr)) in merged.into_iter().enumerate() {
        let deep = if index < DEEP_POLL_CAP {
            Some(PrDetail {
                comments: fetch_comments(http, repo, pr.pull_request_id)?,
                votes: to_votes(&pr.reviewers),
                policies: fetch_policies(
                    http,
                    repo,
                    &pr.repository.project.id,
                    pr.pull_request_id,
                )?,
            })
        } else {
            None
        };
        watched.push(WatchedPr {
            id: pr.pull_request_id,
            title: pr.title,
            author: pr.created_by.display_name,
            role,
            status: pr.status,
            deep,
        });
    }

    for id in watching.iter().filter(|id| !active.contains(id)) {
        let pr = fetch_pr(http, repo, *id)?;
        watched.push(WatchedPr {
            id: pr.pull_request_id,
            title: pr.title,
            author: pr.created_by.display_name,
            role: PrRole::Reviewer,
            status: pr.status,
            deep: None,
        });
    }

    Ok((identity, watched))
}

/// Owns the poller's lifetime. Network and Azure CLI work never holds the DB lock.
pub struct InboxPoller {
    stop: std::sync::mpsc::Sender<()>,
}

impl InboxPoller {
    pub fn start(db: std::sync::Arc<std::sync::Mutex<Connection>>) -> Self {
        Self::start_with(
            db,
            AdoTransport::connect,
            std::time::Duration::from_secs(120),
            std::time::Duration::from_secs(2),
        )
    }

    fn start_with<F, T>(
        db: std::sync::Arc<std::sync::Mutex<Connection>>,
        mut connect: F,
        poll_interval: std::time::Duration,
        check_interval: std::time::Duration,
    ) -> Self
    where
        F: FnMut() -> Result<T, String> + Send + 'static,
        T: JsonTransport,
    {
        let (stop, stopped) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::time::Instant;
            let mut last = Instant::now() - poll_interval;
            let mut previous = Vec::new();
            loop {
                let selected = db
                    .lock()
                    .map_err(|e| e.to_string())
                    .and_then(|db| targets(&db));
                match selected {
                    Ok(selected) => {
                        let fingerprint: Vec<_> = selected
                            .iter()
                            .map(|t| (t.project_id.clone(), t.remote.clone(), t.revision))
                            .collect();
                        if !selected.is_empty()
                            && (fingerprint != previous || last.elapsed() >= poll_interval)
                        {
                            let transport = connect();
                            for target in &selected {
                                if stopped.try_recv() != Err(std::sync::mpsc::TryRecvError::Empty) {
                                    return;
                                }
                                let following = db
                                    .lock()
                                    .map_err(|e| e.to_string())
                                    .and_then(|db| watching(&db, target))
                                    .unwrap_or_default();
                                let result =
                                    transport.as_ref().map_err(Clone::clone).and_then(|http| {
                                        AdoRepo::parse(&target.remote).and_then(|repo| {
                                            fetch_watched(http, &repo, target.mode, &following)
                                        })
                                    });
                                let saved =
                                    db.lock().map_err(|e| e.to_string()).and_then(|mut db| {
                                        match result {
                                            Ok((identity, prs)) => {
                                                apply_snapshot(&mut db, target, &identity, &prs)
                                            }
                                            Err(error) => record_error(&db, target, &error),
                                        }
                                    });
                                if let Err(error) = saved {
                                    eprintln!("[pr-inbox] Could not save poll: {error}");
                                }
                            }
                            last = Instant::now();
                        }
                        previous = fingerprint;
                    }
                    Err(error) => eprintln!("[pr-inbox] Could not read configuration: {error}"),
                }
                if stopped.recv_timeout(check_interval)
                    != Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    break;
                }
            }
        });
        Self { stop }
    }
}

impl Drop for InboxPoller {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inbox_azure_cli_command_supports_windows_cmd_launchers() {
        let windows = azure_cli_command(true);
        assert_eq!(windows.get_program(), "cmd.exe");
        let args: Vec<_> = windows.get_args().map(|s| s.to_str().unwrap()).collect();
        assert_eq!(&args[..3], &["/D", "/C", "az"]);
        assert_eq!(
            &args[3..],
            &[
                "account",
                "get-access-token",
                "--resource",
                "499b84ac-1321-427f-aa17-267ca6975798",
                "--output",
                "json"
            ]
        );
        let unix = azure_cli_command(false);
        assert_eq!(unix.get_program(), "az");
        assert_eq!(unix.get_args().next().unwrap(), "account");
    }

    #[test]
    fn inbox_worker_polls_only_opted_in_repos_without_locking_db_during_network() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        struct UnlockedTransport(Arc<Mutex<Connection>>);
        impl JsonTransport for UnlockedTransport {
            fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
                assert!(
                    self.0.try_lock().is_ok(),
                    "DB must be available during HTTP work"
                );
                if url.path().ends_with("connectionData") {
                    Ok(json!({"authenticatedUser":{"id":"me"}}))
                } else {
                    Ok(json!({"value":[]}))
                }
            }
        }
        let db = Arc::new(Mutex::new(db()));
        let connects = Arc::new(AtomicUsize::new(0));
        let factory_db = Arc::clone(&db);
        let factory_connects = Arc::clone(&connects);
        let poller = InboxPoller::start_with(
            Arc::clone(&db),
            move || {
                factory_connects.fetch_add(1, Ordering::SeqCst);
                Ok(UnlockedTransport(Arc::clone(&factory_db)))
            },
            Duration::from_millis(100),
            Duration::from_millis(5),
        );
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(
            connects.load(Ordering::SeqCst),
            0,
            "no credentials requested without opt-in"
        );
        configure(&db.lock().unwrap(), "p", WatchMode::Reviewer).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while connects.load(Ordering::SeqCst) < 2 {
            assert!(Instant::now() < deadline, "periodic poll did not run");
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(snapshot(&db.lock().unwrap()).unwrap().repos[0]
            .last_checked
            .is_some());
        configure(&db.lock().unwrap(), "p", WatchMode::Off).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let count = connects.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(130));
        assert_eq!(connects.load(Ordering::SeqCst), count);
        drop(poller);
        std::thread::sleep(Duration::from_millis(30));
        configure(&db.lock().unwrap(), "p", WatchMode::Reviewer).unwrap();
        std::thread::sleep(Duration::from_millis(130));
        assert_eq!(
            connects.load(Ordering::SeqCst),
            count,
            "dropping app worker stops polls"
        );
    }

    #[test]
    #[ignore = "Read-only live ADO check; requires az login and PR_INBOX_LIVE_REMOTE"]
    fn inbox_live_provider_reads_authenticated_assignments() {
        let remote = std::env::var("PR_INBOX_LIVE_REMOTE").expect("explicit ADO clone URL");
        let repo = AdoRepo::parse(&remote).unwrap();
        let transport = AdoTransport::connect().unwrap();
        let (identity, prs) = fetch_watched(&transport, &repo, WatchMode::Both, &[]).unwrap();
        assert!(!identity.is_empty());
        for pr in &prs {
            let detail = pr.deep.as_ref();
            println!(
                "PR {} [{}] {} -- {} comments, {} votes, {} gates",
                pr.id,
                pr.role.as_str(),
                pr.title,
                detail.map(|d| d.comments.len()).unwrap_or(0),
                detail.map(|d| d.votes.len()).unwrap_or(0),
                detail.map(|d| d.policies.len()).unwrap_or(0),
            );
        }
        println!("Live ADO identity resolved; {} watched PRs", prs.len());
    }

    struct FakeTransport {
        responses:
            std::cell::RefCell<std::collections::VecDeque<Result<serde_json::Value, String>>>,
        urls: std::cell::RefCell<Vec<reqwest::Url>>,
    }

    impl JsonTransport for FakeTransport {
        fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
            self.urls.borrow_mut().push(url);
            self.responses
                .borrow_mut()
                .pop_front()
                .expect("unexpected request")
        }
    }

    fn transport(pages: Vec<Result<serde_json::Value, String>>) -> FakeTransport {
        FakeTransport {
            responses: std::cell::RefCell::new(pages.into()),
            urls: Default::default(),
        }
    }

    fn wire_pr(id: u64, reviewer: &str, draft: bool, group: bool) -> serde_json::Value {
        json!({"pullRequestId":id,"title":"Title","createdBy":{"id":"author","displayName":"Author"},
            "status":"active","isDraft":draft,
            "repository":{"project":{"id":"guid"}},
            "reviewers":[{"id":reviewer,"displayName":"Reviewer","vote":0,"isContainer":group}]})
    }

    /// Threads and policy evaluations for one deep-polled PR, in the order
    /// `fetch_watched` asks for them.
    fn wire_detail() -> Vec<Result<serde_json::Value, String>> {
        vec![Ok(json!({"value":[]})), Ok(json!({"value":[]}))]
    }

    #[test]
    fn inbox_provider_pages_and_filters_direct_ready_assignments() {
        let mut pages = vec![
            Ok(json!({"authenticatedUser":{"id":"me"}})),
            Ok(json!({"value":[wire_pr(1,"me",false,false),wire_pr(2,"me",true,false)]})),
            Ok(
                json!({"value":[wire_pr(3,"me",false,true),wire_pr(4,"other",false,false),wire_pr(5,"ME",false,false)]}),
            ),
            Ok(json!({"value":[]})),
        ];
        // PR 5 then PR 1: deep polling runs newest first.
        pages.extend(wire_detail());
        pages.extend(wire_detail());
        let http = transport(pages);
        let (identity, prs) = fetch_watched(
            &http,
            &AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap(),
            WatchMode::Reviewer,
            &[],
        )
        .unwrap();
        assert_eq!(identity, "me");
        assert_eq!(prs.iter().map(|p| p.id).collect::<Vec<_>>(), vec![5, 1]);
        assert!(prs.iter().all(|p| p.role == PrRole::Reviewer));
        let urls = http.urls.borrow();
        assert!(urls[1]
            .query()
            .unwrap()
            .contains("searchCriteria.reviewerId=me"));
        assert!(urls[2].query().unwrap().contains("%24skip=2"));
        assert!(urls[3].query().unwrap().contains("%24skip=5"));
        assert!(urls[4].path().ends_with("/pullRequests/5/threads"));
        assert!(urls[5].query().unwrap().contains("CodeReviewId"));
    }

    #[test]
    fn inbox_provider_searches_authored_prs_and_prefers_the_author_role() {
        let mut pages = vec![
            Ok(json!({"authenticatedUser":{"id":"me"}})),
            // Authored search: PR 9 is mine and still a draft, which is fine --
            // comments on my own draft are exactly what I want to hear about.
            Ok(json!({"value":[wire_pr(9,"me",true,false)]})),
            Ok(json!({"value":[]})),
            // Reviewer search returns the same PR; the author role must win.
            Ok(json!({"value":[wire_pr(9,"me",false,false)]})),
            Ok(json!({"value":[]})),
        ];
        pages.extend(wire_detail());
        let http = transport(pages);
        let (_, prs) = fetch_watched(
            &http,
            &AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap(),
            WatchMode::Both,
            &[],
        )
        .unwrap();
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].role, PrRole::Author);
        assert!(http.urls.borrow()[1]
            .query()
            .unwrap()
            .contains("searchCriteria.creatorId=me"));
    }

    #[test]
    fn inbox_provider_resolves_pull_requests_that_left_the_active_search() {
        let http = transport(vec![
            Ok(json!({"authenticatedUser":{"id":"me"}})),
            Ok(json!({"value":[]})),
            Ok(
                json!({"pullRequestId":7,"title":"Merged","createdBy":{"displayName":"Author"},
                "status":"completed","repository":{"project":{"id":"guid"}},"reviewers":[]}),
            ),
        ]);
        let (_, prs) = fetch_watched(
            &http,
            &AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap(),
            WatchMode::Reviewer,
            &[7],
        )
        .unwrap();
        assert_eq!(prs[0].status, "completed");
        assert!(
            prs[0].deep.is_none(),
            "a closed PR is not worth two more requests"
        );
    }

    #[test]
    fn inbox_provider_caps_how_many_pull_requests_are_read_in_depth() {
        let listed: Vec<_> = (1..=DEEP_POLL_CAP as u64 + 3)
            .map(|id| wire_pr(id, "me", false, false))
            .collect();
        let mut pages = vec![
            Ok(json!({"authenticatedUser":{"id":"me"}})),
            Ok(json!({ "value": listed })),
            Ok(json!({"value":[]})),
        ];
        for _ in 0..DEEP_POLL_CAP {
            pages.extend(wire_detail());
        }
        let http = transport(pages);
        let (_, prs) = fetch_watched(
            &http,
            &AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap(),
            WatchMode::Reviewer,
            &[],
        )
        .unwrap();
        assert_eq!(prs.len(), DEEP_POLL_CAP + 3);
        assert_eq!(
            prs.iter().filter(|p| p.deep.is_some()).count(),
            DEEP_POLL_CAP
        );
        // Newest first, so the cap drops the stalest PRs rather than arbitrary ones.
        assert!(prs[..DEEP_POLL_CAP].iter().all(|p| p.id > 3));
    }

    #[test]
    fn inbox_provider_reads_threads_votes_and_gates_and_labels_system_entries() {
        let mut pages = vec![
            Ok(json!({"authenticatedUser":{"id":"me"}})),
            Ok(json!({"value":[wire_pr(1,"me",false,false)]})),
            Ok(json!({"value":[]})),
            Ok(json!({"value":[
                {"id":4,"isDeleted":false,"comments":[
                    {"id":1,"commentType":"text","content":"Looks good","publishedDate":"2026-01-02T00:00:00Z",
                        "author":{"id":"dev","displayName":"Dev"}},
                    {"id":2,"commentType":"system","content":"Dev voted 10","publishedDate":"2026-01-03T00:00:00Z",
                        "author":{"id":"dev","displayName":"Dev"}},
                    {"id":3,"commentType":"text","content":"gone","publishedDate":"2026-01-04T00:00:00Z",
                        "isDeleted":true,"author":{"id":"dev","displayName":"Dev"}}]},
                {"id":5,"isDeleted":true,"comments":[
                    {"id":1,"commentType":"text","content":"hidden","publishedDate":"2026-01-05T00:00:00Z",
                        "author":{"id":"dev","displayName":"Dev"}}]}]})),
            Ok(json!({"value":[
                {"evaluationId":"e1","status":"rejected",
                    "configuration":{"settings":{"displayName":"CI build"},"type":{"displayName":"Build"}}},
                {"evaluationId":"e2","status":"queued","configuration":{"type":{"displayName":"Required reviewers"}}},
                {"status":"approved"}]})),
        ];
        pages.truncate(5);
        let http = transport(pages);
        let (_, prs) = fetch_watched(
            &http,
            &AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap(),
            WatchMode::Reviewer,
            &[],
        )
        .unwrap();
        let detail = prs[0].deep.as_ref().unwrap();
        assert_eq!(detail.comments.len(), 2);
        assert_eq!(detail.comments[0].thread_id, 4);
        assert!(!detail.comments[0].is_system);
        assert!(detail.comments[1].is_system);
        assert_eq!(detail.votes.len(), 1);
        assert_eq!(
            detail
                .policies
                .iter()
                .map(|p| (p.name.as_str(), p.status.as_str()))
                .collect::<Vec<_>>(),
            vec![("CI build", "rejected"), ("Required reviewers", "queued")]
        );
    }

    #[test]
    fn inbox_provider_never_accepts_failed_or_malformed_partial_snapshots() {
        let repo = AdoRepo::parse("https://dev.azure.com/org/proj/_git/repo").unwrap();
        for last in [
            Err("Connection failed".into()),
            Ok(json!({"unexpected":[]})),
            Ok(json!({"value":[wire_pr(1,"me",false,false)]})),
        ] {
            let http = transport(vec![
                Ok(json!({"authenticatedUser":{"id":"me"}})),
                Ok(json!({"value":[wire_pr(1,"me",false,false)]})),
                last,
            ]);
            assert!(fetch_watched(&http, &repo, WatchMode::Reviewer, &[]).is_err());
        }
        // A thread or gate read that fails must sink the whole pass: a PR
        // reported with an empty comment list would silently move its watermark
        // forward and swallow the discussion it could not read.
        for detail in [Err("Threads unavailable".into()), Ok(json!({"nope":[]}))] {
            let http = transport(vec![
                Ok(json!({"authenticatedUser":{"id":"me"}})),
                Ok(json!({"value":[wire_pr(1,"me",false,false)]})),
                Ok(json!({"value":[]})),
                detail,
            ]);
            assert!(fetch_watched(&http, &repo, WatchMode::Reviewer, &[]).is_err());
        }
        let http = transport(vec![Ok(json!({"authenticatedUser":{"id":""}}))]);
        assert!(fetch_watched(&http, &repo, WatchMode::Reviewer, &[]).is_err());
    }

    #[test]
    fn inbox_failed_poll_does_not_establish_baseline_and_drafts_can_become_ready() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let target = targets(&db).unwrap().remove(0);
        record_error(&db, &target, "Run az login").unwrap();
        assert_eq!(
            snapshot(&db).unwrap().repos[0].error.as_deref(),
            Some("Run az login")
        );
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        assert!(snapshot(&db).unwrap().items.is_empty());
        // The provider omits draft PR 2 until ready.
        apply_snapshot(&mut db, &target, "me", &[pr(1), pr(2)]).unwrap();
        let state = snapshot(&db).unwrap();
        assert_eq!(state.items[0].pr_id, 2);
        assert!(state.repos[0].error.is_none());
        assert!(state.repos[0].last_checked.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn inbox_token_command_is_bounded_and_never_returns_raw_credentials_in_errors() {
        use std::process::Command;
        use std::time::Duration;
        let mut valid = Command::new("sh");
        valid.args(["-c", "printf '{\"accessToken\":\"test-token\"}'"]);
        assert_eq!(
            read_azure_token(&mut valid, Duration::from_secs(1)).unwrap(),
            "test-token"
        );
        for script in [
            "printf 'SECRET malformed output'",
            "printf 'SECRET stderr' >&2; exit 1",
            "printf '{\"accessToken\":\"\"}'",
        ] {
            let mut command = Command::new("sh");
            command.args(["-c", script]);
            let error = read_azure_token(&mut command, Duration::from_secs(1)).unwrap_err();
            assert!(error.contains("az login"));
            assert!(!error.contains("SECRET"));
        }
        let mut slow = Command::new("sh");
        slow.args(["-c", "exec sleep 2"]);
        assert!(read_azure_token(&mut slow, Duration::from_millis(20))
            .unwrap_err()
            .contains("timed out"));
    }

    #[test]
    fn inbox_http_transport_sends_bearer_and_refuses_redirects_and_auth_errors() {
        use std::io::{Read, Write};
        for (status, body) in [
            ("200 OK", "{\"value\":[]}"),
            ("302 Found", "SECRET"),
            ("401 Unauthorized", "SECRET"),
            ("200 OK", "SECRET"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = [0; 4096];
                let len = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..len]).to_ascii_lowercase();
                assert!(request.contains("authorization: bearer test-token"));
                write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: https://example.invalid/\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            let http = AdoTransport {
                client: reqwest::blocking::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(2))
                    .build()
                    .unwrap(),
                token: "test-token".into(),
            };
            let result = http.get(reqwest::Url::parse(&url).unwrap());
            if body == "{\"value\":[]}" {
                assert!(result.is_ok());
            } else {
                let error = result.unwrap_err();
                assert!(!error.contains("SECRET"));
                if status.starts_with("401") {
                    assert!(error.contains("az login"));
                }
                if status.starts_with("302") {
                    assert!(error.contains("302"));
                }
            }
            server.join().unwrap();
        }
    }

    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        db.execute("INSERT INTO projects (id,name,directory,git_remote,color,created_at,updated_at)
            VALUES ('p','Repo','/repo','https://dev.azure.com/org/project/_git/repo','#fff','t','t')", []).unwrap();
        db
    }

    /// A review assignment with no deep state read yet.
    fn pr(id: u64) -> WatchedPr {
        WatchedPr {
            id,
            title: format!("PR {id}"),
            author: "Author".into(),
            role: PrRole::Reviewer,
            status: "active".into(),
            deep: None,
        }
    }

    fn mine(id: u64) -> WatchedPr {
        WatchedPr {
            role: PrRole::Author,
            ..pr(id)
        }
    }

    fn comment(thread: i64, id: i64, author: &str, at: &str) -> PrComment {
        PrComment {
            thread_id: thread,
            id,
            published_at: at.into(),
            author_id: author.into(),
            author: format!("{author} display"),
            text: format!("Comment {id}"),
            is_system: false,
        }
    }

    fn with_detail(pr: WatchedPr, detail: PrDetail) -> WatchedPr {
        WatchedPr {
            deep: Some(detail),
            ..pr
        }
    }

    fn kinds(db: &Connection) -> Vec<(String, u64)> {
        snapshot(db)
            .unwrap()
            .items
            .into_iter()
            .map(|i| (i.kind, i.pr_id))
            .collect()
    }

    #[test]
    fn inbox_baselines_silently_then_deduplicates_and_preserves_read_state() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        assert!(snapshot(&db).unwrap().items.is_empty());
        apply_snapshot(&mut db, &target, "me", &[pr(1), pr(2)]).unwrap();
        let item = snapshot(&db).unwrap().items.remove(0);
        assert_eq!(item.pr_id, 2);
        assert!(!item.is_read);
        set_read(&db, &item.id, true).unwrap();
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        apply_snapshot(&mut db, &target, "me", &[pr(2)]).unwrap();
        let items = snapshot(&db).unwrap().items;
        assert_eq!(items.len(), 1);
        assert!(items[0].is_read);
        set_read(&db, &item.id, false).unwrap();
        assert!(!snapshot(&db).unwrap().items[0].is_read);
    }

    #[test]
    fn inbox_disabled_or_changed_configuration_rejects_in_flight_results() {
        let mut db = db();
        assert!(targets(&db).unwrap().is_empty());
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let old = targets(&db).unwrap().remove(0);
        configure(&db, "p", WatchMode::Off).unwrap();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        apply_snapshot(&mut db, &old, "me", &[]).unwrap();
        let current = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &current, "me", &[pr(1)]).unwrap();
        assert!(
            snapshot(&db).unwrap().items.is_empty(),
            "stale result must not establish baseline"
        );
    }

    #[test]
    fn inbox_identity_changes_start_a_silent_separate_baseline() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        apply_snapshot(&mut db, &target, "other", &[pr(2)]).unwrap();
        assert!(snapshot(&db).unwrap().items.is_empty());
        apply_snapshot(&mut db, &target, "other", &[pr(2), pr(3)]).unwrap();
        assert_eq!(snapshot(&db).unwrap().items[0].pr_id, 3);
    }

    #[test]
    fn inbox_reports_comments_from_others_once_and_never_the_users_own() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        // First sight of the PR *and* of its thread: both silent.
        let first = with_detail(
            pr(1),
            PrDetail {
                comments: vec![comment(1, 1, "dev", "2026-01-01T00:00:00Z")],
                ..Default::default()
            },
        );
        apply_snapshot(&mut db, &target, "me", std::slice::from_ref(&first)).unwrap();
        assert_eq!(kinds(&db), vec![("assigned".into(), 1)]);

        let second = with_detail(
            pr(1),
            PrDetail {
                comments: vec![
                    comment(1, 1, "dev", "2026-01-01T00:00:00Z"),
                    comment(1, 2, "dev", "2026-01-02T00:00:00Z"),
                    comment(2, 1, "ME", "2026-01-03T00:00:00Z"),
                    PrComment {
                        is_system: true,
                        ..comment(2, 2, "dev", "2026-01-04T00:00:00Z")
                    },
                ],
                ..Default::default()
            },
        );
        apply_snapshot(&mut db, &target, "me", std::slice::from_ref(&second)).unwrap();
        let items = snapshot(&db).unwrap().items;
        let comments: Vec<_> = items.iter().filter(|i| i.kind == "comment").collect();
        assert_eq!(comments.len(), 1, "own and system entries stay quiet");
        assert!(comments[0].summary.contains("dev display commented"));

        // Replaying the same page must not repeat the notification, and the
        // watermark must have cleared the user's own later comment too.
        apply_snapshot(&mut db, &target, "me", &[second]).unwrap();
        assert_eq!(
            snapshot(&db)
                .unwrap()
                .items
                .iter()
                .filter(|i| i.kind == "comment")
                .count(),
            1
        );
    }

    #[test]
    fn inbox_reports_vote_and_build_gate_transitions_but_not_unsettled_ones() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        let base = PrDetail {
            votes: vec![PrVote {
                reviewer_id: "dev".into(),
                reviewer: "Dev".into(),
                vote: 0,
            }],
            policies: vec![PrPolicy {
                id: "e1".into(),
                name: "CI build".into(),
                status: "queued".into(),
            }],
            ..Default::default()
        };
        apply_snapshot(&mut db, &target, "me", &[with_detail(pr(1), base.clone())]).unwrap();
        apply_snapshot(&mut db, &target, "me", &[with_detail(pr(1), base)]).unwrap();
        assert_eq!(kinds(&db), vec![("assigned".into(), 1)], "nothing changed");

        let moved = PrDetail {
            votes: vec![PrVote {
                reviewer_id: "DEV".into(),
                reviewer: "Dev".into(),
                vote: 10,
            }],
            policies: vec![
                PrPolicy {
                    id: "e1".into(),
                    name: "CI build".into(),
                    status: "rejected".into(),
                },
                PrPolicy {
                    id: "e2".into(),
                    name: "Linting".into(),
                    status: "running".into(),
                },
            ],
            ..Default::default()
        };
        apply_snapshot(&mut db, &target, "me", &[with_detail(pr(1), moved.clone())]).unwrap();
        let items = snapshot(&db).unwrap().items;
        let vote = items.iter().find(|i| i.kind == "vote").unwrap();
        assert_eq!(vote.summary, "Dev approved");
        let gates: Vec<_> = items.iter().filter(|i| i.kind == "policy").collect();
        assert_eq!(gates.len(), 1, "queued and running are not outcomes");
        assert_eq!(gates[0].summary, "CI build failed");

        apply_snapshot(&mut db, &target, "me", &[with_detail(pr(1), moved)]).unwrap();
        assert_eq!(
            snapshot(&db)
                .unwrap()
                .items
                .iter()
                .filter(|i| i.kind == "vote" || i.kind == "policy")
                .count(),
            2
        );
    }

    #[test]
    fn inbox_announces_closure_once_when_a_watched_pr_leaves_the_active_set() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &target, "me", &[]).unwrap();
        apply_snapshot(&mut db, &target, "me", &[pr(1)]).unwrap();
        assert_eq!(watching(&db, &target).unwrap(), vec![1]);

        let completed = WatchedPr {
            status: "completed".into(),
            ..pr(1)
        };
        apply_snapshot(&mut db, &target, "me", std::slice::from_ref(&completed)).unwrap();
        apply_snapshot(&mut db, &target, "me", &[completed]).unwrap();
        let closed: Vec<_> = snapshot(&db)
            .unwrap()
            .items
            .into_iter()
            .filter(|i| i.kind == "closed")
            .collect();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].summary, "Pull request completed");
        assert!(
            watching(&db, &target).unwrap().is_empty(),
            "a closed PR is no longer followed"
        );
    }

    #[test]
    fn inbox_widening_to_authored_prs_starts_its_own_silent_baseline() {
        let mut db = db();
        configure(&db, "p", WatchMode::Reviewer).unwrap();
        let reviewer_only = targets(&db).unwrap().remove(0);
        apply_snapshot(&mut db, &reviewer_only, "me", &[]).unwrap();
        apply_snapshot(&mut db, &reviewer_only, "me", &[pr(1)]).unwrap();
        assert_eq!(kinds(&db), vec![("assigned".into(), 1)]);

        // Turning on authored PRs must not announce the back catalogue.
        configure(&db, "p", WatchMode::Both).unwrap();
        let both = targets(&db).unwrap().remove(0);
        assert_eq!(both.mode, WatchMode::Both);
        apply_snapshot(&mut db, &both, "me", &[pr(1), mine(2), mine(3)]).unwrap();
        assert_eq!(kinds(&db), vec![("assigned".into(), 1)]);

        // Authored PRs never produce an arrival event -- the user opened them --
        // but they are watched from here on.
        apply_snapshot(&mut db, &both, "me", &[pr(1), mine(2), mine(3), mine(4)]).unwrap();
        assert_eq!(kinds(&db), vec![("assigned".into(), 1)]);
        assert_eq!(watching(&db, &both).unwrap(), vec![4, 3, 2, 1]);
    }

    #[test]
    fn inbox_watch_modes_round_trip_and_reject_nonsense() {
        for (text, mode) in [
            ("off", WatchMode::Off),
            ("Reviewer", WatchMode::Reviewer),
            ("authored", WatchMode::Author),
            ("both", WatchMode::Both),
        ] {
            assert_eq!(WatchMode::parse(text).unwrap(), mode);
            assert_eq!(WatchMode::parse(mode.as_str()).unwrap(), mode);
        }
        assert!(WatchMode::parse("sometimes").is_err());
        assert!(WatchMode::Reviewer.watches(PrRole::Reviewer));
        assert!(!WatchMode::Reviewer.watches(PrRole::Author));
        assert!(WatchMode::Author.watches(PrRole::Author));
        assert!(!WatchMode::Author.watches(PrRole::Reviewer));
        assert!(
            WatchMode::Both.watches(PrRole::Reviewer) && WatchMode::Both.watches(PrRole::Author)
        );
        assert!(!WatchMode::Off.watches(PrRole::Reviewer));
    }

    #[test]
    fn inbox_comment_excerpts_stay_to_a_single_bounded_line() {
        assert_eq!(excerpt("  hello\n  world  "), "hello world");
        let long = "x".repeat(400);
        let short = excerpt(&long);
        assert_eq!(short.chars().count(), 140);
        assert!(short.ends_with('…'));
    }

    #[test]
    fn inbox_configuration_rejects_unknown_or_non_ado_repositories() {
        let db = db();
        assert!(configure(&db, "missing", WatchMode::Reviewer).is_err());
        db.execute(
            "UPDATE projects SET git_remote='https://github.com/org/repo'",
            [],
        )
        .unwrap();
        assert!(configure(&db, "p", WatchMode::Reviewer).is_err());
        assert!(targets(&db).unwrap().is_empty());
    }

    #[test]
    fn inbox_remote_parser_accepts_ado_clone_formats_only() {
        for remote in [
            "https://user@dev.azure.com/org/project/_git/repo",
            "https://org.visualstudio.com/project/_git/repo",
            "git@ssh.dev.azure.com:v3/org/project/repo",
            "ssh://git@ssh.dev.azure.com/v3/org/project/repo",
        ] {
            let repo = AdoRepo::parse(remote).unwrap();
            assert_eq!(
                repo.web_url(42),
                "https://dev.azure.com/org/project/_git/repo/pullrequest/42"
            );
        }
        for remote in [
            "https://github.com/org/project/_git/repo",
            "https://dev.azure.com.evil.example/org/project/_git/repo",
            "http://dev.azure.com/org/project/_git/repo",
            "https://dev.azure.com/org/project/_git/repo/extra",
        ] {
            assert!(AdoRepo::parse(remote).is_err(), "{remote}");
        }
    }
}

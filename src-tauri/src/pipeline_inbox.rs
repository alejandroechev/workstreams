//! Pipeline notifications (ADR 038).
//!
//! You paste a link to an Azure DevOps pipeline (or one of its runs), pick a
//! mode, and each run that finishes afterwards with a result the mode watches
//! becomes a notification in the Inbox, next to the PR ones. Checks run in the
//! PR inbox's poller pass, with the same Azure CLI token and HTTP rules
//! (ADR 030); nothing here holds the database lock during network work.

use crate::pr_inbox::JsonTransport;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Which finished runs of a pipeline notify.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PipelineMode {
    Off,
    Failures,
    Successes,
    Both,
}

impl PipelineMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "off" | "none" => Ok(Self::Off),
            "failures" | "failure" | "failed" => Ok(Self::Failures),
            "successes" | "success" | "succeeded" => Ok(Self::Successes),
            "both" | "all" => Ok(Self::Both),
            other => Err(format!(
                "Unknown pipeline mode '{other}'; expected off, failures, successes or both"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Failures => "failures",
            Self::Successes => "successes",
            Self::Both => "both",
        }
    }

    /// Only `failed` is a failure and only `succeeded` a success; partial
    /// successes and cancels never notify (the grill's B3).
    fn watches(self, result: &str) -> bool {
        matches!(
            (self, result),
            (Self::Failures | Self::Both, "failed") | (Self::Successes | Self::Both, "succeeded")
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkTarget {
    Run(u64),
    Definition(u64),
}

/// What a pasted link points at, before asking ADO anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PipelineLink {
    pub organization: String,
    pub project: String,
    pub target: LinkTarget,
}

const NOT_A_PIPELINE_LINK: &str =
    "That isn't an Azure DevOps pipeline or run link. Paste a link to a pipeline (…/_build?definitionId=…) or one of its runs (…/_build/results?buildId=…).";

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains(['/', '\\'])
        && !s.chars().any(char::is_control)
}

/// Reads `https://dev.azure.com/<org>/<project>/_build…` or
/// `https://<org>.visualstudio.com/<project>/_build…`, with `buildId=` (a run)
/// or `definitionId=` (the pipeline).
pub fn parse_link(text: &str) -> Result<PipelineLink, String> {
    let url = reqwest::Url::parse(text.trim()).map_err(|_| NOT_A_PIPELINE_LINK)?;
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return Err(NOT_A_PIPELINE_LINK.into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let path: Vec<String> = url
        .path()
        .trim_matches('/')
        .split('/')
        .map(crate::pull_requests::percent_decode)
        .collect();
    let (organization, rest) = if host == "dev.azure.com" && path.len() >= 3 {
        (path[0].clone(), &path[1..])
    } else if let Some(org) = host.strip_suffix(".visualstudio.com") {
        if org.contains('.') || path.len() < 2 {
            return Err(NOT_A_PIPELINE_LINK.into());
        }
        (org.to_string(), &path[..])
    } else {
        return Err(NOT_A_PIPELINE_LINK.into());
    };
    let project = rest[0].clone();
    if rest.get(1).map(String::as_str) != Some("_build")
        || !valid_segment(&organization)
        || !valid_segment(&project)
    {
        return Err(NOT_A_PIPELINE_LINK.into());
    }
    let query = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.into_owned())
    };
    let id = |value: String| {
        value
            .parse::<u64>()
            .map_err(|_| NOT_A_PIPELINE_LINK.to_string())
    };
    let target = if let Some(run) = query("buildId") {
        LinkTarget::Run(id(run)?)
    } else if let Some(definition) = query("definitionId") {
        LinkTarget::Definition(id(definition)?)
    } else {
        return Err(NOT_A_PIPELINE_LINK.into());
    };
    Ok(PipelineLink {
        organization,
        project,
        target,
    })
}

/// A pipeline as ADO names it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResolvedPipeline {
    pub organization: String,
    pub project_id: String,
    pub project_name: String,
    pub definition_id: u64,
    pub name: String,
}

/// `https://dev.azure.com/<org>/<project>/<segments…>`. Requests always go to
/// dev.azure.com, whatever host the pasted link used, and never follow a URL
/// the provider returned.
fn ado_url(organization: &str, project: &str, segments: &[&str]) -> reqwest::Url {
    let mut url = reqwest::Url::parse("https://dev.azure.com/").expect("constant URL");
    url.path_segments_mut()
        .expect("HTTPS base")
        .pop_if_empty()
        .push(organization)
        .push(project)
        .extend(segments.iter().copied());
    url
}

fn api_get(http: &dyn JsonTransport, mut url: reqwest::Url) -> Result<serde_json::Value, String> {
    url.query_pairs_mut().append_pair("api-version", "7.1");
    http.get(url).map_err(|error| {
        if error.contains("HTTP 404") {
            "That pipeline or run wasn't found, or your Azure CLI account can't see it.".into()
        } else {
            error
        }
    })
}

/// Turns a link into the pipeline it belongs to: a run link costs one extra
/// request to learn its pipeline.
pub(crate) fn resolve(
    http: &dyn JsonTransport,
    link: &PipelineLink,
) -> Result<ResolvedPipeline, String> {
    let (org, project) = (&link.organization, &link.project);
    let definition_id = match link.target {
        LinkTarget::Definition(id) => id,
        LinkTarget::Run(run) => {
            let build = api_get(
                http,
                ado_url(
                    org,
                    project,
                    &["_apis", "build", "builds", &run.to_string()],
                ),
            )?;
            build["definition"]["id"]
                .as_u64()
                .ok_or("ADO didn't say which pipeline that run belongs to")?
        }
    };
    let definition = api_get(
        http,
        ado_url(
            org,
            project,
            &["_apis", "build", "definitions", &definition_id.to_string()],
        ),
    )?;
    let text =
        |value: &serde_json::Value| value.as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    Ok(ResolvedPipeline {
        organization: org.clone(),
        project_id: text(&definition["project"]["id"])
            .ok_or("ADO returned a pipeline without a project")?,
        project_name: text(&definition["project"]["name"]).unwrap_or_else(|| project.clone()),
        definition_id,
        name: text(&definition["name"]).ok_or("ADO returned a pipeline without a name")?,
    })
}

/// Resolves a pasted link, network included. A trait so the agent CLI and the
/// Tauri command share one path and tests can stub ADO.
pub trait PipelineResolver: Send + Sync {
    fn resolve(&self, link: &str) -> Result<ResolvedPipeline, String>;
}

/// The real resolver: the Azure CLI token and the PR inbox's HTTP rules.
pub struct AdoResolver;

impl PipelineResolver for AdoResolver {
    fn resolve(&self, link: &str) -> Result<ResolvedPipeline, String> {
        // A bad link is refused before asking the Azure CLI for anything.
        let link = parse_link(link)?;
        let http = crate::pr_inbox::AdoTransport::connect()?;
        resolve(&http, &link)
    }
}

// ── Store ───────────────────────────────────────────────────────────────

/// A watched pipeline, as the Pipelines manager shows it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PipelineStatus {
    pub id: String,
    pub organization: String,
    pub project: String,
    pub definition_id: u64,
    pub name: String,
    /// The pipeline's page in ADO.
    pub url: String,
    pub mode: PipelineMode,
    pub last_result: Option<String>,
    pub last_run_number: Option<String>,
    pub last_run_url: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_checked: Option<String>,
    pub error: Option<String>,
}

/// One notification: a run that finished with a result the mode watches.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PipelineItem {
    pub id: String,
    pub pipeline_id: String,
    pub pipeline_name: String,
    pub project: String,
    pub run_id: u64,
    pub run_number: String,
    pub result: String,
    pub branch: String,
    pub trigger: String,
    pub finished_at: String,
    /// The run's results page in ADO.
    pub url: String,
    pub is_read: bool,
    pub discovered_at: String,
}

fn pipeline_url(org: &str, project: &str, definition_id: u64) -> String {
    let mut url = ado_url(org, project, &["_build"]);
    url.query_pairs_mut()
        .append_pair("definitionId", &definition_id.to_string());
    url.to_string()
}

fn run_url(org: &str, project: &str, run_id: u64) -> String {
    let mut url = ado_url(org, project, &["_build", "results"]);
    url.query_pairs_mut()
        .append_pair("buildId", &run_id.to_string());
    url.to_string()
}

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// Starts watching a pipeline (default mode: failures). Runs that finished
/// before now never notify.
pub fn add(
    db: &Connection,
    pipeline: &ResolvedPipeline,
    mode: Option<PipelineMode>,
) -> Result<PipelineStatus, String> {
    let existing: Option<String> = db
        .query_row(
            "SELECT name FROM pipeline_watches WHERE organization=?1 COLLATE NOCASE
            AND project_id=?2 COLLATE NOCASE AND definition_id=?3",
            params![
                pipeline.organization,
                pipeline.project_id,
                pipeline.definition_id
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(name) = existing {
        return Err(format!("Already watching “{name}”."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        &format!(
            "INSERT INTO pipeline_watches(id,organization,project_id,project_name,definition_id,name,mode,created_at,notify_after)
            VALUES (?1,?2,?3,?4,?5,?6,?7,{NOW},{NOW})"
        ),
        params![
            id,
            pipeline.organization,
            pipeline.project_id,
            pipeline.project_name,
            pipeline.definition_id,
            pipeline.name,
            mode.unwrap_or(PipelineMode::Failures).as_str()
        ],
    )
    .map_err(|e| e.to_string())?;
    list(db)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "The pipeline was not saved".into())
}

/// Changes what notifies. Restarts the quiet period, so runs that finished
/// under the old mode (including while Off) are never replayed.
pub fn set_mode(db: &Connection, id: &str, mode: PipelineMode) -> Result<(), String> {
    let changed = db
        .execute(
            &format!(
                "UPDATE pipeline_watches SET mode=?2, notify_after={NOW}, revision=revision+1, error=NULL WHERE id=?1"
            ),
            params![id, mode.as_str()],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That pipeline isn't watched".into());
    }
    Ok(())
}

/// Stops watching a pipeline and drops its notifications.
pub fn remove(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM pipeline_events WHERE watch_id=?1", [id])
        .map_err(|e| e.to_string())?;
    let changed = db
        .execute("DELETE FROM pipeline_watches WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That pipeline isn't watched".into());
    }
    Ok(())
}

pub fn list(db: &Connection) -> Result<Vec<PipelineStatus>, String> {
    let mut stmt = db
        .prepare(
            "SELECT id,organization,project_name,definition_id,name,mode,last_result,last_run_number,
            last_run_id,last_finished_at,last_checked,error
            FROM pipeline_watches ORDER BY name COLLATE NOCASE, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let org: String = r.get(1)?;
            let project: String = r.get(2)?;
            let definition_id: u64 = r.get(3)?;
            let mode: String = r.get(5)?;
            let last_run: Option<u64> = r.get(8)?;
            Ok(PipelineStatus {
                id: r.get(0)?,
                url: pipeline_url(&org, &project, definition_id),
                last_run_url: last_run.map(|run| run_url(&org, &project, run)),
                organization: org,
                project,
                definition_id,
                name: r.get(4)?,
                mode: PipelineMode::parse(&mode).unwrap_or(PipelineMode::Failures),
                last_result: r.get(6)?,
                last_run_number: r.get(7)?,
                last_finished_at: r.get(9)?,
                last_checked: r.get(10)?,
                error: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Every pipeline notification, newest run first.
pub fn items(db: &Connection) -> Result<Vec<PipelineItem>, String> {
    let mut stmt = db
        .prepare(
            "SELECT e.id,w.id,w.name,w.organization,w.project_name,e.run_id,e.run_number,e.result,
            e.branch,e.trigger_label,e.finished_at,e.is_read,e.created_at
            FROM pipeline_events e JOIN pipeline_watches w ON w.id=e.watch_id
            ORDER BY julianday(e.finished_at) DESC, e.run_id DESC, e.created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let org: String = r.get(3)?;
            let project: String = r.get(4)?;
            let run_id: u64 = r.get(5)?;
            Ok(PipelineItem {
                id: r.get(0)?,
                pipeline_id: r.get(1)?,
                pipeline_name: r.get(2)?,
                url: run_url(&org, &project, run_id),
                project,
                run_id,
                run_number: r.get(6)?,
                result: r.get(7)?,
                branch: r.get(8)?,
                trigger: r.get(9)?,
                finished_at: r.get(10)?,
                is_read: r.get(11)?,
                discovered_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Marks a pipeline notification read or unread. `false` when there is no
/// such notification, so the caller can try the PR events.
pub fn set_read(db: &Connection, id: &str, is_read: bool) -> Result<bool, String> {
    db.execute(
        "UPDATE pipeline_events SET is_read=?2 WHERE id=?1",
        params![id, is_read],
    )
    .map(|n| n > 0)
    .map_err(|e| e.to_string())
}

// ── Checking ────────────────────────────────────────────────────────────

/// One watched pipeline as the poller sees it, at one configuration revision.
#[derive(Clone, Debug)]
pub struct PipelineTarget {
    pub id: String,
    pub organization: String,
    pub project_id: String,
    pub definition_id: u64,
    revision: i64,
}

impl PipelineTarget {
    /// What the poller compares to notice a change within seconds.
    pub fn fingerprint(&self) -> (String, String, i64) {
        (
            format!("pipeline:{}", self.id),
            String::new(),
            self.revision,
        )
    }
}

/// Every watched pipeline, Off ones included: their last result stays current.
pub fn targets(db: &Connection) -> Result<Vec<PipelineTarget>, String> {
    let mut stmt = db
        .prepare(
            "SELECT id,organization,project_id,definition_id,revision FROM pipeline_watches ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PipelineTarget {
                id: r.get(0)?,
                organization: r.get(1)?,
                project_id: r.get(2)?,
                definition_id: r.get(3)?,
                revision: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// A finished run.
#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    pub id: u64,
    pub number: String,
    pub result: String,
    pub branch: String,
    pub trigger: String,
    pub finished_at: String,
}

fn trigger_label(reason: &str, requester: Option<&str>) -> String {
    match reason {
        "schedule" => "Scheduled".into(),
        "manual" => match requester.filter(|n| !n.is_empty()) {
            Some(name) => format!("Manual · {name}"),
            None => "Manual".into(),
        },
        "individualCI" | "batchedCI" => "CI".into(),
        "pullRequest" => "PR".into(),
        "resourceTrigger" | "buildCompletion" => "Pipeline trigger".into(),
        "" => "Unknown".into(),
        other => other.into(),
    }
}

/// The newest finished runs of a pipeline (one request). These pipelines run
/// rarely, so 50 always covers the gap between two checks.
pub(crate) fn fetch_runs(
    http: &dyn JsonTransport,
    target: &PipelineTarget,
) -> Result<Vec<Run>, String> {
    let mut url = ado_url(
        &target.organization,
        &target.project_id,
        &["_apis", "build", "builds"],
    );
    url.query_pairs_mut()
        .append_pair("definitions", &target.definition_id.to_string())
        .append_pair("statusFilter", "completed")
        .append_pair("queryOrder", "finishTimeDescending")
        .append_pair("$top", "50");
    let body = api_get(http, url)?;
    let runs = body["value"].as_array().ok_or("ADO returned no run list")?;
    Ok(runs
        .iter()
        .filter_map(|run| {
            let text = |key: &str| run[key].as_str().unwrap_or("").to_string();
            let result = text("result");
            let finished_at = text("finishTime");
            if result.is_empty() || finished_at.is_empty() {
                return None;
            }
            let branch = text("sourceBranch");
            Some(Run {
                id: run["id"].as_u64()?,
                number: text("buildNumber"),
                result,
                branch: branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(&branch)
                    .to_string(),
                trigger: trigger_label(
                    &text("reason"),
                    run["requestedFor"]["displayName"].as_str(),
                ),
                finished_at,
            })
        })
        .collect())
}

fn still_current(db: &Connection, target: &PipelineTarget) -> Result<bool, String> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pipeline_watches WHERE id=?1 AND revision=?2)",
        params![target.id, target.revision],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Records a check: the newest run becomes the last result, and each run that
/// finished after the quiet period with a watched result notifies, once per
/// (run, result). Nothing is written if the pipeline changed meanwhile.
/// Returns how many notifications were added.
pub fn apply_runs(db: &Connection, target: &PipelineTarget, runs: &[Run]) -> Result<usize, String> {
    if !still_current(db, target)? {
        return Ok(0);
    }
    let mode: String = db
        .query_row(
            "SELECT mode FROM pipeline_watches WHERE id=?1",
            [&target.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mode = PipelineMode::parse(&mode).unwrap_or(PipelineMode::Failures);
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let newest = runs
        .iter()
        .max_by(|a, b| a.finished_at.cmp(&b.finished_at).then(a.id.cmp(&b.id)));
    if let Some(run) = newest {
        tx.execute(
            "UPDATE pipeline_watches SET last_run_id=?2,last_run_number=?3,last_result=?4,last_finished_at=?5 WHERE id=?1",
            params![target.id, run.id, run.number, run.result, run.finished_at],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        &format!("UPDATE pipeline_watches SET last_checked={NOW}, error=NULL WHERE id=?1"),
        [&target.id],
    )
    .map_err(|e| e.to_string())?;
    let mut added = 0;
    for run in runs.iter().filter(|run| mode.watches(&run.result)) {
        added += tx
            .execute(
                &format!(
                    "INSERT OR IGNORE INTO pipeline_events(id,watch_id,run_id,run_number,result,branch,trigger_label,finished_at,created_at)
                    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,{NOW} FROM pipeline_watches
                    WHERE id=?2 AND julianday(?8) > julianday(notify_after)"
                ),
                params![
                    uuid::Uuid::new_v4().to_string(),
                    target.id,
                    run.id,
                    run.number,
                    run.result,
                    run.branch,
                    run.trigger,
                    run.finished_at
                ],
            )
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(added)
}

/// Shows why a check failed, on that pipeline only.
pub fn record_error(db: &Connection, target: &PipelineTarget, error: &str) -> Result<(), String> {
    if still_current(db, target)? {
        db.execute(
            &format!("UPDATE pipeline_watches SET error=?2, last_checked={NOW} WHERE id=?1"),
            params![target.id, error],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Checks every watched pipeline once, each on its own: one failure is
/// recorded on that pipeline and never stops the others.
pub(crate) fn check_all(
    db: &std::sync::Mutex<Connection>,
    http: Result<&dyn JsonTransport, &str>,
    targets: &[PipelineTarget],
) {
    for target in targets {
        let result = http
            .map_err(str::to_owned)
            .and_then(|http| fetch_runs(http, target));
        let saved = db
            .lock()
            .map_err(|e| e.to_string())
            .and_then(|db| match &result {
                Ok(runs) => apply_runs(&db, target, runs).map(|_| ()),
                Err(error) => record_error(&db, target, error),
            });
        if let Err(error) = saved {
            eprintln!("[pipeline-inbox] Could not save check: {error}");
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn
    }

    /// Serves canned JSON by URL path, and records what was asked.
    struct Stub {
        routes: Vec<(&'static str, Result<serde_json::Value, String>)>,
        asked: RefCell<Vec<String>>,
    }
    impl Stub {
        fn new(routes: Vec<(&'static str, Result<serde_json::Value, String>)>) -> Self {
            Self {
                routes,
                asked: RefCell::new(Vec::new()),
            }
        }
    }
    impl JsonTransport for Stub {
        fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
            self.asked.borrow_mut().push(url.to_string());
            self.routes
                .iter()
                .find(|(path, _)| url.path().ends_with(path))
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| Err(format!("ADO returned HTTP 404. ({})", url.path())))
        }
    }

    fn definition(id: u64, name: &str) -> serde_json::Value {
        json!({"id": id, "name": name, "project": {"id": "proj-guid", "name": "SCC"}})
    }

    // ── Links ──

    #[test]
    fn parses_run_and_pipeline_links_in_both_host_forms() {
        let run = parse_link("https://dev.azure.com/skype/SCC/_build/results?buildId=81724709&view=logs&j=0e6e&t=0ff6").unwrap();
        assert_eq!(
            run,
            PipelineLink {
                organization: "skype".into(),
                project: "SCC".into(),
                target: LinkTarget::Run(81724709)
            }
        );
        let legacy = parse_link(
            "https://skype.visualstudio.com/SCC/_build/results?buildId=81723251&view=logs",
        )
        .unwrap();
        assert_eq!(
            legacy,
            PipelineLink {
                organization: "skype".into(),
                project: "SCC".into(),
                target: LinkTarget::Run(81723251)
            }
        );
        let page =
            parse_link("  https://dev.azure.com/skype/My%20Project/_build?definitionId=33770  ")
                .unwrap();
        assert_eq!(
            page,
            PipelineLink {
                organization: "skype".into(),
                project: "My Project".into(),
                target: LinkTarget::Definition(33770)
            }
        );
        let index =
            parse_link("https://skype.visualstudio.com/SCC/_build/index?definitionId=12").unwrap();
        assert_eq!(index.target, LinkTarget::Definition(12));
    }

    #[test]
    fn refuses_links_that_are_not_ado_pipelines() {
        for bad in [
            "https://github.com/org/repo/actions/runs/1",
            "https://dev.azure.com/skype/SCC/_git/repo/pullrequest/5",
            "https://dev.azure.com/skype/SCC/_build/results?view=logs",
            "https://dev.azure.com/skype/SCC/_build/results?buildId=abc",
            "http://dev.azure.com/skype/SCC/_build/results?buildId=1",
            "https://evil.com.visualstudio.com/SCC/_build?definitionId=1",
            "https://dev.azure.com:8443/skype/SCC/_build?definitionId=1",
            "https://dev.azure.com/skype/../_build?definitionId=1",
            "not a url",
        ] {
            let error = parse_link(bad).unwrap_err();
            assert!(
                error.contains("Azure DevOps pipeline or run link"),
                "{bad}: {error}"
            );
        }
    }

    // ── Resolution ──

    #[test]
    fn a_run_link_resolves_to_its_pipeline() {
        let stub = Stub::new(vec![
            (
                "/_apis/build/builds/81723251",
                Ok(json!({"id": 81723251, "definition": {"id": 33770}})),
            ),
            (
                "/_apis/build/definitions/33770",
                Ok(definition(33770, "agency_pipeline_watchdog")),
            ),
        ]);
        let link = parse_link("https://skype.visualstudio.com/SCC/_build/results?buildId=81723251")
            .unwrap();
        let resolved = resolve(&stub, &link).unwrap();
        assert_eq!(
            resolved,
            ResolvedPipeline {
                organization: "skype".into(),
                project_id: "proj-guid".into(),
                project_name: "SCC".into(),
                definition_id: 33770,
                name: "agency_pipeline_watchdog".into(),
            }
        );
        // Requests go to dev.azure.com whatever the link's host form.
        assert!(stub
            .asked
            .borrow()
            .iter()
            .all(|u| u.starts_with("https://dev.azure.com/skype/SCC/_apis/build/")));
    }

    #[test]
    fn a_missing_pipeline_or_run_says_so_without_provider_details() {
        let stub = Stub::new(vec![]);
        let link = parse_link("https://dev.azure.com/skype/SCC/_build/results?buildId=1").unwrap();
        let error = resolve(&stub, &link).unwrap_err();
        assert!(error.contains("wasn't found"), "{error}");
        assert!(!error.contains("/_apis/"), "{error}");
    }

    // ── Store ──

    fn resolved(id: u64, name: &str) -> ResolvedPipeline {
        ResolvedPipeline {
            organization: "skype".into(),
            project_id: "proj-guid".into(),
            project_name: "SCC".into(),
            definition_id: id,
            name: name.into(),
        }
    }

    #[test]
    fn adds_a_pipeline_once_in_failures_mode() {
        let db = db();
        let added = add(&db, &resolved(33770, "watchdog"), None).unwrap();
        assert_eq!(
            (added.name.as_str(), added.project.as_str(), added.mode),
            ("watchdog", "SCC", PipelineMode::Failures)
        );
        assert_eq!(
            added.url,
            "https://dev.azure.com/skype/SCC/_build?definitionId=33770"
        );
        let mut other_case = resolved(33770, "watchdog");
        other_case.organization = "Skype".into();
        let error = add(&db, &other_case, None).unwrap_err();
        assert!(error.contains("Already watching"), "{error}");
        assert_eq!(list(&db).unwrap().len(), 1);
    }

    #[test]
    fn mode_changes_and_removal_are_saved_and_removal_drops_its_notifications() {
        let db = db();
        let a = add(&db, &resolved(1, "A"), Some(PipelineMode::Both)).unwrap();
        let b = add(&db, &resolved(2, "B"), None).unwrap();
        make_old(&db);
        let target = targets(&db)
            .unwrap()
            .into_iter()
            .find(|t| t.id == b.id)
            .unwrap();
        apply_runs(&db, &target, &[run(10, "failed", NEW)]).unwrap();
        assert_eq!(items(&db).unwrap().len(), 1);
        set_mode(&db, &a.id, PipelineMode::Off).unwrap();
        remove(&db, &b.id).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].id.as_str(), rows[0].mode),
            (a.id.as_str(), PipelineMode::Off)
        );
        assert!(items(&db).unwrap().is_empty());
        assert!(remove(&db, &b.id).is_err());
        assert!(set_mode(&db, "nope", PipelineMode::Both).is_err());
    }

    // ── Checking ──

    const OLD: &str = "2000-01-01T00:00:00.1234567Z";
    const NEW: &str = "2100-01-01T00:00:00.5Z";

    /// Moves every pipeline's "notify after" into the past, between OLD and NEW.
    fn make_old(db: &Connection) {
        db.execute(
            "UPDATE pipeline_watches SET notify_after='2050-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
    }

    fn run(id: u64, result: &str, finished: &str) -> Run {
        Run {
            id,
            number: format!("2026.{id}"),
            result: result.into(),
            branch: "main".into(),
            trigger: "Scheduled".into(),
            finished_at: finished.into(),
        }
    }

    fn notified(db: &Connection) -> Vec<(String, u64, String)> {
        let mut v: Vec<_> = items(db)
            .unwrap()
            .into_iter()
            .map(|i| (i.pipeline_name, i.run_id, i.result))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn each_mode_notifies_exactly_the_results_it_watches() {
        let db = db();
        for (id, name, mode) in [
            (1, "off", PipelineMode::Off),
            (2, "fail", PipelineMode::Failures),
            (3, "ok", PipelineMode::Successes),
            (4, "both", PipelineMode::Both),
        ] {
            add(&db, &resolved(id, name), Some(mode)).unwrap();
        }
        make_old(&db);
        for target in targets(&db).unwrap() {
            let base = target.definition_id * 100;
            apply_runs(
                &db,
                &target,
                &[
                    run(base + 4, "canceled", NEW),
                    run(base + 3, "partiallySucceeded", NEW),
                    run(base + 2, "succeeded", NEW),
                    run(base + 1, "failed", NEW),
                ],
            )
            .unwrap();
        }
        assert_eq!(
            notified(&db),
            vec![
                ("both".into(), 401, "failed".into()),
                ("both".into(), 402, "succeeded".into()),
                ("fail".into(), 201, "failed".into()),
                ("ok".into(), 302, "succeeded".into()),
            ]
        );
        // The last result is the newest run's, whatever it was.
        assert!(list(&db)
            .unwrap()
            .iter()
            .all(|p| p.last_result.as_deref() == Some("canceled")));
    }

    #[test]
    fn adding_a_pipeline_never_replays_runs_that_finished_before() {
        let db = db();
        add(&db, &resolved(1, "watchdog"), Some(PipelineMode::Both)).unwrap();
        let target = targets(&db).unwrap().remove(0);
        let history: Vec<Run> = (1..=5).rev().map(|i| run(i, "failed", OLD)).collect();
        apply_runs(&db, &target, &history).unwrap();
        apply_runs(&db, &target, &history).unwrap();
        assert!(items(&db).unwrap().is_empty());
        let row = &list(&db).unwrap()[0];
        assert_eq!(
            (row.last_result.as_deref(), row.last_run_number.as_deref()),
            (Some("failed"), Some("2026.5"))
        );
        make_old(&db);
        let mut next = vec![run(6, "failed", NEW)];
        next.extend(history);
        apply_runs(&db, &target, &next).unwrap();
        assert_eq!(notified(&db), vec![("watchdog".into(), 6, "failed".into())]);
    }

    #[test]
    fn every_failure_notifies_whatever_the_branch_or_trigger() {
        let db = db();
        add(&db, &resolved(1, "p"), None).unwrap();
        make_old(&db);
        let target = targets(&db).unwrap().remove(0);
        let mut a = run(1, "failed", NEW);
        a.branch = "feature/x".into();
        a.trigger = "Manual · Ana".into();
        apply_runs(&db, &target, &[a]).unwrap();
        let mut b = run(2, "failed", NEW);
        b.trigger = "CI".into();
        let c = run(3, "failed", NEW);
        apply_runs(&db, &target, &[c, b, run(1, "failed", NEW)]).unwrap();
        assert_eq!(notified(&db).len(), 3);
        let first = items(&db)
            .unwrap()
            .into_iter()
            .find(|i| i.run_id == 1)
            .unwrap();
        assert_eq!(
            (first.branch.as_str(), first.trigger.as_str()),
            ("feature/x", "Manual · Ana")
        );
        assert_eq!(
            first.url,
            "https://dev.azure.com/skype/SCC/_build/results?buildId=1"
        );
    }

    #[test]
    fn a_retried_run_that_changes_result_notifies_once_more_and_never_twice() {
        for (mode, expected) in [(PipelineMode::Both, 2), (PipelineMode::Failures, 1)] {
            let db = db();
            add(&db, &resolved(1, "p"), Some(mode)).unwrap();
            make_old(&db);
            let target = targets(&db).unwrap().remove(0);
            apply_runs(&db, &target, &[run(7, "failed", NEW)]).unwrap();
            for _ in 0..3 {
                apply_runs(&db, &target, &[run(7, "succeeded", "2100-01-01T01:00:00Z")]).unwrap();
            }
            assert_eq!(items(&db).unwrap().len(), expected, "{mode:?}");
        }
    }

    #[test]
    fn changing_the_mode_restarts_the_quiet_period_so_runs_seen_while_off_never_replay() {
        let db = db();
        let p = add(&db, &resolved(1, "p"), Some(PipelineMode::Off)).unwrap();
        db.execute(
            "UPDATE pipeline_watches SET notify_after='2000-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_runs(&db, &target, &[run(1, "failed", "2001-01-01T00:00:00Z")]).unwrap();
        assert!(items(&db).unwrap().is_empty(), "Off notifies nothing");
        set_mode(&db, &p.id, PipelineMode::Failures).unwrap();
        let target = targets(&db).unwrap().remove(0);
        apply_runs(&db, &target, &[run(1, "failed", "2001-01-01T00:00:00Z")]).unwrap();
        assert!(
            items(&db).unwrap().is_empty(),
            "a run that finished before the change stays quiet"
        );
    }

    #[test]
    fn a_stale_target_writes_nothing() {
        let db = db();
        let p = add(&db, &resolved(1, "p"), None).unwrap();
        make_old(&db);
        let target = targets(&db).unwrap().remove(0);
        set_mode(&db, &p.id, PipelineMode::Both).unwrap();
        make_old(&db);
        apply_runs(&db, &target, &[run(1, "failed", NEW)]).unwrap();
        record_error(&db, &target, "boom").unwrap();
        assert!(items(&db).unwrap().is_empty());
        assert!(list(&db).unwrap()[0].error.is_none());
    }

    #[test]
    fn reads_finished_runs_from_the_build_api() {
        let stub = Stub::new(vec![(
            "/_apis/build/builds",
            Ok(json!({"value": [
                {"id": 9, "buildNumber": "20261026.3", "result": "failed", "status": "completed",
                 "sourceBranch": "refs/heads/main", "reason": "schedule", "finishTime": "2026-10-26T08:10:44.2179804Z",
                 "requestedFor": {"displayName": "Microsoft.VisualStudio.Services.TFS"}},
                {"id": 8, "buildNumber": "8", "result": "succeeded", "sourceBranch": "refs/pull/12/merge",
                 "reason": "manual", "finishTime": "2026-10-25T08:00:00Z", "requestedFor": {"displayName": "Ana"}},
                {"id": 7, "buildNumber": "7", "result": "failed", "sourceBranch": "refs/heads/dev", "reason": "individualCI", "finishTime": "2026-10-24T08:00:00Z"},
                {"id": 6, "buildNumber": "6", "result": "failed", "sourceBranch": "refs/heads/dev", "reason": "pullRequest", "finishTime": "2026-10-23T08:00:00Z"},
                {"id": 5, "buildNumber": "5", "sourceBranch": "refs/heads/dev", "reason": "manual"}
            ]})),
        )]);
        let db = db();
        add(&db, &resolved(33995, "p"), None).unwrap();
        let target = targets(&db).unwrap().remove(0);
        let runs = fetch_runs(&stub, &target).unwrap();
        assert_eq!(
            runs.iter()
                .map(|r| (r.id, r.branch.as_str(), r.trigger.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (9, "main", "Scheduled"),
                (8, "refs/pull/12/merge", "Manual · Ana"),
                (7, "dev", "CI"),
                (6, "dev", "PR"),
            ]
        );
        let asked = stub.asked.borrow()[0].clone();
        assert!(
            asked.starts_with("https://dev.azure.com/skype/proj-guid/_apis/build/builds?"),
            "{asked}"
        );
        for part in [
            "definitions=33995",
            "statusFilter=completed",
            "queryOrder=finishTimeDescending",
        ] {
            assert!(asked.contains(part), "{asked}");
        }
    }

    #[test]
    fn one_failing_pipeline_does_not_stop_the_others() {
        let conn = db();
        add(&conn, &resolved(1, "broken"), None).unwrap();
        add(&conn, &resolved(2, "fine"), None).unwrap();
        make_old(&conn);
        let stub = Stub::new(vec![(
            "/_apis/build/builds",
            Ok(json!({"value": [
                {"id": 21, "buildNumber": "21", "result": "failed", "sourceBranch": "refs/heads/main", "reason": "schedule", "finishTime": NEW}
            ]})),
        )]);
        struct Picky<'a>(&'a Stub);
        impl JsonTransport for Picky<'_> {
            fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
                if url.query().unwrap_or("").contains("definitions=1&") {
                    return Err(
                        "ADO connection failed or timed out. Check your network and VPN.".into(),
                    );
                }
                self.0.get(url)
            }
        }
        let watched = targets(&conn).unwrap();
        let shared = std::sync::Mutex::new(conn);
        check_all(&shared, Ok(&Picky(&stub)), &watched);
        let conn = shared.into_inner().unwrap();
        let rows = list(&conn).unwrap();
        let broken = rows.iter().find(|p| p.name == "broken").unwrap();
        let fine = rows.iter().find(|p| p.name == "fine").unwrap();
        assert!(broken.error.as_deref().unwrap().contains("timed out"));
        assert!(fine.error.is_none());
        assert_eq!(notified(&conn), vec![("fine".into(), 21, "failed".into())]);
        // Without a token, every pipeline shows why.
        let targets_again = targets(&conn).unwrap();
        let shared = std::sync::Mutex::new(conn);
        check_all(&shared, Err("Azure CLI authentication failed. Install az and run az login for your ADO account."), &targets_again);
        let conn = shared.into_inner().unwrap();
        assert!(list(&conn).unwrap().iter().all(|p| p
            .error
            .as_deref()
            .unwrap_or("")
            .contains("az login")));
    }
}

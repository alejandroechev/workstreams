//! ADO sprint and feature planning (ADR 039).
//!
//! Reads your team's sprints and your user stories and features from Azure
//! DevOps, keeps planning changes as a local draft, and publishes the draft
//! with a revision check per item. Uses the PR inbox's Azure CLI token and
//! HTTP rules (ADR 030): no redirects, bounded responses, no provider bodies
//! or tokens in errors.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The HTTP verbs planning needs. A trait so tests stub ADO.
pub trait AdoHttp {
    fn get(&self, url: reqwest::Url) -> Result<Value, String>;
    fn post(&self, url: reqwest::Url, body: &Value, content_type: &str) -> Result<Value, String>;
    fn patch(&self, url: reqwest::Url, body: &Value) -> Result<Value, String>;
}

impl AdoHttp for crate::pr_inbox::AdoTransport {
    fn get(&self, url: reqwest::Url) -> Result<Value, String> {
        self.send_json(reqwest::Method::GET, url, None)
    }
    fn post(&self, url: reqwest::Url, body: &Value, content_type: &str) -> Result<Value, String> {
        self.send_json(reqwest::Method::POST, url, Some((body, content_type)))
    }
    fn patch(&self, url: reqwest::Url, body: &Value) -> Result<Value, String> {
        self.send_json(
            reqwest::Method::PATCH,
            url,
            Some((body, "application/json-patch+json")),
        )
    }
}

// ── Links ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamLink {
    pub organization: String,
    pub project: String,
    pub team: String,
}

const NOT_A_TEAM_LINK: &str =
    "That isn't an Azure DevOps team sprint or backlog link. Paste the link of your team's sprint (…/_sprints/taskboard/<team>/…) or backlog (…/_backlogs/backlog/<team>/…).";

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && !s.contains(['/', '\\'])
        && !s.chars().any(char::is_control)
}

/// Reads a team's sprint (`_sprints/<view>/<team>/…`), backlog
/// (`_backlogs/<view>/<team>/…`) or board (`_boards/board/t/<team>/…`) link,
/// on `dev.azure.com/<org>/<project>` or `<org>.visualstudio.com/<project>`.
pub fn parse_team_link(text: &str) -> Result<TeamLink, String> {
    let url = reqwest::Url::parse(text.trim()).map_err(|_| NOT_A_TEAM_LINK)?;
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() {
        return Err(NOT_A_TEAM_LINK.into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let path: Vec<String> = url
        .path()
        .trim_matches('/')
        .split('/')
        .map(crate::pull_requests::percent_decode)
        .collect();
    let (organization, rest) = if host == "dev.azure.com" && path.len() >= 2 {
        (path[0].clone(), &path[1..])
    } else if let Some(org) = host.strip_suffix(".visualstudio.com") {
        if org.contains('.') {
            return Err(NOT_A_TEAM_LINK.into());
        }
        (org.to_string(), &path[..])
    } else {
        return Err(NOT_A_TEAM_LINK.into());
    };
    let project = rest.first().cloned().unwrap_or_default();
    let team = match rest.get(1).map(String::as_str) {
        Some("_sprints") | Some("_backlogs") => rest.get(3).cloned(),
        Some("_boards") if rest.get(2).map(String::as_str) == Some("board") => {
            if rest.get(3).map(String::as_str) == Some("t") {
                rest.get(4).cloned()
            } else {
                rest.get(3).cloned()
            }
        }
        _ => None,
    }
    .unwrap_or_default();
    if !valid_segment(&organization) || !valid_segment(&project) || !valid_segment(&team) {
        return Err(NOT_A_TEAM_LINK.into());
    }
    Ok(TeamLink {
        organization,
        project,
        team,
    })
}

// ── URLs ────────────────────────────────────────────────────────────────

pub(crate) fn base(org: &str) -> reqwest::Url {
    let mut url = reqwest::Url::parse("https://dev.azure.com/").expect("constant URL");
    url.path_segments_mut()
        .expect("HTTPS base")
        .pop_if_empty()
        .push(org);
    url
}

pub(crate) fn api(org: &str, segments: &[&str], query: &[(&str, &str)]) -> reqwest::Url {
    let mut url = base(org);
    url.path_segments_mut()
        .expect("HTTPS base")
        .extend(segments.iter().copied());
    {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
        pairs.append_pair("api-version", "7.1");
    }
    url
}

fn not_found_as_missing(error: String, what: &str) -> String {
    if error.contains("HTTP 404") {
        format!("{what} wasn't found, or your Azure CLI account can't see it.")
    } else {
        error
    }
}

// ── Connection ──────────────────────────────────────────────────────────

/// Your team, as Planning needs it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanningConnection {
    pub organization: String,
    pub project: String,
    pub team: String,
    pub team_id: String,
    /// The team's default area path: new items go here.
    pub area_path: String,
    /// The team's backlog iteration (full path): where new features go.
    pub backlog_iteration: String,
    /// The process's backlog-order and effort fields (e.g. StackRank, StoryPoints).
    pub order_field: String,
    pub effort_field: String,
}

pub(crate) fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// An iteration path as work items carry it: `<project>\<path>`.
fn full_iteration_path(project: &str, path: &str) -> String {
    let trimmed = path.trim_start_matches('\\');
    if trimmed.is_empty() {
        project.to_string()
    } else if trimmed
        .split('\\')
        .next()
        .is_some_and(|first| first.eq_ignore_ascii_case(project))
    {
        trimmed.to_string()
    } else {
        format!("{project}\\{trimmed}")
    }
}

pub fn connect(http: &dyn AdoHttp, link: &TeamLink) -> Result<PlanningConnection, String> {
    let org = &link.organization;
    let team = http
        .get(api(
            org,
            &["_apis", "projects", &link.project, "teams", &link.team],
            &[],
        ))
        .map_err(|e| not_found_as_missing(e, "That team"))?;
    let team_name = text(&team["name"]).unwrap_or_else(|| link.team.clone());
    let project = text(&team["projectName"]).unwrap_or_else(|| link.project.clone());
    let team_id = text(&team["id"]).ok_or("ADO returned a team without an id")?;
    let fields = http.get(api(
        org,
        &[
            &project,
            &team_name,
            "_apis",
            "work",
            "teamsettings",
            "teamfieldvalues",
        ],
        &[],
    ))?;
    let area_path =
        text(&fields["defaultValue"]).ok_or("The team has no default area path in ADO")?;
    let settings = http.get(api(
        org,
        &[&project, &team_name, "_apis", "work", "teamsettings"],
        &[],
    ))?;
    let backlog_iteration = full_iteration_path(
        &project,
        &text(&settings["backlogIteration"]["path"]).unwrap_or_default(),
    );
    let process = http.get(api(
        org,
        &[&project, "_apis", "work", "processconfiguration"],
        &[],
    ))?;
    Ok(PlanningConnection {
        organization: org.clone(),
        project,
        team: team_name,
        team_id,
        area_path,
        backlog_iteration,
        order_field: text(&process["typeFields"]["Order"]["referenceName"])
            .unwrap_or_else(|| "Microsoft.VSTS.Common.StackRank".into()),
        effort_field: text(&process["typeFields"]["Effort"]["referenceName"])
            .unwrap_or_else(|| "Microsoft.VSTS.Scheduling.StoryPoints".into()),
    })
}

// ── Reading ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Me {
    pub id: String,
    pub display_name: String,
    pub unique_name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Iteration {
    pub name: String,
    pub path: String,
    pub start: Option<String>,
    pub finish: Option<String>,
    pub timeframe: String,
}

/// A user story, feature or (for counting only) task.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanItem {
    pub id: i64,
    pub rev: i64,
    pub kind: String,
    pub title: String,
    pub state: String,
    pub assigned_to: Option<String>,
    pub assigned_to_me: bool,
    pub iteration_path: String,
    pub story_points: Option<f64>,
    pub order: Option<f64>,
    pub target_date: Option<String>,
    pub parent_id: Option<i64>,
    pub tasks_done: u32,
    pub tasks_total: u32,
    pub url: String,
    /// The child tasks of a story in the selected sprint: by state, then
    /// backlog order; Removed ones left out.
    #[serde(default)]
    pub tasks: Vec<PlanTask>,
}

/// A task under a sprint story.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanTask {
    pub id: i64,
    pub rev: i64,
    pub title: String,
    pub state: String,
    pub assigned_to: Option<String>,
    pub assigned_to_me: bool,
    pub order: Option<f64>,
    pub url: String,
}

/// The states a task (or, through the resolve offer, a story) can be set to.
pub const SETTABLE_STATES: [&str; 5] = ["New", "Active", "Blocked", "Resolved", "Closed"];

fn state_rank(state: &str) -> usize {
    SETTABLE_STATES
        .iter()
        .position(|s| *s == state)
        .unwrap_or(SETTABLE_STATES.len())
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanningData {
    pub connection: PlanningConnection,
    pub me: Me,
    pub iterations: Vec<Iteration>,
    pub selected_sprint: String,
    pub previous_sprint: Option<String>,
    pub items: Vec<PlanItem>,
}

fn wiql(http: &dyn AdoHttp, conn: &PlanningConnection, query: &str) -> Result<Vec<i64>, String> {
    let url = api(
        &conn.organization,
        &[&conn.project, "_apis", "wit", "wiql"],
        &[("$top", "1000")],
    );
    let body = http.post(url, &json!({ "query": query }), "application/json")?;
    Ok(body["workItems"]
        .as_array()
        .map(|items| items.iter().filter_map(|w| w["id"].as_i64()).collect())
        .unwrap_or_default())
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn get_items(
    http: &dyn AdoHttp,
    conn: &PlanningConnection,
    ids: &[i64],
) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    for chunk in ids.chunks(200) {
        let list = chunk
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let body = http.get(api(
            &conn.organization,
            &[&conn.project, "_apis", "wit", "workitems"],
            &[
                ("ids", &list),
                ("$expand", "relations"),
                ("errorPolicy", "omit"),
            ],
        ))?;
        if let Some(values) = body["value"].as_array() {
            items.extend(values.iter().filter(|v| !v.is_null()).cloned());
        }
    }
    Ok(items)
}

fn relation_ids(item: &Value, rel: &str) -> Vec<i64> {
    item["relations"]
        .as_array()
        .map(|relations| {
            relations
                .iter()
                .filter(|r| r["rel"].as_str() == Some(rel))
                .filter_map(|r| r["url"].as_str()?.rsplit('/').next()?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

const CHILD: &str = "System.LinkTypes.Hierarchy-Forward";
const PARENT: &str = "System.LinkTypes.Hierarchy-Reverse";

fn is_me(assigned: &Value, me: &Me) -> bool {
    let unique = assigned["uniqueName"].as_str().unwrap_or("");
    let id = assigned["id"].as_str().unwrap_or("");
    (!unique.is_empty() && unique.eq_ignore_ascii_case(&me.unique_name))
        || (!id.is_empty() && id == me.id)
}

fn web_url(conn: &PlanningConnection, id: i64) -> String {
    let mut url = base(&conn.organization);
    url.path_segments_mut().expect("HTTPS base").extend([
        conn.project.as_str(),
        "_workitems",
        "edit",
        &id.to_string(),
    ]);
    url.to_string()
}

fn to_item(value: &Value, conn: &PlanningConnection, me: &Me) -> Option<PlanItem> {
    let f = &value["fields"];
    let assigned = &f["System.AssignedTo"];
    Some(PlanItem {
        id: value["id"].as_i64()?,
        rev: value["rev"].as_i64().unwrap_or(0),
        kind: text(&f["System.WorkItemType"]).unwrap_or_default(),
        title: text(&f["System.Title"]).unwrap_or_default(),
        state: text(&f["System.State"]).unwrap_or_default(),
        assigned_to: text(&assigned["displayName"]),
        assigned_to_me: is_me(assigned, me),
        iteration_path: text(&f["System.IterationPath"]).unwrap_or_default(),
        story_points: f[conn.effort_field.as_str()].as_f64(),
        order: f[conn.order_field.as_str()].as_f64(),
        target_date: text(&f["Microsoft.VSTS.Scheduling.TargetDate"]),
        parent_id: relation_ids(value, PARENT).first().copied(),
        tasks_done: 0,
        tasks_total: 0,
        url: web_url(conn, value["id"].as_i64()?),
        tasks: Vec::new(),
    })
}

/// Who the Azure CLI login is in an organization.
pub(crate) fn whoami(http: &dyn AdoHttp, organization: &str) -> Result<Me, String> {
    let who = http.get({
        let mut url = base(organization);
        url.path_segments_mut()
            .expect("HTTPS base")
            .extend(["_apis", "connectionData"]);
        url.query_pairs_mut()
            .append_pair("api-version", "7.1-preview.1");
        url
    })?;
    let user = &who["authenticatedUser"];
    Ok(Me {
        id: text(&user["id"]).ok_or("ADO didn't say who you are")?,
        display_name: text(&user["providerDisplayName"]).unwrap_or_default(),
        unique_name: text(&user["properties"]["Account"]["$value"]).unwrap_or_default(),
    })
}

/// The previous sprint is the one before the selected sprint in date order.
pub fn previous_sprint(iterations: &[Iteration], selected: &str) -> Option<String> {
    let index = iterations.iter().position(|i| i.path == selected)?;
    index.checked_sub(1).map(|i| iterations[i].path.clone())
}

/// What Planning shows: the team's sprints, your stories in the selected and
/// previous sprints, your open features with all their stories, and your
/// unfinished stories anywhere (the candidates). Task progress is filled for
/// the stories in the selected sprint.
pub fn fetch(
    http: &dyn AdoHttp,
    conn: &PlanningConnection,
    selected: Option<&str>,
) -> Result<PlanningData, String> {
    let me = whoami(http, &conn.organization)?;
    let body = http.get(api(
        &conn.organization,
        &[
            &conn.project,
            &conn.team,
            "_apis",
            "work",
            "teamsettings",
            "iterations",
        ],
        &[],
    ))?;
    let mut iterations: Vec<Iteration> = body["value"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|i| Iteration {
                    name: text(&i["name"]).unwrap_or_default(),
                    path: full_iteration_path(&conn.project, &text(&i["path"]).unwrap_or_default()),
                    start: text(&i["attributes"]["startDate"]),
                    finish: text(&i["attributes"]["finishDate"]),
                    timeframe: text(&i["attributes"]["timeFrame"]).unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    iterations.sort_by(|a, b| a.start.cmp(&b.start).then(a.path.cmp(&b.path)));
    let selected_sprint = selected
        .filter(|s| iterations.iter().any(|i| i.path == *s))
        .map(str::to_owned)
        .or_else(|| {
            iterations
                .iter()
                .find(|i| i.timeframe == "current")
                .map(|i| i.path.clone())
        })
        .or_else(|| iterations.last().map(|i| i.path.clone()))
        .ok_or("The team has no sprints in ADO")?;
    let previous = previous_sprint(&iterations, &selected_sprint);

    let mut sprints = vec![quote(&selected_sprint)];
    if let Some(p) = &previous {
        sprints.push(quote(p));
    }
    let in_sprints = wiql(http, conn, &format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'User Story' AND [System.AssignedTo] = @Me AND [System.IterationPath] IN ({})",
        sprints.join(", ")
    ))?;
    let features = wiql(http, conn,
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Feature' AND [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed')",
    )?;
    let unfinished = wiql(http, conn,
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'User Story' AND [System.AssignedTo] = @Me AND [System.State] IN ('New', 'Active')",
    )?;

    let feature_values = get_items(http, conn, &features)?;
    let mut story_ids: Vec<i64> = in_sprints
        .iter()
        .chain(unfinished.iter())
        .copied()
        .collect();
    for feature in &feature_values {
        story_ids.extend(relation_ids(feature, CHILD));
    }
    story_ids.sort_unstable();
    story_ids.dedup();
    let story_values: Vec<Value> = get_items(http, conn, &story_ids)?
        .into_iter()
        .filter(|v| v["fields"]["System.WorkItemType"].as_str() == Some("User Story"))
        .collect();

    // Task progress for the stories in the selected sprint.
    let mut task_owner = std::collections::HashMap::new();
    for story in &story_values {
        if story["fields"]["System.IterationPath"].as_str() == Some(selected_sprint.as_str()) {
            let id = story["id"].as_i64().unwrap_or(0);
            for task in relation_ids(story, CHILD) {
                task_owner.insert(task, id);
            }
        }
    }
    let task_ids: Vec<i64> = task_owner.keys().copied().collect();
    let mut progress: std::collections::HashMap<i64, (u32, u32)> = Default::default();
    let mut tasks: std::collections::HashMap<i64, Vec<PlanTask>> = Default::default();
    for task in get_items(http, conn, &task_ids)? {
        if task["fields"]["System.WorkItemType"].as_str() != Some("Task") {
            continue;
        }
        let state = task["fields"]["System.State"].as_str().unwrap_or("");
        if state == "Removed" {
            continue;
        }
        if let Some(owner) = task["id"].as_i64().and_then(|id| task_owner.get(&id)) {
            let entry = progress.entry(*owner).or_default();
            entry.1 += 1;
            if matches!(state, "Closed" | "Resolved" | "Done") {
                entry.0 += 1;
            }
            if let Some(item) = to_item(&task, conn, &me) {
                tasks.entry(*owner).or_default().push(PlanTask {
                    id: item.id,
                    rev: item.rev,
                    title: item.title,
                    state: item.state,
                    assigned_to: item.assigned_to,
                    assigned_to_me: item.assigned_to_me,
                    order: item.order,
                    url: item.url,
                });
            }
        }
    }

    let mut items: Vec<PlanItem> = feature_values
        .iter()
        .chain(story_values.iter())
        .filter_map(|v| to_item(v, conn, &me))
        .collect();
    for item in &mut items {
        if let Some((done, total)) = progress.get(&item.id) {
            item.tasks_done = *done;
            item.tasks_total = *total;
        }
        if let Some(mut list) = tasks.remove(&item.id) {
            list.sort_by(|a, b| {
                state_rank(&a.state)
                    .cmp(&state_rank(&b.state))
                    .then(
                        a.order
                            .unwrap_or(f64::INFINITY)
                            .total_cmp(&b.order.unwrap_or(f64::INFINITY)),
                    )
                    .then(a.id.cmp(&b.id))
            });
            item.tasks = list;
        }
    }
    Ok(PlanningData {
        connection: conn.clone(),
        me,
        iterations,
        selected_sprint,
        previous_sprint: previous,
        items,
    })
}

// ── Draft ───────────────────────────────────────────────────────────────

/// One planning change. Items not created yet have negative (temporary) ids.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Move {
        id: i64,
        rev: i64,
        to_iteration: String,
        #[serde(default)]
        assign_to_me: bool,
    },
    Estimate {
        id: i64,
        rev: i64,
        points: Option<f64>,
    },
    Retitle {
        id: i64,
        rev: i64,
        title: String,
    },
    Order {
        id: i64,
        rev: i64,
        order: f64,
    },
    Remove {
        id: i64,
        rev: i64,
    },
    /// A task's state, or a story's through the "resolve the story" offer.
    SetState {
        id: i64,
        rev: i64,
        state: String,
    },
    /// Links one of your orphaned PRs to a work item (`id`).
    LinkPr {
        id: i64,
        rev: i64,
        pr: PrRef,
    },
    CreateFeature {
        temp_id: i64,
        title: String,
        target_date: Option<String>,
        description: Option<String>,
    },
    CreateStory {
        temp_id: i64,
        parent: i64,
        title: String,
        points: Option<f64>,
        description: Option<String>,
        /// Planned into a sprint before it exists; otherwise its feature's iteration.
        #[serde(default)]
        iteration: Option<String>,
        /// Backlog order set before it exists.
        #[serde(default)]
        order: Option<f64>,
    },
}

/// The pull request a `LinkPr` change links.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PrRef {
    pub id: i64,
    pub project_id: String,
    pub repo_id: String,
    pub title: String,
}

impl PrRef {
    /// How a work item refers to a pull request.
    fn artifact_url(&self) -> String {
        format!(
            "vstfs:///Git/PullRequestId/{}%2F{}%2F{}",
            self.project_id, self.repo_id, self.id
        )
    }
}

impl Change {
    fn target(&self) -> i64 {
        match self {
            Self::Move { id, .. }
            | Self::Estimate { id, .. }
            | Self::Retitle { id, .. }
            | Self::Order { id, .. }
            | Self::Remove { id, .. }
            | Self::SetState { id, .. }
            | Self::LinkPr { id, .. } => *id,
            Self::CreateFeature { temp_id, .. } | Self::CreateStory { temp_id, .. } => *temp_id,
        }
    }

    /// Removing an item and setting its state both set its state, so they
    /// replace each other.
    fn same_slot(&self, other: &Change) -> bool {
        // A PR has one pending link: linking it again moves the link.
        if let (Change::LinkPr { pr: a, .. }, Change::LinkPr { pr: b, .. }) = (self, other) {
            return a.id == b.id;
        }
        let sets_state = |c: &Change| matches!(c, Change::Remove { .. } | Change::SetState { .. });
        (std::mem::discriminant(self) == std::mem::discriminant(other)
            || (sets_state(self) && sets_state(other)))
            && self.target() == other.target()
    }
}

/// Adds a change to the draft. A later change of the same kind to the same
/// item replaces the earlier one. A change to an item not created yet edits
/// its creation instead; removing it drops the creation (and, for a feature,
/// the stories under it).
pub fn add_change(draft: &mut Vec<Change>, change: Change) {
    let target = change.target();
    if target < 0
        && !matches!(
            change,
            Change::CreateFeature { .. } | Change::CreateStory { .. }
        )
    {
        match change {
            Change::Remove { .. } => {
                draft.retain(|c| match c {
                    Change::CreateStory {
                        temp_id, parent, ..
                    } => *temp_id != target && *parent != target,
                    Change::CreateFeature { temp_id, .. } => *temp_id != target,
                    _ => c.target() != target,
                });
            }
            _ => {
                for c in draft.iter_mut() {
                    match (c, &change) {
                        (
                            Change::CreateStory {
                                temp_id, points, ..
                            },
                            Change::Estimate { points: p, .. },
                        ) if *temp_id == target => *points = *p,
                        (
                            Change::CreateStory { temp_id, title, .. },
                            Change::Retitle { title: t, .. },
                        )
                        | (
                            Change::CreateFeature { temp_id, title, .. },
                            Change::Retitle { title: t, .. },
                        ) if *temp_id == target => *title = t.clone(),
                        (
                            Change::CreateStory {
                                temp_id, iteration, ..
                            },
                            Change::Move { to_iteration, .. },
                        ) if *temp_id == target => *iteration = Some(to_iteration.clone()),
                        (
                            Change::CreateStory { temp_id, order, .. },
                            Change::Order { order: o, .. },
                        ) if *temp_id == target => *order = Some(*o),
                        _ => {}
                    }
                }
            }
        }
        return;
    }
    if let Some(existing) = draft.iter_mut().find(|c| c.same_slot(&change)) {
        *existing = change;
    } else {
        draft.push(change);
    }
}

const DRAFT_KEY: &str = "planning.draft";
const CONNECTION_KEY: &str = "planning.connection";
const SPRINT_KEY: &str = "planning.sprint";

fn get_setting(db: &Connection, key: &str) -> Result<Option<String>, String> {
    db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

fn set_setting(db: &Connection, key: &str, value: &str) -> Result<(), String> {
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn load_draft(db: &Connection) -> Result<Vec<Change>, String> {
    Ok(get_setting(db, DRAFT_KEY)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

pub fn save_draft(db: &Connection, draft: &[Change]) -> Result<(), String> {
    set_setting(
        db,
        DRAFT_KEY,
        &serde_json::to_string(draft).map_err(|e| e.to_string())?,
    )
}

pub fn load_connection(db: &Connection) -> Result<Option<PlanningConnection>, String> {
    Ok(get_setting(db, CONNECTION_KEY)?.and_then(|raw| serde_json::from_str(&raw).ok()))
}

/// Saves a new connection. A different team starts with an empty draft and
/// the team's current sprint.
pub fn save_connection(db: &Connection, conn: &PlanningConnection) -> Result<(), String> {
    let previous = load_connection(db)?;
    let same_team = previous.as_ref().is_some_and(|p| {
        p.organization.eq_ignore_ascii_case(&conn.organization) && p.team_id == conn.team_id
    });
    set_setting(
        db,
        CONNECTION_KEY,
        &serde_json::to_string(conn).map_err(|e| e.to_string())?,
    )?;
    if !same_team {
        save_draft(db, &[])?;
        db.execute("DELETE FROM settings WHERE key = ?1", [SPRINT_KEY])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn selected_sprint(db: &Connection) -> Result<Option<String>, String> {
    get_setting(db, SPRINT_KEY)
}

pub fn select_sprint(db: &Connection, path: &str) -> Result<(), String> {
    set_setting(db, SPRINT_KEY, path)
}

// ── Publishing ──────────────────────────────────────────────────────────

/// A change ADO refused because the item changed since it was loaded.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub id: i64,
    pub title: String,
    pub field: String,
    /// The value in ADO now, as text.
    pub ado_value: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub id: i64,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct PublishResult {
    /// Items written (real ids, created ones included).
    pub written: Vec<i64>,
    pub conflicts: Vec<Conflict>,
    pub failures: Vec<Failure>,
    /// What stays in the draft: the conflicting and failed changes.
    pub remaining: Vec<Change>,
}

fn item_url(conn: &PlanningConnection, id: i64) -> reqwest::Url {
    api(
        &conn.organization,
        &[&conn.project, "_apis", "wit", "workitems", &id.to_string()],
        &[],
    )
}

fn field_and_value(conn: &PlanningConnection, change: &Change, me: &Me) -> Vec<(String, Value)> {
    match change {
        Change::Move {
            to_iteration,
            assign_to_me,
            ..
        } => {
            let mut ops = vec![("System.IterationPath".to_string(), json!(to_iteration))];
            if *assign_to_me {
                ops.push(("System.AssignedTo".into(), json!(me.unique_name)));
            }
            ops
        }
        Change::Estimate { points, .. } => vec![(conn.effort_field.clone(), json!(points))],
        Change::Retitle { title, .. } => vec![("System.Title".into(), json!(title))],
        Change::Order { order, .. } => vec![(conn.order_field.clone(), json!(order))],
        Change::Remove { .. } => vec![("System.State".into(), json!("Removed"))],
        Change::SetState { state, .. } => vec![("System.State".into(), json!(state))],
        _ => Vec::new(),
    }
}

fn shown(value: &Value) -> String {
    match value {
        Value::Null => "(empty)".into(),
        Value::String(s) => s.clone(),
        Value::Object(o) => o
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        other => other.to_string(),
    }
}

/// Publishes the draft in order. Each existing item is re-read first: if its
/// revision differs from the one the change was made against (and not because
/// this publish wrote it), it isn't written and is reported as a conflict with
/// ADO's current value. Nothing is ever deleted: removing sets state Removed.
pub fn publish(
    http: &dyn AdoHttp,
    conn: &PlanningConnection,
    me: &Me,
    parents: &std::collections::HashMap<i64, String>,
    draft: &[Change],
) -> PublishResult {
    let mut result = PublishResult::default();
    let mut created: std::collections::HashMap<i64, i64> = Default::default();
    // item id → (revision the draft saw, revision after our own write)
    let mut ours: std::collections::HashMap<i64, (i64, i64)> = Default::default();
    // Iterations of created features, for their new stories.
    let mut created_iterations: std::collections::HashMap<i64, String> = Default::default();

    for change in draft {
        let outcome: Result<(), (bool, String, Option<Conflict>)> = (|| match change {
            Change::CreateFeature {
                temp_id,
                title,
                target_date,
                description,
            } => {
                let mut ops = vec![
                    json!({"op":"add","path":"/fields/System.Title","value":title}),
                    json!({"op":"add","path":"/fields/System.AreaPath","value":conn.area_path}),
                    json!({"op":"add","path":"/fields/System.IterationPath","value":conn.backlog_iteration}),
                    json!({"op":"add","path":"/fields/System.AssignedTo","value":me.unique_name}),
                ];
                if let Some(date) = target_date {
                    ops.push(json!({"op":"add","path":"/fields/Microsoft.VSTS.Scheduling.TargetDate","value":date}));
                }
                if let Some(d) = description.as_ref().filter(|d| !d.trim().is_empty()) {
                    ops.push(json!({"op":"add","path":"/fields/System.Description","value":d}));
                }
                let url = api(
                    &conn.organization,
                    &[&conn.project, "_apis", "wit", "workitems", "$Feature"],
                    &[],
                );
                let body = http
                    .post(url, &Value::Array(ops), "application/json-patch+json")
                    .map_err(|e| (false, e, None))?;
                let id = body["id"].as_i64().ok_or((
                    false,
                    "ADO didn't return the new feature's id".into(),
                    None,
                ))?;
                created.insert(*temp_id, id);
                created_iterations.insert(id, conn.backlog_iteration.clone());
                result.written.push(id);
                Ok(())
            }
            Change::CreateStory {
                temp_id,
                parent,
                title,
                points,
                description,
                iteration: planned,
                order,
            } => {
                let parent_id = if *parent < 0 {
                    *created.get(parent).ok_or((
                        false,
                        "Its feature wasn't created".into(),
                        None,
                    ))?
                } else {
                    *parent
                };
                let iteration = planned
                    .clone()
                    .or_else(|| created_iterations.get(&parent_id).cloned())
                    .or_else(|| parents.get(&parent_id).cloned())
                    .unwrap_or_else(|| conn.backlog_iteration.clone());
                let mut ops = vec![
                    json!({"op":"add","path":"/fields/System.Title","value":title}),
                    json!({"op":"add","path":"/fields/System.AreaPath","value":conn.area_path}),
                    json!({"op":"add","path":"/fields/System.IterationPath","value":iteration}),
                    json!({"op":"add","path":"/fields/System.AssignedTo","value":me.unique_name}),
                    json!({"op":"add","path":"/relations/-","value":{
                        "rel": PARENT,
                        "url": item_url(conn, parent_id).as_str().split('?').next().unwrap_or(""),
                    }}),
                ];
                if let Some(p) = points {
                    ops.push(json!({"op":"add","path":format!("/fields/{}", conn.effort_field),"value":p}));
                }
                if let Some(o) = order {
                    ops.push(json!({"op":"add","path":format!("/fields/{}", conn.order_field),"value":o}));
                }
                if let Some(d) = description.as_ref().filter(|d| !d.trim().is_empty()) {
                    ops.push(json!({"op":"add","path":"/fields/System.Description","value":d}));
                }
                let url = api(
                    &conn.organization,
                    &[&conn.project, "_apis", "wit", "workitems", "$User Story"],
                    &[],
                );
                let body = http
                    .post(url, &Value::Array(ops), "application/json-patch+json")
                    .map_err(|e| (false, e, None))?;
                let id = body["id"].as_i64().ok_or((
                    false,
                    "ADO didn't return the new story's id".into(),
                    None,
                ))?;
                created.insert(*temp_id, id);
                result.written.push(id);
                Ok(())
            }
            other => {
                let id = other.target();
                let rev = match other {
                    Change::Move { rev, .. }
                    | Change::Estimate { rev, .. }
                    | Change::Retitle { rev, .. }
                    | Change::Order { rev, .. }
                    | Change::Remove { rev, .. }
                    | Change::SetState { rev, .. }
                    | Change::LinkPr { rev, .. } => *rev,
                    _ => 0,
                };
                let fields = field_and_value(conn, other, me);
                let mut url = item_url(conn, id);
                if matches!(other, Change::LinkPr { .. }) {
                    url.query_pairs_mut().append_pair("$expand", "relations");
                }
                let current = http
                    .get(url)
                    .map_err(|e| (false, not_found_as_missing(e, "That item"), None))?;
                let current_rev = current["rev"].as_i64().unwrap_or(-1);
                // Already linked (in ADO, or by an earlier attempt): nothing to write.
                if let Change::LinkPr { pr, .. } = other {
                    let wanted = pr.artifact_url();
                    let present = current["relations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|r| {
                            r["rel"] == "ArtifactLink"
                                && r["url"]
                                    .as_str()
                                    .is_some_and(|u| u.eq_ignore_ascii_case(&wanted))
                        });
                    if present {
                        crate::orphan_prs::with_cache(|c| c.forget(&conn.organization, pr.id));
                        if !result.written.contains(&id) {
                            result.written.push(id);
                        }
                        return Ok(());
                    }
                }
                let expected = match ours.get(&id) {
                    Some((seen, after)) if *seen == rev => *after,
                    _ => rev,
                };
                if current_rev != expected {
                    if matches!(other, Change::LinkPr { .. }) {
                        return Err((
                            true,
                            String::new(),
                            Some(Conflict {
                                id,
                                title: current["fields"]["System.Title"]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_string(),
                                field: "Links".into(),
                                ado_value: format!("revision {current_rev}"),
                            }),
                        ));
                    }
                    let (field, _) = &fields[0];
                    return Err((
                        true,
                        String::new(),
                        Some(Conflict {
                            id,
                            title: current["fields"]["System.Title"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            field: field.clone(),
                            ado_value: shown(&current["fields"][field.as_str()]),
                        }),
                    ));
                }
                let mut ops = vec![json!({"op":"test","path":"/rev","value":current_rev})];
                for (field, value) in &fields {
                    ops.push(json!({"op":"add","path":format!("/fields/{field}"),"value":value}));
                }
                if let Change::LinkPr { pr, .. } = other {
                    ops.push(json!({"op":"add","path":"/relations/-","value":{
                        "rel": "ArtifactLink",
                        "url": pr.artifact_url(),
                        "attributes": {"name": "Pull Request"},
                    }}));
                }
                let body = http
                    .patch(item_url(conn, id), &Value::Array(ops))
                    .map_err(|e| {
                        if e.contains("HTTP 412") || e.contains("HTTP 409") {
                            (
                                true,
                                String::new(),
                                Some(Conflict {
                                    id,
                                    title: String::new(),
                                    field: fields
                                        .first()
                                        .map(|f| f.0.clone())
                                        .unwrap_or_else(|| "Links".into()),
                                    ado_value: "(changed while publishing)".into(),
                                }),
                            )
                        } else {
                            (false, e, None)
                        }
                    })?;
                ours.insert(id, (rev, body["rev"].as_i64().unwrap_or(current_rev + 1)));
                if let Change::LinkPr { pr, .. } = other {
                    crate::orphan_prs::with_cache(|c| c.forget(&conn.organization, pr.id));
                }
                if !result.written.contains(&id) {
                    result.written.push(id);
                }
                Ok(())
            }
        })();
        if let Err((conflict, message, detail)) = outcome {
            if conflict {
                if let Some(c) = detail {
                    result.conflicts.push(c);
                }
            } else {
                result.failures.push(Failure {
                    id: change.target(),
                    message,
                });
            }
            result.remaining.push(change.clone());
        }
    }
    // What stays must make sense for the next attempt: point at what this
    // publish created, and at the revisions it wrote itself, so a retry
    // neither loses a new parent nor mistakes our own write for a conflict.
    for change in &mut result.remaining {
        match change {
            Change::CreateStory { parent, .. } => {
                if let Some(real) = created.get(parent) {
                    *parent = *real;
                }
            }
            Change::Move { id, rev, .. }
            | Change::Estimate { id, rev, .. }
            | Change::Retitle { id, rev, .. }
            | Change::Order { id, rev, .. }
            | Change::Remove { id, rev, .. }
            | Change::SetState { id, rev, .. }
            | Change::LinkPr { id, rev, .. } => {
                if let Some((seen, after)) = ours.get(id) {
                    if *seen == *rev {
                        *rev = *after;
                    }
                }
            }
            Change::CreateFeature { .. } => {}
        }
    }
    result
}

static PUBLISHING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Tests that publish or hold the guard take this, since the flag is process-wide.
#[cfg(test)]
pub(crate) static PUBLISH_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Held while a publish runs. The draft can't change meanwhile, so what the
/// publish leaves behind is exactly what it didn't write.
pub struct PublishGuard;

impl PublishGuard {
    pub fn start() -> Result<Self, String> {
        use std::sync::atomic::Ordering::SeqCst;
        PUBLISHING
            .compare_exchange(false, true, SeqCst, SeqCst)
            .map(|_| Self)
            .map_err(|_| "Publishing is already in progress".to_string())
    }
}

impl Drop for PublishGuard {
    fn drop(&mut self) {
        PUBLISHING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

const CHANGED_MEANWHILE: &str =
    "The draft changed meanwhile (an agent or another view) — it has been reloaded; try again";

// The three entry points below take the DB connection, so callers hold the DB
// lock: checking the publish flag and touching the draft are then atomic with
// a publish taking its snapshot.

/// Adds a change to the saved draft. Refused while publishing, and for a new
/// item whose temporary id another new item already took.
pub fn add_to_draft(db: &Connection, change: Change) -> Result<Vec<Change>, String> {
    ensure_not_publishing()?;
    if let Change::LinkPr { id, .. } = &change {
        if *id <= 0 {
            return Err("Link a PR to a work item that exists in ADO".into());
        }
    }
    if let Change::SetState { state, .. } = &change {
        if !SETTABLE_STATES.contains(&state.as_str()) {
            return Err(format!(
                "\"{state}\" isn't a state Planning sets; use New, Active, Blocked, Resolved or Closed"
            ));
        }
    }
    let mut draft = load_draft(db)?;
    let creation = |c: &Change| match c {
        Change::CreateFeature { temp_id, .. } | Change::CreateStory { temp_id, .. } => {
            Some(*temp_id)
        }
        _ => None,
    };
    if let Some(id) = creation(&change) {
        if draft.iter().any(|c| creation(c) == Some(id)) {
            return Err(CHANGED_MEANWHILE.into());
        }
    }
    add_change(&mut draft, change);
    save_draft(db, &draft)?;
    Ok(draft)
}

/// Replaces the saved draft. With `base`, only if the draft is still the one
/// the caller edited, so a change made meanwhile isn't silently dropped.
pub fn replace_draft(
    db: &Connection,
    draft: &[Change],
    base: Option<&[Change]>,
) -> Result<(), String> {
    ensure_not_publishing()?;
    if let Some(base) = base {
        if load_draft(db)? != base {
            return Err(CHANGED_MEANWHILE.into());
        }
    }
    save_draft(db, draft)
}

/// Starts a publish: from here until the guard drops, the draft can't change.
pub fn start_publish(db: &Connection) -> Result<(PublishGuard, Vec<Change>), String> {
    let guard = PublishGuard::start()?;
    Ok((guard, load_draft(db)?))
}

/// Planning changes wait while a publish is running.
pub fn ensure_not_publishing() -> Result<(), String> {
    if PUBLISHING.load(std::sync::atomic::Ordering::SeqCst) {
        Err("Publishing to ADO — try again when it finishes".into())
    } else {
        Ok(())
    }
}

/// Saves the sprint Planning defaulted to (ADO's current) the first time, so a
/// later rollover shows the "finished" banner instead of switching silently.
/// Never overwrites a choice, and only for the team still connected.
pub fn remember_default_sprint(
    db: &Connection,
    conn: &PlanningConnection,
    path: &str,
) -> Result<(), String> {
    let still = load_connection(db)?.is_some_and(|c| {
        c.team_id == conn.team_id && c.organization.eq_ignore_ascii_case(&conn.organization)
    });
    if still && selected_sprint(db)?.is_none() {
        select_sprint(db, path)?;
    }
    Ok(())
}

// ── Summaries (the CLI's view; the UI computes the same in src/domain/planning.ts) ──

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SprintSummary {
    pub sprint: String,
    pub committed: f64,
    pub done: f64,
    pub to_go: f64,
    pub not_estimated: usize,
    pub goal: f64,
    pub stories: Vec<PlanItem>,
}

fn is_done(state: &str) -> bool {
    matches!(state, "Resolved" | "Closed")
}

/// Your user stories in the selected sprint, Removed excluded.
pub fn sprint_summary(data: &PlanningData) -> SprintSummary {
    let stories: Vec<PlanItem> = data
        .items
        .iter()
        .filter(|i| {
            i.kind == "User Story"
                && i.assigned_to_me
                && i.state != "Removed"
                && i.iteration_path == data.selected_sprint
        })
        .cloned()
        .collect();
    let points = |i: &PlanItem| i.story_points.unwrap_or(0.0);
    // `+ 0.0` so an empty sum is 0, not -0.
    let committed = stories.iter().map(points).sum::<f64>() + 0.0;
    let done = stories
        .iter()
        .filter(|i| is_done(&i.state))
        .map(points)
        .sum::<f64>()
        + 0.0;
    SprintSummary {
        sprint: data.selected_sprint.clone(),
        committed,
        done,
        to_go: committed - done,
        not_estimated: stories.iter().filter(|i| i.story_points.is_none()).count(),
        goal: 8.0,
        stories,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FeatureSummary {
    pub feature: PlanItem,
    pub done: f64,
    pub pending: f64,
    pub my_pending: f64,
    pub not_estimated: usize,
    pub sprints_left: Option<usize>,
    pub at_risk: bool,
    pub stories: Vec<PlanItem>,
}

/// Sprints that end on or before the target date, from the selected sprint on.
fn sprints_left(data: &PlanningData, target: &str) -> usize {
    let target = &target[..target.len().min(10)];
    let from = data
        .iterations
        .iter()
        .position(|i| i.path == data.selected_sprint)
        .unwrap_or(0);
    data.iterations[from..]
        .iter()
        .filter(|i| {
            i.finish
                .as_deref()
                .is_some_and(|f| &f[..f.len().min(10)] <= target)
        })
        .count()
}

pub fn feature_summaries(data: &PlanningData) -> Vec<FeatureSummary> {
    data.items
        .iter()
        .filter(|i| i.kind == "Feature" && !matches!(i.state.as_str(), "Closed" | "Removed"))
        .map(|feature| {
            let stories: Vec<PlanItem> = data
                .items
                .iter()
                .filter(|s| {
                    s.kind == "User Story"
                        && s.parent_id == Some(feature.id)
                        && s.state != "Removed"
                })
                .cloned()
                .collect();
            let points = |i: &PlanItem| i.story_points.unwrap_or(0.0);
            let done = stories
                .iter()
                .filter(|s| is_done(&s.state))
                .map(points)
                .sum::<f64>()
                + 0.0;
            let pending = stories
                .iter()
                .filter(|s| !is_done(&s.state))
                .map(points)
                .sum::<f64>()
                + 0.0;
            let my_pending = stories
                .iter()
                .filter(|s| !is_done(&s.state) && s.assigned_to_me)
                .map(points)
                .sum::<f64>()
                + 0.0;
            let left = feature
                .target_date
                .as_deref()
                .map(|t| sprints_left(data, t));
            FeatureSummary {
                feature: feature.clone(),
                done,
                pending,
                my_pending,
                not_estimated: stories.iter().filter(|s| s.story_points.is_none()).count(),
                sprints_left: left,
                at_risk: left.is_some_and(|l| my_pending > l as f64 * 8.0),
                stories,
            }
        })
        .collect()
}

/// Reads and publishes against real ADO with the Azure CLI token.
pub trait PlanningGateway: Send + Sync {
    fn connect(&self, link: &str) -> Result<PlanningConnection, String>;
    fn fetch(
        &self,
        conn: &PlanningConnection,
        selected: Option<&str>,
    ) -> Result<PlanningData, String>;
    fn publish(&self, data: &PlanningData, draft: &[Change]) -> Result<PublishResult, String>;
    /// Your orphaned PRs in the organization, created in the last `days` days.
    fn orphans(
        &self,
        organization: &str,
        days: u32,
    ) -> Result<Vec<crate::orphan_prs::OrphanPr>, String>;
}

pub struct AdoPlanning;

/// Where each known item sits, so a new story under it gets its iteration.
pub fn parent_iterations(data: &PlanningData) -> std::collections::HashMap<i64, String> {
    data.items
        .iter()
        .map(|i| (i.id, i.iteration_path.clone()))
        .collect()
}

impl PlanningGateway for AdoPlanning {
    fn connect(&self, link: &str) -> Result<PlanningConnection, String> {
        let link = parse_team_link(link)?;
        let http = crate::pr_inbox::AdoTransport::connect()?;
        connect(&http, &link)
    }
    fn fetch(
        &self,
        conn: &PlanningConnection,
        selected: Option<&str>,
    ) -> Result<PlanningData, String> {
        let http = crate::pr_inbox::AdoTransport::connect()?;
        fetch(&http, conn, selected)
    }
    fn publish(&self, data: &PlanningData, draft: &[Change]) -> Result<PublishResult, String> {
        let http = crate::pr_inbox::AdoTransport::connect()?;
        Ok(publish(
            &http,
            &data.connection,
            &data.me,
            &parent_iterations(data),
            draft,
        ))
    }
    fn orphans(
        &self,
        organization: &str,
        days: u32,
    ) -> Result<Vec<crate::orphan_prs::OrphanPr>, String> {
        let http = crate::pr_inbox::AdoTransport::connect()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        crate::orphan_prs::with_cache(|cache| {
            crate::orphan_prs::read_orphans(
                &http,
                organization,
                days,
                now,
                cache,
                std::time::Instant::now(),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn parses_team_sprint_backlog_and_board_links_in_both_host_forms() {
        let want = TeamLink {
            organization: "skype".into(),
            project: "OneWork".into(),
            team: "Waimea Bay".into(),
        };
        for link in [
            "https://skype.visualstudio.com/OneWork/_sprints/taskboard/Waimea%20Bay/OneWork/CY26/H2/Q4/Oct/S22%20(Nov%208)",
            "https://dev.azure.com/skype/OneWork/_backlogs/backlog/Waimea%20Bay/Features",
            "  https://dev.azure.com/skype/OneWork/_boards/board/t/Waimea%20Bay/Stories  ",
        ] {
            assert_eq!(parse_team_link(link).unwrap(), want, "{link}");
        }
    }

    #[test]
    fn refuses_links_that_are_not_team_sprint_or_backlog_links() {
        for bad in [
            "https://github.com/o/r",
            "https://dev.azure.com/skype/OneWork/_workitems/edit/4579097",
            "https://dev.azure.com/skype/OneWork/_sprints",
            "http://dev.azure.com/skype/OneWork/_backlogs/backlog/T/Features",
            "https://a.b.visualstudio.com/P/_backlogs/backlog/T",
            "https://dev.azure.com/skype/OneWork/_backlogs/backlog/../x",
            "nope",
        ] {
            assert!(
                parse_team_link(bad)
                    .unwrap_err()
                    .contains("team sprint or backlog link"),
                "{bad}"
            );
        }
    }

    // ── A stub ADO ──

    #[derive(Default)]
    struct Stub {
        items: RefCell<std::collections::BTreeMap<i64, Value>>,
        wiql: RefCell<Vec<(String, Vec<i64>)>>,
        log: RefCell<Vec<String>>,
        next_id: RefCell<i64>,
    }

    impl Stub {
        #[allow(clippy::too_many_arguments)]
        fn item(
            &self,
            id: i64,
            kind: &str,
            title: &str,
            state: &str,
            me: bool,
            iteration: &str,
            points: Option<f64>,
            parent: Option<i64>,
            children: &[i64],
        ) {
            let mut relations = Vec::new();
            if let Some(p) = parent {
                relations.push(json!({"rel": PARENT, "url": format!("https://dev.azure.com/o/_apis/wit/workItems/{p}")}));
            }
            for c in children {
                relations.push(json!({"rel": CHILD, "url": format!("https://dev.azure.com/o/_apis/wit/workItems/{c}")}));
            }
            let assigned = if me {
                json!({"displayName":"Me","uniqueName":"me@x.com","id":"me-id"})
            } else {
                json!({"displayName":"Erwin","uniqueName":"erwin@x.com","id":"e-id"})
            };
            let mut fields = json!({
                "System.WorkItemType": kind, "System.Title": title, "System.State": state,
                "System.AssignedTo": assigned, "System.IterationPath": iteration,
            });
            if let Some(p) = points {
                fields["Microsoft.VSTS.Scheduling.StoryPoints"] = json!(p);
            }
            self.items.borrow_mut().insert(
                id,
                json!({"id": id, "rev": 1, "fields": fields, "relations": relations}),
            );
        }
    }

    impl AdoHttp for Stub {
        fn get(&self, url: reqwest::Url) -> Result<Value, String> {
            let path = url.path().to_string();
            self.log.borrow_mut().push(format!("GET {path}"));
            if path.ends_with("/connectionData") {
                return Ok(
                    json!({"authenticatedUser":{"id":"me-id","providerDisplayName":"Me","properties":{"Account":{"$value":"me@x.com"}}}}),
                );
            }
            if path.ends_with("/teamsettings/iterations") {
                return Ok(json!({"value":[
                    {"name":"S21","path":"P\\S21","attributes":{"startDate":"2026-10-12T00:00:00Z","finishDate":"2026-10-25T00:00:00Z","timeFrame":"past"}},
                    {"name":"S22","path":"P\\S22","attributes":{"startDate":"2026-10-26T00:00:00Z","finishDate":"2026-11-08T00:00:00Z","timeFrame":"current"}},
                    {"name":"S23","path":"P\\S23","attributes":{"startDate":"2026-11-09T00:00:00Z","finishDate":"2026-11-22T00:00:00Z","timeFrame":"future"}},
                ]}));
            }
            if path.ends_with("/_apis/wit/workitems") {
                let ids: Vec<i64> = url
                    .query_pairs()
                    .find(|(k, _)| k == "ids")
                    .map(|(_, v)| v.split(',').filter_map(|s| s.parse().ok()).collect())
                    .unwrap_or_default();
                let items = self.items.borrow();
                return Ok(
                    json!({"value": ids.iter().filter_map(|i| items.get(i).cloned()).collect::<Vec<_>>()}),
                );
            }
            if let Some(id) = path.rsplit('/').next().and_then(|s| s.parse::<i64>().ok()) {
                return self
                    .items
                    .borrow()
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| "ADO returned HTTP 404.".into());
            }
            Err(format!("ADO returned HTTP 404. ({path})"))
        }
        fn post(&self, url: reqwest::Url, body: &Value, _: &str) -> Result<Value, String> {
            let path = url.path().to_string();
            self.log.borrow_mut().push(format!("POST {path}"));
            if path.ends_with("/wiql") {
                let q = body["query"].as_str().unwrap_or("").to_string();
                for (needle, ids) in self.wiql.borrow().iter() {
                    if q.contains(needle.as_str()) {
                        return Ok(
                            json!({"workItems": ids.iter().map(|i| json!({"id": i})).collect::<Vec<_>>()}),
                        );
                    }
                }
                return Ok(json!({"workItems": []}));
            }
            let kind = crate::pull_requests::percent_decode(path.rsplit('/').next().unwrap_or(""))
                .trim_start_matches('$')
                .to_string();
            let mut next = self.next_id.borrow_mut();
            *next += 1;
            let id = 9000 + *next;
            let mut fields = json!({"System.WorkItemType": kind, "System.State": "New"});
            let mut relations = Vec::new();
            for op in body.as_array().unwrap() {
                let p = op["path"].as_str().unwrap();
                if let Some(f) = p.strip_prefix("/fields/") {
                    fields[f] = op["value"].clone();
                } else if p == "/relations/-" {
                    relations.push(op["value"].clone());
                }
            }
            self.items.borrow_mut().insert(
                id,
                json!({"id": id, "rev": 1, "fields": fields, "relations": relations}),
            );
            Ok(json!({"id": id, "rev": 1}))
        }
        fn patch(&self, url: reqwest::Url, body: &Value) -> Result<Value, String> {
            let id: i64 = url.path().rsplit('/').next().unwrap().parse().unwrap();
            self.log.borrow_mut().push(format!("PATCH {id}"));
            let mut items = self.items.borrow_mut();
            let item = items.get_mut(&id).ok_or("ADO returned HTTP 404.")?;
            for op in body.as_array().unwrap() {
                if op["op"] == "test" && op["value"] != item["rev"] {
                    return Err("ADO returned HTTP 412.".into());
                }
                if let Some(f) = op["path"].as_str().unwrap().strip_prefix("/fields/") {
                    item["fields"][f] = op["value"].clone();
                } else if op["path"] == "/relations/-" {
                    item["relations"]
                        .as_array_mut()
                        .unwrap()
                        .push(op["value"].clone());
                }
            }
            let rev = item["rev"].as_i64().unwrap() + 1;
            item["rev"] = json!(rev);
            Ok(json!({"id": id, "rev": rev}))
        }
    }

    fn conn() -> PlanningConnection {
        PlanningConnection {
            organization: "o".into(),
            project: "P".into(),
            team: "T".into(),
            team_id: "t".into(),
            area_path: "P\\Area".into(),
            backlog_iteration: "P\\CY26".into(),
            order_field: "Microsoft.VSTS.Common.StackRank".into(),
            effort_field: "Microsoft.VSTS.Scheduling.StoryPoints".into(),
        }
    }

    fn seeded() -> Stub {
        let s = Stub::default();
        s.item(
            100,
            "Feature",
            "Read support",
            "Active",
            true,
            "P\\Q4",
            None,
            None,
            &[1, 2, 3, 4, 5, 6],
        );
        s.items.borrow_mut().get_mut(&100).unwrap()["fields"]
            ["Microsoft.VSTS.Scheduling.TargetDate"] = json!("2026-11-22T00:00:00Z");
        s.item(
            1,
            "User Story",
            "Closed one",
            "Closed",
            true,
            "P\\S22",
            Some(1.0),
            Some(100),
            &[],
        );
        s.item(
            2,
            "User Story",
            "Auth",
            "New",
            true,
            "P\\S22",
            Some(3.0),
            Some(100),
            &[10, 11, 12],
        );
        s.item(
            3,
            "User Story",
            "App state",
            "Active",
            true,
            "P\\S22",
            Some(3.0),
            Some(100),
            &[],
        );
        s.item(
            4,
            "User Story",
            "Unestimated",
            "New",
            true,
            "P\\S22",
            None,
            Some(100),
            &[],
        );
        s.item(
            5,
            "User Story",
            "Erwin's",
            "New",
            false,
            "P\\S22",
            Some(8.0),
            Some(100),
            &[],
        );
        s.item(
            6,
            "User Story",
            "Dropped",
            "Removed",
            true,
            "P\\Q4",
            Some(5.0),
            Some(100),
            &[],
        );
        s.item(
            7,
            "User Story",
            "Left in S21",
            "Active",
            true,
            "P\\S21",
            Some(2.0),
            None,
            &[],
        );
        s.item(
            10,
            "Task",
            "t",
            "Closed",
            true,
            "P\\S22",
            None,
            Some(2),
            &[],
        );
        s.item(
            11,
            "Task",
            "t",
            "Active",
            true,
            "P\\S22",
            None,
            Some(2),
            &[],
        );
        s.item(
            12,
            "Task",
            "t",
            "Removed",
            true,
            "P\\S22",
            None,
            Some(2),
            &[],
        );
        s.wiql.borrow_mut().extend([
            ("IN ('P\\S22', 'P\\S21')".to_string(), vec![1, 2, 3, 4, 7]),
            ("'Feature'".to_string(), vec![100]),
            ("IN ('New', 'Active')".to_string(), vec![2, 3, 4, 7]),
        ]);
        s
    }

    #[test]
    fn sprint_stories_carry_their_tasks_in_state_order_without_extra_requests() {
        let plain = seeded();
        fetch(&plain, &conn(), None).unwrap();
        let stub = seeded();
        stub.item(
            13,
            "Bug",
            "A bug",
            "New",
            true,
            "P\\S22",
            None,
            Some(2),
            &[],
        );
        stub.item(
            14,
            "Task",
            "Write tests",
            "New",
            false,
            "P\\S22",
            None,
            Some(2),
            &[],
        );
        stub.item(
            15,
            "Task",
            "Docs",
            "Resolved",
            true,
            "P\\S22",
            None,
            Some(2),
            &[],
        );
        stub.items.borrow_mut().get_mut(&15).unwrap()["fields"]
            ["Microsoft.VSTS.Common.StackRank"] = json!(1.0);
        {
            let mut items = stub.items.borrow_mut();
            let relations = items.get_mut(&2).unwrap()["relations"]
                .as_array_mut()
                .unwrap();
            for c in [13, 14, 15] {
                relations.push(json!({"rel": CHILD, "url": format!("https://dev.azure.com/o/_apis/wit/workItems/{c}")}));
            }
        }
        let data = fetch(&stub, &conn(), None).unwrap();
        assert_eq!(
            stub.log.borrow().len(),
            plain.log.borrow().len(),
            "no extra requests"
        );
        let auth = data.items.iter().find(|i| i.id == 2).unwrap();
        let shown: Vec<(i64, &str, Option<&str>, bool)> = auth
            .tasks
            .iter()
            .map(|t| {
                (
                    t.id,
                    t.state.as_str(),
                    t.assigned_to.as_deref(),
                    t.assigned_to_me,
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                (14, "New", Some("Erwin"), false),
                (11, "Active", Some("Me"), true),
                (15, "Resolved", Some("Me"), true),
                (10, "Closed", Some("Me"), true),
            ],
            "by state, then backlog order; no Removed task and no Bug"
        );
        assert_eq!((auth.tasks_done, auth.tasks_total), (2, 4));
        assert_eq!(auth.tasks[0].title, "Write tests");
        assert_eq!(auth.tasks[0].rev, 1);
        assert!(auth.tasks[0].url.ends_with("/_workitems/edit/14"));
        assert!(data
            .items
            .iter()
            .filter(|i| i.id != 2)
            .all(|i| i.tasks.is_empty()));
    }

    #[test]
    fn a_state_change_writes_only_the_state_with_a_revision_test_and_holds_back_a_changed_task() {
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        let before = stub.items.borrow()[&11]["fields"].clone();
        stub.items.borrow_mut().get_mut(&10).unwrap()["rev"] = json!(2);
        stub.items.borrow_mut().get_mut(&10).unwrap()["fields"]["System.State"] = json!("Blocked");
        let draft = vec![
            Change::SetState {
                id: 11,
                rev: 1,
                state: "Closed".into(),
            },
            Change::SetState {
                id: 10,
                rev: 1,
                state: "Active".into(),
            },
            Change::SetState {
                id: 2,
                rev: 1,
                state: "Resolved".into(),
            },
        ];
        let result = publish(&stub, &conn(), &data.me, &parent_iterations(&data), &draft);
        let mut after = stub.items.borrow()[&11]["fields"].clone();
        assert_eq!(after["System.State"], "Closed");
        after["System.State"] = before["System.State"].clone();
        assert_eq!(after, before, "nothing but the state is written");
        assert_eq!(
            stub.items.borrow()[&2]["fields"]["System.State"],
            "Resolved"
        );
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(
            (
                result.conflicts[0].id,
                result.conflicts[0].field.as_str(),
                result.conflicts[0].ado_value.as_str()
            ),
            (10, "System.State", "Blocked")
        );
        assert_eq!(
            result.remaining,
            vec![Change::SetState {
                id: 10,
                rev: 1,
                state: "Active".into()
            }]
        );
    }

    #[test]
    fn a_pr_link_is_a_revision_checked_artifact_link_and_one_per_pr() {
        let pr = |id: i64| PrRef {
            id,
            project_id: "proj".into(),
            repo_id: "repo".into(),
            title: format!("PR {id}"),
        };
        let mut draft = vec![Change::LinkPr {
            id: 2,
            rev: 1,
            pr: pr(7),
        }];
        add_change(
            &mut draft,
            Change::LinkPr {
                id: 3,
                rev: 1,
                pr: pr(8),
            },
        );
        add_change(
            &mut draft,
            Change::LinkPr {
                id: 3,
                rev: 1,
                pr: pr(7),
            },
        );
        assert_eq!(
            draft,
            vec![
                Change::LinkPr {
                    id: 3,
                    rev: 1,
                    pr: pr(7)
                },
                Change::LinkPr {
                    id: 3,
                    rev: 1,
                    pr: pr(8)
                }
            ],
            "a PR's link moves; two PRs can share an item"
        );
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        stub.items.borrow_mut().get_mut(&4).unwrap()["rev"] = json!(5);
        let draft = vec![
            Change::LinkPr {
                id: 2,
                rev: 1,
                pr: pr(7),
            },
            Change::Estimate {
                id: 2,
                rev: 1,
                points: Some(2.0),
            },
            Change::LinkPr {
                id: 4,
                rev: 1,
                pr: pr(9),
            },
        ];
        let result = publish(&stub, &conn(), &data.me, &parent_iterations(&data), &draft);
        let item = stub.items.borrow()[&2].clone();
        let link = item["relations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["rel"] == "ArtifactLink")
            .unwrap()
            .clone();
        assert_eq!(link["url"], "vstfs:///Git/PullRequestId/proj%2Frepo%2F7");
        assert_eq!(
            item["fields"]["Microsoft.VSTS.Scheduling.StoryPoints"], 2.0,
            "same item, after our own write"
        );
        assert_eq!(
            result.conflicts,
            vec![Conflict {
                id: 4,
                title: "Unestimated".into(),
                field: "Links".into(),
                ado_value: "revision 5".into()
            }]
        );
        assert_eq!(
            result.remaining,
            vec![Change::LinkPr {
                id: 4,
                rev: 1,
                pr: pr(9)
            }]
        );
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        let _serial = PUBLISH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(add_to_draft(
            &db,
            Change::LinkPr {
                id: -1,
                rev: 0,
                pr: pr(1)
            }
        )
        .is_err());

        // Linked in ADO meanwhile (same revision seen): nothing to write, and it's done.
        let rev = stub.items.borrow()[&2]["rev"].as_i64().unwrap();
        let patches = || {
            stub.log
                .borrow()
                .iter()
                .filter(|l| l.starts_with("PATCH"))
                .count()
        };
        let before = patches();
        let again = publish(
            &stub,
            &conn(),
            &data.me,
            &parent_iterations(&data),
            &[Change::LinkPr {
                id: 2,
                rev,
                pr: PrRef {
                    project_id: "PROJ".into(),
                    ..pr(7)
                },
            }],
        );
        assert_eq!(
            (
                again.written.clone(),
                again.failures.len(),
                again.remaining.len()
            ),
            (vec![2], 0, 0)
        );
        assert_eq!(patches(), before, "no duplicate relation is written");
    }

    #[test]
    fn removing_and_setting_a_state_replace_each_other() {
        let mut draft = vec![Change::Remove { id: 3, rev: 1 }];
        add_change(
            &mut draft,
            Change::SetState {
                id: 3,
                rev: 1,
                state: "Resolved".into(),
            },
        );
        assert_eq!(
            draft,
            vec![Change::SetState {
                id: 3,
                rev: 1,
                state: "Resolved".into()
            }]
        );
        add_change(&mut draft, Change::Remove { id: 3, rev: 1 });
        assert_eq!(draft, vec![Change::Remove { id: 3, rev: 1 }]);
    }

    #[test]
    fn only_the_five_task_states_can_be_set() {
        let _serial = PUBLISH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        for bad in ["Removed", "Done-ish", ""] {
            let err = add_to_draft(
                &db,
                Change::SetState {
                    id: 1,
                    rev: 1,
                    state: bad.into(),
                },
            )
            .unwrap_err();
            assert!(
                err.contains("New, Active, Blocked, Resolved or Closed"),
                "{err}"
            );
        }
        add_to_draft(
            &db,
            Change::SetState {
                id: 1,
                rev: 1,
                state: "Blocked".into(),
            },
        )
        .unwrap();
        add_to_draft(
            &db,
            Change::SetState {
                id: 1,
                rev: 1,
                state: "Closed".into(),
            },
        )
        .unwrap();
        assert_eq!(
            load_draft(&db).unwrap(),
            vec![Change::SetState {
                id: 1,
                rev: 1,
                state: "Closed".into()
            }]
        );
    }

    #[test]
    fn reads_my_sprint_previous_sprint_features_and_task_progress() {
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        assert_eq!(
            data.selected_sprint, "P\\S22",
            "defaults to ADO's current sprint"
        );
        assert_eq!(data.previous_sprint.as_deref(), Some("P\\S21"));
        assert_eq!(data.me.unique_name, "me@x.com");
        let ids: Vec<i64> = data.items.iter().map(|i| i.id).collect();
        assert_eq!(
            ids,
            vec![100, 1, 2, 3, 4, 5, 6, 7],
            "features first, then stories; no tasks"
        );
        let auth = data.items.iter().find(|i| i.id == 2).unwrap();
        assert_eq!(
            (auth.tasks_done, auth.tasks_total),
            (1, 2),
            "Removed tasks don't count"
        );
        assert_eq!(auth.parent_id, Some(100));
        assert!(
            !data
                .items
                .iter()
                .find(|i| i.id == 5)
                .unwrap()
                .assigned_to_me
        );

        let summary = sprint_summary(&data);
        assert_eq!(
            summary.stories.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert_eq!(
            (
                summary.committed,
                summary.done,
                summary.to_go,
                summary.not_estimated
            ),
            (7.0, 1.0, 6.0, 1)
        );

        let features = feature_summaries(&data);
        let f = &features[0];
        assert_eq!(
            (f.done, f.pending, f.my_pending, f.not_estimated),
            (1.0, 14.0, 6.0, 1)
        );
        assert_eq!(f.sprints_left, Some(2), "S22 and S23 end by Nov 22");
        assert!(!f.at_risk);
        assert!(
            f.stories.iter().all(|s| s.id != 6),
            "Removed stories are left out"
        );
        let empty = PlanningData {
            items: vec![data.items[0].clone()],
            ..data.clone()
        };
        assert!(
            feature_summaries(&empty)[0].done.is_sign_positive(),
            "an empty sum is 0, not -0"
        );

        let picked = fetch(&stub, &conn(), Some("P\\S23")).unwrap();
        assert_eq!(
            (
                picked.selected_sprint.as_str(),
                picked.previous_sprint.as_deref()
            ),
            ("P\\S23", Some("P\\S22"))
        );
        let unknown = fetch(&stub, &conn(), Some("P\\Gone")).unwrap();
        assert_eq!(unknown.selected_sprint, "P\\S22");
    }

    #[test]
    fn a_feature_is_at_risk_when_my_pending_points_exceed_the_sprints_left() {
        let stub = seeded();
        stub.items.borrow_mut().get_mut(&100).unwrap()["fields"]
            ["Microsoft.VSTS.Scheduling.TargetDate"] = json!("2026-11-08T00:00:00Z");
        stub.item(
            8,
            "User Story",
            "Big",
            "New",
            true,
            "P\\Q4",
            Some(5.0),
            Some(100),
            &[],
        );
        stub.items.borrow_mut().get_mut(&100).unwrap()["relations"]
            .as_array_mut()
            .unwrap()
            .push(json!({"rel": CHILD, "url": "https://dev.azure.com/o/_apis/wit/workItems/8"}));
        let f = &feature_summaries(&fetch(&stub, &conn(), None).unwrap())[0];
        assert_eq!(
            (f.sprints_left, f.my_pending, f.at_risk),
            (Some(1), 11.0, true)
        );
    }

    #[test]
    fn the_draft_keeps_the_last_change_per_item_and_edits_items_not_created_yet() {
        let mut draft = Vec::new();
        add_change(
            &mut draft,
            Change::Move {
                id: 2,
                rev: 1,
                to_iteration: "S23".into(),
                assign_to_me: false,
            },
        );
        add_change(
            &mut draft,
            Change::Estimate {
                id: 2,
                rev: 1,
                points: Some(5.0),
            },
        );
        add_change(
            &mut draft,
            Change::Move {
                id: 2,
                rev: 1,
                to_iteration: "S24".into(),
                assign_to_me: false,
            },
        );
        assert_eq!(draft.len(), 2);
        assert!(matches!(&draft[0], Change::Move { to_iteration, .. } if to_iteration == "S24"));
        add_change(
            &mut draft,
            Change::CreateFeature {
                temp_id: -1,
                title: "F".into(),
                target_date: None,
                description: None,
            },
        );
        add_change(
            &mut draft,
            Change::CreateStory {
                temp_id: -2,
                parent: -1,
                title: "S".into(),
                points: Some(2.0),
                description: None,
                iteration: None,
                order: None,
            },
        );
        add_change(
            &mut draft,
            Change::Estimate {
                id: -2,
                rev: 0,
                points: Some(3.0),
            },
        );
        add_change(
            &mut draft,
            Change::Retitle {
                id: -2,
                rev: 0,
                title: "S2".into(),
            },
        );
        assert!(
            matches!(&draft[3], Change::CreateStory { points: Some(p), title, .. } if *p == 3.0 && title == "S2")
        );
        add_change(&mut draft, Change::Remove { id: -1, rev: 0 });
        assert_eq!(
            draft.len(),
            2,
            "removing an uncreated feature drops it and its stories"
        );
    }

    #[test]
    fn the_draft_and_connection_survive_a_reopen_and_a_new_team_starts_clean() {
        let path = std::env::temp_dir().join(format!("ws_planning_{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let db = Connection::open(&path).unwrap();
            crate::db::init_db(&db).unwrap();
            save_connection(&db, &conn()).unwrap();
            select_sprint(&db, "P\\S23").unwrap();
            save_draft(&db, &[Change::Remove { id: 1, rev: 1 }]).unwrap();
        }
        let db = Connection::open(&path).unwrap();
        assert_eq!(load_connection(&db).unwrap(), Some(conn()));
        assert_eq!(selected_sprint(&db).unwrap().as_deref(), Some("P\\S23"));
        assert_eq!(load_draft(&db).unwrap().len(), 1);
        save_connection(&db, &conn()).unwrap();
        assert_eq!(
            load_draft(&db).unwrap().len(),
            1,
            "same team keeps the draft"
        );
        let mut other = conn();
        other.team_id = "other".into();
        save_connection(&db, &other).unwrap();
        assert!(load_draft(&db).unwrap().is_empty());
        assert!(selected_sprint(&db).unwrap().is_none());
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn publishes_creates_and_updates_and_holds_back_only_what_changed_in_ado() {
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        // Someone else moves story 3 after it was loaded.
        {
            let mut items = stub.items.borrow_mut();
            let s3 = items.get_mut(&3).unwrap();
            s3["rev"] = json!(5);
            s3["fields"]["System.IterationPath"] = json!("P\\S24");
        }
        let draft = vec![
            Change::Move {
                id: 2,
                rev: 1,
                to_iteration: "P\\S23".into(),
                assign_to_me: false,
            },
            Change::Estimate {
                id: 2,
                rev: 1,
                points: Some(5.0),
            },
            Change::Move {
                id: 3,
                rev: 1,
                to_iteration: "P\\S23".into(),
                assign_to_me: false,
            },
            Change::Move {
                id: 5,
                rev: 1,
                to_iteration: "P\\S23".into(),
                assign_to_me: true,
            },
            Change::Remove { id: 4, rev: 1 },
            Change::CreateFeature {
                temp_id: -1,
                title: "Write support".into(),
                target_date: Some("2027-01-15".into()),
                description: None,
            },
            Change::CreateStory {
                temp_id: -2,
                parent: -1,
                title: "Frontend".into(),
                points: Some(5.0),
                description: Some("d".into()),
                iteration: None,
                order: None,
            },
            Change::CreateStory {
                temp_id: -3,
                parent: 100,
                title: "More".into(),
                points: None,
                description: None,
                iteration: None,
                order: None,
            },
        ];
        let result = publish(&stub, &conn(), &data.me, &parent_iterations(&data), &draft);
        assert!(result.failures.is_empty(), "{:?}", result.failures);
        assert_eq!(
            result.conflicts,
            vec![Conflict {
                id: 3,
                title: "App state".into(),
                field: "System.IterationPath".into(),
                ado_value: "P\\S24".into()
            }]
        );
        assert_eq!(result.remaining, vec![draft[2].clone()]);
        let items = stub.items.borrow();
        assert_eq!(items[&2]["fields"]["System.IterationPath"], "P\\S23");
        assert_eq!(
            items[&2]["fields"]["Microsoft.VSTS.Scheduling.StoryPoints"], 5.0,
            "a second change to the same item isn't a false conflict"
        );
        assert_eq!(
            items[&3]["fields"]["System.IterationPath"], "P\\S24",
            "the conflicting change wasn't written"
        );
        assert_eq!(
            items[&5]["fields"]["System.AssignedTo"], "me@x.com",
            "picking up an unassigned story assigns it"
        );
        assert_eq!(items[&4]["fields"]["System.State"], "Removed");
        let feature = items
            .values()
            .find(|v| v["fields"]["System.Title"] == "Write support")
            .unwrap();
        assert_eq!(feature["fields"]["System.WorkItemType"], "Feature");
        assert_eq!(feature["fields"]["System.IterationPath"], "P\\CY26");
        assert_eq!(
            feature["fields"]["Microsoft.VSTS.Scheduling.TargetDate"],
            "2027-01-15"
        );
        let fid = feature["id"].as_i64().unwrap();
        let story = items
            .values()
            .find(|v| v["fields"]["System.Title"] == "Frontend")
            .unwrap();
        assert_eq!(story["fields"]["System.WorkItemType"], "User Story");
        assert_eq!(
            story["fields"]["Microsoft.VSTS.Scheduling.StoryPoints"],
            5.0
        );
        assert_eq!(story["fields"]["System.AreaPath"], "P\\Area");
        assert_eq!(
            story["fields"]["System.IterationPath"], "P\\CY26",
            "a new feature's stories go at its iteration"
        );
        assert_eq!(story["fields"]["System.AssignedTo"], "me@x.com");
        assert!(story["relations"][0]["url"]
            .as_str()
            .unwrap()
            .ends_with(&format!("/workitems/{fid}")));
        let more = items
            .values()
            .find(|v| v["fields"]["System.Title"] == "More")
            .unwrap();
        assert_eq!(
            more["fields"]["System.IterationPath"], "P\\Q4",
            "an existing feature's stories go at its iteration"
        );
        assert!(stub.log.borrow().iter().all(|l| !l.starts_with("DELETE")));
        assert_eq!(
            result.written.len(),
            6,
            "2, 5, 4, the feature and two stories"
        );
    }

    /// Fails the first PATCH/POST matching a predicate, once.
    struct Flaky<'a> {
        inner: &'a Stub,
        fail_patch_field: Option<&'static str>,
        fail_post_title: Option<&'static str>,
    }
    impl AdoHttp for Flaky<'_> {
        fn get(&self, url: reqwest::Url) -> Result<Value, String> {
            self.inner.get(url)
        }
        fn post(&self, url: reqwest::Url, body: &Value, ct: &str) -> Result<Value, String> {
            if self
                .fail_post_title
                .is_some_and(|t| body.to_string().contains(t))
            {
                return Err("ADO returned HTTP 500.".into());
            }
            self.inner.post(url, body, ct)
        }
        fn patch(&self, url: reqwest::Url, body: &Value) -> Result<Value, String> {
            if self
                .fail_patch_field
                .is_some_and(|f| body.to_string().contains(f))
            {
                return Err("ADO returned HTTP 500.".into());
            }
            self.inner.patch(url, body)
        }
    }

    #[test]
    fn a_retry_after_a_partial_failure_neither_conflicts_with_our_own_write_nor_loses_a_new_parent()
    {
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        let draft = vec![
            Change::Estimate {
                id: 2,
                rev: 1,
                points: Some(5.0),
            },
            Change::Retitle {
                id: 2,
                rev: 1,
                title: "Renamed".into(),
            },
            Change::CreateFeature {
                temp_id: -1,
                title: "F".into(),
                target_date: None,
                description: None,
            },
            Change::CreateStory {
                temp_id: -2,
                parent: -1,
                title: "Child".into(),
                points: None,
                description: None,
                iteration: None,
                order: None,
            },
        ];
        let flaky = Flaky {
            inner: &stub,
            fail_patch_field: Some("System.Title"),
            fail_post_title: Some("Child"),
        };
        let first = publish(&flaky, &conn(), &data.me, &parent_iterations(&data), &draft);
        assert_eq!(first.failures.len(), 2);
        let fid = *first.written.iter().find(|id| **id > 9000).unwrap();
        // The retained changes now point at what this publish created and wrote.
        assert_eq!(
            first.remaining,
            vec![
                Change::Retitle {
                    id: 2,
                    rev: 2,
                    title: "Renamed".into()
                },
                Change::CreateStory {
                    temp_id: -2,
                    parent: fid,
                    title: "Child".into(),
                    points: None,
                    description: None,
                    iteration: None,
                    order: None
                },
            ]
        );
        let data = fetch(&stub, &conn(), None).unwrap();
        let retry = publish(
            &stub,
            &conn(),
            &data.me,
            &parent_iterations(&data),
            &first.remaining,
        );
        assert!(
            retry.conflicts.is_empty() && retry.failures.is_empty(),
            "{retry:?}"
        );
        assert_eq!(stub.items.borrow()[&2]["fields"]["System.Title"], "Renamed");
    }

    #[test]
    fn new_stories_can_be_planned_into_a_sprint_and_ordered_before_they_exist() {
        let mut draft = vec![Change::CreateStory {
            temp_id: -2,
            parent: 100,
            title: "S".into(),
            points: None,
            description: None,
            iteration: None,
            order: None,
        }];
        add_change(
            &mut draft,
            Change::Move {
                id: -2,
                rev: 0,
                to_iteration: "P\\S23".into(),
                assign_to_me: false,
            },
        );
        add_change(
            &mut draft,
            Change::Order {
                id: -2,
                rev: 0,
                order: 3000.0,
            },
        );
        assert_eq!(
            draft,
            vec![Change::CreateStory {
                temp_id: -2,
                parent: 100,
                title: "S".into(),
                points: None,
                description: None,
                iteration: Some("P\\S23".into()),
                order: Some(3000.0)
            }]
        );
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        publish(&stub, &conn(), &data.me, &parent_iterations(&data), &draft);
        let items = stub.items.borrow();
        let s = items
            .values()
            .find(|v| v["fields"]["System.Title"] == "S")
            .unwrap();
        assert_eq!(s["fields"]["System.IterationPath"], "P\\S23");
        assert_eq!(s["fields"]["Microsoft.VSTS.Common.StackRank"], 3000.0);
    }

    #[test]
    fn the_first_default_sprint_is_remembered_once() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        save_connection(&db, &conn()).unwrap();
        remember_default_sprint(&db, &conn(), "P\\S22").unwrap();
        assert_eq!(selected_sprint(&db).unwrap().as_deref(), Some("P\\S22"));
        remember_default_sprint(&db, &conn(), "P\\S23").unwrap();
        assert_eq!(
            selected_sprint(&db).unwrap().as_deref(),
            Some("P\\S22"),
            "an existing choice is never overwritten"
        );
        let mut other = conn();
        other.team_id = "other".into();
        db.execute("DELETE FROM settings WHERE key = 'planning.sprint'", [])
            .unwrap();
        remember_default_sprint(&db, &other, "P\\S23").unwrap();
        assert!(
            selected_sprint(&db).unwrap().is_none(),
            "not for a team that is no longer connected"
        );
    }

    #[test]
    fn the_saved_draft_refuses_a_taken_new_id_a_stale_replacement_and_changes_while_publishing() {
        let _serial = PUBLISH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        let feature = |temp_id: i64, title: &str| Change::CreateFeature {
            temp_id,
            title: title.into(),
            target_date: None,
            description: None,
        };
        add_to_draft(&db, feature(-1, "From the CLI")).unwrap();
        let err = add_to_draft(&db, feature(-1, "From a stale view")).unwrap_err();
        assert!(err.contains("changed meanwhile"), "{err}");
        assert_eq!(load_draft(&db).unwrap(), vec![feature(-1, "From the CLI")]);

        let stale: Vec<Change> = vec![];
        assert!(replace_draft(&db, &[], Some(&stale))
            .unwrap_err()
            .contains("changed meanwhile"));
        assert_eq!(load_draft(&db).unwrap().len(), 1);
        replace_draft(&db, &[], Some(&[feature(-1, "From the CLI")])).unwrap();
        assert!(load_draft(&db).unwrap().is_empty());

        let (guard, snapshot) = start_publish(&db).unwrap();
        assert!(snapshot.is_empty());
        assert!(add_to_draft(&db, feature(-2, "x"))
            .unwrap_err()
            .contains("Publishing"));
        assert!(replace_draft(&db, &[], None)
            .unwrap_err()
            .contains("Publishing"));
        drop(guard);
        add_to_draft(&db, feature(-2, "x")).unwrap();
    }

    #[test]
    fn changes_are_refused_while_a_publish_is_running() {
        let _serial = PUBLISH_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let guard = PublishGuard::start().unwrap();
        assert!(PublishGuard::start().is_err());
        assert!(ensure_not_publishing().unwrap_err().contains("Publishing"));
        drop(guard);
        assert!(ensure_not_publishing().is_ok());
    }

    #[test]
    fn a_failed_request_stays_in_the_draft_with_its_reason() {
        let stub = seeded();
        let data = fetch(&stub, &conn(), None).unwrap();
        let result = publish(
            &stub,
            &conn(),
            &data.me,
            &parent_iterations(&data),
            &[Change::Estimate {
                id: 404,
                rev: 1,
                points: Some(1.0),
            }],
        );
        assert_eq!(result.remaining.len(), 1);
        assert!(result.failures[0].message.contains("wasn't found"));
    }

    /// Real ADO with your `az login`, reads only:
    /// `cargo test --lib real_ado_planning -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_ado_planning_reads_the_waimea_bay_team() {
        let gateway = AdoPlanning;
        let conn = gateway
            .connect("https://skype.visualstudio.com/OneWork/_sprints/taskboard/Waimea%20Bay/OneWork/CY26/H2/Q4/Oct/S22%20(Nov%208)")
            .unwrap();
        println!("connection: {conn:?}");
        let data = gateway.fetch(&conn, None).unwrap();
        println!(
            "me {:?}; selected {}; previous {:?}; {} iterations; {} items",
            data.me,
            data.selected_sprint,
            data.previous_sprint,
            data.iterations.len(),
            data.items.len()
        );
        let sprint = sprint_summary(&data);
        println!(
            "sprint: committed {} done {} to go {} not estimated {}",
            sprint.committed, sprint.done, sprint.to_go, sprint.not_estimated
        );
        for s in &sprint.stories {
            println!(
                "  {} [{}] {:?} SP, tasks {}/{} — {}",
                s.id, s.state, s.story_points, s.tasks_done, s.tasks_total, s.title
            );
        }
        for f in feature_summaries(&data) {
            println!("feature {} target {:?}: done {} pending {} (mine {}) not estimated {} sprints left {:?} at risk {} — {}",
                f.feature.id, f.feature.target_date, f.done, f.pending, f.my_pending, f.not_estimated, f.sprints_left, f.at_risk, f.feature.title);
        }
    }
}

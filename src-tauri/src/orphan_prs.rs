//! Your pull requests with no linked work item, for Planning's Orphaned PRs
//! tab (ADR 039 amendment). One organization-level list of the PRs you
//! created in the range, then one work-item check per PR; completed PRs'
//! results are cached for an hour, so later reads mostly re-check active ones.

use crate::ado_planning::{api, base, text, whoami, AdoHttp};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The ranges the tab offers, in days.
pub const RANGES: [u32; 3] = [7, 30, 90];
const DEFAULT_DAYS: u32 = 30;
const DAYS_KEY: &str = "planning.orphans.days";
const HIDDEN_KEY: &str = "planning.orphans.hidden";
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OrphanPr {
    pub id: i64,
    pub title: String,
    pub project: String,
    pub project_id: String,
    pub repo: String,
    pub repo_id: String,
    /// "active", "draft" or "completed".
    pub state: String,
    pub created: String,
    pub url: String,
}

/// A hidden PR (id = PR id) or repo (id = repository id), with what to show.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HiddenEntry {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
pub struct Hidden {
    pub prs: Vec<HiddenEntry>,
    pub repos: Vec<HiddenEntry>,
}

/// What the tab shows: every orphan in the range (hidden ones included, so
/// they can be listed under Show hidden), the range and what is hidden.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OrphanReport {
    pub days: u32,
    pub prs: Vec<OrphanPr>,
    pub hidden: Hidden,
}

impl OrphanPr {
    pub fn is_hidden(&self, hidden: &Hidden) -> bool {
        let id = self.id.to_string();
        hidden.prs.iter().any(|h| h.id == id) || hidden.repos.iter().any(|h| h.id == self.repo_id)
    }
}

/// Whether a PR has linked work items, per organization and PR.
#[derive(Default)]
pub struct LinkCache {
    entries: HashMap<(String, i64), (bool, Instant)>,
}

impl LinkCache {
    pub fn forget(&mut self, organization: &str, pr: i64) {
        self.entries
            .remove(&(organization.to_ascii_lowercase(), pr));
    }
}

static LINK_CACHE: std::sync::LazyLock<std::sync::Mutex<LinkCache>> =
    std::sync::LazyLock::new(Default::default);

/// The shared cache, for the real reads and for publishing a link.
pub fn with_cache<T>(f: impl FnOnce(&mut LinkCache) -> T) -> T {
    let mut cache = LINK_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut cache)
}

/// `secs` since the epoch as an ISO-8601 UTC timestamp.
fn iso_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Your PRs created in the last `days` days, across every repo of the
/// organization, that aren't abandoned and have no linked work item; newest first.
pub fn read_orphans(
    http: &dyn AdoHttp,
    organization: &str,
    days: u32,
    now_secs: u64,
    cache: &mut LinkCache,
    now: Instant,
) -> Result<Vec<OrphanPr>, String> {
    let me = whoami(http, organization)?;
    let since = iso_utc(now_secs.saturating_sub(u64::from(days) * 86_400));
    let body = http.get(api(
        organization,
        &["_apis", "git", "pullrequests"],
        &[
            ("searchCriteria.creatorId", &me.id),
            ("searchCriteria.status", "all"),
            ("searchCriteria.minTime", &since),
            ("searchCriteria.queryTimeRangeType", "created"),
            ("$top", "1000"),
        ],
    ))?;
    let org_key = organization.to_ascii_lowercase();
    let mut out = Vec::new();
    for pr in body["value"].as_array().into_iter().flatten() {
        let status = pr["status"].as_str().unwrap_or("");
        if status != "active" && status != "completed" {
            continue;
        }
        let (Some(id), Some(project_id), Some(repo_id)) = (
            pr["pullRequestId"].as_i64(),
            text(&pr["repository"]["project"]["id"]),
            text(&pr["repository"]["id"]),
        ) else {
            continue;
        };
        let completed = status == "completed";
        let cached = cache
            .entries
            .get(&(org_key.clone(), id))
            .filter(|(_, at)| completed && now.duration_since(*at) < CACHE_TTL)
            .map(|(linked, _)| *linked);
        let linked = match cached {
            Some(linked) => linked,
            None => {
                let id_text = id.to_string();
                let links = http.get(api(
                    organization,
                    &[
                        &project_id,
                        "_apis",
                        "git",
                        "repositories",
                        &repo_id,
                        "pullRequests",
                        &id_text,
                        "workitems",
                    ],
                    &[],
                ))?;
                let linked = links["count"]
                    .as_i64()
                    .map(|n| n > 0)
                    .unwrap_or_else(|| links["value"].as_array().is_some_and(|v| !v.is_empty()));
                if completed {
                    cache.entries.insert((org_key.clone(), id), (linked, now));
                }
                linked
            }
        };
        if linked {
            continue;
        }
        let project = text(&pr["repository"]["project"]["name"]).unwrap_or_default();
        let repo = text(&pr["repository"]["name"]).unwrap_or_default();
        let mut url = base(organization);
        url.path_segments_mut().expect("HTTPS base").extend([
            project.as_str(),
            "_git",
            repo.as_str(),
            "pullrequest",
            &id.to_string(),
        ]);
        out.push(OrphanPr {
            id,
            title: text(&pr["title"]).unwrap_or_default(),
            state: if !completed && pr["isDraft"].as_bool() == Some(true) {
                "draft".into()
            } else {
                status.into()
            },
            created: text(&pr["creationDate"]).unwrap_or_default(),
            url: url.to_string(),
            repo: format!("{project}/{repo}"),
            project,
            project_id,
            repo_id,
        });
    }
    out.sort_by(|a, b| b.created.cmp(&a.created).then(b.id.cmp(&a.id)));
    Ok(out)
}

// ── Settings ────────────────────────────────────────────────────────────

fn get(db: &Connection, key: &str) -> Result<Option<String>, String> {
    db.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

fn set(db: &Connection, key: &str, value: &str) -> Result<(), String> {
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        [key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn load_days(db: &Connection) -> Result<u32, String> {
    Ok(get(db, DAYS_KEY)?
        .and_then(|v| v.parse().ok())
        .filter(|d| RANGES.contains(d))
        .unwrap_or(DEFAULT_DAYS))
}

pub fn save_days(db: &Connection, days: u32) -> Result<(), String> {
    if !RANGES.contains(&days) {
        return Err(format!("The range is 7, 30 or 90 days, not {days}"));
    }
    set(db, DAYS_KEY, &days.to_string())
}

pub fn load_hidden(db: &Connection) -> Result<Hidden, String> {
    Ok(get(db, HIDDEN_KEY)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

fn save_hidden(db: &Connection, hidden: &Hidden) -> Result<(), String> {
    set(
        db,
        HIDDEN_KEY,
        &serde_json::to_string(hidden).map_err(|e| e.to_string())?,
    )
}

fn list_of<'a>(hidden: &'a mut Hidden, kind: &str) -> Result<&'a mut Vec<HiddenEntry>, String> {
    match kind {
        "pr" => Ok(&mut hidden.prs),
        "repo" => Ok(&mut hidden.repos),
        other => Err(format!("Hide a \"pr\" or a \"repo\", not \"{other}\"")),
    }
}

/// Hides a PR or a repo; hiding it again keeps one entry.
pub fn hide(db: &Connection, kind: &str, entry: HiddenEntry) -> Result<Hidden, String> {
    let mut hidden = load_hidden(db)?;
    let list = list_of(&mut hidden, kind)?;
    if !list.iter().any(|h| h.id == entry.id) {
        list.push(entry);
    }
    save_hidden(db, &hidden)?;
    Ok(hidden)
}

pub fn unhide(db: &Connection, kind: &str, id: &str) -> Result<Hidden, String> {
    let mut hidden = load_hidden(db)?;
    list_of(&mut hidden, kind)?.retain(|h| h.id != id);
    save_hidden(db, &hidden)?;
    Ok(hidden)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::RefCell;

    #[derive(Default)]
    struct Stub {
        prs: Vec<Value>,
        linked: Vec<i64>,
        log: RefCell<Vec<String>>,
    }

    impl AdoHttp for Stub {
        fn get(&self, url: reqwest::Url) -> Result<Value, String> {
            let path = url.path().to_string();
            self.log
                .borrow_mut()
                .push(format!("GET {path}?{}", url.query().unwrap_or("")));
            if path.ends_with("/connectionData") {
                return Ok(
                    json!({"authenticatedUser":{"id":"me-id","providerDisplayName":"Me","properties":{"Account":{"$value":"me@x.com"}}}}),
                );
            }
            if path.ends_with("/_apis/git/pullrequests") {
                return Ok(json!({"value": self.prs}));
            }
            if path.ends_with("/workitems") {
                let id: i64 = path.split('/').rev().nth(1).unwrap().parse().unwrap();
                let n = i64::from(self.linked.contains(&id));
                return Ok(json!({"count": n, "value": vec![json!({"id": 1}); n as usize]}));
            }
            Err(format!("ADO returned HTTP 404. ({path})"))
        }
        fn post(&self, _: reqwest::Url, _: &Value, _: &str) -> Result<Value, String> {
            unreachable!()
        }
        fn patch(&self, _: reqwest::Url, _: &Value) -> Result<Value, String> {
            unreachable!()
        }
    }

    fn pr(id: i64, status: &str, draft: bool, project: &str, repo: &str, created: &str) -> Value {
        json!({
            "pullRequestId": id, "status": status, "isDraft": draft, "title": format!("PR {id}"),
            "creationDate": created,
            "repository": {"id": format!("{repo}-id"), "name": repo, "project": {"id": format!("{project}-id"), "name": project}},
        })
    }

    fn stub() -> Stub {
        Stub {
            prs: vec![
                pr(
                    1,
                    "active",
                    false,
                    "SCC",
                    "acs_media_sdk",
                    "2026-10-28T10:00:00Z",
                ),
                pr(
                    2,
                    "active",
                    true,
                    "SCC",
                    "acs_media_sdk",
                    "2026-10-27T10:00:00Z",
                ),
                pr(
                    3,
                    "completed",
                    false,
                    "SCC",
                    "engaine",
                    "2026-10-29T10:00:00Z",
                ),
                pr(
                    4,
                    "completed",
                    false,
                    "OneWork",
                    "other",
                    "2026-10-20T10:00:00Z",
                ),
                pr(
                    5,
                    "completed",
                    false,
                    "SCC",
                    "engaine",
                    "2026-10-26T10:00:00Z",
                ),
                pr(
                    6,
                    "abandoned",
                    false,
                    "SCC",
                    "engaine",
                    "2026-10-25T10:00:00Z",
                ),
            ],
            linked: vec![5],
            log: RefCell::default(),
        }
    }

    // 2026-10-30T12:00:00Z
    const NOW: u64 = 1_793_361_600;

    #[test]
    fn lists_my_unlinked_prs_from_one_org_level_query_newest_first() {
        let s = stub();
        let prs =
            read_orphans(&s, "o", 30, NOW, &mut LinkCache::default(), Instant::now()).unwrap();
        assert_eq!(
            prs.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![3, 1, 2, 4]
        );
        assert_eq!(
            prs.iter().map(|p| p.state.as_str()).collect::<Vec<_>>(),
            vec!["completed", "active", "draft", "completed"]
        );
        assert_eq!(prs[0].repo, "SCC/engaine");
        assert_eq!(
            prs[0].url,
            "https://dev.azure.com/o/SCC/_git/engaine/pullrequest/3"
        );
        let log = s.log.borrow();
        let lists: Vec<&String> = log
            .iter()
            .filter(|l| l.contains("/_apis/git/pullrequests?"))
            .collect();
        assert_eq!(lists.len(), 1, "one org-level list");
        assert!(lists[0].starts_with("GET /o/_apis/git/pullrequests?"));
        assert!(lists[0].contains("searchCriteria.creatorId=me-id"));
        assert!(lists[0].contains("searchCriteria.minTime=2026-09-30T12%3A00%3A00Z"));
        assert!(lists[0].contains("queryTimeRangeType=created"));
        assert_eq!(
            log.iter().filter(|l| l.contains("/workitems")).count(),
            5,
            "abandoned PRs aren't checked"
        );
        assert!(log.iter().any(|l| l.starts_with(
            "GET /o/SCC-id/_apis/git/repositories/engaine-id/pullRequests/3/workitems"
        )));
    }

    #[test]
    fn completed_prs_are_checked_once_an_hour_and_active_ones_every_read() {
        let s = stub();
        let mut cache = LinkCache::default();
        let start = Instant::now();
        read_orphans(&s, "o", 30, NOW, &mut cache, start).unwrap();
        let checks = |s: &Stub| {
            s.log
                .borrow()
                .iter()
                .filter(|l| l.contains("/workitems"))
                .count()
        };
        assert_eq!(checks(&s), 5);
        read_orphans(
            &s,
            "o",
            30,
            NOW,
            &mut cache,
            start + Duration::from_secs(300),
        )
        .unwrap();
        assert_eq!(checks(&s), 7, "only the 2 active PRs again");
        cache.forget("O", 3);
        read_orphans(
            &s,
            "o",
            30,
            NOW,
            &mut cache,
            start + Duration::from_secs(600),
        )
        .unwrap();
        assert_eq!(checks(&s), 10, "a forgotten PR is checked again");
        read_orphans(
            &s,
            "o",
            30,
            NOW,
            &mut cache,
            start + Duration::from_secs(3 * 3600),
        )
        .unwrap();
        assert_eq!(checks(&s), 15, "and everything after an hour");
    }

    #[test]
    fn the_range_and_hidden_prs_and_repos_are_remembered() {
        let db = Connection::open_in_memory().unwrap();
        crate::db::init_db(&db).unwrap();
        assert_eq!(load_days(&db).unwrap(), 30);
        save_days(&db, 90).unwrap();
        assert_eq!(load_days(&db).unwrap(), 90);
        assert!(save_days(&db, 45).unwrap_err().contains("7, 30 or 90"));
        let entry = |id: &str, label: &str| HiddenEntry {
            id: id.into(),
            label: label.into(),
        };
        hide(&db, "pr", entry("4", "PR 4")).unwrap();
        hide(&db, "pr", entry("4", "PR 4")).unwrap();
        hide(&db, "repo", entry("engaine-id", "SCC/engaine")).unwrap();
        assert!(hide(&db, "branch", entry("x", "x")).is_err());
        let hidden = load_hidden(&db).unwrap();
        assert_eq!((hidden.prs.len(), hidden.repos.len()), (1, 1));
        let prs = read_orphans(
            &stub(),
            "o",
            30,
            NOW,
            &mut LinkCache::default(),
            Instant::now(),
        )
        .unwrap();
        let shown: Vec<i64> = prs
            .iter()
            .filter(|p| !p.is_hidden(&hidden))
            .map(|p| p.id)
            .collect();
        assert_eq!(shown, vec![1, 2]);
        let hidden = unhide(&db, "repo", "engaine-id").unwrap();
        assert!(hidden.repos.is_empty() && hidden.prs.len() == 1);
    }

    #[test]
    fn formats_dates_in_utc() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(NOW), "2026-10-30T12:00:00Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
    }
}

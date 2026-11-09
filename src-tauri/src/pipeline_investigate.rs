//! Investigating a failed pipeline run (ADR 038 amendment, 2026-11-09).
//!
//! One click on a failed run's Inbox notification makes a workstream for it:
//! a worktree of the pipeline's repo, on a new branch from the branch the run
//! built, or a standalone workstream when there is no repo or the worktree
//! can't be made. Its Copilot session is started by the app with a prompt
//! describing the run. One investigation per run: asking again returns it.
//!
//! The work is split so the caller decides about the database lock: `target`
//! and `record` touch the database, `place` does git work and must not hold it.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::agent_registry::Provisioner;
use crate::pipeline_inbox::{AdoRepoRef, PipelineItem};

/// A failed run to investigate, with where its code lives.
#[derive(Clone, Debug)]
pub struct Target {
    pub item: PipelineItem,
    /// The first of the pipeline's Workstreams repos (chip order), with its folder.
    pub repo: Option<(String, String, String)>,
    /// What ADO says the pipeline builds, for the prompt when no repo is linked.
    pub ado_repo: Option<AdoRepoRef>,
}

/// Where the investigation works.
#[derive(Clone, Debug, PartialEq)]
pub enum Placement {
    Worktree {
        path: String,
        project_id: String,
        repo_name: String,
        branch: String,
        base: Option<String>,
    },
    /// No local checkout; `failure` says why a worktree couldn't be made.
    Standalone {
        directory: String,
        failure: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Started {
    pub workstream_id: String,
    pub created: bool,
}

/// An investigation whose Copilot session the app hasn't started yet.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PendingSession {
    pub event_id: String,
    pub workstream_id: String,
    pub directory: String,
    pub prompt: String,
}

fn starting() -> &'static Mutex<HashSet<String>> {
    static STARTING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    STARTING.get_or_init(Default::default)
}

/// A run whose investigation this caller is starting; released on drop.
pub struct Claim(String);

impl Drop for Claim {
    fn drop(&mut self) {
        if let Ok(mut set) = starting().lock() {
            set.remove(&self.0);
        }
    }
}

/// Claims a run so the UI and an agent can't both make its worktree. Fails,
/// rather than waits, when another caller has it: an agent holds the database
/// lock the other caller needs to finish.
pub fn claim(event_id: &str) -> Result<Claim, String> {
    let mut set = starting().lock().map_err(|e| e.to_string())?;
    if !set.insert(event_id.to_string()) {
        return Err(
            "This run's investigation is already being started; try again in a moment.".into(),
        );
    }
    Ok(Claim(event_id.to_string()))
}

/// Looks up a notification to investigate. Only failed runs can be.
pub fn target(db: &Connection, event_id: &str) -> Result<Target, String> {
    let (item, repos, ado_repo) = crate::pipeline_inbox::item_with_repos(db, event_id)?
        .ok_or_else(|| format!("No pipeline notification with id {event_id}"))?;
    if item.result != "failed" {
        return Err(format!(
            "Only failed runs can be investigated; run #{} {}",
            item.run_number, item.result
        ));
    }
    let repo = match repos.first() {
        Some(r) => db
            .query_row(
                "SELECT directory FROM projects WHERE id = ?1",
                [&r.id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .map(|dir| (r.id.clone(), r.name.clone(), dir)),
        None => None,
    };
    Ok(Target {
        item,
        repo,
        ado_repo,
    })
}

/// The investigation workstream of a run, if it (and its workstream) exists.
pub fn existing(db: &Connection, event_id: &str) -> Result<Option<String>, String> {
    db.query_row(
        "SELECT w.id FROM pipeline_investigations i JOIN workstreams w ON w.id = i.workstream_id
        WHERE i.event_id = ?1",
        [event_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        let keep = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
        let c = if keep { c } else { '-' };
        if (c == '-' || c == '.') && out.ends_with(c) {
            continue;
        }
        out.push(c);
    }
    out.trim_matches(|c| c == '-' || c == '.').to_string()
}

/// `investigate/<pipeline>-<run number>`, as a valid git branch name.
pub fn branch_name(item: &PipelineItem) -> String {
    format!(
        "investigate/{}-{}",
        slug(&item.pipeline_name),
        slug(&item.run_number)
    )
}

pub fn workstream_name(item: &PipelineItem) -> String {
    format!("Investigate {} #{}", item.pipeline_name, item.run_number)
}

/// The ref the worktree starts from: the run's branch on origin. A run of a
/// non-branch ref (a PR merge, a tag) has none, and starts from the default.
fn base_of(item: &PipelineItem) -> Option<(String, String)> {
    let branch = item.branch.trim();
    (!branch.is_empty() && !branch.starts_with("refs/"))
        .then(|| (branch.to_string(), format!("origin/{branch}")))
}

/// Makes the worktree, or decides on a standalone workstream in `home` when
/// there is no repo or git fails. Never fails itself.
pub fn place(provisioner: Option<&dyn Provisioner>, target: &Target, home: &str) -> Placement {
    let standalone = |failure: Option<String>| Placement::Standalone {
        directory: home.to_string(),
        failure,
    };
    let (Some((project_id, repo_name, directory)), Some(provisioner)) = (&target.repo, provisioner)
    else {
        return standalone(None);
    };
    // A run of a non-branch ref starts from the default branch, named
    // explicitly: no base would branch from whatever the checkout has out.
    let Some((fetch, base)) = base_of(&target.item).or_else(|| {
        provisioner
            .default_branch(directory)
            .map(|b| (b.clone(), format!("origin/{b}")))
    }) else {
        return standalone(Some(
            "couldn't tell the repo's default branch to start from".into(),
        ));
    };
    // Never check out an existing branch: it holds other work. The next free name is used.
    let wanted = branch_name(&target.item);
    let free = |b: &str| {
        !provisioner.branch_exists(directory, b)
            && !provisioner
                .derive_worktree_path(directory, b)
                .map(|d| d.exists)
                .unwrap_or(false)
    };
    let Some(branch) = std::iter::once(wanted.clone())
        .chain((2..=20).map(|n| format!("{wanted}-{n}")))
        .find(|b| free(b))
    else {
        return standalone(Some(format!("branches {wanted} to {wanted}-20 all exist")));
    };
    if let Err(error) = provisioner.fetch_branch(directory, &fetch) {
        return standalone(Some(error));
    }
    match provisioner.create_worktree(directory, &branch, Some(&base)) {
        Ok(path) => Placement::Worktree {
            path,
            project_id: project_id.clone(),
            repo_name: repo_name.clone(),
            branch,
            base: Some(base),
        },
        Err(error) => standalone(Some(error)),
    }
}

/// `https://dev.azure.com/<org>/…` → `<org>`.
fn organization(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()?
        .path_segments()?
        .next()
        .filter(|s| !s.is_empty())
        .map(crate::pull_requests::percent_decode)
}

/// What the investigation's Copilot session is asked.
pub fn prompt(target: &Target, placement: &Placement) -> String {
    let item = &target.item;
    let repo = match placement {
        Placement::Worktree { repo_name, .. } => repo_name.clone(),
        Placement::Standalone { .. } => target
            .repo
            .as_ref()
            .map(|r| r.1.clone())
            .or_else(|| target.ado_repo.as_ref().map(|r| r.display()))
            .unwrap_or_else(|| "none linked".into()),
    };
    let location = match placement {
        Placement::Worktree { branch, base, .. } if base_of(item).is_some() => format!(
            "You are in a worktree of {repo} on a new branch {branch}, created from {}: the code that failed.",
            base.as_deref().unwrap_or_default()
        ),
        Placement::Worktree { branch, base, .. } => format!(
            "You are in a worktree of {repo} on a new branch {branch}, created from {} (the default branch); the run built {}.",
            base.as_deref().unwrap_or("the default branch"),
            item.branch
        ),
        Placement::Standalone { failure: None, .. } => {
            "There is no local checkout of this pipeline's repo; work from Azure DevOps.".into()
        }
        Placement::Standalone {
            failure: Some(error),
            ..
        } => format!(
            "There is no local checkout: creating a worktree of {repo} failed ({}). Work from Azure DevOps.",
            error.trim()
        ),
    };
    let org = organization(&item.url).unwrap_or_else(|| "<organization>".into());
    format!(
        "Investigate a failed Azure DevOps pipeline run.

- Pipeline: {name} (project {project})
- Run: #{number} (id {id}), result: {result}
- Branch: {branch}
- Trigger: {trigger}
- Finished: {finished}
- Repo: {repo}
- Run: {url}

{location}

Get the run's failing steps and logs yourself with the Azure CLI (az), for example \
`az pipelines runs show --id {id} --org https://dev.azure.com/{org} --project \"{project}\"`, \
then the build timeline and logs through `az devops invoke --area build`.

Goal: find the root cause and classify it as code, pipeline, infrastructure or flakiness, \
and propose a fix. Don't change any code, commit, push or re-run anything until I ask: \
report your diagnosis first.",
        name = item.pipeline_name,
        project = item.project,
        number = item.run_number,
        id = item.run_id,
        result = item.result,
        branch = item.branch,
        trigger = item.trigger,
        finished = item.finished_at,
        url = item.url,
    )
}

/// Creates the investigation's workstream and records it, unless one was
/// recorded meanwhile (then that one is returned and nothing is written).
pub fn record(
    db: &Connection,
    target: &Target,
    placement: &Placement,
    created_by_session: Option<String>,
) -> Result<Started, String> {
    if let Some(id) = existing(db, &target.item.id)? {
        return Ok(Started {
            workstream_id: id,
            created: false,
        });
    }
    let (directory, project_id, kind, worktree_branch) = match placement {
        Placement::Worktree {
            path,
            project_id,
            branch,
            ..
        } => (
            path.clone(),
            Some(project_id.clone()),
            "worktree",
            Some(branch.clone()),
        ),
        Placement::Standalone { directory, .. } => (directory.clone(), None, "standalone", None),
    };
    let workstream = crate::insert_workstream(
        db,
        crate::NewWorkstream {
            name: workstream_name(&target.item),
            directory: Some(directory),
            description: Some(format!("Investigating {}", target.item.url)),
            project_id,
            workstream_type: Some(kind.into()),
            worktree_branch,
            created_by_session,
        },
    )?;
    db.execute(
        "INSERT OR REPLACE INTO pipeline_investigations (event_id, workstream_id, prompt, session_started, created_at)
        VALUES (?1, ?2, ?3, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        params![target.item.id, workstream.id, prompt(target, placement)],
    )
    .map_err(|e| e.to_string())?;
    Ok(Started {
        workstream_id: workstream.id,
        created: true,
    })
}

/// Investigations whose session the app hasn't started yet.
pub fn pending_sessions(db: &Connection) -> Result<Vec<PendingSession>, String> {
    let mut stmt = db
        .prepare(
            "SELECT i.event_id, i.workstream_id, COALESCE(w.directory, ''), i.prompt
            FROM pipeline_investigations i JOIN workstreams w ON w.id = i.workstream_id
            WHERE i.session_started = 0 ORDER BY i.created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PendingSession {
                event_id: r.get(0)?,
                workstream_id: r.get(1)?,
                directory: r.get(2)?,
                prompt: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn mark_session_started(db: &Connection, event_id: &str) -> Result<(), String> {
    db.execute(
        "UPDATE pipeline_investigations SET session_started = 1 WHERE event_id = ?1",
        [event_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// The folder a standalone investigation works in: the home directory.
pub fn home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_registry::DerivedWorktree;
    use std::sync::Mutex;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn
    }

    /// Records git calls; fails when told to.
    #[derive(Default)]
    struct FakeGit {
        calls: Mutex<Vec<String>>,
        fail_worktree: Option<String>,
        fail_fetch: Option<String>,
        /// Branches (or their folders) that already exist.
        taken: Vec<String>,
        default_branch: Option<String>,
    }
    impl Provisioner for FakeGit {
        fn derive_worktree_path(&self, _: &str, branch: &str) -> Result<DerivedWorktree, String> {
            Ok(DerivedWorktree {
                path: format!("/wt/{branch}"),
                exists: false,
            })
        }
        fn branch_exists(&self, _: &str, branch: &str) -> bool {
            self.taken.iter().any(|b| b == branch)
        }
        fn default_branch(&self, _: &str) -> Option<String> {
            self.default_branch.clone()
        }
        fn create_worktree(
            &self,
            dir: &str,
            branch: &str,
            base: Option<&str>,
        ) -> Result<String, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("worktree {dir} {branch} {}", base.unwrap_or("-")));
            match &self.fail_worktree {
                Some(e) => Err(e.clone()),
                None => Ok(format!("/wt/{branch}")),
            }
        }
        fn fetch_branch(&self, dir: &str, branch: &str) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("fetch {dir} {branch}"));
            match &self.fail_fetch {
                Some(e) => Err(e.clone()),
                None => Ok(()),
            }
        }
    }

    /// A watched pipeline with one failed and one succeeded run; the pipeline
    /// builds SCC/media_components, which two repos check out.
    fn seed(db: &Connection, repos: bool, branch: &str) -> (String, String) {
        for (id, name) in [("mc", "media_components"), ("mc2", "media_components 2nd")] {
            if repos {
                db.execute(
                    "INSERT INTO projects (id, name, directory, git_remote, created_at, updated_at)
                    VALUES (?1, ?2, ?3, 'https://dev.azure.com/skype/SCC/_git/media_components', ?4, 'now')",
                    params![id, name, format!("/code/{id}"), format!("2026-01-0{}", if id == "mc" { 1 } else { 2 })],
                )
                .unwrap();
            }
        }
        let mut p = crate::pipeline_inbox::ResolvedPipeline {
            organization: "skype".into(),
            project_id: "proj".into(),
            project_name: "SCC".into(),
            definition_id: 812,
            name: "media_components-CI".into(),
            repository: None,
        };
        p.repository = Some(AdoRepoRef {
            id: "g".into(),
            kind: "azure".into(),
            organization: "skype".into(),
            project: "SCC".into(),
            name: "media_components".into(),
        });
        let watch =
            crate::pipeline_inbox::add(db, &p, Some(crate::pipeline_inbox::PipelineMode::Both))
                .unwrap();
        for (event, run, result) in [
            ("e-fail", 81724709, "failed"),
            ("e-ok", 81724710, "succeeded"),
        ] {
            db.execute(
                "INSERT INTO pipeline_events (id, watch_id, run_id, run_number, result, branch, trigger_label, finished_at, created_at)
                VALUES (?1, ?2, ?3, '20261105.3', ?4, ?5, 'Scheduled', '2026-11-05T08:10:44Z', 'now')",
                params![event, watch.id, run, result, branch],
            )
            .unwrap();
        }
        ("e-fail".into(), "e-ok".into())
    }

    #[test]
    fn a_failed_run_with_a_repo_gets_a_worktree_from_its_branch() {
        let db = db();
        let (failed, ok) = seed(&db, true, "release/2.4");
        assert!(target(&db, &ok).unwrap_err().contains("Only failed runs"));
        assert!(target(&db, "nope")
            .unwrap_err()
            .contains("No pipeline notification"));

        let t = target(&db, &failed).unwrap();
        assert_eq!(
            t.repo.as_ref().map(|r| r.0.as_str()),
            Some("mc"),
            "the first linked repo"
        );
        let git = FakeGit::default();
        let placement = place(Some(&git), &t, "/home/me");
        assert_eq!(
            *git.calls.lock().unwrap(),
            vec![
                "fetch /code/mc release/2.4".to_string(),
                "worktree /code/mc investigate/media_components-CI-20261105.3 origin/release/2.4"
                    .to_string(),
            ]
        );
        let started = record(&db, &t, &placement, None).unwrap();
        assert!(started.created);
        let (name, kind, dir, branch, project): (String, String, String, String, String) = db
            .query_row(
                "SELECT name, workstream_type, directory, worktree_branch, project_id FROM workstreams WHERE id = ?1",
                [&started.workstream_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            (
                name.as_str(),
                kind.as_str(),
                dir.as_str(),
                branch.as_str(),
                project.as_str()
            ),
            (
                "Investigate media_components-CI #20261105.3",
                "worktree",
                "/wt/investigate/media_components-CI-20261105.3",
                "investigate/media_components-CI-20261105.3",
                "mc"
            )
        );

        // One investigation per run, shown on the notification and kept.
        assert_eq!(
            existing(&db, &failed).unwrap(),
            Some(started.workstream_id.clone())
        );
        let again = record(&db, &t, &placement, None).unwrap();
        assert_eq!(
            (again.workstream_id, again.created),
            (started.workstream_id.clone(), false)
        );
        let item = crate::pipeline_inbox::items(&db)
            .unwrap()
            .into_iter()
            .find(|i| i.id == failed)
            .unwrap();
        assert_eq!(item.investigation, Some(started.workstream_id.clone()));

        let pending = pending_sessions(&db).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].directory,
            "/wt/investigate/media_components-CI-20261105.3"
        );
        mark_session_started(&db, &failed).unwrap();
        assert!(pending_sessions(&db).unwrap().is_empty());
    }

    #[test]
    fn no_repo_or_a_failed_worktree_falls_back_to_standalone_and_says_why() {
        let db = db();
        let (failed, _) = seed(&db, false, "main");
        let t = target(&db, &failed).unwrap();
        let git = FakeGit::default();
        let placement = place(Some(&git), &t, "/home/me");
        assert_eq!(
            placement,
            Placement::Standalone {
                directory: "/home/me".into(),
                failure: None
            }
        );
        assert!(git.calls.lock().unwrap().is_empty());
        let text = prompt(&t, &placement);
        assert!(text.contains("no local checkout"), "{text}");
        assert!(text.contains("Repo: SCC/media_components"), "{text}");

        let db = super::tests::db();
        let (failed, _) = seed(&db, true, "gone");
        let t = target(&db, &failed).unwrap();
        let broken = FakeGit {
            fail_worktree: Some("invalid reference: origin/gone".into()),
            ..Default::default()
        };
        let placement = place(Some(&broken), &t, "/home/me");
        assert!(
            matches!(&placement, Placement::Standalone { failure: Some(e), .. } if e.contains("origin/gone"))
        );
        let started = record(&db, &t, &placement, None).unwrap();
        let kind: String = db
            .query_row(
                "SELECT workstream_type FROM workstreams WHERE id = ?1",
                [&started.workstream_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kind, "standalone");
        let text = &pending_sessions(&db).unwrap()[0].prompt;
        assert!(
            text.contains(
                "creating a worktree of media_components failed (invalid reference: origin/gone)"
            ),
            "{text}"
        );

        let unfetchable = FakeGit {
            fail_fetch: Some("couldn't find remote ref".into()),
            ..Default::default()
        };
        assert!(matches!(
            place(Some(&unfetchable), &t, "/h"),
            Placement::Standalone {
                failure: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn the_prompt_carries_the_run_and_asks_for_a_report() {
        let db = db();
        let (failed, _) = seed(&db, true, "release/2.4");
        let t = target(&db, &failed).unwrap();
        let text = prompt(&t, &place(Some(&FakeGit::default()), &t, "/h"));
        for needle in [
            "media_components-CI",
            "SCC",
            "#20261105.3",
            "81724709",
            "failed",
            "release/2.4",
            "Scheduled",
            "2026-11-05T08:10:44Z",
            "Repo: media_components",
            "https://dev.azure.com/skype/SCC/_build/results?buildId=81724709",
            "az pipelines runs show",
            "--org https://dev.azure.com/skype",
            "code, pipeline, infrastructure or flakiness",
            "Don't change any code",
            "created from origin/release/2.4",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
    }

    #[test]
    fn branch_names_are_valid_and_pr_runs_start_from_the_default_branch() {
        let mut item = crate::pipeline_inbox::items(&{
            let db = db();
            seed(&db, false, "refs/pull/12/merge");
            db
        })
        .unwrap()
        .remove(0);
        assert_eq!(base_of(&item), None);
        item.pipeline_name = "My Pipeline: nightly..x".into();
        item.run_number = "20261105.3".into();
        assert_eq!(
            branch_name(&item),
            "investigate/My-Pipeline-nightly.x-20261105.3"
        );
    }

    #[test]
    fn an_existing_branch_is_never_reused_the_next_free_name_is_taken() {
        let db = db();
        let (failed, _) = seed(&db, true, "release/2.4");
        let t = target(&db, &failed).unwrap();
        let git = FakeGit {
            taken: vec![
                "investigate/media_components-CI-20261105.3".into(),
                "investigate/media_components-CI-20261105.3-2".into(),
            ],
            ..Default::default()
        };
        let placement = place(Some(&git), &t, "/h");
        assert!(
            matches!(&placement, Placement::Worktree { branch, base: Some(base), .. }
                if branch == "investigate/media_components-CI-20261105.3-3" && base == "origin/release/2.4"),
            "{placement:?}"
        );
    }

    #[test]
    fn a_pr_run_branches_from_origin_default_or_falls_back_when_unknown() {
        let db = db();
        let (failed, _) = seed(&db, true, "refs/pull/12/merge");
        let t = target(&db, &failed).unwrap();
        let git = FakeGit {
            default_branch: Some("main".into()),
            ..Default::default()
        };
        let placement = place(Some(&git), &t, "/h");
        assert_eq!(
            *git.calls.lock().unwrap(),
            vec![
                "fetch /code/mc main".to_string(),
                "worktree /code/mc investigate/media_components-CI-20261105.3 origin/main"
                    .to_string(),
            ]
        );
        let text = prompt(&t, &placement);
        assert!(
            text.contains(
                "created from origin/main (the default branch); the run built refs/pull/12/merge"
            ),
            "{text}"
        );
        let unknown = place(Some(&FakeGit::default()), &t, "/h");
        assert!(
            matches!(&unknown, Placement::Standalone { failure: Some(e), .. } if e.contains("default branch")),
            "{unknown:?}"
        );
    }

    #[test]
    fn only_one_caller_at_a_time_may_start_a_runs_investigation() {
        let first = claim("e-claim").expect("free");
        assert!(claim("e-claim").is_err());
        assert!(claim("e-other").is_ok());
        drop(first);
        assert!(claim("e-claim").is_ok());
    }

    #[test]
    fn a_deleted_investigation_workstream_counts_as_none() {
        let db = db();
        let (failed, _) = seed(&db, false, "main");
        let t = target(&db, &failed).unwrap();
        let first = record(&db, &t, &place(None, &t, "/h"), None).unwrap();
        db.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        db.execute(
            "DELETE FROM workstreams WHERE id = ?1",
            [&first.workstream_id],
        )
        .unwrap();
        assert_eq!(existing(&db, &failed).unwrap(), None);
        let second = record(&db, &t, &place(None, &t, "/h"), None).unwrap();
        assert!(second.created);
        assert_ne!(second.workstream_id, first.workstream_id);
    }
}

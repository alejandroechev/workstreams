//! The daily failure digest of Daily-failures pipelines (ADR 045).
//!
//! A pipeline in Daily failures mode notifies no single run. Its runs are
//! kept here instead, and once a day, at one global digest time, each such
//! pipeline with at least one failed run since its previous digest gets one
//! Inbox entry summarising them. Each failed run also gets the name of its
//! failing step, from one ADO timeline request, capped per pipeline per day.
//!
//! Everything clock-dependent takes a [`Clock`], so tests drive time (DST
//! days included) without waiting for it.

use chrono::{DateTime, Duration, NaiveDateTime, TimeZone, Utc};
use rusqlite::{params, Connection};

use crate::pipeline_inbox::Run;

/// When digests are posted unless the user picks another time.
pub const DEFAULT_TIME: &str = "09:00";
/// Failed runs per pipeline per local day whose failing step is fetched.
pub const FETCHES_PER_DAY: i64 = 20;
/// The longest gap one digest covers (a missed digest after a long absence).
pub const MAX_WINDOW_DAYS: i64 = 7;

/// A time zone, as far as the digest needs one.
pub trait Zone: Send + Sync {
    /// The wall-clock time of an instant.
    fn local(&self, at: DateTime<Utc>) -> NaiveDateTime;
    /// The instant a wall-clock time names: the earlier one when the clock is
    /// set back, the first instant after the gap when it springs forward.
    fn instant(&self, local: NaiveDateTime) -> DateTime<Utc>;
}

/// The machine's time zone.
pub struct SystemZone;

impl Zone for SystemZone {
    fn local(&self, at: DateTime<Utc>) -> NaiveDateTime {
        at.with_timezone(&chrono::Local).naive_local()
    }

    fn instant(&self, local: NaiveDateTime) -> DateTime<Utc> {
        resolve(&chrono::Local, local)
    }
}

/// Resolves a wall-clock time in a chrono time zone (see [`Zone::instant`]).
pub fn resolve<Tz: TimeZone>(tz: &Tz, local: NaiveDateTime) -> DateTime<Utc> {
    for minutes in 0..=180 {
        let probe = local + Duration::minutes(minutes);
        if let Some(at) = tz.from_local_datetime(&probe).earliest() {
            return at.with_timezone(&Utc);
        }
    }
    Utc.from_utc_datetime(&local)
}

/// "Now", and the zone wall-clock times are read in.
pub struct Clock<'a> {
    pub now: DateTime<Utc>,
    pub zone: &'a dyn Zone,
}

impl Clock<'static> {
    pub fn system() -> Self {
        Clock {
            now: Utc::now(),
            zone: &SystemZone,
        }
    }
}

impl Clock<'_> {
    /// Today's local date, as `YYYY-MM-DD`.
    pub fn local_day(&self) -> String {
        self.zone
            .local(self.now)
            .date()
            .format("%Y-%m-%d")
            .to_string()
    }

    /// `now` as the database stores times.
    pub fn stamp(&self) -> String {
        stamp(self.now)
    }
}

pub fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Reads a stored or ADO time (any number of fractional digits).
pub fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

// ── Keeping runs ────────────────────────────────────────────────────────

/// Keeps the runs a Daily-failures check saw that count for its digest:
/// in-scope runs that finished after the quiet period. A failed run gets a
/// fetch slot for its failing step while the pipeline has fewer than
/// [`FETCHES_PER_DAY`] today; later ones are marked "not fetched". A run
/// already covered by a digest is never changed.
pub(crate) fn store_runs(
    db: &Connection,
    watch_id: &str,
    runs: &[&Run],
    local_day: &str,
) -> Result<(), String> {
    for run in runs {
        db.execute(
            "INSERT INTO pipeline_digest_runs
            (watch_id,run_id,run_number,result,branch,trigger_label,finished_at,commit_sha,seen_at)
            SELECT ?1,?2,?3,?4,?5,?6,?7,?8,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM pipeline_watches
            WHERE id=?1 AND julianday(?7) > julianday(notify_after)
            ON CONFLICT(watch_id,run_id) DO UPDATE SET result=excluded.result,
              run_number=excluded.run_number, finished_at=excluded.finished_at,
              commit_sha=excluded.commit_sha
            WHERE digest_id IS NULL AND result <> excluded.result",
            params![
                watch_id,
                run.id,
                run.number,
                run.result,
                run.branch,
                run.trigger,
                run.finished_at,
                run.commit
            ],
        )
        .map_err(|e| e.to_string())?;
        if run.result != "failed" {
            continue;
        }
        let used: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM pipeline_digest_runs WHERE watch_id=?1 AND fetch_day=?2",
                params![watch_id, local_day],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let (state, day) = if used < FETCHES_PER_DAY {
            ("pending", Some(local_day))
        } else {
            ("not_fetched", None)
        };
        db.execute(
            "UPDATE pipeline_digest_runs SET step_state=?3, fetch_day=?4
            WHERE watch_id=?1 AND run_id=?2 AND result='failed' AND step_state='none' AND digest_id IS NULL",
            params![watch_id, run.id, state, day],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Forgets a pipeline's runs that no digest covered: they will never be in one.
pub(crate) fn drop_undigested(db: &Connection, watch_id: &str) -> Result<(), String> {
    db.execute(
        "UPDATE pipeline_digest_runs SET digest_id='dropped' WHERE watch_id=?1 AND digest_id IS NULL",
        [watch_id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ── Failing steps ───────────────────────────────────────────────────────

/// The failing step of a run, from its build timeline: the failed task that
/// started first, else a failed job, phase or stage.
pub fn failing_step(timeline: &serde_json::Value) -> Option<String> {
    let records = timeline["records"].as_array()?;
    for kind in ["Task", "Job", "Phase", "Stage"] {
        let first = records
            .iter()
            .filter(|r| r["type"] == kind && r["result"] == "failed")
            .filter(|r| r["name"].as_str().is_some_and(|n| !n.trim().is_empty()))
            .min_by_key(|r| {
                (
                    r["startTime"]
                        .as_str()
                        .and_then(parse_time)
                        .map(|t| t.timestamp_nanos_opt().unwrap_or(i64::MAX))
                        .unwrap_or(i64::MAX),
                    r["order"].as_i64().unwrap_or(i64::MAX),
                )
            });
        if let Some(record) = first {
            return record["name"].as_str().map(|n| n.trim().to_string());
        }
    }
    None
}

/// Fetches the failing step of each of a pipeline's failed runs that has a
/// fetch slot and no step yet: one timeline request per run, without the
/// database lock. A failed request leaves the run waiting for a later pass; a
/// fetched run is never asked again.
pub(crate) fn fetch_steps(
    db: &std::sync::Mutex<Connection>,
    http: &dyn crate::pr_inbox::JsonTransport,
    target: &crate::pipeline_inbox::PipelineTarget,
) {
    let waiting: Result<Vec<u64>, String> = db.lock().map_err(|e| e.to_string()).and_then(|db| {
        let mut stmt = db
            .prepare(
                "SELECT run_id FROM pipeline_digest_runs WHERE watch_id=?1 AND step_state='pending'
                AND result='failed' AND (digest_id IS NULL OR digest_id <> 'dropped') ORDER BY run_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&target.id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    });
    let waiting = match waiting {
        Ok(ids) => ids,
        Err(error) => {
            eprintln!("[pipeline-digest] Could not read runs waiting for a step: {error}");
            return;
        }
    };
    for run_id in waiting {
        let url = crate::pipeline_inbox::ado_url(
            &target.organization,
            &target.project_id,
            &["_apis", "build", "builds", &run_id.to_string(), "timeline"],
        );
        let Ok(timeline) = crate::pipeline_inbox::api_get(http, url) else {
            continue;
        };
        let step = failing_step(&timeline);
        let saved = db.lock().map_err(|e| e.to_string()).and_then(|db| {
            db.execute(
                "UPDATE pipeline_digest_runs SET step=?3, step_state='fetched'
                WHERE watch_id=?1 AND run_id=?2 AND step_state='pending'",
                params![target.id, run_id, step],
            )
            .map_err(|e| e.to_string())
        });
        if let Err(error) = saved {
            eprintln!("[pipeline-digest] Could not save a failing step: {error}");
        }
    }
}

/// A kept run, as a digest lists it.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct KeptRun {
    pub run_id: u64,
    pub run_number: String,
    pub result: String,
    pub branch: String,
    pub trigger: String,
    pub finished_at: String,
    pub commit: String,
    /// The failing step's name, once fetched.
    pub step: Option<String>,
    /// none, pending, fetched or not_fetched.
    pub step_state: String,
}

/// The runs of a pipeline no digest has covered yet, oldest first.
pub fn undigested(db: &Connection, watch_id: &str) -> Result<Vec<KeptRun>, String> {
    runs_where(db, "watch_id=?1 AND digest_id IS NULL", watch_id)
}

fn runs_where(db: &Connection, condition: &str, key: &str) -> Result<Vec<KeptRun>, String> {
    let mut stmt = db
        .prepare(&format!(
            "SELECT run_id,run_number,result,branch,trigger_label,finished_at,commit_sha,step,step_state
            FROM pipeline_digest_runs WHERE {condition} ORDER BY julianday(finished_at), run_id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([key], |r| {
            Ok(KeptRun {
                run_id: r.get(0)?,
                run_number: r.get(1)?,
                result: r.get(2)?,
                branch: r.get(3)?,
                trigger: r.get(4)?,
                finished_at: r.get(5)?,
                commit: r.get(6)?,
                step: r.get(7)?,
                step_state: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pipeline_inbox::{self as inbox, PipelineMode, ResolvedPipeline};

    pub(crate) fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::init_db(&conn).unwrap();
        conn
    }

    pub(crate) fn watch(db: &Connection, id: u64, name: &str, mode: PipelineMode) -> String {
        let p = inbox::add(
            db,
            &ResolvedPipeline {
                organization: "skype".into(),
                project_id: "proj".into(),
                project_name: "SCC".into(),
                definition_id: id,
                name: name.into(),
                repository: None,
                default_branch: Some("main".into()),
            },
            Some(mode),
        )
        .unwrap();
        db.execute(
            "UPDATE pipeline_watches SET notify_after='2026-01-01T00:00:00.000Z' WHERE id=?1",
            [&p.id],
        )
        .unwrap();
        p.id
    }

    pub(crate) fn run(id: u64, result: &str, finished: &str) -> Run {
        Run {
            id,
            number: format!("2026.{id}"),
            result: result.into(),
            branch: "main".into(),
            trigger: "Scheduled".into(),
            finished_at: finished.into(),
            repository: None,
            commit: format!("sha{id}"),
        }
    }

    pub(crate) fn target(db: &Connection, id: &str) -> inbox::PipelineTarget {
        inbox::targets(db)
            .unwrap()
            .into_iter()
            .find(|t| t.id == id)
            .unwrap()
    }

    #[test]
    fn daily_failures_keeps_in_scope_runs_after_the_switch_and_notifies_none() {
        let db = db();
        let daily = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        let failures = watch(&db, 2, "Other", PipelineMode::Failures);
        let mut feature = run(4, "failed", "2026-03-01T10:00:00Z");
        feature.branch = "feature/x".into();
        let runs = [
            run(1, "failed", "2026-03-01T08:00:00Z"),
            run(2, "failed", "2026-03-01T09:00:00Z"),
            run(3, "succeeded", "2026-03-01T09:30:00Z"),
            feature,
            run(5, "failed", "2025-12-31T23:00:00Z"),
        ];
        inbox::apply_runs_on(&db, &target(&db, &daily), &runs, "2026-03-01").unwrap();
        inbox::apply_runs_on(&db, &target(&db, &failures), &runs[..1], "2026-03-01").unwrap();
        let kept = undigested(&db, &daily).unwrap();
        assert_eq!(
            kept.iter()
                .map(|r| (
                    r.run_id,
                    r.result.as_str(),
                    r.step_state.as_str(),
                    r.commit.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (1, "failed", "pending", "sha1"),
                (2, "failed", "pending", "sha2"),
                (3, "succeeded", "none", "sha3"),
            ],
            "the feature-branch run and the run before the switch don't count"
        );
        assert!(undigested(&db, &failures).unwrap().is_empty());
        let notified: Vec<_> = inbox::items(&db)
            .unwrap()
            .into_iter()
            .map(|i| i.pipeline_id)
            .collect();
        assert_eq!(
            notified,
            vec![failures],
            "only the Failures pipeline notifies"
        );
        // Seen again: nothing doubles.
        inbox::apply_runs_on(&db, &target(&db, &daily), &runs, "2026-03-01").unwrap();
        assert_eq!(undigested(&db, &daily).unwrap().len(), 3);
    }

    #[test]
    fn entering_or_leaving_daily_failures_drops_kept_runs_and_removal_forgets_them() {
        let db = db();
        let daily = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        let since = |db: &Connection| -> Option<String> {
            db.query_row(
                "SELECT digest_since FROM pipeline_watches WHERE id=?1",
                [&daily],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            since(&db).is_some(),
            "added in Daily failures: its window starts now"
        );
        let t = target(&db, &daily);
        inbox::apply_runs_on(
            &db,
            &t,
            &[run(1, "failed", "2026-03-01T08:00:00Z")],
            "2026-03-01",
        )
        .unwrap();
        inbox::set_mode(&db, &daily, PipelineMode::Failures).unwrap();
        assert!(undigested(&db, &daily).unwrap().is_empty());
        assert!(since(&db).is_none());
        inbox::set_mode(&db, &daily, PipelineMode::DailyFailures).unwrap();
        assert!(since(&db).is_some());
        db.execute(
            "UPDATE pipeline_watches SET notify_after='2026-01-01T00:00:00.000Z'",
            [],
        )
        .unwrap();
        let t = target(&db, &daily);
        inbox::apply_runs_on(
            &db,
            &t,
            &[run(2, "failed", "2026-03-01T09:00:00Z")],
            "2026-03-01",
        )
        .unwrap();
        inbox::remove(&db, &daily).unwrap();
        let left: i64 = db
            .query_row("SELECT COUNT(*) FROM pipeline_digest_runs", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(left, 0);
    }

    /// Serves each pipeline's runs and each run's timeline, and counts requests.
    pub(crate) struct FakeAdo {
        pub runs: std::collections::HashMap<u64, serde_json::Value>,
        pub steps: std::collections::HashMap<u64, &'static str>,
        pub fail_once: std::sync::Mutex<std::collections::HashSet<u64>>,
        pub asked: std::sync::Mutex<Vec<String>>,
    }

    impl FakeAdo {
        pub(crate) fn timeline_requests(&self) -> Vec<u64> {
            self.asked
                .lock()
                .unwrap()
                .iter()
                .filter_map(|p| p.strip_suffix("/timeline"))
                .filter_map(|p| p.rsplit('/').next()?.parse().ok())
                .collect()
        }
    }

    impl crate::pr_inbox::JsonTransport for FakeAdo {
        fn get(&self, url: reqwest::Url) -> Result<serde_json::Value, String> {
            let path = url.path().to_string();
            self.asked.lock().unwrap().push(path.clone());
            if let Some(build) = path.strip_suffix("/timeline") {
                let id: u64 = build.rsplit('/').next().unwrap().parse().unwrap();
                if self.fail_once.lock().unwrap().remove(&id) {
                    return Err("ADO connection failed or timed out.".into());
                }
                let step = self.steps.get(&id).copied().unwrap_or("Run tests");
                return Ok(serde_json::json!({"records": [
                    {"type": "Stage", "name": "Build", "result": "failed", "startTime": "2026-03-01T07:00:00Z"},
                    {"type": "Job", "name": "Linux", "result": "failed", "startTime": "2026-03-01T07:00:01Z"},
                    {"type": "Task", "name": "Checkout", "result": "succeeded", "startTime": "2026-03-01T07:00:02Z"},
                    {"type": "Task", "name": "Publish", "result": "failed", "startTime": "2026-03-01T07:09:00Z"},
                    {"type": "Task", "name": step, "result": "failed", "startTime": "2026-03-01T07:05:00Z"}
                ]}));
            }
            let definition: u64 = url
                .query_pairs()
                .find(|(k, _)| k == "definitions")
                .and_then(|(_, v)| v.parse().ok())
                .unwrap_or(0);
            Ok(self
                .runs
                .get(&definition)
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"value": []})))
        }
    }

    fn wire_runs(range: std::ops::RangeInclusive<u64>, result: &str) -> serde_json::Value {
        serde_json::json!({"value": range.map(|i| serde_json::json!({
            "id": i, "buildNumber": format!("{i}"), "result": result, "sourceBranch": "refs/heads/main",
            "reason": "schedule", "finishTime": format!("2026-03-01T08:{:02}:00Z", i % 60),
            "sourceVersion": format!("sha{i}")
        })).collect::<Vec<_>>()})
    }

    #[test]
    fn reads_the_failing_task_from_a_timeline_falling_back_to_its_job() {
        let timeline = serde_json::json!({"records": [
            {"type": "Stage", "name": "Pipeline watchdog", "result": "failed", "startTime": "2026-11-25T07:00:50Z"},
            {"type": "Job", "name": "Detect actionable pipeline failures", "result": "failed", "startTime": "2026-11-25T07:00:50Z"},
            {"type": "Task", "name": "Later failure", "result": "failed", "startTime": "2026-11-25T07:09:52Z"},
            {"type": "Task", "name": "Inspect pipeline failures", "result": "failed", "startTime": "2026-11-25T07:02:52.1433333Z"},
            {"type": "Task", "name": "Checkout", "result": "succeeded", "startTime": "2026-11-25T07:01:00Z"}
        ]});
        assert_eq!(
            failing_step(&timeline).as_deref(),
            Some("Inspect pipeline failures")
        );
        let no_task = serde_json::json!({"records": [
            {"type": "Stage", "name": "Build", "result": "failed"},
            {"type": "Job", "name": "Linux", "result": "failed"}
        ]});
        assert_eq!(failing_step(&no_task).as_deref(), Some("Linux"));
        assert_eq!(failing_step(&serde_json::json!({"records": []})), None);
    }

    /// AT-5: only Daily failures asks for timelines, one per failed run, 20 a
    /// day; an error is retried on a later pass; nothing is asked twice.
    #[test]
    fn step_fetches_are_bounded_retried_and_never_repeated() {
        let conn = db();
        let daily = watch(&conn, 1, "CI-Main", PipelineMode::DailyFailures);
        watch(&conn, 2, "Failures", PipelineMode::Failures);
        watch(&conn, 3, "Both", PipelineMode::Both);
        let mut runs = std::collections::HashMap::new();
        runs.insert(1, wire_runs(1..=25, "failed"));
        runs.insert(2, wire_runs(101..=103, "failed"));
        runs.insert(3, wire_runs(201..=203, "failed"));
        let ado = FakeAdo {
            runs,
            steps: [(5, "Integration tests")].into_iter().collect(),
            fail_once: std::sync::Mutex::new([3].into_iter().collect()),
            asked: Default::default(),
        };
        let all = inbox::targets(&conn).unwrap();
        let shared = std::sync::Mutex::new(conn);
        inbox::check_all(&shared, Ok(&ado), &all);
        let first = ado.timeline_requests();
        assert_eq!(first.len(), 20, "{first:?}");
        assert!(
            first.iter().all(|id| *id <= 25),
            "only the Daily-failures pipeline"
        );
        {
            let conn = shared.lock().unwrap();
            let kept = undigested(&conn, &daily).unwrap();
            assert_eq!(
                kept.iter()
                    .filter(|r| r.step_state == "not_fetched")
                    .count(),
                5
            );
            let errored = kept.iter().find(|r| r.run_id == 3).unwrap();
            assert_eq!(
                (errored.step.as_deref(), errored.step_state.as_str()),
                (None, "pending")
            );
            let five = kept.iter().find(|r| r.run_id == 5).unwrap();
            assert_eq!(
                (five.step.as_deref(), five.step_state.as_str()),
                (Some("Integration tests"), "fetched")
            );
        }
        inbox::check_all(&shared, Ok(&ado), &all);
        assert_eq!(ado.timeline_requests().len(), 21, "one retry");
        inbox::check_all(&shared, Ok(&ado), &all);
        assert_eq!(ado.timeline_requests().len(), 21, "never fetched twice");
        let conn = shared.lock().unwrap();
        let retried = undigested(&conn, &daily)
            .unwrap()
            .into_iter()
            .find(|r| r.run_id == 3)
            .unwrap();
        assert_eq!(retried.step.as_deref(), Some("Run tests"));
    }

    /// Against real Azure DevOps with your `az login`; run with
    /// `cargo test --lib real_ado_timeline -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_ado_timeline_names_the_failing_step_of_a_failed_run() {
        let http = crate::pr_inbox::AdoTransport::connect().expect("az login");
        let mut url = crate::pipeline_inbox::ado_url("skype", "SCC", &["_apis", "build", "builds"]);
        url.query_pairs_mut()
            .append_pair("definitions", "33770")
            .append_pair("resultFilter", "failed")
            .append_pair("$top", "1");
        let runs = crate::pipeline_inbox::api_get(&http, url).unwrap();
        let id = runs["value"][0]["id"].as_u64().expect("a failed run");
        let timeline = crate::pipeline_inbox::api_get(
            &http,
            crate::pipeline_inbox::ado_url(
                "skype",
                "SCC",
                &["_apis", "build", "builds", &id.to_string(), "timeline"],
            ),
        )
        .unwrap();
        let step = failing_step(&timeline);
        println!("run {id}: failing step {step:?}");
        assert!(step.is_some());
    }

    #[test]
    fn a_retried_run_takes_its_new_result_until_a_digest_covers_it() {
        let db = db();
        let daily = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        let t = target(&db, &daily);
        inbox::apply_runs_on(
            &db,
            &t,
            &[run(7, "succeeded", "2026-03-01T08:00:00Z")],
            "2026-03-01",
        )
        .unwrap();
        inbox::apply_runs_on(
            &db,
            &t,
            &[run(7, "failed", "2026-03-01T09:00:00Z")],
            "2026-03-01",
        )
        .unwrap();
        let kept = undigested(&db, &daily).unwrap();
        assert_eq!(
            (kept[0].result.as_str(), kept[0].step_state.as_str()),
            ("failed", "pending")
        );
    }

    #[test]
    fn only_twenty_failed_runs_a_day_get_a_step_fetch() {
        let db = db();
        let daily = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        let t = target(&db, &daily);
        let runs: Vec<Run> = (1..=25)
            .map(|i| run(i, "failed", &format!("2026-03-01T08:{i:02}:00Z")))
            .collect();
        inbox::apply_runs_on(&db, &t, &runs, "2026-03-01").unwrap();
        let states: Vec<String> = undigested(&db, &daily)
            .unwrap()
            .into_iter()
            .map(|r| r.step_state)
            .collect();
        assert_eq!(states.iter().filter(|s| *s == "pending").count(), 20);
        assert_eq!(states.iter().filter(|s| *s == "not_fetched").count(), 5);
        // A new local day has slots again.
        inbox::apply_runs_on(
            &db,
            &t,
            &[run(26, "failed", "2026-03-02T08:00:00Z")],
            "2026-03-02",
        )
        .unwrap();
        assert_eq!(
            undigested(&db, &daily).unwrap().last().unwrap().step_state,
            "pending"
        );
    }
}

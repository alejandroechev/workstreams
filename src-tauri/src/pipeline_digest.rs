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

use chrono::{DateTime, Duration, NaiveDateTime, NaiveTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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

// ── The digest time ─────────────────────────────────────────────────────

const TIME_KEY: &str = "pipeline_digest_time";

fn parse_hhmm(text: &str) -> Option<NaiveTime> {
    let (h, m) = text.trim().split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

/// The global digest time, `HH:MM` local (default 09:00).
pub fn digest_time(db: &Connection) -> Result<String, String> {
    let stored: Option<String> = db
        .query_row("SELECT value FROM settings WHERE key=?1", [TIME_KEY], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(stored
        .filter(|t| parse_hhmm(t).is_some())
        .unwrap_or_else(|| DEFAULT_TIME.into()))
}

/// Sets the global digest time; it applies from the next digest.
pub fn set_digest_time(db: &Connection, time: &str) -> Result<String, String> {
    let parsed = parse_hhmm(time)
        .ok_or_else(|| format!("The digest time must be HH:MM (24-hour); got {time:?}"))?;
    let text = parsed.format("%H:%M").to_string();
    db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![TIME_KEY, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(text)
}

/// The latest scheduled digest at or before `clock.now`: today's digest time,
/// or yesterday's when today's hasn't come yet. Read in local wall-clock time,
/// so a DST change moves it with the clock on the wall.
pub fn last_slot(clock: &Clock, time: NaiveTime) -> DateTime<Utc> {
    let today = clock.zone.local(clock.now).date();
    let mut day = today;
    for _ in 0..3 {
        let at = clock.zone.instant(day.and_time(time));
        if at <= clock.now {
            return at;
        }
        day = day.pred_opt().unwrap_or(day);
    }
    clock.now - Duration::days(1)
}

// ── Posting digests ─────────────────────────────────────────────────────

/// What a due digest pass did for one pipeline.
#[derive(Debug, Clone, PartialEq)]
pub struct Posted {
    pub digest_id: String,
    pub watch_id: String,
}

/// Posts every digest that is due: each Daily-failures pipeline whose window
/// began before the latest digest time gets one entry if it had a failed run
/// in the window (at most the last 7 days), and its next window starts now.
/// While the Inbox is muted, a due digest is dropped and its window still
/// moves on. Returns the digests posted.
pub fn run_due(db: &Connection, clock: &Clock) -> Result<Vec<Posted>, String> {
    let time = parse_hhmm(&digest_time(db)?).expect("validated");
    let slot = last_slot(clock, time);
    let now = clock.stamp();
    let oldest = clock.now - Duration::days(MAX_WINDOW_DAYS);
    let watches: Vec<(String, Option<String>)> = {
        let mut stmt = db
            .prepare("SELECT id, digest_since FROM pipeline_watches WHERE mode='daily_failures' ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let muted = crate::inbox_mute::is_muted_at(db, clock.now)?;
    let mut posted = Vec::new();
    for (watch_id, since) in watches {
        let Some(since) = since.as_deref().and_then(parse_time) else {
            db.execute(
                "UPDATE pipeline_watches SET digest_since=?2 WHERE id=?1",
                params![watch_id, now],
            )
            .map_err(|e| e.to_string())?;
            continue;
        };
        if since >= slot {
            continue;
        }
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let window_start = since.max(oldest);
        let runs: Vec<KeptRun> = undigested(&tx, &watch_id)?
            .into_iter()
            .filter(|r| parse_time(&r.finished_at).is_some_and(|t| t >= oldest))
            .collect();
        let failed = runs.iter().filter(|r| r.result == "failed").count();
        if muted || failed == 0 {
            drop_undigested(&tx, &watch_id)?;
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let newest = runs.last().map(|r| r.result.clone()).unwrap_or_default();
            tx.execute(
                "INSERT INTO pipeline_digests (id, watch_id, window_start, window_end, total, failed, newest_result, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?4)",
                params![id, watch_id, stamp(window_start), now, runs.len() as i64, failed as i64, newest],
            )
            .map_err(|e| e.to_string())?;
            for run in &runs {
                tx.execute(
                    "UPDATE pipeline_digest_runs SET digest_id=?3 WHERE watch_id=?1 AND run_id=?2",
                    params![watch_id, run.run_id, id],
                )
                .map_err(|e| e.to_string())?;
            }
            drop_undigested(&tx, &watch_id)?;
            posted.push(Posted {
                digest_id: id,
                watch_id: watch_id.clone(),
            });
        }
        tx.execute(
            "UPDATE pipeline_watches SET digest_since=?2 WHERE id=?1",
            params![watch_id, now],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(posted)
}

/// A failed run in a digest.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DigestRun {
    pub run_id: u64,
    pub run_number: String,
    pub branch: String,
    pub trigger: String,
    pub finished_at: String,
    pub commit: String,
    /// The run's results page in ADO.
    pub url: String,
    pub step: Option<String>,
    /// fetched, pending or not_fetched.
    pub step_state: String,
    /// The workstream investigating this one run, when there is one.
    pub investigation: Option<String>,
}

/// One digest entry in the Inbox.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PipelineDigest {
    pub id: String,
    pub pipeline_id: String,
    pub pipeline_name: String,
    pub project: String,
    pub organization: String,
    /// The pipeline's repo, as its chip shows it.
    pub repo: Option<String>,
    pub window_start: String,
    pub window_end: String,
    pub total: u64,
    pub failed: u64,
    /// `still_failing`, or `passed_since` when the newest run in the window succeeded.
    pub state: String,
    /// Its failed runs, newest first.
    pub runs: Vec<DigestRun>,
    pub is_read: bool,
    pub created_at: String,
    /// The workstream investigating this digest's failures, when there is one.
    pub investigation: Option<String>,
    /// Auto-investigate will start its investigation on the app's next pass.
    pub auto_pending: bool,
}

/// The id of a digest's run as an investigatable item (`drun:<digest>:<run>`).
pub fn run_item_id(digest_id: &str, run_id: u64) -> String {
    format!("drun:{digest_id}:{run_id}")
}

/// Every digest, newest first.
pub fn digests(db: &Connection) -> Result<Vec<PipelineDigest>, String> {
    type Row = (
        String,
        String,
        String,
        String,
        u64,
        u64,
        String,
        bool,
        String,
        Option<String>,
        bool,
    );
    let rows: Vec<Row> = {
        let mut stmt = db
            .prepare(
                "SELECT d.id, d.watch_id, d.window_start, d.window_end, d.total, d.failed, d.newest_result,
                d.is_read, d.created_at, ws.id, d.auto_pending
                FROM pipeline_digests d
                LEFT JOIN pipeline_investigations i ON i.event_id = d.id
                LEFT JOIN workstreams ws ON ws.id = i.workstream_id
                ORDER BY julianday(d.created_at) DESC, d.rowid DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let mut out = Vec::new();
    for (id, watch_id, start, end, total, failed, newest, is_read, created, investigation, auto) in
        rows
    {
        let Some(view) = crate::pipeline_inbox::watch_view(db, &watch_id)? else {
            continue;
        };
        let mut runs: Vec<DigestRun> = runs_where(db, "digest_id=?1 AND result='failed'", &id)?
            .into_iter()
            .map(|r| {
                let item = run_item_id(&id, r.run_id);
                Ok(DigestRun {
                    url: crate::pipeline_inbox::run_url(
                        &view.organization,
                        &view.project,
                        r.run_id,
                    ),
                    investigation: crate::pipeline_investigate::existing(db, &item)?,
                    run_id: r.run_id,
                    run_number: r.run_number,
                    branch: r.branch,
                    trigger: r.trigger,
                    finished_at: r.finished_at,
                    commit: r.commit,
                    step: r.step,
                    step_state: r.step_state,
                })
            })
            .collect::<Result<_, String>>()?;
        runs.reverse();
        out.push(PipelineDigest {
            id,
            pipeline_id: watch_id,
            pipeline_name: view.name,
            project: view.project,
            organization: view.organization,
            repo: view.label,
            window_start: start,
            window_end: end,
            total,
            failed,
            state: if newest == "succeeded" {
                "passed_since"
            } else {
                "still_failing"
            }
            .into(),
            runs,
            is_read,
            created_at: created,
            investigation,
            auto_pending: auto,
        });
    }
    Ok(out)
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

    // ── The digest ──

    /// A zone with one DST change: UTC-3 before `switch`, `after` from it.
    pub(crate) struct TestZone {
        pub switch: DateTime<Utc>,
        pub before: i64,
        pub after: i64,
    }

    impl TestZone {
        pub(crate) fn fixed(hours: i64) -> Self {
            TestZone {
                switch: parse_time("2100-01-01T00:00:00Z").unwrap(),
                before: hours * 3600,
                after: hours * 3600,
            }
        }
    }

    impl Zone for TestZone {
        fn local(&self, at: DateTime<Utc>) -> NaiveDateTime {
            let offset = if at < self.switch {
                self.before
            } else {
                self.after
            };
            at.naive_utc() + Duration::seconds(offset)
        }
        fn instant(&self, local: NaiveDateTime) -> DateTime<Utc> {
            for minutes in 0..=180 {
                let probe = local + Duration::minutes(minutes);
                let mut valid: Vec<DateTime<Utc>> = [self.before, self.after]
                    .iter()
                    .map(|o| Utc.from_utc_datetime(&(probe - Duration::seconds(*o))))
                    .filter(|at| self.local(*at) == probe)
                    .collect();
                valid.sort();
                if let Some(first) = valid.first() {
                    return *first;
                }
            }
            unreachable!()
        }
    }

    pub(crate) fn at(text: &str) -> DateTime<Utc> {
        parse_time(text).unwrap()
    }

    /// Clock at local time `text` (UTC-3, Santiago in summer).
    pub(crate) fn local_clock<'a>(zone: &'a TestZone, text: &str) -> Clock<'a> {
        Clock {
            now: zone.instant(NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap()),
            zone,
        }
    }

    pub(crate) fn since(db: &Connection, id: &str, text: &str) {
        db.execute(
            "UPDATE pipeline_watches SET digest_since=?2, notify_after='2020-01-01T00:00:00.000Z' WHERE id=?1",
            params![id, text],
        )
        .unwrap();
    }

    pub(crate) fn finish(db: &Connection, id: &str, runs: &[Run]) {
        inbox::apply_runs_on(db, &target(db, id), runs, "2026-03-02").unwrap();
    }

    /// AT-2: one entry per failing pipeline, counts and states, nothing for a
    /// clean pipeline, and nothing twice the same day.
    #[test]
    fn posts_one_digest_per_failing_pipeline_at_the_digest_time_once() {
        let db = db();
        let zone = TestZone::fixed(-3);
        let ci = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        let deploy = watch(&db, 2, "Deploy-PPE", PipelineMode::DailyFailures);
        let docs = watch(&db, 3, "Docs", PipelineMode::DailyFailures);
        for id in [&ci, &deploy, &docs] {
            since(&db, id, "2026-03-01T12:00:00.000Z");
        }
        let at_minute = |m: u64| format!("2026-03-01T{:02}:{:02}:00Z", 13 + m / 60, m % 60);
        let mut ci_runs: Vec<Run> = (1..=12)
            .map(|i| run(i, "succeeded", &at_minute(i)))
            .collect();
        for i in [3, 5, 8, 10, 12] {
            ci_runs[i as usize - 1].result = "failed".into();
        }
        finish(&db, &ci, &ci_runs);
        let mut deploy_runs: Vec<Run> = (21..=26)
            .map(|i| run(i, "succeeded", &at_minute(i)))
            .collect();
        deploy_runs[1].result = "failed".into();
        finish(&db, &deploy, &deploy_runs);
        finish(
            &db,
            &docs,
            &(31..=34)
                .map(|i| run(i, "succeeded", &at_minute(i)))
                .collect::<Vec<_>>(),
        );

        assert!(run_due(&db, &local_clock(&zone, "2026-03-02 08:59"))
            .unwrap()
            .is_empty());
        let posted = run_due(&db, &local_clock(&zone, "2026-03-02 09:00")).unwrap();
        assert_eq!(posted.len(), 2);
        let all = digests(&db).unwrap();
        let ci_digest = all.iter().find(|d| d.pipeline_name == "CI-Main").unwrap();
        assert_eq!(
            (
                ci_digest.failed,
                ci_digest.total,
                ci_digest.state.as_str(),
                ci_digest.is_read
            ),
            (5, 12, "still_failing", false)
        );
        assert_eq!(
            ci_digest.runs.iter().map(|r| r.run_id).collect::<Vec<_>>(),
            vec![12, 10, 8, 5, 3],
            "newest first"
        );
        assert_eq!(
            ci_digest.runs[0].url,
            "https://dev.azure.com/skype/SCC/_build/results?buildId=12"
        );
        assert_eq!(ci_digest.runs[0].commit, "sha12");
        let deploy_digest = all
            .iter()
            .find(|d| d.pipeline_name == "Deploy-PPE")
            .unwrap();
        assert_eq!(
            (
                deploy_digest.failed,
                deploy_digest.total,
                deploy_digest.state.as_str()
            ),
            (1, 6, "passed_since")
        );
        assert!(all.iter().all(|d| d.pipeline_name != "Docs"));
        assert!(run_due(&db, &local_clock(&zone, "2026-03-02 15:00"))
            .unwrap()
            .is_empty());
        assert!(run_due(&db, &local_clock(&zone, "2026-03-02 23:59"))
            .unwrap()
            .is_empty());
        // Read state is per digest, like any notification.
        assert!(inbox::set_read(&db, &ci_digest.id, true).unwrap());
        assert!(digests(&db)
            .unwrap()
            .iter()
            .any(|d| d.id == ci_digest.id && d.is_read));
    }

    /// AT-3: the time can be changed and applies to the next digest.
    #[test]
    fn the_digest_time_is_global_and_applies_to_the_next_digest() {
        let db = db();
        let zone = TestZone::fixed(-3);
        assert_eq!(digest_time(&db).unwrap(), "09:00");
        assert!(set_digest_time(&db, "25:00").is_err());
        assert!(set_digest_time(&db, "9").is_err());
        assert_eq!(set_digest_time(&db, "17:30").unwrap(), "17:30");
        let ci = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        since(&db, &ci, "2026-03-01T21:00:00.000Z");
        finish(&db, &ci, &[run(1, "failed", "2026-03-01T22:00:00Z")]);
        assert!(run_due(&db, &local_clock(&zone, "2026-03-02 09:05"))
            .unwrap()
            .is_empty());
        assert_eq!(
            run_due(&db, &local_clock(&zone, "2026-03-02 17:30"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(digest_time(&db).unwrap(), "17:30");
    }

    /// AT-4: a missed digest goes out once at the next start, covering the
    /// gap (at most 7 days); the next day covers only newer runs.
    #[test]
    fn a_missed_digest_covers_the_gap_once_and_at_most_seven_days() {
        let db = db();
        let zone = TestZone::fixed(-3);
        let ci = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        // Last digest Monday 09:00 (12:00Z); failures Monday and Tuesday.
        since(&db, &ci, "2026-03-02T12:00:00.000Z");
        finish(
            &db,
            &ci,
            &[
                run(1, "failed", "2026-03-02T15:00:00Z"),
                run(2, "failed", "2026-03-03T15:00:00Z"),
                run(3, "succeeded", "2026-03-03T16:00:00Z"),
            ],
        );
        // The app starts Wednesday 10:00.
        let posted = run_due(&db, &local_clock(&zone, "2026-03-04 10:00")).unwrap();
        assert_eq!(posted.len(), 1);
        let first = &digests(&db).unwrap()[0];
        assert_eq!((first.failed, first.total), (2, 3));
        assert_eq!(first.window_start, "2026-03-02T12:00:00.000Z");
        assert!(run_due(&db, &local_clock(&zone, "2026-03-04 10:02"))
            .unwrap()
            .is_empty());
        assert!(run_due(&db, &local_clock(&zone, "2026-03-04 23:00"))
            .unwrap()
            .is_empty());
        finish(&db, &ci, &[run(4, "failed", "2026-03-04T20:00:00Z")]);
        assert_eq!(
            run_due(&db, &local_clock(&zone, "2026-03-05 09:00"))
                .unwrap()
                .len(),
            1
        );
        let thursday = &digests(&db).unwrap()[0];
        assert_eq!(
            thursday.runs.iter().map(|r| r.run_id).collect::<Vec<_>>(),
            vec![4]
        );

        // A 10-day gap: only the last 7 days count.
        let db2 = super::tests::db();
        let p = watch(&db2, 1, "CI-Main", PipelineMode::DailyFailures);
        since(&db2, &p, "2026-03-01T12:00:00.000Z");
        finish(
            &db2,
            &p,
            &[
                run(1, "failed", "2026-03-01T15:00:00Z"),
                run(2, "failed", "2026-03-03T15:00:00Z"),
                run(3, "failed", "2026-03-09T15:00:00Z"),
            ],
        );
        run_due(&db2, &local_clock(&zone, "2026-03-11 10:00")).unwrap();
        let d = &digests(&db2).unwrap()[0];
        assert_eq!(
            d.runs.iter().map(|r| r.run_id).collect::<Vec<_>>(),
            vec![3],
            "runs older than 7 days are left out"
        );
        assert_eq!(d.window_start, "2026-03-04T13:00:00.000Z");
    }

    /// DST: the digest follows the wall clock, a skipped 09:00 posts at the
    /// first instant after it, and a repeated hour never posts twice.
    #[test]
    fn digests_follow_the_wall_clock_across_dst_changes() {
        let db = db();
        set_digest_time(&db, "23:30").unwrap();
        // Clocks spring forward at 03:00Z, from 23:00 to 00:00: 23:00-23:59 don't exist.
        let spring = TestZone {
            switch: at("2026-09-06T03:00:00Z"),
            before: -4 * 3600,
            after: -3 * 3600,
        };
        let ci = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        since(&db, &ci, "2026-09-05T05:00:00.000Z");
        finish(&db, &ci, &[run(1, "failed", "2026-09-05T20:00:00Z")]);
        let before_gap = Clock {
            now: at("2026-09-06T02:59:00Z"),
            zone: &spring,
        };
        assert!(run_due(&db, &before_gap).unwrap().is_empty());
        let after_gap = Clock {
            now: at("2026-09-06T03:00:00Z"),
            zone: &spring,
        };
        assert_eq!(
            run_due(&db, &after_gap).unwrap().len(),
            1,
            "posted at 00:00, the first instant after the skipped 23:30"
        );

        // Clocks fall back at 03:00Z, from 00:00 to 23:00: 23:30 happens twice.
        let db = super::tests::db();
        set_digest_time(&db, "23:30").unwrap();
        let fall = TestZone {
            switch: at("2026-04-05T03:00:00Z"),
            before: -3 * 3600,
            after: -4 * 3600,
        };
        let ci = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        since(&db, &ci, "2026-04-04T12:00:00.000Z");
        finish(&db, &ci, &[run(1, "failed", "2026-04-04T20:00:00Z")]);
        let first = Clock {
            now: at("2026-04-05T02:30:00Z"),
            zone: &fall,
        };
        assert_eq!(run_due(&db, &first).unwrap().len(), 1, "the earlier 23:30");
        finish(&db, &ci, &[run(2, "failed", "2026-04-05T03:10:00Z")]);
        let second = Clock {
            now: at("2026-04-05T03:30:00Z"),
            zone: &fall,
        };
        assert!(
            run_due(&db, &second).unwrap().is_empty(),
            "the repeated 23:30 posts nothing"
        );
    }

    #[test]
    fn a_digest_due_while_muted_is_dropped_and_its_window_moves_on() {
        let db = db();
        let zone = TestZone::fixed(-3);
        let ci = watch(&db, 1, "CI-Main", PipelineMode::DailyFailures);
        since(&db, &ci, "2026-03-01T12:00:00.000Z");
        finish(&db, &ci, &[run(1, "failed", "2026-03-01T15:00:00Z")]);
        crate::inbox_mute::mute_at(&db, None, at("2026-03-01T16:00:00Z")).unwrap();
        assert!(run_due(&db, &local_clock(&zone, "2026-03-02 09:00"))
            .unwrap()
            .is_empty());
        crate::inbox_mute::unmute_at(&db, at("2026-03-02T13:00:00Z")).unwrap();
        assert!(run_due(&db, &local_clock(&zone, "2026-03-03 09:00"))
            .unwrap()
            .is_empty());
        assert!(digests(&db).unwrap().is_empty());
        assert!(undigested(&db, &ci).unwrap().is_empty());
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

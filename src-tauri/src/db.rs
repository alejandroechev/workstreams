use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Resolves the workstreams DB path with the following precedence:
/// 1. `WORKSTREAMS_DB_PATH` env var (absolute or relative path)
/// 2. Debug builds → `<cwd>/.dev/workstreams-dev.db`
/// 3. Release builds → `<data_local_dir>/workstreams/workstreams.db`
///
/// Always isolates dev work from the production database.
///
/// Migration: builds prior to v0.2.0 stored the release DB at
/// `<data_local_dir>/copilot-desktop/copilot-desktop.db`. If the new
/// location doesn't exist yet but the old one does, we copy the .db /
/// .db-wal / .db-shm files into the new folder on first launch so the
/// upgrade is transparent. The original is left in place as a backup.
pub fn resolve_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("WORKSTREAMS_DB_PATH") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    if cfg!(debug_assertions) {
        return std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".dev")
            .join("workstreams-dev.db");
    }
    let new_path = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("workstreams")
        .join("workstreams.db");
    migrate_legacy_db_if_present(&new_path);
    new_path
}

/// One-shot copy from the pre-v0.2.0 `copilot-desktop/copilot-desktop.db`
/// location to `workstreams/workstreams.db`. Runs only when the new
/// location is missing and the legacy one exists. Best-effort: copy
/// failures fall through and the caller will simply open an empty DB
/// at the new path (so a corrupted legacy file can never block boot).
fn migrate_legacy_db_if_present(new_path: &Path) {
    if new_path.exists() {
        return;
    }
    let legacy_dir = match dirs::data_local_dir() {
        Some(d) => d.join("copilot-desktop"),
        None => return,
    };
    let legacy_db = legacy_dir.join("copilot-desktop.db");
    if !legacy_db.exists() {
        return;
    }
    let new_dir = match new_path.parent() {
        Some(d) => d,
        None => return,
    };
    if let Err(e) = std::fs::create_dir_all(new_dir) {
        eprintln!(
            "[workstreams] migrate: could not create {}: {e}",
            new_dir.display()
        );
        return;
    }
    let copy = |from_name: &str, to_name: &str| {
        let from = legacy_dir.join(from_name);
        if !from.exists() {
            return;
        }
        let to = new_dir.join(to_name);
        if let Err(e) = std::fs::copy(&from, &to) {
            eprintln!(
                "[workstreams] migrate: copy {} -> {} failed: {e}",
                from.display(),
                to.display()
            );
        } else {
            eprintln!(
                "[workstreams] migrated {} -> {}",
                from.display(),
                to.display()
            );
        }
    };
    copy("copilot-desktop.db", "workstreams.db");
    copy("copilot-desktop.db-wal", "workstreams.db-wal");
    copy("copilot-desktop.db-shm", "workstreams.db-shm");
}

/// Initialize the database schema. Creates all tables if they don't exist.
pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            directory TEXT NOT NULL,
            git_remote TEXT,
            color TEXT NOT NULL DEFAULT '#89b4fa',
            copilot_command TEXT,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workstreams (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            directory TEXT,
            git_repo TEXT,
            git_branch TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            project_id TEXT REFERENCES projects(id),
            workstream_type TEXT NOT NULL DEFAULT 'standalone',
            worktree_branch TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workstream_layouts (
            workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
            layout_mode TEXT NOT NULL DEFAULT 'adaptive',
            focused_tile_id TEXT,
            fullscreen_tile_id TEXT,
            tile_order_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tiles (
            id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
            tile_type TEXT NOT NULL,
            title TEXT,
            config_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS terminal_scrollback (
            tile_id TEXT PRIMARY KEY REFERENCES tiles(id) ON DELETE CASCADE,
            scrollback_blob BLOB,
            encoding TEXT NOT NULL DEFAULT 'plain',
            saved_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS copilot_session_links (
            tile_id TEXT PRIMARY KEY REFERENCES tiles(id) ON DELETE CASCADE,
            copilot_session_id TEXT,
            context_percent REAL,
            turn_count INTEGER,
            summary TEXT,
            linked_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS visual_proofs (
            todo_id TEXT PRIMARY KEY,
            feature_id TEXT NOT NULL,
            screenshot_path TEXT NOT NULL,
            console_error_count INTEGER NOT NULL DEFAULT 0,
            captured_at TEXT NOT NULL
        );

        -- Index of recorded code-walkthrough traces. The JSON file at
        -- `trace_path` is the source of truth; this table exists only so the
        -- UI can list traces without parsing every file on disk, and so a
        -- trace recorded by the CLI (which knows nothing about this database)
        -- can be adopted later.
        CREATE TABLE IF NOT EXISTS code_traces (
            id TEXT PRIMARY KEY,
            workstream_id TEXT,
            test_name TEXT NOT NULL,
            trace_path TEXT NOT NULL,
            commit_sha TEXT NOT NULL,
            step_count INTEGER NOT NULL DEFAULT 0,
            truncated INTEGER NOT NULL DEFAULT 0,
            recorded_at TEXT NOT NULL
        );

        -- Project tracking. `labels` is deliberately NOT the `projects` table
        -- above: `projects` means *repository* here, while a label is the lean
        -- grouping that replaces the devlog's `## section`, its category
        -- bullets and its group bullets all at once. A task carries several.
        CREATE TABLE IF NOT EXISTS labels (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#89b4fa',
            created_at TEXT NOT NULL
        );

        -- Case-insensitive uniqueness is what stops `ai crew` from forking
        -- `AI Crew` into a second label and silently splitting the archive.
        CREATE UNIQUE INDEX IF NOT EXISTS labels_name_unique
            ON labels (lower(trim(name)));

        -- `workstream_id` is nullable and unconstrained in both directions:
        -- most tasks have no workstream, and workstreams exist with no task.
        -- There is deliberately no repo column -- repos are derived from the
        -- attached workstream, because a task can span several or none.
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'todo',
            flags_json TEXT NOT NULL DEFAULT '[]',
            links_json TEXT NOT NULL DEFAULT '[]',
            workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
            -- Free-form scratchpad. A third concept alongside subtasks (units
            -- of work) and events (things that happened): mutable standing
            -- context with no status and no timestamp. 74% of the nested
            -- bullets in the real devlog are exactly this, and had nowhere to
            -- live before it existed.
            notes TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS subtasks (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'todo',
            position INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS task_labels (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (task_id, label_id)
        );

        -- Append-only. There is no update path for `text` anywhere in the
        -- backend: an event may be deleted (it never happened) but never
        -- rewritten, so the log cannot quietly disagree with the archive.
        CREATE TABLE IF NOT EXISTS task_events (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL
        );

        -- Every named command that ran, whoever ran it. One table, because the
        -- interesting question -- do agents drive the app differently from
        -- people? -- is unanswerable if the two are recorded separately.
        --
        -- Never stores free text: command ids and structured parameters only,
        -- no prompts, file contents or terminal output.
        CREATE TABLE IF NOT EXISTS command_log (
            id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            actor TEXT NOT NULL,
            workstream_id TEXT,
            params_json TEXT NOT NULL DEFAULT '{}',
            outcome TEXT NOT NULL,
            error_code TEXT,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        -- Work lanes: a named container for related workstreams. One lane per
        -- workstream, optional. Deliberately not a repository -- project_id
        -- already carries that -- so a lane can span repos or split one.
        CREATE TABLE IF NOT EXISTS work_lanes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Two lanes with the same name would make the folder list unreadable
        -- and a drop target ambiguous, so names are unique regardless of case.
        CREATE UNIQUE INDEX IF NOT EXISTS work_lanes_name_unique
            ON work_lanes (lower(name));

        -- Pull requests linked to workstreams, many-to-many: a workstream often
        -- carries several PRs, and one PR is frequently relevant to more than
        -- one workstream (the branch that produced it, and the one reviewing
        -- it). Stores the link only -- nothing here talks to Azure DevOps.
        CREATE TABLE IF NOT EXISTS workstream_pull_requests (
            id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            organization TEXT NOT NULL,
            project TEXT NOT NULL,
            repository TEXT NOT NULL,
            number INTEGER NOT NULL,
            -- Canonical form, so the same PR pasted from either Azure DevOps
            -- host shape (or with different casing) links once, not twice.
            identity TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        -- Makes re-linking idempotent at the storage layer rather than relying
        -- on a check-then-insert, which two concurrent agents could interleave.
        CREATE UNIQUE INDEX IF NOT EXISTS workstream_pull_requests_unique
            ON workstream_pull_requests (workstream_id, identity);
        CREATE INDEX IF NOT EXISTS workstream_pull_requests_ws_idx
            ON workstream_pull_requests (workstream_id);
        CREATE INDEX IF NOT EXISTS workstream_pull_requests_identity_idx
            ON workstream_pull_requests (identity);

        -- An agent-recommended reading order for one diff of a workstream
        -- (ADR 032). Latest only: one row per (workstream, mode, target).
        -- `target` is the Custom branch target, or '' for the other modes.
        -- The fingerprints are computed by the app at save time, never taken
        -- from the agent, so they always describe the diff git really showed.
        CREATE TABLE IF NOT EXISTS diff_orders (
            workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
            mode TEXT NOT NULL,
            target TEXT NOT NULL DEFAULT '',
            paths_json TEXT NOT NULL,
            -- Sorted (path, status) pairs: changes when a file joins or leaves.
            file_set_fingerprint TEXT NOT NULL,
            -- Both sides of every file: changes on any edit.
            content_fingerprint TEXT NOT NULL,
            saved_at TEXT NOT NULL,
            PRIMARY KEY (workstream_id, mode, target)
        );

        -- Copilot sessions the phone companion started (ADR 033), keyed by tile.
        -- Only these may send messages to the phone. Times are ms epoch.
        CREATE TABLE IF NOT EXISTS companion_sessions (
            tile_id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        -- What their agents sent back. `seq` keeps send order within a millisecond.
        CREATE TABLE IF NOT EXISTS companion_messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            tile_id TEXT NOT NULL REFERENCES companion_sessions(tile_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS companion_messages_tile_idx ON companion_messages (tile_id, at);

        CREATE TABLE IF NOT EXISTS pr_inbox_config (
            project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
            enabled INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 0,
            current_identity TEXT,
            current_source TEXT,
            last_checked TEXT,
            error TEXT,
            watch_mode TEXT NOT NULL DEFAULT 'reviewer'
        );
        CREATE TABLE IF NOT EXISTS pr_inbox_baselines (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source TEXT NOT NULL,
            identity TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'reviewer',
            PRIMARY KEY (project_id, source, identity, role)
        );
        CREATE TABLE IF NOT EXISTS pr_inbox_seen (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source TEXT NOT NULL,
            identity TEXT NOT NULL,
            pr_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            url TEXT NOT NULL,
            notified INTEGER NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            discovered_at TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'reviewer',
            pr_status TEXT NOT NULL DEFAULT 'active',
            deep_synced INTEGER NOT NULL DEFAULT 0,
            comment_watermark TEXT NOT NULL DEFAULT '',
            votes_json TEXT NOT NULL DEFAULT '{}',
            policies_json TEXT NOT NULL DEFAULT '{}',
            UNIQUE(project_id, source, identity, pr_id)
        );
        -- One row per *notification*, where pr_inbox_seen holds one row per
        -- watched PR. A single PR now produces a stream (assigned, comments,
        -- votes, build gates, closure) rather than the single arrival event the
        -- inbox started with, so read state cannot live on the PR row.
        CREATE TABLE IF NOT EXISTS pr_inbox_events (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            source TEXT NOT NULL,
            identity TEXT NOT NULL,
            pr_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            author TEXT NOT NULL,
            summary TEXT NOT NULL,
            url TEXT NOT NULL,
            is_read INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            dedupe_key TEXT NOT NULL,
            UNIQUE(project_id, source, identity, pr_id, kind, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS pr_inbox_events_unread_idx ON pr_inbox_events (is_read);

        CREATE INDEX IF NOT EXISTS command_log_created_idx ON command_log (created_at);
        CREATE INDEX IF NOT EXISTS command_log_command_idx ON command_log (command);
        CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id);
        CREATE INDEX IF NOT EXISTS task_events_date_idx ON task_events (created_at);
        CREATE INDEX IF NOT EXISTS tasks_completed_idx ON tasks (completed_at);
        ",
    )?;

    // Migrations: add columns that may be missing from older schemas
    let migrations = [
        "ALTER TABLE workstreams ADD COLUMN project_id TEXT REFERENCES projects(id)",
        "ALTER TABLE workstreams ADD COLUMN workstream_type TEXT NOT NULL DEFAULT 'standalone'",
        "ALTER TABLE workstreams ADD COLUMN worktree_branch TEXT",
        "ALTER TABLE projects ADD COLUMN copilot_command TEXT",
        // Archived repositories remain available for existing workstreams and
        // can be restored later; ordinary repo lists hide them by default.
        "ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        // Which Copilot session created this workstream, when one did. An agent
        // may act on its own workstream and ones it created, and that second
        // clause is unenforceable without a record of who created what. NULL
        // means "a human made this in the UI", which is the common case and not
        // an error.
        "ALTER TABLE workstreams ADD COLUMN created_by_session TEXT",
        // Which work lane this workstream belongs to. NULL means "No lane",
        // which is a real state rather than an absence: it is the section
        // workstreams are dragged into to leave a lane.
        //
        // ON DELETE SET NULL, so deleting a lane re-files its members instead
        // of destroying them -- reorganising should never lose work.
        "ALTER TABLE workstreams ADD COLUMN lane_id TEXT REFERENCES work_lanes(id) ON DELETE SET NULL",
        "ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
        // Defence in depth for the 1:1 task↔workstream relation. Partial, so
        // the many tasks with no workstream are unaffected. On a database that
        // already contains duplicates this create fails and is ignored (as all
        // migrations here are) -- the command-level check in tasks.rs is the
        // authoritative guard and still holds the line.
        "CREATE UNIQUE INDEX IF NOT EXISTS tasks_workstream_unique          ON tasks (workstream_id) WHERE workstream_id IS NOT NULL",
        // Whether this workstream was open when the app last closed.
        //
        // "Loaded" was runtime-only state (a key in React's wsStates map), so
        // every launch started from an empty desk and the workstreams that
        // represent in-progress work had to be reopened by hand. It is
        // persisted here because the loaded set *is* how the user tracks what
        // they are working on.
        //
        // This records the set, not the processes: restoring it marks the rows
        // as loaded, and their tiles still mount lazily on first visit. Booting
        // 23 workstreams' worth of terminals and Copilot sessions at once is
        // not what "leave my desk as I left it" should cost.
        "ALTER TABLE workstreams ADD COLUMN is_loaded INTEGER NOT NULL DEFAULT 0",
        // The PR inbox grew from "notify me when I am assigned a review" into a
        // per-PR event stream. Older databases predate every column below.
        "ALTER TABLE pr_inbox_config ADD COLUMN watch_mode TEXT NOT NULL DEFAULT 'reviewer'",
        "ALTER TABLE pr_inbox_seen ADD COLUMN role TEXT NOT NULL DEFAULT 'reviewer'",
        "ALTER TABLE pr_inbox_seen ADD COLUMN pr_status TEXT NOT NULL DEFAULT 'active'",
        "ALTER TABLE pr_inbox_seen ADD COLUMN deep_synced INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE pr_inbox_seen ADD COLUMN comment_watermark TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE pr_inbox_seen ADD COLUMN votes_json TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE pr_inbox_seen ADD COLUMN policies_json TEXT NOT NULL DEFAULT '{}'",
    ];
    for sql in &migrations {
        // SQLite errors if column already exists — ignore that error
        let _ = conn.execute_batch(sql);
    }

    migrate_pr_inbox_events(conn)?;

    crate::loops::init_loop_schema(conn)?;

    Ok(())
}

/// Carries a pre-event-stream inbox forward.
///
/// Two things cannot be expressed as `ALTER TABLE`. The baseline key gained a
/// `role`, so widening a repo from reviewer-only to authored starts a *fresh*
/// silent baseline instead of announcing every PR the user has ever opened; a
/// plain added column would keep the old three-column primary key and make the
/// second role unstorable. And the notifications themselves moved out of
/// `pr_inbox_seen` into `pr_inbox_events`, carrying their original ids so the
/// read state already on screen survives the upgrade.
fn migrate_pr_inbox_events(conn: &Connection) -> rusqlite::Result<()> {
    let keyed_by_role: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('pr_inbox_baselines') WHERE name='role'",
        [],
        |r| r.get(0),
    )?;
    if keyed_by_role == 0 {
        conn.execute_batch(
            "ALTER TABLE pr_inbox_baselines RENAME TO pr_inbox_baselines_old;
            CREATE TABLE pr_inbox_baselines (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                source TEXT NOT NULL,
                identity TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'reviewer',
                PRIMARY KEY (project_id, source, identity, role)
            );
            INSERT OR IGNORE INTO pr_inbox_baselines(project_id,source,identity,role)
                SELECT project_id, source, identity, 'reviewer' FROM pr_inbox_baselines_old;
            DROP TABLE pr_inbox_baselines_old;",
        )?;
    }
    // Idempotent: the primary key is the original notification id, so a second
    // run cannot duplicate or resurrect a notification the user has since read.
    conn.execute(
        "INSERT OR IGNORE INTO pr_inbox_events
        (id,project_id,source,identity,pr_id,kind,title,author,summary,url,is_read,created_at,dedupe_key)
        SELECT id,project_id,source,identity,pr_id,'assigned',title,author,
            'Assigned to you as reviewer',url,is_read,discovered_at,''
        FROM pr_inbox_seen WHERE notified=1",
        [],
    )?;
    Ok(())
}

pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    init_db(&conn)?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_in_memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
    }

    #[test]
    fn init_db_creates_all_tables() {
        let conn = open_in_memory();
        let expected = [
            "projects",
            "workstreams",
            "workstream_layouts",
            "tiles",
            "terminal_scrollback",
            "copilot_session_links",
            "settings",
            "visual_proofs",
            "labels",
            "tasks",
            "subtasks",
            "task_labels",
            "task_events",
            "loop_specs",
            "loop_runs",
            "loop_tasks",
            "loop_verifications",
            "loop_evaluations",
            "loop_events",
            "workstream_pull_requests",
            "work_lanes",
            "diff_orders",
            "companion_sessions",
            "companion_messages",
        ];
        for table in &expected {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                    [*table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table {table} missing");
        }
    }

    /// B3: latest only. A second order for the same diff must replace the
    /// first, not sit beside it where a reader could pick the stale one.
    #[test]
    fn diff_orders_keep_one_row_per_workstream_mode_and_target() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO workstreams (id, name, created_at, updated_at) VALUES ('w', 'W', 'x', 'x')",
            [],
        )
        .unwrap();
        let upsert = |paths: &str, target: &str| {
            conn.execute(
                "INSERT INTO diff_orders
                   (workstream_id, mode, target, paths_json, file_set_fingerprint,
                    content_fingerprint, saved_at)
                 VALUES ('w', 'custom_branch', ?2, ?1, 'f', 'c', 'now')
                 ON CONFLICT (workstream_id, mode, target) DO UPDATE SET
                   paths_json = excluded.paths_json",
                rusqlite::params![paths, target],
            )
            .unwrap();
        };
        upsert("[\"a\"]", "main");
        upsert("[\"b\"]", "main");
        upsert("[\"c\"]", "release");
        let rows: Vec<(String, String)> = conn
            .prepare("SELECT target, paths_json FROM diff_orders ORDER BY target")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("main".to_string(), "[\"b\"]".to_string()),
                ("release".to_string(), "[\"c\"]".to_string()),
            ]
        );
    }

    #[test]
    fn tasks_notes_default_to_empty_rather_than_null() {
        // The column is added by migration on existing databases, so rows that
        // predate it must read as "" and not NULL -- a NULL would surface as a
        // crash or a literal "null" in the exported page.
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO tasks (id, title, created_at, updated_at)
             VALUES ('t1', 'x', '2026-08-20', '2026-08-20')",
            [],
        )
        .unwrap();
        let notes: String = conn
            .query_row("SELECT notes FROM tasks WHERE id='t1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(notes, "");
    }

    #[test]
    fn notes_migration_is_safe_to_rerun_on_an_existing_database() {
        let conn = open_in_memory();
        init_db(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name='notes'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "notes column duplicated or missing");
    }

    /// Scope enforcement lets an agent act on workstreams it created, which is
    /// unenforceable without recording who created each one.
    #[test]
    fn provenance_survives_a_rerun_and_leaves_existing_rows_alone() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO workstreams (id, name, status, created_at, updated_at)
             VALUES ('ws-old', 'Made in the UI', 'active', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        // Re-running init_db is how a second launch behaves; the column must
        // appear exactly once and must not disturb rows that predate it.
        init_db(&conn).unwrap();
        init_db(&conn).unwrap();

        let columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('workstreams') WHERE name='created_by_session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 1, "created_by_session duplicated or missing");

        let existing: Option<String> = conn
            .query_row(
                "SELECT created_by_session FROM workstreams WHERE id = 'ws-old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            existing, None,
            "a workstream created before provenance existed has none, and that is not an error"
        );
    }

    /// Reorganising must never destroy work: deleting a lane re-files its
    /// members as "No lane" rather than deleting them.
    #[test]
    fn deleting_a_lane_reassigns_its_workstreams_instead_of_removing_them() {
        let conn = open_in_memory();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO work_lanes (id, name, created_at, updated_at)
                VALUES ('lane-1','Media Store','2026-01-01','2026-01-01');
             INSERT INTO workstreams (id, name, status, lane_id, created_at, updated_at)
                VALUES ('ws-1','Read chunks','active','lane-1','2026-01-01','2026-01-01');",
        )
        .unwrap();

        conn.execute("DELETE FROM work_lanes WHERE id = 'lane-1'", [])
            .unwrap();

        let (surviving, lane): (i64, Option<String>) = conn
            .query_row(
                "SELECT COUNT(*), MAX(lane_id) FROM workstreams WHERE id = 'ws-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(surviving, 1, "the workstream must outlive its lane");
        assert_eq!(lane, None, "it should fall back to No lane");
    }

    /// Duplicate folder names make the list unreadable and a drop target
    /// ambiguous, so case alone cannot distinguish two lanes.
    #[test]
    fn lane_names_are_unique_regardless_of_case() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO work_lanes (id, name, created_at, updated_at)
             VALUES ('lane-1','Media Store','2026-01-01','2026-01-01')",
            [],
        )
        .unwrap();
        for duplicate in ["Media Store", "media store", "MEDIA STORE"] {
            let attempt = conn.execute(
                "INSERT INTO work_lanes (id, name, created_at, updated_at)
                 VALUES ('lane-2', ?1, '2026-01-01','2026-01-01')",
                [duplicate],
            );
            assert!(attempt.is_err(), "{duplicate:?} should collide");
        }
        // A genuinely different name is fine.
        conn.execute(
            "INSERT INTO work_lanes (id, name, created_at, updated_at)
             VALUES ('lane-2','Tooling','2026-01-01','2026-01-01')",
            [],
        )
        .expect("a distinct name must be accepted");
    }

    #[test]
    fn the_lane_column_is_added_once_and_defaults_to_no_lane() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO workstreams (id, name, status, created_at, updated_at)
             VALUES ('ws-old','Made before lanes','active','2026-01-01','2026-01-01')",
            [],
        )
        .unwrap();
        init_db(&conn).unwrap();
        init_db(&conn).unwrap();

        let columns: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('workstreams') WHERE name='lane_id'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 1, "lane_id duplicated or missing");
        let lane: Option<String> = conn
            .query_row(
                "SELECT lane_id FROM workstreams WHERE id='ws-old'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(lane, None, "a workstream that predates lanes has none");
    }

    /// The link table is many-to-many and idempotent, and a deleted workstream
    /// must not leave its links behind.
    #[test]
    fn pull_request_links_are_many_to_many_and_deduplicated() {
        let conn = open_in_memory();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO workstreams (id, name, status, created_at, updated_at)
                VALUES ('ws-1','One','active','2026-01-01','2026-01-01');
             INSERT INTO workstreams (id, name, status, created_at, updated_at)
                VALUES ('ws-2','Two','active','2026-01-01','2026-01-01');",
        )
        .unwrap();
        let link = |id: &str, ws: &str, identity: &str| {
            conn.execute(
                "INSERT INTO workstream_pull_requests
                    (id, workstream_id, url, organization, project, repository, number,
                     identity, created_at, updated_at)
                 VALUES (?1, ?2, 'https://example', 'org', 'proj', 'repo', 1, ?3,
                         '2026-01-01', '2026-01-01')",
                rusqlite::params![id, ws, identity],
            )
        };

        // One workstream, several PRs.
        link("l1", "ws-1", "org/proj/repo#1").unwrap();
        link("l2", "ws-1", "org/proj/repo#2").unwrap();
        // One PR, several workstreams.
        link("l3", "ws-2", "org/proj/repo#1").unwrap();

        // The same PR twice on one workstream is refused by the index, so
        // linking can be idempotent without a check-then-insert race.
        assert!(link("l4", "ws-1", "org/proj/repo#1").is_err());

        conn.execute("DELETE FROM workstreams WHERE id = 'ws-1'", [])
            .unwrap();
        let remaining: i64 = conn
            .query_row("SELECT COUNT(*) FROM workstream_pull_requests", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 1, "links must not outlive their workstream");
    }

    #[test]
    fn labels_are_unique_case_insensitively() {
        // Free-form labels with no seed and no merge tool mean the database
        // itself has to refuse the duplicate; a UI-only guard would be
        // bypassed by the CLI.
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO labels (id, name, created_at) VALUES ('l1', 'AI Crew', '2026-08-19')",
            [],
        )
        .unwrap();
        let dup = conn.execute(
            "INSERT INTO labels (id, name, created_at) VALUES ('l2', ' ai crew ', '2026-08-19')",
            [],
        );
        assert!(dup.is_err(), "case/whitespace variant should be rejected");
    }

    #[test]
    fn deleting_a_task_cascades_to_its_children() {
        let conn = open_in_memory();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO tasks (id, title, created_at, updated_at)
                VALUES ('t1', 'x', '2026-08-19', '2026-08-19');
             INSERT INTO subtasks (id, task_id, title, created_at, updated_at)
                VALUES ('s1', 't1', 'sub', '2026-08-19', '2026-08-19');
             INSERT INTO task_events (id, task_id, kind, text, created_at)
                VALUES ('e1', 't1', 'note', 'hi', '2026-08-19');
             DELETE FROM tasks WHERE id = 't1';",
        )
        .unwrap();

        for table in ["subtasks", "task_events"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table} rows outlived their task");
        }
    }

    #[test]
    fn archiving_a_workstream_leaves_its_task_alive() {
        // A task must survive losing its workstream -- the link is optional in
        // both directions, and archiving a workstream is routine cleanup.
        let conn = open_in_memory();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO workstreams (id, name, created_at, updated_at)
                VALUES ('w1', 'ws', '2026-08-19', '2026-08-19');
             INSERT INTO tasks (id, title, workstream_id, created_at, updated_at)
                VALUES ('t1', 'x', 'w1', '2026-08-19', '2026-08-19');
             DELETE FROM workstreams WHERE id = 'w1';",
        )
        .unwrap();

        let ws: Option<String> = conn
            .query_row("SELECT workstream_id FROM tasks WHERE id = 't1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ws, None, "task should be detached, not deleted");
    }

    #[test]
    fn init_db_is_idempotent() {
        let conn = open_in_memory();
        // Run init again — should not error
        init_db(&conn).unwrap();
        init_db(&conn).unwrap();
    }

    #[test]
    fn open_db_creates_file_and_schema() {
        let tmp = std::env::temp_dir().join(format!("ws_db_test_{}.db", std::process::id()));
        std::fs::remove_file(&tmp).ok();
        let conn = open_db(&tmp).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(conn);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn open_db_waits_for_concurrent_writers() {
        let tmp = std::env::temp_dir().join(format!(
            "ws_busy_timeout_{}_{}.db",
            std::process::id(),
            crate::now()
        ));
        std::fs::remove_file(&tmp).ok();
        let conn = open_db(&tmp).unwrap();
        let timeout_ms: u64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout_ms, 5_000);
        drop(conn);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn resolve_db_path_respects_env_var() {
        // Save and restore to avoid affecting other tests.
        let prev = std::env::var("WORKSTREAMS_DB_PATH").ok();
        std::env::set_var("WORKSTREAMS_DB_PATH", "/tmp/custom-test.db");
        let path = resolve_db_path();
        assert_eq!(path, PathBuf::from("/tmp/custom-test.db"));
        match prev {
            Some(v) => std::env::set_var("WORKSTREAMS_DB_PATH", v),
            None => std::env::remove_var("WORKSTREAMS_DB_PATH"),
        }
    }

    #[test]
    fn resolve_db_path_ignores_empty_env_var() {
        let prev = std::env::var("WORKSTREAMS_DB_PATH").ok();
        std::env::set_var("WORKSTREAMS_DB_PATH", "   ");
        let path = resolve_db_path();
        // Should fall back, not return the empty/whitespace path.
        assert_ne!(path, PathBuf::from("   "));
        match prev {
            Some(v) => std::env::set_var("WORKSTREAMS_DB_PATH", v),
            None => std::env::remove_var("WORKSTREAMS_DB_PATH"),
        }
    }

    #[test]
    fn resolve_db_path_falls_back_to_dev_in_debug_builds() {
        let prev = std::env::var("WORKSTREAMS_DB_PATH").ok();
        std::env::remove_var("WORKSTREAMS_DB_PATH");
        let path = resolve_db_path();
        if cfg!(debug_assertions) {
            assert!(path.ends_with("workstreams-dev.db"));
            assert!(path.to_string_lossy().contains(".dev"));
        } else {
            // Release: uses <data_local_dir>/workstreams/workstreams.db
            assert!(path.ends_with("workstreams.db"));
            assert!(path
                .parent()
                .map(|p| p.ends_with("workstreams"))
                .unwrap_or(false));
        }
        if let Some(v) = prev {
            std::env::set_var("WORKSTREAMS_DB_PATH", v);
        }
    }

    #[test]
    fn migrate_legacy_db_is_noop_when_new_path_exists() {
        let tmp = std::env::temp_dir().join(format!(
            "ws-migrate-noop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let new_dir = tmp.join("new");
        std::fs::create_dir_all(&new_dir).unwrap();
        let new_path = new_dir.join("workstreams.db");
        std::fs::write(&new_path, b"existing content").unwrap();

        super::migrate_legacy_db_if_present(&new_path);

        // File untouched.
        let after = std::fs::read(&new_path).unwrap();
        assert_eq!(after, b"existing content");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn visual_proofs_table_can_insert_and_select() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO visual_proofs (todo_id, feature_id, screenshot_path, console_error_count, captured_at) VALUES ('t1', 'feat1', '/path/x.png', 0, 't')",
            [],
        )
        .unwrap();
        let path: String = conn
            .query_row(
                "SELECT screenshot_path FROM visual_proofs WHERE todo_id = 't1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(path, "/path/x.png");
    }

    #[test]
    fn projects_table_can_insert_and_select() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO projects (id, name, directory, color, created_at, updated_at) VALUES ('p1', 'Test', '/tmp', '#fff', 't1', 't1')",
            [],
        )
        .unwrap();
        let name: String = conn
            .query_row("SELECT name FROM projects WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(name, "Test");
    }

    #[test]
    fn projects_copilot_command_defaults_null_and_round_trips() {
        let conn = open_in_memory();
        // Insert without the column → NULL (inherit global).
        conn.execute(
            "INSERT INTO projects (id, name, directory, color, created_at, updated_at) VALUES ('p1', 'Test', '/tmp', '#fff', 't1', 't1')",
            [],
        )
        .unwrap();
        let cmd: Option<String> = conn
            .query_row(
                "SELECT copilot_command FROM projects WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cmd, None, "new projects default to NULL (inherit)");

        // Set an override, then clear it back to NULL — mirrors update_project.
        conn.execute(
            "UPDATE projects SET copilot_command = 'copilot --yolo' WHERE id = 'p1'",
            [],
        )
        .unwrap();
        let set: Option<String> = conn
            .query_row(
                "SELECT copilot_command FROM projects WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(set.as_deref(), Some("copilot --yolo"));

        conn.execute(
            "UPDATE projects SET copilot_command = NULL WHERE id = 'p1'",
            [],
        )
        .unwrap();
        let cleared: Option<String> = conn
            .query_row(
                "SELECT copilot_command FROM projects WHERE id = 'p1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cleared, None, "empty override clears back to inherit");
    }

    #[test]
    fn projects_archive_state_defaults_to_visible_and_round_trips() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO projects (id, name, directory, color, created_at, updated_at)
             VALUES ('p1', 'Test', '/tmp', '#fff', 't1', 't1')",
            [],
        )
        .unwrap();
        let archived: i64 = conn
            .query_row("SELECT archived FROM projects WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(archived, 0);

        conn.execute("UPDATE projects SET archived = 1 WHERE id = 'p1'", [])
            .unwrap();
        let archived: i64 = conn
            .query_row("SELECT archived FROM projects WHERE id = 'p1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(archived, 1);
    }

    #[test]
    fn list_workstreams_query_includes_archived() {
        // Regression test for the bug where archived workstreams were filtered
        // out by 'WHERE status != archived' in list_workstreams, causing them
        // to disappear on app restart.
        let conn = open_in_memory();
        conn.execute_batch(
            "INSERT INTO workstreams (id, name, status, workstream_type, created_at, updated_at)
                VALUES ('w-active', 'A', 'active', 'standalone', 't1', 't1');
             INSERT INTO workstreams (id, name, status, workstream_type, created_at, updated_at)
                VALUES ('w-archived', 'B', 'archived', 'standalone', 't1', 't1');",
        )
        .unwrap();
        // Exact query mirrored from lib.rs::list_workstreams — must include archived.
        let mut stmt = conn
            .prepare("SELECT id, status FROM workstreams ORDER BY created_at ASC")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(rows.len(), 2, "expected both active and archived rows");
        let statuses: std::collections::HashSet<&str> =
            rows.iter().map(|(_, s)| s.as_str()).collect();
        assert!(statuses.contains("active"));
        assert!(statuses.contains("archived"));
    }

    #[test]
    fn tiles_cascade_delete_with_workstream() {
        let conn = open_in_memory();
        conn.execute_batch(
            "INSERT INTO workstreams (id, name, status, workstream_type, created_at, updated_at) VALUES ('w1', 'WS', 'active', 'standalone', 't', 't');
             INSERT INTO tiles (id, workstream_id, tile_type, created_at, updated_at) VALUES ('t1', 'w1', 'terminal', 't', 't');"
        ).unwrap();
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        conn.execute("DELETE FROM workstreams WHERE id = 'w1'", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tiles", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn settings_table_supports_upsert() {
        let conn = open_in_memory();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            ["k1", "v1"],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            ["k1", "v2"],
        )
        .unwrap();
        let val: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'k1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(val, "v2");
    }
}

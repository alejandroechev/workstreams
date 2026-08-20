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
        "ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT ''",
    ];
    for sql in &migrations {
        // SQLite errors if column already exists — ignore that error
        let _ = conn.execute_batch(sql);
    }

    Ok(())
}

pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(path)?;
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

use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// Resolves the workstreams DB path with the following precedence:
/// 1. `WORKSTREAMS_DB_PATH` env var (absolute or relative path)
/// 2. Debug builds → `<cwd>/.dev/workstreams-dev.db`
/// 3. Release builds → `<data_local_dir>/copilot-desktop/copilot-desktop.db`
///
/// Always isolates dev work from the production database.
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
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("copilot-desktop")
        .join("copilot-desktop.db")
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

        CREATE TABLE IF NOT EXISTS diff_reviews (
            id TEXT PRIMARY KEY,
            workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
            diff_source TEXT NOT NULL,
            source_ref TEXT,
            status TEXT NOT NULL DEFAULT 'planning',
            plan_json TEXT,
            exported_path TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS diff_chunks (
            id TEXT PRIMARY KEY,
            review_id TEXT NOT NULL REFERENCES diff_reviews(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            title TEXT NOT NULL,
            summary TEXT,
            is_trivial INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'pending',
            question_text TEXT,
            question_style TEXT,
            invalidated_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS diff_hunks (
            id TEXT PRIMARY KEY,
            chunk_id TEXT NOT NULL REFERENCES diff_chunks(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL,
            old_start INTEGER,
            old_lines INTEGER,
            new_start INTEGER,
            new_lines INTEGER,
            patch_text TEXT NOT NULL,
            content_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS diff_comments (
            id TEXT PRIMARY KEY,
            chunk_id TEXT NOT NULL REFERENCES diff_chunks(id) ON DELETE CASCADE,
            anchor_file TEXT NOT NULL,
            anchor_line_start INTEGER NOT NULL,
            anchor_line_end INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS diff_review_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            review_id TEXT NOT NULL REFERENCES diff_reviews(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_diff_chunks_review ON diff_chunks(review_id, ordinal);
        CREATE INDEX IF NOT EXISTS idx_diff_hunks_chunk ON diff_hunks(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_diff_comments_chunk ON diff_comments(chunk_id);
        CREATE INDEX IF NOT EXISTS idx_diff_review_events_review ON diff_review_events(review_id, id);
        ",
    )?;

    // Migrations: add columns that may be missing from older schemas
    let migrations = [
        "ALTER TABLE workstreams ADD COLUMN project_id TEXT REFERENCES projects(id)",
        "ALTER TABLE workstreams ADD COLUMN workstream_type TEXT NOT NULL DEFAULT 'standalone'",
        "ALTER TABLE workstreams ADD COLUMN worktree_branch TEXT",
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
            "diff_reviews",
            "diff_chunks",
            "diff_hunks",
            "diff_comments",
            "diff_review_events",
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
        }
        if let Some(v) = prev {
            std::env::set_var("WORKSTREAMS_DB_PATH", v);
        }
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

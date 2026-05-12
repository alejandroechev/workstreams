use rusqlite::Connection;
use std::path::Path;

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

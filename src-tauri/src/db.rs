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

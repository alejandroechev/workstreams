#!/usr/bin/env python3
"""
install-triggers.py <sessionId>

Install SQLite triggers + schema in the current Copilot CLI session's database
to enforce dev discipline AND first-class plan tracking.

Triggers:
1. auto_inject_feature_todos: category='feature' -> auto-creates test/visual/docs sub-todos
2. block_done_with_pending_children: cannot mark parent done while children pending
3. auto_tag_plan_id: every new todo gets plan_id from current_plan
4. maybe_rollover_plan: detect plan boundary via activity gap + completion signal

Schema:
- plans (id, title, status, created_at, superseded_at, superseded_by, plan_md_snapshot)
- current_plan (singleton: id=1, plan_id)
- todos.plan_id, todos.category, todos.parent_id added if missing
- todos.status CHECK constraint includes 'archived'

Idempotent. Safe to run on every session start.
"""
import sqlite3
import sys
import pathlib
from datetime import datetime


def column_exists(conn, table, column):
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def table_exists(conn, table):
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row[0] > 0


def status_check_supports_archived(conn):
    """Check whether the todos.status CHECK constraint allows 'archived'."""
    try:
        conn.execute("SAVEPOINT check_status")
        conn.execute("INSERT INTO todos (id, title, status) VALUES ('__check_archived__', 'check', 'archived')")
        conn.execute("DELETE FROM todos WHERE id = '__check_archived__'")
        conn.execute("RELEASE check_status")
        return True
    except sqlite3.IntegrityError:
        conn.execute("ROLLBACK TO check_status")
        conn.execute("RELEASE check_status")
        return False


def rebuild_todos_with_archived_status(conn):
    """Rebuild todos table to allow 'archived' status. Preserves all data.
    
    Foreign keys are temporarily disabled because todo_deps references todos.id —
    SQLite's table-rebuild trick relies on PRAGMA defer_foreign_keys OR disabling FKs.
    """
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.executescript("""
            BEGIN;
            CREATE TABLE todos_new (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked', 'archived')),
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                category TEXT DEFAULT 'impl',
                parent_id TEXT,
                plan_id TEXT
            );
            INSERT INTO todos_new SELECT id, title, description, status, created_at, updated_at, category, parent_id, plan_id FROM todos;
            DROP TABLE todos;
            ALTER TABLE todos_new RENAME TO todos;
            COMMIT;
        """)
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def install(session_id):
    home = pathlib.Path.home()
    db_path = home / ".copilot" / "session-state" / session_id / "session.db"
    if not db_path.exists():
        print(f"WARN: session.db not found at {db_path}", file=sys.stderr)
        return False

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = ON")

    if not table_exists(conn, "todos"):
        print("INFO: todos table not yet created", file=sys.stderr)
        return True

    # 1. Add new columns (idempotent)
    if not column_exists(conn, "todos", "category"):
        conn.execute("ALTER TABLE todos ADD COLUMN category TEXT DEFAULT 'impl'")
    if not column_exists(conn, "todos", "parent_id"):
        conn.execute("ALTER TABLE todos ADD COLUMN parent_id TEXT")
    if not column_exists(conn, "todos", "plan_id"):
        conn.execute("ALTER TABLE todos ADD COLUMN plan_id TEXT")

    # 2. Create plans tables (idempotent)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS plans (
            id TEXT PRIMARY KEY,
            title TEXT,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK(status IN ('active', 'superseded', 'completed', 'abandoned')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            superseded_at TEXT,
            superseded_by TEXT REFERENCES plans(id),
            plan_md_snapshot TEXT
        );

        CREATE TABLE IF NOT EXISTS current_plan (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            plan_id TEXT NOT NULL REFERENCES plans(id)
        );
    """)

    # 3. Update status CHECK constraint to allow 'archived' (rebuild if needed)
    if not status_check_supports_archived(conn):
        print("INFO: rebuilding todos table to support 'archived' status", file=sys.stderr)
        rebuild_todos_with_archived_status(conn)

    # 4. Bootstrap: create plan-legacy-bootstrap if no current_plan exists
    has_current = conn.execute("SELECT COUNT(*) FROM current_plan").fetchone()[0] > 0
    if not has_current:
        bootstrap_id = "plan-legacy-bootstrap"
        # Check if the plan already exists (idempotent)
        existing = conn.execute("SELECT id FROM plans WHERE id = ?", (bootstrap_id,)).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO plans (id, title, status) VALUES (?, ?, 'active')",
                (bootstrap_id, "Legacy bootstrap plan"),
            )
        conn.execute("INSERT INTO current_plan (id, plan_id) VALUES (1, ?)", (bootstrap_id,))

    # 5. Backfill: any todo with NULL plan_id gets the bootstrap plan
    current_plan_id = conn.execute("SELECT plan_id FROM current_plan WHERE id = 1").fetchone()[0]
    conn.execute(
        "UPDATE todos SET plan_id = ? WHERE plan_id IS NULL",
        (current_plan_id,),
    )

    # 6. Install all triggers
    conn.executescript("""
        -- Feature auto-injection (existing)
        CREATE TRIGGER IF NOT EXISTS auto_inject_feature_todos
        AFTER INSERT ON todos
        WHEN NEW.category = 'feature' AND NEW.parent_id IS NULL
        BEGIN
            INSERT INTO todos (id, title, description, category, parent_id)
            VALUES (NEW.id || '-test', 'Tests for ' || NEW.title,
                    'TDD: write failing test first, then implementation',
                    'test', NEW.id);
            INSERT INTO todos (id, title, description, category, parent_id)
            VALUES (NEW.id || '-visual', 'Visual validation for ' || NEW.title,
                    'Run npm run validate-feature; capture CDP screenshot; verify clean console',
                    'visual', NEW.id);
            INSERT INTO todos (id, title, description, category, parent_id)
            VALUES (NEW.id || '-docs', 'Update docs for ' || NEW.title,
                    'Update README, system-diagram, or write ADR if applicable',
                    'docs', NEW.id);
            INSERT INTO todo_deps (todo_id, depends_on) VALUES (NEW.id, NEW.id || '-test');
            INSERT INTO todo_deps (todo_id, depends_on) VALUES (NEW.id, NEW.id || '-visual');
            INSERT INTO todo_deps (todo_id, depends_on) VALUES (NEW.id, NEW.id || '-docs');
        END;

        -- Block parent done while children pending (existing)
        CREATE TRIGGER IF NOT EXISTS block_done_with_pending_children
        BEFORE UPDATE OF status ON todos
        WHEN NEW.status = 'done'
            AND EXISTS (
                SELECT 1 FROM todo_deps d
                JOIN todos child ON child.id = d.depends_on
                WHERE d.todo_id = NEW.id
                    AND child.status != 'done'
            )
        BEGIN
            SELECT RAISE(ABORT,
                'Cannot mark parent done: child todos still pending. Complete test/visual/docs first.');
        END;

        -- Auto-tag plan_id from current_plan on every insert (NEW)
        CREATE TRIGGER IF NOT EXISTS auto_tag_plan_id
        AFTER INSERT ON todos
        WHEN NEW.plan_id IS NULL
        BEGIN
            UPDATE todos
            SET plan_id = (SELECT plan_id FROM current_plan WHERE id = 1)
            WHERE id = NEW.id;
        END;

        -- Auto-rollover plan on activity gap + completion signal (NEW)
        -- Fires ONCE per planning batch because after first fire, the new
        -- current_plan has no done todos, so the WHEN clause goes false.
        CREATE TRIGGER IF NOT EXISTS maybe_rollover_plan
        AFTER INSERT ON todos
        WHEN (
            -- Current plan has any done work
            EXISTS (
                SELECT 1 FROM todos t
                WHERE t.plan_id = (SELECT plan_id FROM current_plan WHERE id = 1)
                    AND t.status = 'done'
                    AND t.id != NEW.id
            )
            AND
            -- And the last activity in current plan was >15 minutes before NEW.created_at
            (
                SELECT MAX(updated_at) FROM todos
                WHERE id != NEW.id
                    AND plan_id = (SELECT plan_id FROM current_plan WHERE id = 1)
            ) < datetime(NEW.created_at, '-15 minutes')
        )
        BEGIN
            -- Mark current plan as superseded
            UPDATE plans
            SET status = 'superseded',
                superseded_at = NEW.created_at,
                superseded_by = 'plan-' || NEW.created_at
            WHERE status = 'active'
              AND id != 'plan-' || NEW.created_at;

            -- Archive pending/in_progress todos in the old plan
            UPDATE todos
            SET status = 'archived'
            WHERE id != NEW.id
              AND plan_id = (SELECT plan_id FROM current_plan WHERE id = 1)
              AND status IN ('pending', 'in_progress');

            -- Create new plan (INSERT OR IGNORE in case multiple triggers fire same second)
            INSERT OR IGNORE INTO plans (id, status, created_at)
            VALUES ('plan-' || NEW.created_at, 'active', NEW.created_at);

            -- Point current_plan to new plan
            INSERT OR REPLACE INTO current_plan (id, plan_id)
            VALUES (1, 'plan-' || NEW.created_at);

            -- Tag this new todo with the new plan
            UPDATE todos SET plan_id = 'plan-' || NEW.created_at WHERE id = NEW.id;
        END;
    """)
    conn.commit()
    conn.close()
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: install-triggers.py <sessionId>", file=sys.stderr)
        sys.exit(1)
    session_id = sys.argv[1]
    ok = install(session_id)
    if ok:
        print(f"Discipline triggers + plan tracking installed for session {session_id[:8]}")
    else:
        sys.exit(1)

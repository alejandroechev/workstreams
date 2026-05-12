#!/usr/bin/env python3
"""
install-triggers.py <sessionId>

Install SQLite triggers in the current Copilot CLI session's database
to enforce dev discipline:

1. auto_inject_feature_todos: When a todo with category='feature' is
   inserted, automatically create test/visual/docs sub-todos and link
   them via todo_deps.

2. block_done_with_pending_children: Prevent marking a parent todo as
   'done' while any of its child dependencies are still pending or
   in_progress.

Idempotent: Safe to run on every session start. Adds category and
parent_id columns if missing. Recreates triggers if missing.
"""
import sqlite3
import sys
import pathlib


def column_exists(conn, table, column):
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def install(session_id):
    home = pathlib.Path.home()
    db_path = home / ".copilot" / "session-state" / session_id / "session.db"
    if not db_path.exists():
        print(f"WARN: session.db not found at {db_path}", file=sys.stderr)
        return False

    conn = sqlite3.connect(str(db_path))

    table_exists = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='todos'"
    ).fetchone()[0] > 0
    if not table_exists:
        conn.close()
        print("INFO: todos table not yet created", file=sys.stderr)
        return True

    if not column_exists(conn, "todos", "category"):
        conn.execute("ALTER TABLE todos ADD COLUMN category TEXT DEFAULT 'impl'")
    if not column_exists(conn, "todos", "parent_id"):
        conn.execute("ALTER TABLE todos ADD COLUMN parent_id TEXT")

    conn.executescript("""
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
        print(f"Discipline triggers installed for session {session_id[:8]}")
    else:
        sys.exit(1)

import sqlite3

db = r'C:\Users\alejandroe\.copilot\session-store.db'
conn = sqlite3.connect(db)

# All tables
tables = [t[0] for t in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print('Tables:', tables)
print()

# Schema for each table
for t in tables:
    cols = [(c[1], c[2]) for c in conn.execute(f'PRAGMA table_info({t})').fetchall()]
    print(f'{t}: {cols}')
print()

# Check if turns has timestamps
print('=== Recent turns (last 5 across all sessions) ===')
try:
    cols = [c[0] for c in conn.execute('SELECT * FROM turns LIMIT 0').description]
    print('turns columns:', cols)
    rows = conn.execute('SELECT * FROM turns ORDER BY rowid DESC LIMIT 3').fetchall()
    for r in rows:
        print(f'  {r}')
except Exception as e:
    print(f'turns error: {e}')

print()
print('=== Session-state files ===')
import os, glob
state_dir = os.path.expanduser('~/.copilot/session-state')
if os.path.exists(state_dir):
    sessions = os.listdir(state_dir)[:5]
    for s in sessions:
        sdir = os.path.join(state_dir, s)
        files = os.listdir(sdir) if os.path.isdir(sdir) else []
        print(f'  {s}: {files}')

print()
print('=== Recent session updated_at (to detect "active") ===')
rows = conn.execute('''
    SELECT id, summary, updated_at
    FROM sessions ORDER BY updated_at DESC LIMIT 8
''').fetchall()
for r in rows:
    sid = r[0][:8]
    summary = (r[1] or '')[:40]
    print(f'  {sid}  updated={r[2]}  {summary}')

# Check if there's a way to see "last activity" per session
print()
print('=== Turns timestamp check ===')
try:
    row = conn.execute('SELECT session_id, timestamp FROM turns ORDER BY rowid DESC LIMIT 1').fetchone()
    if row:
        print(f'  Last turn: session={row[0][:8]} timestamp={row[1]}')
except:
    # Maybe turns doesn't have timestamp
    cols = [c[0] for c in conn.execute('SELECT * FROM turns LIMIT 0').description]
    print(f'  turns columns: {cols}')

conn.close()

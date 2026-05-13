#!/usr/bin/env python3
"""
start-plan.py <sessionId>

Archive the current plan.md snapshot to plan-history/ when a new plan
begins. Called by the discipline-guardian extension when it detects
the [[PLAN]] prefix in a user prompt.

The DB-level plan rollover is handled by the maybe_rollover_plan trigger
based on activity-gap heuristic. This script's job is purely the prose
archival side.

Returns:
- exits 0 with the snapshot path on stdout if archival occurred
- exits 0 with no output if there was nothing to archive
- exits 1 on error
"""
import sys
import pathlib
import shutil
from datetime import datetime


def archive(session_id):
    home = pathlib.Path.home()
    session_dir = home / ".copilot" / "session-state" / session_id
    plan_md = session_dir / "plan.md"
    history_dir = session_dir / "plan-history"

    if not plan_md.exists():
        return None

    history_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    dest = history_dir / f"plan-{ts}.md"

    # Avoid duplicates if called multiple times in rapid succession
    if dest.exists():
        return str(dest)

    shutil.copy2(plan_md, dest)
    return str(dest)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: start-plan.py <sessionId>", file=sys.stderr)
        sys.exit(1)
    try:
        result = archive(sys.argv[1])
        if result:
            print(result)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

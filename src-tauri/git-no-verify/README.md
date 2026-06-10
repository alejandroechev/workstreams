# git-no-verify

A `git` shim that blocks `git ... --no-verify` invocations so AI agents
cannot silently bypass pre-commit / pre-push hooks. When `--no-verify` is
detected, the shim exits non-zero with a message addressed directly to the
agent asking it to consult the user before bypassing.

This crate is a **workspace member of the parent `workstreams` Tauri app**.
It is NOT installed system-wide. The compiled binary is bundled into the
Workstreams app resources (via `npm run build:shim`) and prepended to
PATH only for PTY sessions spawned by Workstreams. Other shells, IDEs,
and tools are unaffected.

## How it works

1. `npm run build:shim` (auto-chained from `predev` and `prebuild`)
   compiles this crate in release mode and copies the resulting binary
   to `src-tauri/resources/shim/git.exe`.
2. Tauri bundles the resources directory.
3. At PTY spawn time, Workstreams resolves `shim/git.exe` via
   `BaseDirectory::Resource`, takes its parent directory, and prepends
   it to `PATH` in the env map passed to the child process.
4. The spawned shell — and any process it spawns — finds the shim first
   when it resolves `git` through PATH.
5. The shim:
   - rejects `--no-verify` (unless `GIT_NOVERIFY_BYPASS=1` is set);
   - **scrubs its own directory from `PATH`** before spawning real git,
     so real git's internal sub-`git` calls find the system git directly
     and don't recurse into the shim;
   - sets a `GIT_NOVERIFY_SHIM_DEPTH=1` marker on the child env. If the
     shim ever sees that marker on entry, it bails out loudly rather
     than risking a fork bomb (recursion safety belt).

## Tests

```powershell
cargo test -p git-no-verify
```

Covers filter logic, full PATH-scrub behavior with a fake `git.exe`,
recursion-guard, the missing-real-git error path, and broad functional
coverage against the system `git` (init/status/add/commit/log/diff/
branch/checkout/clone/fetch/merge/rebase/stash/tag/remote/config/reset/
revert/cherry-pick/worktree/apply/...).

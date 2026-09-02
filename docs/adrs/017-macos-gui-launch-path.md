# ADR 017 — Repair the GUI-launch environment on macOS (`PATH`, `TERM`)

## Status

Accepted (2026-08-03).

## Context

ADR 016 shipped macOS support and fixed the *shell resolution* problem: which
program a terminal tile spawns. It did not address *where the OS looks* for
that program.

On macOS, an app started from the Dock, Finder, or Spotlight is launched by
**LaunchServices**, and inherits **launchd's** environment — not the user's
shell environment. Concretely, a Dock-launched `Workstreams.app` gets:

```text
PATH=/usr/bin:/bin:/usr/sbin:/sbin
```

`~/.zshrc`, `~/.zprofile` and `~/.profile` are never sourced, because no login
shell is involved. Every PTY the app spawns inherits that stunted `PATH`, so
user-installed tooling is invisible:

| Command | Typical real location | On the GUI `PATH`? |
| --- | --- | --- |
| `agency` | `~/.config/agency/CurrentVersion/agency` | ❌ |
| `copilot` | `~/.local/bin/copilot` | ❌ |
| `node` | `~/.nodenv/shims/node` (nodenv/nvm/fnm) | ❌ |
| Homebrew binaries | `/opt/homebrew/bin` | ❌ |

The default `copilotCommand` is `agency copilot --yolo` (see
`src/domain/app-settings.ts`), so **every** Copilot session tile failed to
exec. The failure is silent from the user's point of view: `spawn_command`
returns an error, the PTY emits zero bytes, and the tile renders an empty
xterm. Because `config.copilot_session_id` is still set, `hasLinkedSession` is
true and the tile shows a green **"🔗 Linked"** badge over a blank terminal —
it looks like a *restore* bug rather than a spawn failure.

This was reported as "sessions work when I create them, but are blank after I
close and reopen the app". That framing was a coincidence of *how* the app was
launched, not of resume: the first launch had come from a terminal (`open`
from a shell forwards the caller's environment), which produced a working
`PATH`; the reopen came from the Dock, which did not.

Windows is unaffected — GUI processes there inherit the user/system `PATH` from
the registry, which is why the bug never appeared on the original platform.

## Decision

**Detect a GUI launch and repair `PATH` by asking the user's login shell**,
once per process, on Unix only.

A new `src-tauri/src/shell_env.rs` module owns the policy:

| Function | Responsibility |
| --- | --- |
| `looks_like_gui_launch_path` | True when `PATH` contains *only* the four launchd defaults (or is unset). |
| `probe_login_shell_path` | Runs `<shell> -lic 'printf %s "$PATH"'`. |
| `parse_login_path_output` | Takes the last non-empty line; rejects output with no absolute entry. |
| `merge_paths` | Login entries first, inherited entries appended, de-duplicated, empty segments dropped. |
| `resolve_for` | The whole decision, with the inherited `PATH` injected as a parameter. |
| `resolved_path` | `resolve_for` over the real environment, cached in a `OnceLock`. |

Key choices:

- **Probe only on a GUI launch.** When the app is started from a terminal the
  inherited `PATH` is already correct, so we skip the ~100 ms shell spawn *and*
  avoid reordering a `PATH` the user deliberately set. `resolve_for` returns
  `None` in that case and callers leave the environment untouched.
- **`-l` *and* `-i`.** Login mode sources `~/.zprofile`; interactive mode
  sources `~/.zshrc`, which is where most users (and `nodenv`/`rbenv`/conda
  initialisers) actually edit `PATH`. Using only one of the two misses roughly
  half of real setups.
- **`printf %s` rather than `echo`.** No trailing newline to strip.
- **`stdin`/`stderr` redirected to `/dev/null`.** An interactive shell that
  inherits a controlling terminal performs job-control operations on it and can
  raise `SIGTTOU`/`SIGTTIN` in the process group.
- **Fail soft everywhere.** A missing shell, a non-zero exit, or unparseable
  output all yield `None`, which preserves today's behaviour rather than
  substituting a broken `PATH`. A profile that prints a banner is tolerated;
  a profile that prints nothing PATH-shaped is rejected.
- **Caller `env` wins.** `pty::spawn_env_overrides` layers the workstream vars
  on top of the repaired `PATH`, so an explicit `PATH` from a caller is never
  clobbered.

Injection happens at every process boundary that resolves user-installed
commands:

- `PtyManager::spawn` for terminal and Copilot session tiles;
- loop deterministic verifiers;
- code-trace test discovery and recording.

The loop-verifier path matters because a definition commonly uses a bare
program such as `npm` or `cargo`. Without the repaired environment, a worker
could complete successfully and then receive a misleading verifier
`spawn_error: No such file or directory` solely because Workstreams was
launched from the Dock.

Windows keeps a `#[cfg(windows)]` `resolved_path` that always returns `None`,
making the change a literal no-op there.

### `TERM` is missing too

`PATH` is not the only variable launchd fails to provide. A GUI-launched app
also has **no `TERM`**, and a shell started under it reports `TERM=dumb`.

`zsh` treats a dumb terminal as incapable of line editing: it disables ZLE
entirely, the tty stays in canonical mode, and the kernel echoes an erase as a
plain space. The visible result is that **Backspace appears to insert spaces**
instead of deleting — the edit actually happens in the input buffer, but the
screen never reflects it, so the line looks corrupted.

Measured on a GUI-equivalent environment, typing `echo abc`, two `DEL` (`0x7f`)
and `ZZ`:

| `TERM` | Echoed erase | Rendered line |
| --- | --- | --- |
| unset / `dumb` | *(spaces)* | `echo abc  ZZ` ❌ |
| `xterm-256color` | `\x08 \x08` | `echo aZZ` ✅ |

`spawn_env_overrides` therefore also sets `TERM=xterm-256color` when the
inherited value is missing, empty, `dumb`, or `unknown`. xterm.js implements
the xterm protocol with 256-colour support, so this is an accurate description
of the emulator on the other end of the PTY rather than a guess. An inherited
`TERM` from a real terminal launch is preserved, and a caller-supplied `TERM`
still wins. Windows uses neither termcap nor terminfo and ConPTY already
reports a capable terminal, so the repair is `cfg(unix)`-only.

## Consequences

- Copilot session tiles work when the app is launched from the Dock, Finder,
  Spotlight, or as a login item — the normal way a desktop app is started.
  Backspace and other line editing work in terminal tiles for the same reason.
- One extra process spawn (~100 ms) on GUI launches only, paid once per app
  process and cached in a `OnceLock`.
- The repaired `PATH` is a *snapshot*. Editing `~/.zshrc` requires restarting
  the app for spawned tiles to see the change; this matches VS Code.
- A user whose shell profile is slow (heavy `nvm`/conda init) pays that cost
  once at first spawn. If this becomes a problem the probe can move to app
  startup in a background thread.
- The heuristic is deliberately conservative: a user who has genuinely reduced
  their `PATH` to exactly the four launchd defaults in a terminal will trigger
  a probe. The merge keeps their entries, so the outcome is still correct.
- Not addressed: other launchd-inherited environment gaps (e.g. `LANG`,
  proxy variables). Only `PATH` and `TERM` were causing observable failures.

## Notes

While validating, a pre-existing race in the `code_review::git` test helper
surfaced: `temp_repo()` named its directory from `pid` + `SystemTime` nanos,
but macOS clocks only have microsecond granularity, so two tests running
concurrently could share a directory and race inside `git init` ("cannot copy
template hook: File exists"). The helper now uses a process-wide
`AtomicUsize`, which is collision-proof regardless of clock resolution.

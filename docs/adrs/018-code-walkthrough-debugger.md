# ADR 018 — Code walkthrough: recorded execution traces for reading code

## Status

Accepted (2026-08-10).

## Context

Reviewing code — especially code an agent wrote — means reconstructing *what
actually runs* from static text. Reading a file top to bottom tells you what
exists, not which branch executed, in what order, or how a test reaches its
assertion.

Repo Explorer is a competent reader but has no notion of execution order. The
request was for a step-through that gives **debug order** without giving up
**free order**: the ability to wander off mid-walkthrough, read anything, and
jump back.

The framing that shaped everything: this is a tool for **understanding** code,
explicitly *not* for finding bugs. That rules out most of what a debugger is
for and makes a much smaller thing viable.

Design was settled in a two-round grill (see the session's
`features/code-walkthrough-debugger/grill-me.md`). Three answers cut the
feature roughly in half — no variable values, no agent curation, no annotation
layer — leaving v1 as *an ordered list of code locations*, which is what the
original request actually asked for.

## Decision

**Record once with a CLI, replay many times in the app.**

| Half | Runs where | Depends on |
| --- | --- | --- |
| **Recorder** | CLI (`scripts/trace-record.mjs`) **and** in-app (`src-tauri/src/trace_record.rs`) | `lldb-dap`, cargo |
| **Replayer** (controller tile + `scripts/trace-replay.mjs`) | In-app and CLI | nothing but the JSON file |

### Why the recorder exists twice

The CLI came first and remains the reference implementation and the scriptable
entry point. Recording *from the UI* could not reuse it: a bundled `.app` ships
neither the repo's `scripts/` folder nor a guaranteed `node`, and a Dock launch
has neither on `PATH` — so shelling out would only have worked when the open
workstream happened to be this repo.

The Rust port therefore drives DAP directly. Both share the same proven
protocol (cargo `--message-format=json` for binary discovery,
`setFunctionBreakpoints`, step-in/step-out on the repo boundary,
consecutive-duplicate collapsing) and write the same versioned format, so a
trace from either is interchangeable. The duplication is deliberate and
bounded; the alternative was shipping Node inside the bundle.

The in-app recorder runs on a blocking thread and emits `trace-record-progress`
events: a recording drives a debugger step by step and takes seconds to
minutes, so a silent button would read as a hang.

The split is the load-bearing decision. It keeps the OS-dependent half — which
must spawn a debugger — out of a sandboxed, unsigned Tauri app; it makes replay
portable to Windows *before* a Windows recorder exists; and it satisfies the
AGENTS.md CLI-parity rule by construction rather than as an afterthought.

It was originally motivated by a hard blocker: a spike showed raw `lldb` could
not pause a process under macOS hardened runtime (`attach failed … could not
pause execution`). Driving `lldb-dap` turned out not to hit that restriction,
so the split is no longer *forced* — but portability and testability justify it
on their own.

### Recording

- **Entry point** is a single `#[test]`, run `--exact <name> --test-threads=1`
  so the step order is deterministic and neighbouring tests cannot interleave.
- **Binary discovery** uses `cargo test --no-run --message-format=json`, which
  reports the executable path directly — nothing has to guess cargo's hash
  suffix.
- **`setFunctionBreakpoints`** on the test name, rather than a file:line
  breakpoint, so the recorder need not know where the test body starts.
- **Stepping rule:** step *into* everything, but step *out* immediately when
  the frame's file is outside the repo root. Std/core internals never enter the
  trace, while the fact that a call happened is preserved. A 27-step trace of
  one small test required 30+ step-outs; without this the trace is thousands of
  frames of formatting machinery.
- **Step cap** sets `truncated: true` rather than cutting silently — a capped
  trace must never look like execution that simply ended.

`supportsStepInTargetsRequest` is false on `lldb-dap`, so the alternative rule
("step over unless the callee is ours") is not implementable: we cannot ask
what a line is about to call.

### Consecutive duplicates collapse into `hits`

A raw trace repeats the same line many times. A line like
`Some(s) if s.trim().starts_with('/')` makes several std calls, and stepping
out of each lands back on that line — eight identical entries in a row.

Those are **debugger mechanics, not execution history**, so consecutive
identical locations collapse into a `hits` count. Only *consecutive* ones:
`52 → 53 → 52` is a real loop iteration and survives, because control returns
via a different line first.

### Storage

- **The JSON file is the source of truth.** Portable, hand-inspectable, and
  writable by a CLI that has no business knowing about the app's database.
- **SQLite holds only an index** (`code_traces`), so the picker is fast without
  parsing every file. `index_code_trace` derives its fields *from the file*
  rather than trusting the caller, so the index cannot drift from what it
  points at.
- **Scoped listing includes unscoped traces.** The recorder has no workstream
  context and writes `workstream_id = NULL`; filtering strictly by workstream
  made every CLI-recorded trace invisible. (Found by the E2E test.)
- **Versioned** (`"version": 1`). A `vars` field is *absent* rather than
  emitted empty: writing `{}` on thousands of steps would bloat every file for
  a feature that does not exist yet, and "missing" already means "not
  captured".

### Staleness: warn, never remap

A trace is keyed by commit SHA. When HEAD has moved — or the tree is merely
dirty, which shifts line numbers just as effectively — the UI shows a banner
and offers a re-record. Replay is **never blocked**.

Line remapping through `git diff` was rejected outright: silently pointing at
the wrong line is worse than an honest warning. Equally, a trace whose commit
is `unknown` (git unavailable at record time) is never called stale — warning
on no evidence trains the user to ignore the banner.

Comparison is by prefix, because a trace may hold a short sha while
`git rev-parse HEAD` returns the full one.

### UI: the controller owns no editor

The walkthrough tile is a *controller*. It fires a navigation event at a bound
Repo Explorer, which opens the file and highlights the line.

Owning an editor would have made "debug order" and "free order" mutually
exclusive — the exact thing the feature exists to avoid. Instead the explorer
stays an ordinary editor: wander anywhere, then press **Resync**.

- **Binding is explicit and sticky**, auto-binding silently when only one
  explorer is open. Focus-based binding was rejected: the step target would
  move as the user clicked around, fighting the wander-freely behaviour.
- Events carry the target tile id, so with several explorers open the others
  stay exactly where the user left them.
- `highlightLine` is deliberately separate from `initialRevealLine`: reveal is
  a one-shot scroll, while the highlight *persists* as the user scrolls away.
  That persistence is what makes coming back work.

### Stepping backwards is a feature

In a replay model, "back" is an array index. A live debugger cannot do it
without record/replay support. It is kept in v1 as a genuine advantage rather
than treated as an accident.

## Consequences

- Ships behind the `debug-walkthrough` feature flag, disabled by default, like
  `plan-tile`.
- **macOS-only recording** for now; replay is platform-neutral, so a
  Windows recorder is an additive follow-up rather than a rewrite. Traces
  resolve step paths using the separator of the *recorded* `repoRoot`, not the
  host's — otherwise a macOS trace opened on Windows yields `C:\repo/src/a.rs`.
- Recording is slow (one DAP round-trip per step) and deliberate; it is a CLI
  action, never something the UI does implicitly.
- The in-memory backend holds traces behind a `_seedTraceFile` seam, so E2E and
  offline development need neither a debugger nor real recorded files.
- **Explicitly out of v1:** UI-set breakpoints, conditional breakpoints, watch
  expressions, call-graph views, multi-threaded traces, async/await stepping,
  value editing, run-to-cursor, agent annotations, and variable values.
  Deferred in order: Windows recorder → values → annotations →
  right-click-to-record.
- The versioned schema is the pressure valve against scope creep toward a real
  debugger: saying no now costs nothing later.

## Validation

The gate before any UI was built was a timeboxed spike, and it passed
decisively. Tracing `default_shell_prefers_the_shell_env_var_on_unix`
reproduced the control flow exactly:

| Input | Path through `resolve_unix_shell` | Meaning |
| --- | --- | --- |
| `None` | 153 → **155** | guard skipped — `None` cannot match `Some(s)` |
| `Some("   ")` | 153 → **154** → **155** | guard evaluated, failed, fell through |

That 154-vs-155 discrimination is the value proposition in one line: the trace
records **which branch actually executed**, which no static tour can know.
Nested loops in `merge_paths` came out in real iteration order, including
`continue` on empty segments.

Coverage of the three testing tiers:

| Tier | Status |
| --- | --- |
| Vitest unit/component | ✅ domain, both backends, the tile, and the CLIs |
| Playwright on dev server | ✅ `e2e/tests/code-walkthrough.spec.ts` |
| CDP on the Tauri desktop app | ⛔ **not possible on macOS** |

### CDP validation is Windows-only

ADR 003's CDP tier depends on `additionalBrowserArgs:
"--remote-debugging-port=9223"`, which is a **WebView2** feature. macOS Tauri
uses **WKWebView**, which exposes only the Safari Web Inspector and speaks no
Chrome DevTools Protocol; the option is silently a no-op there. Confirmed
empirically — `cargo tauri dev` starts and the window appears, but nothing ever
listens on the CDP port.

This is a property of the platform, not of this feature: **no** feature can be
CDP-validated from macOS. It is recorded here because ADR 003 and ADR 016 do
not mention it, and the omission cost a full dev build to rediscover. The
probe at `e2e/features/code-walkthrough.mjs` is written and ready to run from
Windows.

### Acceptance run — ✅ passed

The agreed go/no-go was: record a trace of a test you have never read, and
explain it using *only* the walkthrough.

Target: `repo_create::tests::emits_progress_phases_in_order` (157 recorded
locations). Reading only `trace-replay --list`, the test reconstructs as:

1. `git_available()` guard, via a `git_command` helper
2. `temp_parent(...)` — with a visible retry/uniqueness loop (361 → 364 → 361)
3. `base_opts(...)`
4. a constructor at `:142`
5. `validate_repo_name` walking a character-validation loop (170–193)
6. `create_git_repo_with_progress`, with **a closure at 458–459 firing
   repeatedly, interleaved with the function body**

Checked against the source afterwards, that is correct — including the part
that matters. The interleaved closure *is* the progress callback the test
passes in to collect phases, and its ordering relative to the function body is
exactly what the test asserts. A static read of the file shows a closure is
passed; only the trace shows *when it actually ran*.

That is the feature justifying itself: the understanding came from execution
order, not from the text.

If a future change makes walking a trace slower than simply reading the file,
delete the feature rather than expand it.

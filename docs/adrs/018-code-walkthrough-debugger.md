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

### The test picker is filtered and grouped

Listing every test flat made recording impractical — this crate reports 261 —
so the picker has a filter box and groups options by module. Rust test names
are already hierarchical (`code_review::git::tests::resolve_base_ref`), so the
module path is a natural scope and cargo needs to supply nothing extra. In
practice 261 tests become 14 groups; `shell_env` narrows to 13 and `pty shell`
to 3.

The filter matches each whitespace-separated term against the full path in any
order, so a module and a name can be combined without recalling the exact path.
Filtering away a selected test clears the selection, so Record cannot run
something the user can no longer see.

The selected Cargo package is also carried into **recording**, not only test
discovery. Both phases build with `cargo test -p <package> --no-run`; otherwise
a successful package-scoped discovery can be followed by a whole-workspace
recording failure in an unrelated crate. This surfaced in the Waimea workspace:
`microsoft_ic3_waimea_media_store` built successfully, while an unrelated
`edge_security_tests` protobuf build failed. Recorder build errors retain the
first actionable Cargo error and its `Caused by` context instead of displaying
only Cargo's final `waiting for other jobs to finish` warning.

Tokio async tests remain a trace-quality limitation. Validation against
`streams::tests::read_blocks_skip_block_on_decode_error` records and completes,
but lldb-dap steps mostly through the generated async wrapper/poll boundary and
produces only five source locations. Package scoping is fixed; following an
async future across executor polls is separate future work.

### Test discovery is explicit and backgrounded (2026-08-12)

The first implementation ran test discovery as soon as the tile mounted. That
was acceptable in this repo and pathological in a large Rust workspace:
`cargo test --no-run --message-format=json` can compile hundreds of crates,
and because the Tauri command was synchronous it occupied the IPC handler long
enough for the whole UI to look frozen. On Windows both Cargo and the produced
test binary also opened visible console windows.

Discovery is now a separate **Tests** row with:

- optional **Cargo package** — maps to `-p <package>` and is the meaningful
  performance filter because only that package's test targets are built;
- optional **test-name filter** — passed to each libtest binary after `--list`;
  this reduces returned names but cannot avoid compilation, and the tooltip
  says so;
- an explicit **Load** button — opening the tile never runs Cargo.

The Tauri command is `async` and delegates the blocking build/list work to
`spawn_blocking`, so React and the IPC loop remain responsive. The tile shows a
loading state, disables only discovery controls, and ignores a late result
after unmount or workstream change.

Cargo may report several test executables (workspace packages, integration
tests, binary targets). Discovery now lists every distinct executable and
deduplicates the combined names instead of silently selecting the first/lib
binary.

On Windows every discovery child uses `CREATE_NO_WINDOW`, including Cargo and
the generated test executables, so explicit loading does not flash terminals.

CLI parity is `scripts/trace-tests.mjs`:

```text
node scripts/trace-tests.mjs \
  --manifest-dir <repo-or-crate> \
  --package <cargo-package> \
  --filter <test-name-substring>
```

### Controls: three rows, and bare-key stepping

The toolbar is split into **Trace** (which recording is open), **Record** (test
picker + record), and **Step** (prev/progress/next/resync). A single row pushed
the stepping buttons off the right edge as soon as a trace name was long, which
is the common case — test paths are verbose.

Stepping also works from the keyboard while the tile has focus: `↑↓`/`←→`,
`j`/`k`, `n`/`p`, space, `Home`/`End`, and `r` to resync. Bare keys are safe
because every app-level command uses `Alt+`, but the handler ignores anything
held with a modifier — `Alt+Arrows` moves focus between tiles and `Cmd+R`
reloads — and ignores keys typed into a `select` or `button`, so a `j` pressed
to jump inside the trace dropdown does not also advance the walkthrough.

### Timestamps are ISO-8601, not epoch

The app's global `now()` returns epoch seconds, but the trace format is shared
with the Node CLI, which writes `toISOString()`. Using `now()` in the Rust
recorder rendered as `recorded 1786466376` and, less visibly, broke ordering:
the index sorts traces by that string, so Rust- and CLI-recorded traces
interleaved incorrectly. The recorder now formats ISO-8601 itself rather than
taking on a date dependency for one call.

### Step out, and why the trace records call depth

"I understand this function, take me back to the call site" is a core reading
motion, so the tile has a **step out** (`o`) that jumps to where control
returns to the *caller* — skipping the remainder of the current call and any
deeper calls it makes, not merely advancing one step.

A flat list of locations cannot express that on its own, so each step now
carries the debugger's **call depth** and step-out finds the next shallower
frame. The obvious alternative — "return to the next step whose function name
differs" — breaks under recursion, where the caller shares the callee's name
and the rule lands on an outer frame. `depth` is optional, so traces recorded
before this still work via that name heuristic rather than showing a dead
button; the caveat only applies to them.

Capturing depth required asking DAP for the whole stack (`levels: 0`). With
`levels: 1` lldb-dap reports a `totalFrames` that is a stale constant — 21
regardless of actual depth — which would have produced a plausible-looking but
entirely wrong step-out. Measured cost of the change: a 24-step recording went
from ~9.1s to ~9.8s.

Depths are **absolute**, not normalised: a Rust test sits ~22 frames inside the
libtest harness, so they start in the twenties. Only comparisons between steps
are meaningful.

### Stepping backwards is a feature

In a replay model, "back" is an array index. A live debugger cannot do it
without record/replay support. It is kept in v1 as a genuine advantage rather
than treated as an accident.

## Windows recording (2026-08-12)

Recording works on Windows **from the CLI**. The split held up: replay needed no
changes at all, and the recorder needed no rewrite — only a second adapter
dialect.

### CodeLLDB, because of the PDB reader

An MSVC-toolchain Rust build emits **PDB**, not DWARF, and Windows ships no
system LLDB. CodeLLDB's `codelldb.exe` bundles its own LLDB *and*
`msdia140.dll` — the MS Debug Interface Access library — so it can read those
PDBs. `lldb-dap.exe` (from an LLVM install) is still preferred when present, and
`WORKSTREAMS_DAP_ADAPTER` overrides the search.

Discovery order: `WORKSTREAMS_DAP_ADAPTER` → `where lldb-dap.exe` → LLVM install
dirs → CodeLLDB under `.vscode`/`.vscode-insiders`/`.vscode-server`.

### Four dialect differences, none of which error

Each of these produced a *silent* wrong result rather than a failure, which is
why they are recorded here rather than left to be rediscovered:

| Difference | Symptom |
| --- | --- |
| `levels: 0` on `stackTrace` | The spec says "all frames" and lldb-dap obeys; codelldb returns **zero** frames. The recorder saw an empty stack every step and wrote an empty trace. |
| Function breakpoints | Neither `setFunctionBreakpoints` nor `breakpoint set --name` resolves a Rust symbol from a PDB ("Resolved locations: 0"), though `image lookup -r` finds it. Only a **regex** breakpoint binds. |
| `terminal` | Unset, codelldb defaults to an integrated terminal and answers `launch` with a `runInTerminal` **reverse request**; a client that ignores it gets a bare "unknown error". `terminal: "console"` avoids it. |
| Breakpoint timing | codelldb rejects breakpoints set before the `initialized` event; lldb-dap tolerates them. |

The regex is anchored (`…$`) so it does not also match the `::{{closure}}` twin
that shares the prefix and would stop one frame short of the test body.

Both options are sent **only** to codelldb, so the proven macOS request stream
is unchanged.

### Windows path and symbol handling

- **Case-insensitive, separator-agnostic path comparison.** The debugger reports
  whatever case the PDB recorded, which need not match the workstream directory
  the user typed. A byte-wise compare classified every frame as "not ours" and
  produced an empty trace, again with no error.
- **MSVC decoration is stripped.** PDB frames read
  `struct ref$<str$> traceprobe::classify(int)` rather than a Rust path, so the
  return type and parameter list are removed, leaving `traceprobe::classify`.

### In-app recording is NOT yet working on Windows

The Rust recorder reaches the breakpoint and then stalls: after
`configurationDone` the debuggee is never resumed, so no `stopped` event
arrives. The DAP conversation was compared message-by-message against the Node
CLI driving the same adapter to the same test — they are **identical** up to the
stall — and the following were each ruled out: stdio mode (`null`/`piped`/
`inherit`), console allocation (`CREATE_NO_WINDOW`, `CREATE_NEW_CONSOLE`, a real
console), `stopOnEntry` with a post-entry breakpoint, `--nocapture`, request
timing, and the timeout itself. Cause unknown; the CLI is the supported Windows
path until it is found.

Two fixes made while chasing it are keepers on every platform:

- **The DAP reader now pumps continuously on its own thread.** It previously
  read only while a request was outstanding, so the adapter's stdout pipe could
  fill and block *its* writes — a deadlock in which neither side progressed.
- **Requests now time out** (30s) instead of blocking forever, so a stalled
  adapter reports "the debug adapter stopped responding" rather than hanging the
  recording thread with no diagnosis.

### Validating on Windows needs a clean crate

This repo's own test binary cannot start on the development machine at all —
`cargo test --lib` exits with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139), which
reproduces on a clean checkout and is unrelated to this feature. LLDB therefore
cannot launch it either. Validation used a throwaway crate with no Tauri
dependencies; the pure logic was exercised against the *real* module source by
compiling it into a scratch crate with `#[path]`.

## Consequences

- Ships behind the `debug-walkthrough` feature flag, disabled by default, like
  `plan-tile`.
- **Recording: macOS (in-app + CLI), Windows (CLI only).** Replay is
  platform-neutral everywhere. Traces resolve step paths using the separator of
  the *recorded* `repoRoot`, not the host's — otherwise a macOS trace opened on
  Windows yields `C:\repo/src/a.rs`.
- Windows recording requires CodeLLDB (or an LLVM `lldb-dap.exe`) to be
  installed; it is not bundled.
- Recording is slow (one DAP round-trip per step) and deliberate; it is a CLI
  action, never something the UI does implicitly.
- The in-memory backend holds traces behind a `_seedTraceFile` seam, so E2E and
  offline development need neither a debugger nor real recorded files.
- **Explicitly out of v1:** UI-set breakpoints, conditional breakpoints, watch
  expressions, call-graph views, multi-threaded traces, async/await stepping,
  value editing, run-to-cursor, agent annotations, and variable values.
  Deferred in order: in-app Windows recording → values → annotations →
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

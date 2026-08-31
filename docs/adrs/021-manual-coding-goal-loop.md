# ADR 021: Manual coding goal loop

## Status

Accepted (2026-08-28).

## Context

Workstreams embeds interactive Copilot CLI sessions and observes their output,
but the human still owns the outer workflow: decide what to do, prompt the
agent, inspect whether it succeeded, feed failures back, and stop runaway work.
That does not support a durable autonomous workstream.

Research and a three-round grill rejected two tempting designs:

- one immortal Copilot conversation or a shell busy-loop, because process
  lifetime is not durable workflow state; and
- provider-specific loop implementations, because an agent can already use its
  tools to discover PRs, issues, repository state, and other work.

The long-term shape is a generic scheduled loop. MVP1 deliberately proves the
harder execution and verification boundaries with a manual trigger before
adding recurring schedules.

## Decision

### A loop is a workstream capability

A normal workstream may own one `LoopSpec`. `workstream_type` continues to
describe repository provisioning (`standalone`, `base_repo`, `worktree`, or
`import_worktree`); it is not overloaded with runtime behavior. The loop uses
the workstream's existing directory/worktree.

MVP1 is a manually triggered coding goal loop:

```text
Run now
  -> orchestrator agent
  -> zero or more structured tasks
  -> one worker episode per task
  -> optional deterministic verifier
  -> fresh evaluator agent
  -> at most one worker revision
  -> completed or attention
```

The pipeline shape is fixed, while its three role prompts, models, verifier,
wall-time budget, and concrete tool use are configured per loop. There is no
provider adapter or provider-specific database column.

### The Tauri backend owns execution

The Rust backend uses the GA `github-copilot-sdk` Rust crate. Its default
`bundled-cli` feature embeds a compatible Copilot CLI and manages
`copilot --server --stdio` over JSON-RPC, so the desktop release does not
depend on Node or on an arbitrary CLI version found on `PATH`.

`LoopAgentRuntime` isolates the controller from the SDK:

- `SdkAgentRuntime` is the production implementation;
- `ScriptedAgentRuntime` provides deterministic offline tests and the CLI
  scenario;
- sessions stream typed events rather than terminal text;
- worker sessions are retained only when one evaluator-requested revision may
  need to resume them;
- abort, disconnect, and SDK shutdown are explicit.

The app remains the process owner. Loops run only while Workstreams is open in
MVP1. A background daemon or cloud runner is not implied.

### SQLite is authoritative

The agent conversation is an execution artifact, not workflow truth.
`workstreams.db` persists:

- `loop_specs` — one configuration per workstream;
- `loop_runs` — one manual invocation and its wall-clock deadline/control
  request;
- `loop_tasks` — immutable orchestrator task keys and stage/revision state;
- `loop_verifications` — command, hash, bounded output, exit/timeout result;
- `loop_evaluations` — fresh-agent verdict and feedback;
- `loop_events` — append-only SDK and controller evidence.

Only an explicit allowlist of final message, turn, tool lifecycle, session,
failure, abort, and lag events is persisted. Token deltas, partial tool results,
and progress chunks are presentation traffic, not one row per chunk. Every
event payload is capped at 16 KiB; the control tile loads the newest 500 events
in chronological order. Verifier stdout/stderr lives only in
`loop_verifications`; its event carries the verification row id and status
rather than duplicating up to 512 KiB.

While active, the tile updates elapsed time locally and polls a lightweight
version made from run/task states, verification/evaluation counts, and the
latest retained event id. It reloads the full bounded snapshot only when that
version changes.

An accepted or in-flight `(loop_spec_id, task_key)` is not enqueued again.
Restart reconciliation marks nonterminal work interrupted/attention rather than
silently rerunning it.

### Agent contracts are structured

The orchestrator must return:

```json
{
  "tasks": [
    {
      "key": "stable-source-identity",
      "title": "short title",
      "objective": "complete coding objective"
    }
  ]
}
```

`tasks: []` is successful "no work." Missing/blank required fields or malformed
JSON fail visibly; Workstreams never guesses tasks from prose.

Workers and evaluators likewise return bounded JSON result/verdict contracts.
The evaluator is a fresh Copilot session. `revise` returns actionable feedback
to the retained worker session once; a second rejection requires human
attention.

### Deterministic checks precede semantic judgment

A loop may configure a verifier as a program plus argument array and working
directory. Arguments are not shell-split by the backend. Configuration is
editable only while the LoopSpec is disabled.

Workstreams runs the verifier off the UI thread in a dedicated process group,
with the remaining run deadline as timeout. It drains but caps stdout/stderr,
records exit status/duration/truncation, hashes a directly referenced program
file, kills the process group on timeout, and waits for termination. A spawn
error, timeout, or non-zero exit cannot be overridden by the evaluator.

The verifier is optional because not every semantic task has a meaningful
executable predicate. A workstream's ordinary Copilot session may help author
one before the LoopSpec is enabled.

### Controls have different guarantees

- **Pause** requests a stop at the next persisted task boundary and preserves
  queued tasks for Resume.
- **Stop** finishes the current boundary, blocks work not yet started, and
  ends the run in attention when unfinished tasks remain. Stopping an already
  paused run is applied synchronously because no executor exists to consume a
  deferred request.
- **Kill** aborts active SDK sessions immediately, marks the active task
  interrupted, preserves the worktree for inspection, and ends the run.

Resume atomically moves `paused` to a dedicated `resuming` state before
starting a new SDK runtime. This state is separate from the user-controlled
pause/stop/kill request, so a control during SDK startup cannot turn a resume
into a fresh orchestration pass.

The pre-existing PTY lifecycle was fixed as a prerequisite: every
`portable_pty::Child` is transferred to a dedicated waiter, natural exits are
collected, and explicit close kills then joins the waiter. A generation token
prevents an old process exit from removing a replacement tile's handle.
App exit also cancels every registered SDK session and verifier process group
before closing PTYs.

### UI and CLI are peers

The `loop_control` tile configures and enables the loop, starts Run now, and
projects backend state: stage, task, elapsed/deadline, streamed events, worker
result, verifier output, evaluator feedback, and errors. It exposes separate
Pause, Resume, Stop, and Kill actions. Closing the tile does not own or erase
the run.

The workstream sidebar shows per-workstream running/attention state and the
number of running loops. MVP1 intentionally has one active episode per
workstream and no global concurrency cap.

The existing `workstreams` executable exposes `workstreams loop configure`,
`enable`, `run`, `status`, and `control` subcommands. Its deterministic
`scenario` runs the same controller with the scripted runtime and a real
verifier. Keeping one Cargo binary avoids ambiguity for `cargo tauri dev`.

## Permissions

The grill selected full Copilot tool access for MVP1. This does not imply
permission to impersonate the user publicly: posting comments, pushing, or
other public/destructive effects remain separately authorized outside the
generic loop contract.

## Consequences

### Positive

- The runtime is generic across coding tasks without provider scaffolding.
- Deterministic evidence and independent evaluation are first-class rather than
  prompt conventions.
- Every stage is persisted, inspectable, bounded, resumable where safe, and
  explicitly interruptible.
- The Rust SDK avoids a Node sidecar and bundles a protocol-compatible CLI.
- In-memory parity keeps unit, browser E2E, CLI, and offline development
  independent of credentials.

### Negative and accepted risks

- Bundling Copilot CLI increases the Rust binary and build time.
- Full agent tool access is broad; this is an explicit MVP1 choice.
- No global cap allows several workstreams to consume resources concurrently;
  the sidebar count makes that visible.
- Pause occurs at a task boundary, not in the middle of a tool call.
- Exact deduplication depends on the orchestrator supplying a stable key.

## Out of scope

- recurring interval/cron schedules;
- provider webhooks and integration adapters;
- background daemon or cloud runner;
- arbitrary DAG/workflow editor;
- multiple worker roles or recursive task spawning;
- security-testing-specific policy;
- automatic public review/comment publication;
- configurable retention.

## Validation

- Rust unit tests cover SDK/runtime seams, schema, deduplication, controller
  stages, verifier exit/timeout/output behavior, evaluator revision,
  pause/stop/resume, blocked outcomes, restart reconciliation, and PTY child
  collection.
- An ignored authenticated SDK smoke creates, streams, revises, aborts,
  disconnects, and shuts down a real bundled-CLI session.
- Vitest covers the pure state machine, wire mapping, both backends, Loop
  Control tile, sidebar projection, and App compatibility.
- `workstreams loop scenario` exercises task discovery, a real verifier,
  evaluator acceptance, and second-run deduplication.
- Playwright covers configure/enable/run/pause/resume/verify/evaluate and Kill.
- `e2e/features/manual-coding-loop.mjs` is the real-Tauri CDP probe. It can only
  run on Windows because macOS WKWebView does not expose CDP (ADR 003/018).

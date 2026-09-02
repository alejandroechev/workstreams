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
  -> zero or more structured tasks in a batch
  -> one worker episode per task
  -> optional deterministic verifier
  -> optional fresh evaluator agent
  -> optional human approval
  -> bounded worker revisions
  -> orchestrate the next batch
  -> repeat until orchestration returns no work
  -> completed or attention
```

The pipeline shape is fixed, while its three role prompts, models, verifier,
wall-time budget, total worker-attempt budget, and concrete tool use are
configured per loop. `taskAttempts` counts the initial worker episode, so `1`
disables revisions and `N` permits at most `N - 1` evaluator- or
human-requested revisions. There is no provider adapter or provider-specific
database column.

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
- worker sessions are retained while evaluator-requested revisions may need to
  resume them;
- abort, disconnect, and SDK shutdown are explicit.

Starting the bundled CLI includes a narrow recovery policy. The SDK classifies
`request cancelled` and I/O failures as broken transports that require a fresh
client, so Workstreams makes up to three startup attempts with
short backoff. Authentication, configuration, binary resolution, and protocol
version errors are not retried.

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
- `loop_approvals` — pending and decided human approval requests;
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
Accepted keys are also included in the next orchestrator prompt, so an
integration agent can deliberately skip completed source identities while
still retrying an artifact left by a failed worker/evaluator episode.
After every accepted batch the controller invokes a fresh orchestrator again.
The run reaches `completed` only when that pass returns `tasks: []`; accepting
the current batch is progress, not goal completion. Returning only occupied
keys is an error rather than an empty-success shortcut, preventing accidental
completion and tight deduplication loops.
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

Copilot may occasionally add a short explanation around an otherwise valid
response or wrap it in a Markdown `json` fence despite the prompt. The boundary
accepts raw JSON or exactly one matching typed JSON object embedded in the
response. Multiple matching objects, malformed JSON, or invalid fields still
fail visibly; the parser never chooses among competing objects.

Workers and evaluators likewise return bounded JSON result/verdict contracts.
The evaluator is a fresh Copilot session. `revise` returns actionable feedback
to the retained worker session until the configured total task-attempt budget
is exhausted; another rejection then requires human attention.

Nested `task` delegation from an SDK-created evaluator may be unavailable even
when the interactive parent CLI supports it. If the evaluator's sub-agent tool
returns CAPI 400 "resource not found", Workstreams records
`evaluator.subagent_fallback` and retries once in a fresh evaluator session
with delegation disabled. The evaluator performs the requested review
perspectives sequentially itself; unrelated CAPI failures are not retried.

ADR 023 adds a final human approval sensor. Human-requested revision starts a
fresh worker episode from persisted task context and feedback, so approval
remains restart-safe and does not depend on an in-memory SDK session.

### Deterministic checks precede semantic judgment

A loop may configure a verifier as a program plus argument array and working
directory. Arguments are not shell-split by the backend. Configuration is
editable only while the LoopSpec is disabled.

Workstreams runs the verifier off the UI thread in a dedicated process group,
with the remaining run deadline as timeout. It drains but caps stdout/stderr,
records exit status/duration/truncation, hashes a directly referenced program
file, kills the process group on timeout, and waits for termination. A spawn
error, timeout, or non-zero exit cannot be overridden by the evaluator.
On Unix GUI launches, bare verifier programs inherit the login-shell PATH
repair from ADR 017, so `npm`, `node`, `cargo`, and other user-installed tools
resolve the same way they do in terminal tiles.

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

The `loop_control` tile starts Run now and projects backend state: stage, task,
elapsed/deadline, streamed events, worker result, verifier output, evaluator
feedback, and errors. It exposes separate Pause, Resume, Stop, and Kill
actions. Closing the tile does not own or erase the run. ADR 022 replaces the
original setup form with a catalog of versioned YAML definitions.

Task presentation is state-first rather than ledger-first. Each card parses the
structured worker result and foregrounds only the current state or latest
actionable evaluator feedback. When automatic revisions are exhausted, that is
stated beside the request. Objective, session id, parsed worker evidence,
verifier output, every evaluator/approval record, and errors live behind a
closed **Details** disclosure. The event timeline is also closed by default.
The generic run-level "tasks require attention" message is suppressed when a
task card can show the concrete request.

The workstream sidebar shows per-workstream running/attention state and the
number of running loops. One active run per workstream remains a workspace
mutation safety invariant; there is no global concurrency cap across separate
workstreams.

The existing `workstreams` executable exposes legacy `configure`, `enable`,
`run`, `status`, and `control` subcommands plus the YAML-first `validate`,
`list`, and `run-file` commands defined by ADR 022. Its deterministic `scenario`
runs the same controller with the scripted runtime and a real verifier.
Keeping one Cargo binary avoids ambiguity for `cargo tauri dev`.

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
- Playwright covers YAML catalog discovery/selection, path-based Run,
  Pause/Resume, verifier/evaluator evidence, and Kill.
- `e2e/features/manual-coding-loop.mjs` is the real-Tauri CDP probe. It can only
  run on Windows because macOS WKWebView does not expose CDP (ADR 003/018).

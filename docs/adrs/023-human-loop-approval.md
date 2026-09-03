---
id: "023"
status: Accepted
date: 2026-08-31
---

# ADR 023: Human approval as a loop sensor

## Status

Accepted (2026-08-31).

## Context

Deterministic verifiers and evaluator agents cannot safely decide every
outcome. Subjective UX, risky changes, and work that may lead to public effects
need an explicit human gate. Treating that gate as generic "attention" loses
the decision contract, evidence, and ability to request one bounded correction.

The gate must also survive app restarts. Keeping a Copilot SDK session alive
while a person is away would make SQLite cease to be authoritative and would
fail as soon as the app exits.

## Decision

### Human approval is an optional final sensor

A YAML definition may include:

```yaml
humanApproval:
  prompt: Review the task result and all evidence before accepting it.
```

At least one of `verification`, `evaluator`, or `humanApproval` is required.
When combined, sensors run in this fixed order:

```text
worker -> verifier -> evaluator -> human approval
```

An earlier failure stops the pipeline. Human approval cannot override a failed
verifier or a rejecting evaluator.

### Approval is durable workflow state

After automated stages pass, the executor disconnects its worker session and
persists:

- run and task state `awaiting_approval`;
- a `loop_approvals` row with attempt, prompt, status, feedback, and decision
  timestamps;
- an `approval.requested` event.

Restart reconciliation preserves this state. Waiting for a person consumes no
agent runtime and may outlive the original run deadline.
It remains an active run, so the workstream cannot start another loop or switch
definitions until the reviewer decides or stops it.

The reviewer has three decisions:

- **Approve** — accept the task and continue with queued work or another
  orchestration cycle.
- **Request revision** — require non-empty feedback and start one fresh worker
  episode, then rerun every configured automated sensor before asking again.
- **Reject / stop** — block the task and end the run in attention.

There is one total revision budget per task. If an evaluator already consumed
it, human revision is unavailable. A human-requested revision receives a fresh
run timeout because time spent awaiting a person is not compute time.

A fresh worker episode is deliberate: persisted task context and human feedback
are sufficient, while retaining an in-memory SDK session would make the gate
non-durable.

### UI and CLI expose the same decisions

The Goal Loop tile shows the task, worker result, verifier/evaluator evidence,
approval prompt, feedback box, and Approve / Request revision / Reject actions.
The sidebar shows a distinct approval indicator and count even when the tile is
closed.

CLI parity is provided by:

```text
workstreams loop approval <db> <run-id> <approve|revise|reject> [feedback]
workstreams loop approval-scenario <db> <workspace>
```

## Consequences

Human judgment becomes explicit, durable evidence instead of an ambiguous
attention state. Long waits consume no Copilot process. Revisions remain
bounded and repeat all sensors.

Approving one task refreshes the execution deadline and continues queued work
or starts another orchestration cycle. Final run disposition still reflects
any earlier failed task, and completion still requires a later empty
orchestration pass.

## Validation

Rust tests cover pending requests, restart preservation, revision and approval
records, and the CLI scenario. Vitest covers domain transitions, wire mapping,
both backends, tile actions, and sidebar status. Playwright performs a complete
run through pause, automated sensors, human revision, repeated sensors, and
final approval. The Windows CDP fixture exposes a human-gated definition in the
real Tauri catalog.

---
id: "025"
status: Accepted
date: 2026-09-02
---

# ADR 025: Re-plan a stuck task before asking for a human

## Status

Accepted (2026-09-02).

## Context

When a task exhausts `maxTaskIterations`, the run stops and asks the operator to
correct the issue by hand. Observed runs show that this escalation is often
premature: the failure is not that the worker cannot do the job, but that the
task was too coarse for a single accept/reject decision.

In one real run the verifier passed on all six attempts while the evaluator
rejected six times for a *different* reason each time. The task bundled seven
distinct behaviors, so any single attempt could satisfy some and regress others.
The evaluator consumed 36 of the run's 63 minutes and the operator was handed a
task no smaller than the one that had already failed six times.

The orchestrator already knows how to turn an objective into bounded tasks. It
was only consulted once, at the start of the run.

## Decision

### Consult the orchestrator when the attempt budget is exhausted

At the point where a run would previously have stopped for a human, the runtime
now asks the orchestrator to decompose the stuck work into narrower tasks. The
prompt includes each stuck task's objective and its *observed* failure reason
(the evaluator's feedback where present, otherwise the task summary), so the
decomposition is informed by why the work failed rather than only by what it
asked for.

If the orchestrator returns usable tasks, they are enqueued and the run
continues. If it returns nothing usable, the run goes to Attention with an
explicit "could not be decomposed" message — a strictly better escalation,
because the operator now knows that automatic decomposition was tried.

### Only `attention` re-plans, and only when it is the whole story

`blocked` and `interrupted` are excluded. `blocked` is a deliberate escalation:
a worker or evaluator stating it cannot proceed. `interrupted` means the
operator stopped the run. Re-planning either would override a decision a human
already made.

A re-plan happens only when *every* unfinished task is re-plannable. A run with
one `attention` task and one `blocked` task still needs a person, because the
blocked task will not be resolved by splitting its neighbour.

### Anti-spin guards

Two mechanical guards prevent a re-plan loop:

1. Keys that just exhausted their budget are filtered out of the orchestrator's
   response. An orchestrator that returns the same task under the same key
   cannot resurrect it.
2. `MAX_REPLANS_PER_RUN` bounds how many times one run may re-plan. The counter
   lives in memory rather than being derived from events, so a run the operator
   resumes gets a fresh allowance — they have just looked at it.

### Superseded tasks keep their evidence

A re-planned task is not deleted or rewritten. It keeps its state and its
failure reason, and gains `superseded_by_replan`. That flag removes it from run
disposition — it no longer blocks completion, no longer counts toward the
attention badge, and renders as *Superseded* rather than *Action required* —
while its verifier output, evaluator feedback and timings stay readable as the
explanation for why the smaller tasks exist.

## Consequences

- A run can now finish successfully after a task failed, which is new: run
  disposition is computed over non-superseded tasks only.
- The orchestrator is on the critical path more than once per run, so its cost
  and latency are incurred again at the moment a run was previously stopping.
- The failure mode shifts from "operator receives an oversized failing task" to
  "operator receives either a finished run or an explicit statement that
  decomposition was attempted and did not help".
- A task that fails for an environmental reason (a missing tool, a broken
  network) will be decomposed pointlessly once before escalating. The attempt
  is bounded and its cost is one orchestrator call.

## Alternatives considered

**Add a `superseded` task state.** Rejected: it would ripple through the Rust
enum, the TypeScript `LOOP_TASK_STATES` union, every filter and every label,
and it would destroy the information about *how* the task failed.

**Retry the same task with more iterations.** Rejected: the observed failure was
goalpost drift across attempts, not insufficient attempts. More iterations on an
oversized task produce more drift.

**Re-plan on any non-terminal failure including `blocked`.** Rejected as
described above: it overrides explicit human and agent escalations.

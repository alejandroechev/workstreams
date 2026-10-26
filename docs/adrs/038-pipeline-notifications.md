---
id: "038"
status: Accepted
date: 2026-10-26
---

# ADR 038: Pipeline notifications in the Inbox

## Status

Accepted (2026-10-26). Extends [ADR 030](030-ado-pr-inbox.md) and
[ADR 031](031-pr-inbox-event-stream.md); the PR inbox becomes the **Inbox**.

## Context

The PR inbox tells you when a pull request needs you. Nothing told you when one
of the few Azure DevOps pipelines you care about failed or succeeded: low-
frequency, task-specific pipelines such as a weekly update job or a twice-daily
watchdog. These are often started by a schedule or service account, and they
build repositories you may never import into Workstreams.

## Decision

**Watch individual pipelines, added by pasting a link.** A pipeline page link
(`…/_build?definitionId=N`) or any run link (`…/_build/results?buildId=N`) works,
in either host form (`dev.azure.com/<org>/…` or `<org>.visualstudio.com/…`). A
run link resolves to its pipeline with one extra request. Watched pipelines are
a standalone list (the **Pipelines** manager, opened from the Inbox and the
sidebar). They aren't attached to Workstreams repos, and a pipeline is
identified by organization, ADO project id and definition id.

**Modes per pipeline:** Off · Failures · Successes · Both. The default is
Failures. Only result `failed` is a failure and only `succeeded` a success;
`partiallySucceeded` and `canceled` never notify, but still show as the last
result. Off keeps the pipeline listed, with its last result, but silent.

**Every finished run counts**, whatever its branch, trigger or requester; there
is no filter. Each run with a watched result is its own notification, so a
pipeline that keeps failing notifies on each failure.

**No replay.** Each watch has a `notify_after` time, set to the current time
when it is added and again on every mode change. A run notifies only if it
finished after that time. Comparisons use SQLite `julianday`, which reads ADO's
7-digit fractional timestamps. Notifications are unique on (pipeline, run,
result), so a retried run that changes result notifies once more and never
twice.

**Checking reuses the PR inbox poller.** The same native thread, 120-second
pass, Azure CLI token, host and redirect rules, timeouts and size caps apply
(ADR 030). Pipelines are checked after PRs. Each costs one request
(`_apis/build/builds?definitions=…&statusFilter=completed&queryOrder=finishTimeDescending&$top=50`);
these pipelines run rarely, so 50 always covers the gap between checks. Each
pipeline is checked on its own: a failure is stored on that pipeline and never
stops the others or the PRs. When nothing at all is watched, no token or HTTP
call is made. A change to the list is noticed within two seconds, so a new
pipeline shows its last result almost at once. The poller never holds the
database lock during network work.

**Adding asks ADO**, so the Tauri command runs off the IPC thread without the
lock. The agent CLI's `inbox.pipeline_add` resolves while its request holds the
lock, as worktree creation already does; it is a request or two with a
30-second timeout.

**One Inbox.** "PR inbox" is renamed **Inbox**. It has a **Pull requests**
section (grouped by repo, unchanged) and a **Pipelines** section (grouped by
pipeline, newest run first), with All / Pull requests / Pipelines filters next
to the existing unread toggle. A run shows its result, run number, branch,
trigger and finish time. Clicking it opens the run in ADO and marks it read. One
badge counts unread PRs plus unread pipeline runs.

**Storage:** `pipeline_watches` and `pipeline_events`. Removing a pipeline
deletes its notifications. Agent CLI: `inbox.pipelines`, `inbox.pipeline_add`,
`inbox.pipeline_mode` and `inbox.pipeline_remove`; `inbox.list` and
`inbox.read` cover pipeline events.

## Consequences

- No mute ("Stop tracking") for pipeline events: the mode, with Off, is the
  control. PR mutes (ADR 036) are unchanged.
- In-app only, like PRs: no desktop or phone notifications.
- A run that finishes and is then retried within one two-minute pass is seen
  only with its final result.
- Clock skew between the laptop and ADO shifts the quiet period by the same
  amount; runs finishing within that skew of an add or mode change may be
  missed or included.
- No browsing of organizations or projects, no branch filters, no stage-level
  detail.

## References

- [ADR 030: ADO PR inbox](030-ado-pr-inbox.md)
- [ADR 031: PR inbox event stream](031-pr-inbox-event-stream.md)
- [ADR 036: PR inbox mutes](036-pr-inbox-mutes.md)

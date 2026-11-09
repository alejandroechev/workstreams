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

## Amendment (2026-11-05): the repo a pipeline builds

Each watched pipeline is labelled with its repo, in the Pipelines manager and on
its Inbox notifications. Pipelines stay a standalone list: the repo is a label,
never a requirement, and there's no per-repo pipeline view.

- **Detected from ADO, at no extra polling cost.** Adding a pipeline stores its
  definition's `repository` (from the request adding already makes). Every
  check then takes the newest run's `repository` from the builds response it
  already fetches, so a pipeline re-pointed in ADO follows. A run that doesn't
  name one keeps what is stored. A pipeline watched before this has no repo
  until a run names one, or, if none does, its definition is asked once.
  Azure Repos URLs are read in any host form. Without a URL, the repo is taken
  to be in the pipeline's own organization and project. GitHub repos are
  `owner/repo`.
- **Matched to Workstreams repos when read.** ADO's repo (stored as JSON in
  `pipeline_watches.ado_repo`) is compared with every non-archived repo's
  `git_remote`, normalized the way the PR inbox reads clone URLs:
  - Azure Repos: organization/project/repository, case-insensitive, HTTPS in
    either host form or SSH;
  - GitHub: owner/repo.

  Folder names never match. The pipeline links to every repo with that remote
  (two checkouts → "repo +1"). One whose repo isn't in Workstreams shows ADO's
  name, marked *not in Workstreams*, and links as soon as that repo is added,
  because nothing is copied.
- **Manual override** (`pipeline_watches.repo_override`): NULL follows ADO,
  `none` shows no repo, or a repo id. It is set from the repo chip's menu
  (Automatic — <what ADO says> · each repo · No repo). An override survives
  restarts and later changes in ADO, and the menu keeps showing what Automatic
  would be. An override to a repo that has since been removed counts as unset.
- **Agents.** `inbox.pipelines` includes `ado_repo`, `repos`, `auto_repos`,
  `repo_source` (`auto` | `manual`) and `repo_label`, and
  `inbox.pipeline_set_repo pipeline= repo=<id|none|auto>` sets the override.

## Amendment (2026-11-06): Investigate a failed run

A failed run in the Inbox has an **Investigate** button. One click makes a
workstream for that run and starts a Copilot session in it, with a prompt
describing the run. The Inbox stays open, the active workstream stays the same,
and the notification's read state doesn't change.

- **A new workstream per run**, named `Investigate <pipeline> #<run>`. If the
  pipeline has a repo, it's a worktree of the first linked repo on a new branch
  `investigate/<pipeline>-<run>`, from `origin/<run branch>` (fetched first). A
  run whose branch isn't a branch (`refs/pull/…`, tags) starts from
  `origin/<default branch>`, named explicitly so it never inherits whatever the
  checkout has out. An existing branch of that name is never checked out (it
  holds other work); the next free name (`-2`, `-3`…) is used. With no repo, or
  if the worktree can't be made, it's a standalone workstream in the home
  directory, and the prompt says why there's no checkout.
- **The prompt carries identifiers and links only.** Pipeline, project, run
  number and id, result, branch, trigger, finish time, repo and run URL; then an
  instruction to fetch the failing steps and logs with `az`, and the goal: find
  the root cause, classify it as code, pipeline, infrastructure or flakiness,
  propose a fix, and change nothing until asked. Workstreams makes no extra ADO
  request. Fetching logs ourselves was rejected: the session can do it, and
  the prompt stays small.
- **One investigation per notification.** `pipeline_investigations(event_id,
  workstream_id, prompt, session_started)` links them, so after a restart the
  button reads **Open investigation** and switches to that workstream. Deleting
  the workstream frees the run to be investigated again.
- **Native side makes, app side starts.** The native command (or
  `inbox.investigate` for agents) creates the workstream and records the
  prompt. The app then starts every investigation whose session hasn't started:
  right after a click, on a `pipeline_investigation` state change from an agent,
  and on startup (so one interrupted mid-start gets its session). A session that
  fails to start stays pending. The app claims a left-over tile before mounting
  the workstream, so the mount never starts it without its prompt.
- **One starter at a time.** The UI and agent paths claim the run in-process
  before running git; a second caller while one is starting gets an error
  rather than a second worktree. It fails rather than waits because the agent
  path holds the database lock that the UI path needs to finish.
- Not on the phone companion.

## References

- [ADR 030: ADO PR inbox](030-ado-pr-inbox.md)
- [ADR 031: PR inbox event stream](031-pr-inbox-event-stream.md)
- [ADR 036: PR inbox mutes](036-pr-inbox-mutes.md)

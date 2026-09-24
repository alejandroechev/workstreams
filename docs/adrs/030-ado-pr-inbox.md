---
id: "030"
status: Accepted
date: 2026-09-24
---

# ADR 030: A local ADO reviewer inbox with app-lifetime polling

## Status

Accepted (2026-09-24).

## Context

The PR inbox tells the user when a selected repository needs their review,
without requiring a workstream or leaving Workstreams running as a background
notification service.

The initial scope is Azure DevOps, direct reviewer assignments, an in-app inbox,
and authentication through the existing Azure CLI login. Authored PRs, team
membership, desktop alerts, webhooks and GitHub notifications are outside this
version.

## Decision

**Persist assignment history locally and poll only while the application runs.**

Opt-in belongs to the repository. `pr_inbox_config` stores enabled state, a
configuration revision, current account/source, last successful check and error.
`pr_inbox_baselines` records successful first checks. `pr_inbox_seen` records both
silent baseline PRs and notifications, with durable read/unread state. All three
tables reference `projects` with cascading deletion.

History and baselines are keyed by repository, canonical ADO source and acting
account. The first successful check for that tuple is silent. Subsequent checks
insert one notification per newly observed eligible PR. Drafts are excluded from
the baseline, so becoming ready can notify. Removal and reassignment do not reset
deduplication. Disabling a repo preserves its baseline and history; archiving is
independent of notification opt-in.

### Native boundary

Rust owns the poller because it needs Azure CLI, HTTP and transactional SQLite
access, and must keep running when every workstream and the inbox are closed.
This also keeps CLI writes and UI writes on the same persistence path.
React owns presentation and a five-second local snapshot subscription.

One native thread checks enabled targets on startup and every 120 seconds after
the previous pass. Configuration changes are detected within two seconds when
idle. No checks overlap. The thread never holds the database mutex during Azure
CLI or HTTP work. A changed configuration revision or remote invalidates an
in-flight response before persistence.

`az account get-access-token` requests the ADO resource
`499b84ac-1321-427f-aa17-267ca6975798`, inherits repaired GUI PATH, and has a
30-second timeout and bounded output. The bearer token stays in memory; it is
never stored, logged or sent in process arguments. Provider response bodies and
Azure CLI output are not included in user-facing errors.

Clone URLs must identify HTTPS `dev.azure.com`, one organization under
`visualstudio.com`, or a supported `ssh.dev.azure.com` clone form. Requests use
constructed HTTPS URLs under `dev.azure.com`; credentials in clone URLs and
provider-supplied URLs are never forwarded. Redirects are refused. HTTP requests
time out after 30 seconds and responses are capped at 8 MiB.

The provider resolves `authenticatedUser.id` through connection data, then queries
active PRs with `searchCriteria.reviewerId` and `$skip`/`$top`. It also checks the
returned reviewers for an exact direct identity match and rejects drafts.
Pagination continues to an empty page, with a 100-page limit and duplicate-page
detection. A failure anywhere in a repo's query records an error without applying
a partial snapshot or baseline; other repos still run.

### Offline behavior and failure visibility

`Backend` has matching native and in-memory inbox operations. Browser E2E uses
`MemoryBackend` fixtures, while native provider tests inject an in-memory
`JsonTransport`. The real app never substitutes empty fixture data for missing
credentials: opting in without Azure CLI authentication shows an error and
`az login` guidance. With no opted-in repos, it makes no auth or network calls.

The sidebar badge counts unread notifications. Opening a PR launches its
canonical ADO URL and marks it read only after the opener succeeds. Read-state,
configuration and connection failures remain visible. The CLI exposes
`inbox.list`, `inbox.configure` and `inbox.read` on the existing agent channel.

## Consequences

This observes snapshots, not assignment events. It cannot recover assignments
that disappear or PRs that close between polls, including while the app is off.
Catch-up covers assignments still active at the next successful check. History
is retained after PR completion and is not a live list of outstanding reviews.

Switching Azure CLI accounts selects a separate inbox on the next successful
check. Old account history remains stored but hidden; credentials are not
persisted by Workstreams.

**Validation boundary:** browser E2E verifies UI behavior with fixtures. Native
unit and CLI integration tests verify filtering, persistence and deduplication.
The opt-in ignored test `inbox_live_provider_reads_authenticated_assignments`
exercises Azure CLI and ADO read-only using `PR_INBOX_LIVE_REMOTE`. Real desktop
CDP validation remains Windows-only under ADR 003/018; browser tests are not
evidence of WebView runtime behavior.

## References

- [ADO PR list API: reviewer filter and pagination](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-requests?view=azure-devops-rest-7.1)
- [ADO connection data: authenticated user](https://github.com/microsoft/azure-devops-node-api/blob/master/api/interfaces/LocationsInterfaces.ts)
- [ADR 017: GUI launch PATH](017-macos-gui-launch-path.md)

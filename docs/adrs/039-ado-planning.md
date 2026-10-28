---
id: "039"
status: Accepted
date: 2026-10-28
---

# ADR 039: Planning your ADO sprint and features, through a draft

## Status

Accepted (2026-10-28).

## Context

ADO's taskboard and backlog are built for a whole team. To see your own
sprint, check whether your features will land by their target date, or plan
the next sprint against your 8-story-point goal, you have to filter, count and
drag on a board your team shares. Every drag there is a write, seen by
everyone.

## Decision

**A global Planning view** reached from the sidebar, with four tabs: Sprint,
Features, Plan sprint and Plan feature. It shows **only your work items**,
with two exceptions: a feature's totals include every child story, and
unassigned stories in your features are offered as sprint candidates.

**You connect once by pasting a team link.** A sprint, backlog or board link,
in either host form, gives the organization, project and team. The team's
default area path, backlog iteration and the process's order and effort
fields (`StackRank`, `StoryPoints` in OneWork) are read from ADO and saved.

**You choose the sprint**, not ADO. The selected sprint drives the Sprint tab
and Plan sprint, and it is saved. The first default is ADO's current sprint,
saved on the first read so that a later rollover never switches silently: when
the selected sprint has finished, a banner offers to switch.

**Counting:**
- done = Resolved + Closed;
- Removed stories are left out entirely;
- a story without story points counts 0, shows **?**, and is counted as
  "not estimated";
- a feature is **at risk** when your pending story points exceed the sprints
  left before its target date × 8.

**Planning a sprint.** Drag stories between the candidates and the sprint
against a gauge marked at 8: green from 7 to 9, yellow below, orange above. It
never blocks. Candidates are:
- your unfinished stories from the previous sprint, listed first as carried
  over and never moved automatically;
- your New or Active stories that aren't in a sprint;
- unassigned stories in your features.

**Planning a feature.** You can create a feature, add stories, and estimate
them with free numbers. You can also retitle, reorder (backlog order) and
remove stories. Removing sets state Removed; nothing is ever deleted.

**Every change goes into a draft** (sprint moves, estimates, new items, titles,
order, removals) stored in SQLite, so it survives restarts. Nothing reaches ADO
until you press **Publish**. Publishing applies the changes in order. Each
existing item is re-read first and written with a JSON Patch `test /rev`
operation. An item whose revision changed since it was loaded (and not because
this publish wrote it) isn't written: it is shown as *changed in ADO* with
ADO's value, and its change stays in the draft while the rest publish. New
stories are created:
- assigned to you;
- in the team's area path;
- at the sprint they were planned into, otherwise their feature's iteration
  (a new feature uses the team's backlog iteration), and at the backlog order
  they were given;
- in state New, linked to their feature as children.

What a publish leaves in the draft is ready to retry: a story whose new
feature was created now points at the real feature, and a change to an item
this publish already wrote carries the revision it wrote, so the retry isn't
mistaken for a conflict. **While a publish runs, the draft is locked**: the
Plan tabs are disabled, and draft changes from the UI or an agent are refused
until it finishes, so what it leaves behind is exactly what it didn't write.

**Reading** costs these requests:
- a WIQL query each for your stories in the selected and previous sprints,
  your open features, and your unfinished stories;
- batched work-item reads (200 ids each) for features, their children, and
  the tasks of stories in the sprint (task progress counts Closed, Resolved
  or Done over all non-Removed tasks).

Planning reads ADO when it opens, every 5 minutes while it stays open, and on
Refresh, but never while closed and never before a team is connected. Each
read also re-reads the saved draft, as does an agent's planning change
(`state-changed`, entity `planning`), so CLI edits show up in the view. It
reuses the PR inbox's Azure CLI token and HTTP rules (ADR 030): requests only
to `dev.azure.com`, no redirects, 30 s timeout, 8 MiB cap, and no tokens or
provider bodies in errors. The transport gained POST and PATCH for WIQL and
writes.

**Where the logic lives.** The model (summaries, gauge, candidates, draft
overlay) is TypeScript (`src/domain/planning.ts`) for the UI. The native side
(`src-tauri/src/ado_planning.rs`) owns ADO access, the stored connection,
sprint and draft, publishing, and summaries for the agent CLI:
`planning.sprint`, `planning.features`, `planning.feature`, `planning.move`,
`planning.estimate`, `planning.add_story` and `planning.publish`. Both sides
apply the same draft rules: the last change of a kind to an item wins, and a
change to an item not created yet edits its creation (including the sprint
it is planned into and its order).

## Consequences

- **The Sprint and Features tabs show ADO as it is**; the Plan tabs show it as
  it will be after publishing.
- **Publishing re-reads the whole view first**, a few seconds of requests,
  so conflicts are judged against fresh revisions.
- **Removing an uncreated item** from the draft simply drops it; removing a
  real one sets Removed and can be undone in ADO.
- **Not covered:** a whole-team view, tasks and bugs as planning items,
  linking to the local Tasks board, and background polling.

## References

- [ADR 030: ADO PR inbox](030-ado-pr-inbox.md) (token and HTTP rules)
- [ADR 038: Pipeline notifications](038-pipeline-notifications.md)

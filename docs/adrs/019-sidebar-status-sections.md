---
id: "019"
status: Accepted
date: 2026-08-19
---

# ADR 019: Sidebar status sections + Repo Manager

## Status

Accepted.

## Context

The sidebar had two lists: every non-archived workstream in one flat list, and a
collapsed **Archived** fold. Two problems showed up in real use (13 active / 8
archived across 14 repos):

1. **The active list conflated two very different things.** `WorkstreamStatus`
   persists only `active` and `archived` (plus transient `creating` /
   `archiving` / `create_failed`). What the user calls "closed" is not a status
   at all — it is runtime `loadedWsIds`, i.e. whether the workstream's tiles and
   processes are running. `onCloseWorkstream` stops them without touching the
   stored status, so a closed workstream sat in the main list looking almost
   identical to a running one. Ten stopped workstreams crowded out the three
   being worked on.

2. **Archiving is destructive**, so it is not a tidy-up. It runs
   `git worktree remove` (see `worktree-provisioning.ts`). That is precisely
   *why* the idle pile grows: the only way to shorten the list was to delete
   work. Users correctly refuse.

Separately, the **Repos** section was pinned to the bottom of the same 240px
sidebar with `maxHeight: 40vh, minHeight: 120`. With 14 repos it reserved
roughly **a third of the sidebar** — yet clicking a repo only opened an *edit*
dialog and `+` only imported/created. It never navigated or filtered. Prime
navigation space was funding two rare administrative actions.

Five sidebar structures and three repo placements were prototyped before
choosing (`features/workstream-status-ui/prototypes`).

## Decision

1. **Split the working list into `Live` and `Idle` sections**, derived in
   `src/domain/workstream-sections.ts`:
   - `live` — not archived, and present in `loadedWsIds`
   - `idle` — not archived, nothing running ("closed")
   - `archived` — `archived` or mid-`archiving`

   Transient `creating` / `create_failed` stay in the working list: a
   provisioning workstream is live work, and a failed create must remain visible
   to retry or discard.

2. **Idle auto-collapses only when something is live.** This default matters
   more than it looks: on a cold start nothing is loaded, so *every* workstream
   is idle — a blanket "collapse idle" would render an empty sidebar. Encoded in
   `isSectionCollapsed` and guarded by tests at both the domain and component
   level. Explicit user toggles always win and persist.

3. **Order is preserved within each bucket**, so drag-and-drop reordering keeps
   working: `reorderById` still operates on the full active array and the
   sections are filtered views of it.

4. **Repos move out of the sidebar body** into a one-line footer control that
   opens a **Repo Manager** modal. The footer also surfaces a dormant count —
   repos with no active workstreams — which the old list could never show.

5. **The Repo Manager is the single place to administer repos**: browse, search
   by name or path, see active-workstream counts and dormant repos, edit
   (name / colour / Copilot command), import and create. The old sidebar edit
   dialog was deleted rather than left orphaned; its preset colour palette moved
   into the manager so no capability was lost.

## Consequences

**Positive**
- The list you look at constantly shows what is actually running. Idle work
  stays one click away instead of competing for attention.
- ~a third of the sidebar is returned to navigation.
- Age/dormancy signals make the idle and repo piles triageable rather than just
  tidy.
- Repo administration finally has room for path, counts and dormancy.

**Negative / risks**
- A first-run user with **zero repos** now reaches Import/Create through the
  footer rather than a visible `+`. The manager leads with a first-run state for
  exactly this case, but discoverability on day 1 is weaker than on day 100.
- One more concept (sections) in the sidebar.
- `Idle` will still grow without bound. This ADR deliberately does **not**
  introduce a non-destructive "shelved" tier — that was prototyped (option E)
  and remains the strongest candidate for the underlying cause, but it needs a
  schema change and its own design.

## Validation

- `src/domain/__tests__/workstream-sections.test.ts` — bucketing, age labels and
  the collapse-default rule, including the cold-start case.
- `src/workstream/__tests__/WorkstreamSidebar.sections.test.tsx` — sections,
  counts, persistence, and the repo footer.
- `src/workstream/__tests__/RepoManagerModal.test.tsx` — listing, filtering,
  dormancy, editing, first-run state, dismissal.
- `e2e/tests/sidebar-sections.spec.ts` — real-browser sections plus a
  **reachability** check for the footer control at 1440×900, 1280×720 and
  1180×700. The prototypes of this design shipped with green unit tests and
  good screenshots while being unclickable, because a layout that overflows its
  container pushes bottom-pinned controls below the viewport. Presence is not
  usability; that spec asserts the control is inside the viewport and is the top
  element at its own centre.

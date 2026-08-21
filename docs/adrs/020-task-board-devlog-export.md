# ADR 020: Task board, labels, event log, and devlog export

## Status

Accepted.

## Context

The user maintained a project tracker by hand: one markdown page per day in a
wiki (`devlog/fy2027/YYYY-MM-DD.md`), carried forward each morning. Measuring
30 real consecutive days made the problem concrete rather than aesthetic:

| Measurement | Value |
| --- | --- |
| Task lines identical to the previous day | **1755 (76%)** |
| Task lines new or changed | 553 (24%) |
| Open tasks on the latest day | 61 |
| Tasks receiving any activity on a given day | ~11 |
| Open tasks sitting in `in_progress` | **45 of 61** |
| Distinct `##` sections | 21 |

**76% of every page was retyped from the day before.** The page is
overwhelmingly *derived state* maintained by hand, and the ✅ backlog that
accumulated in it was the main driver of that growth.

Workstreams already modelled *execution* — worktrees, tiles, Copilot sessions —
but had no concept of the *work*. Three facts ruled out the obvious shapes:

1. Some tasks have a workstream, some do not, and some workstreams have no
   task. A task cannot be a property of a workstream.
2. The devlog's `##` sections are not repositories. `AI Crew` spans three
   repos; six sections have no repo at all. Grouping is orthogonal to code
   location.
3. The word `project` was already taken: `projects` in the schema means
   *repository* (`directory`, `git_remote`, `copilot_command`).

Reading the raw files also contradicted a model we had already half-committed
to. Counting every glyph across the 30 days:

```
✅ 181   ⚒️ 116   👁️ 68   🧊 39   🐞 30   🌟 30   🚗 8   ❌ 7   🕵️ 4   ❓ 3
```

`🐞` and `🌟` are **not statuses** — they are `Bugs/Fixes` and `Features`
*category bullets*. And `‼️` stacks *in front of* a status glyph
(`‼️🕵️offline sdk write path impl`), which a status could never do. The real
structure under `## Workstreams` is four levels deep and **irregular**:

```
- 🐞Bugs/Fixes          ← category
  - FileComments:        ← group
    - ✅my reply…        ← task
- 🌟Features            ← category
  - ⚒️Debug Mode         ← task, no group level
```

## Decision

### Tasks are two levels; labels absorb the rest

A task has one level of **subtasks**. The category and group levels become
**labels**, which are free-form and multi-valued. This is what collapses an
irregular four-level tree into a fixed two-level one: a task carries
`Workstreams` + `Bug` + `FileComments` rather than living three nodes deep, and
a task with no group simply carries one fewer label.

Subtasks carry the **full status vocabulary**, not a checkbox. The archive is
full of `⚒️Addressing second round of in depth comments` nested under an
in-progress parent, and degrading that to "not done" would corrupt the export.

### Statuses, folds, and flags

Seven board columns: To do · ⚒️ In progress · 👁️ In review · 🧊 Blocked ·
🚗 Parked · 🙋 Delegated · ✅ Done.

- `🕵️ investigating` **folds into** In progress. Four occurrences in 30 days;
  a column empty 99% of the time is pure cost, and investigating *is*
  in-progress work.
- `♾️ persistent` is standing work that never completes (the app's own
  development, say). It sits with the other non-flowing buckets rather than in
  the To do → Done run, because nothing ever moves out of it, and it is
  explicitly **not** terminal so it stays on every exported page.
- `❌ cancelled` is terminal but shares the Done column. It needs to exist
  (7 uses) without owning a graveyard nobody scrolls to.
- `‼️ priority` and `❓ question` are **flags on an orthogonal axis**, proven by
  the fact that they stack on top of a status glyph.

`🙋` for Delegated is the one invention; the user had no glyph for it. It is
asserted in tests to collide with no existing glyph.

### One task per workstream

The relation is 1:1. A workstream's `⋯` menu therefore offers **Go to task**
once bound and **Create task…** only while unbound — a second task could never
be created anyway.

Enforcement lives in both backends rather than only in that menu, because the
CLI reaches the commands directly and two tasks sharing a workstream leaves the
quick-note bar guessing which one a note belongs to. A partial unique index
(`WHERE workstream_id IS NOT NULL`, so the many task-less rows are unaffected)
backs it up; on a database that already contains duplicates that index fails to
create and is ignored, which is why the command-level check is the
authoritative guard.

The quick-note picker survives for exactly those pre-existing rows: picking the
first silently would file notes under the wrong task.

### Repos are derived, never stored

A task's repos come from its attached workstream. Repo is a board *filter*, not
a field on the card. Storing it would be wrong more often than right.

### Free-form notes are a third concept

Measuring the archive settled this: **1470 of the 1962 nested bullets (74%) are
context-only prose** — no status glyph, no link, no timestamp. Lines like
*"Passing seqnum when switching from Opus to Wavelock"* or *"synced with Peter,
have concrete feedback to improve design"*.

They are neither subtasks (no status, not units of work) nor events (standing
design context, not something that happened at 14:05), so under the original
two-concept model they had nowhere to live. `tasks.notes` is that third thing:

| | mutable | timestamped | answers |
| --- | --- | --- | --- |
| Subtask | yes | no | what is left to do |
| Event | no (delete only) | yes | what happened |
| **Notes** | **yes** | no | what this *is* / current thinking |

**One note per task**, deliberately: a list of notes would immediately raise
"which one?" and drift back towards being an event log. It is fully mutable
because it records current understanding rather than history, and editing it is
**not** recorded as an event — logging every revision would bury the day's real
events under successive drafts of the same paragraph.

It is exported as nested bullets, one per line, appended after subtasks and
links. **Blank lines are dropped**: a blank line terminates a markdown list, so
emitting one would detach every following bullet from its task and demote it to
a top-level item in the archive.

Because two things called "note" is unusable, the append-only box in the
activity feed is labelled **Log entry**.

### Events are immutable but deletable

An event may be **deleted** (it never happened) but never **rewritten**. There
is no update path for event text in either backend, and the UI exposes no edit
control — asserted by tests in both places. Pure immutability was rejected
because a typo would otherwise be permanent in the wiki; rewriting was rejected
because the in-app log could then quietly disagree with what was already
exported.

Automatic events in v1 are limited to what the app already observes: board
moves and workstream attach/detach. PR and build-pipeline events need
credentials and an ADO client, and were deferred rather than stubbed.

### The board is global, not a tile

Tiles are bound to one workstream. Tasks cross and outlive workstreams, and
many have none, so a tile would leave most tasks unreachable. The board is a
sibling of the workstream list, reached from the sidebar like the Repo Manager.

Swimlanes by label break up the 45-of-61 `in_progress` pile without asking the
user to change how they work. The Done column shows **today's completions
only** by default.

Cards are dragged between columns, and a drop is recorded as an auto `status`
event exactly like the dropdown. One rule is load-bearing: **dropping a card
back on the column it already renders in is a true no-op** (`statusForDrop`
returns null). Because `investigating` renders in In progress and `cancelled`
renders in Done, writing the column's own status on such a drop would silently
flatten `🕵️` into `⚒️` and `❌` into `✅` — destroying a distinction the export
depends on, purely because a card was picked up and put down again.

Cards show their subtasks inline with each subtask's own glyph, capped at five
with a `+n more` summary. The cap exists because 45 tasks share one column;
rendering every subtask of every card unbounded makes that column unusable.

The sidebar's `⋯` menu offers **Create task…**, which opens the board with a
task created, named after the workstream, attached to it and selected. The
request is one-shot: it is guarded by a ref and cleared by the board through
`onCreateForWorkstreamHandled`, because StrictMode double-invokes effects and a
replayed request would silently mint a duplicate task on every open. Tasks are
renamed inline in the detail panel; a blank title is refused rather than saved,
since the title is the only handle a task has on the board and in the archive.

A card carries a link to its workstream when it has one. The link stops click
propagation, since the card itself is clickable and would otherwise open the
detail panel behind the navigation, and navigating closes the board — it is a
full-screen overlay, so leaving it open would hide the workstream just
navigated to.

### Export is one-way, manual, and refuses to guess

The generated page is written into the same wiki folder with the same
`YYYY-MM-DD.md` naming, so the archive stays one continuous searchable series.

The export writes up **yesterday**, not today: it runs at the start of a
working day and covers the day just finished, so the page is complete rather
than a snapshot taken mid-morning. That date also decides which event-log
entries and which completions belong on the page.

Format (front matter is load-bearing, see below):

```markdown
---
date: 2026-08-20
generated_by: workstreams
---

# 2026-08-20

## ⚒️ Agency Code Review Telemetry

### Labels

`AI Crew`

### Workstream

`ws:PR Telemetry Pipeline`

### Subtasks

- 👁️ ACSMediaSDK Pipeline
- ✅ Improve Dashboards

### Notes

I am exploring some improvements:
- Moving the miner logic to a shared repo
- Adding tests

### Event log

- _14:05_ — synced with Ela on the transform step
```

Each task owns a `##` heading led by its status glyph (flags stack in front,
as the archive writes them), with its detail in `###` subsections. Empty
subsections are omitted: at 60-odd open tasks, empty scaffolding would triple
the page length.

**Notes are emitted verbatim, not bulletised.** Prefixing `- ` onto a line
that already starts with `- ` produced `- - Moving the miner logic` in the
previous format. Being a top-level block rather than a nested list item also
means blank lines are ordinary paragraph breaks instead of something that
terminates a list.

**Labels moved into a `### Labels` subsection** when tasks took over `##`.
They no longer group the page visually, so ordering does that job instead:
tasks sharing a label set stay adjacent, in the order their group first
appears. Without that, 61 tasks would be a flat, unscannable run of headings.

**There is no "touched today" badge.** The presence of an `### Event log`
section is itself the signal that a task moved that day.

Three rules make the generated page **smaller** than the one it replaces:

1. **Completed work appears only on the day it finished** — precisely the
   backlog that made each page grow without bound.
2. **Only manual notes reach the page.** Auto events stay in-app; the
   hand-written archive never contained commit logs.
3. **Touched tasks are marked**, surfacing the 24% the copy-paste habit hid.

Section headings are a breadcrumb over the task's labels **in their stored
order**. A round-trip prototype recalled 96.9% of task lines but differed in
section order on 28 of 29 days; an explicit label order closes that gap.

### The clobber guard

The target folder holds a year of hand-written work log that exists in no other
form. A file is replaced **only** if it proves it came from us, by carrying
`generated_by: workstreams` inside leading YAML front matter. A hand-written
page, foreign front matter, an empty file, or an unreadable file all cause the
export to write alongside under `<date>.workstreams.md` and warn.

This is why the front matter exists at all: a sidecar hash file would litter the
wiki repo, and "does this look generated?" heuristics fail exactly once, and
unrecoverably.

## Consequences

- **Day one is empty.** No seeded labels, no history import, no paste-import —
  all explicitly chosen. The in-workstream quick note is therefore not a
  convenience but *the* adoption path: if logging is slower than editing the
  wiki, the wiki wins and the feature is dead weight.
- **Label count will grow well past 21**, because labels now carry section,
  category and group. Case-insensitive dedupe with autocomplete is the only
  defence shipped in v1; there is no merge/rename tool yet.
- **Nesting is flattened in the output.** `## Workstreams › Bugs/Fixes ›
  FileComments` and `## Workstreams` render as sibling sections rather than
  nested ones. This is a direct consequence of flat labels and was accepted.
- **Timestamps are ISO-8601 UTC**, deliberately *not* the epoch seconds
  `lib.rs::now()` returns. Mixing formats in one column is what broke
  file-comment ordering (ADR 009), and here it would also place notes on the
  wrong devlog day. Grouping converts to the **local** day before slicing.
- Dedupe rules are duplicated in Rust (`normalize_label`) and TypeScript
  (`normalizeLabelName`). `npm run tasks:smoke` asserts they agree, because a
  drift would let the CLI mint a duplicate the UI refuses.

## Alternatives considered

- **Round-trip sync with the wiki.** Rejected: it needs conflict resolution
  between a database and a markdown file, and the wiki was only ever asked to
  be a searchable archive.
- **A real four-level hierarchy.** Rejected: the depth is already inconsistent
  across the user's own sections, so it would hard-code a shape that does not
  hold.
- **Importing all 30 days.** Rejected: reconstructed "events" would carry
  invented timestamps, and the bullet grammar is genuinely ambiguous (is a
  three-deep bullet a subtask or a link?). The old files remain the archive.
- **A WIP limit on `in_progress`.** Rejected: it moralises at someone who
  genuinely has 45 things in flight, rather than making them legible.

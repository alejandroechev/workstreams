---
id: "037"
status: Accepted
date: 2026-10-14
---

# ADR 037: Reviewing acceptance tests in the Plan tile, with storyboards

## Status

Accepted (2026-10-14). Builds on [ADR 034](034-grill-answer-mode.md) (the grill
Answer mode it reuses).

## Context

`after-grill` writes `acceptance.md` and stops so the owner can approve the
tests before implementation starts. Approving them meant reading a long
markdown file top to bottom. Nothing showed what a UI test means as screens,
and there was no way to mark "this one is wrong" except typing prose into the
session. The Plan tile's Acceptance tab only listed titles with status buttons.

`validate-acceptance` pins a sha256 of `acceptance.md` per round, and
`complete-feature-plan` refuses if the file changed afterwards. That guard
catches an assertion edited after it passed. So anything that writes the file
must stop once the tests are approved.

## Decision

### 1. One job: approving the tests

The Acceptance tab gets a **Review** mode, opened by default. **List** keeps
today's list, where results are recorded. Review mode has:

- one test per screen, in file order, with ←/→/Enter and Previous/Next;
- an overview strip coloured by mark, and a filter by mark;
- the parts of each test: Validates, the automation tag, Given/When/Then, the
  storyboard, *Passes when*, and both Verify notes.

Review mode records **no results**. It shows validation screenshots read-only
(§3).

### 2. Marks and requests are markers in the draft file

The grill style, parsed by `src/domain/acceptance/`:

| Marker | Written by | Meaning |
|---|---|---|
| `**Review:** ok` / `**Review:** change: <note>` under a test's header lines | Looks right / Needs change | Keep it / rewrite it as the note says |
| `## Missing tests (review)` with `- <note>` lines | Missing test | Add a test for this |
| `**Visual requested:** <note>` in a test | Show me this | Draw (or redraw) its storyboard |
| `**Frame:** acceptance-assets/<AT>/<file> "caption" (given\|when\|then)` | `after-grill` | One storyboard frame |

- **Writers change exactly one line**, or insert one, and go through the
  grill's compare-and-swap writer, so a rewrite the agent makes meanwhile is
  never clobbered.
- **Notes are collapsed to one line**, so a pasted heading or `---` cannot
  change the file's structure.
- **Every writer refuses once the front-matter says `status: approved`**, and
  the view disables its controls. Nothing writes an approved file, so the
  sha256 guard keeps its meaning.
- **There is no Approve button.** The owner types "approve" in the session.
  `after-grill` refuses while any test is still marked *Needs change*, or a
  missing-test note or a visual request is unhandled. On "review" it applies
  the marks.

`scripts/acceptance-cli.mjs` (`parse | mark | missing | request`) gives the
same operations on the command line.

### 3. Storyboards and expected vs actual

- **What a storyboard is.** For every UI-visible test, `after-grill` draws one:
  frames for at least each Given/When/Then step. Frames are low-fi HTML
  wireframes (or images) in `acceptance-assets/<AT>/`, with real labels and
  the element under test highlighted. Non-UI tests get a mermaid flow or
  nothing.
- **How frames render.** They reuse `GrillVisualView`, now given an allowed
  asset folder: the same confinement to the document's own folder, and the same
  sandbox (`sandbox="allow-scripts"` srcdoc with a CSP prefix, no network, no
  parent access, frame-only `frame-src`). They show as a filmstrip; clicking a
  frame's header enlarges it.
- **Where screenshots come from.** `validate-acceptance` saves a screenshot per
  frame it can reach, as `validation/r<n>/<AT-id>-<frame number>.png`, frames
  numbered from 1 in marker order. Review mode lists `validation/r*` and shows
  each frame's latest screenshot beside it, as *Expected* / *Actual — round
  n*. The comparison is read-only.

## Consequences

- **Old files still open.** Every `acceptance.md` written before this has no
  frames or marks, and opens with one card per test and no storyboard.
- **The UI depends on the screenshot naming.** If the validator names a
  screenshot differently, it simply doesn't show, and the frame shows only its
  mockup.
- **Changes to the skills.** `after-grill` and `validate-acceptance` gained the
  storyboard, review-mark and screenshot rules. Both live outside this repo.
- **Generalised grill pieces.** The grill's `assetPath` and `GrillVisualView`
  now take the allowed asset folder (default `grill-assets`). Grill behaviour is
  unchanged.

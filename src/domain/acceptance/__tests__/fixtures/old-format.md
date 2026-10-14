---
feature: grill-ui
status: approved
created_at: 2026-10-08T14:50:00-03:00
---

# Focused grill answering — Acceptance Tests

> High-level validation from the user's point of view. Each test is runnable by a
> human **or** an agent. These validate the **ask**, not the implementation.
>
> **Review these before implementation starts.** Say "approve" when they capture
> what you expect.

## AT-1 — The Plan tile is there, and its Grill tab opens in Answer mode
**Validates:** US-1, R2-A1, R2-A2
**Automation:** agent

**Given** a normal Workstreams build with no feature flags set, and a linked session with a grill
**When** you add a Plan tile, pick the feature and open its Grill tab
**Then** the tile can be added, the Grill tab shows the Answer view, and the mode selector offers
Answer, Edit, Preview and Slides.

**Verify (human):** Add tile → Plan → pick the feature → Grill.

**Verify (agent):** In the browser E2E harness with no flag environment variables, add the Plan
tile through the add-tile menu, select a seeded feature, open Grill, and read the active mode and
the selector's options.
**Passes when:** the Plan item is in the add-tile menu, the Answer view is shown on opening Grill,
and the selector lists Answer, Edit, Preview and Slides with Answer active.

**Status:** ☐ not run

---

## AT-2 — One question per screen, with keyboard navigation and an overview strip
**Validates:** US-2, R1-C1
**Automation:** agent

**Given** a grill whose latest round has 5 questions of mixed importance, 2 already answered
**When** you open Answer mode and use `→`, `←`, a number key, `Enter`, and click an overview marker
**Then** exactly one question is shown at a time, the keys move as described, the number key picks
that option, and the strip has 5 markers coloured by importance with 2 filled.

**Verify (human):** Walk through the round with the keyboard.

**Verify (agent):** Drive the view in the E2E harness: count visible question cards, press keys,
read which question id is shown, the selected option, and each marker's importance colour and
filled state.
**Passes when:** exactly one card is visible at every step; `→`/`←`/`Enter` change the shown id as
expected; pressing `2` selects option (b); the strip has 5 markers whose colours match their
importance and exactly the answered ones are filled; clicking marker 4 shows question 4.

**Status:** ☐ not run

---

## AT-3 — Earlier rounds are visible but can't be changed
**Validates:** US-2, US-3, R1-C3
**Automation:** agent

**Given** a grill with an answered Round 1 and an open Round 2
**When** you open Answer mode, then switch to Round 1
**Then** it opens on Round 2; Round 1's questions are shown read-only and no control changes them.

**Verify (human):** Switch to Round 1 and try to change an answer.

**Verify (agent):** Open the view, read the shown round, switch to Round 1, try every answer
control, and compare the file before and after.
**Passes when:** the initial round is Round 2, Round 1 controls are disabled or absent, and the
file is byte-identical after the attempts.

**Status:** ☐ not run

---

## AT-4 — Answers are written into the file, only into their own slot
**Validates:** US-3, R1-C2, R2-A4
**Automation:** agent

**Given** an open round with an option question, a free-text question, and the agent appending a
new round to the file while you answer
**When** you pick (b) with the note "only on the phone" on the first, and type text in the second
**Then** without saving explicitly, the file shows `**Answer:** b — only on the phone` and the typed
text under the right questions, and the appended round is still in the file, intact.

**Verify (human):** Answer two questions, then open Edit mode and read the file.

**Verify (agent):** In the harness, answer the two questions; in between, append a new round to the
file on disk; wait for saving; read the file.
**Passes when:** the two answer slots hold exactly those texts; every other byte of the file,
including the appended round, is unchanged.

**Status:** ☐ not run

---

## AT-5 — Importance is shown, can be overridden, and drives the filter
**Validates:** US-4, R1-B1, R1-B3
**Automation:** agent

**Given** a round with one Low, one Medium, one High and one Blocking question
**When** you set the filter to "High and up", then turn on "unanswered only" after answering the
High one, then change the Low question to High
**Then** the filter shows only High and Blocking, then only Blocking; after the override the
formerly Low question is included, and the file reads `**Importance:** High (you)` for it.

**Verify (human):** Use the filter and the importance control on a question.

**Verify (agent):** Drive the filter and the override in the harness; read the navigable question
ids after each step and the importance line in the file.
**Passes when:** the navigable ids are exactly {High, Blocking}, then {Blocking}, then include the
overridden question; the file's line for it is `**Importance:** High (you)`.

**Status:** ☐ not run

---

## AT-6 — Blocking questions can't take the recommendation
**Validates:** US-4, US-5, R1-B2, R2-A3
**Automation:** agent

**Given** a round with an unanswered Blocking question and other unanswered questions
**When** you reveal its recommendation, and press Finish round
**Then** Accept recommendation isn't offered for the Blocking question, and Finish round is refused,
naming it, with nothing written.

**Verify (human):** Try to accept the reco on a Blocking question, then Finish round.

**Verify (agent):** In the harness, reveal the Blocking question's recommendation and look for the
accept control; press Finish round; read the message and the file.
**Passes when:** no accept control exists on the Blocking question; Finish round shows a refusal
naming that question's id; the file is unchanged.

**Status:** ☐ not run

---

## AT-7 — Finish round records the defaults honestly
**Validates:** US-5, R1-B4, R2-A3, R1-A3
**Automation:** agent

**Given** a round where every Blocking question is answered and 3 questions are unanswered (some
hidden by the filter)
**When** you press Finish round and confirm
**Then** it first says 3 questions will take the recommendation; afterwards those 3 answers read
`reco (default — not reviewed)`, other answers are unchanged, and nothing was sent to the session.

**Verify (human):** Finish a round and read the file.

**Verify (agent):** Seed the round, press Finish round, read the summary text, confirm, read the
file, and check the linked session's terminal input received nothing.
**Passes when:** the summary names 3; exactly those 3 slots equal `reco (default — not reviewed)`;
the rest of the file is unchanged; no write reached the session.

**Status:** ☐ not run

---

## AT-8 — The recommendation is hidden until asked
**Validates:** US-6, R1-D1, R1-D2, R1-D3
**Automation:** agent

**Given** a non-Blocking question with a recommendation
**When** you open it, press "Show recommendation", then Accept recommendation; and separately turn
on "always show recommendations"
**Then** the recommendation text isn't visible until revealed; Accept appears only after revealing
and writes `reco`; with the setting on, recommendations are visible on every question; the file
gains no marker about having seen it.

**Verify (human):** Open a question and look for the recommendation before and after revealing.

**Verify (agent):** Read the visible text of the question card before and after revealing; look for
the accept control in both states; accept; read the answer slot; toggle the global setting and
check another question.
**Passes when:** the recommendation text is absent from the visible card before revealing and
present after; the accept control exists only after revealing; the slot reads exactly `reco`;
with the setting on, a second question shows its recommendation without revealing; no other
change appears in the file.

**Status:** ☐ not run

---

## AT-9 — Mermaid, images and per-option visuals render
**Validates:** US-7, R1-E1, R1-E2
**Automation:** agent

**Given** a question with a mermaid block, an image visual, and one prototype per option (a, b)
**When** you open it
**Then** the mermaid block is a rendered diagram, the image is shown, and each option's prototype is
shown with its option, with a side-by-side comparison available.

**Verify (human):** Open the question and compare options.

**Verify (agent):** In the harness, read the question card: an SVG diagram from mermaid, an image
element loading the asset, and two prototype frames associated with options a and b; open the
comparison.
**Passes when:** an SVG diagram is rendered, the image has loaded from `grill-assets/<id>/`, each
option shows its own prototype frame, and the comparison shows both frames at once.

**Status:** ☐ not run

---

## AT-10 — Prototypes are sandboxed
**Validates:** US-7, NFR-1, R1-E3
**Automation:** agent

**Given** a prototype that runs a script, tries `fetch("https://example.com")`, tries to read
`window.parent` state, tries `top.location = …`, and references a file outside its `grill-assets`
**When** you open its question
**Then** its script runs (it updates its own page), and none of the other four succeed.

**Verify (human):** Not practical by hand; covered by the agent check.

**Verify (agent):** Seed that prototype; in the harness, read the prototype's own DOM for the
script's effect, watch network requests, check the app's URL and state, and check the outside file
did not load.
**Passes when:** the script's change is visible inside the frame; no request to example.com is
made; the app's URL and state are unchanged; the outside file is not loaded.

**Status:** ☐ not run

---

## AT-11 — Requesting a visual, and the agent delivering it
**Validates:** US-8, R1-E4, R2-A5, R2-A6
**Automation:** agent-partial

**Given** two unanswered questions in an open round
**When** you press "Show me this" on both with the note "prototype of option b", answer the second
one, then type `review` so the agent runs the skill
**Then** both get `**Visual requested:** prototype of option b` immediately and show as pending; after
review, the first question still has the same id, is still unanswered, has a `**Visual:**` marker
whose file exists, and its request marker is gone; the second got no visual.

**Verify (human):** Request a visual, type `review`, open the question again.

**Verify (agent):** Do the requests in the harness and read the file and the pending indicator.
Then run a real `review` with a real agent in a session using the updated skill, and read the file
again. Whether a real agent follows the instructions needs a real run; if none is available, check
what you can and say what you couldn't.
**Passes when:** both request markers appear right away; after review, question 1 has a `**Visual:**`
pointing to an existing file under `grill-assets/<id>/`, no request marker, and an empty answer;
question 2 has no new visual.

**Status:** ☐ not run

---

## AT-12 — Agent fallback on review: blanks and Blocking
**Validates:** US-5, R2-A3
**Automation:** agent-partial

**Given** a round finished in a plain editor: two blank non-Blocking answers and one blank Blocking
question
**When** you type `review`
**Then** the agent refuses to converge, naming the Blocking question; once that one is answered and
you type `review` again, the two blanks read `reco (default — not reviewed)`.

**Verify (human):** Leave answers blank, including a Blocking one, and type review.

**Verify (agent):** Run the updated skill with a real agent on a seeded grill; read the agent's
reply and the file after each review. Needs a real agent session.
**Passes when:** the first review leaves the grill unconverged and names the Blocking id; after
the second, both blanks equal `reco (default — not reviewed)` and the status reads Converged or a
new round opens.

**Status:** ☐ not run

---

## AT-13 — Old grills open, and after-grill reads new ones
**Validates:** US-9, R1-F1, R1-F2
**Automation:** agent

**Given** an existing grill written before this change (for example `companion-messages/grill-me.md`)
and a new-format grill using every marker
**When** you open the old one in Answer mode, and run `after-grill` on the new one
**Then** the old grill shows Medium importance everywhere, option buttons where its `(a)/(b)/(c)` text
can be recognised and text boxes elsewhere; the spec `after-grill` writes from the new grill takes
`reco (default — not reviewed)` answers as recommendations and ignores the markers as content.

**Verify (human):** Open an old grill; run after-grill on a new one and read the spec.

**Verify (agent):** Open a copy of an old grill in the harness and read importance and controls for
several questions; run `after-grill` (or have a real agent follow it) on a seeded new-format grill
and inspect the spec.
**Passes when:** every old question shows Medium; at least one old question renders option buttons
and at least one a text box; the new spec contains no literal `**Importance:**`/`**Visual` markers as
requirements and treats default-reco answers as the recommendation.

**Status:** ☐ not run

---

## AT-14 — The grill-me skill teaches the new format
**Validates:** US-9, US-4, US-7, US-8, R1-F1, R1-E5
**Automation:** agent

**Given** the updated `grill-me` skill
**When** you read its template and rules
**Then** it requires `**Importance:**` on every question with the four levels and the Blocking rule,
options as `- (a) …` lines, `**Visual:**` markers under `grill-assets/<id>/`, the proactive-visual
rule (mermaid by default, a prototype only for UI choices, at most one unless asked), the
`**Visual requested:**` handling on review, and the blank → `reco (default — not reviewed)` fallback.

**Verify (human):** Read `~/.copilot/skills/grill-me/SKILL.md`.

**Verify (agent):** grep the skill file for each required element.
**Passes when:** every element listed above is present in the skill file.

**Status:** ☐ not run

---

## AT-15 — Workstreams is committed and pushed
**Validates:** US-1 … US-9 (delivery)
**Automation:** agent

**Given** the feature implemented
**When** you look at `alejandroechev/workstreams`
**Then** every change is committed and pushed to `master`, and its CI run is green.

**Verify (human):** Open the repository's commits and Actions.

**Verify (agent):**
```sh
git -C <workstreams> status --porcelain -- . ':!src-tauri/src/pty.rs' ':!e2e/features/terminal-wrap-diag.mjs'
git -C <workstreams> fetch -q && git -C <workstreams> rev-list --count origin/master..master
gh run list -R alejandroechev/workstreams --branch master --limit 1 --json conclusion,headSha
```
**Passes when:** no uncommitted feature files, 0 commits ahead of `origin/master`, and the latest CI
run on that commit concluded `success`.

**Status:** ☐ not run

---

## Coverage
| Story | Tests |
| --- | --- |
| US-1 | AT-1, AT-15 |
| US-2 | AT-2, AT-3 |
| US-3 | AT-3, AT-4 |
| US-4 | AT-5, AT-6, AT-14 |
| US-5 | AT-6, AT-7, AT-12 |
| US-6 | AT-8 |
| US-7 | AT-9, AT-10, AT-14 |
| US-8 | AT-11, AT-14 |
| US-9 | AT-13, AT-14 |
| NFR-1 | AT-10 |

Every story is covered.

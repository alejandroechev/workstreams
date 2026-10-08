# Grill-Me: A focused UI for answering grills

> **Instructions:** Answer inline under each question (a letter, "reco", or free
> text). Use the **Recommendation** as the default if you don't want to decide.
> Tell me **"review"** when a batch is ready.
>
> **Status:** Converged.
>
> **Grounding:**
> - **Size of the problem:** 21 grills exist across sessions; the larger ones run
>   37–90 questions, and many get answered "reco" in bulk (wb-canvas: 24 of 52,
>   pagos-plus: 16 of 47). That points at importance filtering paying off.
> - **Where grills live:** `~/.copilot/session-state/<id>/files/features/<name>/grill-me.md`,
>   which Workstreams already browses in **Session Meta → State** and opens in the
>   embedded viewer.
> - **Reusable pieces in Workstreams:**
>   - **Slides mode** for markdown (Edit / Preview / Slides, keyboard nav,
>     progress bar) in `FileEditorView`.
>   - `MarkdownView` already renders **mermaid**.
>   - **Inline file comments** already carry user→agent notes through
>     `session.db` (`/file-comments`).
>   - The app can write into a linked Copilot session's terminal.
> - **Grill format today:** fully prose. Options are `(a)/(b)/(c)` inline text,
>   with no machine-readable importance, option list or artifact link. Answers are
>   free text under `**Answer:**`. Downstream skills (`after-grill`,
>   `feature-plan`) read the markdown.
> - **Rules the skill already enforces:** append-only rounds; never edit
>   answered questions.

---

## A. Shape and source of truth

### A1. Where the UI lives
(a) **Inside Workstreams**: a "Grill" view for any `grill-me.md`, opened from
Session Meta → State or Repo Explorer (like Slides mode is for markdown).
(b) A new tile type ("Grill") bound to the workstream's linked session, which
finds its grills by itself.
(c) A standalone web page or app outside Workstreams.

**Recommendation:** (a), plus a one-click way in: when the linked session has a grill
with open questions, Session Meta shows "Open grill". It reuses the file
viewer, Slides navigation and mermaid rendering already there, and needs no
new tile plumbing.

**Answer:** it should live only in the Plan tile, where there is a Grill tab view

---

### A2. What is the source of truth
(a) **The markdown file stays the source of truth.** The UI parses it and writes
answers back into the `**Answer:**` slots. New metadata (importance, options,
visuals) is added to the format as small, readable markers.
(b) A structured sidecar (`grill.json`) is authoritative, and the markdown is generated from it.
(c) Only the session DB, with no file.

**Recommendation:** (a). `after-grill`, `feature-plan` and you yourself all read the
markdown, the append-only history stays readable in git and plain editors, and
older grills keep working.

**Answer:** reco

---

### A3. Telling the agent you're done
Today you type "review" in the session.
(a) **A "Send for review" button** in the UI writes the answers to the file and then
types `review` into the linked Copilot session.
(b) Only save the file; you still type "review" yourself.
(c) The agent watches the file and reacts on its own.

**Recommendation:** (a), with a confirm step if Blocking questions are still
open. It closes the loop without leaving the view. Typing into the terminal already
exists in the app, so there's no new channel.

**Answer:** no need for this, I can still type review to the agent

---

## B. Importance and filtering

### B1. Levels and who sets them
The agent tags each question **Low / Medium / High / Blocking** when it writes
the grill. Should you be able to change a question's level in the UI?

**Recommendation:** Yes. Your override is written to the file as you
(`**Importance:** High (you)`), so the agent and later rounds see that you
raised or lowered it.

**Answer:** reco

---

### B2. What "Blocking" means
(a) **It must be answered by you**; "reco" isn't allowed, and Send for review
refuses while any Blocking question is open.
(b) Just the highest level, with no special rule.

**Recommendation:** (a). It's the only level whose meaning changes behaviour,
which is what makes it worth having. The agent should use it sparingly, for
decisions it can't sensibly default.

**Answer:** a)

---

### B3. Filtering
(a) **A threshold**: show questions at or above a level ("High and up"), plus a
toggle for "unanswered only".
(b) Independent checkboxes per level.

**Recommendation:** (a). It matches "only the important ones" and keeps one
control. Checkboxes add choices nobody needs.

**Answer:** a)

---

### B4. What happens to questions you filtered out and never answered
(a) **They become "reco" explicitly on Send for review.** The file records
`**Answer:** reco (default — not reviewed)`, so it's honest that you didn't look.
(b) They're left blank, and the agent treats blank as reco.
(c) Send for review is refused until everything is answered.

**Recommendation:** (a). The decision record stays truthful, and `after-grill` can tell
"you chose the recommendation" from "nobody looked". A summary before sending
says "14 questions will take the recommendation".

**Answer:** a)

---

## C. The focus view

### C1. One question per screen
Each question fills the view: title, context, options, an answer area, and
prev/next with a progress bar. Keyboard: `→`/`←` move between questions, number keys pick an
option, `Enter` goes to the next.

**Recommendation:** As described, plus an **overview strip** (one dot per question,
coloured by importance, filled when answered) so you can jump anywhere and see
what's left at a glance.

**Answer:** reco

---

### C2. How you answer
(a) **Option buttons when the question has options, plus a free-text note** under
them ("b, but only for the phone"). Questions without options get a text box.
(b) Free text only, as today.

**Recommendation:** (a). It requires the skill to write options in a parseable form
(one per line, `- (a) …`). Picking b writes `b`, or `b — <your note>`.

**Answer:** reco

---

### C3. Rounds
Grills grow with `## Round N` sections.
**Recommendation:** Open on the **latest open round** only, with a switch to see
earlier rounds read-only. Answered questions from earlier rounds are never
editable from the UI, which keeps the append-only rule.

**Answer:** reco

---

## D. Hiding the recommendation

### D1. When it's shown
(a) **Hidden until you press "Show recommendation"** on that question (or a key).
(b) Hidden by default, with a global "always show" setting.
(c) Always shown.

**Recommendation:** (a) plus a global setting for when you're in a hurry. Hiding is
the point, but answering 40 Low questions one reveal at a time would be tedious.

**Answer:** reco

---

### D2. Record whether you saw it
Should the file note that an answer was given **after** revealing the
recommendation?

**Recommendation:** Yes, as a tiny marker (`**Answer:** b *(after seeing reco)*`).
It's cheap and makes "independent judgement vs went with the reco" visible
when reviewing decisions later. Skip it if that feels like surveillance of yourself.

**Answer:** no need

---

### D3. Does "Accept recommendation" exist as a button?
**Recommendation:** Yes, but only once the recommendation is revealed; it writes `reco`.
With the recommendation hidden, the only fast path is to filter the question out and
let B4 handle it.

**Answer:** reco

---

## E. Visual artifacts

### E1. Which kinds
(a) **Mermaid diagrams** (already rendered by the app)
(b) **Images** (PNG/SVG: screenshots, generated sketches)
(c) **Interactive HTML prototypes** (a self-contained page per option)

**Recommendation:** All three. Mermaid covers most "explain the options"
cases; images cover "here's how it looks today"; HTML prototypes cover
"which of these UIs". The UI shows them per question, and per option when an
option has its own ("compare a vs b" side by side).

**Answer:** reco

---

### E2. Where artifacts are stored and how questions reference them
**Recommendation:** Files next to the grill, in
`features/<name>/grill-assets/<question-id>/…`, referenced from the question with
a marker such as `**Visual:** grill-assets/B2/option-a.html "Option a"`. Mermaid
can also stay inline in the question as a fenced block. The file stays readable
everywhere, and the assets are versioned with it.

**Answer:**
reco
---

### E3. Prototype safety
HTML prototypes come from the agent.
**Recommendation:** Render them in a **sandboxed iframe**: scripts allowed so they can
be interactive, but no network, no access to the app and no top navigation. Only files
from the grill's own `grill-assets` folder.

**Answer:**
reco
---

### E4. Asking for a visual from the UI
You press "Show me this" on a question, optionally with a note ("a prototype
of option b").
(a) **Queue it:** the request is written into the file under the question
(`**Visual requested:** …`). The agent produces it on the next review, before
you decide.
(b) **Ask now:** also type the request into the linked session immediately, so
the agent makes it while you keep going through other questions.

**Recommendation:** (b). It's the "show me" loop you described. The request is
also written into the file so it isn't lost if the agent is busy. The question stays
open and shows "visual requested" until the artifact appears; the view picks up
new artifacts live.

**Answer:**
when I ask for review, the agent check this and generates the visual for next round
---

### E5. Should the agent add visuals proactively?
**Recommendation:** Yes, when a question's options differ in shape (a layout, a
flow, a data model): a mermaid diagram by default, an HTML prototype only when the
choice is about a UI. The skill says so, with a limit (for example at most one
prototype per question unless asked), so grills don't get slow to write.

**Answer:** reco

---

## F. The skill and compatibility

### F1. Changes to the grill-me skill
The template gains `**Importance:**`, parseable options (`- (a) …`) and optional
`**Visual:**` lines. Should old grills, which have none of these, open in the
UI?

**Recommendation:** Yes, degraded gracefully: they open with importance "Medium",
options parsed from `(a)/(b)/(c)` text where possible and otherwise free text. New grills use the new
format. `after-grill` must ignore the new markers, so check that it does.

**Answer:** reco

---

### F2. Which skills get it
(a) `grill-me` only.
(b) Also `problem-grill`, which has the same Q/A shape.

**Recommendation:** (a) first, but a parser that only needs the shared Q/A shape, so
`problem-grill` can opt in by adding importance tags later.

**Answer:** a)

---

## Z. Non-functional requirements

### Z1. Any non-functional requirements?
Performance, scale, security, accessibility, compatibility, operability.
Leave blank if none matter — most features genuinely have none worth stating.

**Recommendation:** none beyond E3 (sandboxed prototypes) unless something else
worries you. A candidate: "a 90-question grill opens and moves between questions
instantly (≤100 ms per move)".

**Answer:** reco

---

---

## Round 2 — the Plan tile, and finishing a round without a send button

> Given your answers: **A1** puts the UI in the Plan tile's Grill tab rather than a new view, and
> **A3** drops the "Send for review" button, so you keep typing `review` yourself. **E4** queues
> visual requests for the next round instead of asking immediately. Three earlier decisions relied
> on the button and need re-asking: when are filtered-out questions recorded as defaults (**B4**),
> where is Blocking enforced (**B2**), and when is the file written. Also, I found the Plan tile is
> **behind a feature flag that is off** in normal builds ("Not enabled in this build"), and its
> Grill tab today is just the markdown editor with Edit / Preview / Slides.

### A1. Turning the Plan tile on
The Grill view is only reachable if the Plan tile is.
(a) **Turn the `plan-tile` flag on by default** as part of this feature (the tile already lists
features, and has Overview / Grill / Acceptance / Graph tabs).
(b) Keep it behind the flag; you enable it locally.

**Recommendation:** (a). The flag's reason ("requires the plan/todo subsystem") no longer holds for
the Grill and Acceptance tabs, which read only files and the session DB.

**Answer:** a)

---

### A2. How the focus view fits the Grill tab
(a) **Add an "Answer" mode** next to Edit / Preview / Slides, and open the Grill tab in Answer
mode by default. Edit and Preview stay for the raw file.
(b) Replace the editor with the focus view.

**Recommendation:** (a). The raw file stays one click away, which is useful when the parser
misreads something, and the existing mode selector already has the pattern.

**Answer:** a)

---

### A3. When filtered-out questions become "reco (default — not reviewed)"
Without a send button, the app doesn't know when you're done.
(a) **A "Finish round" button in the Grill tab** writes the defaults for every unanswered,
filtered-out question, refuses while a Blocking question is open, and shows the summary
("14 will take the recommendation"). It does not message the agent; you then type `review`.
(b) The agent does it during `review`: any blank answer becomes `reco (default — not reviewed)`.
(c) Both: the button for when you use the UI, and the agent as a fallback for blanks.

**Recommendation:** (c). The button gives you the summary and the Blocking check before you
hand over. The agent fallback means a grill answered in a plain editor still ends up with an
honest record. In both cases, the agent refuses to converge while a Blocking question has no
answer of yours.

**Answer:** c)

---

### A4. When answers are written to the file
(a) **On every answer, immediately** (debounced). Before each write the file is read again
and only that question's `**Answer:**` slot changes, so a round the agent appended meanwhile
is never overwritten.
(b) Only when you press Save, like the editor today.

**Recommendation:** (a). An answer typed in the focus view should never be lost by closing the
tile, and rewriting a single slot keeps you and the agent from clobbering each other.

**Answer:** a)

---

### A5. Where a requested visual appears
You request a visual (queued in the file); on `review` the agent makes it.
(a) **Attached to the same question**, which is still unanswered so it isn't frozen. The
question stays open, now with the visual.
(b) Re-asked as a new question in the next round, with the visual.

**Recommendation:** (a). The append-only rule protects answered questions; adding a visual to
an open one changes no decision, and you don't have to answer the same thing twice under two
ids. The agent removes the `Visual requested` marker when it delivers.

**Answer:** a)

---

### A6. Can you answer a question that has a pending visual request?
**Recommendation:** Yes. The request is a wish, not a lock. If you answer before the visual
arrives, the agent skips making it.

**Answer:** reco

---

## Decisions (converged)

- **Where (R1-A1, R2-A1, R2-A2):** in the **Plan tile's Grill tab** only. The `plan-tile` flag is
  turned on by default. The Grill tab gains an **Answer** mode next to Edit / Preview / Slides and
  opens in it.
- **Source of truth (R1-A2):** `grill-me.md` stays authoritative. The UI parses it and writes only
  `**Answer:**` slots; new metadata comes as readable markers (`**Importance:**`, `- (a) …` options,
  `**Visual:**`, `**Visual requested:**`).
- **Handoff (R1-A3):** no send button; you still type `review`.
- **Importance (R1-B1–B3):** the agent tags Low / Medium / High / Blocking. You can override it, and
  the override is written as `(you)`. **Blocking** must be answered by you; `reco` isn't accepted. The
  filter is a threshold ("High and up") plus an "unanswered only" toggle.
- **Skipped questions (R1-B4, R2-A3):** recorded as `reco (default — not reviewed)` by **both** a
  **Finish round** button (summary, refuses while Blocking is open, doesn't message the agent) and the
  agent on `review` as a fallback for blanks. The agent won't converge while a Blocking question
  lacks your answer.
- **Writing (R2-A4):** each answer is saved immediately (debounced). The file is re-read before each
  write and only that question's slot changes.
- **Focus view (R1-C1–C3):** one question per screen with prev/next, keyboard (`←`/`→`, number keys
  pick an option, `Enter` goes next), and an overview strip coloured by importance and filled when
  answered. Option buttons plus a free-text note (`b — note`); a text box when there are no options.
  It opens on the latest open round; earlier rounds are read-only.
- **Recommendation (R1-D1–D3):** hidden until revealed per question, with a global "always show"
  setting. There's no "after seeing reco" marker. An **Accept recommendation** button appears only
  once revealed and writes `reco`.
- **Visuals (R1-E1–E3, E5):** mermaid (inline), images and HTML prototypes, shown per question and
  per option (side by side). Stored in `grill-assets/<question-id>/`, referenced with `**Visual:**`.
  Prototypes render in a sandboxed iframe (scripts allowed; no network, app access or top
  navigation; only the grill's own assets). The agent adds visuals itself when options differ in
  shape: mermaid by default, a prototype only for UI choices, at most one prototype per question
  unless asked.
- **Requesting visuals (R1-E4, R2-A5, R2-A6):** "Show me this" queues `**Visual requested:** <note>`
  in the file. On `review` the agent attaches the visual to the same (still open) question and
  removes the marker. Answering first is allowed, and the agent then skips the visual.
- **Skill (R1-F1, F2):** only `grill-me`'s template changes. Old grills open degraded: Medium
  importance, options parsed from `(a)/(b)/(c)` text where possible. `after-grill` must tolerate
  the new markers.
- **NFR (Z1):** "reco" = none beyond the prototype sandbox (E3). The ≤100 ms navigation figure
  was only a suggested candidate, not adopted.


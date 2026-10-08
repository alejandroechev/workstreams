---
id: "034"
status: Accepted
date: 2026-10-05
---

# ADR 034: Answering grills in the Plan tile — a parsed grill-me.md format and a focused Answer mode

## Status

Accepted (2026-10-05). Amends [ADR 010](010-feature-flags.md): the `plan-tile`
flag is removed and the Plan tile ships to everyone.

## Context

The `grill-me` skill interviews the owner through a markdown file,
`grill-me.md`, which they answer inline in an editor. With 15–30 questions per
round, answering in a raw document is slow:

- every question gets the same weight;
- the recommendation sits right above the answer slot and biases it;
- options are prose, so picking one means typing it;
- diagrams and prototypes that would settle a question quickly have nowhere to
  go.

The Plan tile already showed the grill, but only as a file (Edit / Preview /
Slides), and it was hidden behind the `plan-tile` flag.

## Decision

### 1. The grill file stays the single source of truth, with parsed markers

No new store. `grill-me.md` remains the decision record the agent reads on
`review`, and it stays readable by hand. A question is:

```markdown
### A1. Title
**Importance:** Low | Medium | High | Blocking        ← "(you)" when you overrode it
<context markdown, mermaid fences allowed>
- (a) option                                          ← old grills' "(a) option" also parsed
**Visual:** grill-assets/A1/file.html "Label" (a)     ← optional option key
**Visual requested:** note                            ← written by "Show me this"
**Recommendation:** …
**Answer:** …
```

Content before the first `## Round N` is Round 1, and ids repeat per round.
Fenced code is ignored when looking for markers; a fence closes only on a bare
delimiter of the same character at least as long as the opener (CommonMark). A question with no Importance
line is Medium, so every older grill opens unchanged. The parser and writers
are `src/domain/grill/`, and `scripts/grill-cli.mjs` gives the same operations
on the command line (`parse | answer | finish [--preview]`).

### 2. Writers change one slot, compare-and-swap

Each write (answer, importance override, visual request, finish round) re-reads
the file and replaces exactly one slot. It then writes with `write_text_file`'s
expected hash, and re-applies the edit if the file changed in between. So an
answer never overwrites a round the agent appended while you typed. Writers
refuse:

- an id that appears twice in the round (Finish round included);
- `reco` on a Blocking question;
- a **finished** earlier round;
- an answer that would change the file's structure — an unclosed fence, a
  `---` line or a heading would swallow or split the questions after it. The
  writer re-parses its own output and refuses unless every question is still
  there and the answer reads back exactly. The UI keeps such text as an unsaved
  draft and says why; failed saves of any kind keep the draft, with a Retry;
- a file with mixed CRLF/LF endings, because the native write normalises every
  line ending and would touch lines other than the answer's (Edit mode still
  works).

A round is writable while it still has an unanswered question, and the latest
round is always writable. This was looser at first ("only the latest open
round"), but a round the agent appends while you answer would then have locked
the one you were in the middle of.

### 3. Answer mode is the Grill tab's default

The Plan tile's mode selector becomes **Answer / Edit / Preview / Slides**.
Answer mode shows:

- one question per screen, with `←`/`→`/`Enter` to move and number keys to pick
  an option;
- an overview strip coloured by importance and filled when answered;
- a filter by importance ("High and up") and by unanswered;
- an importance override;
- autosave after a 500 ms pause, plus a 2 s poll for the agent's changes (no
  second file watcher on the same path as the hidden editor).

Earlier, finished rounds are read-only, and the view stays on the round it
opened even if a new one appears.

**Nothing is sent to the session.** You type `review` yourself. *Finish round*
writes `reco (default — not reviewed)` into the blanks after saying how many,
and refuses while a Blocking question is open. On review, the agent applies the
same fallback to blanks left in a plain editor.

### 4. The recommendation is hidden until asked for

This avoids anchoring. *Show recommendation* reveals it per question. *Accept*
appears only after revealing it, and never on a Blocking question. A global
setting, `grill.always-show-reco`, turns hiding off. Nothing records whether you
looked.

### 5. Visuals are confined and prototypes are sandboxed

Visuals load only from `grill-assets/` next to the grill. Any other path,
whether absolute, `..`, or a URL, is refused. They come in three kinds:

- **Images**: read as base64 through the backend.
- **Mermaid**: rendered from the context.
- **HTML prototypes**: shown in an `<iframe sandbox="allow-scripts" srcdoc=…>`.

A prototype runs in an opaque origin, so it cannot reach the app's DOM, storage
or `invoke`. Before rendering, a Content-Security-Policy `<meta>` is put at the very start
of the document, before any of the prototype's markup (searching for its
`<head>` was bypassable with a commented-out head): `default-src 'none'`, with
inline scripts and styles allowed and images and fonts only as `data:`. Its own
images are inlined as data URLs. A prototype's own CSP can only tighten this.
It cannot navigate the app (no `allow-top-navigation`).

A frame's own CSP cannot stop the frame navigating **itself** (`location.href`,
`<meta http-equiv="refresh">`). The app page therefore carries a frame-only
policy in `index.html`, `frame-src 'self' blob: data:`, which the browser
checks on every navigation of a child frame. A prototype that tries ends up on
the browser's error page, not on the network. The policy governs frames only
(the PDF viewer's `blob:` frames still load).

Visuals tied to an option show with that option, with a side-by-side
comparison. *Show me this* writes a `**Visual requested:**` marker. On review,
the agent:

- attaches the visual to the same question if it is still open;
- skips the visual if the question is already answered;
- removes the marker in both cases.

## Consequences

- The grill-me skill teaches the markers, including the importance levels, the
  Blocking rule, the visual rules (mermaid by default, at most one prototype
  unless asked) and the default fallback. `after-grill` treats the markers as
  metadata. Both skills live outside this repo.
- Old grills keep working: Medium everywhere, option buttons where their
  `(a)/(b)` lines can be recognised, text boxes elsewhere.
- Two writers can share the file safely. The hidden Edit-mode buffer sees
  Answer-mode writes as external changes through its own watcher.
- The prototype sandbox relies on the webview honouring `sandbox` + `srcdoc` +
  meta CSP. It is covered by Playwright in Chromium (WebView2's engine) and
  WebKit (WKWebView's engine): a hostile prototype's script runs, but `fetch`
  (even behind a commented-out `<head>`), `window.parent` access, top
  navigation, self-navigation, a meta refresh and a `../` image are all
  blocked.
- The Plan tile no longer depends on a flag. Without a linked session that has
  plans, it shows its existing empty state.

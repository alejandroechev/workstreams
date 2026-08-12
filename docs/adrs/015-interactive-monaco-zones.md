# ADR 015: Interactive Monaco view zones + a UI-bug reproduction harness

## Status
Accepted.

## Date
2026-07-07

## Context

Two long-standing UI bugs resisted repeated fixes: the **Edit/Delete** buttons on
Repo Explorer file comments and the **Resolve/Reopen** buttons on Code Review
comment threads were unclickable — clicking them placed the editor's text caret
(I-beam) instead of activating the button.

Both render their comment thread as a Monaco **view zone** (an inline DOM block
that reserves vertical space between lines). The root cause is a Monaco
paint/z-order fact: inside `.lines-content`, the layers are siblings with
`position:absolute; z-index:auto`, so they **paint in DOM order**:

```
view-overlays → view-rulers → view-zones → view-lines → contentWidgets → cursors-layer
```

`.view-lines` (the text + `monaco-mouse-cursor-text`) comes **after**
`.view-zones`, so it paints on top of the zone DOM and swallows clicks aimed at
buttons inside it. `pointer-events:auto` on the zone node and
`suppressMouseDown:true` on the zone don't help, because the problem is stacking,
not mousedown handling. (`contentWidgets` paints *above* `.view-lines`, which is
why Monaco's own floating UI is clickable — the documented "hybrid" fix is to
render interactive DOM as a content/overlay widget.)

A second, compounding problem: **our tests never caught this.** Vitest runs in
jsdom with Monaco fully mocked (zone nodes are attached to `document.body` and
`fireEvent.click`ed), so the buttons are trivially "clickable" in unit tests
while the real Monaco layering is never exercised. Every prior fix went green
and shipped broken. The real-browser repro existed only as throwaway scripts
that drove the whole app; the `cargo tauri dev` + CDP path was too slow/hung.

## Decision

### 1. Fix: lift `.view-zones` above `.view-lines` for opt-in editors

Rather than the heavier content-widget rework, we lift the whole `.view-zones`
layer above `.view-lines` **only for editors that opt in**, via a scoped CSS
class:

```css
/* src/styles/theme.css */
.interactive-zones .view-zones { z-index: 1; }
```

Zones only occupy their reserved vertical gaps (transparent elsewhere), so no
code text is covered and text editing/selection is unaffected. The pattern is
packaged in `src/ui/interactive-zones.ts`:

- `INTERACTIVE_ZONES_CLASS` — add to the editor **host** element (the div passed
  to `monaco.editor.create`, or the wrapper around `<DiffEditor>`).
- `markInteractiveZoneNode(node)` — call on each zone DOM node to set
  `pointer-events:auto`.

Adopted by `FileEditorView` (when `commentsEnabled`), the Repo Explorer
Unstaged DiffEditor modified-side comment layer, and the `CodeReviewTile` diff
editor. New inline-in-editor UIs should use this helper.

### 2. A dev/E2E component harness as the trustworthy signal

Because this bug class is invisible to jsdom, the authoritative check is
**Playwright driving real Monaco** via the existing `dev:e2e` Vite server:

- `?harness=<case>` (guarded in `src/main.tsx` behind `import.meta.env.VITE_E2E`
  / `DEV`, dynamic-imported, rendered **without** StrictMode) mounts one
  component in isolation with seeded data from `src/harness/cases.tsx`.
- `scripts/harness.mjs` (`npm run harness -- <case>`) reuses/cold-starts the
  server and proves each button is **actually clickable** — an `elementFromPoint`
  hit-test (diagnostic) plus a real click that must cause a state change.
- Durable cases graduate to `e2e/tests/comment-interactivity.spec.ts`, run by
  the existing CI Playwright job, so the occlusion bug cannot silently regress.

CDP-on-Tauri remains a documented **escalation** for genuinely Tauri/webview
-specific bugs, not the default.

## Consequences

- Comment buttons work in both tiles; verified GREEN by the harness and the CI
  interactivity spec.
- A reusable, low-friction loop exists for the next real-DOM UI bug: add a
  harness case, reproduce **red**, fix against the live repro, confirm **green**.
- Unit tests are explicitly scoped to logic/state; a note in the affected tests
  points to the harness for interactivity so nobody "fixes" a green unit test and
  assumes the UI works.
- Risk: the CSS lift is global to any editor carrying `INTERACTIVE_ZONES_CLASS`;
  it is applied narrowly (comment-enabled file editors + the code-review diff)
  and leaves non-opted editors untouched.

## Alternatives considered

- **Content/overlay widget hybrid** (view zone reserves space; interactive DOM
  in a `contentWidget` above `.view-lines`). More faithful to Monaco's intended
  layering but a larger rework; the harness proved the CSS lift sufficient, so we
  kept the smaller change. This remains the fallback if the CSS approach ever
  proves inadequate.
- **Beefing up the jsdom mocks** to emulate layering — rejected as brittle and a
  source of false confidence; jsdom has no real layout.
- **CDP-on-Tauri** as the primary signal — rejected for the inner loop (slow Rust
  build + WebView2 attach); kept as an escalation.

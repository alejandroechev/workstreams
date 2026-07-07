---
name: ui-harness
description: >-
  Reproduce and verify real-Monaco UI bugs (layout / z-index / pointer-events)
  that jsdom unit tests cannot see, using the isolated component harness driven
  by Playwright against the dev:e2e Vite server. Use when a UI element "looks
  right but doesn't work" (e.g. buttons inside Monaco view zones aren't
  clickable), or when validating a UI fix end-to-end. Trigger phrases: "run the
  harness", "repro this UI bug", "is the button actually clickable", "verify the
  comment buttons", "harness <case>".
---

# UI Component Harness

A fast, reliable loop for reproducing and verifying **real-browser** UI bugs in
Workstreams — the kind jsdom/Vitest can't catch because they mock Monaco and have
no layout/z-index/pointer-events.

## Why this exists

Vitest runs in jsdom with Monaco mocked, so a comment button can be "clickable"
in a unit test while being unclickable in the real app (a Monaco layer paints on
top of it). The harness mounts the **real component with real Monaco** in
Chromium via the existing `dev:e2e` Vite server, so clicks, occlusion, and
layout are faithful.

The authoritative signal is **Playwright-on-Vite**. `cargo tauri dev` + CDP is a
slower escalation reserved for genuinely Tauri/webview-specific bugs.

## The loop

```
npm run harness            # run all cases
npm run harness -- <case>  # run one case, e.g. comment-zone
```

The runner (`scripts/harness.mjs`) is the source of truth for flags/behavior —
don't duplicate its internals here. In short it:

- reuses a `dev:e2e` server on :5177 if one is up, else cold-starts one and
  leaves it running (fast inner loop);
- opens `http://localhost:5177/?harness=<case>` in real Chromium;
- proves each target button is **actually clickable, not just present**: a DOM
  hit-test (`elementFromPoint`) for a diagnostic ("covered by `<div.view-lines…>`")
  plus a real click that must produce a state change;
- writes a screenshot per case to `.dev/harness/<case>.png` and exits non-zero on
  any failure.

Read the printed diagnostic and **look at the screenshot** — a red run tells you
*which* layer is occluding the element.

## Typical bug workflow (red → fix → green)

1. Add/confirm a harness **case** that mounts the buggy component (see below).
2. `npm run harness -- <case>` → confirm it's **RED** with a real diagnostic
   (this is the missing capability; a reliable red is half the battle).
3. Iterate the fix in the component/CSS. Vite HMR picks up changes, so just
   re-run `npm run harness -- <case>` — no restart needed.
4. Stop when it's **GREEN** (hit-test clickable + click causes the state change).
5. Promote/keep the check in `e2e/tests/comment-interactivity.spec.ts` so CI
   guards it.

## Adding a new case

Cases live in `src/harness/cases.tsx` (a registry `caseId -> React component`).
Each case mounts ONE component full-viewport with seeded data:

- For editor/file components, use `makeInMemoryRegistry(path, content)`
  (`src/harness/fakeRegistry.ts`) so `FileEditorView` renders without the Tauri
  filesystem.
- For backend-driven tiles, seed a `MemoryBackend` (its `seed*` helpers) and
  pre-create state (e.g. `createReview` + `addReviewComment`) before rendering
  so the target UI is present on mount.
- Expose stable `data-testid`s on the elements the probe will target.

Then add the case to the `CASES` table in `scripts/harness.mjs` with its target
button selector and the expected state change (`expectVisible` or `expectText`),
and (if it's a durable concern) a matching assertion in the CI spec.

The harness route is **dev/E2E-only** (guarded in `src/main.tsx` behind
`import.meta.env.VITE_E2E` / `DEV` + a dynamic import) and is rendered **without
StrictMode** — StrictMode's double-mount races Monaco's async create/dispose.

## Notes / gotchas

- **jsdom can't see these bugs.** Keep unit tests for logic/state; interactivity
  is the harness's job.
- If Monaco never mounts for a `FileEditorView` case, check the fake registry
  handles `canonicalize_path` / `read_text_file` (a missing handler yields an
  undefined path and the editor silently no-ops).
- Screenshots accumulate under `.dev/harness/` (gitignored) — safe to delete.

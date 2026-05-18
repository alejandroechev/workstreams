# ADR 004 — Playwright E2E via Vite dev server with Tauri host shim

## Status
Accepted (2026-05-18).

## Context
The app already has three layers of automated coverage:
1. **Vitest unit tests** — domain logic, store ops, components, hooks.
2. **CDP visual validation** — Playwright over CDP on a real `cargo tauri dev`
   build (`scripts/cdp-feature.mjs`). Catches real runtime bugs but is slow
   (~30s/feature), requires a running Tauri host, and is single-process.
3. **Manual exploration** — the developer drives the app.

What was missing: fast, parallelisable Playwright tests that drive the React
UI through complex multi-step flows (e.g. the WS creation matrix: 3 repo
options × 2 session choices). The CDP layer is a poor fit — it expects a
prepared dev DB and can't easily seed per-test state.

## Decision
Run Playwright against the **Vite dev server** (`localhost:5177`) with an
environment flag `VITE_E2E=1` that:

1. Swaps `@tauri-apps/api/core`, `@tauri-apps/api/event`,
   `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener` for browser shims
   via Vite resolve aliases. The `invoke()` shim dispatches through
   `window.__WS_INVOKE_HANDLERS__` so each test can configure backend-level
   behaviour (e.g. `create_worktree` returning a synthetic path).
2. Selects `MemoryBackend` instead of `TauriBackend` in `main.tsx`.
3. Pre-seeds the in-memory backend with a "Demo" project so the workstream
   create form always has a repo to pick.

The Playwright config (`playwright.config.ts`) spawns `npm run dev:e2e` as
its `webServer`, runs against Chromium only, and lives in `e2e/tests/*.spec.ts`.

## Trade-offs

| Concern | Resolution |
|---|---|
| Tests miss real Tauri runtime bugs | CDP layer still owns that; this layer is for UI flows |
| `invoke()` mocks could drift from real signatures | Per-test handlers keep mocks minimal and explicit |
| Extra `MemoryBackend` code path in `main.tsx` | Gated behind `import.meta.env.VITE_E2E` — zero impact on production bundle |
| Different ports (Vite 5177 vs Tauri dev 1420) | Playwright uses Vite; CDP runner uses Tauri |

## Consequences
- New developer-facing commands: `npm run test:e2e`, `npm run test:e2e:ui`.
- The shims under `src/test-shims/` must stay in lockstep with the real Tauri
  module signatures used by the app.
- E2E specs are excluded from vitest collection in `vitest.config.ts`.
- The discipline gates do not require Playwright runs (still optional);
  CDP remains the authoritative visual proof.

## Alternatives considered
- **Playwright on the real Tauri app for everything** — too slow for the
  number of UI flows we'll want to cover; also requires shutting down the
  prod app.
- **MSW or fetch interception** — doesn't help because the app talks to
  `@tauri-apps/api/core::invoke`, not HTTP.
- **Component tests in vitest** — already used for the form behavior tests,
  but they can't validate multi-component flows like "submit form → see WS
  in sidebar → tile is pinned".

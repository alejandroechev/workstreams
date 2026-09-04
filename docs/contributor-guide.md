# Contributor guide

> This file is for people working *on* Workstreams. End users want the
> [README](../README.md).

## Setup

1. Clone the repository
2. `npm install` (also installs the local git hooks via the `postinstall`
   script — see `scripts/install-hooks.mjs`)
3. `cargo tauri dev` (first build ~5 min, subsequent ~20 s)

## Commands

```bash
cargo tauri dev      # Development (NO CDP)
npm run tauri:dev    # Development WITH CDP enabled (for visual validation)
cargo tauri build    # Production build (CDP disabled — never shipped)

npm test             # Unit tests (vitest)
npm run test:coverage  # Unit tests + 90% coverage gate
npm run test:e2e     # Playwright E2E tests (Vite dev server + MemoryBackend)
npm run harness -- <case>             # Reproduce/verify a real-Monaco UI bug in isolation
npx tsc --noEmit     # Type check

npm run lint                          # ESLint over src/
npm run cdp:feature -- <feature-id>   # Per-feature visual validation (ADR-003)
npm run cdp:seed                      # Seed dev DB + showcase markdown
npm run dev:reset                     # Reset dev state (.dev/ folder)
npm run dev:kill                      # Kill the dev Tauri process by PID
npm run hooks:install                 # Re-install git hooks
```

## Test pyramid

```
┌─────────────────────────────┐
│  CDP + Playwright on Tauri  │  ← Catches real runtime bugs
│  (Desktop)                  │    (white screens, plugin issues)
├─────────────────────────────┤
│  Playwright on Dev Server   │  ← Fast CI, tests React UI flows
│  (localhost:1420)           │    (90%+ coverage of user interactions)
├─────────────────────────────┤
│  Vitest Unit Tests          │  ← Domain logic, store ops,
│  (InMemoryStore)            │    components, hooks (≥90% coverage)
└─────────────────────────────┘
```

## E2E tests (Playwright)

`npm run test:e2e` boots Vite with `VITE_E2E=1` (port 5177), which swaps the
Tauri host for an in-memory backend and shimmed `@tauri-apps/api/*` modules.
Tests in `e2e/tests/*.spec.ts` drive the React app via Playwright and can
configure per-test `invoke()` handlers through
`window.__WS_INVOKE_HANDLERS__`. Useful for validating multi-step UI flows
(workstream creation, session linking, etc.) without needing the real Tauri
runtime. See `e2e/tests/ws-create.spec.ts` for the canonical example.

## Demo recordings

Published demos are declared in `demos/manifest.json` and recorded by dedicated
Playwright scenarios in `e2e/demos/`. The recorder runs the Vite E2E app with
the `MemoryBackend`; it does not start Tauri or read the production database.
Scenarios must use synthetic names, paths, source, comments, task text, terminal
output, and session IDs, and must reach the final visual through the same
visible controls a user drives.

### Prerequisites and commands

Install project dependencies first, then install Playwright's Chromium and
ffmpeg bundle. The host also needs `ffmpeg` and `ffprobe` on `PATH`; recording
the overview GIF additionally requires `gifski`.

```bash
npm install
npx playwright install chromium ffmpeg

npm run demos:record  # Re-record every manifest clip and refresh source hashes
npm run demos:check   # Read-only validation; never regenerates or mutates media
```

`demos:record` fixes the viewport at 1280×800 and uses the dark theme. It writes
raw recordings and temporary GIF frames only under `.dev/demo-media/<clip-id>/`,
publishes the encoded artifacts below, updates each manifest `sourceHash`, and
removes the temporary workspace. Do not commit `.raw.webm` files or frame
directories.

| Clip | Deterministic fixture and visible flow | Generated outputs and limits |
| --- | --- | --- |
| `overview` | Synthetic Atlas/Beacon workstreams, files, session, and PTY output; opens a workstream and adds Repo Explorer and Terminal tiles | `overview.webm` (VP9, 6 MB), `overview.mp4` (H.264/yuv420p/faststart, 8 MB), `overview.png` (PNG, 2 MB), `overview.gif` (gifski, 12 MB); video/GIF ≤30 s |
| `goal-loop` | Synthetic retry-reliability YAML, task, verifier, evaluator, timings, and session data; opens the definition, runs, pauses, resumes, and expands evidence | `goal-loop.webm` (VP9, 6 MB), `goal-loop.mp4` (H.264/yuv420p/faststart, 8 MB), `goal-loop.png` (PNG, 2 MB); videos ≤30 s |
| `local-code-review` | Synthetic Orbit working-tree diff and bound session; creates a review, selects the added line, and submits an inline comment | `local-code-review.webm` (VP9, 6 MB), `local-code-review.mp4` (H.264/yuv420p/faststart, 8 MB), `local-code-review.png` (PNG, 2 MB); videos ≤30 s |

All outputs live in `docs/assets/demos/`, are linked from `README.md`, and are
published by `site/index.html` as `assets/demos/<name>`. The overview GIF is the
only GIF fallback. Every artifact is 1280×800.

### Determinism, provenance, and review

The shared fixture starts recording only after the root, fonts, and two
animation frames settle; scenarios wait on observable UI state and retain the
final settled result for at least one second. Keep chapter overlays brief and
show real UI underneath them. Prefer action annotations for interaction
clarity.

The source hash covers the clip declaration (including encoding and budget
settings), shared recorder/configuration sources, the scenario, and every
clip-specific visual source listed in the manifest. If any of those inputs
change, `npm run demos:check` rejects the old media as stale. The check also
probes codec, dimensions, duration, pixel format, MP4 faststart, byte budgets,
and every declared README/site reference; it intentionally does not compare
encoded bytes.

Before committing, watch each WebM and MP4 from start to finish and inspect its
poster (plus the overview GIF). Confirm the clip starts and ends on settled
frames, actions and text are legible, overlays clear, the final state is real,
and no personal path, live repository data, credentials, notifications, or real
Copilot content appears. Then run `npm run demos:check` and stage only the
scenario/source changes, `demos/manifest.json`, reviewed outputs, and their
publication/documentation updates.

## Component harness (real-Monaco UI bugs)

jsdom/Vitest mocks Monaco and has no layout/z-index/pointer-events, so a class
of bugs is invisible to unit tests (e.g. buttons inside Monaco **view zones**
being unclickable because the text layer paints on top). The **component
harness** reproduces these against real Monaco, fast, without driving the whole
app:

```
npm run harness              # run all cases
npm run harness -- <case>    # e.g. comment-zone | review-thread
```

`?harness=<case>` (dev/E2E-only, guarded in `src/main.tsx`) mounts a single
component with seeded data from the `src/harness/cases.tsx` registry.
`scripts/harness.mjs` reuses/cold-starts the `dev:e2e` server, then proves each
target button is **actually clickable** (a `elementFromPoint` hit-test plus a
real click that must cause a state change), screenshotting to `.dev/harness/`.
Durable cases graduate to `e2e/tests/comment-interactivity.spec.ts` (CI). See
the `ui-harness` skill in `.github/skills/`.

## Per-feature visual validation

Every UI feature is validated by running it against a Tauri dev build via
CDP. **CDP is dev-only** — `tauri.conf.json` ships with no remote-debugging
port; it's enabled only via the `tauri.conf.dev.json` overlay passed to
`tauri dev`. The release binary cannot be inspected via CDP, so dev runs
never conflict with your working production session.

Workflow:

1. The runner uses an isolated dev DB at `.dev/workstreams-dev.db`.
2. Connects Playwright over CDP, navigates, captures console + page errors.
3. Saves a screenshot under `screenshots/<feature-id>/`.

See [ADR-003](adrs/003-cdp-feature-validation.md).

## Git hooks

Hooks live in `.githooks/` (tracked) and are wired by
`scripts/install-hooks.mjs` (auto-run via `npm` postinstall). They mirror CI.

- **Pre-commit** — ESLint (staged files), `vitest run --changed`,
  test-file-exists, `cargo fmt --check`. Fast incremental gate.
- **Pre-push** — `tsc --noEmit --incremental`, `vitest run --coverage`
  (90% threshold), `cargo clippy -D warnings`, smart doc gate (>200 source
  lines without a doc touch fails unless the commit message includes
  `[no-docs: <reason>]`).

**Do not bypass** with `--no-verify` without asking. Each hook prints a
loud "AGENT NOTICE" block on failure with the same warning.

## CI

Two workflows, with strictly separated responsibilities:

- **`.github/workflows/ci.yml`** runs on every push to `master` (and on PRs).
  It executes every check the pre-push hook runs, plus Playwright E2E and
  `cargo test --lib`. It does **not** build the Tauri installer and does
  **not** create tags or releases.

- **`.github/workflows/release.yml`** is **manual**. Trigger it via
  GitHub → Actions → "Release" → "Run workflow":
  - Leave the `version` input blank to auto-compute the next semver tag
    from conventional-commit history since the last tag (`feat:` → minor,
    `fix:` → patch, `BREAKING CHANGE` → major).
  - Or enter an explicit tag like `v0.3.0` to override.

  The workflow stamps the version into `package.json` + `tauri.conf.json`,
  runs `tauri build` on `windows-latest`, creates the git tag, and publishes
  a GitHub Release with the NSIS installer, MSI installer, and raw
  `workstreams-vX.Y.Z.exe` attached.

## Releases

### Bump rules (when auto-computing)

The bump is derived from [Conventional Commits](https://www.conventionalcommits.org/)
across the range since the previous tag.

| Commit prefix | Bump kind | Example |
|---|---|---|
| `feat:` / `feat(scope):` | **minor** | `feat(repo): add Diff tab filter` |
| `fix:` / `perf:` / `refactor:` / `chore:` / `test:` / `style:` / `build:` / `ci:` / `revert:` | **patch** | `fix(window): grant allow-destroy permission` |
| `docs:` only | **none** — auto-compute refuses to release (set `version` explicitly to override) | `docs: update tutorial` |
| `<any-type>!:` or body contains `BREAKING CHANGE:` | **major** | `feat!: rewrite tile persistence schema` |
| Anything else (no recognised prefix) | **patch** (safe default) | — |

The **strongest** bump across the range wins. If several commits are batched
(`fix:` + `feat:` + `docs:`), the result is a **minor** bump.

```
v0.1.0 → fix: …                      → v0.1.1
v0.1.1 → feat: …                     → v0.2.0
v0.2.0 → docs: …                     → auto-compute refuses (use explicit version)
v0.2.0 → docs: …    + fix: …         → v0.2.1
v0.2.0 → feat: …    + fix: …         → v0.3.0
v0.2.0 → feat!: …                    → v1.0.0
```

### Release notes

The published release body leads with a **Highlights** section lifted from
`CHANGELOG.md` by `scripts/changelog-section.mjs`: it looks for a section
matching the tag, then falls back to `[Unreleased]`. The raw commit log is kept
but collapsed beneath it.

So before cutting a release, move the `[Unreleased]` entries in `CHANGELOG.md`
under a new version heading. If no entry is found the release still publishes,
with a note saying curated notes were missing — it degrades rather than
blocking.

### Source-of-truth files

- `package.json` `"version"` and `src-tauri/tauri.conf.json` `"version"` are
  **decorative** — they are stamped at release time from the resolved tag.
  Their committed value is what the dev binary reports between releases.
- Git tags `v<major>.<minor>.<patch>` are the actual source of truth.

## Process safety — never kill by name

The dev build (`cargo tauri dev`) and the production build both ship as
`workstreams.exe` (Cargo derives the binary name from the package name).
The user usually has the production app running locally.

- **Never** run `Stop-Process -Name workstreams`, `taskkill /IM
  workstreams.exe`, or any other name-based termination. Doing so will kill
  the user's production app and any work in flight there.
- To stop the dev instance spawned by `scripts/cdp-feature.mjs`, run
  `npm run dev:kill`. It reads `.dev/dev.pids` and uses `taskkill /T /PID`
  on that specific PID only after verifying CDP :9223 is alive.
- The same rule applies to `cargo`, `cargo-tauri`, `rustc`, and `link.exe`:
  always kill by explicit PID, never by name.

## Architecture

See [`docs/system-diagram.md`](system-diagram.md) for the full architecture
diagram and `docs/adrs/` for design decisions.

## Bypass mechanisms (use sparingly, ask first)

- `[no-docs: <reason>]` in a commit message → skips smart doc gate
- `// @test-skip: <reason>` in first 5 lines of source → skips test-file-exists check

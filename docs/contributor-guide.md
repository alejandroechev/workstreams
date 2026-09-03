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

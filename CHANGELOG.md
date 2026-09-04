# Changelog

All notable changes to Workstreams are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project aims to follow [Semantic Versioning](https://semver.org/).

Entries describe what changed for someone *using* the app. The full commit log
for any release is attached to its
[GitHub release](https://github.com/alejandroechev/workstreams/releases).

## [Unreleased]

### Added

- `CODE_OF_CONDUCT.md`, issue forms and a pull request template, so the project
  states how to contribute and what to expect.
- An index for the Architecture Decision Records at `docs/adrs/`, listing every
  record with a one-line summary and its status, including the ones that have
  been retired or superseded.
- A database model reference at `docs/db-model.md`, linked from the README for
  the first time.
- This changelog.
- A machine-checked demo-media manifest and recording command now guard clip
  provenance, encoding, size budgets, publication references, and legacy GIF
  retirement.
- A deterministic Playwright screencast harness records isolated demo scenarios
  against synthetic in-memory data without launching the desktop app.
- The published overview now demonstrates workstream context and adaptive
  Copilot, Repo Explorer, and terminal tiling in WebM, MP4, PNG, and GIF formats,
  with playback controls and a clean high-motion-quality GIF fallback.

### Changed

- `CONTRIBUTING.md` is now about how to get a change accepted, including an
  explicit policy on AI-assisted contributions. Its previous release and
  versioning content moved to the contributor guide.

- The README is restructured around what the app does for you. It is now a
  third of its previous length, install instructions sit near the top instead
  of halfway down, and the long-form detail moved to
  `docs/features-detailed.md`, which gained the goal loop, task board, code
  review, code walkthrough and search sections it was missing.
- Release notes now lead with a curated summary drawn from this file rather
  than opening with the commit SHA.

### Fixed

- The duplicate ADR number 004: the Repo Explorer record is now 024.

## [0.7.0] - 2026-09-03

### Added

- **Goal loops.** Author a reusable YAML definition and let a bounded
  orchestrator→worker pipeline run it against the repo until the objective is
  met. Every loop must carry deterministic verification, an independent
  evaluator, human approval, or a combination. Runs pin the definition by
  SHA-256, record a measured per-stage time breakdown, and can be paused,
  closed, and resumed after an app restart. Definitions are editable from the
  Goal Loop tile and scriptable through `npm run loop:cli`.
- **Task board improvements.** Per-column tinting with lane separators and a
  clearly salient In progress column, clickable URLs in log entries and notes,
  `Enter` to commit a label or subtask, hidden completed subtasks on cards, and
  opening the detail pane on the task you just created.
- A GitHub Pages landing page.

### Changed

- Loop runs are presented overview-first: state, elapsed time and the slowest
  stage lead, while the definition, task list and event timeline stay
  collapsed. Tasks are listed newest-first with a sort toggle and state filter.
- Session Meta lists configuration items alphabetically within each category.

### Fixed

- Wrapped terminal input no longer loses its first row, and the cursor stays
  over the character it is actually on while you edit.
- Loop verifiers inherit the login shell's `PATH` on macOS, so a verifier
  calling `npm` or `cargo` resolves it the same way a terminal does.
- Transient Copilot SDK startup failures are retried instead of failing the
  run outright.
- Every spawned PTY child process is collected rather than leaked.

## Earlier releases

Curated notes start at 0.7.0. For 0.6.0 and earlier, see the commit log
attached to each [GitHub release](https://github.com/alejandroechev/workstreams/releases).

[unreleased]: https://github.com/alejandroechev/workstreams/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/alejandroechev/workstreams/releases/tag/v0.7.0

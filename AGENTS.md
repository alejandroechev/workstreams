# Agent Manager

## Description

Workstream manager with tiling compositor for Copilot CLI — manage projects, persist sessions, embed terminals with adaptive tiling layouts, code viewers, and doc viewers.

## Code Implementation Flow

### Pre-Development
- **Read ADRs** Before starting any development work, read all Architecture Decision Records in `docs/adrs/` to understand existing design decisions and constraints. Do not contradict or duplicate existing ADRs without explicit user approval.

### Architecture
- **TypeScript + Rust** Use TypeScript for the frontend (React) and Rust for the backend (Tauri). Domain logic that doesn't need native APIs should live in TypeScript.
- **Domain Logic Separation** Separate domain logic from UI. Core workstream/tile/session management should be testable without rendering.
- **CLI** Always implement a CLI with feature parity to UI layer. This is a tool for you as an agent to validate your work.
- **Tauri** Desktop app built with Tauri v2 framework.
- **Language Convention** UI text visible to users is in English. All code (variables, functions, types, comments), documentation, and test descriptions must be in English.
- **UI Iconography** For web/desktop interfaces, use **Heroicons** via `@heroicons/react` instead of emoji or raw Unicode glyphs for buttons, navigation, banners, and status chips. Keep icon choices consistent through a shared `src/ui/components/icons.tsx` mapping/helper.
- **In-Memory Stubs for External Integrations** For every external service integration (databases, APIs, third-party services), implement an in-memory stub that conforms to the same interface. Use a provider/factory that auto-selects the real implementation when credentials are configured, and falls back to the in-memory stub when they are not. This ensures E2E tests, CLI validation, and local development work fully offline without external dependencies.

### Git Workflow
- **Work directly on master** — solo developer, no branch overhead
- **Commit after every completed unit of work** — never leave working code uncommitted
- **Push after each work session** — remote backup is non-negotiable. Remote for this repo at https://github.com/alejandroechev/agent-manager.git
- **Tag milestones**: `git tag v0.1.0-mvp` when deploying or reaching a checkpoint
- **Branch only for risky experiments** you might discard — delete after merge or abandon

### Coding — TDD Workflow (strict, per-function)

1. **RED** — Write a failing test FIRST. Run it. Confirm it fails. Show the failure output.
2. **GREEN** — Write the MINIMUM implementation code to make the test pass. Run the test. Confirm it passes.
3. **REFACTOR** — Clean up if needed. Run the test again to confirm it still passes.
4. Repeat for the next behavior/function.

### Coding — E2E and CLI Tests (per-feature, not batched)

For every user-facing feature, before considering it complete:
- **E2E Test** — Write a Playwright E2E test that exercises the feature end-to-end. Run it. Confirm it passes.
- **CLI Scenario** — Write a CLI scenario AND execute it using the CLI. Confirm the output matches expectations.

### Testing Pyramid (all three levels required)

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

### Validation — Automated Enforcement

Validation is enforced automatically by two layers:

1. **Git Hooks** (`.husky/pre-commit` and `.husky/pre-push`) — Runs actual validation commands:
   - Pre-commit: `tsc -b` + `vitest run --coverage` + `eslint`
   - Pre-push: E2E tests + CDP visual validation on real Tauri app

2. **Copilot CLI Extension** (`.github/extensions/`) — Intercepts agent actions in real time.

### Documentation
- **Docs hierarchy**: ADRs are the source of truth for architecture decisions, README is the public summary that links back to ADRs, and AGENTS.md contains process rules only.
- **README** Update readme file with any relevant public change to the app
- **System Diagram** Keep always up to date a mermaid system level diagram of the app architecture in docs/system-diagram.md
- **ADR** For every major design and architecture decision add an Architecture Decision Record in docs/adrs
- **Docs sync** After every feature or fix, review `git diff --stat` against README.md, `docs/system-diagram.md`, and `docs/adrs/`. Update only what is stale.

### Commit Checklist

Before running `git commit`, verify:
- ⚡ Source files have corresponding test files?
- ⚡ All tests pass with ≥ 90% statement coverage?
- ⚡ Zero type/lint errors?
- [ ] Every new function/component was built with TDD (red → green → refactor)?
- [ ] E2E tests exist for every new user-facing feature?
- [ ] CLI scenarios exist and have been executed for every new feature?
- [ ] **Docs sync** completed?
- [ ] README updated (if public-facing change)?
- [ ] System diagram updated (if architecture changed)?
- [ ] ADR written (if major design decision)?

# ADR-001: Workstream + Tiling Architecture

## Status
Accepted

## Context
A power user runs 3-10 parallel Copilot CLI sessions across repos/worktrees. No tool combines terminal multiplexing + AI session awareness + project persistence. Two prototypes were validated:
- **Monolith MVP** — Single Tauri process with PTY spawning, xterm.js, SQLite persistence
- **Tiling Compositor** — Adaptive tiling layout engine with keyboard navigation

## Decision
Merge both approaches into a unified architecture:
- **Workstream** = top-level project/task container (replaces ambiguous "session" term)
- Each workstream has its own **tiling layout** with multiple **tile types** (terminal, code viewer, doc viewer)
- **Rust owns state** (workstreams, tiles, PTY lifecycle, persistence). React owns transient UI.
- **SQLite** for persistence (matches Copilot CLI's own format). Automerge deferred to V2.
- **V1 restore = respawn + scrollback**, not live PTY reattachment (ConPTY handles lost on crash)

## Consequences
- Simpler single-process architecture (no daemon needed for V1)
- Per-workstream independent tile layouts persisted as JSON
- Terminal scrollback saved as compressed blobs with 1MB max, periodic 30s saves
- Future daemon architecture possible for V2 live crash resilience

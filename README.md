# Workstreams

> **v0.2.0** — Desktop app

Project-aware workstream manager with tiling compositor for Copilot CLI — manage projects, persist sessions, embed terminals with adaptive tiling layouts, code viewers, and doc viewers.

## Features

- **Workstream management** — Create, switch, and persist project workstreams with git repo detection
- **Adaptive tiling** — Tiles auto-arrange: 1=fullscreen, 2=split, 3=focus+stack, 4=grid, 5+=focus+grid. The fullscreen tile has a distinct yellow border to make the mode obvious at a glance.
- **Terminal tiles** — Full interactive terminals via xterm.js + portable-pty (ConPTY on Windows)
- **Code viewer tiles** — Monaco Editor read-only with syntax highlighting for 20+ languages
- **Doc viewer tiles** — VS Code-style markdown renderer with GFM support, syntax-highlighted code blocks, and inline **Mermaid diagrams** with zoom/pan
- **Session persistence** — Workstreams, tile layouts, and terminal scrollback survive app restarts
- **Keyboard-driven** — hjkl navigation, n/c/d for new tiles, Ctrl+1-9 for workstream switching
- **Copilot CLI enrichment** — Reads session-store.db for context %, turn count, summaries

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Tauri v2 (Rust backend + WebView2 frontend) |
| Frontend | React 19 + Vite + TypeScript |
| Terminal | xterm.js + portable-pty (ConPTY) |
| Code Viewer | Monaco Editor (read-only) |
| Doc Viewer | react-markdown + remark-gfm + react-syntax-highlighter + Mermaid (vendored) |
| Persistence | SQLite (rusqlite) with WAL |
| Theme | Catppuccin Mocha |

## Requirements

- Node.js 18+
- Rust toolchain (cargo)
- Tauri CLI v2 (`cargo install tauri-cli`)
- Windows 10/11 (primary platform)

## Setup

1. Clone the repository
2. `npm install`
3. `cargo tauri dev` (first build ~5min, subsequent ~20s)

## Commands

```bash
cargo tauri dev      # Development with hot reload (auto-uses ./.dev/workstreams-dev.db)
cargo tauri build    # Production build
npm run test         # Unit tests
npx tsc --noEmit     # Type check
npm run cdp:feature -- <feature-id>   # Per-feature visual validation (see ADR-003)
npm run cdp:seed     # Seed dev DB + showcase markdown
npm run dev:reset    # Reset dev state (.dev/ folder)
```

## Per-Feature Visual Validation

Every UI feature is validated by running it against the real Tauri app via
CDP. The runner reuses a live `cargo tauri dev` instance (or cold-spawns one
with an isolated dev DB at `.dev/workstreams-dev.db`), navigates to the
feature, captures console errors, and saves a screenshot under
`screenshots/<feature-id>/`. A `visual_proofs` row gets written so the
discipline system can confirm the validation happened.

See `docs/adrs/003-cdp-feature-validation.md` for the design.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New terminal tile |
| `c` | New code viewer tile |
| `d` | New doc viewer tile |
| `x` | Close focused tile |
| `f` | Toggle fullscreen |
| `hjkl` / arrows | Navigate tiles |
| `Esc` | Unfocus terminal |
| `1-9` | Jump to tile by number |
| `Ctrl+1-9` | Switch workstream |

## Architecture

See `docs/system-diagram.md` for the full architecture diagram and `docs/adrs/` for design decisions.

## License

Private use.

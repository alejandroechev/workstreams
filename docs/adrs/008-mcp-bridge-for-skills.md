# ADR 008: MCP bridge for Copilot CLI skills

## Status

Accepted (MVP scope — single tool `create_diff_review` end-to-end)

## Context

Workstreams exposes its domain operations (workstream CRUD, tile CRUD, diff
review, plan tracking) as `#[tauri::command]` functions. These commands are
reachable **only from the webview's JS bridge via `invoke()`** — there is no
HTTP, IPC, or stdio surface.

This breaks any skill running inside a Copilot CLI session spawned by a
Workstreams tile. The skill sees its own env vars (`WORKSTREAMS_ACTIVE_WS`,
`WORKSTREAMS_ACTIVE_TILE` — ADR 007) and knows it's inside a workstream, but
has no way to call `create_diff_review`, `set_review_plan`, `activate_chunk`,
etc. The diff-grok skill (ADR 007) discovered this gap at runtime.

## Decision

Add a separate **MCP server** (Model Context Protocol, stdio JSON-RPC) that
Copilot CLI auto-spawns and exposes Workstreams operations as MCP tools.

### Why MCP (not other options)

Considered three options:

| Option | Pros | Cons |
|---|---|---|
| **MCP server** | Idiomatic Copilot CLI surface, agents see tools natively, JSON I/O, scales to many tools | New process, needs cross-process notification for live UI updates |
| CLI subcommand (`workstreams.exe rpc ...`) | Trivial to implement | Process-per-call, agents have to parse stdout, not idiomatic |
| Local HTTP server in Tauri | Native event emission, single process | Port management, auth tokens, curl/Invoke-RestMethod ugliness from skills |

MCP wins because Copilot CLI agents already understand the protocol — they
introspect tools, see schemas, validate inputs, and surface failures
uniformly. Skills become much shorter (no shell-parsing).

### Architecture

```
┌────────────────────────────────────────────────┐
│ Workstreams.exe (Tauri)                        │
│  ┌──────────────────────────────────────────┐  │
│  │ Webview (React)                          │  │
│  │  └─ invoke("create_diff_review", ...) ───┼──┐
│  └──────────────────────────────────────────┘  │ │
│  ┌──────────────────────────────────────────┐  │ │
│  │ Tauri commands (diff_review.rs etc.)     │◄─┼─┘
│  │  └─ rusqlite → DB                        │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ PTY → Copilot CLI tile                   │  │
│  │ env: WORKSTREAMS_ACTIVE_WS, _TILE,       │  │
│  │      WORKSTREAMS_DB_PATH                 │  │
│  └──────────────────────────┬───────────────┘  │
└─────────────────────────────┼──────────────────┘
                              │ spawns
                              ▼
┌────────────────────────────────────────────────┐
│ Copilot CLI                                    │
│  └─ reads ~/.copilot/mcp-config.json           │
│     spawns workstreams-mcp (stdio)             │
│       ┌────────────────────────────────────┐   │
│       │ workstreams-mcp.exe                │   │
│       │  - reads same DB via WORKSTREAMS_  │   │
│       │    DB_PATH                         │   │
│       │  - exposes diff-grok tools         │   │
│       │  - writes → same SQLite file       │◄──┼── same DB!
│       └────────────────────────────────────┘   │
└────────────────────────────────────────────────┘
```

### Cross-process notification (deferred — MVP works without it)

For the MVP, the MCP server only writes to the DB. The Tauri app does **not**
get a live "tile-created" event when the MCP inserts data. Workaround for the
MVP validation loop:

1. Agent calls MCP tool → review row + chunks inserted.
2. User presses **Alt+G** in the app → existing `list_active_diff_reviews`
   reads the DB and finds the new review → existing
   `create_or_focus_diff_review_tile` opens the tile.

This loop validates the integration end-to-end without needing real-time
notification. Real-time updates (so the app picks up MCP writes
automatically) is a follow-up — likely a named pipe or SQLite
`update_hook` polling.

### Scope of the MVP

**Implemented** (this ADR):

- `workstreams-mcp` Node binary in `~/.copilot/mcp-servers/workstreams-mcp/`
- Registered in `~/.copilot/mcp-config.json`
- One tool: `create_diff_review(diff_source, source_ref, demo_chunks?)`
  - Inserts a `diff_reviews` row + (optionally) demo chunks/hunks
  - Uses `WORKSTREAMS_ACTIVE_WS` (errors clearly if unset)
  - Uses `WORKSTREAMS_DB_PATH` (errors clearly if unset)
- Validation flow: user opens Copilot tile → agent calls tool → presses Alt+G
  → diff review tile opens with chunks rendered.

**Deferred** (next iteration once MVP validates):

- Remaining diff-grok tools: `set_review_plan`, `activate_chunk`, `ack_chunk`,
  `add_comment`, `complete_review`, `list_chunks`, `get_chunk_details`,
  `detect_drift`.
- Real-time tile-created emission when MCP writes (named-pipe ping, or DB
  watcher in Tauri).
- Other domains (workstream/project CRUD, plan tile, terminal control).
- Migrating skill prompts to call MCP tools instead of describing what should
  happen.

## Consequences

**Positive:**
- Skills become genuinely callable from Copilot CLI sessions inside
  Workstreams tiles.
- Each new domain capability gets a uniform exposure path (Tauri command for
  webview + MCP tool for skills).
- Agents see typed tool schemas + descriptions → fewer hallucinations.

**Negative:**
- Two implementations of every operation (Tauri command + MCP tool). Mitigation
  later: extract a shared `workstreams-core` library that both call into. For
  the MVP, the MCP server inlines DB ops because they're small.
- The MCP server can write to the DB while the Tauri app is also writing.
  SQLite handles concurrent readers + one writer at a time; for the MVP this
  is acceptable. Consider switching to WAL mode if contention shows up.
- The MCP server is registered globally (in `~/.copilot/mcp-config.json`), so
  every Copilot CLI session spawns it. The server gracefully no-ops (returns
  an error from tool calls) when `WORKSTREAMS_ACTIVE_WS` is unset.

## Validation

1. `npm install` in `~/.copilot/mcp-servers/workstreams-mcp/`.
2. Restart Copilot CLI / spawn a fresh Copilot tile from `cargo tauri dev`.
3. In the tile, ask the agent to call `mcp__workstreams__create_diff_review`.
4. The agent reports a `review_id`.
5. User presses **Alt+G** in the app → Diff Review tile opens.
6. Tile renders the demo chunks the MCP server seeded.

If step 3 fails because the tool isn't available, check `~/.copilot/mcp-config.json`
and the stderr of the Copilot CLI session.

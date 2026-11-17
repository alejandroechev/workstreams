---
name: diagram
description: 'Read and add to the user''s Workstreams Diagram boards (Excalidraw whiteboards) from a Copilot session running inside Workstreams. Uses the `workstreams agent` CLI over a local socket; no MCP, no secrets. Only works inside a Workstreams session tile, gated on $WORKSTREAMS_SOCKET. Trigger phrases - "/diagram", "read my diagram", "look at my Ideas board", "draw this as a diagram", "add a sequence diagram to my board", "sketch the architecture on my whiteboard".'
---

# Diagram boards (agent side)

The user sketches in **Diagram tiles**: Excalidraw whiteboards inside their
workstream, each holding named **boards**. You can read a board as text (to use
the sketch as context) and add a diagram to it (to sketch something for them).
You never delete or move what the user drew: additions are only ever appended,
placed to the right of the existing drawing.

## First: are you inside Workstreams?

```sh
[ -n "$WORKSTREAMS_SOCKET" ] && echo inside || echo outside
```

If that prints `outside`, you cannot reach the boards. Say so, and give the
diagram as Mermaid text in the terminal instead.

## List the boards

```sh
workstreams agent call diagram.list
```

Returns this workstream's boards: `id`, `name`, the tile, how many shapes and
connections each holds, and `pending_additions`. Boards of other workstreams
are never visible. If there are no boards, ask the user to add a Diagram tile
(`Alt+G`).

## Read a board

```sh
workstreams agent call diagram.get board=Ideas
```

`board=` is a board id or its name (names match case-insensitively; use the id
when two boards share a name). The `text` field reads the board as one line per
shape and per connection:

```text
Board "Ideas": 2 shapes, 1 connections
- rectangle "API"
- rectangle "DB"
- "API" -> "DB" "reads"
```

`shapes` and `connections` carry the same as JSON. Free-hand strokes and images
have no text; images are only counted.

## Add a diagram

Write the diagram as **Mermaid** and send it on stdin:

```sh
workstreams agent call diagram.add board=Ideas mermaid=@- <<'END_OF_MERMAID'
flowchart LR
  Client --> API
  API --> Queue
  Queue --> Worker
END_OF_MERMAID
```

- Supported kinds: `flowchart`, `sequenceDiagram`, `classDiagram`,
  `stateDiagram-v2`. Each becomes ordinary editable shapes, arrows and text.
- The addition is **queued**: the board's Diagram tile draws it when it is open
  (immediately if it already is). Until then `diagram.get` reports it as
  pending, so do not describe it as drawn yet.
- Invalid Mermaid is not drawn: `diagram.get` then lists the addition as failed
  with Mermaid's parse error. Fix the text and add it again.
- It never deletes, moves or edits the user's shapes, and there is no command
  that does. To change something the user drew, ask them.

## Errors

| Code | Meaning |
| --- | --- |
| `DIAGRAM` | No such board in this workstream, or the name is ambiguous. Run `diagram.list`. |
| `MISSING_PARAM` | `board` or `mermaid` was not given (or the Mermaid text is empty). |
| `BAD_MERMAID` | The Mermaid text could not be queued. |
| `NO_WORKSTREAM` | This session is not a workstream's session tile. |
| exit code 3 or 4 | Workstreams is not running, or this is not a Workstreams session. Answer in the terminal. |

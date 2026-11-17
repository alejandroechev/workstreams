---
id: "043"
status: Accepted
date: 2026-11-17
---

# ADR 043: The Diagram tile

## Status

Accepted (2026-11-17).

## Context

Workstreams had no place to think visually. The ask was a whiteboard for
working diagrams, not polished documentation: quick hand-drawn shapes, arrows
and text, extended for software (sequence, class, state and flow sketches),
that Copilot sessions can read and add to.

## Decision

**A new `diagram` tile built on Excalidraw** (`@excalidraw/excalidraw`, MIT),
embedded as a React component. It is not a mode of an existing tile.

- **Boards.** One tile holds several named boards (add, rename, switch,
  delete; at least one remains). The active board is kept in the tile config.
- **Storage stays in the app.** Each board's scene (Excalidraw elements and the
  image files they use) lives in `diagram_boards` in `workstreams.db`, never in
  the workstream folder. Deleting the tile deletes its boards. A board reaches
  disk only through **Save to file…** or **Export**, which use the system Save
  dialog (any folder; the workstream folder is only suggested) and write
  Excalidraw's own `.excalidraw` format, so the file opens at excalidraw.com.
- **`.excalidraw` files** in the Repo Explorer open as the same canvas and save
  edits back, checking the hash last read so a change on disk is never silently
  overwritten. The file's own fields (appState, source) are kept.
- **Getting diagrams out:** Copy as PNG (the selection or the board), Copy as
  Excalidraw (`excalidraw/clipboard` JSON, which pastes into excalidraw.com as
  editable shapes), Export as SVG, PNG or Excalidraw. Exports use a white
  background so they read well in PRs. Pasting an image is Excalidraw's own.
  PNG copy uses the web clipboard with a promised blob, falling back to the
  clipboard plugin's image write (Tauri `image-png`).
- **Software on top of Excalidraw:**
  - *Mermaid import* via `@excalidraw/mermaid-to-excalidraw`: flowchart,
    sequence, class and state diagrams become ordinary elements, placed to the
    right of the drawing. The conversion is one-way. A diagram that would only
    become a picture is refused, and invalid Mermaid shows its error and adds
    nothing. **Mermaid is pinned to 11.13.0** (an npm override): the 2.2.2
    converter's class parser does not match later Mermaid's DOM ids and falls
    back to a picture.
  - *A software palette* (Flow, Sequence, Class, State) of hand-drawn starting
    shapes, written as Excalidraw skeletons and placed at the middle of the
    view. Multi-shape items are grouped; placed shapes are ordinary elements.
    Sequence diagrams are plain shapes: inserting a message reflows nothing.
- **Agents** (`diagram` skill, shipped in `skills/`):
  - `diagram.list` — the caller's workstream's boards;
  - `diagram.get board=` — a board as text: labelled shapes and labelled
    connections (from arrow bindings), with pending and failed additions;
  - `diagram.add board= mermaid=@-` — **queues** Mermaid in
    `diagram_additions`. Converting Mermaid needs its browser renderer, so the
    board's open tile converts each queued addition, appends it with fresh ids
    beside the drawing, saves, and resolves it (applied ones are deleted, failed
    ones keep the parse error). The active board waits for its canvas, so the
    canvas can never save over an addition. Agents can only append: there is no
    command that deletes, moves or edits a user's shape.
- **Loading.** Excalidraw and Mermaid are loaded lazily, so start-up does not
  pay for them. Excalidraw's fonts ship with the app
  (`public/excalidraw-assets`) instead of coming from a CDN; the large CJK
  fallback font is left out.
- **Shortcut:** `Alt+G` adds a Diagram tile.

## Consequences

- The app bundle gains Excalidraw and Mermaid as lazy chunks (a few MB).
- Scenes are stored whole on each (debounced) change; boards with many pasted
  images make large rows.
- An agent's addition to a board whose tile is never opened stays pending, and
  `diagram.get` says so rather than pretending it is drawn.
- The Mermaid pin must be revisited when `@excalidraw/mermaid-to-excalidraw`
  is upgraded (its 3.x line replaces Mermaid with another renderer).
- Out of scope: the phone companion, Mermaid export, live Mermaid that
  re-renders, and real-time collaboration.

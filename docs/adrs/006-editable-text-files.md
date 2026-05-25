# ADR 006: Editable text files in tile file-detail panes

## Status
Accepted.

## Date
2026-05-25

## Context

Repo Explorer, Meta, and Workbench tiles already had file-detail panes for
reading text files, inspecting metadata, and navigating project artifacts.
Those panes stopped at viewing: any edit required switching to an external
editor, saving there, and returning to Workstreams. That broke the flow for
small changes discovered while driving Copilot sessions inside the app.

The editor also needed to respect the app's multi-tile model. The same file can
be opened from more than one tile, external tools may modify files while the app
is open, and the desktop runtime must avoid expensive editor payloads until a
file is actually edited.

## Decision

1. **Use Monaco for editable text files** in Repo Explorer, Meta, and Workbench
   file-detail panes. Markdown remains preview-first with an explicit Edit path;
   other UTF-8 text files open directly in the editor.

2. **Share one model per canonical file path** through
   `FileBufferRegistry`. Rust canonicalizes paths before they become registry
   keys, and each open view ref-counts the shared buffer. Multiple tiles showing
   the same file therefore see the same text, dirty state, save state, and undo
   history.

3. **Track edits with an explicit buffer state machine**:
   `clean`, `dirty`, `saving`, `conflicted`, `deleted`, and `save_blocked`.
   External changes reload clean buffers, conflict with dirty buffers, and pause
   auto-save until the user chooses Keep mine or Take disk.

4. **Save through Rust filesystem commands** exposed by a
   `FileSystemProvider` trait. `read_text_file`, `write_text_file`,
   `canonicalize_path`, and file watching have a real OS implementation plus an
   in-memory implementation for tests.

5. **Use conditional writes and atomic replacement**. Saves include the
   last-known disk hash; Rust rejects the write if the file changed externally.
   Accepted writes go through a temporary file followed by rename, avoiding
   partially-written target files.

6. **Lazy-load Monaco** on first editor use. The app pays the Monaco bundle cost
   only when the user opens or switches a file into edit mode.

## Alternatives considered

- **Plain `<textarea>`** — rejected. It would be lightweight, but code editing
  without syntax highlighting, find behavior, indentation, and editor keybindings
  would make the feature feel worse than opening an external editor.

- **CodeMirror 6** — rejected. It is capable and smaller, but Monaco is already
  used elsewhere in the app and provides the most familiar VS Code-like editing
  model for the target workflow.

## Consequences

- Users can make first-class text edits without leaving Workstreams.
- Safe save semantics are centralized: conditional writes detect external
  modification and atomic rename avoids partial target files.
- Shared models keep the same file consistent across Repo Explorer, Meta, and
  Workbench tiles.
- Monaco adds roughly 3 MB to the editor path, mitigated by lazy loading.
- The same file opened in multiple tiles intentionally shares one undo stack.
  This follows from the shared model decision and is documented UX, not a bug.
- There is no crash recovery for unsaved buffers. The app prompts on graceful
  workstream switches and window close, but dirty text is not persisted across a
  process crash.

## Risks accepted

- **Shared undo stack** across tiles showing the same canonical file.
- **No crash recovery** beyond best-effort prompts on graceful quit paths.
- **Mixed line endings normalize to the dominant line ending** on save.
- **No `.editorconfig` parsing** in v1; editor formatting policy is not inferred
  from repository configuration.

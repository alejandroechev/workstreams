// @test-skip: Type-only module; behaviour covered by MemoryBackend tests + UI tests.

/**
 * Session.db-backed inline file comment (unify-commenting). Stored in the bound
 * Copilot session's session.db with the same reviewer↔agent reply/status model
 * as Code Review, so the agent can read/reply via its native `sql` tool.
 * Repo-relative `file` path.
 */
export interface SessionFileComment {
  id: string;
  workstream_id: string;
  file: string;
  anchor_line_start: number;
  anchor_line_end: number;
  anchor_text: string | null;
  body: string;
  /**
   * Who wrote the comment. Two well-known aliases drive local behaviour:
   * `reviewer` (this user, authored in the tile — the only mutable case) and
   * `agent`. Importers such as the `ado-file-comments` skill store the real
   * display name instead (e.g. `"Eduardo Fernandez"`), which is rendered
   * verbatim so third-party review comments aren't attributed to this user.
   */
  author: string;
  parent_id: string | null;
  status: "open" | "addressed" | "resolved" | "wontfix" | string;
  created_at: string;
  updated_at: string;
}

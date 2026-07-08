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
  author: "reviewer" | "agent";
  parent_id: string | null;
  status: "open" | "addressed" | "resolved" | "wontfix" | string;
  created_at: string;
  updated_at: string;
}

// @test-skip: Type-only module; behaviour covered by MemoryBackend tests + UI tests.

export interface FileComment {
  id: string;
  workstream_id: string;
  absolute_path: string;
  anchor_line_start: number;
  anchor_line_end: number;
  anchor_text: string | null;
  body_md: string;
  author: string;
  origin_type: "user" | "ado-pr";
  origin_pr_id: string | null;
  origin_comment_id: string | null;
  origin_thread_id: string | null;
  origin_parent_id: string | null;
  origin_url: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportedCommentInput {
  absolute_path: string;
  anchor_line_start: number;
  anchor_line_end: number;
  anchor_text?: string | null;
  body_md: string;
  author: string;
  origin_pr_id: string;
  origin_comment_id: string;
  origin_thread_id?: string | null;
  origin_parent_id?: string | null;
  origin_url?: string | null;
  status?: string | null;
}

export interface ImportSummary {
  inserted: number;
  skipped: number;
}

/**
 * Session.db-backed inline file comment (unify-commenting). Stored in the bound
 * Copilot session's session.db with the same reviewer↔agent reply/status model
 * as Code Review, so the agent can read/reply via its native `sql` tool.
 * Repo-relative `file` path. Replaces the legacy workstreams.db `FileComment`
 * (which carried origin_* / ADO-import fields).
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

// @test-skip: Type-only module; behaviour covered by MemoryBackend + TauriBackend tests.
/**
 * Code Review tile (ADR 014) — shared types.
 *
 * Mirrors the Rust DTOs in `src-tauri/src/code_review/mod.rs`. Reviews +
 * comments live in the bound Copilot session's `session.db`; the tile reads
 * them via these Backend methods and polls for the agent's writes.
 */

/** Where a review's diff comes from. */
export type DiffSource = "working_tree" | "last_commit" | "branch";

/** Review lifecycle. */
export type ReviewStatus = "open" | "completed";

/** Comment thread lifecycle. Reviewer closes with `resolved`; agent may set
 * `addressed`/`wontfix`. */
export type CommentStatus = "open" | "addressed" | "resolved" | "wontfix";

export type CommentAuthor = "reviewer" | "agent";

export interface Review {
  id: string;
  workstream_id: string;
  diff_source: string;
  base_ref: string | null;
  title: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ReviewComment {
  id: string;
  review_id: string;
  file: string;
  line: number;
  side: string;
  code: string | null;
  hunk_header: string | null;
  body: string;
  author: string;
  parent_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** A changed file in a review's diff: repo-relative path + status char
 * (`A` added, `M` modified, `D` deleted, `R` renamed). */
export interface ChangedFile {
  path: string;
  status: string;
}

/** Both sides of a file diff for the Monaco DiffEditor. */
export interface DiffSides {
  before: string;
  after: string;
}

/**
 * Code Review tile `config_json` payload. The tile resolves the bound session
 * and loads the active review; `reviewId` optionally remembers the last-viewed
 * review across restarts.
 */
export interface CodeReviewTileConfig {
  reviewId?: string;
  diffSource?: DiffSource;
  baseRef?: string;
  selectedFile?: string;
}

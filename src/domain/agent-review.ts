// @test-skip: Type-only module; behaviour covered by MemoryBackend + TauriBackend tests.
/**
 * Local Agent Review (ADR 013) — shared types + event-name constants.
 *
 * Mirrors the Rust DTOs in `src-tauri/src/agent_review/mod.rs`. Local-review
 * comments are stored in `file_comments` with `origin_type='local-review'`;
 * `AgentReview` is the parent row grouping a review's threads.
 */

export type ReviewStatus = "active" | "completed";

/** Thread lifecycle. `me` closes the loop (resolve/reopen); `agent` may only
 * mark `addressed`/`wontfix`. */
export type ThreadStatus = "open" | "addressed" | "resolved" | "wontfix";

/** Binary anchor state from the spike-proven engine. */
export type AnchorState = "unchanged" | "changed";

export type ReviewAuthor = "me" | "agent";

export interface AgentReview {
  id: string;
  workstream_id: string;
  base_ref: string | null;
  head_ref: string | null;
  round: number;
  status: ReviewStatus | string;
  exported_path: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ReviewComment {
  id: string;
  review_id: string | null;
  workstream_id: string;
  absolute_path: string;
  anchor_line_start: number;
  anchor_line_end: number;
  anchor_text: string | null;
  body_md: string;
  author: string;
  status: string | null;
  origin_parent_id: string | null;
  round: number | null;
  anchor_state: string | null;
  fixing_commit: string | null;
  anchor_commit: string | null;
  created_at: string;
  updated_at: string;
  /** Computed on read for `changed` roots: the per-comment before/after hunk. */
  fixing_hunk?: string | null;
}

/**
 * Tauri event names. MUST satisfy `[a-zA-Z0-9\-/:_]+`.
 * Mirrored in `src-tauri/src/agent_review/mod.rs::events`.
 */
export const REVIEW_EVENTS = {
  ROUND_READY: "review:round-ready",
  COMMENT_UPDATED: "review:comment-updated",
} as const;

export type ReviewEventName = (typeof REVIEW_EVENTS)[keyof typeof REVIEW_EVENTS];

export interface RoundReadyPayload {
  reviewId: string;
  round: number;
}

export interface CommentUpdatedPayload {
  reviewId: string | null;
  commentId: string;
}

/**
 * Agent Review tile `config_json` payload. The tile reads `reviewId`; the
 * review + its comments in SQLite are the source of truth.
 */
export interface AgentReviewTileConfig {
  reviewId: string;
}

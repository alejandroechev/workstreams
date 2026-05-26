/**
 * diff-grok / Diff Review feature — shared types and event-name constants.
 *
 * These are the contracts shared between:
 * - Rust backend (mirror in `src-tauri/src/diff_review.rs`)
 * - Diff Review tile (`src/tiles/DiffReviewTile.tsx`)
 * - `diff-grok` skill (drives the workflow via Tauri commands + events)
 *
 * Schema details and rationale: `docs/adrs/007-diff-grok-integration.md`.
 */

export type DiffSource = "branch" | "pr" | "working_tree";

export type ReviewStatus = "planning" | "active" | "completed" | "archived";

export type ChunkState =
  | "pending"
  | "seen"
  | "approved"
  | "commented"
  | "invalidated";

export type QuestionStyle = "socratic" | "guided" | "review";

export interface DiffReview {
  id: string;
  workstream_id: string;
  diff_source: DiffSource;
  source_ref: string | null;
  status: ReviewStatus;
  plan_json: string | null;
  exported_path: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DiffChunk {
  id: string;
  review_id: string;
  ordinal: number;
  title: string;
  summary: string | null;
  is_trivial: boolean;
  state: ChunkState;
  question_text: string | null;
  question_style: QuestionStyle | null;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiffHunk {
  id: string;
  chunk_id: string;
  file_path: string;
  old_start: number | null;
  old_lines: number | null;
  new_start: number | null;
  new_lines: number | null;
  patch_text: string;
  content_hash: string;
}

export interface DiffComment {
  id: string;
  chunk_id: string;
  anchor_file: string;
  anchor_line_start: number;
  anchor_line_end: number;
  text: string;
  created_at: string;
}

export interface ChunkWithDetails {
  chunk: DiffChunk;
  hunks: DiffHunk[];
  comments: DiffComment[];
}

/**
 * Tauri event names. MUST satisfy `[a-zA-Z0-9\-/:_]+`.
 * Mirrored in `src-tauri/src/diff_review.rs::events`.
 */
export const DIFF_REVIEW_EVENTS = {
  PLAN_READY: "diff-review:plan-ready",
  CHUNK_ACTIVE: "diff-review:chunk-active",
  CHUNK_DONE: "diff-review:chunk-done",
  COMMENT_ADDED: "diff-review:comment-added",
  DRIFT_DETECTED: "diff-review:drift-detected",
  COMPLETED: "diff-review:completed",
} as const;

export type DiffReviewEventName =
  (typeof DIFF_REVIEW_EVENTS)[keyof typeof DIFF_REVIEW_EVENTS];

export interface PlanReadyPayload {
  reviewId: string;
  chunkCount: number;
}

export interface ChunkActivePayload {
  reviewId: string;
  chunkId: string;
  ordinal: number;
}

export interface ChunkDonePayload {
  reviewId: string;
  chunkId: string;
  state: Extract<ChunkState, "approved" | "commented" | "seen">;
}

export interface CommentAddedPayload {
  reviewId: string;
  chunkId: string;
  commentId: string;
}

export interface DriftDetectedPayload {
  reviewId: string;
  chunkIds: string[];
}

export interface CompletedPayload {
  reviewId: string;
  exportedPath: string;
}

/**
 * Diff Review tile `config_json` payload. The tile reads `reviewId` to know
 * which review to render; the review is the authoritative source of state.
 */
export interface DiffReviewTileConfig {
  reviewId: string;
}

/**
 * Export schema version 1 — written to
 * `.copilot-reviews/<review-id>/review.json` on completion.
 */
export interface DiffReviewExportV1 {
  schema: 1;
  review_id: string;
  workstream_id: string;
  diff_source: DiffSource;
  source_ref: string | null;
  completed_at: string;
  chunks: Array<{
    ordinal: number;
    title: string;
    summary: string | null;
    state: ChunkState;
    is_trivial: boolean;
    hunks: Array<{
      file: string;
      old_start: number | null;
      new_start: number | null;
      patch: string;
    }>;
    comments: Array<{
      anchor_file: string;
      anchor_line_start: number;
      anchor_line_end: number;
      text: string;
    }>;
  }>;
}

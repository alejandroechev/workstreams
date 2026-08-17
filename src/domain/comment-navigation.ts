/**
 * Cross-file comment navigation logic for the Repo Explorer **Comments tab**.
 *
 * Pure functions only — no Monaco, no React, no backend — so the grouping,
 * filtering, and drift rules are unit-testable on their own. The tab composes
 * these over the workstream-wide comment list.
 */
import type { SessionFileComment } from "./file-comments";
import { compareByCreatedAt } from "./comment-order";

export interface CommentThreadSummary {
  root: SessionFileComment;
  replies: SessionFileComment[];
  replyCount: number;
}

export interface FileCommentGroup {
  file: string;
  threads: CommentThreadSummary[];
  /** Thread roots in this file. */
  threadCount: number;
  /** Roots + replies, i.e. every row anchored to this file. */
  commentCount: number;
}

export interface CommentFilters {
  /** Empty means "any status". */
  statuses: string[];
  /** Empty means "any author". */
  authors: string[];
  /** Case-insensitive match against body and file path. Empty means "any". */
  text: string;
}

/**
 * Group a flat comment list into files, each holding its thread roots with
 * replies nested and counted.
 *
 * Files sort by path, threads by anchor line, replies chronologically. A reply
 * whose root is absent (filtered out, or deleted out-of-band) is promoted to a
 * root rather than dropped — in a cross-file list, silently hiding a comment is
 * worse than showing one with missing context.
 */
export function groupByFile(comments: SessionFileComment[]): FileCommentGroup[] {
  const byId = new Set(comments.map((c) => c.id));
  const repliesByParent = new Map<string, SessionFileComment[]>();
  const roots: SessionFileComment[] = [];

  for (const comment of comments) {
    const isReply = comment.parent_id !== null && byId.has(comment.parent_id);
    if (isReply) {
      const arr = repliesByParent.get(comment.parent_id as string) ?? [];
      arr.push(comment);
      repliesByParent.set(comment.parent_id as string, arr);
    } else {
      roots.push(comment);
    }
  }

  const byFile = new Map<string, SessionFileComment[]>();
  for (const root of roots) {
    byFile.set(root.file, [...(byFile.get(root.file) ?? []), root]);
  }

  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, fileRoots]) => {
      const threads = fileRoots
        .slice()
        .sort(
          (a, b) => a.anchor_line_start - b.anchor_line_start || compareByCreatedAt(a, b),
        )
        .map((root) => {
          const replies = (repliesByParent.get(root.id) ?? [])
            .slice()
            .sort(compareByCreatedAt);
          return { root, replies, replyCount: replies.length };
        });
      return {
        file,
        threads,
        threadCount: threads.length,
        commentCount: threads.reduce((n, t) => n + 1 + t.replyCount, 0),
      };
    });
}

/**
 * Apply the tab's filters. All three combine with AND; an empty value means
 * "don't filter on this".
 *
 * A reply is kept when **its root matches**, so filtering never splits a thread
 * — otherwise resolving a root would strand its replies as pseudo-roots.
 */
export function filterComments(
  comments: SessionFileComment[],
  filters: CommentFilters,
): SessionFileComment[] {
  const text = filters.text.trim().toLowerCase();
  const matches = (c: SessionFileComment): boolean => {
    if (filters.statuses.length > 0 && !filters.statuses.includes(c.status)) return false;
    if (filters.authors.length > 0 && !filters.authors.includes(c.author)) return false;
    if (text.length > 0) {
      const haystack = `${c.body}\n${c.file}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  };

  const keptRoots = new Set(comments.filter((c) => c.parent_id === null && matches(c)).map((c) => c.id));
  return comments.filter((c) =>
    c.parent_id !== null && keptRoots.has(c.parent_id) ? true : matches(c),
  );
}

/** Whether a comment's stored anchor still points at the code it was written on. */
export type DriftState = "fresh" | "drifted" | "unknown";

/**
 * Compare a comment's `anchor_text` snapshot against the file's current lines.
 *
 * Display-only: the tab badges drifted anchors but still navigates to the
 * stored line. Re-anchoring is deliberately out of scope (see ADR 009) because
 * it needs fuzzy matching, ambiguity handling, and a persistence decision.
 *
 * Returns `unknown` when there's nothing to compare (no snapshot, or the file
 * isn't loaded) so the UI can stay silent rather than claim staleness.
 */
export function detectDrift(
  comment: SessionFileComment,
  fileLines: string[] | null | undefined,
): DriftState {
  if (!comment.anchor_text) return "unknown";
  if (!fileLines) return "unknown";

  const start = comment.anchor_line_start;
  const end = Math.max(start, comment.anchor_line_end);
  if (start < 1 || end > fileLines.length) return "drifted";

  const current = fileLines.slice(start - 1, end).join("\n");
  return normalize(current) === normalize(comment.anchor_text) ? "fresh" : "drifted";
}

/** Trailing whitespace is noise for drift purposes (formatters churn it). */
function normalize(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

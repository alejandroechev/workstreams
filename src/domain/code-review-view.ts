/**
 * Pure view helpers for the Code Review tile (ADR 014). Kept out of the tile
 * component so they're unit-testable without React/Monaco.
 */
import type { ReviewComment } from "./code-review";

export interface CommentThread {
  root: ReviewComment;
  replies: ReviewComment[];
}

/** Group flat comments into threads: roots (parent_id === null) each with their
 * replies (ordered by created_at). Roots keep input order (already file→line). */
export function groupThreads(comments: ReviewComment[]): CommentThread[] {
  const roots = comments.filter((c) => c.parent_id === null);
  const byParent = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (c.parent_id) {
      const arr = byParent.get(c.parent_id) ?? [];
      arr.push(c);
      byParent.set(c.parent_id, arr);
    }
  }
  return roots.map((root) => ({
    root,
    replies: (byParent.get(root.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
}

/** Threads for one file, keyed by new-side line — for inline view zones. */
export function threadsByLine(threads: CommentThread[], file: string): Map<number, CommentThread[]> {
  const m = new Map<number, CommentThread[]>();
  for (const t of threads) {
    if (t.root.file !== file) continue;
    const arr = m.get(t.root.line) ?? [];
    arr.push(t);
    m.set(t.root.line, arr);
  }
  return m;
}

/** A thread is open (needs the reviewer) unless resolved/wontfix. */
export function isOpenThread(root: ReviewComment): boolean {
  return root.status !== "resolved" && root.status !== "wontfix";
}

/** Count of open threads the agent has already addressed — "needs your review". */
export function attentionCount(threads: CommentThread[]): number {
  return threads.filter((t) => isOpenThread(t.root) && t.root.status === "addressed").length;
}

/** Count of still-open (unresolved) threads. */
export function openCount(threads: CommentThread[]): number {
  return threads.filter((t) => isOpenThread(t.root)).length;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "addressed":
      return "Addressed";
    case "resolved":
      return "Resolved";
    case "wontfix":
      return "Won't fix";
    default:
      return "Open";
  }
}

/** File name (last path segment). */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Status char → human label for the file list. */
export function fileStatusLabel(status: string): string {
  switch (status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

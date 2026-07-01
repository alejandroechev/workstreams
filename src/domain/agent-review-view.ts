/**
 * Pure view helpers for the Agent Review tile (ADR 013). Kept out of the tile
 * component so they're unit-testable without React/Monaco.
 */
import type { ReviewComment } from "./agent-review";

export interface ReviewThread {
  root: ReviewComment;
  replies: ReviewComment[];
}

/** Group a flat comment list into threads: roots (origin_parent_id === null)
 * each with their replies (ordered by created_at). Roots keep input order. */
export function groupThreads(comments: ReviewComment[]): ReviewThread[] {
  const roots = comments.filter((c) => c.origin_parent_id === null);
  const byParent = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    if (c.origin_parent_id) {
      const arr = byParent.get(c.origin_parent_id) ?? [];
      arr.push(c);
      byParent.set(c.origin_parent_id, arr);
    }
  }
  return roots.map((root) => ({
    root,
    replies: (byParent.get(root.id) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at)),
  }));
}

/** File name (last path segment) for a slash- or backslash-separated path. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** True when a thread is still awaiting the reviewer's attention: its status is
 * open/addressed (not resolved/wontfix). */
export function isOpenThread(root: ReviewComment): boolean {
  const s = root.status ?? "open";
  return s !== "resolved" && s !== "wontfix";
}

/** Count of open threads whose commented code changed since it was raised —
 * the "needs your attention" badge. */
export function attentionCount(threads: ReviewThread[]): number {
  return threads.filter((t) => isOpenThread(t.root) && t.root.anchor_state === "changed").length;
}

/** Human label for a thread status. */
export function statusLabel(status: string | null): string {
  switch (status) {
    case "addressed":
      return "Addressed";
    case "resolved":
      return "Resolved";
    case "wontfix":
      return "Won't fix";
    case "open":
    case null:
    default:
      return "Open";
  }
}

/** Whether every thread is closed (resolved/wontfix) — review is completable. */
export function allThreadsClosed(threads: ReviewThread[]): boolean {
  return threads.length > 0 && threads.every((t) => !isOpenThread(t.root));
}

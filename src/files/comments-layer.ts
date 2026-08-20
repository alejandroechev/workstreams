import type { SessionFileComment } from "../domain/file-comments";
import { compareByCreatedAt } from "../domain/comment-order";

export interface Anchor {
  start: number;
  end: number;
  anchorText: string;
}

/**
 * Given the editor's content and a Monaco selection range, build an Anchor
 * suitable for `addSessionFileComment`. The anchor's text snapshot is the
 * joined lines covered by the selection (used later for drift detection).
 *
 * Returns null when the selection is empty (single column, no line span)
 * because there's nothing meaningful to anchor a comment to.
 */
export function selectionToAnchor(
  contentLines: string[],
  startLine: number,
  endLine: number,
): Anchor | null {
  if (startLine < 1 || endLine < 1) return null;
  if (endLine < startLine) return null;
  const clampedStart = Math.min(startLine, contentLines.length);
  const clampedEnd = Math.min(endLine, contentLines.length);
  if (clampedStart < 1) return null;
  const snippet = contentLines
    .slice(clampedStart - 1, clampedEnd)
    .join("\n");
  return { start: clampedStart, end: clampedEnd, anchorText: snippet };
}

/**
 * Returns a human-readable single-line summary of a comment's author/status.
 * Used in the view-zone header next to the body.
 */
export function formatCommentMeta(comment: SessionFileComment): string {
  return `${formatAuthor(comment.author)} · ${comment.status}`;
}

/**
 * Display label for an author. `reviewer` is this user's own note, `agent` is
 * the assistant; anything else is an imported third-party name (e.g. an Azure
 * DevOps reviewer) and is shown verbatim so it isn't attributed to this user.
 */
export function formatAuthor(author: string): string {
  if (author === "agent") return "agent";
  if (author === "reviewer") return "you";
  return author;
}

/**
 * Normalize a comment timestamp to epoch milliseconds for ordering.
 * Re-exported from the domain layer so the backends and the editor layer share
 * one implementation.
 */
export { commentTimeValue, compareByCreatedAt } from "../domain/comment-order";

/**
 * Whether this user may edit/delete the comment — i.e. change its **text**.
 * Only their own notes qualify; imported and agent comments are someone else's
 * words.
 *
 * Deliberately NOT used to gate Resolve/Reopen: status is triage ("have I dealt
 * with this?"), which applies to any comment regardless of who wrote it.
 */
export function isMutable(comment: SessionFileComment): boolean {
  return comment.author === "reviewer";
}

/** Returns true when the comment is a resolved/dismissed reviewer note. */
export function isClosedStatus(status: string): boolean {
  return status === "resolved" || status === "wontfix";
}

/**
 * Drop closed threads so a file shows only what still needs attention.
 *
 * Two rules matter:
 *
 * - **A resolved root takes its replies with it.** Leaving them would orphan
 *   them, and `groupCommentThreads` drops replies whose parent is missing --
 *   so they would silently disappear rather than render as anything useful.
 * - **A resolved reply does NOT hide anything.** Status on a reply is not a
 *   verdict on the thread; hiding it would tear a hole out of a conversation
 *   the user is still working through.
 *
 * Returns the input reference untouched when the filter is off, so callers can
 * pass the result straight into memoised render paths without forcing a
 * rebuild on every render.
 */
export function hideResolvedComments(
  comments: SessionFileComment[],
  hide: boolean,
): SessionFileComment[] {
  if (!hide) return comments;
  const closedRoots = new Set(
    comments.filter((c) => c.parent_id === null && isClosedStatus(c.status)).map((c) => c.id),
  );
  if (closedRoots.size === 0) return comments;
  return comments.filter(
    (c) => !closedRoots.has(c.id) && !(c.parent_id !== null && closedRoots.has(c.parent_id)),
  );
}

export interface CommentThread {
  root: SessionFileComment;
  replies: SessionFileComment[];
}

/**
 * Group a flat comment list into top-level reviewer notes with their threaded
 * agent replies attached in creation order. Replies whose parent is absent are
 * dropped (defensive).
 */
export function groupCommentThreads(comments: SessionFileComment[]): CommentThread[] {
  const roots = comments.filter((c) => c.parent_id === null);
  const byParent = new Map<string, SessionFileComment[]>();
  for (const c of comments) {
    if (c.parent_id === null) continue;
    const arr = byParent.get(c.parent_id) ?? [];
    arr.push(c);
    byParent.set(c.parent_id, arr);
  }
  return roots.map((root) => ({
    root,
    replies: (byParent.get(root.id) ?? []).sort(compareByCreatedAt),
  }));
}

/**
 * Rough height estimate (in editor line units) for the view zone we'll render
 * below a comment thread's anchor. One line for the meta header + one line per
 * ~80 chars of body for the root and each reply, plus padding so adjacent lines
 * of code stay visually distinct from the comment block.
 */
export function estimateThreadHeightInLines(thread: CommentThread): number {
  const bodyLines = (body: string): number =>
    body.split(/\r?\n/).reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / 80)), 0);
  let lines = 1 + bodyLines(thread.root.body);
  for (const r of thread.replies) {
    lines += 1 + bodyLines(r.body);
  }
  return Math.max(3, lines + 1);
}

/**
 * Serialize a whole comment thread (root + replies) to plain text for the
 * "Copy thread" action. Each entry is prefixed with its author + status so the
 * copied text is self-describing when pasted elsewhere.
 */
export function formatThreadForCopy(thread: CommentThread): string {
  const entry = (c: SessionFileComment): string => `${formatCommentMeta(c)}:\n${c.body}`;
  return [thread.root, ...thread.replies].map(entry).join("\n\n");
}

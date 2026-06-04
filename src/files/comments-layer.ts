import type { FileComment } from "../domain/file-comments";

export interface Anchor {
  start: number;
  end: number;
  anchorText: string;
}

/**
 * Given the editor's content and a Monaco selection range, build an Anchor
 * suitable for `addFileComment`. The anchor's text snapshot is the joined
 * lines covered by the selection (used later for drift detection).
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
 * Returns a human-readable single-line summary of a comment's origin/status.
 * Used in the view-zone header next to the body so users can tell apart
 * imported ADO comments from their own.
 */
export function formatCommentMeta(comment: FileComment): string {
  if (comment.origin_type === "ado-pr") {
    const pr = comment.origin_pr_id ?? "?";
    const status = comment.status ?? "active";
    return `${comment.author} · PR #${pr} · ${status}`;
  }
  return `${comment.author}`;
}

/** Returns true when the user is allowed to edit/delete this comment. */
export function isMutable(comment: FileComment): boolean {
  return comment.origin_type === "user";
}

/**
 * Rough height estimate (in editor line units) for the view zone we'll
 * render below a comment's anchor. One line for the meta header + one line
 * per ~80 chars of body, plus a 1-line bottom padding so adjacent lines of
 * code stay visually distinct from the comment block.
 */
export function estimateZoneHeightInLines(bodyMd: string): number {
  const explicitLines = bodyMd.split(/\r?\n/).length;
  const wrappedLines = bodyMd
    .split(/\r?\n/)
    .reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / 80)), 0);
  return Math.max(3, 1 + Math.max(explicitLines, wrappedLines) + 1);
}

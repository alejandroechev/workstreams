/**
 * Which Repo Explorer diff modes can be edited in place.
 *
 * A diff is only writable when its **modified side is the working file** —
 * otherwise there is nothing on disk for an edit to be saved to. The backend
 * builds the two sides differently per mode (`git_diff_file_sides`):
 *
 * | Mode | before | modified side |
 * | --- | --- | --- |
 * | `unstaged` | `git show HEAD` | the file on disk |
 * | `last_commit` | `git show HEAD~1` | `git show HEAD` |
 * | `branch_vs_master` | `git show master` | `git show HEAD` |
 *
 * Only `unstaged` reads the working tree, so only it is editable. This mirrors
 * `modifiedEditable` in `code-review-view.ts`, which encodes the same rule for
 * the Code Review tile (ADR 014 §4) — the constraint is about where the
 * content came from, not which tile is showing it.
 */

/** The one diff mode whose modified side is the on-disk working file. */
export const EDITABLE_DIFF_MODE = "unstaged";

/**
 * True when a diff mode's modified side can be edited and saved.
 *
 * Fails closed for unknown or absent modes: a diff mode added later must not
 * become writable by default before someone has checked where its modified
 * side actually comes from.
 */
export function diffModeEditable(mode: string | null | undefined): boolean {
  return mode === EDITABLE_DIFF_MODE;
}

/**
 * True when a diff file has a modified-side working file that can carry a
 * file comment. Deleted files have no modified-side lines, so their old-side
 * deletions cannot be represented by the working-file `file_comments` model.
 */
export function diffFileCommentable(
  mode: string | null | undefined,
  status: "A" | "M" | "D" | "R" | undefined,
): boolean {
  return diffModeEditable(mode) && status !== undefined && status !== "D";
}

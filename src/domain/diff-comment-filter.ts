import type { SessionFileComment } from "./file-comments";

/** A 1-based, inclusive line range in the shape Monaco's `IRange` subset uses. */
export interface LineRange {
  startLineNumber: number;
  endLineNumber: number;
}

/**
 * Diff file list label: the file name first, then its directory. Long paths
 * used to force horizontal scrolling just to find out which file a row was.
 */
export function diffFileLabel(path: string): { name: string; dir: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
}

/** Comment threads per repo-relative file. Replies belong to their thread. */
export function commentThreadCountsByFile(comments: SessionFileComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    if (comment.parent_id !== null) continue;
    counts.set(comment.file, (counts.get(comment.file) ?? 0) + 1);
  }
  return counts;
}

/** Commented lines plus `context` either side, merged, on the modified side. */
function commentWindows(lineCount: number, comments: SessionFileComment[], context: number): LineRange[] {
  if (lineCount < 1) return [];
  return merge(
    comments
      .filter((comment) => comment.parent_id === null)
      .map((comment) => {
        const start = Math.min(Math.max(comment.anchor_line_start, 1), lineCount);
        const end = Math.min(Math.max(comment.anchor_line_end, start), lineCount);
        return {
          startLineNumber: Math.max(start - context, 1),
          endLineNumber: Math.min(end + context, lineCount),
        };
      }),
  );
}

function merge(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLineNumber - b.startLineNumber);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startLineNumber <= last.endLineNumber + 1) {
      last.endLineNumber = Math.max(last.endLineNumber, range.endLineNumber);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function complement(windows: LineRange[], lineCount: number): LineRange[] {
  if (windows.length === 0 || lineCount < 1) return [];
  const hidden: LineRange[] = [];
  let next = 1;
  for (const window of windows) {
    if (window.startLineNumber > next) {
      hidden.push({ startLineNumber: next, endLineNumber: Math.min(window.startLineNumber - 1, lineCount) });
    }
    next = Math.max(next, window.endLineNumber + 1);
  }
  if (next <= lineCount) hidden.push({ startLineNumber: next, endLineNumber: lineCount });
  return hidden;
}

/**
 * Lines to hide so only commented code, plus `context` lines either side,
 * stays visible. Returns nothing when there is no comment to anchor on: hiding
 * the whole file would leave an empty pane with no way back to the code.
 */
export function commentOnlyHiddenRanges(
  lineCount: number,
  comments: SessionFileComment[],
  context: number,
): LineRange[] {
  return complement(commentWindows(lineCount, comments, context), lineCount);
}

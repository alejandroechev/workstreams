import type { FileSearchMatch } from "../backend/types";

/** A file and all its content-search matches, in first-seen order. */
export interface FileMatchGroup {
  /** Absolute path as returned by the backend. */
  path: string;
  /** Path relative to the search root (for display); falls back to `path`. */
  relPath: string;
  matches: FileSearchMatch[];
}

/** One run of text within a result line, flagged as a match or not. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Group flat content-search matches by file, preserving the order in which each
 * file was first seen and the order of matches within a file. `rootDir` is used
 * only to compute a display-friendly relative path.
 */
export function groupMatchesByFile(
  matches: FileSearchMatch[],
  rootDir: string,
): FileMatchGroup[] {
  const order: string[] = [];
  const byPath = new Map<string, FileSearchMatch[]>();
  for (const match of matches) {
    let bucket = byPath.get(match.path);
    if (!bucket) {
      bucket = [];
      byPath.set(match.path, bucket);
      order.push(match.path);
    }
    bucket.push(match);
  }
  return order.map((path) => ({
    path,
    relPath: relativize(rootDir, path),
    matches: byPath.get(path) ?? [],
  }));
}

/**
 * Compute the relative path of `path` under `rootDir`, normalised to forward
 * slashes for display. Returns the original `path` when `rootDir` is empty or
 * `path` is not under it. Separator-agnostic (handles `/` and `\`).
 */
function relativize(rootDir: string, path: string): string {
  if (!rootDir) return path;
  const normRoot = rootDir.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const normPath = path.replace(/\\/g, "/");
  if (normPath.toLowerCase() === normRoot) return normPath;
  const prefix = normRoot + "/";
  if (normPath.toLowerCase().startsWith(prefix)) {
    return normPath.slice(prefix.length);
  }
  return path;
}

/**
 * Split a result line into highlight segments around each occurrence of
 * `query`. Phase 1 = plain substring matching (case-insensitive by default).
 * The original casing of the line is preserved in the emitted segment text.
 *
 * Always returns at least one segment; an empty query or no match yields a
 * single non-match segment spanning the whole line.
 */
export function computeHighlightSegments(
  lineText: string,
  query: string,
  caseSensitive = false,
): HighlightSegment[] {
  if (!query) return [{ text: lineText, match: false }];

  const haystack = caseSensitive ? lineText : lineText.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  let idx = haystack.indexOf(needle, cursor);
  if (idx === -1) return [{ text: lineText, match: false }];

  while (idx !== -1) {
    if (idx > cursor) {
      segments.push({ text: lineText.slice(cursor, idx), match: false });
    }
    segments.push({ text: lineText.slice(idx, idx + needle.length), match: true });
    cursor = idx + needle.length;
    idx = haystack.indexOf(needle, cursor);
  }
  if (cursor < lineText.length) {
    segments.push({ text: lineText.slice(cursor), match: false });
  }
  return segments;
}

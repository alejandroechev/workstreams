/**
 * Ordering helpers for session-DB comments (`file_comments`, `review_comments`).
 *
 * These rows are written by three producers that historically disagreed on the
 * timestamp format: the tile wrote Unix **seconds** (`"1787000000"`), while the
 * agent (`file-comments` skill) and importers (`ado-file-comments` skill) write
 * ISO-8601 (`"2026-08-17T14:48:29Z"`). Comparing those as plain strings sorts
 * every epoch value before every ISO value, so a reply written in the tile
 * rendered above the earlier agent reply it was answering.
 *
 * The tile now writes ISO-8601 too, but existing rows keep the legacy format,
 * so ordering must normalize both shapes.
 */

/** Epoch milliseconds for a comment timestamp. Unparseable values sort last. */
export function commentTimeValue(createdAt: string): number {
  if (/^\d+$/.test(createdAt)) return Number(createdAt) * 1000;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/** Chronological comparator tolerating both epoch-second and ISO timestamps. */
export function compareByCreatedAt(
  a: { created_at: string },
  b: { created_at: string },
): number {
  return commentTimeValue(a.created_at) - commentTimeValue(b.created_at);
}

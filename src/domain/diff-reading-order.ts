/**
 * Agent-recommended reading order for a Repo Explorer diff (ADR 032).
 *
 * The order is saved by the workstream's agent through `diff.order.set`; the
 * app computes whether the diff has moved on since. This module turns the
 * stored order plus the current file list into what the diff list shows.
 */

/** How far the diff has moved since the order was saved. */
export type DiffOrderFreshness = "current" | "content_changed" | "files_changed";

export interface DiffOrderView {
  paths: string[];
  freshness: DiffOrderFreshness;
}

export type DiffSort = "recommended" | "name";

/** The words to say to the workstream's agent to get an order. */
export const READING_ORDER_PROMPT = "order my diff";

export interface DiffRow<F> {
  file: F;
  /** 1-based place in the recommended order; null when sorted by name. */
  position: number | null;
}

const byPath = <F extends { path: string }>(a: F, b: F) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The diff file list in display order.
 *
 * Name sorts by full path, so a folder's files stay together. Recommended
 * follows the saved order; when files have since joined or left the diff the
 * order is degraded rather than dropped: survivors keep their order, new files
 * follow by path, and removed files are simply absent. Positions number the
 * whole list, so a later filter keeps them rather than renumbering.
 */
export function sortDiffFiles<F extends { path: string }>(
  files: F[],
  order: DiffOrderView | null,
  sort: DiffSort,
): Array<DiffRow<F>> {
  if (sort === "name" || !order) {
    return [...files].sort(byPath).map((file) => ({ file, position: null }));
  }
  const byPathMap = new Map(files.map((file) => [file.path, file]));
  const ordered = order.paths.flatMap((path) => {
    const file = byPathMap.get(path);
    byPathMap.delete(path);
    return file ? [file] : [];
  });
  const appended = [...byPathMap.values()].sort(byPath);
  return [...ordered, ...appended].map((file, index) => ({ file, position: index + 1 }));
}

/** Recommended whenever an order exists, however stale; Name otherwise. */
export function defaultDiffSort(order: DiffOrderView | null): DiffSort {
  return order ? "recommended" : "name";
}

/** Tooltip text for a drifted order, or null when it still matches. */
export function driftDescription(freshness: DiffOrderFreshness): string | null {
  const regenerate = `Ask the workstream's agent to "${READING_ORDER_PROMPT}" again to refresh it.`;
  switch (freshness) {
    case "current":
      return null;
    case "content_changed":
      return `File content has changed since this order was saved; the same files are still in the diff. ${regenerate}`;
    case "files_changed":
      return `Files were added to or removed from the diff since this order was saved. New files are listed after the ordered ones, by path. ${regenerate}`;
  }
}

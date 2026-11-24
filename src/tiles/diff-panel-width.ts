/**
 * Width of the Repo Explorer diff view's changed-files list. The user drags
 * the divider between the list and the code viewer; the width is remembered
 * app-wide so every Repo Explorer tile opens with the same split.
 */
export const DEFAULT_DIFF_PANEL_WIDTH = 180;
export const MIN_DIFF_PANEL_WIDTH = 120;
export const MIN_DIFF_VIEWER_WIDTH = 200;

const STORAGE_KEY = "workstreams.repoExplorer.diffFileListWidth";

/** `containerWidth` of 0 means "not measured yet": only the minimum applies. */
export function clampDiffPanelWidth(width: number, containerWidth: number): number {
  let w = width;
  if (containerWidth > 0) w = Math.min(w, containerWidth - MIN_DIFF_VIEWER_WIDTH);
  return Math.round(Math.max(MIN_DIFF_PANEL_WIDTH, w));
}

export function loadDiffPanelWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampDiffPanelWidth(n, 0) : DEFAULT_DIFF_PANEL_WIDTH;
  } catch {
    return DEFAULT_DIFF_PANEL_WIDTH;
  }
}

export function saveDiffPanelWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage unavailable: the width just isn't remembered.
  }
}

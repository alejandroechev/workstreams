/**
 * Cross-tile navigation for the code walkthrough.
 *
 * The walkthrough controller does not own an editor. It *drives* an existing
 * Repo Explorer tile by firing an event, which preserves the property the
 * whole feature exists for: the trace dictates navigation, but the editor
 * stays an ordinary editor you can wander off in and then resync.
 *
 * Modelled on `workbench-events.ts`, which already establishes the
 * window-CustomEvent pattern for tile-to-tile messaging.
 */

export const WALKTHROUGH_NAVIGATE_EVENT = "workstreams:walkthrough-navigate";

export interface WalkthroughNavigatePayload {
  /** Which Repo Explorer should react. Others ignore the event. */
  readonly explorerTileId: string;
  /** Absolute path of the file to reveal. */
  readonly path: string;
  /** 1-based line to reveal and highlight. */
  readonly line: number;
  readonly workstreamId: string | null;
}

export function dispatchWalkthroughNavigate(payload: WalkthroughNavigatePayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WalkthroughNavigatePayload>(WALKTHROUGH_NAVIGATE_EVENT, { detail: payload }),
  );
}

/** Subscribe to navigation requests. Returns an unsubscribe function. */
export function subscribeWalkthroughNavigate(
  handler: (payload: WalkthroughNavigatePayload) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<WalkthroughNavigatePayload>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(WALKTHROUGH_NAVIGATE_EVENT, listener);
  return () => window.removeEventListener(WALKTHROUGH_NAVIGATE_EVENT, listener);
}

export interface ExplorerCandidate {
  readonly id: string;
  readonly title: string | null;
}

export interface ExplorerBinding {
  /** The explorer to drive, or null when the user must pick one. */
  readonly boundId: string | null;
  /** True when a picker should be shown. */
  readonly needsChoice: boolean;
}

/**
 * Decide which Repo Explorer the controller drives.
 *
 * An explicit choice is sticky and wins over everything else. Deriving the
 * binding from focus was rejected: the step target would move as the user
 * clicked around, which is exactly the "wander freely" behaviour this design
 * is built to support. When only one explorer exists there is nothing to
 * choose, so it binds silently and the UI shows no chrome.
 */
export function selectExplorerBinding(
  chosenId: string | null,
  candidates: ReadonlyArray<ExplorerCandidate>,
): ExplorerBinding {
  if (chosenId && candidates.some((c) => c.id === chosenId)) {
    return { boundId: chosenId, needsChoice: false };
  }
  if (candidates.length === 1) {
    return { boundId: candidates[0].id, needsChoice: false };
  }
  // Zero candidates is not a choice the user can make — the controller tells
  // them to open a Repo Explorer instead of showing an empty picker.
  return { boundId: null, needsChoice: candidates.length > 1 };
}

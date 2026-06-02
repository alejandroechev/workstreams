/**
 * Cross-tile "add-to-workbench" bus.
 *
 * The Repo Explorer / Session Meta tiles dispatch this event when the
 * user picks "Add to Workbench" from a context menu. The Workbench tile
 * listens for it and appends the file path to its config.
 *
 * Implementation: plain CustomEvent on window. Stays inside the React
 * tree, no backend round-trip, no broadcast across windows.
 */

export const WORKBENCH_ADD_EVENT = "workstreams:add-to-workbench";

export interface AddToWorkbenchPayload {
  /** Absolute path of the file to add. */
  path: string;
  /** Workstream id the file belongs to. Used to filter which Workbench tile responds. */
  workstreamId: string | null;
}

/** Fire the event. No-op on the server. */
export function dispatchAddToWorkbench(payload: AddToWorkbenchPayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AddToWorkbenchPayload>(WORKBENCH_ADD_EVENT, { detail: payload }));
}

/** Subscribe to the event. Returns an unsubscribe function. */
export function subscribeAddToWorkbench(handler: (payload: AddToWorkbenchPayload) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    const ce = e as CustomEvent<AddToWorkbenchPayload>;
    if (ce.detail) handler(ce.detail);
  };
  window.addEventListener(WORKBENCH_ADD_EVENT, listener);
  return () => window.removeEventListener(WORKBENCH_ADD_EVENT, listener);
}

/**
 * Pure helper: append a path to a file list, deduping. Returns the
 * original reference unchanged when the path is already present.
 */
export function appendUnique(files: ReadonlyArray<string>, path: string): string[] {
  if (files.includes(path)) return files as string[];
  return [...files, path];
}

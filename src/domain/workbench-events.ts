/**
 * Cross-tile "add-to-workbench" bus.
 *
 * The Repo Explorer / Session Meta tiles dispatch this event when the
 * user picks "Add to Workbench" from a context menu. Two things happen:
 *  1. The persistent workstream Workbench list is updated (writes
 *     through {@link workbenchStoreDispatcher}).
 *  2. A CustomEvent fires on window so any mounted Workbench tile in
 *     the matching workstream can refresh optimistically.
 *
 * Step 1 means the file is queued even when no Workbench tile is open;
 * the next time the user opens one it shows up. Step 2 is just UX so
 * already-open tiles don't have to wait for a re-read.
 */
import type { WorkbenchStore } from "./workbench-store";

export const WORKBENCH_ADD_EVENT = "workstreams:add-to-workbench";

export interface AddToWorkbenchPayload {
  /** Absolute path of the file to add. */
  path: string;
  /** Workstream id the file belongs to. Used to scope persistence + listener filtering. */
  workstreamId: string | null;
}

let storeRef: WorkbenchStore | null = null;
/** App startup wires the real (Tauri-backed) store; tests can leave it null. */
export function setWorkbenchStoreForDispatcher(store: WorkbenchStore | null): void {
  storeRef = store;
}

/**
 * Fire the event AND persist to the workstream's Workbench list (when a
 * store has been wired). Returns a promise that resolves once persistence
 * has settled. Callers that don't need to await can ignore it.
 */
export function dispatchAddToWorkbench(payload: AddToWorkbenchPayload): Promise<void> {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<AddToWorkbenchPayload>(WORKBENCH_ADD_EVENT, { detail: payload }));
  }
  if (storeRef && payload.workstreamId) {
    return storeRef.add(payload.workstreamId, payload.path).then(() => undefined).catch(() => undefined);
  }
  return Promise.resolve();
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

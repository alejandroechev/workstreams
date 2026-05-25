export type BufferState = "clean" | "dirty" | "saving" | "conflicted" | "deleted" | "save_blocked";

export type BufferEvent =
  | { type: "user_typed" }
  | { type: "save_started" }
  | { type: "save_succeeded"; newDiskHash: string }
  | { type: "save_failed_external_modified"; currentDiskHash: string }
  | { type: "save_failed_not_found" }
  | { type: "save_failed_permission" }
  | { type: "save_failed_disk_full" }
  | { type: "save_failed_other"; message: string }
  | { type: "external_change_detected" }
  | { type: "external_delete_detected" }
  | { type: "conflict_resolved_keep_mine" }
  | { type: "conflict_resolved_take_disk" }
  | { type: "user_retry_save" };

export interface BufferStateContext {
  state: BufferState;
  /** Most recent error message, for save_blocked / conflicted UX. */
  lastError?: string;
  /** Last hash that came back from disk during a conflict (for the diff view). */
  conflictingDiskHash?: string;
  /** Whether auto-save should be allowed to fire from this state. */
  autoSaveAllowed: boolean;
}

export const INITIAL_CONTEXT: BufferStateContext = {
  state: "clean",
  autoSaveAllowed: false,
};

const EXTERNAL_CHANGE_CONFLICT_HASH = "external-change-detected";
const EXTERNAL_CHANGE_ERROR = "File changed on disk";

const contextFor = (state: BufferState, extra: Omit<Partial<BufferStateContext>, "state" | "autoSaveAllowed"> = {}) => ({
  state,
  autoSaveAllowed: state === "dirty",
  ...extra,
});

/**
 * Applies a file-buffer event to the current state context.
 * Unknown transitions are intentional no-ops so callers can safely dispatch
 * stale or out-of-order async save events without throwing.
 */
export function reduce(ctx: BufferStateContext, event: BufferEvent): BufferStateContext {
  switch (ctx.state) {
    case "clean":
      switch (event.type) {
        case "user_typed":
          return contextFor("dirty");
        case "external_change_detected":
          return contextFor("clean");
        case "external_delete_detected":
          return contextFor("deleted");
        default:
          return ctx;
      }

    case "dirty":
      switch (event.type) {
        case "user_typed":
          return contextFor("dirty");
        case "save_started":
          return contextFor("saving");
        case "external_change_detected":
          return contextFor("conflicted", {
            conflictingDiskHash: EXTERNAL_CHANGE_CONFLICT_HASH,
            lastError: EXTERNAL_CHANGE_ERROR,
          });
        case "external_delete_detected":
          return contextFor("deleted");
        default:
          return ctx;
      }

    case "saving":
      switch (event.type) {
        case "save_succeeded":
          return contextFor("clean");
        case "save_failed_external_modified":
          return contextFor("conflicted", {
            conflictingDiskHash: event.currentDiskHash,
            lastError: EXTERNAL_CHANGE_ERROR,
          });
        case "save_failed_not_found":
          return contextFor("deleted");
        case "save_failed_permission":
          return contextFor("save_blocked", { lastError: "Permission denied" });
        case "save_failed_disk_full":
          return contextFor("save_blocked", { lastError: "Disk full" });
        case "save_failed_other":
          return contextFor("save_blocked", { lastError: event.message });
        case "user_typed":
          return contextFor("saving");
        default:
          return ctx;
      }

    case "conflicted":
      switch (event.type) {
        case "conflict_resolved_keep_mine":
          return contextFor("dirty");
        case "conflict_resolved_take_disk":
          return contextFor("clean");
        case "user_typed":
          return contextFor("conflicted", {
            conflictingDiskHash: ctx.conflictingDiskHash,
            lastError: ctx.lastError,
          });
        default:
          return ctx;
      }

    case "deleted":
      switch (event.type) {
        case "user_typed":
          return contextFor("dirty");
        default:
          return ctx;
      }

    case "save_blocked":
      switch (event.type) {
        case "user_retry_save":
          return contextFor("dirty");
        case "user_typed":
          return contextFor("save_blocked", { lastError: ctx.lastError });
        case "external_change_detected":
          return contextFor("conflicted", {
            conflictingDiskHash: EXTERNAL_CHANGE_CONFLICT_HASH,
            lastError: EXTERNAL_CHANGE_ERROR,
          });
        default:
          return ctx;
      }
  }
}

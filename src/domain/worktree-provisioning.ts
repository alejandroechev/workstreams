/**
 * Pure state machine for non-blocking worktree provisioning (create) and
 * archive-delete (remove). The Rust side runs git on a background thread and
 * emits id-keyed `worktree-progress` events; this reducer maps those events
 * to the workstream row's UI state.
 *
 * The reducer is **total**: every event in every state returns a valid state,
 * and once a terminal state is reached (active / create_failed / archived)
 * further events are ignored (tolerates duplicate `done`, error-after-done,
 * and out-of-order events).
 */

import type { WorkstreamStatus } from "./types";

export type WorktreeOp = "create" | "archive";

export interface WorktreeProgressEvent {
  workstreamId: string;
  /** e.g. resolving, pulling-base, pull-skipped, creating, created, removing, removed. */
  phase: string;
  detail: string;
  status: "running" | "done" | "error";
  /** Which operation emitted this; inferred from current state when absent. */
  op?: WorktreeOp;
}

export interface ProvisioningState {
  /** The workstream row's status derived from progress so far. */
  status: WorkstreamStatus;
  /** Current running-phase label (null once terminal). */
  phase: string | null;
  /** Accumulated step log for the expandable detail view. */
  steps: Array<{ phase: string; detail: string }>;
  /** Hard error (create failure) — drives the create_failed row. */
  error: string | null;
  /** Non-fatal warning (pull-skipped, or worktree-not-deleted on archive). */
  warning: string | null;
}

export function initialCreatingState(): ProvisioningState {
  return { status: "creating", phase: null, steps: [], error: null, warning: null };
}

export function initialArchivingState(): ProvisioningState {
  return { status: "archiving", phase: null, steps: [], error: null, warning: null };
}

const TERMINAL: ReadonlySet<WorkstreamStatus> = new Set(["active", "create_failed", "archived"]);

export function applyWorktreeEvent(
  state: ProvisioningState,
  event: WorktreeProgressEvent,
): ProvisioningState {
  // Once terminal, ignore further events (total + idempotent).
  if (TERMINAL.has(state.status)) return state;

  const op: WorktreeOp = event.op ?? (state.status === "archiving" ? "archive" : "create");

  if (event.status === "running") {
    const steps = [...state.steps, { phase: event.phase, detail: event.detail }];
    if (event.phase === "pull-skipped") {
      return { ...state, steps, warning: event.detail || "Pull skipped; used local base" };
    }
    return { ...state, steps, phase: event.detail || event.phase };
  }

  if (event.status === "done") {
    return op === "archive"
      ? { ...state, status: "archived", phase: null }
      : { ...state, status: "active", phase: null };
  }

  // event.status === "error"
  if (op === "archive") {
    // The archive itself already succeeded; only the worktree removal failed.
    return {
      ...state,
      status: "archived",
      phase: null,
      warning: `Worktree not deleted: ${event.detail}`,
    };
  }
  return { ...state, status: "create_failed", phase: null, error: event.detail };
}

/**
 * Step-navigation model for a recorded code walkthrough. Pure and
 * host-agnostic — no React, no Tauri, no Monaco.
 *
 * Navigation is just an index into an immutable step array, which is why
 * **stepping backwards is free** here. A live debugger cannot go back without
 * record/replay support; a replayed trace can, and that is a deliberate v1
 * feature rather than a side effect.
 *
 * ## Filtering is a view, never a mutation
 *
 * `visibleSteps` hides generated code, but the index always addresses the
 * *full* step list. Renumbering around hidden frames would make every index
 * shift silently as the filter changes, and navigation would land on the wrong
 * line. Capture-time filtering was rejected for the same reason at the
 * recorder level: discarding frames is destructive and forces a re-record to
 * get them back.
 */

import type { TraceFile, TraceStep } from "./trace-format";

export interface WalkthroughOptions {
  /** Show files under `target/` (generated code). Off by default. */
  readonly showGenerated?: boolean;
  /** Extra display filter over repo-relative paths. */
  readonly fileFilter?: (file: string) => boolean;
}

export interface Walkthrough {
  readonly trace: TraceFile;
  /** Index into `trace.steps` — the *unfiltered* list. */
  readonly index: number;
  readonly options: WalkthroughOptions;
}

export function createWalkthrough(trace: TraceFile, options: WalkthroughOptions = {}): Walkthrough {
  return { trace, index: 0, options };
}

export function totalSteps(w: Walkthrough): number {
  return w.trace.steps.length;
}

/** The step under the cursor, or `null` for an empty trace. */
export function currentStep(w: Walkthrough): TraceStep | null {
  return w.trace.steps[w.index] ?? null;
}

export function canStepBack(w: Walkthrough): boolean {
  return w.index > 0;
}

export function canStepForward(w: Walkthrough): boolean {
  return w.index < w.trace.steps.length - 1;
}

/**
 * Move to `index`, clamped into range. Clamping rather than throwing matters
 * because the step list is user-clickable and traces get re-recorded — a stale
 * index must not take the tile down.
 */
export function gotoStep(w: Walkthrough, index: number): Walkthrough {
  const last = Math.max(0, w.trace.steps.length - 1);
  const clamped = Math.min(Math.max(Math.trunc(index) || 0, 0), last);
  return clamped === w.index ? w : { ...w, index: clamped };
}

export function stepForward(w: Walkthrough): Walkthrough {
  return gotoStep(w, w.index + 1);
}

export function stepBack(w: Walkthrough): Walkthrough {
  return gotoStep(w, w.index - 1);
}


/**
 * Index of the step where control returns to the current step's **caller**, or
 * `null` when there is nowhere to go.
 *
 * This is the reading equivalent of a debugger's "finish": *I understand this
 * function, take me back to the call site.* It deliberately skips the whole
 * remainder of the current call — including any deeper calls it makes — rather
 * than merely advancing one step.
 *
 * Uses recorded call depth when available, which is exact (only comparisons
 * between steps matter, so the absolute values need no normalising). Traces recorded
 * before `depth` existed fall back to matching the calling function's **name**;
 * that is correct except under recursion, where the caller shares the callee's
 * name and the fallback lands on an outer frame instead. Depth-bearing traces
 * have no such caveat, which is why the recorder captures it.
 */
export function stepOutIndex(w: Walkthrough): number | null {
  const steps = w.trace.steps;
  const current = steps[w.index];
  if (!current) return null;

  if (current.depth !== undefined) {
    const depth = current.depth;
    for (let i = w.index + 1; i < steps.length; i++) {
      const candidate = steps[i].depth;
      // A shallower frame means this call has returned.
      if (candidate !== undefined && candidate < depth) return i;
    }
    // The frame never returns inside the trace — typically a truncated
    // recording. Claiming a return point would send the reader somewhere
    // execution never actually reached.
    return null;
  }

  // Fallback: the most recent step in a different function is the caller.
  let callerName: string | null = null;
  for (let i = w.index - 1; i >= 0; i--) {
    if (steps[i].function !== current.function) {
      callerName = steps[i].function;
      break;
    }
  }
  if (callerName === null) return null; // outermost recorded frame

  for (let i = w.index + 1; i < steps.length; i++) {
    if (steps[i].function === callerName) return i;
  }
  return null;
}

export function canStepOut(w: Walkthrough): boolean {
  return stepOutIndex(w) !== null;
}

/** Jump to the caller's next step. No-op when there is nowhere to return to. */
export function stepOut(w: Walkthrough): Walkthrough {
  const target = stepOutIndex(w);
  return target === null ? w : gotoStep(w, target);
}

/** 1-based "n / total", for display. */
export function progressLabel(w: Walkthrough): string {
  const total = totalSteps(w);
  return `${total === 0 ? 0 : w.index + 1} / ${total}`;
}

/**
 * Absolute path of a step's file.
 *
 * The separator is inferred from `repoRoot` rather than taken from the local
 * platform, because traces are portable by design: one recorded on macOS can
 * be opened on Windows. Using the host separator there would splice a
 * Windows-recorded root onto a Unix-style relative path (`C:\repo/src/a.rs`)
 * or vice versa.
 */
export function resolveStepPath(repoRoot: string, file: string): string {
  const usesBackslash = repoRoot.includes("\\") && !repoRoot.includes("/");
  const sep = usesBackslash ? "\\" : "/";
  const root = repoRoot.replace(/[\\/]+$/, "");
  const relative = file.replace(/[\\/]+/g, sep).replace(new RegExp(`^\\${sep}+`), "");
  return `${root}${sep}${relative}`;
}

function isGenerated(file: string): boolean {
  return /(^|[\\/])target[\\/]/.test(file);
}

/** The steps a UI should render, given the current display options. */
export function visibleSteps(w: Walkthrough): ReadonlyArray<TraceStep> {
  const { showGenerated, fileFilter } = w.options;
  return w.trace.steps.filter((step) => {
    if (!showGenerated && isGenerated(step.file)) return false;
    if (fileFilter && !fileFilter(step.file)) return false;
    return true;
  });
}

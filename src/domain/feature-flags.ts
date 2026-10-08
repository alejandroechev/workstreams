/**
 * Feature flag registry.
 *
 * Flags are evaluated from the build-time env var
 * `VITE_ENABLE_OPTIONAL_FEATURES`. Default: off. Set to `1` to enable
 * every optional feature. Local dev builds set this via `.env.local`
 * (gitignored); CI builds don't set it, so the public release ships
 * with these features hidden.
 *
 * **Sunset features are the exception.** A feature being retired is not the
 * same as one waiting on infrastructure, and it must not ride the maintainer's
 * master toggle — that would leave it enabled on the very machine trying to
 * stop using it. Those carry `sunset: true` and read their own variable
 * (`VITE_ENABLE_TASKS`), defaulting off everywhere.
 *
 * Adding a new flag: append to FeatureId + FEATURES below. Consumers
 * read with isFeatureEnabled(id) — never check the env var directly so
 * we keep one source of truth.
 */

export type FeatureId = "debug-walkthrough" | "tasks";

export const FEATURE_IDS: readonly FeatureId[] = [
  "debug-walkthrough",
  "tasks",
] as const;

interface FeatureDescriptor {
  id: FeatureId;
  /** Human-readable label, shown in disabled-tile placeholders. */
  label: string;
  /** Short note shown in disabled-tile placeholders explaining why it's off. */
  requires: string;
  /**
   * A feature being retired rather than one waiting on missing infrastructure.
   *
   * Sunset features are **not** governed by `VITE_ENABLE_OPTIONAL_FEATURES`.
   * That variable means "I am the maintainer, show me the unfinished things",
   * and it is set in the maintainer's `.env.local` — so folding a retirement
   * into it would leave the feature on for the one person trying to stop using
   * it. Each sunset feature gets its own variable and defaults off.
   */
  sunset?: boolean;
}

const FEATURES: Record<FeatureId, FeatureDescriptor> = {
  "debug-walkthrough": {
    id: "debug-walkthrough",
    label: "Code Walkthrough",
    requires:
      "Requires a recorded Rust test trace. Recording uses lldb-dap on macOS/Linux or CodeLLDB on Windows. Experimental; not enabled in this build.",
  },
  // Unlike the one above, this one is not hidden because it needs something
  // the build lacks -- it works. It is hidden because tracking work in it made
  // work harder to track, and the free-form text file won. Flagged off rather
  // than deleted: `task_events.task_id` is ON DELETE CASCADE, so removing the
  // tasks would take the note history with it, and that history is what the
  // per-workstream log is meant to inherit.
  tasks: {
    id: "tasks",
    label: "Tasks",
    requires:
      "The task board is being sunset in favour of a per-workstream activity log. Hidden, not removed -- existing tasks and their notes are still in the database. Set VITE_ENABLE_TASKS=1 to bring it back.",
    sunset: true,
  },
};

const BUILD_TIME_ENABLED: boolean =
  (import.meta.env?.VITE_ENABLE_OPTIONAL_FEATURES ?? "0") === "1";

/**
 * Per-feature switches for retired features. Deliberately separate from the
 * master toggle above: see `FeatureDescriptor.sunset`.
 */
const SUNSET_ENABLED: Partial<Record<FeatureId, boolean>> = {
  tasks: (import.meta.env?.VITE_ENABLE_TASKS ?? "0") === "1",
};

// Tests override via _setFeatureFlagOverrideForTests; nulls fall through.
let testOverride: boolean | null = null;

/** True when `id` is a retirement rather than an unfinished feature. */
export function isSunsetFeature(id: FeatureId): boolean {
  return FEATURES[id].sunset === true;
}

export function isFeatureEnabled(id: FeatureId): boolean {
  if (testOverride !== null) return testOverride;
  if (isSunsetFeature(id)) return SUNSET_ENABLED[id] ?? false;
  return BUILD_TIME_ENABLED;
}

export function featureDescriptor(id: FeatureId): FeatureDescriptor {
  return FEATURES[id];
}

/** Test helper. Pass null to clear. Returns a restore fn for convenience. */
export function _setFeatureFlagOverrideForTests(value: boolean | null): () => void {
  const prev = testOverride;
  testOverride = value;
  return () => { testOverride = prev; };
}

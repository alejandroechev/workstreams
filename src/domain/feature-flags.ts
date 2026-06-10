/**
 * Feature flag registry.
 *
 * Flags are evaluated from the build-time env var
 * `VITE_ENABLE_OPTIONAL_FEATURES`. Default: off. Set to `1` to enable
 * every optional feature. Local dev builds set this via `.env.local`
 * (gitignored); CI builds don't set it, so the public release ships
 * with these features hidden.
 *
 * Adding a new flag: append to FeatureId + FEATURES below. Consumers
 * read with isFeatureEnabled(id) — never check the env var directly so
 * we keep one source of truth.
 */

export type FeatureId = "diff-review" | "plan-tile" | "no-verify-blocking";

export const FEATURE_IDS: readonly FeatureId[] = ["diff-review", "plan-tile", "no-verify-blocking"] as const;

interface FeatureDescriptor {
  id: FeatureId;
  /** Human-readable label, shown in disabled-tile placeholders. */
  label: string;
  /** Short note shown in disabled-tile placeholders explaining why it's off. */
  requires: string;
}

const FEATURES: Record<FeatureId, FeatureDescriptor> = {
  "diff-review": {
    id: "diff-review",
    label: "Diff Review",
    requires:
      "Requires the user-level diff-grok skill (planning + MCP bridge). Not enabled in this build.",
  },
  "plan-tile": {
    id: "plan-tile",
    label: "Plan",
    requires:
      "Requires the Copilot CLI plan/todo subsystem with the discipline-guardian extension. Not enabled in this build.",
  },
  "no-verify-blocking": {
    id: "no-verify-blocking",
    label: "Block git --no-verify in sessions",
    requires:
      "Requires the bundled git-no-verify shim that intercepts --no-verify in PTY sessions. Not enabled in this build.",
  },
};

const BUILD_TIME_ENABLED: boolean =
  (import.meta.env?.VITE_ENABLE_OPTIONAL_FEATURES ?? "0") === "1";

// Tests override via _setFeatureFlagOverrideForTests; nulls fall through.
let testOverride: boolean | null = null;

export function isFeatureEnabled(id: FeatureId): boolean {
  void FEATURES[id]; // ensure id is valid
  return testOverride !== null ? testOverride : BUILD_TIME_ENABLED;
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

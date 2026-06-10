import { describe, it, expect, afterEach } from "vitest";
import {
  isFeatureEnabled,
  featureDescriptor,
  FEATURE_IDS,
  _setFeatureFlagOverrideForTests,
} from "../feature-flags";

afterEach(() => _setFeatureFlagOverrideForTests(null));

describe("feature-flags", () => {
  it("exposes a stable id list", () => {
    expect(FEATURE_IDS).toContain("diff-review");
    expect(FEATURE_IDS).toContain("plan-tile");
    expect(FEATURE_IDS).toContain("no-verify-blocking");
  });

  it("returns a stable boolean for every flag at module load (build-time gated)", () => {
    // VITE_ENABLE_OPTIONAL_FEATURES may or may not be set under vitest
    // depending on .env.local. What we care about is that the answer is
    // boolean and consistent across flags (single master toggle).
    const refs = FEATURE_IDS.map((id) => isFeatureEnabled(id));
    for (const v of refs) {
      expect(typeof v).toBe("boolean");
    }
    expect(new Set(refs).size).toBe(1);
  });

  it("test override flips every flag to true", () => {
    _setFeatureFlagOverrideForTests(true);
    expect(isFeatureEnabled("diff-review")).toBe(true);
    expect(isFeatureEnabled("plan-tile")).toBe(true);
    expect(isFeatureEnabled("no-verify-blocking")).toBe(true);
  });

  it("test override flips every flag to false explicitly", () => {
    _setFeatureFlagOverrideForTests(false);
    expect(isFeatureEnabled("diff-review")).toBe(false);
    expect(isFeatureEnabled("no-verify-blocking")).toBe(false);
  });

  it("featureDescriptor returns label + requires for every id", () => {
    for (const id of FEATURE_IDS) {
      const d = featureDescriptor(id);
      expect(d.id).toBe(id);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.requires.length).toBeGreaterThan(0);
    }
  });
});

import { describe, it, expect, afterEach } from "vitest";
import {
  isFeatureEnabled,
  isSunsetFeature,
  isTileTypeEnabled,
  tileTypeFeature,
  featureDescriptor,
  FEATURE_IDS,
  _setFeatureFlagOverrideForTests,
} from "../feature-flags";

afterEach(() => _setFeatureFlagOverrideForTests(null));

describe("feature-flags", () => {
  it("exposes a stable id list", () => {
    expect(FEATURE_IDS).not.toContain("plan-tile");
    expect(FEATURE_IDS).toContain("debug-walkthrough");
  });

  it("returns a stable boolean for every optional flag at module load", () => {
    // VITE_ENABLE_OPTIONAL_FEATURES may or may not be set under vitest
    // depending on .env.local. What we care about is that the answer is
    // boolean and consistent across the flags the master toggle governs.
    // `tasks` is deliberately excluded -- see the sunset describe below.
    const governed = FEATURE_IDS.filter((id) => !isSunsetFeature(id));
    const refs = governed.map((id) => isFeatureEnabled(id));
    for (const v of refs) {
      expect(typeof v).toBe("boolean");
    }
    expect(new Set(refs).size).toBeLessThanOrEqual(1);
  });

  it("test override flips every flag to true", () => {
    _setFeatureFlagOverrideForTests(true);
    expect(isFeatureEnabled("debug-walkthrough")).toBe(true);
  });

  it("test override flips every flag to false explicitly", () => {
    _setFeatureFlagOverrideForTests(false);
    expect(isFeatureEnabled("debug-walkthrough")).toBe(false);
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

/**
 * The task board is being sunset: the user lost track of work in it and went
 * back to free-form text files. It is flagged off rather than deleted so the
 * 26 tasks and 213 task_events stay readable, and because `task_events.task_id`
 * is ON DELETE CASCADE -- deleting the tasks would destroy the note history
 * that is meant to become the per-workstream log.
 */
describe("tasks sunset flag", () => {
  it("registers a tasks flag", () => {
    expect(FEATURE_IDS).toContain("tasks");
  });

  /**
   * The whole point. The maintainer's `.env.local` sets
   * VITE_ENABLE_OPTIONAL_FEATURES=1 to get the Plan tile, so a `tasks` flag
   * governed by that master toggle would leave the board on the one machine
   * it is supposed to disappear from. Sunset features get their own switch and
   * default off.
   */
  it("stays off even when the master optional-features toggle is on", () => {
    _setFeatureFlagOverrideForTests(null);
    expect(isFeatureEnabled("tasks")).toBe(false);
  });

  it("is not governed by the master toggle", () => {
    _setFeatureFlagOverrideForTests(null);
    expect(isSunsetFeature("tasks")).toBe(true);
  });

  it("still honours the test override, so suites can exercise the board", () => {
    _setFeatureFlagOverrideForTests(true);
    expect(isFeatureEnabled("tasks")).toBe(true);
  });
});

/**
 * Tiles the owner does not use: hidden, not deleted. Each is a sunset flag with
 * its own variable, so the maintainer's VITE_ENABLE_OPTIONAL_FEATURES=1 does
 * not bring them back.
 */
describe("tile sunset flags", () => {
  const tiles = [
    ["code_review", "code-review"],
    ["debug_walkthrough", "debug-walkthrough"],
    ["loop_control", "goal-loop"],
  ] as const;

  it.each(tiles)("%s is behind the %s sunset flag, off by default", (tileType, flag) => {
    _setFeatureFlagOverrideForTests(null);
    expect(tileTypeFeature(tileType)).toBe(flag);
    expect(isSunsetFeature(flag)).toBe(true);
    expect(isFeatureEnabled(flag)).toBe(false);
    expect(isTileTypeEnabled(tileType)).toBe(false);
  });

  it("leaves every other tile type alone", () => {
    _setFeatureFlagOverrideForTests(null);
    for (const tileType of ["terminal", "copilot_session", "file_explorer", "session_meta", "workbench", "plan"] as const) {
      expect(tileTypeFeature(tileType)).toBeNull();
      expect(isTileTypeEnabled(tileType)).toBe(true);
    }
  });

  it("follows the test override, so suites can still exercise the tiles", () => {
    _setFeatureFlagOverrideForTests(true);
    expect(isTileTypeEnabled("code_review")).toBe(true);
    expect(isTileTypeEnabled("loop_control")).toBe(true);
  });

  it("says how to bring each one back", () => {
    expect(featureDescriptor("code-review").requires).toContain("VITE_ENABLE_CODE_REVIEW=1");
    expect(featureDescriptor("goal-loop").requires).toContain("VITE_ENABLE_GOAL_LOOP=1");
    expect(featureDescriptor("debug-walkthrough").requires).toContain("VITE_ENABLE_WALKTHROUGH=1");
  });
});

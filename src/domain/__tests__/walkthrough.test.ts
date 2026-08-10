import { describe, it, expect } from "vitest";

import {
  createWalkthrough,
  currentStep,
  canStepBack,
  canStepForward,
  stepForward,
  stepBack,
  gotoStep,
  visibleSteps,
  resolveStepPath,
  totalSteps,
  progressLabel,
} from "../walkthrough";
import type { TraceFile } from "../trace-format";

function trace(steps: TraceFile["steps"]): TraceFile {
  return {
    version: 1,
    test: "a::b",
    repoRoot: "/repo",
    commitSha: "abc1234",
    recordedAt: "2026-08-10T00:00:00.000Z",
    truncated: false,
    steps,
  };
}

const threeSteps = trace([
  { file: "src/a.rs", line: 10, function: "f" },
  { file: "src/a.rs", line: 11, function: "f", hits: 3 },
  { file: "src/b.rs", line: 20, function: "g" },
]);

describe("walkthrough navigation", () => {
  it("starts at the first step", () => {
    const w = createWalkthrough(threeSteps);
    expect(w.index).toBe(0);
    expect(currentStep(w)?.line).toBe(10);
  });

  it("steps forward and back through the trace", () => {
    let w = createWalkthrough(threeSteps);
    w = stepForward(w);
    expect(currentStep(w)?.line).toBe(11);
    w = stepForward(w);
    expect(currentStep(w)?.file).toBe("src/b.rs");
    w = stepBack(w);
    expect(currentStep(w)?.line).toBe(11);
  });

  it("supports stepping backwards, which a live debugger cannot", () => {
    // Free in a replay model — it is just an array index — and an explicit v1
    // feature rather than an accident.
    let w = createWalkthrough(threeSteps);
    w = gotoStep(w, 2);
    w = stepBack(w);
    w = stepBack(w);
    expect(w.index).toBe(0);
  });

  it("clamps at both ends instead of wrapping or going out of range", () => {
    let w = createWalkthrough(threeSteps);
    w = stepBack(w);
    expect(w.index).toBe(0);
    w = gotoStep(w, 2);
    w = stepForward(w);
    expect(w.index).toBe(2);
  });

  it("reports whether movement is possible", () => {
    let w = createWalkthrough(threeSteps);
    expect(canStepBack(w)).toBe(false);
    expect(canStepForward(w)).toBe(true);
    w = gotoStep(w, 2);
    expect(canStepBack(w)).toBe(true);
    expect(canStepForward(w)).toBe(false);
  });

  it("clamps an out-of-range goto rather than throwing", () => {
    // The step list is user-clickable and traces get re-recorded; a stale
    // index must not crash the tile.
    let w = createWalkthrough(threeSteps);
    expect(gotoStep(w, 99).index).toBe(2);
    expect(gotoStep(w, -5).index).toBe(0);
    w = gotoStep(w, 1.7);
    expect(Number.isInteger(w.index)).toBe(true);
  });

  it("never mutates the walkthrough it was given", () => {
    const w = createWalkthrough(threeSteps);
    const next = stepForward(w);
    expect(w.index).toBe(0);
    expect(next).not.toBe(w);
  });

  describe("an empty trace", () => {
    const empty = createWalkthrough(trace([]));

    it("has no current step and cannot move", () => {
      // A test that never enters repo code records zero steps. That is a
      // legitimate trace, so navigation must degrade rather than throw.
      expect(currentStep(empty)).toBeNull();
      expect(canStepBack(empty)).toBe(false);
      expect(canStepForward(empty)).toBe(false);
      expect(stepForward(empty).index).toBe(0);
      expect(totalSteps(empty)).toBe(0);
    });

    it("reports empty progress", () => {
      expect(progressLabel(empty)).toBe("0 / 0");
    });
  });

  it("labels progress 1-based for humans", () => {
    const w = createWalkthrough(threeSteps);
    expect(progressLabel(w)).toBe("1 / 3");
    expect(progressLabel(stepForward(w))).toBe("2 / 3");
  });
});

describe("display filtering", () => {
  const mixed = trace([
    { file: "src/a.rs", line: 1, function: "f" },
    { file: "target/debug/build/gen.rs", line: 2, function: "gen" },
    { file: "src/b.rs", line: 3, function: "g" },
  ]);

  it("hides generated files under target/ by default", () => {
    // Filtering happens at *display*, never at capture: capture-time filtering
    // is destructive and would force a re-record to see a discarded frame.
    const w = createWalkthrough(mixed);
    expect(visibleSteps(w).map((s) => s.file)).toEqual(["src/a.rs", "src/b.rs"]);
  });

  it("can show everything, because the data was never discarded", () => {
    const w = createWalkthrough(mixed, { showGenerated: true });
    expect(visibleSteps(w)).toHaveLength(3);
  });

  it("keeps indices addressing the full step list", () => {
    // The filter is a view. If it renumbered steps, a hidden frame would
    // silently shift every index and navigation would land on the wrong line.
    const w = gotoStep(createWalkthrough(mixed), 2);
    expect(currentStep(w)?.file).toBe("src/b.rs");
    expect(totalSteps(w)).toBe(3);
  });

  it("applies a caller-supplied path filter", () => {
    const w = createWalkthrough(mixed, { fileFilter: (f) => f.startsWith("src/a") });
    expect(visibleSteps(w).map((s) => s.file)).toEqual(["src/a.rs"]);
  });
});

describe("resolveStepPath", () => {
  it("joins a unix root with a unix separator", () => {
    expect(resolveStepPath("/Users/me/repo", "src/a.rs")).toBe("/Users/me/repo/src/a.rs");
  });

  it("joins a Windows root with a backslash", () => {
    expect(resolveStepPath("C:\\repo", "src\\a.rs")).toBe("C:\\repo\\src\\a.rs");
  });

  it("infers the separator from the trace, not the host", () => {
    // Traces are portable by design — recorded on macOS, opened on Windows.
    // Using the *host* separator would splice a unix root onto Windows-style
    // segments and produce a path that resolves nowhere.
    expect(resolveStepPath("/repo", "src\\a.rs")).toBe("/repo/src/a.rs");
    expect(resolveStepPath("C:\\repo", "src/a.rs")).toBe("C:\\repo\\src\\a.rs");
  });

  it("does not double up separators", () => {
    expect(resolveStepPath("/repo/", "/src/a.rs")).toBe("/repo/src/a.rs");
    expect(resolveStepPath("C:\\repo\\", "\\src\\a.rs")).toBe("C:\\repo\\src\\a.rs");
  });
});

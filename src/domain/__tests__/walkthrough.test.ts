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
  canStepOut,
  stepOut,
  stepOutIndex,
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

describe("step out", () => {
  // Shape taken from a real recording: the test calls schema_conn, which calls
  // ensure_review_schema, and control unwinds back through both.
  const nested = trace([
    { file: "a.rs", line: 680, function: "add_list_and_resolve", depth: 1 },
    { file: "a.rs", line: 656, function: "schema_conn", depth: 2 },
    { file: "a.rs", line: 61, function: "ensure_review_schema", depth: 3 },
    { file: "a.rs", line: 90, function: "ensure_review_schema", depth: 3 },
    { file: "a.rs", line: 657, function: "schema_conn", depth: 2 },
    { file: "a.rs", line: 659, function: "schema_conn", depth: 2 },
    { file: "a.rs", line: 681, function: "add_list_and_resolve", depth: 1 },
  ]);

  it("returns to the caller, skipping the rest of the current function", () => {
    // From inside ensure_review_schema, "I'm done here" lands on the line in
    // schema_conn that follows the call — not merely the next step.
    const w = gotoStep(createWalkthrough(nested), 2);
    expect(stepOutIndex(w)).toBe(4);
    expect(currentStep(stepOut(w))?.line).toBe(657);
  });

  it("skips a whole nested subtree when stepping out of the middle frame", () => {
    // From schema_conn, stepping out must pass over ensure_review_schema
    // entirely rather than stopping inside it.
    const w = gotoStep(createWalkthrough(nested), 1);
    expect(currentStep(stepOut(w))?.line).toBe(681);
  });

  it("cannot step out of the outermost frame", () => {
    const w = createWalkthrough(nested);
    expect(canStepOut(w)).toBe(false);
    expect(stepOutIndex(w)).toBeNull();
  });

  it("cannot step out when the frame never returns within the trace", () => {
    // A truncated recording can end mid-call; claiming a return point would
    // send the reader somewhere execution never reached.
    const truncated = trace([
      { file: "a.rs", line: 1, function: "outer", depth: 1 },
      { file: "a.rs", line: 2, function: "inner", depth: 2 },
    ]);
    const w = gotoStep(createWalkthrough(truncated), 1);
    expect(canStepOut(w)).toBe(false);
  });

  it("leaves the walkthrough untouched when there is nowhere to go", () => {
    const w = createWalkthrough(nested);
    expect(stepOut(w)).toBe(w);
  });

  it("handles recursion, which names alone cannot", () => {
    // f calls itself: the caller has the *same* name, so a name-based rule
    // would skip past the recursive parent to the wrong frame.
    const recursive = trace([
      { file: "a.rs", line: 10, function: "f", depth: 1 },
      { file: "a.rs", line: 11, function: "f", depth: 2 },
      { file: "a.rs", line: 11, function: "f", depth: 3 },
      { file: "a.rs", line: 12, function: "f", depth: 2 },
      { file: "a.rs", line: 13, function: "f", depth: 1 },
    ]);
    const w = gotoStep(createWalkthrough(recursive), 2);
    expect(stepOutIndex(w)).toBe(3);
  });

  describe("traces recorded before depth was captured", () => {
    // `depth` is optional, so older traces must still get a useful step-out
    // rather than a disabled button.
    const noDepth = trace([
      { file: "a.rs", line: 680, function: "add_list_and_resolve" },
      { file: "a.rs", line: 656, function: "schema_conn" },
      { file: "a.rs", line: 61, function: "ensure_review_schema" },
      { file: "a.rs", line: 657, function: "schema_conn" },
      { file: "a.rs", line: 681, function: "add_list_and_resolve" },
    ]);

    it("falls back to returning to the calling function by name", () => {
      const w = gotoStep(createWalkthrough(noDepth), 2);
      expect(currentStep(stepOut(w))?.line).toBe(657);
    });

    it("still refuses at the outermost frame", () => {
      expect(canStepOut(createWalkthrough(noDepth))).toBe(false);
    });
  });
});

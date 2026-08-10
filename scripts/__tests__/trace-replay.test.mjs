import { describe, it, expect } from "vitest";

import {
  formatStepLine,
  sourceContext,
  formatStepDetail,
  parseReplayCommand,
} from "../trace-replay.mjs";

const step = { file: "src/a.rs", line: 3, function: "mycrate::thing::run" };

describe("formatStepLine", () => {
  it("renders index, location and function", () => {
    const out = formatStepLine(step, 0, 5);
    expect(out).toContain("1/5");
    expect(out).toContain("src/a.rs:3");
    expect(out).toContain("run");
  });

  it("shows a hits count when a location was collapsed", () => {
    // Without this the reader silently loses the fact that a line was
    // re-entered several times.
    expect(formatStepLine({ ...step, hits: 4 }, 0, 5)).toMatch(/x4/);
  });

  it("omits the hits marker for a single visit", () => {
    expect(formatStepLine(step, 0, 5)).not.toMatch(/x1\b/);
  });

  it("marks the current step so it is findable in a long list", () => {
    expect(formatStepLine(step, 2, 9, true)).toMatch(/^\s*>/);
    expect(formatStepLine(step, 2, 9, false)).not.toMatch(/^\s*>/);
  });
});

describe("sourceContext", () => {
  const lines = ["one", "two", "three", "four", "five", "six", "seven"];

  it("returns the target line plus surrounding context", () => {
    const ctx = sourceContext(lines, 4, 2);
    expect(ctx.map((c) => c.line)).toEqual([2, 3, 4, 5, 6]);
    expect(ctx.find((c) => c.isTarget)?.text).toBe("four");
  });

  it("clamps at the start of the file", () => {
    const ctx = sourceContext(lines, 1, 3);
    expect(ctx[0].line).toBe(1);
    expect(ctx.find((c) => c.isTarget)?.text).toBe("one");
  });

  it("clamps at the end of the file", () => {
    const ctx = sourceContext(lines, 7, 3);
    expect(ctx[ctx.length - 1].line).toBe(7);
  });

  it("returns nothing when the line is out of range", () => {
    // A stale trace can point past the end of an edited file; that must not
    // throw, because replay is deliberately still allowed on stale traces.
    expect(sourceContext(lines, 99, 2)).toEqual([]);
    expect(sourceContext(lines, 0, 2)).toEqual([]);
  });
});

describe("formatStepDetail", () => {
  it("includes the location and the source context", () => {
    const out = formatStepDetail(step, 0, 3, ["a", "b", "c", "d"]);
    expect(out).toContain("src/a.rs:3");
    expect(out).toContain("c"); // line 3
  });

  it("says so when the source cannot be read", () => {
    // Better an explicit note than a blank gap the reader has to interpret.
    expect(formatStepDetail(step, 0, 3, null)).toMatch(/source unavailable/i);
  });
});

describe("parseReplayCommand", () => {
  it("understands next and its shorthands", () => {
    for (const input of ["n", "next", ""]) {
      expect(parseReplayCommand(input)).toEqual({ type: "next" });
    }
  });

  it("understands previous", () => {
    for (const input of ["p", "prev", "previous"]) {
      expect(parseReplayCommand(input)).toEqual({ type: "prev" });
    }
  });

  it("understands goto with a 1-based number", () => {
    // The display is 1-based, so the command must be too — asking a user to
    // mentally subtract one is a bug generator.
    expect(parseReplayCommand("5")).toEqual({ type: "goto", index: 4 });
    expect(parseReplayCommand("goto 5")).toEqual({ type: "goto", index: 4 });
  });

  it("understands list and quit", () => {
    expect(parseReplayCommand("l")).toEqual({ type: "list" });
    expect(parseReplayCommand("list")).toEqual({ type: "list" });
    expect(parseReplayCommand("q")).toEqual({ type: "quit" });
    expect(parseReplayCommand("quit")).toEqual({ type: "quit" });
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseReplayCommand("  NEXT  ")).toEqual({ type: "next" });
  });

  it("rejects anything else rather than guessing", () => {
    expect(parseReplayCommand("frobnicate")).toEqual({ type: "unknown", input: "frobnicate" });
    expect(parseReplayCommand("goto abc")).toEqual({ type: "unknown", input: "goto abc" });
  });
});

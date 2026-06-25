import { describe, it, expect } from "vitest";
import { groupMatchesByFile, computeHighlightSegments } from "../content-search";
import type { FileSearchMatch } from "../../backend/types";

function m(path: string, line: number, text: string): FileSearchMatch {
  return { path, line_number: line, line_text: text };
}

describe("groupMatchesByFile", () => {
  it("returns an empty array for no matches", () => {
    expect(groupMatchesByFile([], "/repo")).toEqual([]);
  });

  it("groups matches by file preserving first-seen order and counts", () => {
    const matches = [
      m("/repo/a.ts", 1, "x"),
      m("/repo/b.ts", 2, "y"),
      m("/repo/a.ts", 5, "z"),
    ];
    const groups = groupMatchesByFile(matches, "/repo");
    expect(groups.map((g) => g.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
    expect(groups[0].matches).toHaveLength(2);
    expect(groups[1].matches).toHaveLength(1);
    expect(groups[0].matches.map((x) => x.line_number)).toEqual([1, 5]);
  });

  it("computes a repo-relative path against rootDir (posix separators)", () => {
    const groups = groupMatchesByFile([m("/repo/src/a.ts", 1, "x")], "/repo");
    expect(groups[0].relPath).toBe("src/a.ts");
  });

  it("computes a repo-relative path against rootDir (windows separators)", () => {
    const groups = groupMatchesByFile([m("C:\\repo\\src\\a.ts", 1, "x")], "C:\\repo");
    expect(groups[0].relPath).toBe("src/a.ts");
  });

  it("falls back to the full path when it is not under rootDir", () => {
    const groups = groupMatchesByFile([m("/other/a.ts", 1, "x")], "/repo");
    expect(groups[0].relPath).toBe("/other/a.ts");
  });

  it("uses the full path as relPath when rootDir is empty", () => {
    const groups = groupMatchesByFile([m("/repo/a.ts", 1, "x")], "");
    expect(groups[0].relPath).toBe("/repo/a.ts");
  });
});

describe("computeHighlightSegments", () => {
  it("returns a single non-match segment when the query is empty", () => {
    expect(computeHighlightSegments("hello world", "")).toEqual([
      { text: "hello world", match: false },
    ]);
  });

  it("returns a single non-match segment when there is no match", () => {
    expect(computeHighlightSegments("hello world", "xyz")).toEqual([
      { text: "hello world", match: false },
    ]);
  });

  it("splits a single match into before / match / after", () => {
    expect(computeHighlightSegments("a needle b", "needle")).toEqual([
      { text: "a ", match: false },
      { text: "needle", match: true },
      { text: " b", match: false },
    ]);
  });

  it("matches case-insensitively by default but preserves original casing", () => {
    expect(computeHighlightSegments("A Needle here", "needle")).toEqual([
      { text: "A ", match: false },
      { text: "Needle", match: true },
      { text: " here", match: false },
    ]);
  });

  it("highlights multiple occurrences", () => {
    expect(computeHighlightSegments("ababa", "a")).toEqual([
      { text: "a", match: true },
      { text: "b", match: false },
      { text: "a", match: true },
      { text: "b", match: false },
      { text: "a", match: true },
    ]);
  });

  it("handles a match at the start and end", () => {
    expect(computeHighlightSegments("needle", "needle")).toEqual([
      { text: "needle", match: true },
    ]);
  });

  it("respects caseSensitive=true (no match on different casing)", () => {
    expect(computeHighlightSegments("Needle", "needle", true)).toEqual([
      { text: "Needle", match: false },
    ]);
  });
});

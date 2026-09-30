import { describe, it, expect } from "vitest";
import {
  diffFileLabel,
  commentThreadCountsByFile,
  commentOnlyHiddenRanges,
} from "../diff-comment-filter";
import type { SessionFileComment } from "../file-comments";

function comment(over: Partial<SessionFileComment> = {}): SessionFileComment {
  return {
    id: "c",
    workstream_id: "ws",
    file: "src/a.ts",
    anchor_line_start: 10,
    anchor_line_end: 10,
    anchor_text: null,
    body: "b",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("diff file list labels", () => {
  it("puts the file name first and its directory after", () => {
    expect(diffFileLabel("src/tiles/RepoExplorerTile.tsx")).toEqual({
      name: "RepoExplorerTile.tsx",
      dir: "src/tiles",
    });
  });

  it("has no directory for a file at the repo root", () => {
    expect(diffFileLabel("README.md")).toEqual({ name: "README.md", dir: "" });
  });

  it("accepts Windows separators", () => {
    expect(diffFileLabel("src\\domain\\x.ts")).toEqual({ name: "x.ts", dir: "src/domain" });
  });
});

describe("counting comment threads per file", () => {
  it("counts threads, not replies", () => {
    const counts = commentThreadCountsByFile([
      comment({ id: "a" }),
      comment({ id: "r", parent_id: "a" }),
      comment({ id: "b", anchor_line_start: 20, anchor_line_end: 20 }),
      comment({ id: "c", file: "src/b.ts" }),
    ]);
    expect(counts.get("src/a.ts")).toBe(2);
    expect(counts.get("src/b.ts")).toBe(1);
    expect(counts.get("src/none.ts")).toBeUndefined();
  });
});

describe("hiding code that has no comments", () => {
  it("keeps a few lines of context around each comment and hides the rest", () => {
    expect(commentOnlyHiddenRanges(100, [comment({ anchor_line_start: 40, anchor_line_end: 42 })], 3))
      .toEqual([
        { startLineNumber: 1, endLineNumber: 36 },
        { startLineNumber: 46, endLineNumber: 100 },
      ]);
  });

  it("merges comments whose context windows touch or overlap", () => {
    expect(commentOnlyHiddenRanges(100, [
      comment({ id: "a", anchor_line_start: 10, anchor_line_end: 10 }),
      comment({ id: "b", anchor_line_start: 17, anchor_line_end: 17 }),
    ], 3)).toEqual([
      { startLineNumber: 1, endLineNumber: 6 },
      { startLineNumber: 21, endLineNumber: 100 },
    ]);
  });

  it("does not hide past either end of the file", () => {
    expect(commentOnlyHiddenRanges(10, [
      comment({ id: "a", anchor_line_start: 1, anchor_line_end: 1 }),
      comment({ id: "b", anchor_line_start: 10, anchor_line_end: 10 }),
    ], 3)).toEqual([{ startLineNumber: 5, endLineNumber: 6 }]);
  });

  it("clamps anchors that drifted past the end of a shorter file", () => {
    expect(commentOnlyHiddenRanges(20, [comment({ anchor_line_start: 50, anchor_line_end: 55 })], 3))
      .toEqual([{ startLineNumber: 1, endLineNumber: 16 }]);
  });

  it("anchors replies by their thread, so a reply never widens what is shown", () => {
    expect(commentOnlyHiddenRanges(100, [
      comment({ id: "a", anchor_line_start: 50, anchor_line_end: 50 }),
      comment({ id: "r", parent_id: "a", anchor_line_start: 90, anchor_line_end: 90 }),
    ], 0)).toEqual([
      { startLineNumber: 1, endLineNumber: 49 },
      { startLineNumber: 51, endLineNumber: 100 },
    ]);
  });

  // Hiding every line would leave an empty pane with no way back to the code.
  it("hides nothing when the file has no comments", () => {
    expect(commentOnlyHiddenRanges(100, [], 3)).toEqual([]);
    expect(commentOnlyHiddenRanges(0, [comment()], 3)).toEqual([]);
  });
});

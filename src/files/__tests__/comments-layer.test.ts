import { describe, it, expect } from "vitest";
import {
  selectionToAnchor,
  formatCommentMeta,
  isMutable,
  estimateZoneHeightInLines,
} from "../comments-layer";
import type { FileComment } from "../../domain/file-comments";

const baseComment: FileComment = {
  id: "fc-1",
  workstream_id: "ws-1",
  absolute_path: "C:/a.ts",
  anchor_line_start: 1,
  anchor_line_end: 1,
  anchor_text: null,
  body_md: "hi",
  author: "me",
  origin_type: "user",
  origin_pr_id: null,
  origin_comment_id: null,
  origin_thread_id: null,
  origin_parent_id: null,
  origin_url: null,
  status: null,
  created_at: "0",
  updated_at: "0",
};

describe("selectionToAnchor", () => {
  const lines = ["line1", "line2", "line3", "line4"];

  it("returns null for an invalid range", () => {
    expect(selectionToAnchor(lines, 0, 1)).toBeNull();
    expect(selectionToAnchor(lines, 2, 1)).toBeNull();
  });

  it("captures the joined snippet for the selected lines", () => {
    expect(selectionToAnchor(lines, 2, 3)).toEqual({
      start: 2,
      end: 3,
      anchorText: "line2\nline3",
    });
  });

  it("clamps to the file length and still returns the trailing line", () => {
    expect(selectionToAnchor(lines, 3, 99)).toEqual({
      start: 3,
      end: 4,
      anchorText: "line3\nline4",
    });
  });

  it("returns null when both ends are past file length", () => {
    expect(selectionToAnchor([], 1, 1)).toBeNull();
  });
});

describe("formatCommentMeta", () => {
  it("renders the bare author for user comments", () => {
    expect(formatCommentMeta(baseComment)).toBe("me");
  });

  it("renders PR + status for imported comments", () => {
    const imported: FileComment = {
      ...baseComment,
      origin_type: "ado-pr",
      author: "alice",
      origin_pr_id: "42",
      status: "fixed",
    };
    expect(formatCommentMeta(imported)).toBe("alice · PR #42 · fixed");
  });

  it("falls back to 'active' when imported comment has no status", () => {
    const imported: FileComment = {
      ...baseComment,
      origin_type: "ado-pr",
      author: "alice",
      origin_pr_id: "42",
      status: null,
    };
    expect(formatCommentMeta(imported)).toBe("alice · PR #42 · active");
  });
});

describe("isMutable", () => {
  it("is true for user comments", () => {
    expect(isMutable(baseComment)).toBe(true);
  });
  it("is false for imported comments", () => {
    expect(isMutable({ ...baseComment, origin_type: "ado-pr" })).toBe(false);
  });
});

describe("estimateZoneHeightInLines", () => {
  it("uses a minimum of 3 lines", () => {
    expect(estimateZoneHeightInLines("x")).toBe(3);
  });
  it("counts explicit newlines", () => {
    // 1 header + 3 body + 1 padding
    expect(estimateZoneHeightInLines("a\nb\nc")).toBe(5);
  });
  it("counts wrapping at ~80 chars per visual line", () => {
    const longLine = "x".repeat(240); // 3 visual lines
    // 1 header + 3 wrapped + 1 padding
    expect(estimateZoneHeightInLines(longLine)).toBe(5);
  });
});

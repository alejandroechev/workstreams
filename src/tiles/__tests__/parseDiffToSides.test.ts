import { describe, it, expect } from "vitest";
import { parseDiffToSides } from "../ExplorerTile";

describe("parseDiffToSides", () => {
  it("returns empty strings for empty input", () => {
    const result = parseDiffToSides("");
    expect(result).toEqual({ original: "", modified: "" });
  });

  it("returns empty strings for whitespace-only input", () => {
    const result = parseDiffToSides("   \n  ");
    expect(result).toEqual({ original: "", modified: "" });
  });

  it("parses a simple unified diff with added and removed lines", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "index abc..def 100644",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      " const c = 4;",
    ].join("\n");

    const { original, modified } = parseDiffToSides(diff);
    expect(original).toBe("const a = 1;\nconst b = 2;\nconst c = 4;");
    expect(modified).toBe("const a = 1;\nconst b = 3;\nconst c = 4;");
  });

  it("handles additions only", () => {
    const diff = [
      "@@ -1,2 +1,3 @@",
      " line1",
      "+new line",
      " line2",
    ].join("\n");

    const { original, modified } = parseDiffToSides(diff);
    expect(original).toBe("line1\nline2");
    expect(modified).toBe("line1\nnew line\nline2");
  });

  it("handles deletions only", () => {
    const diff = [
      "@@ -1,3 +1,2 @@",
      " line1",
      "-removed line",
      " line2",
    ].join("\n");

    const { original, modified } = parseDiffToSides(diff);
    expect(original).toBe("line1\nremoved line\nline2");
    expect(modified).toBe("line1\nline2");
  });

  it("handles multiple hunks", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-old1",
      "+new1",
      " same",
      "@@ -10,2 +10,2 @@",
      "-old2",
      "+new2",
      " same2",
    ].join("\n");

    const { original, modified } = parseDiffToSides(diff);
    expect(original).toContain("old1");
    expect(original).toContain("old2");
    expect(modified).toContain("new1");
    expect(modified).toContain("new2");
  });
});

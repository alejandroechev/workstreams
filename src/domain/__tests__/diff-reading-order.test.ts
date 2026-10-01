import { describe, it, expect } from "vitest";
import {
  sortDiffFiles,
  defaultDiffSort,
  driftDescription,
  READING_ORDER_PROMPT,
} from "../diff-reading-order";

const files = (...paths: string[]) => paths.map((path) => ({ path, status: "M" as const }));
const paths = (rows: Array<{ file: { path: string } }>) => rows.map((row) => row.file.path);
const positions = (rows: Array<{ position: number | null }>) => rows.map((row) => row.position);

describe("sorting the diff file list", () => {
  it("sorts by full path for Name, so a folder's files stay together", () => {
    const rows = sortDiffFiles(files("src/b/a.ts", "src/a/z.ts", "README.md"), null, "name");
    expect(paths(rows)).toEqual(["README.md", "src/a/z.ts", "src/b/a.ts"]);
    expect(positions(rows)).toEqual([null, null, null]);
  });

  it("follows the saved order for Recommended and numbers the rows from 1", () => {
    const rows = sortDiffFiles(
      files("a.ts", "b.ts", "c.ts"),
      { paths: ["c.ts", "a.ts", "b.ts"], freshness: "current" },
      "recommended",
    );
    expect(paths(rows)).toEqual(["c.ts", "a.ts", "b.ts"]);
    expect(positions(rows)).toEqual([1, 2, 3]);
  });

  // C2: survivors keep their order, new files follow by path, removed go.
  it("degrades a stale order instead of discarding it", () => {
    const rows = sortDiffFiles(
      files("a.ts", "c.ts", "aa.ts", "0.ts"),
      { paths: ["c.ts", "a.ts", "b.ts"], freshness: "files_changed" },
      "recommended",
    );
    expect(paths(rows)).toEqual(["c.ts", "a.ts", "0.ts", "aa.ts"]);
    expect(positions(rows)).toEqual([1, 2, 3, 4]);
  });

  it("falls back to Name when Recommended is asked for but there is no order", () => {
    expect(paths(sortDiffFiles(files("b", "a"), null, "recommended"))).toEqual(["a", "b"]);
  });

  it("does not change the caller's list", () => {
    const input = files("b", "a");
    sortDiffFiles(input, null, "name");
    expect(paths(input.map((file) => ({ file })))).toEqual(["b", "a"]);
  });
});

describe("the default sort", () => {
  it("is Recommended whenever an order exists, stale or not, and Name otherwise", () => {
    expect(defaultDiffSort({ paths: [], freshness: "current" })).toBe("recommended");
    expect(defaultDiffSort({ paths: [], freshness: "files_changed" })).toBe("recommended");
    expect(defaultDiffSort(null)).toBe("name");
  });
});

describe("describing drift", () => {
  it("names what changed and how to regenerate", () => {
    expect(driftDescription("current")).toBeNull();
    expect(driftDescription("content_changed")).toMatch(/content.*changed/i);
    const files = driftDescription("files_changed")!;
    expect(files).toMatch(/files.*(added|removed)/i);
    expect(files).toContain(READING_ORDER_PROMPT);
    expect(driftDescription("content_changed")).toContain(READING_ORDER_PROMPT);
  });
});

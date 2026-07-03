import { describe, it, expect } from "vitest";
import {
  groupThreads,
  threadsByLine,
  isOpenThread,
  attentionCount,
  openCount,
  statusLabel,
  basename,
  fileStatusLabel,
} from "../code-review-view";
import type { ReviewComment } from "../code-review";

function c(over: Partial<ReviewComment> & { id: string }): ReviewComment {
  return {
    review_id: "r1",
    file: "a.js",
    line: 1,
    side: "new",
    code: null,
    hunk_header: null,
    body: "",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    ...over,
  };
}

describe("code-review-view helpers", () => {
  it("groups replies under roots, ordered by created_at", () => {
    const root = c({ id: "root" });
    const r2 = c({ id: "r2", parent_id: "root", author: "agent", created_at: "2026-01-03" });
    const r1 = c({ id: "r1c", parent_id: "root", author: "reviewer", created_at: "2026-01-02" });
    const threads = groupThreads([root, r2, r1]);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((x) => x.id)).toEqual(["r1c", "r2"]);
  });

  it("indexes threads by new-side line for a file", () => {
    const threads = groupThreads([
      c({ id: "a", file: "a.js", line: 4 }),
      c({ id: "b", file: "a.js", line: 9 }),
      c({ id: "d", file: "b.js", line: 4 }),
    ]);
    const map = threadsByLine(threads, "a.js");
    expect([...map.keys()].sort((x, y) => x - y)).toEqual([4, 9]);
    expect(map.get(4)![0].root.id).toBe("a");
  });

  it("isOpenThread is false only for resolved/wontfix", () => {
    expect(isOpenThread(c({ id: "a", status: "open" }))).toBe(true);
    expect(isOpenThread(c({ id: "b", status: "addressed" }))).toBe(true);
    expect(isOpenThread(c({ id: "c", status: "resolved" }))).toBe(false);
    expect(isOpenThread(c({ id: "d", status: "wontfix" }))).toBe(false);
  });

  it("attentionCount = open + addressed; openCount = all open", () => {
    const threads = groupThreads([
      c({ id: "a", status: "addressed" }), // attention
      c({ id: "b", status: "open" }), // open, not attention
      c({ id: "e", status: "resolved" }), // neither
    ]);
    expect(attentionCount(threads)).toBe(1);
    expect(openCount(threads)).toBe(2);
  });

  it("labels", () => {
    expect(statusLabel("addressed")).toBe("Addressed");
    expect(statusLabel("resolved")).toBe("Resolved");
    expect(statusLabel("wontfix")).toBe("Won't fix");
    expect(statusLabel("open")).toBe("Open");
    expect(fileStatusLabel("A")).toBe("added");
    expect(fileStatusLabel("D")).toBe("deleted");
    expect(fileStatusLabel("R")).toBe("renamed");
    expect(fileStatusLabel("M")).toBe("modified");
    expect(basename("C:/repo/src/a.js")).toBe("a.js");
    expect(basename("src\\b.ts")).toBe("b.ts");
  });
});

import { describe, it, expect } from "vitest";
import {
  groupThreads,
  basename,
  isOpenThread,
  attentionCount,
  statusLabel,
  allThreadsClosed,
} from "../agent-review-view";
import type { ReviewComment } from "../agent-review";

function comment(over: Partial<ReviewComment> & { id: string }): ReviewComment {
  return {
    review_id: "r1",
    workstream_id: "ws1",
    absolute_path: "C:/repo/a.js",
    anchor_line_start: 1,
    anchor_line_end: 1,
    anchor_text: null,
    body_md: "",
    author: "me",
    status: "open",
    origin_parent_id: null,
    round: 1,
    anchor_state: "unchanged",
    fixing_commit: null,
    anchor_commit: "c",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    fixing_hunk: null,
    ...over,
  };
}

describe("agent-review-view helpers", () => {
  it("groups replies under their root, ordered by created_at", () => {
    const root = comment({ id: "root" });
    const r2 = comment({ id: "r2", origin_parent_id: "root", author: "agent", created_at: "2026-01-03" });
    const r1 = comment({ id: "r1c", origin_parent_id: "root", author: "me", created_at: "2026-01-02" });
    const threads = groupThreads([root, r2, r1]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("root");
    expect(threads[0].replies.map((c) => c.id)).toEqual(["r1c", "r2"]);
  });

  it("basename handles both separators", () => {
    expect(basename("C:/repo/src/a.js")).toBe("a.js");
    expect(basename("C:\\repo\\src\\b.ts")).toBe("b.ts");
    expect(basename("single")).toBe("single");
  });

  it("isOpenThread is false only for resolved/wontfix", () => {
    expect(isOpenThread(comment({ id: "a", status: "open" }))).toBe(true);
    expect(isOpenThread(comment({ id: "b", status: "addressed" }))).toBe(true);
    expect(isOpenThread(comment({ id: "c", status: "resolved" }))).toBe(false);
    expect(isOpenThread(comment({ id: "d", status: "wontfix" }))).toBe(false);
    expect(isOpenThread(comment({ id: "e", status: null }))).toBe(true);
  });

  it("attentionCount counts open + changed threads only", () => {
    const threads = groupThreads([
      comment({ id: "a", status: "open", anchor_state: "changed" }), // counts
      comment({ id: "b", status: "open", anchor_state: "unchanged" }), // no
      comment({ id: "c", status: "resolved", anchor_state: "changed" }), // no (closed)
    ]);
    expect(attentionCount(threads)).toBe(1);
  });

  it("statusLabel maps known + unknown states", () => {
    expect(statusLabel("addressed")).toBe("Addressed");
    expect(statusLabel("resolved")).toBe("Resolved");
    expect(statusLabel("wontfix")).toBe("Won't fix");
    expect(statusLabel(null)).toBe("Open");
    expect(statusLabel("open")).toBe("Open");
  });

  it("allThreadsClosed requires at least one thread, all closed", () => {
    expect(allThreadsClosed([])).toBe(false);
    expect(
      allThreadsClosed(groupThreads([comment({ id: "a", status: "resolved" })])),
    ).toBe(true);
    expect(
      allThreadsClosed(groupThreads([comment({ id: "a", status: "open" })])),
    ).toBe(false);
  });
});

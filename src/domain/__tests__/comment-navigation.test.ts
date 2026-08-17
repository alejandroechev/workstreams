import { describe, it, expect } from "vitest";
import {
  groupByFile,
  filterComments,
  detectDrift,
  type CommentFilters,
} from "../comment-navigation";
import type { SessionFileComment } from "../file-comments";

function c(over: Partial<SessionFileComment> & { id: string }): SessionFileComment {
  return {
    workstream_id: "ws-1",
    file: "src/a.ts",
    anchor_line_start: 1,
    anchor_line_end: 1,
    anchor_text: null,
    body: "body",
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-08-17T10:00:00Z",
    updated_at: "2026-08-17T10:00:00Z",
    ...over,
  };
}

describe("groupByFile", () => {
  it("groups thread roots under their file, sorted by path then line", () => {
    const groups = groupByFile([
      c({ id: "b1", file: "src/b.ts", anchor_line_start: 3 }),
      c({ id: "a2", file: "src/a.ts", anchor_line_start: 20 }),
      c({ id: "a1", file: "src/a.ts", anchor_line_start: 5 }),
    ]);

    expect(groups.map((g) => g.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(groups[0].threads.map((t) => t.root.id)).toEqual(["a1", "a2"]);
  });

  it("nests replies under their root instead of listing them as threads", () => {
    const groups = groupByFile([
      c({ id: "root" }),
      c({ id: "r1", parent_id: "root", created_at: "2026-08-17T11:00:00Z" }),
      c({ id: "r2", parent_id: "root", created_at: "2026-08-17T12:00:00Z" }),
    ]);

    expect(groups[0].threads).toHaveLength(1);
    expect(groups[0].threads[0].replyCount).toBe(2);
    expect(groups[0].threads[0].replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("orders replies chronologically across mixed timestamp formats", () => {
    // The tile historically wrote epoch seconds; agents/importers write ISO.
    const epochLater = String(Math.floor(Date.parse("2026-08-17T13:00:00Z") / 1000));
    const groups = groupByFile([
      c({ id: "root" }),
      c({ id: "mine", parent_id: "root", created_at: epochLater }),
      c({ id: "agent", parent_id: "root", created_at: "2026-08-17T12:00:00Z" }),
    ]);

    expect(groups[0].threads[0].replies.map((r) => r.id)).toEqual(["agent", "mine"]);
  });

  it("keeps a reply whose root is missing so it cannot silently vanish", () => {
    const groups = groupByFile([c({ id: "orphan", parent_id: "gone" })]);

    expect(groups[0].threads.map((t) => t.root.id)).toEqual(["orphan"]);
  });

  it("counts threads and comments per file", () => {
    const groups = groupByFile([
      c({ id: "root" }),
      c({ id: "reply", parent_id: "root" }),
      c({ id: "other", anchor_line_start: 9 }),
    ]);

    expect(groups[0].threadCount).toBe(2);
    expect(groups[0].commentCount).toBe(3);
  });

  it("returns nothing for an empty list", () => {
    expect(groupByFile([])).toEqual([]);
  });
});

describe("filterComments", () => {
  const list = [
    c({ id: "open-me", status: "open", author: "Eduardo Fernandez", body: "use Duration" }),
    c({ id: "resolved-mine", status: "resolved", author: "reviewer", body: "typo" }),
    c({ id: "agent-note", status: "addressed", author: "agent", file: "src/deep/x.ts" }),
  ];
  const all: CommentFilters = { statuses: [], authors: [], text: "" };

  it("returns everything when no filter is set", () => {
    expect(filterComments(list, all)).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(filterComments(list, { ...all, statuses: ["open"] }).map((x) => x.id)).toEqual([
      "open-me",
    ]);
  });

  it("filters by author", () => {
    expect(
      filterComments(list, { ...all, authors: ["Eduardo Fernandez"] }).map((x) => x.id),
    ).toEqual(["open-me"]);
  });

  it("matches text against body and path, case-insensitively", () => {
    expect(filterComments(list, { ...all, text: "duration" }).map((x) => x.id)).toEqual(["open-me"]);
    expect(filterComments(list, { ...all, text: "deep/" }).map((x) => x.id)).toEqual(["agent-note"]);
  });

  it("combines filters with AND", () => {
    expect(filterComments(list, { statuses: ["open"], authors: ["agent"], text: "" })).toEqual([]);
  });

  it("keeps a reply when its root matches, so threads stay intact", () => {
    const withReply = [
      c({ id: "root", status: "open" }),
      c({ id: "reply", parent_id: "root", status: "resolved" }),
    ];
    expect(filterComments(withReply, { ...all, statuses: ["open"] }).map((x) => x.id)).toEqual([
      "root",
      "reply",
    ]);
  });
});

describe("detectDrift", () => {
  const lines = ["const a = 1;", "const b = 2;", "const c = 3;"];

  it("reports unknown when there is no snapshot to compare", () => {
    expect(detectDrift(c({ id: "x", anchor_text: null }), lines)).toBe("unknown");
  });

  it("reports unknown when the file content is unavailable", () => {
    expect(detectDrift(c({ id: "x", anchor_text: "const b = 2;" }), null)).toBe("unknown");
  });

  it("reports fresh when the anchored lines still match", () => {
    const comment = c({ id: "x", anchor_line_start: 2, anchor_line_end: 2, anchor_text: "const b = 2;" });
    expect(detectDrift(comment, lines)).toBe("fresh");
  });

  it("reports fresh for a multi-line anchor that still matches", () => {
    const comment = c({
      id: "x",
      anchor_line_start: 1,
      anchor_line_end: 2,
      anchor_text: "const a = 1;\nconst b = 2;",
    });
    expect(detectDrift(comment, lines)).toBe("fresh");
  });

  it("reports drifted when the line now holds different code", () => {
    const comment = c({ id: "x", anchor_line_start: 2, anchor_line_end: 2, anchor_text: "const OLD = 9;" });
    expect(detectDrift(comment, lines)).toBe("drifted");
  });

  it("reports drifted when the anchor is past the end of the file", () => {
    const comment = c({ id: "x", anchor_line_start: 99, anchor_line_end: 99, anchor_text: "gone" });
    expect(detectDrift(comment, lines)).toBe("drifted");
  });

  it("ignores trailing whitespace differences", () => {
    const comment = c({ id: "x", anchor_line_start: 2, anchor_line_end: 2, anchor_text: "const b = 2;   " });
    expect(detectDrift(comment, lines)).toBe("fresh");
  });
});

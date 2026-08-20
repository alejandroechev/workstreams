import { describe, it, expect } from "vitest";
import {
  selectionToAnchor,
  formatCommentMeta,
  formatThreadForCopy,
  isMutable,
  isClosedStatus,
  hideResolvedComments,
  groupCommentThreads,
  estimateThreadHeightInLines,
  commentTimeValue,
} from "../comments-layer";
import type { SessionFileComment } from "../../domain/file-comments";

const baseComment: SessionFileComment = {
  id: "fc-1",
  workstream_id: "ws-1",
  file: "src/a.ts",
  anchor_line_start: 1,
  anchor_line_end: 1,
  anchor_text: null,
  body: "hi",
  author: "reviewer",
  parent_id: null,
  status: "open",
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
  it("renders 'you' + status for a reviewer note", () => {
    expect(formatCommentMeta(baseComment)).toBe("you · open");
  });

  it("renders 'agent' + status for an agent reply", () => {
    const reply: SessionFileComment = {
      ...baseComment,
      author: "agent",
      parent_id: "fc-1",
      status: "addressed",
    };
    expect(formatCommentMeta(reply)).toBe("agent · addressed");
  });
});

describe("isMutable", () => {
  it("is true for reviewer notes", () => {
    expect(isMutable(baseComment)).toBe(true);
  });
  it("is false for agent replies", () => {
    expect(isMutable({ ...baseComment, author: "agent" })).toBe(false);
  });
});

describe("isClosedStatus", () => {
  it("treats resolved / wontfix as closed", () => {
    expect(isClosedStatus("resolved")).toBe(true);
    expect(isClosedStatus("wontfix")).toBe(true);
  });
  it("treats open / addressed as not closed", () => {
    expect(isClosedStatus("open")).toBe(false);
    expect(isClosedStatus("addressed")).toBe(false);
  });
});

describe("groupCommentThreads", () => {
  it("nests agent replies under their reviewer root, sorted by created_at", () => {
    const root: SessionFileComment = { ...baseComment, id: "r1" };
    const reply2: SessionFileComment = {
      ...baseComment,
      id: "a2",
      author: "agent",
      parent_id: "r1",
      body: "second",
      created_at: "2",
    };
    const reply1: SessionFileComment = {
      ...baseComment,
      id: "a1",
      author: "agent",
      parent_id: "r1",
      body: "first",
      created_at: "1",
    };
    const threads = groupCommentThreads([root, reply2, reply1]);
    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("r1");
    expect(threads[0].replies.map((r) => r.id)).toEqual(["a1", "a2"]);
  });

  it("drops replies whose parent is absent", () => {
    const orphan: SessionFileComment = {
      ...baseComment,
      id: "a1",
      author: "agent",
      parent_id: "missing",
    };
    expect(groupCommentThreads([orphan])).toEqual([]);
  });
});

describe("estimateThreadHeightInLines", () => {
  it("uses a minimum of 3 lines for a single short root", () => {
    expect(
      estimateThreadHeightInLines({ root: { ...baseComment, body: "x" }, replies: [] }),
    ).toBe(3);
  });
  it("adds a header + body lines per reply", () => {
    const root = { ...baseComment, body: "a\nb\nc" };
    const reply: SessionFileComment = {
      ...baseComment,
      id: "a1",
      author: "agent",
      parent_id: "fc-1",
      body: "y",
    };
    // root: 1 header + 3 body; reply: 1 header + 1 body; + 1 padding = 7
    expect(estimateThreadHeightInLines({ root, replies: [reply] })).toBe(7);
  });
});

describe("formatThreadForCopy", () => {
  it("serializes the root and replies with author/status prefixes", () => {
    const root = { ...baseComment, id: "r1", body: "please rename b" };
    const reply: SessionFileComment = {
      ...baseComment,
      id: "a1",
      author: "agent",
      parent_id: "r1",
      status: "addressed",
      body: "done",
    };
    expect(formatThreadForCopy({ root, replies: [reply] })).toBe(
      "you · open:\nplease rename b\n\nagent · addressed:\ndone",
    );
  });

  it("handles a root with no replies", () => {
    const root = { ...baseComment, body: "just a note" };
    expect(formatThreadForCopy({ root, replies: [] })).toBe("you · open:\njust a note");
  });
});

describe("author display (imported third-party comments)", () => {
  it("shows a named external author verbatim instead of 'you'", () => {
    expect(
      formatCommentMeta({ ...baseComment, author: "Eduardo Fernandez" }),
    ).toBe("Eduardo Fernandez · open");
  });

  it("still renders the well-known reviewer/agent aliases", () => {
    expect(formatCommentMeta({ ...baseComment, author: "reviewer" })).toBe("you · open");
    expect(formatCommentMeta({ ...baseComment, author: "agent" })).toBe("agent · open");
  });

  it("only lets the local reviewer mutate their own note", () => {
    expect(isMutable({ ...baseComment, author: "reviewer" })).toBe(true);
    expect(isMutable({ ...baseComment, author: "Eduardo Fernandez" })).toBe(false);
    expect(isMutable({ ...baseComment, author: "agent" })).toBe(false);
  });
});

describe("commentTimeValue", () => {
  it("parses ISO-8601 timestamps", () => {
    expect(commentTimeValue("2026-08-17T14:48:29Z")).toBe(Date.parse("2026-08-17T14:48:29Z"));
  });

  it("parses legacy epoch-second timestamps written by the tile", () => {
    expect(commentTimeValue("1787000000")).toBe(1787000000 * 1000);
  });

  it("sorts unparseable timestamps last rather than throwing", () => {
    expect(commentTimeValue("not-a-date")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("groupCommentThreads reply ordering across timestamp formats", () => {
  it("keeps an agent ISO reply before a later epoch-second reviewer reply", () => {
    const root: SessionFileComment = { ...baseComment, id: "root", created_at: "1787000000" };
    const agentReply: SessionFileComment = {
      ...baseComment,
      id: "agent-reply",
      author: "agent",
      parent_id: "root",
      created_at: "2026-08-17T10:00:00Z",
    };
    // Written by the tile AFTER the agent replied, but as epoch seconds.
    const myReply: SessionFileComment = {
      ...baseComment,
      id: "my-reply",
      parent_id: "root",
      created_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)),
    };

    const [thread] = groupCommentThreads([root, myReply, agentReply]);

    expect(thread.replies.map((r) => r.id)).toEqual(["agent-reply", "my-reply"]);
  });
});

describe("hideResolvedComments", () => {
  const comment = (
    id: string,
    over: Partial<SessionFileComment> = {},
  ): SessionFileComment => ({
    id,
    workstream_id: "ws-1",
    file: "src/a.ts",
    anchor_line_start: 1,
    anchor_line_end: 1,
    anchor_text: null,
    body: id,
    author: "reviewer",
    parent_id: null,
    status: "open",
    created_at: "2026-08-20T10:00:00Z",
    updated_at: "2026-08-20T10:00:00Z",
    ...over,
  });

  it("returns everything untouched when the filter is off", () => {
    const list = [comment("a"), comment("b", { status: "resolved" })];
    expect(hideResolvedComments(list, false)).toBe(list);
  });

  it("drops resolved roots", () => {
    const list = [comment("open"), comment("done", { status: "resolved" })];
    expect(hideResolvedComments(list, true).map((c) => c.id)).toEqual(["open"]);
  });

  it("drops wontfix as well, since both are closed", () => {
    const list = [comment("open"), comment("nope", { status: "wontfix" })];
    expect(hideResolvedComments(list, true).map((c) => c.id)).toEqual(["open"]);
  });

  it("drops the replies of a hidden root, not just the root", () => {
    // Leaving replies behind would orphan them: groupCommentThreads discards
    // replies whose parent is absent, so they would silently vanish anyway --
    // but any other consumer would render a headless fragment.
    const list = [
      comment("root", { status: "resolved" }),
      comment("reply", { parent_id: "root", author: "agent" }),
    ];
    expect(hideResolvedComments(list, true)).toEqual([]);
  });

  it("keeps a reply that is itself resolved when its root is still open", () => {
    // Status on a reply is not a thread verdict; hiding it would tear a hole
    // in a conversation the user is still working through.
    const list = [
      comment("root"),
      comment("reply", { parent_id: "root", status: "resolved" }),
    ];
    expect(hideResolvedComments(list, true).map((c) => c.id)).toEqual(["root", "reply"]);
  });

  it("keeps an open root with resolved siblings", () => {
    const list = [
      comment("a", { status: "resolved" }),
      comment("b"),
      comment("c", { status: "resolved" }),
    ];
    expect(hideResolvedComments(list, true).map((c) => c.id)).toEqual(["b"]);
  });

  it("preserves order", () => {
    const list = [comment("a"), comment("b"), comment("c")];
    expect(hideResolvedComments(list, true).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("handles an empty list", () => {
    expect(hideResolvedComments([], true)).toEqual([]);
  });
});

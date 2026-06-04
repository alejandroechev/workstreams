import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend.file comments", () => {
  let backend: MemoryBackend;
  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("returns empty when nothing has been added", async () => {
    expect(await backend.listFileComments("ws-1", "C:/a.ts")).toEqual([]);
  });

  it("adds a user comment with origin_type 'user' and author 'me'", async () => {
    const c = await backend.addFileComment("ws-1", "C:/a.ts", 10, 12, "  foo();", "**bold** note");
    expect(c.origin_type).toBe("user");
    expect(c.author).toBe("me");
    expect(c.anchor_line_start).toBe(10);
    expect(c.anchor_line_end).toBe(12);
    expect(c.anchor_text).toBe("  foo();");
    expect(c.body_md).toBe("**bold** note");
    const list = await backend.listFileComments("ws-1", "C:/a.ts");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  it("isolates comments by workstream and absolute path", async () => {
    await backend.addFileComment("ws-1", "C:/a.ts", 1, 1, null, "ws1-a");
    await backend.addFileComment("ws-2", "C:/a.ts", 1, 1, null, "ws2-a");
    await backend.addFileComment("ws-1", "C:/b.ts", 1, 1, null, "ws1-b");
    const r = await backend.listFileComments("ws-1", "C:/a.ts");
    expect(r).toHaveLength(1);
    expect(r[0].body_md).toBe("ws1-a");
  });

  it("returns comments ordered by anchor_line_start asc then created_at asc", async () => {
    const second = await backend.addFileComment("ws-1", "C:/a.ts", 10, 10, null, "second");
    const first = await backend.addFileComment("ws-1", "C:/a.ts", 5, 7, null, "first");
    const list = await backend.listFileComments("ws-1", "C:/a.ts");
    expect(list.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("rejects inverted line ranges", async () => {
    await expect(
      backend.addFileComment("ws-1", "C:/a.ts", 5, 2, null, "bad"),
    ).rejects.toThrow(/anchor_line_end/);
  });

  it("updates only the body and bumps updated_at", async () => {
    const c = await backend.addFileComment("ws-1", "C:/a.ts", 1, 1, null, "old");
    const u = await backend.updateFileComment(c.id, "new");
    expect(u.body_md).toBe("new");
    expect(u.id).toBe(c.id);
    expect(u.created_at).toBe(c.created_at);
    const fresh = (await backend.listFileComments("ws-1", "C:/a.ts"))[0];
    expect(fresh.body_md).toBe("new");
  });

  it("deletes a user comment", async () => {
    const c = await backend.addFileComment("ws-1", "C:/a.ts", 1, 1, null, "x");
    await backend.deleteFileComment(c.id);
    expect(await backend.listFileComments("ws-1", "C:/a.ts")).toEqual([]);
  });

  it("delete on unknown id throws", async () => {
    await expect(backend.deleteFileComment("nope")).rejects.toThrow();
  });

  it("update on unknown id throws", async () => {
    await expect(backend.updateFileComment("nope", "x")).rejects.toThrow();
  });

  it("imports PR comments and dedupes by (pr_id, comment_id)", async () => {
    const summary1 = await backend.importPrComments("ws-1", [
      {
        absolute_path: "C:/a.ts",
        anchor_line_start: 1,
        anchor_line_end: 1,
        body_md: "first",
        author: "bob",
        origin_pr_id: "42",
        origin_comment_id: "c-1",
        status: "active",
      },
      {
        absolute_path: "C:/a.ts",
        anchor_line_start: 2,
        anchor_line_end: 2,
        body_md: "second",
        author: "alice",
        origin_pr_id: "42",
        origin_comment_id: "c-2",
        status: "fixed",
      },
    ]);
    expect(summary1).toEqual({ inserted: 2, skipped: 0 });

    const summary2 = await backend.importPrComments("ws-1", [
      {
        absolute_path: "C:/a.ts",
        anchor_line_start: 1,
        anchor_line_end: 1,
        body_md: "dup attempt",
        author: "bob",
        origin_pr_id: "42",
        origin_comment_id: "c-1",
      },
      {
        absolute_path: "C:/a.ts",
        anchor_line_start: 3,
        anchor_line_end: 3,
        body_md: "fresh",
        author: "carol",
        origin_pr_id: "42",
        origin_comment_id: "c-3",
      },
    ]);
    expect(summary2).toEqual({ inserted: 1, skipped: 1 });

    const list = await backend.listFileComments("ws-1", "C:/a.ts");
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.origin_comment_id)).toEqual(["c-1", "c-2", "c-3"]);
    expect(list[0].author).toBe("bob");
    expect(list[1].status).toBe("fixed");
  });

  it("imported comments cannot be edited or deleted", async () => {
    await backend.importPrComments("ws-1", [
      {
        absolute_path: "C:/a.ts",
        anchor_line_start: 1,
        anchor_line_end: 1,
        body_md: "from ado",
        author: "bob",
        origin_pr_id: "42",
        origin_comment_id: "c-1",
      },
    ]);
    const imported = (await backend.listFileComments("ws-1", "C:/a.ts"))[0];
    await expect(backend.updateFileComment(imported.id, "nope")).rejects.toThrow(/read-only/);
    await expect(backend.deleteFileComment(imported.id)).rejects.toThrow(/read-only/);
  });
});

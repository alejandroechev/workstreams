import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend.session file comments", () => {
  let backend: MemoryBackend;
  beforeEach(() => {
    backend = new MemoryBackend();
    backend.seedBoundSession("ws-1", "sess-1");
  });

  it("throws when no linked session is bound", async () => {
    await expect(backend.listSessionFileComments("ws-unbound", "src/a.ts")).rejects.toThrow(
      /linked Copilot session/i,
    );
  });

  it("returns empty when nothing has been added", async () => {
    expect(await backend.listSessionFileComments("ws-1", "src/a.ts")).toEqual([]);
  });

  it("adds a reviewer comment defaulting to author 'reviewer' and status 'open'", async () => {
    const c = await backend.addSessionFileComment("ws-1", "src/a.ts", 10, 12, "  foo();", "note");
    expect(c.author).toBe("reviewer");
    expect(c.status).toBe("open");
    expect(c.parent_id).toBeNull();
    expect(c.file).toBe("src/a.ts");
    expect(c.anchor_line_start).toBe(10);
    expect(c.anchor_line_end).toBe(12);
    expect(c.anchor_text).toBe("  foo();");
    expect(c.body).toBe("note");
    const list = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  it("scopes listing by workstream and file", async () => {
    backend.seedBoundSession("ws-2", "sess-2");
    await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "ws1-a");
    await backend.addSessionFileComment("ws-2", "src/a.ts", 1, 1, null, "ws2-a");
    await backend.addSessionFileComment("ws-1", "src/b.ts", 1, 1, null, "ws1-b");
    const r = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(r).toHaveLength(1);
    expect(r[0].body).toBe("ws1-a");
  });

  it("sorts by anchor line then created_at", async () => {
    const second = await backend.addSessionFileComment("ws-1", "src/a.ts", 10, 10, null, "second");
    const first = await backend.addSessionFileComment("ws-1", "src/a.ts", 5, 7, null, "first");
    const list = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(list.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("rejects an inverted anchor range", async () => {
    await expect(
      backend.addSessionFileComment("ws-1", "src/a.ts", 5, 2, null, "bad"),
    ).rejects.toThrow(/anchor_line_end/);
  });

  it("adds an agent reply threaded under a reviewer note", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    const reply = await backend.replySessionFileComment("ws-1", parent.id, "answer");
    expect(reply.author).toBe("agent");
    expect(reply.parent_id).toBe(parent.id);
    expect(reply.file).toBe("src/a.ts");
    const list = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(list).toHaveLength(2);
  });

  it("rejects a reply to a missing parent", async () => {
    await expect(backend.replySessionFileComment("ws-1", "nope", "x")).rejects.toThrow(/not found/);
  });

  it("updates a reviewer comment body", async () => {
    const c = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "old");
    const u = await backend.updateSessionFileComment("ws-1", c.id, "new");
    expect(u.body).toBe("new");
    const fresh = (await backend.listSessionFileComments("ws-1", "src/a.ts"))[0];
    expect(fresh.body).toBe("new");
  });

  it("refuses to update an agent reply", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    const reply = await backend.replySessionFileComment("ws-1", parent.id, "a");
    await expect(backend.updateSessionFileComment("ws-1", reply.id, "x")).rejects.toThrow(
      /not editable/,
    );
  });

  it("sets status on a comment", async () => {
    const c = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "x");
    const u = await backend.setSessionFileCommentStatus("ws-1", c.id, "resolved");
    expect(u.status).toBe("resolved");
  });

  it("deletes a reviewer note and cascades its agent replies", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    await backend.replySessionFileComment("ws-1", parent.id, "a1");
    await backend.replySessionFileComment("ws-1", parent.id, "a2");
    await backend.deleteSessionFileComment("ws-1", parent.id);
    expect(await backend.listSessionFileComments("ws-1", "src/a.ts")).toEqual([]);
  });

  it("refuses to delete an agent reply directly", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    const reply = await backend.replySessionFileComment("ws-1", parent.id, "a");
    await expect(backend.deleteSessionFileComment("ws-1", reply.id)).rejects.toThrow(
      /not deletable/,
    );
  });
});

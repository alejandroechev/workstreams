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

  it("adds a reviewer reply threaded under a note (in-file Reply UI)", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    const reply = await backend.replySessionFileComment("ws-1", parent.id, "answer");
    expect(reply.author).toBe("reviewer");
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

  it("allows updating a reviewer reply (it is reviewer-authored)", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    const reply = await backend.replySessionFileComment("ws-1", parent.id, "a");
    const updated = await backend.updateSessionFileComment("ws-1", reply.id, "edited");
    expect(updated.body).toBe("edited");
  });

  it("sets status on a comment", async () => {
    const c = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "x");
    const u = await backend.setSessionFileCommentStatus("ws-1", c.id, "resolved");
    expect(u.status).toBe("resolved");
  });

  it("deletes a reviewer note and cascades its replies", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    await backend.replySessionFileComment("ws-1", parent.id, "a1");
    await backend.replySessionFileComment("ws-1", parent.id, "a2");
    await backend.deleteSessionFileComment("ws-1", parent.id);
    expect(await backend.listSessionFileComments("ws-1", "src/a.ts")).toEqual([]);
  });

  it("allows deleting a reviewer reply directly", async () => {
    const parent = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "q");
    const reply = await backend.replySessionFileComment("ws-1", parent.id, "a");
    await backend.deleteSessionFileComment("ws-1", reply.id);
    const list = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(list.map((c) => c.id)).toEqual([parent.id]);
  });

  it("preserves an imported third-party author instead of forcing 'reviewer'", async () => {
    backend.seedSessionFileComment({
      id: "ado-1513151-16261206-1",
      workstream_id: "ws-1",
      file: "src/a.ts",
      anchor_line_start: 3,
      anchor_line_end: 3,
      body: "imported note",
      author: "Eduardo Fernandez",
      created_at: "2026-08-16T23:51:26Z",
    });

    const [imported] = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(imported.author).toBe("Eduardo Fernandez");
  });

  it("refuses to delete an imported note so its replies cannot be orphaned", async () => {
    backend.seedSessionFileComment({
      id: "ado-1",
      workstream_id: "ws-1",
      file: "src/a.ts",
      anchor_line_start: 1,
      anchor_line_end: 1,
      body: "imported",
      author: "Eduardo Fernandez",
      created_at: "2026-08-16T23:51:26Z",
    });
    backend.seedSessionFileComment({
      id: "ado-1-agent",
      workstream_id: "ws-1",
      file: "src/a.ts",
      anchor_line_start: 1,
      anchor_line_end: 1,
      body: "agent answer",
      author: "agent",
      parent_id: "ado-1",
      created_at: "2026-08-17T09:00:00Z",
    });

    await expect(backend.deleteSessionFileComment("ws-1", "ado-1")).rejects.toThrow(
      /not found or not deletable/i,
    );
    expect(await backend.listSessionFileComments("ws-1", "src/a.ts")).toHaveLength(2);
  });

  it("orders replies chronologically across epoch-second and ISO timestamps", async () => {
    // The tile historically wrote epoch seconds; agents/importers write ISO.
    // Lexicographic ordering put every epoch row before every ISO row, so a
    // reply written in the tile appeared above the agent reply it answered.
    backend.seedSessionFileComment({
      id: "root",
      workstream_id: "ws-1",
      file: "src/a.ts",
      anchor_line_start: 1,
      anchor_line_end: 1,
      body: "question",
      author: "reviewer",
      created_at: "1786000000",
    });
    backend.seedSessionFileComment({
      id: "agent-reply",
      workstream_id: "ws-1",
      file: "src/a.ts",
      anchor_line_start: 1,
      anchor_line_end: 1,
      body: "agent answer",
      author: "agent",
      parent_id: "root",
      created_at: "2026-08-17T10:00:00Z",
    });
    backend.seedSessionFileComment({
      id: "my-reply",
      workstream_id: "ws-1",
      file: "src/a.ts",
      anchor_line_start: 1,
      anchor_line_end: 1,
      body: "my follow-up",
      author: "reviewer",
      parent_id: "root",
      created_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)),
    });

    const list = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(list.map((c) => c.id)).toEqual(["root", "agent-reply", "my-reply"]);
  });

  it("lists every comment in the workstream across files, ordered by file then line", async () => {
    await backend.addSessionFileComment("ws-1", "src/b.ts", 3, 3, null, "b3");
    await backend.addSessionFileComment("ws-1", "src/a.ts", 20, 20, null, "a20");
    await backend.addSessionFileComment("ws-1", "src/a.ts", 5, 5, null, "a5");

    const all = await backend.listAllSessionFileComments("ws-1");
    expect(all.map((c) => c.body)).toEqual(["a5", "a20", "b3"]);
  });

  it("scopes list-all to its workstream", async () => {
    backend.seedBoundSession("ws-2", "sess-2");
    await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "mine");
    await backend.addSessionFileComment("ws-2", "src/a.ts", 1, 1, null, "theirs");

    const all = await backend.listAllSessionFileComments("ws-1");
    expect(all.map((c) => c.body)).toEqual(["mine"]);
  });

  it("orders list-all chronologically across mixed timestamp formats", async () => {
    backend.seedSessionFileComment({
      id: "iso", workstream_id: "ws-1", file: "src/a.ts",
      anchor_line_start: 1, anchor_line_end: 1, body: "iso",
      created_at: "2026-08-17T10:00:00Z",
    });
    backend.seedSessionFileComment({
      id: "epoch", workstream_id: "ws-1", file: "src/a.ts",
      anchor_line_start: 1, anchor_line_end: 1, body: "epoch",
      created_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)),
    });

    const all = await backend.listAllSessionFileComments("ws-1");
    expect(all.map((c) => c.id)).toEqual(["iso", "epoch"]);
  });

  it("throws list-all when no session is bound", async () => {
    await expect(backend.listAllSessionFileComments("ws-unbound")).rejects.toThrow(
      /linked Copilot session/i,
    );
  });

  describe("deleteSessionFileCommentThread", () => {
  it("removes an imported thread the author-gated delete refuses", async () => {
    // A thread anchored to a file that no longer exists is unreachable, so
    // cleanup must not depend on who wrote it.
    const imported = backend.seedSessionFileComment({
      id: "ado-1",
      workstream_id: "ws-1",
      file: "src/gone.ts",
      body: "imported note",
      author: "Eduardo Fernandez",
    });
    await backend.replySessionFileComment("ws-1", imported.id, "an answer");

    await expect(backend.deleteSessionFileComment("ws-1", imported.id)).rejects.toThrow();
    await backend.deleteSessionFileCommentThread("ws-1", imported.id);

    expect(await backend.listSessionFileComments("ws-1", "src/gone.ts")).toEqual([]);
  });

  it("throws for an unknown id rather than silently succeeding", async () => {
    await expect(backend.deleteSessionFileCommentThread("ws-1", "nope")).rejects.toThrow();
  });

  it("leaves other threads alone", async () => {
    const keep = await backend.addSessionFileComment("ws-1", "src/a.ts", 1, 1, null, "keep");
    const drop = await backend.addSessionFileComment("ws-1", "src/a.ts", 2, 2, null, "drop");

    await backend.deleteSessionFileCommentThread("ws-1", drop.id);

    const left = await backend.listSessionFileComments("ws-1", "src/a.ts");
    expect(left.map((c) => c.id)).toEqual([keep.id]);
  });
});
});

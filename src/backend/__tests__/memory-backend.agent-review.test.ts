import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend.agent review", () => {
  let backend: MemoryBackend;
  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("createAgentReview is idempotent per workstream (one active review)", async () => {
    const a = await backend.createAgentReview("ws-1", "base", "head");
    const b = await backend.createAgentReview("ws-1", "base", "head");
    expect(b.id).toBe(a.id);
    expect(a.round).toBe(1);
    expect(a.status).toBe("active");
  });

  it("adds a root comment (author me, open, unchanged) and lists it", async () => {
    const r = await backend.createAgentReview("ws-1");
    const c = await backend.addReviewComment(r.id, "C:/a.js", 4, 4, "remove the console.log");
    expect(c.author).toBe("me");
    expect(c.status).toBe("open");
    expect(c.anchor_state).toBe("unchanged");
    expect(c.origin_parent_id).toBeNull();
    expect(c.round).toBe(1);
    const list = await backend.listReviewComments(r.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(c.id);
  });

  it("rejects an inverted anchor range", async () => {
    const r = await backend.createAgentReview("ws-1");
    await expect(backend.addReviewComment(r.id, "C:/a.js", 8, 4, "bad")).rejects.toThrow();
  });

  it("threads replies under a root, ordered after it", async () => {
    const r = await backend.createAgentReview("ws-1");
    const root = await backend.addReviewComment(r.id, "C:/a.js", 4, 4, "root");
    const reply = await backend.replyReviewComment(root.id, "done", "agent");
    expect(reply.origin_parent_id).toBe(root.id);
    expect(reply.author).toBe("agent");
    const list = await backend.listReviewComments(r.id);
    expect(list).toHaveLength(2);
    expect(list[0].origin_parent_id).toBeNull();
    expect(list[1].origin_parent_id).toBe(root.id);
  });

  it("rejects an unknown reply author", async () => {
    const r = await backend.createAgentReview("ws-1");
    const root = await backend.addReviewComment(r.id, "C:/a.js", 4, 4, "root");
    await expect(backend.replyReviewComment(root.id, "x", "bob")).rejects.toThrow();
  });

  it("enforces the resolution role guard", async () => {
    const r = await backend.createAgentReview("ws-1");
    const root = await backend.addReviewComment(r.id, "C:/a.js", 4, 4, "root");
    // Agent may address/wontfix but not resolve/reopen.
    await expect(backend.setCommentResolution(root.id, "addressed", "agent")).resolves.toBeUndefined();
    await expect(backend.setCommentResolution(root.id, "resolved", "agent")).rejects.toThrow();
    await expect(backend.setCommentResolution(root.id, "open", "agent")).rejects.toThrow();
    // Reviewer may resolve.
    await backend.setCommentResolution(root.id, "resolved", "me");
    const list = await backend.listReviewComments(r.id);
    expect(list[0].status).toBe("resolved");
    // Unknown actor rejected.
    await expect(backend.setCommentResolution(root.id, "open", "bob")).rejects.toThrow();
  });

  it("submitReviewRound bumps the round", async () => {
    const r = await backend.createAgentReview("ws-1");
    await backend.submitReviewRound(r.id);
    // A fresh comment now carries the incremented round.
    const c = await backend.addReviewComment(r.id, "C:/a.js", 1, 1, "second round");
    expect(c.round).toBe(2);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend.code review", () => {
  let backend: MemoryBackend;
  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("resolves a (stub) bound session and creates the latest-active review", async () => {
    expect(await backend.resolveWorkstreamSession("ws-1")).toBe("mem-session-ws-1");
    const a = await backend.createReview("ws-1", "branch", "master", "First");
    expect(a.status).toBe("open");
    expect(a.diff_source).toBe("branch");
    const b = await backend.createReview("ws-1", "working_tree", null, null);
    const active = await backend.getActiveReview("ws-1");
    expect(active?.id).toBe(b.id); // latest-created
    expect(await backend.listReviews("ws-1")).toHaveLength(2);
  });

  it("refuses to create a review when no session is linked", async () => {
    backend.seedBoundSession("ws-x", null);
    expect(await backend.resolveWorkstreamSession("ws-x")).toBeNull();
    await expect(backend.createReview("ws-x", "branch", "master")).rejects.toThrow();
  });

  it("adds reviewer comments ordered by file then line", async () => {
    const r = await backend.createReview("ws-1", "working_tree");
    await backend.addReviewComment("ws-1", r.id, "b.js", 2, "new", null, null, "b2");
    await backend.addReviewComment("ws-1", r.id, "a.js", 9, "new", null, null, "a9");
    await backend.addReviewComment("ws-1", r.id, "a.js", 4, "new", "console.log()", "@@", "a4");
    const list = await backend.listReviewComments("ws-1", r.id);
    expect(list.map((c) => `${c.file}:${c.line}`)).toEqual(["a.js:4", "a.js:9", "b.js:2"]);
    expect(list.every((c) => c.author === "reviewer" && c.status === "open")).toBe(true);
  });

  it("simulates an agent reply that the poll picks up + flips the parent to addressed", async () => {
    const r = await backend.createReview("ws-1", "working_tree");
    const c = await backend.addReviewComment("ws-1", r.id, "a.js", 4, "new", null, null, "remove this");
    backend.simulateAgentReply(r.id, c.id, "done — removed it");
    const list = await backend.listReviewComments("ws-1", r.id);
    expect(list).toHaveLength(2);
    const root = list.find((x) => x.id === c.id)!;
    const reply = list.find((x) => x.parent_id === c.id)!;
    expect(root.status).toBe("addressed");
    expect(reply.author).toBe("agent");
    expect(reply.body).toBe("done — removed it");
  });

  it("reviewer resolves/reopens; invalid + unknown are rejected", async () => {
    const r = await backend.createReview("ws-1", "working_tree");
    const c = await backend.addReviewComment("ws-1", r.id, "a.js", 4, "new", null, null, "x");
    await backend.setReviewCommentStatus("ws-1", c.id, "resolved");
    expect((await backend.listReviewComments("ws-1", r.id))[0].status).toBe("resolved");
    await backend.setReviewCommentStatus("ws-1", c.id, "open"); // reopen
    expect((await backend.listReviewComments("ws-1", r.id))[0].status).toBe("open");
    await expect(backend.setReviewCommentStatus("ws-1", c.id, "bogus")).rejects.toThrow();
    await expect(backend.setReviewCommentStatus("ws-1", "nope", "resolved")).rejects.toThrow();
  });

  it("completes a review", async () => {
    const r = await backend.createReview("ws-1", "branch", "master");
    await backend.completeCodeReview("ws-1", r.id);
    expect((await backend.getActiveReview("ws-1"))?.status).toBe("completed");
  });

  it("returns seeded diff files + sides", async () => {
    backend.seedReviewDiff([{ path: "a.js", status: "M" }]);
    backend.seedReviewDiffSides("a.js", { before: "one\n", after: "one\ntwo\n" });
    expect(await backend.codeReviewDiffFiles("/repo", "working_tree")).toEqual([{ path: "a.js", status: "M" }]);
    expect(await backend.codeReviewDiffFileSides("/repo", "a.js", "working_tree")).toEqual({
      before: "one\n",
      after: "one\ntwo\n",
    });
    // Unknown file → empty sides.
    expect(await backend.codeReviewDiffFileSides("/repo", "missing.js", "working_tree")).toEqual({
      before: "",
      after: "",
    });
  });
});

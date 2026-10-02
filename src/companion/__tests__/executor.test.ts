import { describe, it, expect } from "vitest";
import {
  planRequest,
  pendingRequests,
  interruptedRequests,
  requestsToPrune,
  folderSlug,
  PRUNE_AFTER_MS,
  type ExecutorWorld,
} from "../executor";
import { emptyDocument, signRequest, type CompanionRequest, type UnsignedRequest } from "../protocol";
import fixtures from "../protocol/fixtures.json";

const SECRET = fixtures.secret;
const NOW = 1_790_000_000_000;

const world: ExecutorWorld = {
  workstreams: [
    { id: "loaded", name: "Loaded", archived: false, loaded: true, copilotCommand: "copilot --yolo" },
    { id: "idle", name: "Idle", archived: false, loaded: false, copilotCommand: "agency copilot --yolo" },
    { id: "old", name: "Old", archived: true, loaded: false, copilotCommand: "copilot" },
  ],
  globalCopilotCommand: "agency copilot --yolo",
};

async function req(over: Partial<UnsignedRequest>, secret = SECRET): Promise<CompanionRequest> {
  const unsigned = { id: "r1", kind: "load", args: { workstreamId: "idle" }, createdAt: NOW, ...over } as UnsignedRequest;
  return { ...unsigned, signature: await signRequest(secret, unsigned) };
}

const plan = async (request: CompanionRequest, w = world, secret = SECRET) =>
  planRequest(request, w, { secret, now: NOW, schemaVersion: 1 });

describe("planning a load", () => {
  it("loads a workstream that is not loaded", async () => {
    expect(await plan(await req({}))).toEqual({ ok: true, actions: [{ type: "load", workstreamId: "idle" }] });
  });

  it("does nothing, successfully, for one already loaded", async () => {
    expect(await plan(await req({ args: { workstreamId: "loaded" } }))).toEqual({ ok: true, actions: [] });
  });

  it.each([["missing"], ["old"]])("refuses %s (unknown or archived)", async (id) => {
    const result = await plan(await req({ args: { workstreamId: id } }));
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not found|archived/i) });
  });
});

describe("planning a create", () => {
  it("creates in a fresh folder and loads, without a session when there is no prompt", async () => {
    const result = await plan(await req({ kind: "create", args: { name: "  Phone idea  " } }));
    expect(result).toEqual({
      ok: true,
      actions: [
        { type: "create", name: "Phone idea", folderSlug: "phone-idea" },
        { type: "load", workstreamId: "$created" },
      ],
    });
  });

  it("also starts a session with the global command when there is a prompt", async () => {
    const result = await plan(await req({ kind: "create", args: { name: "Fix the docs", prompt: "List the files here" } }));
    expect(result).toEqual({
      ok: true,
      actions: [
        { type: "create", name: "Fix the docs", folderSlug: "fix-the-docs" },
        { type: "load", workstreamId: "$created" },
        { type: "session", workstreamId: "$created", command: "agency copilot --yolo", prompt: "List the files here" },
      ],
    });
  });
});

describe("planning a session", () => {
  it("uses the workstream's resolved command and keeps the prompt intact", async () => {
    const prompt = "First line\nsecond line with \"quotes\" and $(not a shell)";
    const result = await plan(await req({ kind: "session", args: { workstreamId: "loaded", prompt } }));
    expect(result).toEqual({
      ok: true,
      actions: [{ type: "session", workstreamId: "loaded", command: "copilot --yolo", prompt }],
    });
  });

  it("loads a workstream that is not loaded first, in the same request", async () => {
    const result = await plan(await req({ kind: "session", args: { workstreamId: "idle", prompt: "Go" } }));
    expect(result).toEqual({
      ok: true,
      actions: [
        { type: "load", workstreamId: "idle" },
        { type: "session", workstreamId: "idle", command: "agency copilot --yolo", prompt: "Go" },
      ],
    });
  });
});

describe("the security gate comes first", () => {
  it("refuses unsigned, foreign-signed and stale requests without planning anything", async () => {
    const unsigned = { ...(await req({})), signature: "" };
    const foreign = await req({}, "c29tZS1vdGhlci1zZWNyZXQtdGhhdC1pcy0zMi1ieXQ");
    const stale = await req({ createdAt: NOW - 10 * 60_000 });
    for (const request of [unsigned, foreign, stale]) {
      const result = await plan(request);
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty("actions");
    }
  });

  it("refuses everything when the document's schema is unknown", async () => {
    const result = await planRequest(await req({}), world, { secret: SECRET, now: NOW, schemaVersion: 2 });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/update Workstreams/i) });
  });

  it("refuses everything when the companion is not paired", async () => {
    const result = await plan(await req({}), world, "");
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/pair/i) });
  });
});

describe("choosing what to process", () => {
  it("takes only requests with no outcome, oldest first", () => {
    const doc = emptyDocument();
    doc.requests = {
      b: { id: "b", kind: "load", args: { workstreamId: "x" }, createdAt: 2, signature: "s" },
      a: { id: "a", kind: "load", args: { workstreamId: "x" }, createdAt: 1, signature: "s" },
      done: { id: "done", kind: "load", args: { workstreamId: "x" }, createdAt: 0, signature: "s", outcome: { status: "done", at: 1 } },
    };
    expect(pendingRequests(doc).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("finds requests left running by a previous run, so they fail instead of re-running", () => {
    const doc = emptyDocument();
    doc.requests = {
      r: { id: "r", kind: "load", args: { workstreamId: "x" }, createdAt: 1, signature: "s", outcome: { status: "running", at: 1 } },
      d: { id: "d", kind: "load", args: { workstreams: "x" } as never, createdAt: 1, signature: "s", outcome: { status: "done", at: 1 } },
    };
    expect(interruptedRequests(doc)).toEqual(["r"]);
  });

  it("prunes finished requests after a few days, never pending or running ones", () => {
    const doc = emptyDocument();
    const old = NOW - PRUNE_AFTER_MS - 1;
    doc.requests = {
      oldDone: { id: "oldDone", kind: "load", args: { workstreamId: "x" }, createdAt: old, signature: "s", outcome: { status: "done", at: old } },
      oldFailed: { id: "oldFailed", kind: "load", args: { workstreamId: "x" }, createdAt: old, signature: "s", outcome: { status: "failed", at: old } },
      oldPending: { id: "oldPending", kind: "load", args: { workstreamId: "x" }, createdAt: old, signature: "s" },
      newDone: { id: "newDone", kind: "load", args: { workstreamId: "x" }, createdAt: NOW, signature: "s", outcome: { status: "done", at: NOW } },
    };
    expect(requestsToPrune(doc, NOW).sort()).toEqual(["oldDone", "oldFailed"]);
  });
});

describe("folder names for new workstreams", () => {
  it.each([
    ["Phone idea", "phone-idea"],
    ["  Fix: the DOCS!!  ", "fix-the-docs"],
    ["Ünïcødé café", "unicode-cafe"],
    ["../../etc", "etc"],
    ["!!!", "workstream"],
    ["x".repeat(200), "x".repeat(50)],
  ])("%s → %s", (name, slug) => {
    expect(folderSlug(name)).toBe(slug);
  });
});

import { describe, it, expect, vi } from "vitest";
import { startCompanionRuntime, type CompanionOps } from "../runtime";
import { createInMemoryHub } from "../doc";
import { emptyDocument, signRequest, type CompanionDocument, type UnsignedRequest } from "../protocol";
import type { ExecutorWorld } from "../executor";
import fixtures from "../protocol/fixtures.json";

const SECRET = fixtures.secret;
const NOW = 1_790_000_000_000;

function fakeOps(over: Partial<CompanionOps> = {}) {
  const world: ExecutorWorld = {
    workstreams: [
      { id: "idle", name: "Idle", archived: false, loaded: false, copilotCommand: "copilot --yolo" },
      { id: "busy", name: "Busy", archived: false, loaded: true, copilotCommand: "repo-copilot --yolo" },
    ],
    globalCopilotCommand: "agency copilot --yolo",
  };
  const calls: string[] = [];
  const ops: CompanionOps = {
    world: () => world,
    loadInBackground: vi.fn(async (id: string) => {
      calls.push(`load:${id}`);
      const w = world.workstreams.find((x) => x.id === id);
      if (w) w.loaded = true;
    }),
    createWorkstream: vi.fn(async (name: string, slug: string) => {
      calls.push(`create:${name}:${slug}`);
      world.workstreams.push({ id: "new-ws", name, archived: false, loaded: false, copilotCommand: world.globalCopilotCommand });
      return "new-ws";
    }),
    startSession: vi.fn(async (id: string, command: string, prompt: string) => {
      calls.push(`session:${id}:${command}:${prompt}`);
    }),
    ...over,
  };
  return { ops, calls };
}

async function phoneRequest(doc: { change(fn: (d: CompanionDocument) => void): void }, over: Partial<UnsignedRequest>, secret = SECRET) {
  const unsigned = { id: "r1", kind: "load", args: { workstreamId: "idle" }, createdAt: NOW, ...over } as UnsignedRequest;
  const signature = await signRequest(secret, unsigned);
  doc.change((d) => { d.requests[unsigned.id] = { ...unsigned, signature }; });
}

describe("the companion runtime on the laptop", () => {
  it("executes a signed load and records the outcome", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const { ops, calls } = fakeOps();
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await phoneRequest(phone, {});
    await runtime.idle();
    expect(calls).toEqual(["load:idle"]);
    expect(phone.read().requests.r1.outcome).toEqual({ status: "done", at: NOW });
    runtime.stop();
  });

  it("creates a workstream with a prompt in one request, resolving the new id", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const { ops, calls } = fakeOps();
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await phoneRequest(hub.peer(), { id: "c1", kind: "create", args: { name: "Fix the docs", prompt: "List the files here" } });
    await runtime.idle();
    expect(calls).toEqual([
      "create:Fix the docs:fix-the-docs",
      "load:new-ws",
      "session:new-ws:agency copilot --yolo:List the files here",
    ]);
    expect(laptop.read().requests.c1.outcome).toEqual({ status: "done", at: NOW, workstreamId: "new-ws" });
    runtime.stop();
  });

  it("refuses unsigned, foreign-signed and stale requests, doing nothing they asked", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const { ops, calls } = fakeOps();
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    phone.change((d) => { d.requests.u = { id: "u", kind: "create", args: { name: "Unsigned" }, createdAt: NOW, signature: "" }; });
    await phoneRequest(phone, { id: "f", kind: "create", args: { name: "Foreign" } }, "c29tZS1vdGhlci1zZWNyZXQtdGhhdC1pcy0zMi1ieXQ");
    await phoneRequest(phone, { id: "s", kind: "create", args: { name: "Stale" }, createdAt: NOW - 10 * 60_000 });
    await phoneRequest(phone, { id: "ok", kind: "create", args: { name: "Fresh" } });
    await runtime.idle();
    expect(calls).toEqual(["create:Fresh:fresh", "load:new-ws"]);
    for (const id of ["u", "f", "s"]) {
      const outcome = laptop.read().requests[id].outcome;
      expect(outcome?.status, id).toBe("failed");
      expect(outcome?.error, id).toBeTruthy();
    }
    runtime.stop();
  });

  it("runs a request at most once, across repeated passes and a restart", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const { ops, calls } = fakeOps();
    let runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await phoneRequest(hub.peer(), { id: "once", kind: "create", args: { name: "Once" } });
    await runtime.idle();
    laptop.change((d) => { d.laptop.lastSeenAt = 1; }); // another change, another pass
    await runtime.idle();
    runtime.stop();
    runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await runtime.idle();
    expect(calls.filter((c) => c.startsWith("create:"))).toHaveLength(1);
    expect(laptop.read().requests.once.outcome?.status).toBe("done");
    runtime.stop();
  });

  it("fails, and never retries, a request a crashed run left running", async () => {
    const seeded: CompanionDocument = emptyDocument();
    const unsigned = { id: "crash", kind: "load" as const, args: { workstreamId: "idle" }, createdAt: NOW };
    seeded.requests.crash = { ...unsigned, signature: await signRequest(SECRET, unsigned), outcome: { status: "running", at: NOW } };
    const laptop = createInMemoryHub(seeded).peer();
    const { ops, calls } = fakeOps();
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await runtime.idle();
    expect(calls).toEqual([]);
    expect(laptop.read().requests.crash.outcome).toEqual({ status: "failed", at: NOW, error: expect.stringMatching(/interrupted/i) });
    runtime.stop();
  });

  it("marks the request running before acting, so a crash mid-action is never re-run", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    let statusWhileActing: string | undefined;
    const { ops } = fakeOps({
      loadInBackground: vi.fn(async () => { statusWhileActing = laptop.read().requests.r1.outcome?.status; }),
    });
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await phoneRequest(hub.peer(), {});
    await runtime.idle();
    expect(statusWhileActing).toBe("running");
    runtime.stop();
  });

  it("records a failed action as a failed request with its message", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const { ops } = fakeOps({ createWorkstream: vi.fn(async () => { throw new Error("Folder already exists"); }) });
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await phoneRequest(hub.peer(), { kind: "create", args: { name: "X" } });
    await runtime.idle();
    expect(laptop.read().requests.r1.outcome).toEqual({ status: "failed", at: NOW, error: "Folder already exists" });
    runtime.stop();
  });

  it("touches nothing in a document from a newer major version", async () => {
    const seeded = emptyDocument();
    seeded.schemaVersion = 2;
    const unsigned = { id: "v2", kind: "load" as const, args: { workstreamId: "idle" }, createdAt: NOW };
    seeded.requests.v2 = { ...unsigned, signature: await signRequest(SECRET, unsigned) };
    const laptop = createInMemoryHub(seeded).peer();
    const { ops, calls } = fakeOps();
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    await runtime.idle();
    expect(calls).toEqual([]);
    expect(laptop.read().requests.v2.outcome).toBeUndefined();
    expect(runtime.status()).toEqual({ state: "update-needed" });
    runtime.stop();
  });

  it("stops acting after stop()", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const { ops, calls } = fakeOps();
    const runtime = startCompanionRuntime({ doc: laptop, secret: SECRET, ops, now: () => NOW });
    runtime.stop();
    await phoneRequest(hub.peer(), {});
    await runtime.idle();
    expect(calls).toEqual([]);
  });
});

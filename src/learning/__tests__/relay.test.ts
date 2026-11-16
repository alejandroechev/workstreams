import { describe, expect, it, vi } from "vitest";
import { createLearningRelay, type LedgerJob, type LedgerPort } from "../relay";
import { createInMemoryLearningHub } from "../doc";
import { generateLearningSecret, requestHash, sign, verify, type LearningRequest, type LearningResponse } from "../protocol";

const SECRET = generateLearningSecret();
const NOW = 1_700_000_000_000;

function fakeLedger() {
  const jobs = new Map<string, LedgerJob>();
  const contents = new Map<string, string>();
  const ledger: LedgerPort = {
    enqueue: vi.fn(async (job) => {
      const id = job.id as string;
      const existing = jobs.get(id);
      // Like learning_jobs.rs: the same id with other content is refused.
      if (existing && contents.get(id) !== JSON.stringify(job)) throw new Error(`Job ${id} already exists with different content`);
      if (existing) return existing;
      contents.set(id, JSON.stringify(job));
      const created: LedgerJob = { id, kind: job.kind as "check" | "help", status: "queued", result: null };
      jobs.set(id, created);
      return created;
    }),
    get: vi.fn(async (id) => jobs.get(id) ?? null),
  };
  const finish = (id: string, status: LedgerJob["status"], result: unknown = null) => jobs.set(id, { ...jobs.get(id)!, status, result });
  return { ledger, jobs, finish };
}

const check = (id: string, over: Partial<LearningRequest> = {}): LearningRequest => ({
  version: 1, id, kind: "check", createdAt: NOW, cardId: "even", cardVersion: "2", source: "fn x() {}",
  harness: { tests: "assert!(true);" }, ...over,
});

async function setup() {
  const hub = createInMemoryLearningHub();
  const phone = hub.peer();
  const laptop = hub.peer();
  const { ledger, jobs, finish } = fakeLedger();
  const relay = createLearningRelay({ doc: laptop, ledger, secret: SECRET, now: () => NOW });
  const send = async (request: LearningRequest, secret = SECRET) => {
    const envelope = await sign(request, secret);
    phone.change((d) => { d.requests[request.id] = JSON.stringify(envelope); });
  };
  const result = (id: string) => {
    const raw = phone.read().results[id];
    return raw === undefined ? undefined : JSON.parse(raw) as { body: LearningResponse; signature: string } & { refused?: string; message?: string };
  };
  return { hub, phone, laptop, ledger, jobs, finish, relay, send, result };
}

describe("learning relay", () => {
  it("queues a signed check once and publishes a signed result bound to the attempt", async () => {
    const t = await setup();
    await t.send(check("a1"));
    await t.relay.process();
    expect(t.ledger.enqueue).toHaveBeenCalledWith({
      kind: "check", id: "a1", card_id: "even", card_version: "2", harness: { tests: "assert!(true);" }, source: "fn x() {}",
    });
    await t.relay.process();
    expect(t.result("a1")).toBeUndefined();
    expect(t.ledger.enqueue).toHaveBeenCalledTimes(1);

    t.finish("a1", "finished", { status: "passed", output: "ok", toolchain: "rustc 1.98.0" });
    await t.relay.process();
    const published = t.result("a1")!;
    expect(await verify(published, SECRET)).toBe(true);
    expect(published.body).toEqual({
      version: 1, id: "a1", requestHash: await requestHash(check("a1")), at: NOW,
      result: { status: "passed", output: "ok", toolchain: "rustc 1.98.0" },
    });
  });

  it("publishes a help reply or its error", async () => {
    const t = await setup();
    await t.send(check("h1", { kind: "help", level: "hint", harness: undefined, exercise: { prompt: "p" } }));
    await t.send(check("h2", { kind: "help", level: "nudge", harness: undefined }));
    await t.relay.process();
    t.finish("h1", "finished", { reply: "Look at the borrow.", error: null });
    t.finish("h2", "finished", { reply: null, error: "Copilot timed out" });
    await t.relay.process();
    expect(t.result("h1")!.body).toMatchObject({ id: "h1", reply: "Look at the borrow." });
    expect(t.result("h1")!.body).not.toHaveProperty("error");
    expect(t.result("h2")!.body).toMatchObject({ id: "h2", error: "Copilot timed out" });
  });

  it("publishes a pack draft with its validation", async () => {
    const t = await setup();
    await t.send({ ...check("g1"), kind: "pack", harness: undefined, cardId: "", cardVersion: "", source: "", topic: "Slices" });
    await t.relay.process();
    const draft = { pack: { id: "pack-slices", version: 1, cards: [] }, validation: [{ card_id: "x", ok: false }], valid: false, error: null };
    t.finish("g1", "finished", draft);
    await t.relay.process();
    expect(t.result("g1")!.body).toMatchObject({ id: "g1", pack: draft.pack, validation: draft.validation, valid: false });
    expect(t.result("g1")!.body).not.toHaveProperty("error");
  });

  it("reports a job interrupted by a restart instead of rerunning it", async () => {
    const t = await setup();
    await t.send(check("a1"));
    await t.relay.process();
    t.finish("a1", "interrupted");
    await t.relay.process();
    expect(t.result("a1")!.body.error).toMatch(/stopped while/);
    expect(t.result("a1")!.body).not.toHaveProperty("result");
  });

  it("refuses visibly, without queueing, a request signed with another key or too old", async () => {
    const t = await setup();
    await t.send(check("bad"), generateLearningSecret());
    await t.send(check("old", { createdAt: NOW - 10 * 60_000 }));
    await t.relay.process();
    expect(t.ledger.enqueue).not.toHaveBeenCalled();
    expect(t.result("bad")).toMatchObject({ refused: "bad-signature" });
    expect(t.result("old")).toMatchObject({ refused: "expired" });
    expect(t.result("old")!.message).toMatch(/too late/);
  });

  it("refuses a reused id with other content", async () => {
    const t = await setup();
    t.ledger.enqueue = vi.fn(async () => { throw new Error("Job a1 already exists with different content"); });
    await t.send(check("a1"));
    await t.relay.process();
    expect(t.result("a1")).toMatchObject({ refused: "invalid", message: "Job a1 already exists with different content" });
  });

  it("after a restart, finishes a job it had queued even though the request is no longer fresh", async () => {
    const t = await setup();
    await t.send(check("a1"));
    await t.relay.process();
    t.finish("a1", "finished", { status: "passed", output: "", toolchain: "" });
    const later = createLearningRelay({ doc: t.hub.peer(), ledger: t.ledger, secret: SECRET, now: () => NOW + 60 * 60_000 });
    await later.process();
    expect(t.result("a1")!.body.result).toEqual({ status: "passed", output: "", toolchain: "" });
  });

  it("never binds a job's result to a different request filed under the same id", async () => {
    const t = await setup();
    await t.send(check("a1"));
    await t.relay.process();
    await t.send(check("a1", { source: "fn other() {}" }));
    t.finish("a1", "finished", { status: "passed", output: "", toolchain: "" });
    const restarted = createLearningRelay({ doc: t.hub.peer(), ledger: t.ledger, secret: SECRET, now: () => NOW });
    await restarted.process();
    expect(t.result("a1")).toMatchObject({ refused: "invalid", message: "Job a1 already exists with different content" });
  });

  it("acts on nothing in a document from a newer version", async () => {
    const t = await setup();
    await t.send(check("a1"));
    t.phone.change((d) => { d.schemaVersion = 2; });
    const status = vi.fn();
    const relay = createLearningRelay({ doc: t.laptop, ledger: t.ledger, secret: SECRET, now: () => NOW, onStatus: status });
    await relay.process();
    expect(t.ledger.enqueue).not.toHaveBeenCalled();
    expect(t.result("a1")).toBeUndefined();
    expect(status).toHaveBeenCalledWith("update-needed");
  });

  it("prunes an answered request a week after its result was published", async () => {
    const t = await setup();
    const WEEK = 7 * 24 * 60 * 60_000;
    t.phone.change((d) => {
      d.requests.old = "x"; d.results.old = JSON.stringify({ body: { at: NOW - WEEK - 1 }, signature: "s" });
      d.requests.recent = "x"; d.results.recent = JSON.stringify({ body: { at: NOW - 1000 }, signature: "s" });
      d.requests.refused = "x"; d.results.refused = JSON.stringify({ refused: "invalid", message: "m", at: NOW - WEEK - 1 });
      d.requests.junk = "not json";
    });
    await t.relay.process();
    expect(Object.keys(t.phone.read().requests).sort()).toEqual(["junk", "recent"]);
    expect(t.result("junk")).toMatchObject({ refused: "invalid", at: NOW });
  });

  it("answers a retrieval of an old finished job instead of pruning it", async () => {
    const t = await setup();
    const old = check("a1", { createdAt: NOW - 8 * 24 * 60 * 60_000 });
    await t.ledger.enqueue({ kind: "check", id: "a1", card_id: "even", card_version: "2", harness: old.harness, source: old.source });
    t.finish("a1", "finished", { status: "passed", output: "", toolchain: "" });
    await t.send(old);
    await t.relay.process();
    expect(t.result("a1")!.body).toMatchObject({ id: "a1", result: { status: "passed" }, at: NOW });
  });

  it("runs on changes and on a timer, announces presence, and stops cleanly", async () => {
    const t = await setup();
    const heard: unknown[] = [];
    t.phone.onEphemeral((m) => heard.push(m));
    const stop = t.relay.start({ pollMs: 20, presenceMs: 30 });
    expect(t.phone.read().laptop?.lastSeenAt).toBe(NOW);
    expect(heard[0]).toEqual({ kind: "presence", sentAt: NOW });
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(1));
    await t.send(check("a1"));
    await vi.waitFor(() => expect(t.ledger.enqueue).toHaveBeenCalledTimes(1));
    t.finish("a1", "finished", { status: "passed", output: "", toolchain: "" });
    await vi.waitFor(() => expect(t.result("a1")).toBeDefined());
    stop();
    await t.send(check("a2"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.ledger.enqueue).toHaveBeenCalledTimes(1);
  });
});

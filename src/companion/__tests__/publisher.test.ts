import { describe, it, expect, vi, afterEach } from "vitest";
import { buildLaptopState, publishLaptopState, startPresence, LAST_SEEN_WRITE_MS, buildSessions, publishSessions } from "../publisher";
import type { CompanionStoredSession } from "../../backend/types";
import { createInMemoryHub } from "../doc";
import { PRESENCE_INTERVAL_MS } from "../protocol";
import type { Workstream } from "../../domain/types";

afterEach(() => vi.useRealTimers());

const ws = (id: string, name: string, over: Partial<Workstream> = {}): Workstream => ({
  id, name, description: null, directory: null, git_repo: null, git_branch: null,
  status: "active", project_id: null, workstream_type: "standalone", worktree_branch: null,
  lane_id: null, created_at: "", updated_at: "", ...over,
});

const lanes = [
  { id: "lane-z", name: "Zeta" },
  { id: "lane-a", name: "Alpha" },
];

describe("what the laptop publishes", () => {
  it("lists non-archived workstreams in sidebar order with loaded state and session counts", () => {
    const state = buildLaptopState({
      workstreams: [
        ws("1", "beta", { lane_id: "lane-a" }),
        ws("2", "Alpha 10", { lane_id: "lane-a" }),
        ws("3", "Alpha 9", { lane_id: "lane-a" }),
        ws("4", "In zeta", { lane_id: "lane-z" }),
        ws("5", "Unfiled"),
        ws("6", "Gone", { status: "archived", lane_id: "lane-a" }),
        ws("7", "Stale lane", { lane_id: "deleted-lane" }),
      ],
      lanes,
      loadedIds: new Set(["2", "5"]),
      sessionCounts: new Map([["2", 2], ["4", 1]]),
    });
    // Lanes by name (Alpha, Zeta), names with numeric collation, unfiled last.
    expect(state.workstreams.map((w) => w.name)).toEqual(["Alpha 9", "Alpha 10", "beta", "In zeta", "Stale lane", "Unfiled"]);
    expect(state.workstreams.find((w) => w.id === "2")).toEqual({ id: "2", name: "Alpha 10", laneId: "lane-a", loaded: true, sessionCount: 2 });
    expect(state.workstreams.find((w) => w.id === "7")?.laneId).toBeNull();
    expect(state.workstreams.find((w) => w.id === "6")).toBeUndefined();
    expect(state.lanes).toEqual([{ id: "lane-a", name: "Alpha" }, { id: "lane-z", name: "Zeta" }]);
  });
});

describe("publishing", () => {
  const state = buildLaptopState({ workstreams: [ws("1", "One")], lanes: [], loadedIds: new Set(), sessionCounts: new Map() });

  it("writes the state, and writes nothing when it has not changed", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const writes = vi.fn();
    hub.peer().subscribe(writes);
    expect(publishLaptopState(laptop, state)).toBe(true);
    expect(laptop.read().laptop.workstreams).toEqual(state.workstreams);
    expect(publishLaptopState(laptop, state)).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it("leaves requests and lastSeenAt alone", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    laptop.change((d) => { d.laptop.lastSeenAt = 5; d.requests.r = { id: "r", kind: "load", args: { workstreamId: "1" }, createdAt: 1, signature: "s" }; });
    publishLaptopState(laptop, state);
    expect(laptop.read().laptop.lastSeenAt).toBe(5);
    expect(Object.keys(laptop.read().requests)).toEqual(["r"]);
  });
});

describe("presence", () => {
  it("broadcasts every interval and writes lastSeenAt at start and then only every few minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const heard: unknown[] = [];
    phone.onEphemeral((m) => heard.push(m));
    const writes = vi.fn();
    phone.subscribe(writes);

    const stop = startPresence(laptop);
    expect(heard).toEqual([{ kind: "presence", sentAt: 1_000_000 }]);
    expect(laptop.read().laptop.lastSeenAt).toBe(1_000_000);

    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 3);
    expect(heard).toHaveLength(4);
    expect(writes).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LAST_SEEN_WRITE_MS);
    expect(laptop.read().laptop.lastSeenAt).toBeGreaterThan(1_000_000);
    const writesBeforeStop = writes.mock.calls.length;
    expect(writesBeforeStop).toBe(2);

    stop();
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 10);
    expect(heard.length).toBe(4 + LAST_SEEN_WRITE_MS / PRESENCE_INTERVAL_MS);
  });

  it("stops writing lastSeenAt once the document belongs to a newer version", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const stop = startPresence(laptop);
    phone.change((d) => { d.schemaVersion = 2; });
    const writes = vi.fn();
    phone.subscribe(writes);
    vi.advanceTimersByTime(LAST_SEEN_WRITE_MS * 2);
    expect(writes).not.toHaveBeenCalled();
    expect(laptop.read().laptop.lastSeenAt).toBe(1_000_000);
    stop();
  });

  it("never publishes into a document from a newer version", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    laptop.change((d) => { d.schemaVersion = 2; });
    expect(publishLaptopState(laptop, { workstreams: [{ id: "a", name: "A", laneId: null, loaded: false, sessionCount: 0 }], lanes: [] })).toBe(false);
    expect(laptop.read().laptop.workstreams).toEqual([]);
  });
});


describe("publishing phone sessions", () => {
  const stored = (over: Partial<CompanionStoredSession> = {}): CompanionStoredSession => ({
    tileId: "t1", workstreamId: "a", requestId: "r1", prompt: "List the files\nand more", createdAt: 1000, messages: [], ...over,
  });
  const names = new Map([["a", "Alpha"]]);

  it("builds the published sessions from the laptop's records", () => {
    const sessions = buildSessions([stored({ messages: [{ id: "m1", kind: "result", text: "# x", at: 2000 }] })], names);
    expect(sessions).toEqual({
      t1: {
        id: "t1", workstreamId: "a", workstreamName: "Alpha", requestId: "r1", title: "List the files", createdAt: 1000,
        messages: [{ id: "m1", kind: "result", text: "# x", at: 2000 }],
      },
    });
    expect(buildSessions([stored({ workstreamId: "gone" })], names).t1.workstreamName).toBe("Unknown workstream");
  });

  it("writes sessions, then only appends new messages, and removes pruned sessions", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const writes = vi.fn();
    phone.subscribe(writes);
    const first = buildSessions([stored({ messages: [{ id: "m1", kind: "progress", text: "a", at: 1 }] })], names);
    expect(publishSessions(laptop, first)).toBe(true);
    expect(publishSessions(laptop, first)).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);

    const second = buildSessions([stored({ messages: [
      { id: "m1", kind: "progress", text: "a", at: 1 },
      { id: "m2", kind: "result", text: "b", at: 2 },
    ] })], names);
    publishSessions(laptop, second);
    expect(phone.read().sessions).toEqual(second);

    publishSessions(laptop, {});
    expect(phone.read().sessions).toEqual({});
  });

  it("follows the laptop's cap when older messages are dropped", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const msg = (i: number) => ({ id: `m${i}`, kind: "progress" as const, text: `${i}`, at: i });
    publishSessions(laptop, buildSessions([stored({ messages: [msg(1), msg(2)] })], names));
    const capped = buildSessions([stored({ messages: [msg(2), msg(3)] })], names);
    publishSessions(laptop, capped);
    expect(laptop.read().sessions).toEqual(capped);
  });

  it("never writes sessions into a document from a newer version", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    laptop.change((d) => { d.schemaVersion = 2; });
    expect(publishSessions(laptop, buildSessions([stored()], names))).toBe(false);
    expect(laptop.read().sessions).toBeUndefined();
  });
});

describe("publishing phone sessions into a real Automerge document", () => {
  it("appends, trims and removes in place", async () => {
    const { openAutomergeDoc } = await import("../automerge-doc");
    const { doc } = await openAutomergeDoc({ docUrl: null, network: [], storage: false });
    const names = new Map([["a", "Alpha"]]);
    const msg = (i: number) => ({ id: `m${i}`, kind: "progress" as const, text: `${i}`, at: i });
    const at = (messages: ReturnType<typeof msg>[]) =>
      buildSessions([{ tileId: "t1", workstreamId: "a", requestId: "r1", prompt: "p", createdAt: 1, messages }], names);
    publishSessions(doc, at([msg(1)]));
    publishSessions(doc, at([msg(1), msg(2), msg(3)]));
    expect(doc.read().sessions).toEqual(at([msg(1), msg(2), msg(3)]));
    publishSessions(doc, at([msg(3), msg(4)]));
    expect(doc.read().sessions).toEqual(at([msg(3), msg(4)]));
    publishSessions(doc, {});
    expect(doc.read().sessions).toEqual({});
    doc.close();
  });
});

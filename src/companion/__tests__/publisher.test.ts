import { describe, it, expect, vi, afterEach } from "vitest";
import { buildLaptopState, publishLaptopState, startPresence, LAST_SEEN_WRITE_MS, buildSessions, publishSessions, buildSessionTiles, publishSessionTiles } from "../publisher";
import { linkRevision } from "../link-revision";
import type { Tile } from "../../domain/types";
import type { CompanionStoredSession } from "../../backend/types";
import { verifySessions } from "../protocol";
import fixtures from "../protocol/fixtures.json";

const SECRET = fixtures.secret;
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
    tileId: "t1", workstreamId: "a", requestId: "r1", prompt: "List the files\nand more", createdAt: 1000, canSend: true, messages: [], ...over,
  });
  const names = new Map([["a", "Alpha"]]);

  it("builds the published sessions from the laptop's records, signed", async () => {
    const sessions = await buildSessions([stored({ messages: [{ id: "m1", kind: "result", text: "# x", at: 2000 }] })], names, SECRET);
    expect(sessions).toEqual({
      t1: {
        id: "t1", workstreamId: "a", workstreamName: "Alpha", requestId: "r1", title: "List the files", createdAt: 1000,
        messages: [{ id: "m1", kind: "result", text: "# x", at: 2000, signature: expect.stringMatching(/^[0-9a-f]{64}$/) }],
        signature: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(await verifySessions(Object.values(sessions), SECRET)).toEqual(Object.values(sessions));
    expect((await buildSessions([stored({ workstreamId: "gone" })], names, SECRET)).t1.workstreamName).toBe("Unknown workstream");
  });

  it("writes sessions, then only appends new messages, and removes pruned sessions", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const phone = hub.peer();
    const writes = vi.fn();
    phone.subscribe(writes);
    const first = await buildSessions([stored({ messages: [{ id: "m1", kind: "progress", text: "a", at: 1 }] })], names, SECRET);
    expect(publishSessions(laptop, first)).toBe(true);
    expect(publishSessions(laptop, first)).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);

    const second = await buildSessions([stored({ messages: [
      { id: "m1", kind: "progress", text: "a", at: 1 },
      { id: "m2", kind: "result", text: "b", at: 2 },
    ] })], names, SECRET);
    publishSessions(laptop, second);
    expect(phone.read().sessions).toEqual(second);

    publishSessions(laptop, {});
    expect(phone.read().sessions).toEqual({});
  });

  it("follows the laptop's cap when older messages are dropped", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const msg = (i: number) => ({ id: `m${i}`, kind: "progress" as const, text: `${i}`, at: i });
    publishSessions(laptop, await buildSessions([stored({ messages: [msg(1), msg(2)] })], names, SECRET));
    const capped = await buildSessions([stored({ messages: [msg(2), msg(3)] })], names, SECRET);
    publishSessions(laptop, capped);
    expect(laptop.read().sessions).toEqual(capped);
  });

  it("never writes sessions into a document from a newer version", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    laptop.change((d) => { d.schemaVersion = 2; });
    expect(publishSessions(laptop, await buildSessions([stored()], names, SECRET))).toBe(false);
    expect(laptop.read().sessions).toBeUndefined();
  });
});

describe("publishing phone sessions into a real Automerge document", () => {
  it("appends, trims and removes in place", async () => {
    const { openAutomergeDoc } = await import("../automerge-doc");
    const { doc } = await openAutomergeDoc({ docUrl: null, network: [], storage: false });
    const names = new Map([["a", "Alpha"]]);
    const msg = (i: number) => ({ id: `m${i}`, kind: "progress" as const, text: `${i}`, at: i });
    const at = async (messages: ReturnType<typeof msg>[]) =>
      buildSessions([{ tileId: "t1", workstreamId: "a", requestId: "r1", prompt: "p", createdAt: 1, canSend: true, messages }], names, SECRET);
    publishSessions(doc, await at([msg(1)]));
    publishSessions(doc, await at([msg(1), msg(2), msg(3)]));
    expect(doc.read().sessions).toEqual(await at([msg(1), msg(2), msg(3)]));
    publishSessions(doc, await at([msg(3), msg(4)]));
    expect(doc.read().sessions).toEqual(await at([msg(3), msg(4)]));
    publishSessions(doc, {});
    expect(doc.read().sessions).toEqual({});
    doc.close();
  });
});


describe("publishing the laptop's session tiles", () => {
  const tile = (id: string, workstreamId: string, config: Record<string, unknown>, over: Partial<Tile> = {}): Tile => ({
    id, workstream_id: workstreamId, tile_type: "copilot_session", title: `T ${id}`,
    config_json: JSON.stringify(config), created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T11:00:00Z", ...over,
  });

  it("lists every Copilot tile of non-archived workstreams in order, with link, summary, activity and origin", async () => {
    const tiles = new Map<string, Tile[]>([
      ["a", [
        tile("t1", "a", { copilot_session_id: "s1", session_name: "Fix the bug" }),
        tile("t2", "a", {}),
        { ...tile("x", "a", {}), tile_type: "terminal" },
      ]],
      ["b", [tile("t3", "b", { resume_by_id: "s3" }, { title: null })]],
      ["gone", [tile("t4", "gone", { copilot_session_id: "s4" })]],
    ]);
    const stored = [
      { tileId: "t1", workstreamId: "a", requestId: "r", prompt: "p", createdAt: 1, canSend: true, messages: [{ id: "m", kind: "result" as const, text: "x", at: Date.parse("2026-10-21T00:00:00Z") }] },
      { tileId: "t3", workstreamId: "b", requestId: "r", prompt: "p", createdAt: 1, canSend: false, messages: [] },
    ];
    const published = await buildSessionTiles({ workstreams: [ws("a", "A"), ws("b", "B"), ws("old", "Old", { status: "archived" })], tilesByWorkstream: tiles, stored });
    expect(published).toEqual([
      { tileId: "t1", workstreamId: "a", title: "T t1", summary: "Fix the bug", linked: true, linkRevision: await linkRevision("t1", "s1"), lastActivity: Date.parse("2026-10-21T00:00:00Z"), origin: "phone" },
      { tileId: "t2", workstreamId: "a", title: "T t2", summary: null, linked: false, linkRevision: null, lastActivity: Date.parse("2026-10-20T11:00:00Z"), origin: "laptop" },
      { tileId: "t3", workstreamId: "b", title: "Copilot session", summary: null, linked: true, linkRevision: await linkRevision("t3", "s3"), lastActivity: Date.parse("2026-10-20T11:00:00Z"), origin: "laptop" },
    ]);
    // No transcript or session id leaves the laptop.
    expect(JSON.stringify(published)).not.toContain("s1");
  });

  it("writes them only when they changed, and never into a newer document", () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const t = [{ tileId: "t", workstreamId: "a", title: "T", summary: null, linked: false, linkRevision: null, lastActivity: null, origin: "laptop" as const }];
    expect(publishSessionTiles(laptop, t)).toBe(true);
    expect(publishSessionTiles(laptop, t)).toBe(false);
    expect(hub.peer().read().laptop.tiles).toEqual(t);
    laptop.change((d) => { d.schemaVersion = 2; });
    expect(publishSessionTiles(laptop, [])).toBe(false);
  });
});

describe("keeping the document's history small", () => {
  // A real Automerge document: its history is what the sync server loads on
  // every reconnect, and whole-list rewrites once grew it to 15M operations.
  async function realDoc() {
    const A = await import("@automerge/automerge");
    const { emptyDocument } = await import("../protocol");
    let doc = A.from(emptyDocument() as unknown as Record<string, unknown>);
    const handle = {
      read: () => A.toJS(doc) as unknown as ReturnType<typeof emptyDocument>,
      change: (mutate: (d: ReturnType<typeof emptyDocument>) => void) => { doc = A.change(doc, (d) => mutate(d as unknown as ReturnType<typeof emptyDocument>)); },
      subscribe: () => () => {},
      broadcast: () => {},
      close: () => {},
    };
    const ops = () => A.getAllChanges(doc).reduce((n, c) => n + A.decodeChange(c).ops.length, 0);
    return { handle: handle as unknown as Parameters<typeof publishSessionTiles>[0], ops };
  }
  const tiles = (n: number, activityOf = (i: number) => i) =>
    Array.from({ length: n }, (_, i) => ({
      tileId: `tile-${i}-0123456789abcdef`, workstreamId: `ws-${i}-0123456789abcdef`, title: `A Copilot session title ${i}`,
      summary: `Summary of what session ${i} is doing`, linked: true, linkRevision: `rev-${i}-0123456789abcdef0123456789`,
      lastActivity: activityOf(i), origin: "laptop" as const,
    }));

  it("updates one tile's activity with a handful of operations, not a rewrite of the list", async () => {
    const { handle, ops } = await realDoc();
    publishSessionTiles(handle, tiles(38));
    const before = ops();
    expect(publishSessionTiles(handle, tiles(38, (i) => (i === 7 ? 999 : i)))).toBe(true);
    expect(ops() - before).toBeLessThan(5);
    expect(handle.read().laptop.tiles).toEqual(tiles(38, (i) => (i === 7 ? 999 : i)));
    // A tile added, one removed, and the order changed still end up exact.
    const next = [...tiles(38).slice(1, 20).reverse(), ...tiles(40).slice(38)];
    publishSessionTiles(handle, next);
    expect(handle.read().laptop.tiles).toEqual(next);
  });

  it("updates one workstream's loaded flag with a handful of operations", async () => {
    const { handle, ops } = await realDoc();
    const ws = (loaded: number) => Array.from({ length: 33 }, (_, i) => ({
      id: `ws-${i}-0123456789abcdef`, name: `Workstream number ${i}`, laneId: i % 3 ? `lane-${i % 3}` : null, loaded: i === loaded, sessionCount: i % 4,
    }));
    const lanes = [{ id: "lane-1", name: "One" }, { id: "lane-2", name: "Two" }];
    publishLaptopState(handle, { workstreams: ws(1), lanes });
    const before = ops();
    expect(publishLaptopState(handle, { workstreams: ws(2), lanes })).toBe(true);
    expect(ops() - before).toBeLessThan(5);
    expect(handle.read().laptop.workstreams).toEqual(ws(2));
    const fewer = ws(2).slice(5);
    publishLaptopState(handle, { workstreams: fewer, lanes: lanes.slice(1) });
    expect(handle.read().laptop).toMatchObject({ workstreams: fewer, lanes: lanes.slice(1) });
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { rotateCompanionNow, useCompanionService, type CompanionBindings } from "../useCompanionService";
import { createInMemoryHub } from "../doc";
import { createMemorySettingsStore, loadCompanionSettings, saveCompanionSettings } from "../settings";
import { emptyDocument, signMove, signRequest, verifyMove, type CompanionDocument, type UnsignedRequest } from "../protocol";
import fixtures from "../protocol/fixtures.json";
import { hasOpenRequest } from "../rotation";
import type { Workstream } from "../../domain/types";

afterEach(cleanup);

const SECRET = fixtures.secret;
const OLD = "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh";
const ws = (id: string, name: string): Workstream => ({
  id, name, description: null, directory: `/dirs/${id}`, git_repo: null, git_branch: null,
  status: "active", project_id: null, workstream_type: "standalone", worktree_branch: null,
  lane_id: null, created_at: "", updated_at: "",
});

function bindings(over: Partial<CompanionBindings> = {}): CompanionBindings {
  return {
    ready: true,
    sessionsVersion: 0,
    listSessions: vi.fn(async () => []),
    pruneSessions: vi.fn(async () => 0),
    workstreams: [ws("a", "Alpha"), ws("b", "Beta")],
    lanes: [],
    loadedIds: new Set(["a"]),
    sessionCounts: new Map([["a", 1]]),
    commandFor: () => "copilot --yolo",
    globalCommand: "agency copilot --yolo",
    loadInBackground: vi.fn(async () => {}),
    createWorkstreamAt: vi.fn(async () => "new-id"),
    startSession: vi.fn(async () => {}),
    messageSession: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
    homeDir: async () => "/Users/me",
    ...over,
  };
}

/** Documents by URL on a fake sync server; `create` makes a new empty one. */
function server(initial: CompanionDocument = { ...emptyDocument(), schemaVersion: 1 }) {
  const hubs = new Map<string, ReturnType<typeof createInMemoryHub>>([[OLD, createInMemoryHub(initial)]]);
  let next = 0;
  return {
    hubs,
    connect: vi.fn(async (settings: { docUrl: string }) => hubs.get(settings.docUrl)!.peer()),
    createDocument: vi.fn(async () => {
      const url = `automerge:3NewDoc${++next}`;
      hubs.set(url, createInMemoryHub(emptyDocument()));
      return url;
    }),
  };
}

const store = () => createMemorySettingsStore({
  "companion.enabled": "1",
  "companion.doc_url": OLD,
  "companion.secret": SECRET,
  "companion.folder_root": "~/Phone",
});

async function phoneSends(doc: { change(m: (d: CompanionDocument) => void): void }, id: string) {
  const unsigned = { id, kind: "load", args: { workstreamId: "b" }, createdAt: Date.now() } as UnsignedRequest;
  const signature = await signRequest(SECRET, unsigned);
  doc.change((d) => { d.requests[id] = { ...unsigned, signature }; });
}

const big = { aboveBytes: 10_000_000, everyMs: 60_000, graceMs: 60_000 };

describe("rotating the companion document", () => {
  it("Rotate now moves to a fresh v2 document, republishes, and leaves a signed pointer behind", async () => {
    const s = server();
    const settings = store();
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await waitFor(() => expect(s.hubs.get(OLD)!.peer().read().laptop.workstreams).toHaveLength(2));

    let outcome: Awaited<ReturnType<typeof rotateCompanionNow>> | undefined;
    await act(async () => { outcome = await rotateCompanionNow(); });
    expect(outcome).toEqual({ ok: true, url: "automerge:3NewDoc1" });
    expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3NewDoc1");

    const fresh = s.hubs.get("automerge:3NewDoc1")!.peer();
    await waitFor(() => expect(fresh.read().laptop.workstreams.map((w) => w.name)).toEqual(["Alpha", "Beta"]));
    expect(fresh.read().requests).toEqual({});
    expect(fresh.read().schemaVersion).toBe(2);

    const old = s.hubs.get(OLD)!.peer().read();
    expect(old.schemaVersion).toBe(2);
    expect(await verifyMove(old, OLD, SECRET)).toBe("automerge:3NewDoc1");
  });

  it("does not rotate while a request is running, and rotates once it finishes", async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const settings = store();
    const { result } = renderHook(() => useCompanionService(bindings({ loadInBackground: vi.fn(() => gate) }), {
      store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await phoneSends(s.hubs.get(OLD)!.peer(), "r1");
    await waitFor(() => expect(s.hubs.get(OLD)!.peer().read().requests.r1.outcome?.status).toBe("running"));

    let outcome: Awaited<ReturnType<typeof rotateCompanionNow>> | undefined;
    await act(async () => { outcome = await rotateCompanionNow(); });
    expect(outcome).toEqual({ ok: false, reason: "queued" });
    expect((await loadCompanionSettings(settings)).docUrl).toBe(OLD);
    expect(s.createDocument).not.toHaveBeenCalled();
    release();
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3NewDoc1"));
    expect(s.hubs.get(OLD)!.peer().read().requests.r1.outcome?.status).toBe("done");
  });

  it("rotates by itself when the document is over the size limit, at start and on the periodic check", async () => {
    const s = server();
    const settings = store();
    const size = s.hubs.get(OLD)!.peer().size();
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: settings, connect: s.connect, createDocument: s.createDocument,
      rotation: { aboveBytes: size + 2_000, everyMs: 80, graceMs: 60_000 }, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(s.createDocument).not.toHaveBeenCalled();

    // The document grows past the limit; the next check rotates.
    s.hubs.get(OLD)!.peer().change((d) => {
      d.laptop.lanes = Array.from({ length: 100 }, (_, i) => ({ id: `lane-${i}`, name: "x".repeat(40) }));
    });
    await waitFor(() => expect(s.createDocument).toHaveBeenCalledTimes(1), { timeout: 2000 });
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3NewDoc1"));
  });

  it("rotates at start when the document is already over the limit", async () => {
    const s = server();
    const settings = store();
    renderHook(() => useCompanionService(bindings(), {
      store: settings, connect: s.connect, createDocument: s.createDocument,
      rotation: { aboveBytes: 1, everyMs: 60_000, graceMs: 60_000 }, devBuild: false,
    }));
    await waitFor(() => expect(s.createDocument).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // The fresh document is also over 1 byte, but automatic rotation waits a whole interval.
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(s.createDocument).toHaveBeenCalledTimes(1);
  });

  it("answers the old document's requests during the grace period only, and stops publishing there", async () => {
    const s = server();
    const settings = store();
    let b = bindings();
    const { result, rerender } = renderHook(() => useCompanionService(b, {
      store: settings, connect: s.connect, createDocument: s.createDocument,
      rotation: { aboveBytes: 10_000_000, everyMs: 60_000, graceMs: 300 }, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await rotateCompanionNow(); });
    const oldPeer = s.hubs.get(OLD)!.peer();
    const before = JSON.stringify(oldPeer.read().laptop);

    await phoneSends(oldPeer, "early");
    await waitFor(() => expect(oldPeer.read().requests.early.outcome?.status).toBe("done"));

    b = bindings({ workstreams: [ws("a", "Alpha"), ws("b", "Beta"), ws("c", "Gamma")] });
    rerender();
    const fresh = s.hubs.get("automerge:3NewDoc1")!.peer();
    await waitFor(() => expect(fresh.read().laptop.workstreams).toHaveLength(3));
    expect(JSON.stringify(oldPeer.read().laptop)).toBe(before);

    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await phoneSends(oldPeer, "late");
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(oldPeer.read().requests.late.outcome).toBeUndefined();
  });
});

describe("rotation, failure cases", () => {
  it("does not retire the document when a request arrives while the successor is being made", async () => {
    const s = server();
    const settings = store();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createDocument = vi.fn(async () => {
      await phoneSends(s.hubs.get(OLD)!.peer(), "mid");
      return s.createDocument();
    });
    const { result } = renderHook(() => useCompanionService(bindings({ loadInBackground: vi.fn(() => gate) }), {
      store: settings, connect: s.connect, createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    let outcome: Awaited<ReturnType<typeof rotateCompanionNow>> | undefined;
    await act(async () => { outcome = await rotateCompanionNow(); });
    expect(outcome).toEqual({ ok: false, reason: "queued" });
    expect(s.hubs.get(OLD)!.peer().read().movedTo).toBeUndefined();
    expect((await loadCompanionSettings(settings)).docUrl).toBe(OLD);
    release();
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).not.toBe(OLD));
  });

  it("follows its own pointer when it restarts on a document it already retired", async () => {
    const s = server();
    s.hubs.set("automerge:3Successor", createInMemoryHub(emptyDocument()));
    const movedTo = await signMove(SECRET, OLD, "automerge:3Successor", Date.now());
    s.hubs.get(OLD)!.peer().change((d) => { d.movedTo = movedTo; d.schemaVersion = 2; });
    const settings = store();
    renderHook(() => useCompanionService(bindings(), { store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false }));
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3Successor"));
    await waitFor(() => expect(s.hubs.get("automerge:3Successor")!.peer().read().laptop.workstreams).toHaveLength(2));
    expect(s.createDocument).not.toHaveBeenCalled();
  });

  it("re-sends the pointer from a retired document after a restart, until the phone arrives", async () => {
    const s = server();
    s.hubs.set("automerge:3Successor", createInMemoryHub(emptyDocument()));
    const settings = createMemorySettingsStore({
      "companion.enabled": "1", "companion.doc_url": "automerge:3Successor", "companion.secret": SECRET,
      "companion.folder_root": "~/Phone", "companion.retired_docs": JSON.stringify([OLD]),
    });
    renderHook(() => useCompanionService(bindings(), { store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false }));
    // The pointer never reached the server: it is written again.
    await waitFor(async () => expect(await verifyMove(s.hubs.get(OLD)!.peer().read(), OLD, SECRET)).toBe("automerge:3Successor"));
    expect(JSON.parse((await settings.get("companion.retired_docs")) ?? "[]")).toEqual([OLD]);
    await phoneSends(s.hubs.get("automerge:3Successor")!.peer(), "arrived");
    await waitFor(async () => expect(JSON.parse((await settings.get("companion.retired_docs")) ?? "[]")).toEqual([]));
  });

  it("stops answering the retired document as soon as the companion is turned off", async () => {
    const s = server();
    const settings = store();
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: settings, connect: s.connect, createDocument: s.createDocument,
      rotation: { aboveBytes: 10_000_000, everyMs: 60_000, graceMs: 60_000 }, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await rotateCompanionNow(); });
    await act(async () => { await saveCompanionSettings(settings, { enabled: false }); });
    await waitFor(() => expect(result.current.state).toBe("off"));
    const oldPeer = s.hubs.get(OLD)!.peer();
    await phoneSends(oldPeer, "after-off");
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(oldPeer.read().requests["after-off"].outcome).toBeUndefined();
  });

  it("never lets a slow publish started before the rotation write into the retired document", async () => {
    const s = server();
    const settings = store();
    let slowNext = false;
    let slow: ((value: unknown[]) => void) | null = null;
    const listSessions = vi.fn(() => {
      if (!slowNext) return Promise.resolve([]);
      slowNext = false;
      return new Promise<unknown[]>((resolve) => { slow = resolve; });
    }) as unknown as CompanionBindings["listSessions"];
    let b = bindings({ listSessions });
    // The successor connects only after the stale publish has resolved.
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const connect = vi.fn(async (settings: { docUrl: string }) => {
      if (settings.docUrl !== OLD) await connectGate;
      return s.connect(settings);
    });
    const { result, rerender } = renderHook(() => useCompanionService(b, {
      store: settings, connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    slowNext = true;
    b = bindings({ listSessions, sessionsVersion: 1 });
    rerender();
    await waitFor(() => expect(slow).not.toBeNull());
    await act(async () => { await rotateCompanionNow(); });
    const before = JSON.stringify(s.hubs.get(OLD)!.peer().read().sessions ?? null);
    const stored = [{ tileId: "t1", workstreamId: "a", requestId: "r", prompt: "late", createdAt: Date.now(), canSend: true, messages: [] }];
    await act(async () => { slow!(stored); await new Promise((r) => setTimeout(r, 50)); });
    expect(JSON.stringify(s.hubs.get(OLD)!.peer().read().sessions ?? null)).toBe(before);
    releaseConnect();
  });
});

describe("rotation, recovery", () => {
  it("records the retired document before publishing its pointer, and retires nothing if it cannot", async () => {
    const s = server();
    const base = store();
    const failing = { get: base.get, set: async (key: string, value: string) => {
      if (key === "companion.retired_docs") throw new Error("disk full");
      await base.set(key, value);
    } };
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: failing, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    let outcome: Awaited<ReturnType<typeof rotateCompanionNow>> | undefined;
    await act(async () => { outcome = await rotateCompanionNow(); });
    expect(outcome).toMatchObject({ ok: false, reason: "error", message: "disk full" });
    expect(s.hubs.get(OLD)!.peer().read().movedTo).toBeUndefined();
    expect((await loadCompanionSettings(base)).docUrl).toBe(OLD);
  });

  it("keeps every retired document until the phone arrives, and repairs each one", async () => {
    const s = server();
    const settings = store();
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await rotateCompanionNow(); });
    await waitFor(() => expect(result.current.state).toBe("on"));
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3NewDoc1"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); await rotateCompanionNow(); });
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3NewDoc2"));
    expect(JSON.parse((await settings.get("companion.retired_docs")) ?? "[]")).toEqual([OLD, "automerge:3NewDoc1"]);
    expect(await verifyMove(s.hubs.get(OLD)!.peer().read(), OLD, SECRET)).toBe("automerge:3NewDoc1");
    expect(await verifyMove(s.hubs.get("automerge:3NewDoc1")!.peer().read(), "automerge:3NewDoc1", SECRET)).toBe("automerge:3NewDoc2");
  });

  it("follows a move that syncs in after it connected", async () => {
    const s = server();
    s.hubs.set("automerge:3Successor", createInMemoryHub(emptyDocument()));
    const settings = store();
    const { result } = renderHook(() => useCompanionService(bindings(), { store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    const movedTo = await signMove(SECRET, OLD, "automerge:3Successor", Date.now());
    s.hubs.get(OLD)!.peer().change((d) => { d.movedTo = movedTo; d.schemaVersion = 2; });
    await waitFor(async () => expect((await loadCompanionSettings(settings)).docUrl).toBe("automerge:3Successor"));
  });

  it("starts the current document without waiting for a retired one that does not open", async () => {
    const s = server();
    s.hubs.set("automerge:3Successor", createInMemoryHub(emptyDocument()));
    const connect = vi.fn(async (settings: { docUrl: string }) => {
      if (settings.docUrl === OLD) return new Promise<never>(() => {});
      return s.connect(settings);
    });
    const settings = createMemorySettingsStore({
      "companion.enabled": "1", "companion.doc_url": "automerge:3Successor", "companion.secret": SECRET,
      "companion.folder_root": "~/Phone", "companion.retired_docs": JSON.stringify([OLD]),
    });
    const { result } = renderHook(() => useCompanionService(bindings(), { store: settings, connect, createDocument: s.createDocument, rotation: big, devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await waitFor(() => expect(s.hubs.get("automerge:3Successor")!.peer().read().laptop.workstreams).toHaveLength(2));
  });

  it("never writes a pointer into a retired document from a newer version", async () => {
    const s = server({ ...emptyDocument(), schemaVersion: 3 });
    s.hubs.set("automerge:3Successor", createInMemoryHub(emptyDocument()));
    const settings = createMemorySettingsStore({
      "companion.enabled": "1", "companion.doc_url": "automerge:3Successor", "companion.secret": SECRET,
      "companion.folder_root": "~/Phone", "companion.retired_docs": JSON.stringify([OLD]),
    });
    const { result } = renderHook(() => useCompanionService(bindings(), { store: settings, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(s.hubs.get(OLD)!.peer().read()).toMatchObject({ schemaVersion: 3 });
    expect(s.hubs.get(OLD)!.peer().read().movedTo).toBeUndefined();
  });
});

describe("rotation, last checks", () => {
  it("does not publish the pointer when a request arrives while the settings are written", async () => {
    const s = server();
    const base = store();
    const racing = { get: base.get, set: async (key: string, value: string) => {
      if (key === "companion.retired_docs") await phoneSends(s.hubs.get(OLD)!.peer(), "during-settings");
      await base.set(key, value);
    } };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { result } = renderHook(() => useCompanionService(bindings({ loadInBackground: vi.fn(() => gate) }), {
      store: racing, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    let outcome: Awaited<ReturnType<typeof rotateCompanionNow>> | undefined;
    await act(async () => { outcome = await rotateCompanionNow(); });
    expect(outcome).toEqual({ ok: false, reason: "queued" });
    expect(s.hubs.get(OLD)!.peer().read().movedTo).toBeUndefined();
    release();
  });

  it("still moves with the phone when saving the new document fails once", async () => {
    const s = server();
    const base = store();
    let failOnce = true;
    const flaky = { get: base.get, set: async (key: string, value: string) => {
      if (key === "companion.doc_url" && failOnce) { failOnce = false; throw new Error("locked"); }
      await base.set(key, value);
    } };
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: flaky, connect: s.connect, createDocument: s.createDocument, rotation: big, devBuild: false,
    }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await rotateCompanionNow(); });
    await waitFor(async () => expect((await loadCompanionSettings(base)).docUrl).toBe("automerge:3NewDoc1"));
  });
});

describe("hasOpenRequest", () => {
  const NOW = 1_800_000_000_000;
  const doc = (requests: Record<string, unknown>) => ({ ...emptyDocument(), requests } as unknown as CompanionDocument);
  const request = (over: Record<string, unknown>) => ({ id: "r", kind: "load", args: { workstreamId: "a" }, createdAt: NOW, signature: "s", ...over });

  it("is open for a running request or a fresh unanswered one", () => {
    expect(hasOpenRequest(doc({ r: request({ outcome: { status: "running", at: NOW } }) }), NOW)).toBe(true);
    expect(hasOpenRequest(doc({ r: request({}) }), NOW)).toBe(true);
  });

  it("is not open for finished, stale or malformed entries", () => {
    expect(hasOpenRequest(doc({}), NOW)).toBe(false);
    expect(hasOpenRequest(doc({ r: request({ outcome: { status: "done", at: NOW } }) }), NOW)).toBe(false);
    expect(hasOpenRequest(doc({ r: request({ createdAt: NOW - 60 * 60_000 }) }), NOW)).toBe(false);
    expect(hasOpenRequest(doc({ r: "junk", s: null }), NOW)).toBe(false);
  });
});


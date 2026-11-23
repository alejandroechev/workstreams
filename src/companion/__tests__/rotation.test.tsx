import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { rotateCompanionNow, useCompanionService, type CompanionBindings } from "../useCompanionService";
import { createInMemoryHub } from "../doc";
import { createMemorySettingsStore, loadCompanionSettings } from "../settings";
import { emptyDocument, signRequest, verifyMove, type CompanionDocument, type UnsignedRequest } from "../protocol";
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


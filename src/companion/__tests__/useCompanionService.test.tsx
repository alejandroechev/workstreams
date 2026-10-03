import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import { useCompanionService, type CompanionBindings } from "../useCompanionService";
import { createInMemoryHub } from "../doc";
import { createMemorySettingsStore, saveCompanionSettings } from "../settings";
import { emptyDocument, signRequest, type UnsignedRequest } from "../protocol";
import fixtures from "../protocol/fixtures.json";
import type { Workstream } from "../../domain/types";

afterEach(cleanup);

const SECRET = fixtures.secret;
const ws = (id: string, name: string, over: Partial<Workstream> = {}): Workstream => ({
  id, name, description: null, directory: `/dirs/${id}`, git_repo: null, git_branch: null,
  status: "active", project_id: null, workstream_type: "standalone", worktree_branch: null,
  lane_id: null, created_at: "", updated_at: "", ...over,
});

function bindings(over: Partial<CompanionBindings> = {}): CompanionBindings {
  return {
    ready: true,
    workstreams: [ws("a", "Alpha"), ws("b", "Beta")],
    lanes: [],
    loadedIds: new Set(["a"]),
    sessionCounts: new Map([["a", 1]]),
    commandFor: () => "copilot --yolo",
    globalCommand: "agency copilot --yolo",
    loadInBackground: vi.fn(async () => {}),
    createWorkstreamAt: vi.fn(async () => "new-id"),
    startSession: vi.fn(async () => {}),
    createDirectory: vi.fn(async () => {}),
    homeDir: async () => "/Users/me",
    ...over,
  };
}

const enabledStore = () => createMemorySettingsStore({
  "companion.enabled": "1",
  "companion.doc_url": "automerge:2CNt9qhcehE1jm8fNB88b6PzuuWh",
  "companion.secret": SECRET,
  "companion.folder_root": "~/Phone",
});

async function phoneSends(phone: ReturnType<ReturnType<typeof createInMemoryHub>["peer"]>, request: Partial<UnsignedRequest>) {
  const unsigned = { id: "r1", kind: "load", args: { workstreamId: "b" }, createdAt: Date.now(), ...request } as UnsignedRequest;
  const signature = await signRequest(SECRET, unsigned);
  phone.change((d) => { d.requests[unsigned.id] = { ...unsigned, signature }; });
}

describe("the companion service in the app", () => {
  it("does not connect while the companion is off", async () => {
    const connect = vi.fn();
    const { result } = renderHook(() => useCompanionService(bindings(), { store: createMemorySettingsStore(), connect, devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("off"));
    expect(connect).not.toHaveBeenCalled();
  });

  it("never connects in a development build", async () => {
    const connect = vi.fn();
    const { result } = renderHook(() => useCompanionService(bindings(), { store: enabledStore(), connect, devBuild: true }));
    await waitFor(() => expect(result.current.state).toBe("dev-disabled"));
    expect(connect).not.toHaveBeenCalled();
  });

  it("waits until the app has loaded before connecting, publishing or executing", async () => {
    const hub = createInMemoryHub();
    const phone = hub.peer();
    await phoneSends(phone, {});
    const connect = vi.fn(async () => hub.peer());
    let b = bindings({ ready: false, workstreams: [] });
    const { result, rerender, unmount } = renderHook(() => useCompanionService(b, { store: enabledStore(), connect, devBuild: false }));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(connect).not.toHaveBeenCalled();
    expect(phone.read().requests.r1.outcome).toBeUndefined();
    b = bindings();
    rerender();
    await waitFor(() => expect(result.current.state).toBe("on"));
    await waitFor(() => expect(phone.read().requests.r1.outcome?.status).toBe("done"));
    expect(b.loadInBackground).toHaveBeenCalledWith("b");
    unmount();
  });

  it("records executed requests in the laptop's own settings", async () => {
    const hub = createInMemoryHub();
    const phone = hub.peer();
    const store = enabledStore();
    const { result, unmount } = renderHook(() => useCompanionService(bindings(), { store, connect: async () => hub.peer(), devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await phoneSends(phone, {}); });
    await waitFor(() => expect(phone.read().requests.r1.outcome?.status).toBe("done"));
    expect(Object.keys(JSON.parse((await store.get("companion.consumed")) ?? "{}"))).toEqual(["r1"]);
    unmount();
  });

  it("publishes the workstreams and executes the paired phone's requests", async () => {
    const hub = createInMemoryHub();
    const phone = hub.peer();
    const b = bindings();
    const { result, unmount } = renderHook(() => useCompanionService(b, { store: enabledStore(), connect: async () => hub.peer(), devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await waitFor(() => expect(phone.read().laptop.workstreams.map((w) => w.name)).toEqual(["Alpha", "Beta"]));
    expect(phone.read().laptop.workstreams[0]).toMatchObject({ loaded: true, sessionCount: 1 });
    expect(phone.read().laptop.lastSeenAt).not.toBeNull();

    await act(async () => { await phoneSends(phone, {}); });
    await waitFor(() => expect(phone.read().requests.r1.outcome?.status).toBe("done"));
    expect(b.loadInBackground).toHaveBeenCalledWith("b");
    unmount();
  });

  it("creates phone workstreams in a fresh folder under the configured root", async () => {
    const hub = createInMemoryHub();
    const phone = hub.peer();
    const b = bindings();
    const { result, unmount } = renderHook(() => useCompanionService(b, { store: enabledStore(), connect: async () => hub.peer(), devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await phoneSends(phone, { id: "c1", kind: "create", args: { name: "Phone idea", prompt: "Go" } }); });
    await waitFor(() => expect(phone.read().requests.c1.outcome?.status).toBe("done"));
    expect(b.createDirectory).toHaveBeenCalledWith("/Users/me/Phone/phone-idea");
    expect(b.createWorkstreamAt).toHaveBeenCalledWith("Phone idea", "/Users/me/Phone/phone-idea");
    expect(b.loadInBackground).toHaveBeenCalledWith("new-id");
    expect(b.startSession).toHaveBeenCalledWith("new-id", "agency copilot --yolo", "Go");
    unmount();
  });

  it("disconnects when the companion is turned off", async () => {
    const hub = createInMemoryHub();
    const laptop = hub.peer();
    const close = vi.spyOn(laptop, "close");
    const store = enabledStore();
    const { result } = renderHook(() => useCompanionService(bindings(), { store, connect: async () => laptop, devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("on"));
    await act(async () => { await saveCompanionSettings(store, { enabled: false }); });
    await waitFor(() => expect(result.current.state).toBe("off"));
    expect(close).toHaveBeenCalled();
  });

  it("says Workstreams needs updating when the document is from a newer version", async () => {
    const seeded = emptyDocument();
    seeded.schemaVersion = 2;
    const hub = createInMemoryHub(seeded);
    const { result } = renderHook(() => useCompanionService(bindings(), { store: enabledStore(), connect: async () => hub.peer(), devBuild: false }));
    await waitFor(() => expect(result.current).toEqual({ state: "update-needed" }));
    // Nothing is written into a document whose shape this version does not know.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = hub.peer().read();
    expect(after.laptop.lastSeenAt).toBeNull();
    expect(after.laptop.workstreams).toEqual([]);
  });

  it("reports a connection failure instead of failing silently", async () => {
    const { result } = renderHook(() => useCompanionService(bindings(), {
      store: enabledStore(), connect: async () => { throw new Error("401 Unauthorized"); }, devBuild: false,
    }));
    await waitFor(() => expect(result.current).toEqual({ state: "error", error: "401 Unauthorized" }));
  });

  it("refuses to run anything when its record of handled requests is unreadable", async () => {
    const hub = createInMemoryHub();
    const phone = hub.peer();
    await phoneSends(phone, {});
    const store = enabledStore();
    await store.set("companion.consumed", "{corrupt");
    const { result, unmount } = renderHook(() => useCompanionService(bindings(), { store, connect: async () => hub.peer(), devBuild: false }));
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current).toMatchObject({ error: expect.stringContaining("Pair a new phone") });
    expect(phone.read().requests.r1.outcome).toBeUndefined();
    unmount();
  });
});


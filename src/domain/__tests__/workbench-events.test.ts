import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WORKBENCH_ADD_EVENT,
  dispatchAddToWorkbench,
  subscribeAddToWorkbench,
  appendUnique,
  setWorkbenchStoreForDispatcher,
} from "../workbench-events";
import { createWorkbenchStore } from "../workbench-store";

describe("workbench-events", () => {
  describe("appendUnique", () => {
    it("appends a new path", () => {
      expect(appendUnique(["a"], "b")).toEqual(["a", "b"]);
    });
    it("returns the original ref when the path already exists", () => {
      const xs = ["a", "b"];
      expect(appendUnique(xs, "a")).toBe(xs);
    });
    it("appends to an empty list", () => {
      expect(appendUnique([], "a")).toEqual(["a"]);
    });
  });

  describe("dispatch + subscribe", () => {
    afterEach(() => { setWorkbenchStoreForDispatcher(null); });

    it("subscriber receives dispatched payload", async () => {
      const handler = vi.fn();
      const off = subscribeAddToWorkbench(handler);
      await dispatchAddToWorkbench({ path: "C:/x", workstreamId: "ws-1" });
      expect(handler).toHaveBeenCalledWith({ path: "C:/x", workstreamId: "ws-1" });
      off();
    });

    it("unsubscribed handlers do not receive subsequent dispatches", async () => {
      const handler = vi.fn();
      const off = subscribeAddToWorkbench(handler);
      off();
      await dispatchAddToWorkbench({ path: "C:/x", workstreamId: null });
      expect(handler).not.toHaveBeenCalled();
    });

    it("event name is stable for cross-bundle subscribers", () => {
      expect(WORKBENCH_ADD_EVENT).toBe("workstreams:add-to-workbench");
    });

    it("persists through the wired store when a workstreamId is supplied", async () => {
      const backing = new Map<string, string>();
      const store = createWorkbenchStore({
        getSetting: async (k) => backing.get(k) ?? null,
        setSetting: async (k, v) => { backing.set(k, v); },
      });
      setWorkbenchStoreForDispatcher(store);
      await dispatchAddToWorkbench({ path: "C:/x", workstreamId: "ws-1" });
      expect(await store.list("ws-1")).toEqual(["C:/x"]);
    });

    it("does NOT persist when workstreamId is null", async () => {
      const backing = new Map<string, string>();
      const store = createWorkbenchStore({
        getSetting: async (k) => backing.get(k) ?? null,
        setSetting: async (k, v) => { backing.set(k, v); },
      });
      setWorkbenchStoreForDispatcher(store);
      await dispatchAddToWorkbench({ path: "C:/x", workstreamId: null });
      expect(backing.size).toBe(0);
    });
  });
});

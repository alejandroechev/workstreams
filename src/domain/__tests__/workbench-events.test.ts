import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WORKBENCH_ADD_EVENT,
  dispatchAddToWorkbench,
  subscribeAddToWorkbench,
  appendUnique,
} from "../workbench-events";

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
    afterEach(() => { /* listeners cleaned up by tests themselves */ });

    it("subscriber receives dispatched payload", () => {
      const handler = vi.fn();
      const off = subscribeAddToWorkbench(handler);
      dispatchAddToWorkbench({ path: "C:/x", workstreamId: "ws-1" });
      expect(handler).toHaveBeenCalledWith({ path: "C:/x", workstreamId: "ws-1" });
      off();
    });

    it("unsubscribed handlers do not receive subsequent dispatches", () => {
      const handler = vi.fn();
      const off = subscribeAddToWorkbench(handler);
      off();
      dispatchAddToWorkbench({ path: "C:/x", workstreamId: null });
      expect(handler).not.toHaveBeenCalled();
    });

    it("event name is stable for cross-bundle subscribers", () => {
      expect(WORKBENCH_ADD_EVENT).toBe("workstreams:add-to-workbench");
    });
  });
});

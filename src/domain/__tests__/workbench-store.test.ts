import { describe, it, expect, vi } from "vitest";
import {
  workbenchSettingKey,
  parseList,
  serializeList,
  appendUnique,
  removeOne,
  createWorkbenchStore,
  type WorkbenchStoreDeps,
} from "../workbench-store";

describe("workbench-store", () => {
  describe("workbenchSettingKey", () => {
    it("namespaces by workstream id", () => {
      expect(workbenchSettingKey("ws-1")).toBe("workbench:ws-1");
    });
  });

  describe("parseList", () => {
    it("returns [] for null / empty / invalid JSON", () => {
      expect(parseList(null)).toEqual([]);
      expect(parseList("")).toEqual([]);
      expect(parseList("not-json")).toEqual([]);
      expect(parseList('{"not":"an array"}')).toEqual([]);
    });
    it("returns the parsed array of strings, dropping non-strings", () => {
      expect(parseList('["a","b","c"]')).toEqual(["a", "b", "c"]);
      expect(parseList('["a",2,null,"c"]')).toEqual(["a", "c"]);
    });
  });

  describe("serializeList", () => {
    it("round-trips with parseList", () => {
      const xs = ["a", "b"];
      expect(parseList(serializeList(xs))).toEqual(xs);
    });
  });

  describe("appendUnique", () => {
    it("appends a new path", () => {
      expect(appendUnique(["a"], "b")).toEqual(["a", "b"]);
    });
    it("returns same ref on duplicate", () => {
      const xs = ["a", "b"];
      expect(appendUnique(xs, "a")).toBe(xs);
    });
  });

  describe("removeOne", () => {
    it("removes the first matching path", () => {
      expect(removeOne(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    });
    it("returns same ref when path is missing", () => {
      const xs = ["a", "b"];
      expect(removeOne(xs, "x")).toBe(xs);
    });
  });

  describe("createWorkbenchStore", () => {
    function makeDeps(initial: Record<string, string> = {}): { deps: WorkbenchStoreDeps; backing: Map<string, string>; setCalls: Array<[string, string]> } {
      const backing = new Map<string, string>(Object.entries(initial));
      const setCalls: Array<[string, string]> = [];
      const deps: WorkbenchStoreDeps = {
        getSetting: vi.fn(async (key: string) => backing.get(key) ?? null),
        setSetting: vi.fn(async (key: string, value: string) => { backing.set(key, value); setCalls.push([key, value]); }),
      };
      return { deps, backing, setCalls };
    }

    it("list returns [] when no setting exists", async () => {
      const { deps } = makeDeps();
      const store = createWorkbenchStore(deps);
      expect(await store.list("ws-1")).toEqual([]);
    });

    it("list returns the persisted array", async () => {
      const { deps } = makeDeps({ "workbench:ws-1": '["foo","bar"]' });
      const store = createWorkbenchStore(deps);
      expect(await store.list("ws-1")).toEqual(["foo", "bar"]);
    });

    it("add writes through and returns the new list", async () => {
      const { deps, setCalls } = makeDeps({ "workbench:ws-1": '["a"]' });
      const store = createWorkbenchStore(deps);
      expect(await store.add("ws-1", "b")).toEqual(["a", "b"]);
      expect(setCalls).toEqual([["workbench:ws-1", '["a","b"]']]);
    });

    it("add is a no-op when path is already present", async () => {
      const { deps, setCalls } = makeDeps({ "workbench:ws-1": '["a"]' });
      const store = createWorkbenchStore(deps);
      expect(await store.add("ws-1", "a")).toEqual(["a"]);
      expect(setCalls).toEqual([]);
    });

    it("remove writes through and returns the new list", async () => {
      const { deps, setCalls } = makeDeps({ "workbench:ws-1": '["a","b","c"]' });
      const store = createWorkbenchStore(deps);
      expect(await store.remove("ws-1", "b")).toEqual(["a", "c"]);
      expect(setCalls).toEqual([["workbench:ws-1", '["a","c"]']]);
    });

    it("remove is a no-op when path is missing", async () => {
      const { deps, setCalls } = makeDeps({ "workbench:ws-1": '["a"]' });
      const store = createWorkbenchStore(deps);
      expect(await store.remove("ws-1", "x")).toEqual(["a"]);
      expect(setCalls).toEqual([]);
    });

    it("set overwrites the persisted value", async () => {
      const { deps, setCalls } = makeDeps({ "workbench:ws-1": '["old"]' });
      const store = createWorkbenchStore(deps);
      await store.set("ws-1", ["x", "y"]);
      expect(setCalls).toEqual([["workbench:ws-1", '["x","y"]']]);
    });

    it("each workstream has an isolated list", async () => {
      const { deps } = makeDeps();
      const store = createWorkbenchStore(deps);
      await store.add("ws-1", "a");
      await store.add("ws-2", "b");
      expect(await store.list("ws-1")).toEqual(["a"]);
      expect(await store.list("ws-2")).toEqual(["b"]);
    });
  });
});

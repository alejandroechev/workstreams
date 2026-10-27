import { describe, it, expect, vi } from "vitest";
import { expandHome, createUniqueFolder, createStandaloneFolder } from "../folders";

describe("expanding the folder root", () => {
  it.each([
    ["~/Workstreams", "/Users/me", "/Users/me/Workstreams"],
    ["~", "/Users/me", "/Users/me"],
    ["/abs/path", "/Users/me", "/abs/path"],
    ["~/Workstreams/", "/Users/me/", "/Users/me/Workstreams"],
  ])("%s with home %s → %s", (root, home, expected) => {
    expect(expandHome(root, home)).toBe(expected);
  });

  it("refuses a relative root, which would land wherever the app happened to start", () => {
    expect(() => expandHome("Workstreams", "/Users/me")).toThrow(/absolute/i);
  });
});

describe("creating a fresh folder for a new workstream", () => {
  it("uses the slug when it is free", async () => {
    const create = vi.fn(async () => {});
    await expect(createUniqueFolder("/root", "idea", create)).resolves.toBe("/root/idea");
    expect(create).toHaveBeenCalledWith("/root/idea");
  });

  it("adds a numeric suffix until a name is free, never reusing an existing folder", async () => {
    const taken = new Set(["/root/idea", "/root/idea-2"]);
    const create = vi.fn(async (path: string) => {
      if (taken.has(path)) throw new Error(`A file or folder already exists at ${path}`);
    });
    await expect(createUniqueFolder("/root", "idea", create)).resolves.toBe("/root/idea-3");
  });

  it("gives up after a bounded number of attempts", async () => {
    const create = vi.fn(async (path: string) => { throw new Error(`A file or folder already exists at ${path}`); });
    await expect(createUniqueFolder("/root", "idea", create)).rejects.toThrow(/could not find a free folder/i);
    expect(create.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it("reports any other failure straight away", async () => {
    const create = vi.fn(async () => { throw new Error("Permission denied"); });
    await expect(createUniqueFolder("/root", "idea", create)).rejects.toThrow("Permission denied");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("a folder for a workstream without a repo", () => {
  it("makes a fresh folder named after the workstream under the root, expanding ~", async () => {
    const created: string[] = [];
    const createDirectory = async (path: string) => {
      if (created.includes(path)) throw new Error(`A file or folder already exists at ${path}`);
      created.push(path);
    };
    const home = async () => "/Users/me";
    await expect(createStandaloneFolder({ root: "~/Workstreams", name: "Café ideas!", homeDir: home, createDirectory }))
      .resolves.toBe("/Users/me/Workstreams/cafe-ideas");
    await expect(createStandaloneFolder({ root: "~/Workstreams", name: "Café ideas", homeDir: home, createDirectory }))
      .resolves.toBe("/Users/me/Workstreams/cafe-ideas-2");
  });

  it("doesn't ask for the home folder when the root is absolute, and refuses a relative one", async () => {
    const homeDir = vi.fn(async () => "/Users/me");
    await expect(createStandaloneFolder({ root: "/data/ws", name: "x", homeDir, createDirectory: async () => {} }))
      .resolves.toBe("/data/ws/x");
    expect(homeDir).not.toHaveBeenCalled();
    await expect(createStandaloneFolder({ root: "ws", name: "x", homeDir, createDirectory: async () => {} }))
      .rejects.toThrow(/absolute path/);
  });
});

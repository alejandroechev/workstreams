import { describe, it, expect, vi } from "vitest";
import { expandHome, createUniqueFolder } from "../folders";

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

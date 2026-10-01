import { describe, it, expect } from "vitest";
import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend diff reading orders", () => {
  it("has no order until one is seeded, and keys orders by workstream, mode and target", async () => {
    const backend = new MemoryBackend();
    expect(await backend.getDiffOrder("w", "/repo", "unstaged")).toBeNull();
    backend.seedDiffOrder("w", "unstaged", null, { paths: ["b", "a"], freshness: "current" });
    backend.seedDiffOrder("w", "custom_branch", "main", { paths: ["x"], freshness: "files_changed" });
    expect(await backend.getDiffOrder("w", "/repo", "unstaged")).toEqual({ paths: ["b", "a"], freshness: "current" });
    expect(await backend.getDiffOrder("w", "/repo", "custom_branch", "main")).toEqual({ paths: ["x"], freshness: "files_changed" });
    expect(await backend.getDiffOrder("w", "/repo", "custom_branch", "other")).toBeNull();
    expect(await backend.getDiffOrder("other", "/repo", "unstaged")).toBeNull();
  });

  it("returns a copy, so a caller cannot edit the stored order", async () => {
    const backend = new MemoryBackend();
    backend.seedDiffOrder("w", "unstaged", null, { paths: ["a"], freshness: "current" });
    const first = await backend.getDiffOrder("w", "/repo", "unstaged");
    first!.paths.push("mutated");
    expect((await backend.getDiffOrder("w", "/repo", "unstaged"))!.paths).toEqual(["a"]);
  });

  it("clears a seeded order", async () => {
    const backend = new MemoryBackend();
    backend.seedDiffOrder("w", "unstaged", null, { paths: ["a"], freshness: "current" });
    backend.seedDiffOrder("w", "unstaged", null, null);
    expect(await backend.getDiffOrder("w", "/repo", "unstaged")).toBeNull();
  });
});

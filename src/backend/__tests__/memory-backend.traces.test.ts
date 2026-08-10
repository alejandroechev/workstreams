import { describe, it, expect, beforeEach } from "vitest";

import { MemoryBackend } from "../memory-backend";

describe("MemoryBackend — code traces", () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  it("starts with no traces", async () => {
    expect(await backend.listCodeTraces()).toEqual([]);
  });

  it("indexes a seeded trace file and lists it", async () => {
    // The in-memory backend must work with no debugger and no real files, so
    // E2E and offline development need neither (AGENTS.md in-memory-stub rule).
    backend._seedTraceFile("/traces/a.json", {
      version: 1,
      test: "pty::tests::resolves_shell",
      repoRoot: "/repo",
      commitSha: "abc1234",
      recordedAt: "2026-08-10T00:00:00.000Z",
      truncated: false,
      steps: [
        { file: "src/pty.rs", line: 1, function: "f" },
        { file: "src/pty.rs", line: 2, function: "f" },
      ],
    });

    const indexed = await backend.indexCodeTrace("/traces/a.json", "ws-1");
    expect(indexed.test_name).toBe("pty::tests::resolves_shell");
    expect(indexed.step_count).toBe(2);
    expect(indexed.commit_sha).toBe("abc1234");

    const all = await backend.listCodeTraces();
    expect(all).toHaveLength(1);
  });

  it("rejects indexing a file that was never written", async () => {
    await expect(backend.indexCodeTrace("/traces/missing.json")).rejects.toThrow(/cannot read/i);
  });

  it("rejects a trace whose version this build does not support", async () => {
    backend._seedTraceFile("/traces/future.json", { version: 99, test: "a", steps: [] });
    await expect(backend.indexCodeTrace("/traces/future.json")).rejects.toThrow(/version/i);
  });

  it("scopes the list to a workstream when asked", async () => {
    backend._seedTraceFile("/a.json", baseTrace("a::a"));
    backend._seedTraceFile("/b.json", baseTrace("b::b"));
    await backend.indexCodeTrace("/a.json", "ws-1");
    await backend.indexCodeTrace("/b.json", "ws-2");

    const scoped = await backend.listCodeTraces("ws-2");
    expect(scoped.map((t) => t.test_name)).toEqual(["b::b"]);
  });

  it("returns traces newest first", async () => {
    backend._seedTraceFile("/old.json", { ...baseTrace("old"), recordedAt: "2026-01-01T00:00:00.000Z" });
    backend._seedTraceFile("/new.json", { ...baseTrace("new"), recordedAt: "2026-08-01T00:00:00.000Z" });
    await backend.indexCodeTrace("/old.json");
    await backend.indexCodeTrace("/new.json");

    expect((await backend.listCodeTraces()).map((t) => t.test_name)).toEqual(["new", "old"]);
  });

  it("replaces the row when the same path is re-recorded", async () => {
    backend._seedTraceFile("/a.json", baseTrace("a::a"));
    await backend.indexCodeTrace("/a.json");
    backend._seedTraceFile("/a.json", { ...baseTrace("a::a"), steps: [{ file: "x.rs", line: 9, function: "f" }] });
    await backend.indexCodeTrace("/a.json");

    const all = await backend.listCodeTraces();
    expect(all).toHaveLength(1);
    expect(all[0].step_count).toBe(1);
  });

  it("gets a trace by id and returns null for an unknown one", async () => {
    backend._seedTraceFile("/a.json", baseTrace("a::a"));
    const indexed = await backend.indexCodeTrace("/a.json");
    expect((await backend.getCodeTrace(indexed.id))?.test_name).toBe("a::a");
    expect(await backend.getCodeTrace("nope")).toBeNull();
  });

  it("deletes a trace, and deleting an unknown id is not an error", async () => {
    backend._seedTraceFile("/a.json", baseTrace("a::a"));
    const indexed = await backend.indexCodeTrace("/a.json");
    await backend.deleteCodeTrace(indexed.id);
    expect(await backend.listCodeTraces()).toEqual([]);
    await expect(backend.deleteCodeTrace("ghost")).resolves.toBeUndefined();
  });

  it("preserves the truncated flag", async () => {
    // A capped trace must never be presented as a complete one.
    backend._seedTraceFile("/t.json", { ...baseTrace("t"), truncated: true });
    const indexed = await backend.indexCodeTrace("/t.json");
    expect(indexed.truncated).toBe(true);
  });

  it("reads back the seeded trace file contents", async () => {
    // Replay needs the steps, not just the index row.
    backend._seedTraceFile("/a.json", baseTrace("a::a"));
    const file = await backend.readCodeTraceFile("/a.json");
    expect(file.steps).toHaveLength(1);
    expect(file.test).toBe("a::a");
  });
});

function baseTrace(test: string) {
  return {
    version: 1,
    test,
    repoRoot: "/repo",
    commitSha: "abc1234",
    recordedAt: "2026-08-10T00:00:00.000Z",
    truncated: false,
    steps: [{ file: "src/a.rs", line: 1, function: "f" }],
  };
}

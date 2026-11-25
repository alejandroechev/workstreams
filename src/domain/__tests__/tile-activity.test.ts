import { describe, expect, it } from "vitest";
import { bumpTileGeneration, forgetTileActivity, isTileBusy, setTileActivity, tileChangedRecently, tileGeneration } from "../tile-activity";

describe("tile activity registry", () => {
  it("is busy only while the agent is mid-turn", () => {
    expect(isTileBusy("t")).toBe(false);
    // A sub-agent running in the background is still inside the parent's turn.
    for (const status of ["thinking", "tool_use", "responding", "background_task"] as const) {
      setTileActivity("t", status);
      expect(isTileBusy("t")).toBe(true);
    }
    for (const status of ["idle", "offline", undefined] as const) {
      setTileActivity("t", status);
      expect(isTileBusy("t")).toBe(false);
    }
  });

  it("forgets a tile", () => {
    setTileActivity("u", "thinking");
    forgetTileActivity("u");
    expect(isTileBusy("u")).toBe(false);
  });
});

describe("tile process generations (finding 5)", () => {
  it("counts each process change, and keeps it after the tile forgets its activity", () => {
    const before = tileGeneration("g");
    bumpTileGeneration("g");
    bumpTileGeneration("g");
    forgetTileActivity("g");
    expect(tileGeneration("g")).toBe(before + 2);
    expect(tileGeneration("never")).toBe(0);
  });

  it("the backends bump a tile's generation on every spawn and close", async () => {
    const { MemoryBackend } = await import("../../backend/memory-backend");
    const backend = new MemoryBackend();
    const start = tileGeneration("p");
    await backend.spawnCopilotSession("p", "/", null);
    await backend.closeTerminal("p");
    expect(tileGeneration("p")).toBe(start + 2);
  });
});

describe("a tile's process changed moments ago", () => {
  it("counts as recent for two minutes after a start or stop", () => {
    expect(tileChangedRecently("fresh-tile", 1_000)).toBe(false);
    bumpTileGeneration("fresh-tile", 1_000);
    expect(tileChangedRecently("fresh-tile", 1_000 + 119_000)).toBe(true);
    expect(tileChangedRecently("fresh-tile", 1_000 + 121_000)).toBe(false);
  });
});

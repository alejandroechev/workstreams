import { describe, expect, it } from "vitest";
import { forgetTileActivity, isTileBusy, setTileActivity } from "../tile-activity";

describe("tile activity registry", () => {
  it("is busy only while the agent is mid-turn", () => {
    expect(isTileBusy("t")).toBe(false);
    for (const status of ["thinking", "tool_use", "responding"] as const) {
      setTileActivity("t", status);
      expect(isTileBusy("t")).toBe(true);
    }
    for (const status of ["idle", "offline", "background_task", undefined] as const) {
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

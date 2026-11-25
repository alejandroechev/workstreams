import { describe, it, expect } from "vitest";
import { digestCounts, digestStateLabel, isDigestTime, lastSlot, localDay, stepLabel } from "../pipeline-digest";

describe("pipeline digest", () => {
  it("names local days as YYYY-MM-DD", () => {
    expect(localDay(new Date(2026, 2, 1, 23, 59))).toBe("2026-03-01");
    expect(localDay(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });

  it("finds the latest digest time at or before now, in local time", () => {
    expect(lastSlot(new Date(2026, 2, 2, 8, 59), "09:00")).toEqual(new Date(2026, 2, 1, 9, 0));
    expect(lastSlot(new Date(2026, 2, 2, 9, 0), "09:00")).toEqual(new Date(2026, 2, 2, 9, 0));
    expect(lastSlot(new Date(2026, 2, 2, 23, 0), "17:30")).toEqual(new Date(2026, 2, 2, 17, 30));
    expect(isDigestTime("17:30")).toBe(true);
    expect(isDigestTime("24:00")).toBe(false);
    expect(isDigestTime("9:00")).toBe(false);
  });

  it("words counts, states and steps the way the Inbox shows them", () => {
    expect(digestCounts({ failed: 5, total: 12 })).toBe("5 of 12 failed");
    expect([digestStateLabel("still_failing"), digestStateLabel("passed_since")]).toEqual(["Still failing", "Passed since"]);
    expect([
      stepLabel({ step: "Run tests", step_state: "fetched" }),
      stepLabel({ step: null, step_state: "not_fetched" }),
      stepLabel({ step: null, step_state: "pending" }),
      stepLabel({ step: null, step_state: "fetched" }),
    ]).toEqual(["Run tests", "step not fetched", "step not known yet", "no failing step reported"]);
  });
});

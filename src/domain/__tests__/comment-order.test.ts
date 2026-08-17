import { describe, it, expect } from "vitest";
import { commentTimeValue, compareByCreatedAt } from "../comment-order";

describe("commentTimeValue", () => {
  it("parses ISO-8601 timestamps written by agents and importers", () => {
    expect(commentTimeValue("2026-08-17T14:48:29Z")).toBe(Date.parse("2026-08-17T14:48:29Z"));
  });

  it("parses legacy epoch-second timestamps written by the tile", () => {
    expect(commentTimeValue("1787000000")).toBe(1787000000 * 1000);
  });

  it("sorts unparseable timestamps last rather than throwing", () => {
    expect(commentTimeValue("not-a-date")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("compareByCreatedAt", () => {
  it("orders a mixed-format pair chronologically, not lexicographically", () => {
    const agent = { created_at: "2026-08-17T10:00:00Z" };
    const tile = { created_at: String(Math.floor(Date.parse("2026-08-17T11:00:00Z") / 1000)) };

    expect(compareByCreatedAt(agent, tile)).toBeLessThan(0);
    expect([tile, agent].sort(compareByCreatedAt)).toEqual([agent, tile]);
  });

  it("keeps ordering stable for two same-format timestamps", () => {
    expect(compareByCreatedAt({ created_at: "100" }, { created_at: "200" })).toBeLessThan(0);
    expect(
      compareByCreatedAt({ created_at: "2026-01-02T00:00:00Z" }, { created_at: "2026-01-01T00:00:00Z" }),
    ).toBeGreaterThan(0);
  });
});

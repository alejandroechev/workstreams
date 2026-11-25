import { describe, it, expect } from "vitest";
import { localDay } from "../pipeline-digest";

describe("pipeline digest", () => {
  it("names local days as YYYY-MM-DD", () => {
    expect(localDay(new Date(2026, 2, 1, 23, 59))).toBe("2026-03-01");
    expect(localDay(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

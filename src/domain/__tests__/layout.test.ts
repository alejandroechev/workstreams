import { describe, it, expect } from "vitest";
import { computeLayout, computeSideBySideLayout, navigateFocus } from "../layout";

describe("computeLayout", () => {
  it("returns empty grid for 0 tiles", () => {
    const result = computeLayout(0);
    expect(result.columns).toBe("1fr");
    expect(result.rows).toBe("1fr");
    expect(result.areas).toBe('"empty"');
  });

  it("returns empty grid for negative tile count", () => {
    const result = computeLayout(-1);
    expect(result.areas).toBe('"empty"');
  });

  it("returns single tile layout for 1 tile", () => {
    const result = computeLayout(1);
    expect(result.columns).toBe("1fr");
    expect(result.rows).toBe("1fr");
    expect(result.areas).toBe('"t0"');
  });

  it("returns side-by-side layout for 2 tiles", () => {
    const result = computeLayout(2);
    expect(result.columns).toBe("1fr 1fr");
    expect(result.rows).toBe("1fr");
    expect(result.areas).toBe('"t0 t1"');
  });

  it("returns 50/50 split for 3 tiles (left spans 2 rows)", () => {
    const result = computeLayout(3);
    expect(result.columns).toBe("1fr 1fr");
    expect(result.rows).toBe("1fr 1fr");
    expect(result.areas).toBe('"t0 t1" "t0 t2"');
  });

  it("returns 2x2 grid for 4 tiles, preserving 3-tile positions", () => {
    const result = computeLayout(4);
    expect(result.columns).toBe("1fr 1fr");
    expect(result.rows).toBe("1fr 1fr");
    // t1 stays top-right, t2 stays bottom-right, t3 (new) fills bottom-left.
    expect(result.areas).toBe('"t0 t1" "t3 t2"');
  });

  it("returns 2-column layout for 5 tiles", () => {
    const result = computeLayout(5);
    expect(result.columns).toBe("1fr 1fr");
    expect(result.areas).toContain("t4");
  });

  it("returns 2-column layout for 8 tiles", () => {
    const result = computeLayout(8);
    expect(result.columns).toBe("1fr 1fr");
    expect(result.areas).toContain("t7");
  });
});

describe("computeSideBySideLayout", () => {
  it("returns a 50/50 two-column grid with named slots", () => {
    const result = computeSideBySideLayout();
    expect(result.columns).toBe("1fr 1fr");
    expect(result.rows).toBe("1fr");
    expect(result.areas).toBe('"sbs-left sbs-right"');
  });
});

describe("navigateFocus", () => {
  it("returns 0 for single tile regardless of direction", () => {
    expect(navigateFocus("left", 0, 1)).toBe(0);
    expect(navigateFocus("right", 0, 1)).toBe(0);
    expect(navigateFocus("up", 0, 1)).toBe(0);
    expect(navigateFocus("down", 0, 1)).toBe(0);
  });

  it("returns 0 for zero tiles", () => {
    expect(navigateFocus("right", 0, 0)).toBe(0);
  });

  it("moves right/down forward", () => {
    expect(navigateFocus("right", 0, 4)).toBe(1);
    expect(navigateFocus("down", 1, 4)).toBe(2);
  });

  it("moves left/up backward", () => {
    expect(navigateFocus("left", 2, 4)).toBe(1);
    expect(navigateFocus("up", 1, 4)).toBe(0);
  });

  it("wraps right→beginning", () => {
    expect(navigateFocus("right", 3, 4)).toBe(0);
  });

  it("wraps left→end", () => {
    expect(navigateFocus("left", 0, 4)).toBe(3);
  });

  it("wraps down→beginning", () => {
    expect(navigateFocus("down", 4, 5)).toBe(0);
  });

  it("wraps up→end", () => {
    expect(navigateFocus("up", 0, 5)).toBe(4);
  });
});

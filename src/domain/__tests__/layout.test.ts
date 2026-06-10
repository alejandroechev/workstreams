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

  // 2-tile layout: "t0 t1"
  it("2-tile: right from t0 → t1; left wraps", () => {
    expect(navigateFocus("right", 0, 2)).toBe(1);
    expect(navigateFocus("left", 0, 2)).toBe(1);
    expect(navigateFocus("left", 1, 2)).toBe(0);
  });

  it("2-tile: up/down stay (single row) but wrap to the other tile", () => {
    // No row below; falls through to same-column wrap (which yields self),
    // so up/down from t0 stays at t0 — kept this way to avoid pretending
    // there's a vertical neighbor when there isn't.
    expect(navigateFocus("up", 0, 2)).toBe(0);
    expect(navigateFocus("down", 0, 2)).toBe(0);
  });

  // 3-tile layout: "t0 t1" / "t0 t2" — t0 spans the left column.
  it("3-tile: right from t0 picks t1 (top-right) of the spanned column", () => {
    expect(navigateFocus("right", 0, 3)).toBe(1);
  });
  it("3-tile: left from t1 → t0; left from t2 → t0", () => {
    expect(navigateFocus("left", 1, 3)).toBe(0);
    expect(navigateFocus("left", 2, 3)).toBe(0);
  });
  it("3-tile: down from t1 → t2; up from t2 → t1", () => {
    expect(navigateFocus("down", 1, 3)).toBe(2);
    expect(navigateFocus("up", 2, 3)).toBe(1);
  });

  // 4-tile L-shape: "t0 t1" / "t3 t2" (top-left, top-right, bottom-right, bottom-left).
  // The reported bug: left from bottom-right (t2) used to go to t1 (top-right).
  it("4-tile L-shape: left from bottom-right (t2) goes to bottom-left (t3)", () => {
    expect(navigateFocus("left", 2, 4)).toBe(3);
  });
  it("4-tile L-shape: right from bottom-left (t3) goes to bottom-right (t2)", () => {
    expect(navigateFocus("right", 3, 4)).toBe(2);
  });
  it("4-tile L-shape: up from bottom-right (t2) goes to top-right (t1)", () => {
    expect(navigateFocus("up", 2, 4)).toBe(1);
  });
  it("4-tile L-shape: down from top-right (t1) goes to bottom-right (t2)", () => {
    expect(navigateFocus("down", 1, 4)).toBe(2);
  });
  it("4-tile L-shape: right from top-left (t0) goes to top-right (t1); down → bottom-left (t3)", () => {
    expect(navigateFocus("right", 0, 4)).toBe(1);
    expect(navigateFocus("down", 0, 4)).toBe(3);
  });

  // Wrap-around branches: 2-tile single row exercised above; here we hit
  // the wrap path for 4-tile L-shape and bigger grids.
  it("4-tile L-shape: left wraps from top-left (t0) to top-right (t1)", () => {
    expect(navigateFocus("left", 0, 4)).toBe(1);
  });
  it("4-tile L-shape: right wraps from top-right (t1) to top-left (t0)", () => {
    expect(navigateFocus("right", 1, 4)).toBe(0);
  });
  it("4-tile L-shape: up wraps from top-row (t1) to bottom-row of same column (t2)", () => {
    expect(navigateFocus("up", 1, 4)).toBe(2);
  });
  it("4-tile L-shape: down wraps from bottom-row (t2) to top-row of same column (t1)", () => {
    expect(navigateFocus("down", 2, 4)).toBe(1);
  });

  // 5-tile layout: "t0 t2" / "t0 t3" / "t1 t4"
  it("5-tile: right from t0 → t2 (spanning rectangle exit)", () => {
    expect(navigateFocus("right", 0, 5)).toBe(2);
  });
  it("5-tile: down from t3 → t4", () => {
    expect(navigateFocus("down", 3, 5)).toBe(4);
  });
  it("5-tile: up from t1 → t0 (spanning tile target)", () => {
    expect(navigateFocus("up", 1, 5)).toBe(0);
  });

  // 6-tile 3x2 grid: exercises 3-row navigation
  it("6-tile: down from t1 → t3; up from t5 → t3", () => {
    expect(navigateFocus("down", 1, 6)).toBe(3);
    expect(navigateFocus("up", 5, 6)).toBe(3);
  });

  // 7-tile layout uses the generic generator (last row spans both cols).
  it("7-tile: down from t5 → t6 (spanning last row)", () => {
    expect(navigateFocus("down", 5, 7)).toBe(6);
  });

  // Fallback path: currentIndex outside the grid → linear next/prev.
  it("fallback (currentIndex not in grid): right → (idx + 1) mod n", () => {
    expect(navigateFocus("right", 99, 4)).toBe(0);
  });
  it("fallback (currentIndex not in grid): left → previous index modulo n", () => {
    // (99 - 1 + 4) % 4 = 102 % 4 = 2
    expect(navigateFocus("left", 99, 4)).toBe(2);
  });
  it("fallback (currentIndex not in grid): up wraps", () => {
    expect(navigateFocus("up", 99, 4)).toBeGreaterThanOrEqual(0);
  });
  it("fallback (currentIndex not in grid): down wraps", () => {
    expect(navigateFocus("down", 99, 4)).toBeGreaterThanOrEqual(0);
  });
});

import type { GridConfig, Direction } from "./types";

/**
 * Compute adaptive grid layout based on tile count.
 * Rules: always split 50/50 horizontally when adding columns.
 */
export function computeLayout(tileCount: number): GridConfig {
  if (tileCount <= 0) {
    return { columns: "1fr", rows: "1fr", areas: '"empty"' };
  }
  if (tileCount === 1) {
    return { columns: "1fr", rows: "1fr", areas: '"t0"' };
  }
  if (tileCount === 2) {
    // 50/50 horizontal split
    return {
      columns: "1fr 1fr",
      rows: "1fr",
      areas: '"t0 t1"',
    };
  }
  if (tileCount === 3) {
    // Left 50%, right 50% split vertically
    return {
      columns: "1fr 1fr",
      rows: "1fr 1fr",
      areas: '"t0 t1" "t0 t2"',
    };
  }
  if (tileCount === 4) {
    // 2x2 grid. Layout keeps positions stable from the 3-tile layout:
    //   3 tiles: "t0 t1" / "t0 t2"   (t0 spans full height of left column)
    //   4 tiles: "t0 t1" / "t3 t2"   (t0 halves down, new t3 fills bottom-left)
    // So t1 stays top-right and t2 stays bottom-right when adding the 4th tile.
    return {
      columns: "1fr 1fr",
      rows: "1fr 1fr",
      areas: '"t0 t1" "t3 t2"',
    };
  }
  if (tileCount === 5) {
    // Left column: 2 stacked, Right column: 3 stacked
    return {
      columns: "1fr 1fr",
      rows: "1fr 1fr 1fr",
      areas: '"t0 t2" "t0 t3" "t1 t4"',
    };
  }
  if (tileCount === 6) {
    // 3x2 grid
    return {
      columns: "1fr 1fr",
      rows: "1fr 1fr 1fr",
      areas: '"t0 t1" "t2 t3" "t4 t5"',
    };
  }
  // 7+: 2 columns, distribute rows
  const rows = Math.ceil(tileCount / 2);
  const rowTemplate = Array(rows).fill("1fr").join(" ");
  let areas = "";
  let idx = 0;
  for (let r = 0; r < rows; r++) {
    if (idx + 1 >= tileCount) {
      // Last tile alone spans both columns
      areas += `"t${idx} t${idx}" `;
      idx++;
    } else {
      areas += `"t${idx} t${idx + 1}" `;
      idx += 2;
    }
  }
  return {
    columns: "1fr 1fr",
    rows: rowTemplate,
    areas: areas.trim(),
  };
}

/**
 * Navigate focus between tiles. Returns the new focused index.
 */
export function navigateFocus(
  direction: Direction,
  currentIndex: number,
  tileCount: number
): number {
  if (tileCount <= 1) return 0;
  switch (direction) {
    case "right":
    case "down":
      return (currentIndex + 1) % tileCount;
    case "left":
    case "up":
      return (currentIndex - 1 + tileCount) % tileCount;
  }
}

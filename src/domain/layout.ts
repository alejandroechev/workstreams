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
 * Side-by-side layout: exactly two visible cells split 50/50 horizontally.
 * Cell areas are named `sbs-left` and `sbs-right` so it's obvious the
 * grid is a different mode from the adaptive one (which uses t0..tN).
 */
export function computeSideBySideLayout(): GridConfig {
  return {
    columns: "1fr 1fr",
    rows: "1fr",
    areas: '"sbs-left sbs-right"',
  };
}

/**
 * Parse a CSS `grid-template-areas` string into a 2-D matrix of tile
 * indices. Each cell holds the integer N from `tN`, or null for empty
 * slots (e.g. the `sbs-*` side-by-side layout, which navigateFocus
 * doesn't try to handle). Cells may repeat when a tile spans multiple
 * rows / columns (e.g. the 3-tile layout where t0 spans both rows of
 * the left column).
 */
function parseAreasGrid(areas: string): Array<Array<number | null>> {
  // areas looks like: '"t0 t1" "t3 t2"' — split on " " between quoted rows.
  const rows = areas.match(/"([^"]+)"/g);
  if (!rows) return [];
  return rows.map((quoted) => {
    const cells = quoted.replace(/"/g, "").trim().split(/\s+/);
    return cells.map((c) => {
      const m = /^t(\d+)$/.exec(c);
      return m ? Number(m[1]) : null;
    });
  });
}

/**
 * Locate a tile index inside the parsed grid. For a spanning tile this
 * returns the top-left cell of its rectangle, which is enough for the
 * arrow-key step logic.
 */
function findTilePosition(
  grid: Array<Array<number | null>>,
  tileIndex: number,
): { row: number; col: number } | null {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === tileIndex) return { row: r, col: c };
    }
  }
  return null;
}

/**
 * Navigate focus between tiles spatially based on the current grid
 * layout. Arrow keys map to geometric directions: left → tile in the
 * cell to the left (or wrap to the same row's rightmost cell), etc.
 * Spanning tiles are treated as the rectangle they cover; stepping out
 * of the rectangle uses the row/col adjacent to that rectangle edge.
 *
 * When the layout can't be parsed (e.g. side-by-side), we fall back to
 * the linear next/prev semantics.
 */
export function navigateFocus(
  direction: Direction,
  currentIndex: number,
  tileCount: number,
): number {
  if (tileCount <= 1) return 0;
  const grid = parseAreasGrid(computeLayout(tileCount).areas);
  const pos = findTilePosition(grid, currentIndex);
  if (!pos || grid.length === 0) {
    // Layout doesn't expose a parseable grid (shouldn't happen for the
    // adaptive layouts — kept as a safety net so the shortcut never
    // becomes a no-op).
    switch (direction) {
      case "right":
      case "down":
        return (currentIndex + 1) % tileCount;
      case "left":
      case "up":
        return (currentIndex - 1 + tileCount) % tileCount;
    }
  }

  const rowsCount = grid.length;
  const colsCount = grid[0].length;

  // The current tile may span multiple cells; compute its rectangle so
  // a vertical step out the top/bottom uses the row above/below the
  // span, not the row after the top-left cell.
  let minRow = rowsCount;
  let maxRow = -1;
  let minCol = colsCount;
  let maxCol = -1;
  for (let r = 0; r < rowsCount; r++) {
    for (let c = 0; c < colsCount; c++) {
      if (grid[r][c] === currentIndex) {
        if (r < minRow) minRow = r;
        if (r > maxRow) maxRow = r;
        if (c < minCol) minCol = c;
        if (c > maxCol) maxCol = c;
      }
    }
  }

  function cell(r: number, c: number): number | null {
    if (r < 0 || r >= rowsCount || c < 0 || c >= colsCount) return null;
    return grid[r][c];
  }

  switch (direction) {
    case "left": {
      // Step out the left edge of the current rect, scanning rows
      // covered by the rect for the nearest non-self cell.
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol - 1; c >= 0; c--) {
          const v = cell(r, c);
          if (v !== null && v !== currentIndex) return v;
        }
      }
      // Wrap to the rightmost column in the same row.
      for (let c = colsCount - 1; c >= 0; c--) {
        const v = cell(pos.row, c);
        if (v !== null && v !== currentIndex) return v;
      }
      return currentIndex;
    }
    case "right": {
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = maxCol + 1; c < colsCount; c++) {
          const v = cell(r, c);
          if (v !== null && v !== currentIndex) return v;
        }
      }
      for (let c = 0; c < colsCount; c++) {
        const v = cell(pos.row, c);
        if (v !== null && v !== currentIndex) return v;
      }
      return currentIndex;
    }
    case "up": {
      for (let c = minCol; c <= maxCol; c++) {
        for (let r = minRow - 1; r >= 0; r--) {
          const v = cell(r, c);
          if (v !== null && v !== currentIndex) return v;
        }
      }
      for (let r = rowsCount - 1; r >= 0; r--) {
        const v = cell(r, pos.col);
        if (v !== null && v !== currentIndex) return v;
      }
      return currentIndex;
    }
    case "down": {
      for (let c = minCol; c <= maxCol; c++) {
        for (let r = maxRow + 1; r < rowsCount; r++) {
          const v = cell(r, c);
          if (v !== null && v !== currentIndex) return v;
        }
      }
      for (let r = 0; r < rowsCount; r++) {
        const v = cell(r, pos.col);
        if (v !== null && v !== currentIndex) return v;
      }
      return currentIndex;
    }
  }
}

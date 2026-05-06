import type { GridConfig, Direction } from "./types";

/**
 * Compute adaptive grid layout based on tile count.
 * Returns CSS grid properties for the container.
 */
export function computeLayout(tileCount: number): GridConfig {
  if (tileCount <= 0) {
    return { columns: "1fr", rows: "1fr", areas: '"empty"' };
  }
  if (tileCount === 1) {
    return { columns: "1fr", rows: "1fr", areas: '"t0"' };
  }
  if (tileCount === 2) {
    return {
      columns: "1fr 1fr",
      rows: "1fr",
      areas: '"t0 t1"',
    };
  }
  if (tileCount === 3) {
    return {
      columns: "3fr 2fr",
      rows: "1fr 1fr",
      areas: '"t0 t1" "t0 t2"',
    };
  }
  if (tileCount === 4) {
    return {
      columns: "1fr 1fr",
      rows: "1fr 1fr",
      areas: '"t0 t1" "t2 t3"',
    };
  }
  // 5+: focused tile large on left, rest stacked on right
  const rightCount = tileCount - 1;
  const rightRows = Math.ceil(rightCount / 2);
  const rowTemplate = Array(rightRows).fill("1fr").join(" ");
  let areas = "";
  let idx = 1;
  for (let r = 0; r < rightRows; r++) {
    const cols = r === rightRows - 1 && rightCount % 2 !== 0 ? 1 : 2;
    if (cols === 1) {
      areas += `"t0 t${idx} t${idx}" `;
      idx++;
    } else {
      areas += `"t0 t${idx} t${idx + 1}" `;
      idx += 2;
    }
  }
  return {
    columns: "2fr 1fr 1fr",
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

import type { Tile, TileType } from "./types";

const RESTARTABLE_TILE_TYPES = new Set<TileType>(["terminal", "copilot_session"]);

export function rewriteTileCwd(configJson: string, newCwd: string, tileType: TileType): string {
  let config: unknown;
  try {
    config = JSON.parse(configJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid tile config JSON: ${message}`);
  }

  if (!RESTARTABLE_TILE_TYPES.has(tileType)) {
    return configJson;
  }

  const updated = isJsonObject(config) ? { ...config, cwd: newCwd } : { cwd: newCwd };
  return JSON.stringify(updated);
}

export function summarizeTilesToRestart(tiles: Tile[]): { count: number; labels: string[] } {
  const labels = tiles
    .filter((tile) => RESTARTABLE_TILE_TYPES.has(tile.tile_type))
    .map((tile) => tile.title?.trim() || tile.tile_type);

  return { count: labels.length, labels };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

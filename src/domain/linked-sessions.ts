import type { Tile } from "./types";

/**
 * Derive the set of linked Copilot session ids from a workstream's tiles.
 *
 * A `copilot_session` tile is "linked" when its config carries a
 * `copilot_session_id` (or legacy `resume_by_id`). Returns the ids in tile
 * order, skipping unlinked tiles and malformed config.
 *
 * Pure + extension-free so it can be reused per-workstream (every mounted
 * workstream needs its *own* linked-session list — sharing the active
 * workstream's list across all mounted tiles wipes hidden tiles' state).
 */
export function deriveLinkedSessionIds(tiles: Tile[]): string[] {
  return tiles
    .filter((t) => t.tile_type === "copilot_session")
    .map((t) => linkedSessionId(t.config_json))
    .filter((id): id is string => !!id);
}

/** The Copilot session a tile's config links it to, or `null`. */
export function linkedSessionId(configJson: string | undefined): string | null {
  try {
    const cfg = JSON.parse(configJson || "{}");
    const id = cfg.copilot_session_id || cfg.resume_by_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

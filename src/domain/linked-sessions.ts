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
    .map((t) => {
      try {
        const cfg = JSON.parse(t.config_json || "{}");
        return (cfg.copilot_session_id || cfg.resume_by_id || null) as string | null;
      } catch {
        return null;
      }
    })
    .filter((id): id is string => !!id);
}

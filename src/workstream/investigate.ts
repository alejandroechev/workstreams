import type { Backend } from "../backend/types";
import type { Tile } from "../domain/types";
import { createCopilotSessionConfig } from "../domain/tile-config";

export interface InvestigationDeps {
  backend: Pick<Backend, "pendingInvestigationSessions" | "markInvestigationSessionStarted" | "listTiles" | "createTile" | "listWorkstreams">;
  /** Mounts a workstream in the background (never changes the active one). */
  mount(workstreamId: string): Promise<void>;
  onTileCreated(tile: Tile): void;
  markSpawned(tileId: string): void;
  unmarkSpawned(tileId: string): void;
  commandFor(workstreamId: string): string;
  spawn(tileId: string, cwd: string, command: string, prompt: string): Promise<void>;
  /** Investigations being started now, so overlapping calls don't start one twice. */
  inFlight: Set<string>;
}

/**
 * Starts the Copilot session of every investigation that doesn't have one yet
 * (ADR 038 amendment): in its workstream, in the background, on its prompt.
 * One that fails to start stays pending and is tried again next time.
 */
export async function startPendingInvestigations(deps: InvestigationDeps): Promise<void> {
  const { backend } = deps;
  const pending = await backend.pendingInvestigationSessions();
  for (const session of pending) {
    if (deps.inFlight.has(session.event_id)) continue;
    deps.inFlight.add(session.event_id);
    let tileId: string | null = null;
    try {
      await deps.mount(session.workstream_id);
      const tiles = await backend.listTiles(session.workstream_id);
      const name = (await backend.listWorkstreams()).find((w) => w.id === session.workstream_id)?.name ?? "Investigation";
      // A tile left by an earlier attempt that never started is reused.
      const tile = tiles.find((t) => t.tile_type === "copilot_session")
        ?? await backend.createTile(session.workstream_id, "copilot_session", name, createCopilotSessionConfig(name, session.directory));
      tileId = tile.id;
      deps.onTileCreated(tile);
      deps.markSpawned(tile.id);
      await deps.spawn(tile.id, session.directory, deps.commandFor(session.workstream_id), session.prompt);
      await backend.markInvestigationSessionStarted(session.event_id);
    } catch (error) {
      if (tileId) deps.unmarkSpawned(tileId);
      console.error("[investigate] Could not start the investigation session:", error);
    } finally {
      deps.inFlight.delete(session.event_id);
    }
  }
}

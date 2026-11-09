import type { Backend } from "../backend/types";
import type { Tile } from "../domain/types";
import { createCopilotSessionConfig, parseCopilotSessionConfig } from "../domain/tile-config";

export interface InvestigationDeps {
  backend: Pick<Backend, "pendingInvestigationSessions" | "markInvestigationSessionStarted" | "listTiles" | "createTile" | "listWorkstreams">;
  /** Mounts a workstream in the background (never changes the active one). */
  mount(workstreamId: string): Promise<void>;
  onTileCreated(tile: Tile): void;
  isSpawned(tileId: string): boolean;
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
    let spawned = false;
    try {
      // The snapshot may be stale: another run may have started it meanwhile.
      const still = await backend.pendingInvestigationSessions();
      if (!still.some((p) => p.event_id === session.event_id)) continue;
      // A tile left by an earlier attempt that never started is reused.
      const left = (await backend.listTiles(session.workstream_id)).find((t) => t.tile_type === "copilot_session");
      // Already running, or linked to a session from before a restart (which
      // the mount resumes): it started, only the record of it was lost.
      if (left && (deps.isSpawned(left.id) || parseCopilotSessionConfig(left.config_json).copilot_session_id)) {
        await backend.markInvestigationSessionStarted(session.event_id);
        continue;
      }
      // Claimed before mounting, so the mount doesn't start it without its prompt.
      if (left) { tileId = left.id; deps.markSpawned(left.id); }
      await deps.mount(session.workstream_id);
      const name = (await backend.listWorkstreams()).find((w) => w.id === session.workstream_id)?.name ?? "Investigation";
      const tile = left
        ?? await backend.createTile(session.workstream_id, "copilot_session", name, createCopilotSessionConfig(name, session.directory));
      tileId = tile.id;
      deps.onTileCreated(tile);
      deps.markSpawned(tile.id);
      await deps.spawn(tile.id, session.directory, deps.commandFor(session.workstream_id), session.prompt);
      spawned = true;
      await backend.markInvestigationSessionStarted(session.event_id);
    } catch (error) {
      // Once running, the tile stays marked: the next pass only records that it started.
      if (tileId && !spawned) deps.unmarkSpawned(tileId);
      console.error("[investigate] Could not start the investigation session:", error);
    } finally {
      deps.inFlight.delete(session.event_id);
    }
  }
}

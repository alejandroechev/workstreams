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
        // Marked as an investigation: every start of it is launched read-only (ADR 045).
        ?? await backend.createTile(session.workstream_id, "copilot_session", name,
          JSON.stringify({ ...JSON.parse(createCopilotSessionConfig(name, session.directory)), investigation: true }));
      tileId = tile.id;
      deps.onTileCreated(tile);
      deps.markSpawned(tile.id);
      // Rechecked right before the spawn: an auto-start dropped meanwhile (the Inbox was muted) doesn't start (ADR 045).
      if (!(await backend.pendingInvestigationSessions()).some((p) => p.event_id === session.event_id)) {
        deps.unmarkSpawned(tile.id);
        continue;
      }
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

export interface FollowUpDeps {
  backend: Pick<Backend, "pendingInvestigationFollowups" | "markInvestigationSessionStarted" | "listTiles">;
  /** The tile's agent is mid-turn, as the session poller last said. */
  isBusy(tileId: string): boolean;
  /** The session's log has a turn that hasn't ended. */
  turnOpen(sessionId: string): Promise<boolean>;
  /** Counts the tile's process starts and stops. */
  generation(tileId: string): number;
  /** The tile's process started or stopped moments ago (a resume whose turn may not show yet). */
  spawnedRecently(tileId: string): boolean;
  /**
   * Resumes the session in its tile on the follow-up, through the shared,
   * per-tile serialized resume path; `revalidate` runs under the tile lock
   * right before the stop and the spawn, and throws to cancel.
   */
  resume(workstreamId: string, tileId: string, prompt: string,
    revalidate: (phase: "before-stop" | "before-spawn", sessionId: string) => Promise<void>): Promise<void>;
  inFlight: Set<string>;
}

class Skip extends Error {}

/**
 * Sends each waiting digest follow-up into its investigation's session
 * (ADR 045), resuming it in its tile, never interrupting anything: it goes
 * only to the session it was queued for, and only if, rechecked under the
 * tile's resume lock right before sending, the follow-up is still due (not
 * muted meanwhile), the tile still runs that session, no other start happened
 * since it was read, and the session isn't mid-turn or just started.
 * Otherwise it is skipped; the digest still links to the investigation. Each
 * follow-up is handled once, whatever happens.
 */
export async function deliverFollowUps(deps: FollowUpDeps): Promise<void> {
  const { backend } = deps;
  for (const followUp of await backend.pendingInvestigationFollowups()) {
    if (deps.inFlight.has(followUp.event_id)) continue;
    deps.inFlight.add(followUp.event_id);
    try {
      const expected = followUp.expected_session_id ?? null;
      const tile = (await backend.listTiles(followUp.workstream_id))
        .find((t) => t.tile_type === "copilot_session" && expected !== null && parseCopilotSessionConfig(t.config_json).copilot_session_id === expected);
      if (!tile || !expected) continue;
      const busy = async () => deps.isBusy(tile.id) || deps.spawnedRecently(tile.id) || (await deps.turnOpen(expected).catch(() => true));
      if (await busy()) continue;
      const generation = deps.generation(tile.id);
      await deps.resume(followUp.workstream_id, tile.id, followUp.prompt, async (phase, sessionId) => {
        if (sessionId !== expected) throw new Skip("The investigation's tile runs another session now.");
        if (!(await backend.pendingInvestigationFollowups()).some((f) => f.event_id === followUp.event_id)) {
          throw new Skip("The follow-up is no longer due (the Inbox was muted).");
        }
        if (phase === "before-stop" && (deps.generation(tile.id) !== generation || (await busy()))) {
          throw new Skip("The investigation's session is busy.");
        }
      });
    } catch (error) {
      if (!(error instanceof Skip)) console.error("[investigate] Could not send the digest follow-up:", error);
    } finally {
      await backend.markInvestigationSessionStarted(followUp.event_id).catch(() => {});
      deps.inFlight.delete(followUp.event_id);
    }
  }
}

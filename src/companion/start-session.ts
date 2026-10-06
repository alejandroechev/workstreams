import type { Backend } from "../backend/types";
import type { Tile, Workstream } from "../domain/types";
import { createCopilotSessionConfig } from "../domain/tile-config";
import type { RequestGuard } from "./runtime";

export interface StartSessionDeps {
  backend: Pick<Backend, "listTiles" | "createTile" | "deleteTile" | "companionRecordSession" | "companionDeleteSession">;
  /** Mounts the workstream in the background (never changes the active one). */
  mount(workstreamId: string): Promise<void>;
  workstream(workstreamId: string): Workstream | undefined;
  defaultCwd(): string;
  /** Shows the new tile; called just before the agent is launched. */
  onTileCreated(tile: Tile): void;
  /** Takes back a tile shown by onTileCreated whose agent failed to launch; republishes. */
  onTileRemoved(tileId: string): void;
  /** The phone sessions changed: republish them. */
  onRecorded(): void;
  /** Marks the PTY as spawned by us, before spawning. */
  markSpawned(tileId: string): void;
  unmarkSpawned(tileId: string): void;
  spawn(tileId: string, cwd: string, command: string, prompt: string): Promise<void>;
}

/**
 * Appends a Copilot session tile for a phone request and starts it on the
 * phone's prompt, as ADR 033 describes. Tiles and layout are read from the backend because a
 * background mount may not have rendered yet.
 *
 * `guard` throws once the request may no longer run (stopped, expired, newer
 * document). It is checked after every wait, and last right before the agent
 * is launched; a refusal leaves nothing behind: no tile, no layout entry, no
 * phone session.
 */
export async function startPhoneSession(
  deps: StartSessionDeps,
  request: { workstreamId: string; command: string; prompt: string; guard: RequestGuard; requestId: string; now: number },
): Promise<void> {
  const { backend } = deps;
  const { workstreamId, guard } = request;
  await deps.mount(workstreamId);
  guard();
  const ws = deps.workstream(workstreamId);
  const cwd = ws?.directory || deps.defaultCwd();
  const existing = await backend.listTiles(workstreamId);
  guard();
  const count = existing.filter((t) => t.tile_type === "copilot_session").length;
  const title = `${ws?.name || "ws"}/${count + 1}`;
  // createTile appends the tile to the layout and deleteTile takes it out:
  // the layout is never rewritten here, so tiles the user adds or reorders
  // meanwhile are left alone.
  const tile = await backend.createTile(workstreamId, "copilot_session", title, createCopilotSessionConfig(title, cwd));
  let recorded = false;
  let shown = false;
  let marked = false;
  try {
    guard();
    // Recorded before the agent starts, so its first message finds it.
    await backend.companionRecordSession({
      tileId: tile.id, workstreamId, requestId: request.requestId, prompt: request.prompt, createdAt: request.now,
    });
    recorded = true;
    guard();
    deps.onTileCreated(tile);
    shown = true;
    deps.markSpawned(tile.id);
    marked = true;
    await deps.spawn(tile.id, cwd, request.command, request.prompt);
  } catch (error) {
    // Refused, or the agent could not start: take everything back out, so
    // nothing is left with the phone's permission and a later visit doesn't
    // start an agent nobody asked for any more.
    if (marked) deps.unmarkSpawned(tile.id);
    if (recorded) await backend.companionDeleteSession(tile.id).catch(() => {});
    await backend.deleteTile(tile.id).catch(() => {});
    if (shown) deps.onTileRemoved(tile.id);
    throw error;
  }
  deps.onRecorded();
}

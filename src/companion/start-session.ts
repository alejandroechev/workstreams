import type { Backend } from "../backend/types";
import type { Tile, Workstream } from "../domain/types";
import { createCopilotSessionConfig } from "../domain/tile-config";
import type { RequestGuard } from "./runtime";

export interface StartSessionDeps {
  backend: Pick<Backend, "listTiles" | "getLayout" | "createTile" | "updateLayout" | "deleteTile" | "companionRecordSession" | "companionDeleteSession">;
  /** Mounts the workstream in the background (never changes the active one). */
  mount(workstreamId: string): Promise<void>;
  workstream(workstreamId: string): Workstream | undefined;
  defaultCwd(): string;
  /** Shows the new tile; called only once the session will start. */
  onTileCreated(tile: Tile): void;
  /** The phone sessions changed: republish them. */
  onRecorded(): void;
  /** Marks the PTY as spawned by us, before spawning. */
  markSpawned(tileId: string): void;
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
  const [existing, layout] = await Promise.all([backend.listTiles(workstreamId), backend.getLayout(workstreamId)]);
  guard();
  const count = existing.filter((t) => t.tile_type === "copilot_session").length;
  const title = `${ws?.name || "ws"}/${count + 1}`;
  const tile = await backend.createTile(workstreamId, "copilot_session", title, createCopilotSessionConfig(title, cwd));
  const order: string[] = JSON.parse(layout.tile_order_json || "[]");
  let recorded = false;
  try {
    await backend.updateLayout(workstreamId, { tile_order_json: JSON.stringify([...order, tile.id]) });
    guard();
    // Recorded before the agent starts, so its first message finds it.
    await backend.companionRecordSession({
      tileId: tile.id, workstreamId, requestId: request.requestId, prompt: request.prompt, createdAt: request.now,
    });
    recorded = true;
    guard();
  } catch (error) {
    // Too late to launch: take everything back out, so a later visit doesn't
    // start an agent nobody asked for any more.
    if (recorded) await backend.companionDeleteSession(tile.id).catch(() => {});
    await backend.updateLayout(workstreamId, { tile_order_json: JSON.stringify(order) }).catch(() => {});
    await backend.deleteTile(tile.id).catch(() => {});
    throw error;
  }
  deps.onRecorded();
  deps.onTileCreated(tile);
  deps.markSpawned(tile.id);
  await deps.spawn(tile.id, cwd, request.command, request.prompt);
}

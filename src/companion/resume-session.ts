import type { Backend } from "../backend/types";
import type { Workstream } from "../domain/types";
import { linkRevision } from "./link-revision";
import type { RequestGuard } from "./runtime";

export interface ResumeSessionDeps {
  backend: Pick<Backend, "listTiles" | "companionClaimSession" | "companionAddPrompt">;
  /** Mounts the workstream in the background (never changes the active one). */
  mount(workstreamId: string): Promise<void>;
  workstream(workstreamId: string): Workstream | undefined;
  defaultCwd(): string;
  /** Whether the app has started (or is about to start) this tile's process. */
  isSpawned(tileId: string): boolean;
  markSpawned(tileId: string): void;
  unmarkSpawned(tileId: string): void;
  /** The coming exit is ours: the tile says "Restarting", not "Session ended". */
  markIntentionalRestart(tileId: string): void;
  notice(tileId: string, text: string): void;
  stop(tileId: string): Promise<{ forced: boolean }>;
  /** Starts the tile's process: `command --resume=<sessionId>`, plus `-i prompt` when there is one. */
  spawn(tileId: string, cwd: string, command: string, sessionId: string, prompt: string | null): Promise<void>;
  /** The phone sessions changed: republish them. */
  onRecorded(): void;
}

export interface ResumeRequest {
  workstreamId: string;
  tileId: string;
  linkRevision: string;
  prompt: string;
  command: string;
  guard: RequestGuard;
  requestId: string;
  now: number;
}

const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";

/**
 * Delivers a phone message to an existing session (companion conversations):
 * records it in the session's thread, stops the tile's process, and resumes
 * the same Copilot session in the same tile with the message as its new
 * interactive prompt.
 *
 * Nothing is touched until the tile is known to still run the session the
 * phone saw. A tile in a workstream that isn't mounted is marked as ours
 * before mounting, so the mount doesn't start it only for us to stop it.
 */
export async function resumePhoneSession(deps: ResumeSessionDeps, request: ResumeRequest): Promise<void> {
  const { backend } = deps;
  const { guard } = request;
  const tiles = await backend.listTiles(request.workstreamId);
  guard();
  const tile = tiles.find((t) => t.id === request.tileId && t.tile_type === "copilot_session");
  if (!tile) throw new Error("That session is no longer on the laptop.");
  const config = (() => {
    try { return JSON.parse(tile.config_json || "{}") as Record<string, unknown>; } catch { return {}; }
  })();
  const sessionId = (config.copilot_session_id || config.resume_by_id || null) as string | null;
  if (!sessionId) throw new Error("This session can't be resumed yet: it isn't linked to a Copilot session.");
  if ((await linkRevision(tile.id, sessionId)) !== request.linkRevision) {
    throw new Error("This tile now runs a different Copilot session, so the message was not delivered and nothing was restarted.");
  }
  guard();

  const running = deps.isSpawned(tile.id);
  if (!running) deps.markSpawned(tile.id);
  let mounted = false;
  /** From here a failure would leave the tile without its process. */
  let touched = false;
  try {
    await deps.mount(request.workstreamId);
    mounted = true;
    guard();
    await backend.companionClaimSession({
      tileId: tile.id, workstreamId: request.workstreamId, requestId: request.requestId, prompt: request.prompt, createdAt: request.now,
    });
    await backend.companionAddPrompt(tile.id, request.requestId, request.prompt, request.now);
    deps.onRecorded();
    guard();
    deps.notice(tile.id, `Resumed from phone: ${firstLine(request.prompt)}`);
    if (running) {
      deps.markIntentionalRestart(tile.id);
      touched = true;
      await deps.stop(tile.id);
    }
    const ws = deps.workstream(request.workstreamId);
    const cwd = (typeof config.cwd === "string" && config.cwd) || ws?.directory || deps.defaultCwd();
    deps.markSpawned(tile.id);
    touched = true;
    await deps.spawn(tile.id, cwd, request.command, sessionId, request.prompt);
  } catch (error) {
    if (!running && !mounted) {
      // The mount never ran, so it will start the tile itself when it does.
      deps.unmarkSpawned(tile.id);
    } else if (!running || touched) {
      // We kept the mount from starting this tile, or stopped it: leave it running its session.
      const ws = deps.workstream(request.workstreamId);
      const cwd = (typeof config.cwd === "string" && config.cwd) || ws?.directory || deps.defaultCwd();
      await deps.spawn(tile.id, cwd, request.command, sessionId, null).catch(() => deps.unmarkSpawned(tile.id));
    }
    throw error;
  }
}

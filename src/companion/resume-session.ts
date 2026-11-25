import type { Backend } from "../backend/types";
import type { Tile, Workstream } from "../domain/types";
import { linkedSessionId } from "../domain/linked-sessions";
import { linkRevision } from "./link-revision";
import type { RequestGuard } from "./runtime";

export interface ResumeSessionDeps {
  backend: Pick<Backend, "listTiles" | "companionClaimSession" | "companionAddPrompt" | "companionRevokeSession" | "clearStaleSessionLocks">;
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

const RELINKED = "This tile now runs a different Copilot session, so the message was not delivered and nothing was restarted.";

interface ResumeHooks {
  /** Before anything is touched, with the tile's linked session; throws to refuse. */
  verify?(sessionId: string): Promise<void>;
  /** After the mount, once the tile is known to still run the session: records the prompt. */
  record?(tile: Tile, sessionId: string): Promise<void>;
  /** The resume failed after `record` and the tile now runs another session. */
  undoRecord?(tileId: string): Promise<void>;
}

interface ResumeTileRequest {
  workstreamId: string;
  tileId: string;
  prompt: string;
  command: string;
  guard: RequestGuard;
  /** The line written in the terminal before the session restarts. */
  noticeText: string;
  /** Re-checks what asked for the resume (a schedule) right before the stop and the spawn; throws to cancel. */
  revalidate?: (phase: ResumePhase, sessionId: string) => Promise<void>;
  /** Why an unlinked tile can't be resumed. */
  unlinkedError: string;
  /** Refuse (touching nothing) when the tile's process is running: never stop it. */
  onlyIfStopped?: boolean;
}

/**
 * Stops a tile's process and resumes the same Copilot session in the same
 * tile with `prompt` as its new interactive prompt. Shared by phone messages
 * and scheduled runs (ADR 044).
 *
 * Nothing is touched until the tile is known to still run the session it was
 * read with, and that is checked again after every wait: the user may re-link
 * the tile meanwhile. A tile in a workstream that isn't mounted is marked as
 * ours before mounting, so the mount doesn't start it only for us to stop it.
 */
/** The resume holding each tile; phone messages and scheduled runs queue behind it. */
const tileLocks = new Map<string, Promise<void>>();

/** Runs `work` once no other resume holds `tileId`; everything it reads is read after that. */
async function withTileLock<T>(tileId: string, work: () => Promise<T>): Promise<T> {
  const previous = tileLocks.get(tileId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const chained = previous.then(() => mine);
  tileLocks.set(tileId, chained);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (tileLocks.get(tileId) === chained) tileLocks.delete(tileId);
  }
}

/** Resolves to the session it resumed. */
function resumeTileSession(deps: ResumeSessionDeps, request: ResumeTileRequest, hooks: ResumeHooks): Promise<string> {
  return withTileLock(request.tileId, () => resumeTileSessionNow(deps, request, hooks));
}

async function resumeTileSessionNow(deps: ResumeSessionDeps, request: ResumeTileRequest, hooks: ResumeHooks): Promise<string> {
  const { backend } = deps;
  const { guard } = request;
  const tiles = await backend.listTiles(request.workstreamId);
  guard();
  const tile = tiles.find((t) => t.id === request.tileId && t.tile_type === "copilot_session");
  if (!tile) throw new Error("That session is no longer on the laptop.");
  const config = (() => {
    try { return JSON.parse(tile.config_json || "{}") as Record<string, unknown>; } catch { return {}; }
  })();
  const sessionId = linkedSessionId(tile.config_json);
  if (!sessionId) throw new Error(request.unlinkedError);
  await hooks.verify?.(sessionId);
  guard();

  /** The session the tile is linked to now, re-read from the store. */
  const currentSession = async (): Promise<string | null> => {
    const fresh = (await backend.listTiles(request.workstreamId)).find((t) => t.id === tile.id);
    return fresh ? linkedSessionId(fresh.config_json) : null;
  };
  /** A killed or crashed CLI leaves its lock behind, and the next one would stop to ask about it. */
  const clearLocks = () => backend.clearStaleSessionLocks(sessionId).catch(() => 0);
  const stillLinked = async () => {
    if ((await currentSession()) !== sessionId) throw new Error(RELINKED);
  };

  const running = deps.isSpawned(tile.id);
  if (running && request.onlyIfStopped) throw new Error("The tile's session is running, so nothing was sent.");
  if (!running) deps.markSpawned(tile.id);
  let mounted = false;
  /** From here a failure would leave the tile without its process. */
  let touched = false;
  let recorded = false;
  try {
    await deps.mount(request.workstreamId);
    mounted = true;
    guard();
    await stillLinked();
    if (hooks.record) {
      recorded = true;
      await hooks.record(tile, sessionId);
    }
    await request.revalidate?.("before-stop", sessionId);
    await stillLinked();
    guard();
    deps.notice(tile.id, request.noticeText);
    if (running) {
      deps.markIntentionalRestart(tile.id);
      touched = true;
      await deps.stop(tile.id);
    }
    await clearLocks();
    // Recording and stopping take time: the tile may have been re-linked, or the
    // request expired, meanwhile. Checked last, with nothing awaited before launching.
    await request.revalidate?.("before-spawn", sessionId);
    await stillLinked();
    guard();
    const ws = deps.workstream(request.workstreamId);
    const cwd = (typeof config.cwd === "string" && config.cwd) || ws?.directory || deps.defaultCwd();
    deps.markSpawned(tile.id);
    touched = true;
    await deps.spawn(tile.id, cwd, request.command, sessionId, request.prompt);
    return sessionId;
  } catch (error) {
    // A record made for a session the tile no longer runs must not let that tile message the phone.
    if (recorded && hooks.undoRecord && (await currentSession().catch(() => null)) !== sessionId) {
      await hooks.undoRecord(tile.id).catch(() => {});
    }
    const relaunch = mounted && (!running || touched);
    if (relaunch) await clearLocks();
    // Read last, right before relaunching, so recovery never starts a session the tile no longer names,
    // nor one in a workstream being archived.
    const current = await currentSession().catch(() => null);
    const status = deps.workstream(request.workstreamId)?.status;
    const archived = status === "archived" || status === "archiving";
    if (!running && !mounted) {
      // The mount never ran, so it will start the tile itself when it does.
      deps.unmarkSpawned(tile.id);
    } else if (relaunch) {
      // We kept the mount from starting this tile, or stopped it: leave it running
      // whatever session it is linked to now, without the message.
      const ws = deps.workstream(request.workstreamId);
      const cwd = (typeof config.cwd === "string" && config.cwd) || ws?.directory || deps.defaultCwd();
      if (current && !archived) await deps.spawn(tile.id, cwd, request.command, current, null).catch(() => deps.unmarkSpawned(tile.id));
      else deps.unmarkSpawned(tile.id);
    }
    throw error;
  }
}

/**
 * Delivers a phone message to an existing session (companion conversations):
 * records it in the session's thread, stops the tile's process, and resumes
 * the same Copilot session in the same tile with the message as its new
 * interactive prompt. The claim checks the link atomically with the tile's config.
 */
export async function resumePhoneSession(deps: ResumeSessionDeps, request: ResumeRequest): Promise<void> {
  const { backend } = deps;
  let claimed = false;
  await resumeTileSession(
    deps,
    {
      workstreamId: request.workstreamId,
      tileId: request.tileId,
      prompt: request.prompt,
      command: request.command,
      guard: request.guard,
      noticeText: `Resumed from phone: ${firstLine(request.prompt)}`,
      unlinkedError: "This session can't be resumed yet: it isn't linked to a Copilot session.",
    },
    {
      async verify(sessionId) {
        if ((await linkRevision(request.tileId, sessionId)) !== request.linkRevision) throw new Error(RELINKED);
      },
      async record(tile, sessionId) {
        await backend.companionClaimSession({
          tileId: tile.id, workstreamId: request.workstreamId, requestId: request.requestId, prompt: request.prompt, createdAt: request.now,
        }, sessionId);
        claimed = true;
        await backend.companionAddPrompt(tile.id, request.requestId, request.prompt, request.now);
        deps.onRecorded();
      },
      async undoRecord(tileId) {
        // Only the thread this request claimed: a newer claim since must stand.
        if (claimed) await backend.companionRevokeSession(tileId, request.requestId);
      },
    },
  );
}

/** When a scheduled resume re-checks its schedule: under the tile lock before stopping, and before spawning. */
export type ResumePhase = "before-stop" | "before-spawn";

export interface ScheduledResumeRequest {
  workstreamId: string;
  tileId: string;
  /** What the run sends: the schedule's prompt plus any notify instructions. */
  prompt: string;
  command: string;
  scheduleId: string;
  now: number;
  /** Throws when the schedule was paused, edited, deleted or archived since the run was claimed. */
  revalidate?: (phase: ResumePhase, sessionId: string) => Promise<void>;
}

/**
 * Starts a periodic schedule's run (ADR 044): resumes the session the tile is
 * linked to *now* (a re-linked tile runs its new session) with the prompt.
 * With the phone companion on, the prompt is also recorded in the tile's phone
 * thread (created, named after the tile, on first use) so the thread reads
 * run by run; that record never stops the run.
 */
export async function resumeScheduledSession(
  deps: ResumeSessionDeps & { companionOn(): Promise<boolean> },
  request: ScheduledResumeRequest,
): Promise<{ sessionId: string }> {
  const { backend } = deps;
  let claimed = false;
  const claimId = `schedule-${request.scheduleId}-${request.now}`;
  const sessionId = await resumeTileSession(
    deps,
    {
      workstreamId: request.workstreamId,
      tileId: request.tileId,
      prompt: request.prompt,
      command: request.command,
      guard: () => {},
      revalidate: request.revalidate,
      noticeText: `Scheduled run: ${firstLine(request.prompt)}`,
      unlinkedError: "This tile isn't linked to a Copilot session yet, so there is nothing to resume.",
    },
    {
      async record(tile, sessionId) {
        try {
          if (!(await deps.companionOn())) return;
          const id = claimId;
          await backend.companionClaimSession({
            tileId: tile.id, workstreamId: request.workstreamId, requestId: id, prompt: tile.title || "Copilot session", createdAt: request.now,
          }, sessionId);
          claimed = true;
          await backend.companionAddPrompt(tile.id, id, request.prompt, request.now);
          deps.onRecorded();
        } catch (error) {
          console.warn("Could not record the scheduled prompt in the phone thread:", error);
        }
      },
      async undoRecord(tileId) {
        if (claimed) await backend.companionRevokeSession(tileId, claimId);
      },
    },
  );
  return { sessionId };
}

export interface FollowUpResumeRequest {
  workstreamId: string;
  tileId: string;
  prompt: string;
  command: string;
  /** Rechecks, under the tile lock right before the stop and the spawn, that the follow-up may go; throws to cancel. */
  revalidate?: (phase: ResumePhase, sessionId: string) => Promise<void>;
}

/**
 * Sends a later digest's new failed runs into an existing investigation
 * (ADR 045): resumes the session its tile runs with the follow-up as the
 * prompt, through the same per-tile serialized path as phone messages and
 * scheduled runs, and only when the tile has no live process: a running
 * session is never stopped or interrupted for a follow-up.
 */
export async function resumeFollowUpSession(deps: ResumeSessionDeps, request: FollowUpResumeRequest): Promise<{ sessionId: string }> {
  const sessionId = await resumeTileSession(
    deps,
    {
      workstreamId: request.workstreamId,
      tileId: request.tileId,
      prompt: request.prompt,
      command: request.command,
      guard: () => {},
      revalidate: request.revalidate,
      onlyIfStopped: true,
      noticeText: `Daily digest follow-up: ${firstLine(request.prompt)}`,
      unlinkedError: "The investigation's tile isn't linked to a Copilot session yet, so there is nothing to resume.",
    },
    {},
  );
  return { sessionId };
}

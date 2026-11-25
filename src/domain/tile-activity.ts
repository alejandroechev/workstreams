/**
 * What each Copilot session tile's agent is doing, as the session poller last
 * reported it (`copilot-stats-<tile>`), readable app-wide, and a count of the
 * tile's process changes. The periodic schedule runner (ADR 044) skips a run
 * while the agent is mid-turn, and only interrupts a process it launched itself.
 */
import type { CopilotSessionStats } from "./types";

type Activity = CopilotSessionStats["activity_status"];

// A sub-agent running in the background is still inside its parent's turn.
const MID_TURN: ReadonlySet<string> = new Set(["thinking", "tool_use", "responding", "background_task"]);
const activity = new Map<string, Activity>();
const generations = new Map<string, number>();

export function setTileActivity(tileId: string, status: Activity): void {
  activity.set(tileId, status);
}

export function forgetTileActivity(tileId: string): void {
  activity.delete(tileId);
}

/** Mid-turn: thinking, using a tool, responding or running a sub-agent. Typing doesn't count. */
export function isTileBusy(tileId: string): boolean {
  const status = activity.get(tileId);
  return status !== undefined && MID_TURN.has(status);
}

const changedAt = new Map<string, number>();

/** The tile's process was spawned or closed (called by the backends). */
export function bumpTileGeneration(tileId: string, now: number = Date.now()): void {
  generations.set(tileId, (generations.get(tileId) ?? 0) + 1);
  changedAt.set(tileId, now);
}

/** How long after a start or stop a tile counts as just changed: its new turn may not show yet. */
export const RECENT_CHANGE_MS = 2 * 60 * 1000;

/** The tile's process started or stopped within RECENT_CHANGE_MS (a digest follow-up then waits, ADR 045). */
export function tileChangedRecently(tileId: string, now: number = Date.now()): boolean {
  const at = changedAt.get(tileId);
  return at !== undefined && now - at < RECENT_CHANGE_MS;
}

export function tileGeneration(tileId: string): number {
  return generations.get(tileId) ?? 0;
}

/**
 * What each Copilot session tile's agent is doing, as the session poller last
 * reported it (`copilot-stats-<tile>`), readable app-wide, and a count of the
 * tile's process changes. The periodic schedule runner (ADR 044) skips a run
 * while the agent is mid-turn, and only interrupts a process it launched itself.
 */
import type { CopilotSessionStats } from "./types";

type Activity = CopilotSessionStats["activity_status"];

const MID_TURN: ReadonlySet<string> = new Set(["thinking", "tool_use", "responding"]);
const activity = new Map<string, Activity>();
const generations = new Map<string, number>();

export function setTileActivity(tileId: string, status: Activity): void {
  activity.set(tileId, status);
}

export function forgetTileActivity(tileId: string): void {
  activity.delete(tileId);
}

/** Mid-turn: thinking, using a tool or responding. Typing in the tile doesn't count. */
export function isTileBusy(tileId: string): boolean {
  const status = activity.get(tileId);
  return status !== undefined && MID_TURN.has(status);
}

/** The tile's process was spawned or closed (called by the backends). */
export function bumpTileGeneration(tileId: string): void {
  generations.set(tileId, (generations.get(tileId) ?? 0) + 1);
}

export function tileGeneration(tileId: string): number {
  return generations.get(tileId) ?? 0;
}

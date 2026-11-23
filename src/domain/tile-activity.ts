/**
 * What each Copilot session tile's agent is doing, as the session poller last
 * reported it (`copilot-stats-<tile>`), readable app-wide, and a count of the
 * tile's process changes. The periodic schedule runner (ADR 044) skips a run
 * while the agent is mid-turn, sees a run's turn start and end, and only
 * interrupts a process it launched itself.
 */
import type { CopilotSessionStats } from "./types";

type Activity = CopilotSessionStats["activity_status"];

const MID_TURN: ReadonlySet<string> = new Set(["thinking", "tool_use", "responding"]);
const activity = new Map<string, Activity>();
const turns = new Map<string, number>();
const generations = new Map<string, number>();

export function setTileActivity(tileId: string, status: Activity, turnCount?: number | null): void {
  activity.set(tileId, status);
  if (typeof turnCount === "number") turns.set(tileId, turnCount);
}

export function forgetTileActivity(tileId: string): void {
  activity.delete(tileId);
  turns.delete(tileId);
}

/** Mid-turn: thinking, using a tool or responding. Typing in the tile doesn't count. */
export function isTileBusy(tileId: string): boolean {
  const status = activity.get(tileId);
  return status !== undefined && MID_TURN.has(status);
}

export function tileTurnCount(tileId: string): number | undefined {
  return turns.get(tileId);
}

/** The tile's process was spawned or closed (called by the backends). */
export function bumpTileGeneration(tileId: string): void {
  generations.set(tileId, (generations.get(tileId) ?? 0) + 1);
}

export function tileGeneration(tileId: string): number {
  return generations.get(tileId) ?? 0;
}

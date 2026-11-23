/**
 * What each Copilot session tile's agent is doing, as the session poller last
 * reported it (`copilot-stats-<tile>`), readable app-wide. The periodic
 * schedule runner (ADR 044) skips a run while the agent is mid-turn.
 */
import type { CopilotSessionStats } from "./types";

type Activity = CopilotSessionStats["activity_status"];

const MID_TURN: ReadonlySet<string> = new Set(["thinking", "tool_use", "responding"]);
const activity = new Map<string, Activity>();

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

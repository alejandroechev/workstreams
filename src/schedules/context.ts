// @test-skip: React context declaration only; exercised through PeriodicSessionTile and the E2E specs
import { createContext, useContext } from "react";
import type { PeriodicRun, PeriodicSchedule } from "../domain/periodic-schedules";

/** What a Periodic session tile needs from the app (ADR 046). */
export interface TileSchedules {
  byTile: ReadonlyMap<string, PeriodicSchedule>;
  now: number;
  /** Opens the schedule's edit form. */
  openEditor(tileId: string, workstreamId: string): void;
  runNow(id: string): Promise<void>;
  /** Runs `text` as the session's next turn now. */
  reply(id: string, text: string): Promise<unknown>;
  /** Opens an ordinary Copilot tile resuming the schedule's session. */
  openInteractively(schedule: PeriodicSchedule): Promise<void>;
  /** The tile's runs, newest first. */
  listRuns(tileId: string): Promise<PeriodicRun[]>;
}

export const TileSchedulesContext = createContext<TileSchedules | null>(null);

export function useTileSchedules(): TileSchedules | null {
  return useContext(TileSchedulesContext);
}

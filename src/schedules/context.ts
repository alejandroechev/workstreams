// @test-skip: React context declaration only; exercised through Tile and the E2E specs
import { createContext, useContext } from "react";
import type { PeriodicSchedule } from "../domain/periodic-schedules";

/** What a tile needs to show its periodic badge and menu entry (ADR 044). */
export interface TileSchedules {
  byTile: ReadonlyMap<string, PeriodicSchedule>;
  now: number;
  /** Opens "Run periodically…" (or the edit form, when the tile has a schedule). */
  openEditor(tileId: string, workstreamId: string): void;
}

export const TileSchedulesContext = createContext<TileSchedules | null>(null);

export function useTileSchedules(): TileSchedules | null {
  return useContext(TileSchedulesContext);
}

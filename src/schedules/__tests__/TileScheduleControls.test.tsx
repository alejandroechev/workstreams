import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TileScheduleControls } from "../TileScheduleControls";
import { TileSchedulesContext } from "../context";
import type { PeriodicSchedule } from "../../domain/periodic-schedules";

afterEach(cleanup);

const now = new Date(2026, 10, 23, 16, 0).getTime();
const schedule: PeriodicSchedule = {
  id: "a", tile_id: "t1", workstream_id: "w1", prompt: "P", frequency: { kind: "daily", time: "09:00" },
  notify_inbox: false, notify_phone: false, paused: false, next_run_at: new Date(2026, 10, 24, 9, 0).getTime(), last_run_at: null,
  last_result: null, last_error: null, failures: 0, run_requested: false, created_at: 0,
};

function renderWith(byTile: Map<string, PeriodicSchedule>, tileId = "t1") {
  const openEditor = vi.fn();
  render(
    <TileSchedulesContext.Provider value={{ byTile, now, openEditor }}>
      <TileScheduleControls tileId={tileId} workstreamId="w1" />
    </TileSchedulesContext.Provider>,
  );
  return openEditor;
}

describe("TileScheduleControls", () => {
  it("offers Run periodically… on a tile without a schedule, and shows no badge", () => {
    const openEditor = renderWith(new Map());
    expect(screen.queryByTestId("tile-schedule-badge-t1")).toBeNull();
    fireEvent.click(screen.getByTestId("tile-menu-t1"));
    expect(screen.getByTestId("tile-menu-run-periodically").textContent).toBe("Run periodically…");
    fireEvent.click(screen.getByTestId("tile-menu-run-periodically"));
    expect(openEditor).toHaveBeenCalledWith("t1", "w1");
  });

  it("shows the next run and last result on a periodic tile, and edits it", () => {
    const openEditor = renderWith(new Map([["t1", schedule]]));
    expect(screen.getByTestId("tile-schedule-badge-t1").textContent).toBe("next: tomorrow 09:00 · last: never run");
    fireEvent.click(screen.getByTestId("tile-menu-t1"));
    expect(screen.getByTestId("tile-menu-run-periodically").textContent).toBe("Edit schedule…");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("tile-menu-run-periodically")).toBeNull();
    fireEvent.click(screen.getByTestId("tile-schedule-badge-t1"));
    expect(openEditor).toHaveBeenCalledWith("t1", "w1");
  });

  it("says paused", () => {
    renderWith(new Map([["t1", { ...schedule, paused: true, last_result: "timed out", last_error: "60 minutes" }]]));
    expect(screen.getByTestId("tile-schedule-badge-t1").textContent).toBe("paused · last: timed out: 60 minutes");
  });

  it("renders nothing outside the app", () => {
    const { container } = render(<TileScheduleControls tileId="t1" workstreamId="w1" />);
    expect(container.innerHTML).toBe("");
  });
});

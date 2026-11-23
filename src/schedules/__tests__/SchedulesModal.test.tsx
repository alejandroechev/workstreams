import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SchedulesModal } from "../SchedulesModal";
import type { PeriodicSchedule } from "../../domain/periodic-schedules";

afterEach(cleanup);

const now = new Date(2026, 10, 23, 16, 0).getTime();
const schedule = (over: Partial<PeriodicSchedule>): PeriodicSchedule => ({
  id: "a", tile_id: "t1", workstream_id: "w1", prompt: "Check for new videos\nand summarise", frequency: { kind: "daily", time: "09:00" },
  notify_inbox: false, notify_phone: false, paused: false, next_run_at: new Date(2026, 10, 24, 9, 0).getTime(), last_run_at: null,
  last_result: "ok", last_error: null, failures: 0, run_requested: false, run_requested_at: null, created_at: 0, revision: 0, ...over,
});

function setup(schedules: PeriodicSchedule[]) {
  const controls = {
    runNow: vi.fn(async () => {}), pause: vi.fn(async () => {}), resume: vi.fn(async () => {}),
    remove: vi.fn(async () => {}), edit: vi.fn(), onClose: vi.fn(),
  };
  render(<SchedulesModal schedules={schedules} now={now} workstreamName={(id) => (id === "w1" ? "Courses" : "Infra")}
    tileTitle={(id) => (id === "t1" ? "Videos" : undefined)} {...controls} />);
  return controls;
}

describe("SchedulesModal", () => {
  it("lists each schedule's workstream, prompt first line, next run and last result", () => {
    setup([schedule({}), schedule({ id: "b", tile_id: "t2", workstream_id: "w2", paused: true, last_result: "could not start", last_error: "tile gone", failures: 2 })]);
    const first = screen.getByTestId("schedule-row-a");
    expect(first.textContent).toContain("Courses");
    expect(first.textContent).toContain("Videos");
    expect(screen.getAllByTestId("schedule-row-prompt")[0].textContent).toBe("Check for new videos");
    expect(screen.getAllByTestId("schedule-row-next")[0].textContent).toBe("next tomorrow 09:00");
    expect(screen.getAllByTestId("schedule-row-last")[0].textContent).toBe("last ok");
    const second = screen.getByTestId("schedule-row-b");
    expect(second.getAttribute("data-paused")).toBe("true");
    expect(second.textContent).toContain("paused");
    expect(second.textContent).toContain("could not start: tile gone");
    expect(second.textContent).toContain("2 failures in a row");
  });

  it("wires Run now, Pause, Resume, Edit and Delete", async () => {
    const controls = setup([schedule({}), schedule({ id: "b", paused: true })]);
    fireEvent.click(screen.getByTestId("schedule-run-a"));
    fireEvent.click(screen.getByTestId("schedule-pause-a"));
    fireEvent.click(screen.getByTestId("schedule-resume-b"));
    fireEvent.click(screen.getByTestId("schedule-edit-a"));
    fireEvent.click(screen.getByTestId("schedule-delete-b"));
    expect(controls.runNow).toHaveBeenCalledWith("a");
    expect(controls.pause).toHaveBeenCalledWith("a");
    expect(controls.resume).toHaveBeenCalledWith("b");
    expect(controls.edit).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(controls.remove).toHaveBeenCalledWith("b");
    controls.runNow.mockRejectedValueOnce(new Error("No schedule a"));
    fireEvent.click(screen.getByTestId("schedule-run-a"));
    await waitFor(() => expect(screen.getByTestId("schedules-error").textContent).toBe("No schedule a"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(controls.onClose).toHaveBeenCalled();
  });

  it("explains how to add one when there are none", () => {
    setup([]);
    expect(screen.getByTestId("schedules-empty").textContent).toContain("Run periodically");
  });
});

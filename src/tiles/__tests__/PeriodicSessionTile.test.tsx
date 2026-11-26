import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import PeriodicSessionTile from "../PeriodicSessionTile";
import { TileSchedulesContext, type TileSchedules } from "../../schedules/context";
import type { PeriodicRun, PeriodicSchedule } from "../../domain/periodic-schedules";

vi.mock("@tauri-apps/api/event", () => import("../../test-shims/tauri-event-shim"));

afterEach(cleanup);

const now = new Date(2026, 10, 26, 9, 30).getTime();
const schedule = (over: Partial<PeriodicSchedule> = {}): PeriodicSchedule => ({
  id: "s", tile_id: "p", workstream_id: "w", prompt: "Check CI health", frequency: { kind: "interval", minutes: 120 },
  notify_inbox: false, notify_phone: false, paused: false, next_run_at: now + 2 * 3_600_000, last_run_at: null,
  last_result: null, last_error: null, failures: 0, run_requested: false, run_requested_at: null, created_at: 0, revision: 0,
  session_id: "S", session_started: true, interactive_tile_id: null, ...over,
});
const run = (over: Partial<PeriodicRun>): PeriodicRun => ({
  id: "r", schedule_id: "s", tile_id: "p", kind: "scheduled", status: "ok", started_at: now - 3_600_000, ended_at: now - 3_600_000 + 192_000,
  exit_code: 0, prompt: "Check CI health", answer: "All green", question: null, error: null, tools: [], events_path: null, ...over,
});

function setup(s: PeriodicSchedule | null, runs: PeriodicRun[] = []) {
  const context: TileSchedules = {
    byTile: new Map(s ? [["p", s]] : []),
    now,
    openEditor: vi.fn(),
    runNow: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    openInteractively: vi.fn(async () => {}),
    listRuns: vi.fn(async () => runs),
  };
  const view = render(
    <TileSchedulesContext.Provider value={context}>
      <PeriodicSessionTile tileId="p" workstreamId="w" />
    </TileSchedulesContext.Provider>,
  );
  return { context, view };
}

describe("PeriodicSessionTile (ADR 046)", () => {
  it("shows the schedule, the next run, no runs yet, and the three actions (AT-1)", async () => {
    setup(schedule({ session_started: false }));
    const header = screen.getByTestId("periodic-header");
    expect(header.textContent).toContain("Every 2 hours");
    expect(screen.getByTestId("periodic-next").textContent).toBe("next: today 11:30");
    expect(screen.getByTestId("periodic-last").textContent).toBe("no runs yet");
    expect(await screen.findByTestId("periodic-empty")).toBeTruthy();
    expect(screen.getByTestId("periodic-run-now")).toBeTruthy();
    expect(screen.getByTestId("periodic-edit")).toBeTruthy();
    // No session yet: nothing to open until the first run creates it.
    expect((screen.getByTestId("periodic-open-interactive") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".xterm")).toBeNull();
  });

  it("lists runs newest first with result, start and duration; the selected one shows prompt, tools, answer and question (AT-4, AT-5)", async () => {
    const { context } = setup(schedule({ last_result: "needs_input" }), [
      run({ id: "new", status: "needs_input", started_at: now - 60_000, ended_at: now, answer: "NEEDS INPUT: Skip it or report it?", question: "Skip it or report it?",
        tools: [{ id: "c1", name: "bash", status: "ok" }, { id: "c2", name: "view", status: "failed" }] }),
      run({ id: "old", status: "failed", exit_code: 1, error: "The run ended with exit code 1", answer: null }),
    ]);
    const rows = await screen.findAllByTestId(/^periodic-run-row-/);
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["needs_input", "failed"]);
    expect(rows[0].textContent).toContain("needs input");
    expect(rows[0].textContent).toContain("09:29");
    expect(rows[0].textContent).toContain("1m 0s");
    expect(rows[1].textContent).toContain("3m 12s");
    const detail = screen.getByTestId("periodic-run-detail");
    expect(within(detail).getByTestId("periodic-run-prompt").textContent).toContain("Check CI health");
    const tools = within(detail).getAllByTestId("periodic-tool");
    expect(tools.map((t) => t.textContent)).toEqual(["bash (ok)", "view (failed)"]);
    expect(within(detail).getByTestId("periodic-run-question").textContent).toContain("Skip it or report it?");
    expect(screen.getByTestId("periodic-last").textContent).toBe("last: needs input");
    fireEvent.click(rows[1]);
    expect(screen.getByTestId("periodic-run-detail").textContent).toContain("exit code 1");
    // The reply runs the next turn now.
    fireEvent.change(screen.getByTestId("periodic-reply-input"), { target: { value: "Just report it" } });
    fireEvent.click(screen.getByTestId("periodic-reply-send"));
    await waitFor(() => expect(context.reply).toHaveBeenCalledWith("s", "Just report it"));
    expect((screen.getByTestId("periodic-reply-input") as HTMLInputElement).value).toBe("");
  });

  it("updates a running run live as its events arrive (AT-5)", async () => {
    setup(schedule({ last_result: "running" }), [run({ id: "live", status: "running", ended_at: null, answer: null, exit_code: null })]);
    await screen.findByTestId("periodic-run-row-live");
    // Two processes never share the session: no taking over while a run goes.
    expect((screen.getByTestId("periodic-open-interactive") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      window.__WS_EMIT__?.("periodic-run", { run: run({ id: "live", status: "running", ended_at: null, answer: null, tools: [{ id: "c1", name: "bash", status: "running" }] }), finished: false });
    });
    expect(screen.getAllByTestId("periodic-tool").map((t) => t.textContent)).toEqual(["bash (running)"]);
    await act(async () => {
      window.__WS_EMIT__?.("periodic-run", { run: run({ id: "live", status: "ok", answer: "Done", tools: [{ id: "c1", name: "bash", status: "ok" }] }), finished: true });
    });
    expect(screen.getByTestId("periodic-run-answer").textContent).toBe("Done");
    expect(screen.getByTestId("periodic-run-row-live").getAttribute("data-status")).toBe("ok");
    // Another tile's run doesn't show here.
    await act(async () => { window.__WS_EMIT__?.("periodic-run", { run: run({ id: "x", tile_id: "other" }), finished: true }); });
    expect(screen.queryByTestId("periodic-run-row-x")).toBeNull();
  });

  it("wires Run now, Edit schedule and Open interactively", async () => {
    const { context } = setup(schedule());
    fireEvent.click(screen.getByTestId("periodic-run-now"));
    fireEvent.click(screen.getByTestId("periodic-edit"));
    fireEvent.click(screen.getByTestId("periodic-open-interactive"));
    await waitFor(() => expect(context.openInteractively).toHaveBeenCalledWith(expect.objectContaining({ id: "s" })));
    expect(context.runNow).toHaveBeenCalledWith("s");
    expect(context.openEditor).toHaveBeenCalledWith("p", "w");
  });

  it("while open interactively: says so, and Run now, the reply and Open interactively are off (AT-6)", async () => {
    setup(schedule({ interactive_tile_id: "c1" }));
    expect(screen.getByTestId("periodic-next").textContent).toBe("Paused while open interactively");
    for (const id of ["periodic-run-now", "periodic-reply-send", "periodic-open-interactive"]) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("says paused, shows a refused action's reason, and waits for its schedule", async () => {
    const { context, view } = setup(schedule({ paused: true }));
    expect(screen.getByTestId("periodic-next").textContent).toBe("Paused");
    (context.runNow as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("A run is already going"));
    fireEvent.click(screen.getByTestId("periodic-run-now"));
    expect((await screen.findByTestId("periodic-error")).textContent).toContain("already going");
    view.unmount();
    setup(null);
    expect(screen.getByTestId("periodic-missing").textContent).toContain("no schedule");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScheduleEditor } from "../ScheduleEditor";

afterEach(cleanup);

describe("ScheduleEditor", () => {
  it("defaults to daily at 09:00 with both notify toggles off, and saves the prompt verbatim", async () => {
    const onSave = vi.fn(async () => {});
    render(<ScheduleEditor title="Run periodically" onSave={onSave} onCancel={() => {}} />);
    expect((screen.getByTestId("schedule-notify-inbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("schedule-notify-phone") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByTestId("schedule-prompt"), { target: { value: "  Check videos\n" } });
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      prompt: "  Check videos\n", frequency: { kind: "daily", time: "09:00" }, notifyInbox: false, notifyPhone: false,
    }));
  });

  it("builds every preset", async () => {
    const onSave = vi.fn(async () => {});
    render(<ScheduleEditor title="t" onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("schedule-prompt"), { target: { value: "P" } });
    const save = async () => { fireEvent.click(screen.getByTestId("schedule-save")); await waitFor(() => expect(onSave).toHaveBeenCalled()); return (onSave.mock.calls.pop() as unknown as [{ frequency: unknown }])[0].frequency; };
    fireEvent.change(screen.getByTestId("schedule-frequency"), { target: { value: "hourly" } });
    expect(await save()).toEqual({ kind: "interval", minutes: 60 });
    fireEvent.change(screen.getByTestId("schedule-frequency"), { target: { value: "hours" } });
    fireEvent.change(screen.getByTestId("schedule-every"), { target: { value: "2" } });
    expect(await save()).toEqual({ kind: "interval", minutes: 120 });
    fireEvent.change(screen.getByTestId("schedule-frequency"), { target: { value: "weekly" } });
    fireEvent.change(screen.getByTestId("schedule-day"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("schedule-time"), { target: { value: "18:30" } });
    fireEvent.click(screen.getByTestId("schedule-notify-inbox"));
    fireEvent.click(screen.getByTestId("schedule-notify-phone"));
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ prompt: "P", frequency: { kind: "weekly", day: 5, time: "18:30" }, notifyInbox: true, notifyPhone: true }));
  });

  it("refuses under 5 minutes and an empty prompt, saving nothing", async () => {
    const onSave = vi.fn(async () => {});
    render(<ScheduleEditor title="t" onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId("schedule-save"));
    expect(screen.getByTestId("schedule-error").textContent).toMatch(/prompt/);
    fireEvent.change(screen.getByTestId("schedule-prompt"), { target: { value: "P" } });
    fireEvent.change(screen.getByTestId("schedule-frequency"), { target: { value: "minutes" } });
    fireEvent.change(screen.getByTestId("schedule-every"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("schedule-save"));
    expect(screen.getByTestId("schedule-error").textContent).toMatch(/5 minutes/);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a save failure, starts from an existing schedule, and cancels on Escape", async () => {
    const onCancel = vi.fn();
    const onSave = vi.fn(async () => { throw new Error("This tile already has a schedule"); });
    render(<ScheduleEditor title="Edit" initial={{ prompt: "Old", frequency: { kind: "interval", minutes: 30 }, notifyInbox: true, notifyPhone: false }} onSave={onSave} onCancel={onCancel} />);
    expect((screen.getByTestId("schedule-prompt") as HTMLTextAreaElement).value).toBe("Old");
    expect((screen.getByTestId("schedule-frequency") as HTMLSelectElement).value).toBe("minutes");
    expect((screen.getByTestId("schedule-every") as HTMLInputElement).value).toBe("30");
    fireEvent.click(screen.getByTestId("schedule-save"));
    await waitFor(() => expect(screen.getByTestId("schedule-error").textContent).toContain("already has a schedule"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("recognises hourly, hours and weekly when editing", () => {
    const { unmount } = render(<ScheduleEditor title="e" initial={{ prompt: "P", frequency: { kind: "interval", minutes: 60 }, notifyInbox: false, notifyPhone: false }} onSave={vi.fn()} onCancel={() => {}} />);
    expect((screen.getByTestId("schedule-frequency") as HTMLSelectElement).value).toBe("hourly");
    unmount();
    const second = render(<ScheduleEditor title="e" initial={{ prompt: "P", frequency: { kind: "interval", minutes: 180 }, notifyInbox: false, notifyPhone: false }} onSave={vi.fn()} onCancel={() => {}} />);
    expect((screen.getByTestId("schedule-every") as HTMLInputElement).value).toBe("3");
    second.unmount();
    render(<ScheduleEditor title="e" initial={{ prompt: "P", frequency: { kind: "weekly", day: 2, time: "07:15" }, notifyInbox: false, notifyPhone: false }} onSave={vi.fn()} onCancel={() => {}} />);
    expect((screen.getByTestId("schedule-day") as HTMLSelectElement).value).toBe("2");
    expect((screen.getByTestId("schedule-time") as HTMLInputElement).value).toBe("07:15");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { MemoryBackend } from "../../backend/memory-backend";
import { useSchedules, type UseSchedulesOptions } from "../useSchedules";

vi.mock("@tauri-apps/api/event", () => import("../../test-shims/tauri-event-shim"));

afterEach(cleanup);

const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m).getTime();

async function setup(over: Partial<UseSchedulesOptions> = {}) {
  const backend = new MemoryBackend();
  const ws = await backend.createWorkstream("Courses", "/c");
  const tile = await backend.createTile(ws.id, "copilot_session", "Videos", JSON.stringify({ copilot_session_id: "S" }));
  let now = at(16, 42);
  const resume = vi.fn(async () => ({ sessionId: "S" }));
  const options: UseSchedulesOptions = {
    backend, ready: true, workstreamName: () => "Courses", isArchived: () => false, isBusy: () => false, turnState: async () => ({ starts: 0, ends: 0, open: false }), resume, interrupt: vi.fn(async () => {}),
    clock: () => now, tickMs: 60_000, ...over,
  };
  const hook = renderHook(() => useSchedules(options));
  await waitFor(() => expect(hook.result.current).toBeTruthy());
  return { backend, ws, tile, hook, resume, setNow: (t: number) => { now = t; } };
}

const draft = { prompt: "Check videos", frequency: { kind: "daily", time: "09:00" } as const, notifyInbox: false, notifyPhone: false };

describe("useSchedules", () => {
  it("creates a schedule planned for its first scheduled time, not now (AT-1)", async () => {
    const { hook, tile, ws, resume } = await setup();
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    expect(hook.result.current.schedules).toHaveLength(1);
    expect(hook.result.current.schedules[0].next_run_at).toBe(new Date(2026, 10, 24, 9, 0).getTime());
    expect(resume).not.toHaveBeenCalled();
  });

  it("edits (re-planning), pauses, resumes (clearing failures), runs now and deletes", async () => {
    const { hook, tile, ws, backend, resume, setNow } = await setup();
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    const id = hook.result.current.schedules[0].id;
    await act(() => hook.result.current.edit(id, { ...draft, prompt: "Edited", frequency: { kind: "daily", time: "18:00" } }));
    expect(hook.result.current.schedules[0]).toMatchObject({ prompt: "Edited", next_run_at: at(18, 0) });
    await act(() => hook.result.current.pause(id));
    expect(hook.result.current.schedules[0].paused).toBe(true);
    await backend.updateSchedule(id, { failures: 3 });
    setNow(at(19));
    await act(() => hook.result.current.refresh());
    await act(() => hook.result.current.resume(id));
    expect(hook.result.current.schedules[0]).toMatchObject({ paused: false, failures: 0, next_run_at: new Date(2026, 10, 24, 18, 0).getTime() });
    await act(() => hook.result.current.runNow(id));
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id }), "Edited", expect.any(Function));
    await act(() => hook.result.current.remove(id));
    expect(hook.result.current.schedules).toEqual([]);
    expect(await backend.listTiles(ws.id)).toHaveLength(1);
  });

  it("re-reads and ticks when an agent changes a schedule", async () => {
    const { hook, tile, ws, backend, resume } = await setup();
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    const id = hook.result.current.schedules[0].id;
    await act(async () => { backend.agentScheduleForTests(id, "run"); });
    await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
  });

  it("refuses Run now and Resume for an archived workstream (finding 4)", async () => {
    const archived = new Set<string>();
    const { hook, tile, ws, resume } = await setup({ isArchived: (id) => archived.has(id) });
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    const id = hook.result.current.schedules[0].id;
    await act(() => hook.result.current.pause(id));
    archived.add(ws.id);
    await expect(hook.result.current.runNow(id)).rejects.toThrow("archived");
    await expect(hook.result.current.resume(id)).rejects.toThrow("archived");
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.schedules[0].paused).toBe(true);
    expect(resume).not.toHaveBeenCalled();
  });

  it("does nothing until the app is ready", async () => {
    const { backend, ws, tile } = await setup({ ready: false });
    await backend.createSchedule({ tileId: tile.id, workstreamId: ws.id, prompt: "P", frequency: draft.frequency, notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect((await backend.listSchedules())[0].next_run_at).toBeNull();
  });
});

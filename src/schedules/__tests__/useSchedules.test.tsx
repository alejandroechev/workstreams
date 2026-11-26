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
  const tile = await backend.createTile(ws.id, "periodic_session", "Videos", "{}");
  let now = at(16, 42);
  const start = vi.spyOn(backend, "startPeriodicRun");
  const options: UseSchedulesOptions = {
    backend, ready: true, workstreamName: () => "Courses", isArchived: () => false,
    command: () => "my-copilot --yolo", cwd: () => "/c", companionOn: async () => false,
    clock: () => now, tickMs: 60_000, ...over,
  };
  const hook = renderHook(() => useSchedules(options));
  await waitFor(() => expect(hook.result.current).toBeTruthy());
  return { backend, ws, tile, hook, start, setNow: (t: number) => { now = t; } };
}

const draft = { prompt: "Check videos", frequency: { kind: "daily", time: "09:00" } as const, notifyInbox: false, notifyPhone: false };

describe("useSchedules", () => {
  it("creates a schedule planned for its first scheduled time, on the tile's session, starting nothing (AT-1)", async () => {
    const { hook, tile, ws, start } = await setup();
    await act(() => hook.result.current.create(tile.id, ws.id, draft, "S-new"));
    expect(hook.result.current.schedules).toHaveLength(1);
    expect(hook.result.current.schedules[0]).toMatchObject({ session_id: "S-new", next_run_at: new Date(2026, 10, 24, 9, 0).getTime() });
    expect(start).not.toHaveBeenCalled();
  });

  it("edits (re-planning), pauses, resumes (clearing failures), runs now and deletes with the tile", async () => {
    const { hook, tile, ws, backend, start, setNow } = await setup();
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
    expect(start).toHaveBeenCalledWith({ tileId: tile.id, kind: "manual", prompt: "Edited", command: "my-copilot --yolo", cwd: "/c", startedAt: at(19) });
    await act(() => hook.result.current.remove(id));
    expect(hook.result.current.schedules).toEqual([]);
    expect(await backend.listTiles(ws.id)).toHaveLength(0);
  });

  it("applies a run's end as soon as the native runner says so, and delivers it", async () => {
    const postApp = vi.fn(async () => {});
    const { hook, tile, ws, backend } = await setup();
    backend.postAppInboxMessage = postApp;
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    const id = hook.result.current.schedules[0].id;
    await act(() => hook.result.current.reply(id, "Just report it"));
    expect((await backend.listPeriodicRuns(tile.id))[0]).toMatchObject({ kind: "reply", prompt: "Just report it" });
    await act(async () => { backend.finishPeriodicRunForTests(tile.id, { exitCode: 0, answer: "NEEDS INPUT: Which file?" }); });
    await waitFor(() => expect(hook.result.current.schedules[0].last_result).toBe("needs_input"));
    expect(postApp).toHaveBeenCalledWith(ws.id, tile.id, "needs-you", "Needs input: Check videos", "Which file?");
  });

  it("re-reads and ticks when an agent changes a schedule", async () => {
    const { hook, tile, ws, backend, start } = await setup();
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    const id = hook.result.current.schedules[0].id;
    await act(async () => { backend.agentScheduleForTests(id, "run"); });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it("refuses Run now and Resume for an archived workstream", async () => {
    const archived = new Set<string>();
    const { hook, tile, ws, start } = await setup({ isArchived: (id) => archived.has(id) });
    await act(() => hook.result.current.create(tile.id, ws.id, draft));
    const id = hook.result.current.schedules[0].id;
    await act(() => hook.result.current.pause(id));
    archived.add(ws.id);
    await expect(hook.result.current.runNow(id)).rejects.toThrow("archived");
    await expect(hook.result.current.resume(id)).rejects.toThrow("archived");
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.schedules[0].paused).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it("does nothing until the app is ready", async () => {
    const { backend, ws, tile } = await setup({ ready: false });
    await backend.createSchedule({ tileId: tile.id, workstreamId: ws.id, prompt: "P", frequency: draft.frequency, notifyInbox: false, notifyPhone: false, nextRunAt: null, createdAt: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect((await backend.listSchedules())[0].next_run_at).toBeNull();
  });
});

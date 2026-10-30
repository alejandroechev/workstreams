import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { usePlanning } from "../usePlanning";
import { emit } from "../../test-shims/tauri-event-shim";

vi.mock("@tauri-apps/api/event", () => import("../../test-shims/tauri-event-shim"));

const LINK = "https://dev.azure.com/skype/OneWork/_backlogs/backlog/Waimea%20Bay/Features";

function backend() {
  const b = new MemoryBackend();
  b.seedPlanningAdo({
    iterations: [{ name: "S22", path: "OneWork\\S22", start: "2026-10-26T00:00:00Z", finish: "2026-11-08T00:00:00Z", timeframe: "current" }],
    items: [],
  });
  return b;
}

afterEach(() => vi.useRealTimers());

describe("usePlanning freshness", () => {
  it("loads on open, every 5 minutes and on Refresh while open; never while closed or unconnected", async () => {
    vi.useFakeTimers();
    const b = backend();
    const { result, rerender } = renderHook(({ open }) => usePlanning(b, open), { initialProps: { open: true } });
    await act(async () => {});
    expect(b.planningFetchCount()).toBe(0);
    expect(result.current.connection).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(b.planningFetchCount()).toBe(0);

    await act(async () => { await result.current.connect(LINK); });
    expect(b.planningFetchCount()).toBe(1);
    expect(result.current.data?.selected_sprint).toBe("OneWork\\S22");
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(b.planningFetchCount()).toBe(2);
    await act(async () => { await result.current.refresh(); });
    expect(b.planningFetchCount()).toBe(3);

    rerender({ open: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(b.planningFetchCount()).toBe(3);
    rerender({ open: true });
    await act(async () => {});
    expect(b.planningFetchCount()).toBe(4);
    expect(b.planningOrphansFetchCount()).toBe(b.planningFetchCount());
  });

  it("keeps the last data and shows the error when a load fails", async () => {
    const b = backend();
    await b.planningConnect(LINK);
    const { result } = renderHook(() => usePlanning(b, true));
    await act(async () => {});
    expect(result.current.data).not.toBeNull();
    b.failPlanningFetch(true);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.error).toMatch(/timed out/);
    expect(result.current.data).not.toBeNull();
  });

  it("picks up draft changes made elsewhere (the CLI) on refresh and when Planning state changes", async () => {
    const b = backend();
    await b.planningConnect(LINK);
    const { result } = renderHook(() => usePlanning(b, true));
    await act(async () => {});
    await b.planningAddChange({ kind: "create_feature", temp_id: -1, title: "From the CLI", target_date: null, description: null });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.draft).toHaveLength(1);
    await b.planningAddChange({ kind: "create_feature", temp_id: -2, title: "Again", target_date: null, description: null });
    await act(async () => { await emit("state-changed", { entity: "planning" }); });
    await act(async () => {});
    expect(result.current.draft).toHaveLength(2);
    await b.planningAddChange({ kind: "create_feature", temp_id: -3, title: "Ignored", target_date: null, description: null });
    await act(async () => { await emit("state-changed", { entity: "workstream" }); });
    expect(result.current.draft).toHaveLength(2);
  });

  it("never drops a change made meanwhile: a stale replacement is refused and the draft reloaded", async () => {
    const b = backend();
    await b.planningConnect(LINK);
    const { result } = renderHook(() => usePlanning(b, true));
    await act(async () => {});
    await act(async () => { await result.current.addChange({ kind: "create_feature", temp_id: -1, title: "Mine", target_date: null, description: null }); });
    await b.planningAddChange({ kind: "create_feature", temp_id: -2, title: "The CLI's", target_date: null, description: null });
    await act(async () => { await expect(result.current.setDraft([])).rejects.toThrow("changed meanwhile"); });
    expect(result.current.draft.map((c) => "title" in c && c.title)).toEqual(["Mine", "The CLI's"]);
    await act(async () => { await result.current.setDraft([]); });
    expect((await b.planningState()).draft).toEqual([]);
  });

  it("keeps a Hide made while a refresh is in flight", async () => {
    const b = backend();
    await b.planningConnect(LINK);
    b.seedPlanningPrs([{ id: 1, title: "PR 1", project: "P", project_id: "p", repo: "P/r", repo_id: "r", status: "active", draft: false, mine: true, created: new Date().toISOString() }]);
    const { result } = renderHook(() => usePlanning(b, true));
    await act(async () => {});
    // The refresh's read happened before the Hide, and answers after it.
    const stale = await b.planningOrphans();
    let release!: () => void;
    vi.spyOn(b, "planningOrphans").mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(stale); }));
    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refresh(); });
    await act(async () => { await result.current.hideOrphan("pr", "1", "PR 1"); });
    expect(result.current.orphans?.hidden.prs).toHaveLength(1);
    await act(async () => { release(); await refreshing; });
    expect(result.current.orphans?.hidden.prs).toHaveLength(1);
  });

  it("selects a sprint, keeps the draft, and publishes", async () => {
    const b = backend();
    await b.planningConnect(LINK);
    const { result } = renderHook(() => usePlanning(b, true));
    await act(async () => {});
    await act(async () => { await result.current.selectSprint("OneWork\\S22"); });
    expect((await b.planningState()).selected_sprint).toBe("OneWork\\S22");
    await act(async () => { await result.current.addChange({ kind: "create_feature", temp_id: -1, title: "F", target_date: null, description: null }); });
    expect(result.current.draft).toHaveLength(1);
    await act(async () => { await result.current.publish(); });
    expect(result.current.draft).toHaveLength(0);
    expect(result.current.lastPublish?.written).toHaveLength(1);
    await act(async () => { await result.current.setDraft([]); });
    expect(result.current.draft).toEqual([]);
  });
});

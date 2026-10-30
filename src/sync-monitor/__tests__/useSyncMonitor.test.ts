import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { useSyncMonitor } from "../useSyncMonitor";
import { emit } from "../../test-shims/tauri-event-shim";
import { cpu, vitals } from "./fixtures";

vi.mock("@tauri-apps/api/event", () => import("../../test-shims/tauri-event-shim"));

const TWO_MIN = 2 * 60_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T12:00:00Z")); });
afterEach(() => vi.useRealTimers());

async function tick(ms = TWO_MIN) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("useSyncMonitor", () => {
  it("does nothing without a sync server", async () => {
    const b = new MemoryBackend();
    const { result } = renderHook(() => useSyncMonitor(b));
    await tick(0);
    expect(result.current.state?.configured).toBe(false);
    expect((await b.syncMonitorState()).checks).toEqual([]);
  });

  it("checks every two minutes, alerts once when the server is down twice, and once when it's back", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example" });
    const { result } = renderHook(() => useSyncMonitor(b));
    await tick(0);
    expect(result.current.state?.checks).toHaveLength(1);
    b.setSyncHealth("down");
    await tick();
    expect(b.syncNotifications()).toEqual([]);
    await tick();
    expect(b.syncNotifications().map((e) => [e.kind, e.event])).toEqual([["unreachable", "started"]]);
    await tick(3 * TWO_MIN);
    expect(b.syncNotifications()).toHaveLength(1);
    expect(result.current.state?.problems.map((p) => p.kind)).toEqual(["unreachable"]);
    b.setSyncHealth("ok");
    await tick();
    expect(b.syncNotifications().map((e) => e.event)).toEqual(["started", "resolved"]);
    expect(result.current.state?.events.map((e) => e.event)).toEqual(["resolved", "started"]);
    expect(result.current.state?.problems).toEqual([]);
  });

  it("reads vitals once a key is set, applies changed thresholds, and respects mutes", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example", monitorKey: "m", vitals: cpu(85) });
    const { result } = renderHook(() => useSyncMonitor(b));
    await tick(0);
    expect(result.current.state?.checks[0].vitals).toBeNull();
    await act(async () => { await result.current.setKey("m"); });
    await tick();
    await tick();
    expect(b.syncNotifications().map((e) => e.kind)).toEqual(["cpu"]);
    await act(async () => { await result.current.setThresholds({ cpuPercent: 90 }); });
    expect(b.syncNotifications().map((e) => e.event)).toEqual(["started", "resolved"]);
    await act(async () => { await result.current.mute("cpu"); });
    b.setSyncVitals(cpu(95));
    await tick(3 * TWO_MIN);
    expect(b.syncNotifications()).toHaveLength(2);
    expect(result.current.state?.problems.map((p) => p.kind)).toEqual(["cpu"]);
    b.setSyncVitals(vitals());
  });

  it("never alerts twice when an agent's change and a check overlap", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example", monitorKey: "m", vitals: vitals({ disk: { freeBytes: 2 ** 30, totalBytes: 2 ** 34 } }) });
    await b.syncMonitorSetKey("m");
    renderHook(() => useSyncMonitor(b));
    await act(async () => {
      await Promise.all([emit("state-changed", { entity: "sync" }), vi.advanceTimersByTimeAsync(0), emit("state-changed", { entity: "sync" })]);
    });
    await tick(0);
    expect(b.syncNotifications().map((e) => e.kind)).toEqual(["disk"]);
    expect((await b.syncMonitorState()).events).toHaveLength(1);
  });

  it("doesn't alert for a kind muted while the evaluation was running", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example", monitorKey: "m", vitals: vitals({ disk: { freeBytes: 2 ** 30, totalBytes: 2 ** 34 } }) });
    await b.syncMonitorSetKey("m");
    const read = b.syncMonitorState.bind(b);
    vi.spyOn(b, "syncMonitorState").mockImplementationOnce(async () => {
      const snapshot = await read();
      await b.syncMonitorMute("disk", 24);
      return snapshot;
    });
    renderHook(() => useSyncMonitor(b));
    await tick(0);
    expect(b.syncNotifications()).toEqual([]);
    expect((await b.syncMonitorState()).events).toEqual([]);
  });

  it("reloads when an agent mutes something", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example" });
    const { result } = renderHook(() => useSyncMonitor(b));
    await tick(0);
    await b.syncMonitorMute("disk", 24);
    await act(async () => { await emit("state-changed", { entity: "sync" }); });
    await tick(0);
    expect(Object.keys(result.current.state?.mutes ?? {})).toEqual(["disk"]);
  });
});

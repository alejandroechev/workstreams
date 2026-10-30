import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../../backend/memory-backend";
import { SyncPanel } from "../SyncPanel";
import { useSyncMonitor } from "../useSyncMonitor";
import { cpu, vitals } from "./fixtures";
import type { SyncCheck } from "../../domain/sync-monitor";

vi.mock("@tauri-apps/api/event", () => import("../../test-shims/tauri-event-shim"));

const NOW = Date.parse("2026-10-30T12:00:00Z");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

function Harness({ backend }: { backend: MemoryBackend }) {
  const monitor = useSyncMonitor(backend);
  return <SyncPanel monitor={monitor} onClose={() => {}} />;
}

const stored = (minutesAgo: number, percent: number): SyncCheck => ({
  at: NOW - minutesAgo * 60_000, reachable: true, latency_ms: 80, error: null, vitals: cpu(percent), vitals_error: null,
});

describe("the Sync server panel", () => {
  it("shows only reachability until a monitor key is set, then the vitals", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example", monitorKey: "m", vitals: vitals() });
    render(<Harness backend={b} />);
    expect(await screen.findByTestId("sync-vitals-missing")).toHaveTextContent("Add a monitor key");
    expect(screen.getByTestId("sync-reachability")).toHaveTextContent("Answered in 90 ms");
    fireEvent.change(screen.getByTestId("sync-key-input"), { target: { value: "m" } });
    await act(async () => { fireEvent.click(screen.getByTestId("sync-key-save")); });
    const values = await screen.findByTestId("sync-vitals-values");
    expect(values).toHaveTextContent("CPU 2%");
    expect(values).toHaveTextContent("540 MB free");
    expect(values).toHaveTextContent("Disk 5.6 GB free");
    expect(values).toHaveTextContent("Rejected logins 0 / 5 min");
    expect(screen.getByTestId("sync-doc-4RGYp")).toHaveTextContent("Pagos+ — 1.7 MB");
  });

  it("says why vitals are missing when the key is wrong", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example", monitorKey: "m", vitals: vitals() });
    await b.syncMonitorSetKey("wrong");
    render(<Harness backend={b} />);
    await waitFor(() => expect(screen.getByTestId("sync-vitals-missing")).toHaveTextContent("Invalid monitor key"));
  });

  it("draws 24 hours of history, lists problems with a mute, and recent alerts", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example", monitorKey: "m", vitals: cpu(95) });
    await b.syncMonitorSetKey("m");
    b.seedSyncChecks([stored(25 * 60, 3), stored(6, 92), stored(4, 93), stored(2, 94)]);
    render(<Harness backend={b} />);
    await screen.findByTestId("sync-problem-cpu");
    expect(screen.getByTestId("sync-spark-cpu").getAttribute("data-points")).toBe("4");
    expect(screen.getByTestId("sync-recent-alerts")).toHaveTextContent("CPU high");
    await act(async () => { fireEvent.click(screen.getByTestId("sync-mute-cpu")); });
    expect(await screen.findByTestId("sync-muted-cpu")).toHaveTextContent("muted until");
  });

  it("edits thresholds", async () => {
    const b = new MemoryBackend();
    b.seedSyncServer({ url: "https://sync.example" });
    render(<Harness backend={b} />);
    const field = await screen.findByTestId("sync-threshold-cpuPercent");
    expect(field).toHaveValue("80");
    fireEvent.change(field, { target: { value: "90" } });
    await act(async () => { fireEvent.click(screen.getByTestId("sync-thresholds-save")); });
    expect((await b.syncMonitorState()).thresholds).toEqual({ cpuPercent: 90 });
    fireEvent.change(field, { target: { value: "abc" } });
    await act(async () => { fireEvent.click(screen.getByTestId("sync-thresholds-save")); });
    expect(screen.getByRole("alert")).toHaveTextContent("not a number");
  });

  it("explains when no sync server is configured", async () => {
    render(<Harness backend={new MemoryBackend()} />);
    expect(await screen.findByText(/No sync server is configured/)).toBeInTheDocument();
  });
});

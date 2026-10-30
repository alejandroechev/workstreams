// @test-skip: test fixtures
import type { SyncVitals } from "../../domain/sync-monitor";

/** Healthy vitals for the in-memory sync server; override what a test needs. */
export function vitals(over: Partial<SyncVitals> = {}): SyncVitals {
  return {
    box: { cpuPercent: 2, memory: { totalBytes: 1e9, availableBytes: 540 * 2 ** 20, swapTotalBytes: 2.4e9, swapUsedBytes: 9e7 } },
    process: { cpuPercent: 1, rssBytes: 370 * 2 ** 20 },
    disk: { freeBytes: 5.6 * 2 ** 30, totalBytes: 23 * 2 ** 30 },
    rejectedLogins: { last5Minutes: 0 },
    storage: { automerge: { bytes: 3.4e6, files: 470 }, blobs: { bytes: 2.7e8, files: 102 }, docCount: 20 },
    docs: [
      { docId: "4RGYp", appName: "Pagos+", sizeBytes: 1.8e6, growthBytes24h: 0, modifiedAt: "" },
      { docId: "2kBad", appName: "Workstreams companion", sizeBytes: 72_000, growthBytes24h: 0, modifiedAt: "" },
    ],
    ...over,
  };
}

export const cpu = (percent: number) => vitals({ box: { ...vitals().box, cpuPercent: percent } });

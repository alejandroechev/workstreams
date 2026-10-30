import { describe, it, expect } from "vitest";
import {
  activeProblems,
  DEFAULT_THRESHOLDS,
  statusLevel,
  thresholdsFrom,
  transition,
  type SyncCheck,
  type SyncProblem,
  type SyncVitals,
} from "../sync-monitor";

const MIN = 60_000;
const vitals = (over: Partial<SyncVitals> = {}): SyncVitals => ({
  box: { cpuPercent: 5, memory: { totalBytes: 1e9, availableBytes: 500 * 2 ** 20, swapTotalBytes: 2e9, swapUsedBytes: 1e8 } },
  process: { cpuPercent: 3, rssBytes: 1e8 },
  disk: { freeBytes: 5 * 2 ** 30, totalBytes: 24 * 2 ** 30 },
  rejectedLogins: { last5Minutes: 0 },
  storage: { automerge: { bytes: 3e6, files: 10 }, blobs: { bytes: 2e8, files: 100 }, docCount: 20 },
  docs: [{ docId: "2kBad", appName: "Workstreams companion", sizeBytes: 72_000, growthBytes24h: 0, modifiedAt: "" }],
  ...over,
});
const ok = (at: number, v: SyncVitals | null = vitals()): SyncCheck => ({ at, reachable: true, latency_ms: 90, error: null, vitals: v, vitals_error: null });
const down = (at: number): SyncCheck => ({ at, reachable: false, latency_ms: 0, error: "No answer within 10 s", vitals: null, vitals_error: null });
const kinds = (checks: SyncCheck[], t = DEFAULT_THRESHOLDS) => activeProblems(checks, t).map((p) => p.kind);

describe("which problems a run of checks shows", () => {
  it("calls the server unreachable after 2 bad checks in a row, a slow answer counting as bad", () => {
    expect(kinds([ok(0), down(2 * MIN)])).toEqual([]);
    expect(kinds([ok(0), down(2 * MIN), down(4 * MIN)])).toEqual(["unreachable"]);
    expect(kinds([down(0), { ...ok(2 * MIN), latency_ms: 6000 }])).toEqual(["unreachable"]);
    expect(kinds([down(0), { ...ok(2 * MIN), latency_ms: 5000 }])).toEqual([]);
  });

  it("doesn't count a sleep gap as consecutive", () => {
    expect(kinds([down(0), down(60 * MIN)])).toEqual([]);
  });

  it("raises CPU only after 3 checks over the threshold, never at it", () => {
    const cpu = (at: number, c: number) => ok(at, vitals({ box: { cpuPercent: c, memory: vitals().box.memory } }));
    expect(kinds([cpu(0, 92), cpu(2 * MIN, 95)])).toEqual([]);
    expect(kinds([cpu(0, 92), cpu(2 * MIN, 95), cpu(4 * MIN, 405)])).toEqual(["cpu"]);
    expect(kinds([cpu(0, 80), cpu(2 * MIN, 80), cpu(4 * MIN, 80)])).toEqual([]);
    expect(kinds([cpu(0, 85), cpu(2 * MIN, 85), cpu(4 * MIN, 85)], { ...DEFAULT_THRESHOLDS, cpuPercent: 90 })).toEqual([]);
  });

  it("raises memory, disk, rejected logins, and size or growth naming the app", () => {
    const v = vitals({
      box: { cpuPercent: 5, memory: { totalBytes: 1e9, availableBytes: 90 * 2 ** 20, swapTotalBytes: 2e9, swapUsedBytes: 1.2e9 } },
      disk: { freeBytes: 1.5 * 2 ** 30, totalBytes: 24 * 2 ** 30 },
      rejectedLogins: { last5Minutes: 25 },
      docs: [
        { docId: "2kBad", appName: "Workstreams companion", sizeBytes: 900_000, growthBytes24h: 1.4 * 2 ** 20, modifiedAt: "" },
        { docId: "zzz", appName: null, sizeBytes: 3 * 2 ** 20, growthBytes24h: 0, modifiedAt: "" },
      ],
    });
    const problems = activeProblems([ok(0, v)], DEFAULT_THRESHOLDS);
    expect(problems.map((p) => p.kind).sort()).toEqual(["disk", "doc_growth:2kBad", "doc_size:zzz", "logins", "memory"]);
    expect(problems.find((p) => p.kind === "doc_growth:2kBad")?.message).toContain("Workstreams companion");
    expect(problems.find((p) => p.kind === "doc_size:zzz")?.message).toContain("unknown app");
    expect(problems.every((p) => p.hint.length > 0)).toBe(true);
  });

  it("reads nothing from vitals when the latest check has none", () => {
    expect(kinds([ok(0, null)])).toEqual([]);
  });

  it("keeps an open vitals problem while vitals are missing, until fresh vitals show recovery", () => {
    const low = vitals({ disk: { freeBytes: 1 * 2 ** 30, totalBytes: 2 ** 34 } });
    const open = activeProblems([ok(0, low)], DEFAULT_THRESHOLDS).map((p) => ({ ...p, started_at: 0 }));
    expect(open.map((p) => p.kind)).toEqual(["disk"]);
    const noVitals = { ...ok(2 * MIN, null), vitals_error: "Invalid monitor key" };
    expect(activeProblems([ok(0, low), noVitals], DEFAULT_THRESHOLDS, open).map((p) => p.kind)).toEqual(["disk"]);
    expect(activeProblems([ok(0, low), down(2 * MIN), down(4 * MIN)], DEFAULT_THRESHOLDS, open).map((p) => p.kind).sort()).toEqual(["disk", "unreachable"]);
    expect(activeProblems([ok(0, low), ok(2 * MIN)], DEFAULT_THRESHOLDS, open)).toEqual([]);
  });

  it("keeps CPU open while it stays high, even if a vitals gap broke the run", () => {
    const high = (at: number) => ok(at, vitals({ box: { cpuPercent: 95, memory: vitals().box.memory } }));
    const open = [{ kind: "cpu", severity: "critical" as const, started_at: 0, message: "", hint: "" }];
    expect(activeProblems([high(0), ok(2 * MIN, null), high(4 * MIN)], DEFAULT_THRESHOLDS, open).map((p) => p.kind)).toEqual(["cpu"]);
  });
});

describe("alerting once per problem", () => {
  const cpuProblem = { kind: "cpu", severity: "critical" as const, message: "CPU 405%", hint: "h" };

  it("opens with a started event and a notification, stays quiet, then resolves once", () => {
    const first = transition([], [cpuProblem], {}, 1000);
    expect(first.problems).toEqual([{ ...cpuProblem, started_at: 1000 }]);
    expect(first.events.map((e) => e.event)).toEqual(["started"]);
    expect(first.notify).toEqual(first.events);
    const again = transition(first.problems, [{ ...cpuProblem, message: "CPU 300%" }], {}, 2000);
    expect(again.events).toEqual([]);
    expect(again.problems[0]).toMatchObject({ started_at: 1000, message: "CPU 300%" });
    const resolved = transition(again.problems, [], {}, 3000);
    expect(resolved.problems).toEqual([]);
    expect(resolved.events).toMatchObject([{ kind: "cpu", event: "resolved", at: 3000 }]);
    expect(resolved.notify).toHaveLength(1);
  });

  it("keeps a muted kind's problem but records and notifies nothing", () => {
    const muted = transition([], [cpuProblem], { cpu: 5000 }, 1000);
    expect(muted.problems).toHaveLength(1);
    expect([muted.events, muted.notify]).toEqual([[], []]);
    const cleared = transition(muted.problems, [], { cpu: 5000 }, 2000);
    expect(cleared.events).toEqual([]);
    const later = transition([], [cpuProblem], { cpu: 5000 }, 6000);
    expect(later.events).toHaveLength(1);
  });
});

describe("the status dot and settings", () => {
  const p = (kind: string, severity: SyncProblem["severity"]): SyncProblem => ({ kind, severity, started_at: 0, message: "", hint: "" });
  it("is off, green, yellow or red", () => {
    expect(statusLevel(false, [])).toBe("off");
    expect(statusLevel(true, [])).toBe("ok");
    expect(statusLevel(true, [p("doc_size:a", "warning")])).toBe("warning");
    expect(statusLevel(true, [p("doc_size:a", "warning"), p("unreachable", "critical")])).toBe("critical");
  });
  it("fills unset thresholds with the defaults and ignores nonsense", () => {
    expect(thresholdsFrom({ cpuPercent: 90, maxDocMB: "x" })).toEqual({ ...DEFAULT_THRESHOLDS, cpuPercent: 90 });
  });
});

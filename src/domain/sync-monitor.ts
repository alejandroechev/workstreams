/**
 * Sync server monitoring (ADR 040): which problems a run of checks shows, and
 * when to alert. The checks, problems and events are stored natively
 * (`src-tauri/src/sync_monitor.rs`); these rules decide what they mean.
 */

export interface SyncMemory {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface SyncDoc {
  docId: string;
  appName: string | null;
  sizeBytes: number;
  growthBytes24h: number;
  modifiedAt: string;
}

/** What the server's `/health/vitals` returns. */
export interface SyncVitals {
  box: { cpuPercent: number | null; memory: SyncMemory | null };
  process: { cpuPercent: number; rssBytes: number };
  disk: { freeBytes: number; totalBytes: number } | null;
  rejectedLogins: { last5Minutes: number };
  storage: { automerge: { bytes: number; files: number }; blobs: { bytes: number; files: number }; docCount: number };
  docs: SyncDoc[];
}

export interface SyncCheck {
  at: number;
  reachable: boolean;
  latency_ms: number;
  error: string | null;
  vitals: SyncVitals | null;
  vitals_error: string | null;
}

export type Severity = "critical" | "warning";

/** A problem the latest checks show, before it has a start time. */
export interface ProblemDraft {
  kind: string;
  severity: Severity;
  message: string;
  hint: string;
}

export interface SyncProblem extends ProblemDraft {
  started_at: number;
}

export interface SyncEvent {
  id: string;
  kind: string;
  event: "started" | "resolved";
  at: number;
  message: string;
  hint: string;
  is_read: boolean;
}

export interface SyncThresholds {
  /** A /health answer slower than this counts as bad. */
  slowMs: number;
  unreachableChecks: number;
  cpuPercent: number;
  cpuChecks: number;
  minAvailableMB: number;
  maxSwapPercent: number;
  minDiskFreeGB: number;
  maxRejectedLogins: number;
  maxDocMB: number;
  maxDocGrowthMB: number;
}

export interface SyncMonitorState {
  configured: boolean;
  server_url: string | null;
  has_key: boolean;
  thresholds: Partial<SyncThresholds>;
  /** Base problem kind → muted until (ms). */
  mutes: Record<string, number>;
  checks: SyncCheck[];
  problems: SyncProblem[];
  events: SyncEvent[];
}

export const DEFAULT_THRESHOLDS: SyncThresholds = {
  slowMs: 5000,
  unreachableChecks: 2,
  cpuPercent: 80,
  cpuChecks: 3,
  minAvailableMB: 100,
  maxSwapPercent: 50,
  minDiskFreeGB: 2,
  maxRejectedLogins: 20,
  maxDocMB: 2,
  maxDocGrowthMB: 1,
};

/** What each threshold means, for settings. */
export const THRESHOLD_LABELS: Record<keyof SyncThresholds, string> = {
  slowMs: "Slow answer (ms)",
  unreachableChecks: "Bad checks before \"unreachable\"",
  cpuPercent: "CPU over (%)",
  cpuChecks: "…for this many checks",
  minAvailableMB: "Free memory under (MB)",
  maxSwapPercent: "Swap over (%)",
  minDiskFreeGB: "Free disk under (GB)",
  maxRejectedLogins: "Rejected logins in 5 min over",
  maxDocMB: "A document over (MB)",
  maxDocGrowthMB: "A document growing in a day over (MB)",
};

/** The checks run every 2 minutes; a longer gap (the laptop slept) breaks a run. */
export const CHECK_INTERVAL_MS = 2 * 60_000;
const GAP_MS = 6 * 60_000;
const MB = 2 ** 20;
const GB = 2 ** 30;

export const MUTE_KINDS = ["unreachable", "cpu", "memory", "disk", "logins", "doc_size", "doc_growth"] as const;

export const baseKind = (kind: string) => kind.split(":")[0];

export function thresholdsFrom(raw: Partial<Record<keyof SyncThresholds, unknown>> | null | undefined): SyncThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(out) as Array<keyof SyncThresholds>) {
    const value = raw?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/** The newest checks, newest first, as long as they follow each other without a sleep gap. */
function recentRun(checks: SyncCheck[]): SyncCheck[] {
  const sorted = [...checks].sort((a, b) => b.at - a.at);
  const run: SyncCheck[] = [];
  for (const check of sorted) {
    if (run.length > 0 && run[run.length - 1].at - check.at > GAP_MS) break;
    run.push(check);
  }
  return run;
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
const cpuOf = (v: SyncVitals) => v.box.cpuPercent ?? v.process.cpuPercent;

const HINTS = {
  unreachable: "Every app that syncs is affected. On the VPS check `docker compose ps` and the server's CPU: a client pushing a document with a huge history can stall it.",
  cpu: "A client may be syncing a document with a huge history: see Largest documents in the Sync server panel, and which app grew.",
  memory: "The server may be loading a large document, or the box is short on RAM. Restart the sync server; if it recurs, find the growing document.",
  disk: "Blobs and documents fill the data volume: check /data on the VPS (`du -sh /data/*`).",
  logins: "Devices are being refused: their tokens aren't accepted. Check data/devices.json on the server (and devices.json.bak).",
  doc: "Large histories slow every sync of that app. Look for an app rewriting whole values on every change.",
};

const VITALS_KINDS = new Set(["cpu", "memory", "disk", "logins", "doc_size", "doc_growth"]);

/**
 * The problems the stored checks show now. `open` are the problems already
 * open: when the latest check brought no vitals (unreachable, or the vitals
 * failed), nothing is known about them, so they stay open rather than read as
 * recovered.
 */
export function activeProblems(checks: SyncCheck[], t: SyncThresholds, open: SyncProblem[] = []): ProblemDraft[] {
  const run = recentRun(checks);
  if (run.length === 0) return [];
  const carried = (): ProblemDraft[] =>
    open.filter((p) => VITALS_KINDS.has(baseKind(p.kind))).map(({ kind, severity, message, hint }) => ({ kind, severity, message, hint }));
  const out: ProblemDraft[] = [];
  const bad = (c: SyncCheck) => !c.reachable || c.latency_ms > t.slowMs;
  const firstBad = run.slice(0, t.unreachableChecks);
  if (firstBad.length >= t.unreachableChecks && firstBad.every(bad)) {
    const latest = run[0];
    out.push({
      kind: "unreachable",
      severity: "critical",
      message: latest.reachable ? `Sync server slow (${round(latest.latency_ms / 1000)} s to answer)` : `Sync server unreachable (${latest.error ?? "no answer"})`,
      hint: HINTS.unreachable,
    });
  }
  const latest = run[0].vitals;
  if (!run[0].reachable || !latest) return [...out, ...carried()];

  const cpuRun = run.slice(0, t.cpuChecks);
  const cpuOpen = open.some((p) => p.kind === "cpu");
  // Raised after enough high checks in a row; once open, it stays while the latest is high.
  if ((cpuOpen && cpuOf(latest) > t.cpuPercent)
    || (cpuRun.length >= t.cpuChecks && cpuRun.every((c) => c.vitals && cpuOf(c.vitals) > t.cpuPercent))) {
    out.push({ kind: "cpu", severity: "critical", message: `Sync server CPU high (${round(cpuOf(latest))}%)`, hint: HINTS.cpu });
  }
  const mem = latest.box.memory;
  if (mem) {
    const freeMB = mem.availableBytes / MB;
    const swapPercent = mem.swapTotalBytes > 0 ? (mem.swapUsedBytes / mem.swapTotalBytes) * 100 : 0;
    if (freeMB < t.minAvailableMB || swapPercent > t.maxSwapPercent) {
      out.push({
        kind: "memory",
        severity: "critical",
        message: `Sync server low on memory (${Math.round(freeMB)} MB free, swap ${Math.round(swapPercent)}%)`,
        hint: HINTS.memory,
      });
    }
  }
  if (latest.disk && latest.disk.freeBytes / GB < t.minDiskFreeGB) {
    out.push({ kind: "disk", severity: "critical", message: `Sync server disk low (${round(latest.disk.freeBytes / GB)} GB free)`, hint: HINTS.disk });
  }
  if (latest.rejectedLogins.last5Minutes > t.maxRejectedLogins) {
    out.push({
      kind: "logins",
      severity: "critical",
      message: `Sync server rejected ${latest.rejectedLogins.last5Minutes} logins in 5 minutes`,
      hint: HINTS.logins,
    });
  }
  for (const doc of latest.docs) {
    const app = doc.appName ?? "unknown app";
    if (doc.sizeBytes / MB > t.maxDocMB) {
      out.push({ kind: `doc_size:${doc.docId}`, severity: "warning", message: `${app} document is ${round(doc.sizeBytes / MB)} MB`, hint: HINTS.doc });
    }
    if (doc.growthBytes24h / MB > t.maxDocGrowthMB) {
      out.push({ kind: `doc_growth:${doc.docId}`, severity: "warning", message: `${app} document grew ${round(doc.growthBytes24h / MB)} MB today`, hint: HINTS.doc });
    }
  }
  return out;
}

/**
 * From the open problems to what the checks show now: problems that start get
 * a "started" event, problems that clear a "resolved" one, both notified,
 * unless their kind is muted. Problems that continue keep their start time.
 */
export function transition(
  open: SyncProblem[],
  active: ProblemDraft[],
  mutes: Record<string, number>,
  now: number,
): { problems: SyncProblem[]; events: SyncEvent[]; notify: SyncEvent[] } {
  const muted = (kind: string) => (mutes[baseKind(kind)] ?? 0) > now;
  const before = new Map(open.map((p) => [p.kind, p]));
  const problems: SyncProblem[] = active.map((p) => ({ ...p, started_at: before.get(p.kind)?.started_at ?? now }));
  const events: SyncEvent[] = [];
  for (const p of problems) {
    if (!before.has(p.kind) && !muted(p.kind)) {
      events.push({ id: `${p.kind}-${now}-started`, kind: p.kind, event: "started", at: now, message: p.message, hint: p.hint, is_read: false });
    }
  }
  const still = new Set(active.map((p) => p.kind));
  for (const p of open) {
    if (!still.has(p.kind) && !muted(p.kind)) {
      events.push({ id: `${p.kind}-${now}-resolved`, kind: p.kind, event: "resolved", at: now, message: `Resolved: ${p.message}`, hint: "Back to normal.", is_read: false });
    }
  }
  return { problems, events, notify: events };
}

export type StatusLevel = "off" | "ok" | "warning" | "critical";

export function statusLevel(configured: boolean, problems: SyncProblem[]): StatusLevel {
  if (!configured) return "off";
  if (problems.some((p) => p.severity === "critical")) return "critical";
  return problems.length > 0 ? "warning" : "ok";
}

export const STATUS_COLORS: Record<StatusLevel, string> = {
  off: "#6c7086",
  ok: "#a6e3a1",
  warning: "#f9e2af",
  critical: "#f38ba8",
};

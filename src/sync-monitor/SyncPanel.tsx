import { useEffect, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";
import {
  baseKind,
  DEFAULT_THRESHOLDS,
  statusLevel,
  STATUS_COLORS,
  THRESHOLD_LABELS,
  thresholdsFrom,
  type SyncCheck,
  type SyncThresholds,
} from "../domain/sync-monitor";
import type { SyncMonitor } from "./useSyncMonitor";

const C = { base: "#1e1e2e", mantle: "#181825", crust: "#11111b", surface0: "#313244", surface1: "#45475a", text: "#cdd6f4", sub: "#a6adc8", muted: "#6c7086", red: "#f38ba8", peach: "#fab387", blue: "#89b4fa" };
const button: React.CSSProperties = { padding: "3px 10px", fontSize: 11, color: C.text, background: C.mantle, border: `1px solid ${C.surface1}`, borderRadius: 4, cursor: "pointer", fontFamily: "inherit" };
const input: React.CSSProperties = { padding: "3px 6px", fontSize: 11, color: C.text, background: C.mantle, border: `1px solid ${C.surface1}`, borderRadius: 4, fontFamily: "inherit" };
const card: React.CSSProperties = { background: C.mantle, border: `1px solid ${C.surface0}`, borderRadius: 6, padding: "8px 10px" };
const label: React.CSSProperties = { fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 };

const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(bytes < 10 * 2 ** 20 ? 1 : 0)} MB`;
const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)} GB`;
const when = (at: number) => new Date(at).toLocaleString();

/** A small line over the last 24 hours of checks. */
function Sparkline({ testId, checks, value, max }: { testId: string; checks: SyncCheck[]; value: (c: SyncCheck) => number | null; max?: number }) {
  const points = checks.map((c) => [c.at, value(c)] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  const width = 260;
  const height = 28;
  if (points.length < 2) return <svg data-testid={testId} data-points={points.length} width={width} height={height} />;
  const t0 = points[0][0];
  const span = Math.max(1, points[points.length - 1][0] - t0);
  const top = Math.max(max ?? 0, ...points.map((p) => p[1]), 1);
  const path = points.map(([t, v]) => `${(((t - t0) / span) * width).toFixed(1)},${(height - (v / top) * (height - 2) - 1).toFixed(1)}`).join(" ");
  return (
    <svg data-testid={testId} data-points={points.length} width={width} height={height} style={{ background: C.crust, borderRadius: 3 }}>
      <polyline points={path} fill="none" stroke={C.blue} strokeWidth={1.2} />
    </svg>
  );
}

interface Props {
  monitor: SyncMonitor;
  onClose: () => void;
}

/**
 * The sync server at a glance (ADR 040): current vitals, the last 24 hours of
 * checks, the largest documents by app, recent alerts, and the monitor's settings.
 */
export function SyncPanel({ monitor, onClose }: Props) {
  const { state } = monitor;
  const [key, setKey] = useState("");
  const [draft, setDraft] = useState<Partial<Record<keyof SyncThresholds, string>>>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await action(); } catch (failure) { setActionError(String(failure instanceof Error ? failure.message : failure)); } finally { setBusy(false); }
  };

  const level = statusLevel(!!state?.configured, state?.problems ?? []);
  const checks = state?.checks ?? [];
  const latest = checks[checks.length - 1];
  const vitals = [...checks].reverse().find((c) => c.vitals)?.vitals ?? null;
  const thresholds = thresholdsFrom(state?.thresholds);
  // The stored mutes are the ones still in force.
  const mutedUntil = (kind: string) => state?.mutes[baseKind(kind)];
  const memory = vitals?.box.memory;

  const saveThresholds = () => act(async () => {
    const next: Partial<SyncThresholds> = { ...(state?.thresholds ?? {}) };
    for (const [k, text] of Object.entries(draft) as Array<[keyof SyncThresholds, string]>) {
      const n = Number(text);
      if (text.trim() === "") delete next[k];
      else if (Number.isFinite(n) && n >= 0) next[k] = n;
      else throw new Error(`${THRESHOLD_LABELS[k]}: not a number`);
    }
    await monitor.setThresholds(next);
    setDraft({});
  });

  return (
    <div data-testid="sync-panel" role="dialog" aria-label="Sync server" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(17,17,27,0.6)", zIndex: 1900, display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: 48 }}>
      <section onClick={(e) => e.stopPropagation()}
        style={{ width: 640, maxWidth: "94vw", maxHeight: "86vh", overflowY: "auto", background: C.base, color: C.text, border: `1px solid ${C.surface0}`, borderRadius: 8, fontSize: 12 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${C.surface0}` }}>
          <span data-testid="sync-panel-level" data-level={level} style={{ width: 10, height: 10, borderRadius: "50%", background: STATUS_COLORS[level] }} />
          <b style={{ fontSize: 14 }}>Sync server</b>
          <span style={{ color: C.muted }}>{state?.server_url ?? "not configured"}</span>
          <span style={{ flex: 1 }} />
          <button data-testid="sync-check-now" disabled={busy || !state?.configured} onClick={() => void act(monitor.check)} style={button}>Check now</button>
          <button aria-label="Close" onClick={onClose} style={{ ...button, border: "none", background: "none" }}><XMarkIcon width={16} height={16} /></button>
        </header>

        <div style={{ padding: "10px 14px", display: "grid", gap: 10 }}>
          {!state?.configured && <p style={{ color: C.sub, margin: 0 }}>No sync server is configured. Set one up in Settings → Companion.</p>}
          {(monitor.error || actionError) && <p role="alert" style={{ color: C.red, margin: 0 }}>{actionError ?? monitor.error}</p>}

          {state?.configured && (
            <>
              <div data-testid="sync-reachability" style={card}>
                <div style={label}>Reachability</div>
                {latest ? (
                  <span>{latest.reachable ? `Answered in ${latest.latency_ms} ms` : `Unreachable: ${latest.error}`} · last check {when(latest.at)}</span>
                ) : <span style={{ color: C.sub }}>Checking…</span>}
                <Sparkline testId="sync-spark-latency" checks={checks} value={(c) => (c.reachable ? c.latency_ms : null)} />
              </div>

              {!state.has_key || !vitals ? (
                <p data-testid="sync-vitals-missing" style={{ ...card, color: C.sub, margin: 0 }}>
                  {!state.has_key
                    ? "Add a monitor key below to see CPU, memory, disk, rejected logins and document sizes."
                    : latest?.vitals_error ?? "No vitals yet."}
                </p>
              ) : (
                <div data-testid="sync-vitals" style={{ ...card, display: "grid", gap: 6 }}>
                  <div style={label}>Vitals</div>
                  <div data-testid="sync-vitals-values" style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    <span>CPU {vitals.box.cpuPercent ?? "?"}% <span style={{ color: C.muted }}>(server {vitals.process.cpuPercent}%)</span></span>
                    {memory && <span>Memory {mb(memory.availableBytes)} free</span>}
                    {memory && memory.swapTotalBytes > 0 && <span>Swap {Math.round((memory.swapUsedBytes / memory.swapTotalBytes) * 100)}%</span>}
                    {vitals.disk && <span>Disk {gb(vitals.disk.freeBytes)} free</span>}
                    <span>Rejected logins {vitals.rejectedLogins.last5Minutes} / 5 min</span>
                  </div>
                  <div style={label}>CPU, last 24 h</div>
                  <Sparkline testId="sync-spark-cpu" checks={checks} value={(c) => c.vitals?.box.cpuPercent ?? c.vitals?.process.cpuPercent ?? null} max={100} />
                  <div style={label}>Free memory, last 24 h</div>
                  <Sparkline testId="sync-spark-memory" checks={checks} value={(c) => (c.vitals?.box.memory ? c.vitals.box.memory.availableBytes / 2 ** 20 : null)} />
                  <div style={label}>Largest documents</div>
                  <ul data-testid="sync-docs" style={{ margin: 0, paddingLeft: 16 }}>
                    {vitals.docs.slice(0, 8).map((d) => (
                      <li key={d.docId} data-testid={`sync-doc-${d.docId}`}>
                        {d.appName ?? "unknown app"} — {mb(d.sizeBytes)}
                        {d.growthBytes24h > 0 && <span style={{ color: C.peach }}> (+{mb(d.growthBytes24h)} today)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={card}>
                <div style={label}>Problems now</div>
                {state.problems.length === 0 && <span data-testid="sync-no-problems" style={{ color: C.sub }}>None.</span>}
                {state.problems.map((p) => (
                  <div key={p.kind} data-testid={`sync-problem-${p.kind}`} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                    <span style={{ color: p.severity === "critical" ? C.red : C.peach, flex: 1 }}>{p.message} <span style={{ color: C.muted }}>since {when(p.started_at)}</span></span>
                    {mutedUntil(p.kind) ? (
                      <span data-testid={`sync-muted-${baseKind(p.kind)}`} style={{ color: C.muted, fontSize: 11 }}>muted until {when(mutedUntil(p.kind)!)}</span>
                    ) : (
                      <button data-testid={`sync-mute-${baseKind(p.kind)}`} disabled={busy} onClick={() => void act(() => monitor.mute(p.kind, 24))} style={button}>Mute 24 h</button>
                    )}
                  </div>
                ))}
              </div>

              <div data-testid="sync-recent-alerts" style={card}>
                <div style={label}>Recent alerts</div>
                {state.events.length === 0 && <span style={{ color: C.sub }}>None.</span>}
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {state.events.slice(0, 10).map((e) => (
                    <li key={e.id} style={{ color: e.event === "resolved" ? C.sub : C.text }}>{when(e.at)} — {e.message}</li>
                  ))}
                </ul>
              </div>
            </>
          )}

          <div data-testid="sync-settings" style={card}>
            <div style={label}>Settings</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
              <span style={{ flex: "0 0 140px" }}>Monitor key</span>
              <input data-testid="sync-key-input" type="password" aria-label="Monitor key" value={key} onChange={(e) => setKey(e.target.value)}
                placeholder={state?.has_key ? "•••••••• (set)" : "MONITOR_KEY from the server's .env"} style={{ ...input, flex: 1 }} />
              <button data-testid="sync-key-save" disabled={busy || !key.trim()} onClick={() => void act(async () => { await monitor.setKey(key); setKey(""); })} style={button}>Save</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: 4, alignItems: "center" }}>
              {(Object.keys(DEFAULT_THRESHOLDS) as Array<keyof SyncThresholds>).map((k) => (
                <label key={k} style={{ display: "contents" }}>
                  <span style={{ color: C.sub }}>{THRESHOLD_LABELS[k]}</span>
                  <input data-testid={`sync-threshold-${k}`} inputMode="decimal" value={draft[k] ?? String(thresholds[k])}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={input} />
                </label>
              ))}
            </div>
            <div style={{ marginTop: 6 }}>
              <button data-testid="sync-thresholds-save" disabled={busy || Object.keys(draft).length === 0} onClick={() => void saveThresholds()} style={button}>Save thresholds</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

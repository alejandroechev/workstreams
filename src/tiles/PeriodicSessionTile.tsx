import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ClockIcon,
  CommandLineIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  PlayIcon,
  QuestionMarkCircleIcon,
} from "@heroicons/react/24/outline";
import {
  describeFrequency,
  formatNextRun,
  PAUSED_INTERACTIVE,
  resultLabel,
  type PeriodicRun,
  type PeriodicSchedule,
} from "../domain/periodic-schedules";
import { useTileSchedules } from "../schedules/context";

const COLORS: Record<string, string> = {
  ok: "#a6e3a1",
  failed: "#f38ba8",
  timed_out: "#f38ba8",
  needs_input: "#f9e2af",
  running: "#89b4fa",
  skipped: "#6c7086",
  interrupted: "#6c7086",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "Today 09:00", "Yesterday 09:00", or "Tue 24 Nov 09:00". */
export function formatRunStart(at: number, now: number): string {
  const when = new Date(at);
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(when)) / 86_400_000);
  if (days === 0) return `Today ${clock}`;
  if (days === 1) return `Yesterday ${clock}`;
  return `${when.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })} ${clock}`;
}

/** "3m 12s", "60m 0s"; a run still going counts up to now. */
export function formatDuration(run: Pick<PeriodicRun, "started_at" | "ended_at" | "status">, now: number): string {
  if (run.status === "skipped") return "skipped";
  const seconds = Math.max(0, Math.round(((run.ended_at ?? now) - run.started_at) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const runLabel = (run: PeriodicRun) =>
  run.status === "failed" && run.exit_code !== null ? `failed (exit ${run.exit_code})` : resultLabel(run.status);

function headerState(schedule: PeriodicSchedule, now: number): string {
  if (schedule.interactive_tile_id) return PAUSED_INTERACTIVE;
  if (schedule.paused) return "Paused";
  return `next: ${formatNextRun(schedule.next_run_at, now)}`;
}

const button = {
  display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid #45475a", borderRadius: 4, padding: "2px 8px",
  background: "#313244", color: "#cdd6f4", fontSize: 11, cursor: "pointer",
} as const;

/**
 * A Periodic session tile (ADR 046): no terminal. Its header shows the
 * schedule, the next run and the last result with Run now, Edit schedule and
 * Open interactively; below, the run log (newest first) and the selected
 * run's prompt, tool calls, final answer and needs-input question, live while
 * it streams; and a reply box that runs the next turn now.
 */
export default function PeriodicSessionTile({ tileId, workstreamId }: { tileId: string; workstreamId: string }) {
  const context = useTileSchedules();
  const schedule = context?.byTile.get(tileId) ?? null;
  const [runs, setRuns] = useState<PeriodicRun[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const listRuns = context?.listRuns;

  const load = useCallback(async () => {
    if (!listRuns) return;
    setRuns(await listRuns(tileId));
  }, [listRuns, tileId]);

  // Re-read when the schedule changes (a run started, ended or was skipped).
  const revision = schedule?.revision;
  useEffect(() => {
    void load().catch((e) => console.error("Failed to load the run log:", e));
  }, [load, revision]);

  useEffect(() => {
    const unlisten = listen<{ run?: PeriodicRun }>("periodic-run", (event) => {
      const live = event.payload?.run;
      if (!live || live.tile_id !== tileId) return;
      setRuns((current) => {
        const list = current ?? [];
        return list.some((r) => r.id === live.id) ? list.map((r) => (r.id === live.id ? live : r)) : [live, ...list];
      });
    });
    return () => { void unlisten.then((dispose) => dispose()).catch(() => {}); };
  }, [tileId]);

  const running = runs?.some((r) => r.status === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const current = useMemo(() => runs?.find((r) => r.id === selected) ?? runs?.[0] ?? null, [runs, selected]);

  if (!context || !schedule) {
    return <div data-testid="periodic-missing" style={{ padding: 16, color: "#6c7086", fontSize: 12 }}>This tile has no schedule.</div>;
  }
  const now = context.now;
  const interactive = !!schedule.interactive_tile_id;
  const act = (work: () => Promise<unknown>) => {
    setError(null);
    void work().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const send = () => {
    const text = reply.trim();
    if (!text) return;
    act(async () => { await context.reply(schedule.id, text); setReply(""); });
  };
  const last = schedule.last_result ? `last: ${resultLabel(schedule.last_result)}` : "no runs yet";

  return (
    <div data-testid="periodic-session-tile" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, fontSize: 12, color: "#cdd6f4" }}>
      <div data-testid="periodic-header" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "6px 10px", background: "#181825", borderBottom: "1px solid #313244" }}>
        <ClockIcon style={{ width: 14, height: 14, color: "#89b4fa" }} />
        <span style={{ fontWeight: 600 }}>{describeFrequency(schedule.frequency)}</span>
        <span data-testid="periodic-next" style={{ color: interactive || schedule.paused ? "#f9e2af" : "#a6adc8" }}>{headerState(schedule, now)}</span>
        <span data-testid="periodic-last" style={{ background: "#313244", borderRadius: 10, padding: "1px 8px", fontSize: 11, color: COLORS[schedule.last_result ?? ""] ?? "#a6adc8" }}>{last}</span>
        <span style={{ flex: 1 }} />
        <button data-testid="periodic-run-now" style={button} disabled={interactive} onClick={() => act(() => context.runNow(schedule.id))}>
          <PlayIcon style={{ width: 12, height: 12 }} /> Run now
        </button>
        <button data-testid="periodic-edit" style={button} onClick={() => context.openEditor(tileId, workstreamId)}>
          <PencilSquareIcon style={{ width: 12, height: 12 }} /> Edit schedule
        </button>
        <button
          data-testid="periodic-open-interactive"
          style={button}
          disabled={interactive || !schedule.session_started}
          title={schedule.session_started ? "Open this session in an ordinary Copilot tile; the schedule pauses while it is open." : "Available after the first run creates the session."}
          onClick={() => act(() => context.openInteractively(schedule))}
        >
          <CommandLineIcon style={{ width: 12, height: 12 }} /> Open interactively
        </button>
      </div>
      {error && <div data-testid="periodic-error" style={{ padding: "4px 10px", color: "#f38ba8", fontSize: 11 }}>{error}</div>}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div data-testid="periodic-run-list" style={{ width: 190, borderRight: "1px solid #313244", overflow: "auto" }}>
          {runs !== null && runs.length === 0 && <div data-testid="periodic-empty" style={{ padding: 10, color: "#6c7086" }}>No runs yet.</div>}
          {runs?.map((r) => (
            <div
              key={r.id}
              data-testid={`periodic-run-row-${r.id}`}
              data-status={r.status}
              onClick={() => setSelected(r.id)}
              style={{ padding: "6px 8px", borderBottom: "1px solid #26263a", cursor: "pointer", background: current?.id === r.id ? "#313244" : "transparent" }}
            >
              <div style={{ color: COLORS[r.status] ?? "#cdd6f4" }}>● {runLabel(r)}</div>
              <div style={{ color: "#6c7086", fontSize: 11 }}>{formatRunStart(r.started_at, now)} · {formatDuration(r, clock)}</div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div data-testid="periodic-run-detail" style={{ flex: 1, overflow: "auto", padding: "10px 12px", lineHeight: 1.45 }}>
            {current && (
              <>
                <div data-testid="periodic-run-prompt" style={{ whiteSpace: "pre-wrap" }}><span style={{ color: "#6c7086" }}>Prompt: </span>{current.prompt}</div>
                {current.tools.map((tool) => (
                  <div key={tool.id} data-testid="periodic-tool" style={{ fontFamily: "monospace", fontSize: 11, color: tool.status === "failed" ? "#f38ba8" : "#6c7086", borderLeft: "2px solid #45475a", paddingLeft: 6, margin: "4px 0" }}>
                    {`${tool.name} (${tool.status})`}
                  </div>
                ))}
                {current.answer && !current.question && (
                  <div data-testid="periodic-run-answer" style={{ background: "#181825", borderRadius: 4, padding: "8px 10px", marginTop: 8, whiteSpace: "pre-wrap" }}>{current.answer}</div>
                )}
                {current.question !== null && (
                  <div data-testid="periodic-run-question" style={{ background: "#3a3424", border: "1px solid #f9e2af", borderRadius: 4, padding: "8px 10px", marginTop: 8, whiteSpace: "pre-wrap", display: "flex", gap: 6 }}>
                    <QuestionMarkCircleIcon style={{ width: 14, height: 14, color: "#f9e2af", flexShrink: 0 }} />
                    <span><strong style={{ color: "#f9e2af" }}>Needs input: </strong>{current.question}</span>
                  </div>
                )}
                {current.error && <div data-testid="periodic-run-error" style={{ color: "#f38ba8", marginTop: 8, whiteSpace: "pre-wrap" }}>{current.error}</div>}
                {current.status === "running" && !current.answer && <div style={{ color: "#89b4fa", marginTop: 8 }}>Running…</div>}
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, padding: "6px 10px", borderTop: "1px solid #313244" }}>
            <input
              data-testid="periodic-reply-input"
              value={reply}
              placeholder={interactive ? PAUSED_INTERACTIVE : "Reply, or ask something: runs as the next turn now"}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") send(); }}
              style={{ flex: 1, background: "#11111b", border: "1px solid #45475a", borderRadius: 4, color: "#cdd6f4", padding: "4px 6px" }}
            />
            <button data-testid="periodic-reply-send" style={button} disabled={interactive || !reply.trim()} onClick={send}>
              <PaperAirplaneIcon style={{ width: 12, height: 12 }} /> Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

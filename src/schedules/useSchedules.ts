import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Backend } from "../backend/types";
import { nextRunAfter, type PeriodicRun, type PeriodicSchedule, type ScheduleFrequency } from "../domain/periodic-schedules";
import { createScheduleRunner, type ScheduleRunner } from "../domain/schedule-runner";
import { deliverRunResult, recordRunPrompt, type NotifyDeps } from "./notify";

/** What the schedule editor produces. */
export interface ScheduleDraft {
  prompt: string;
  frequency: ScheduleFrequency;
  notifyInbox: boolean;
  notifyPhone: boolean;
}

export interface UseSchedulesOptions {
  backend: Backend;
  /** The app has loaded its workstreams; nothing runs before. */
  ready: boolean;
  workstreamName(workstreamId: string): string | undefined;
  /** Archived workstreams' schedules never run, and can't be run now or resumed. */
  isArchived(workstreamId: string): boolean;
  /** The workspace's configured Copilot command, used as it is. */
  command(workstreamId: string): string | null;
  /** Where a workstream's runs start. */
  cwd(workstreamId: string): string;
  /** Whether the phone companion is on: runs post to the phone only then. */
  companionOn(): Promise<boolean>;
  /** A run posted to a phone thread: republish the threads. */
  onPhonePosted?(): void;
  /** Changes when tiles or workstreams may have changed (closed, archived): re-read. */
  refreshKey?: unknown;
  tickMs?: number;
  /** Defaults to Date.now; tests pass a fake clock. */
  clock?: () => number;
}

export interface SchedulesApi {
  schedules: PeriodicSchedule[];
  /** The clock at the last refresh, for "next run" labels. */
  now: number;
  /** A schedule for a Periodic session tile, on `sessionId` (omitted: a fresh one). */
  create(tileId: string, workstreamId: string, draft: ScheduleDraft, sessionId?: string): Promise<void>;
  edit(id: string, draft: ScheduleDraft): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /** Deletes the schedule and its tile. */
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  /** Runs `text` as the session's next turn now (the reply box; `phone` for a phone reply). */
  reply(id: string, text: string, kind?: "reply" | "phone"): Promise<PeriodicRun>;
  refresh(): Promise<void>;
}

const TICK_MS = 15_000;

type SchedulerWindow = {
  __WS_SCHEDULER__?: { tick(now: number): Promise<void> };
  __WS_SCHEDULER_MANUAL__?: boolean;
};

type OptionsRef = { readonly current: UseSchedulesOptions };

function notifyDeps(ref: OptionsRef): NotifyDeps {
  return {
    postInbox: (ws, tile, level, title, body) => ref.current.backend.postAppInboxMessage(ws, tile, level, title, body),
    postPhone: async (tile, ws, kind, text, at) => {
      await ref.current.backend.companionPostAppMessage(tile, ws, kind, text, at);
      ref.current.onPhonePosted?.();
    },
    companionOn: () => ref.current.companionOn(),
  };
}

/** The runner's view of the app, read fresh from the latest options on every call. */
function runnerFor(ref: OptionsRef, clock: () => number, onChange: () => void, startedAt: number): ScheduleRunner {
  const backend = () => ref.current.backend;
  return createScheduleRunner({
    list: () => backend().listSchedules(),
    update: (id, patch, expected, alert) => backend().updateSchedule(id, patch, expected, alert),
    workstreamName: (id) => ref.current.workstreamName(id),
    isArchived: (id) => ref.current.isArchived(id),
    start: async (schedule, prompt, kind, now) => {
      const run = await backend().startPeriodicRun({
        tileId: schedule.tile_id, kind, prompt, command: ref.current.command(schedule.workstream_id),
        cwd: ref.current.cwd(schedule.workstream_id), startedAt: now,
      });
      await recordRunPrompt(notifyDeps(ref), schedule, run, now);
      return run;
    },
    getRun: (id) => backend().getPeriodicRun(id),
    latestRun: async (tileId) => (await backend().listPeriodicRuns(tileId))[0] ?? null,
    recordSkip: async (schedule, kind, prompt, now) => { await backend().recordPeriodicSkip(schedule.tile_id, kind, prompt, now); },
    notify: (schedule, run, autoPaused) => deliverRunResult(notifyDeps(ref), schedule, run, autoPaused, clock()),
    onChange,
  }, { startedAt });
}

const ARCHIVED = "This schedule's workstream is archived; unarchive it first.";

/**
 * Periodic sessions in the app (ADR 044, ADR 046): the stored schedules for
 * the UI, their controls, and the runner ticking next to the companion
 * runtime. Runs are headless (`periodic_runner.rs`); a `periodic-run` event
 * that says one finished settles it at once.
 */
export function useSchedules(options: UseSchedulesOptions): SchedulesApi {
  const optionsRef = useRef(options);
  useLayoutEffect(() => { optionsRef.current = options; });
  const clock = useCallback(() => (optionsRef.current.clock ?? Date.now)(), []);
  const [schedules, setSchedules] = useState<PeriodicSchedule[]>([]);
  const [now, setNow] = useState(() => (options.clock ?? Date.now)());
  // This app instance's start: Run now requests from before it expire.
  const [startedAt] = useState(() => (options.clock ?? Date.now)());

  const refresh = useCallback(async () => {
    const list = await optionsRef.current.backend.listSchedules();
    setSchedules(list);
    setNow(clock());
  }, [clock]);
  // Made on first use, outside render: it reads the latest options on every call.
  const runnerRef = useRef<ScheduleRunner | null>(null);
  const getRunner = useCallback(
    () => (runnerRef.current ??= runnerFor(optionsRef, clock, () => { void refresh().catch(() => {}); }, startedAt)),
    [refresh, startedAt, clock],
  );

  const { ready, refreshKey } = options;
  useEffect(() => {
    void refresh().catch((error) => console.error("Failed to load schedules:", error));
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!ready) return;
    const w = (typeof window === "undefined" ? {} : window) as SchedulerWindow;
    if (import.meta.env.VITE_E2E === "1") w.__WS_SCHEDULER__ = { tick: async (at) => { await getRunner().tick(at); await refresh(); } };
    const tick = () => { void getRunner().tick(clock()).then(() => setNow(clock())); };
    if (w.__WS_SCHEDULER_MANUAL__) return;
    tick();
    const timer = setInterval(tick, optionsRef.current.tickMs ?? TICK_MS);
    return () => clearInterval(timer);
  }, [ready, getRunner, refresh, clock]);

  // An agent's schedule.* command changed the store: show it, and run what it asked for.
  useEffect(() => {
    const unlisten = listen<{ entity?: string }>("state-changed", (event) => {
      if (event.payload?.entity !== "schedule") return;
      void refresh().catch(() => {});
      if (optionsRef.current.ready && !(window as SchedulerWindow).__WS_SCHEDULER_MANUAL__) void getRunner().tick(clock());
    });
    return () => { void unlisten.then((dispose) => dispose()).catch(() => {}); };
  }, [refresh, getRunner, clock]);

  // A run ended: apply its result and deliver it now, rather than on the next tick.
  useEffect(() => {
    const unlisten = listen<{ finished?: boolean }>("periodic-run", (event) => {
      if (!event.payload?.finished || !optionsRef.current.ready) return;
      void getRunner().settle(clock()).then(() => refresh()).catch(() => {});
    });
    return () => { void unlisten.then((dispose) => dispose()).catch(() => {}); };
  }, [refresh, getRunner, clock]);

  const backend = () => optionsRef.current.backend;
  const after = <T,>(work: Promise<T>) => work.then(async (value) => { await refresh(); return value; });

  return {
    schedules,
    now,
    refresh,
    create: (tileId, workstreamId, draft, sessionId) => {
      const at = clock();
      return after(backend().createSchedule({
        tileId, workstreamId, prompt: draft.prompt, frequency: draft.frequency,
        notifyInbox: draft.notifyInbox, notifyPhone: draft.notifyPhone,
        // The first run is the first scheduled time, never now.
        nextRunAt: nextRunAfter(draft.frequency, at, at), createdAt: at, sessionId: sessionId ?? null,
      })).then(() => {});
    },
    edit: (id, draft) => {
      const at = clock();
      return after(backend().updateSchedule(id, {
        prompt: draft.prompt, frequency: draft.frequency, notify_inbox: draft.notifyInbox, notify_phone: draft.notifyPhone,
        next_run_at: nextRunAfter(draft.frequency, at, at),
      })).then(() => {});
    },
    pause: (id) => after(backend().updateSchedule(id, { paused: true })).then(() => {}),
    resume: (id) => {
      const schedule = schedules.find((s) => s.id === id);
      if (schedule && optionsRef.current.isArchived(schedule.workstream_id)) return Promise.reject(new Error(ARCHIVED));
      const at = clock();
      return after(backend().updateSchedule(id, {
        paused: false, failures: 0, next_run_at: schedule ? nextRunAfter(schedule.frequency, at, at) : null,
      })).then(() => {});
    },
    remove: (id) => after(backend().deleteSchedule(id)),
    runNow: (id) => after(getRunner().runNow(id, clock())),
    reply: (id, text, kind = "reply") => after(getRunner().reply(id, text, kind, clock())),
  };
}

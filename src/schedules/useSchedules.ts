import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Backend } from "../backend/types";
import { nextRunAfter, type PeriodicSchedule, type ScheduleFrequency } from "../domain/periodic-schedules";
import { createScheduleRunner, type ResumePhase, type ScheduleRunner, type TurnCursor } from "../domain/schedule-runner";
import { tileGeneration } from "../domain/tile-activity";

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
  isBusy(tileId: string): boolean;
  /** A session's turn cursor (its events file), read live, or null. */
  turnState(sessionId: string): Promise<TurnCursor | null>;
  /** Defaults to the app-wide tile registry (`tile-activity.ts`). */
  generation?(tileId: string): number;
  /** Resumes the tile's session; `revalidate` must run before the stop and before the spawn. */
  resume(
    schedule: PeriodicSchedule,
    prompt: string,
    revalidate: (phase: ResumePhase, sessionId: string) => Promise<void>,
  ): Promise<{ sessionId: string }>;
  interrupt(tileId: string): Promise<void>;
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
  create(tileId: string, workstreamId: string, draft: ScheduleDraft): Promise<void>;
  edit(id: string, draft: ScheduleDraft): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  refresh(): Promise<void>;
}

const TICK_MS = 15_000;

type SchedulerWindow = {
  __WS_SCHEDULER__?: { tick(now: number): Promise<void> };
  __WS_SCHEDULER_MANUAL__?: boolean;
};

type OptionsRef = { readonly current: UseSchedulesOptions };

/** The runner's view of the app, read fresh from the latest options on every call. */
function runnerFor(ref: OptionsRef, onChange: () => void, startedAt: number): ScheduleRunner {
  return createScheduleRunner({
    list: () => ref.current.backend.listSchedules(),
    update: (id, patch, expected, alert) => ref.current.backend.updateSchedule(id, patch, expected, alert),
    workstreamName: (id) => ref.current.workstreamName(id),
    isArchived: (id) => ref.current.isArchived(id),
    isBusy: (tileId) => ref.current.isBusy(tileId),
    turnState: (sessionId) => ref.current.turnState(sessionId),
    generation: (tileId) => (ref.current.generation ?? tileGeneration)(tileId),
    resume: (schedule, prompt, revalidate) => ref.current.resume(schedule, prompt, revalidate),
    interrupt: (tileId) => ref.current.interrupt(tileId),
    onChange,
  }, { startedAt });
}

const ARCHIVED = "This schedule's workstream is archived; unarchive it first.";

/**
 * Periodic Copilot sessions in the app (ADR 044): the stored schedules for the
 * UI, their controls, and the runner ticking next to the companion runtime.
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
    () => (runnerRef.current ??= runnerFor(optionsRef, () => { void refresh().catch(() => {}); }, startedAt)),
    [refresh, startedAt],
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

  const backend = () => optionsRef.current.backend;
  const after = <T,>(work: Promise<T>) => work.then(async () => { await refresh(); });

  return {
    schedules,
    now,
    refresh,
    create: (tileId, workstreamId, draft) => {
      const at = clock();
      return after(backend().createSchedule({
        tileId, workstreamId, prompt: draft.prompt, frequency: draft.frequency,
        notifyInbox: draft.notifyInbox, notifyPhone: draft.notifyPhone,
        // The first run is the first scheduled time, never now.
        nextRunAt: nextRunAfter(draft.frequency, at, at), createdAt: at,
      }));
    },
    edit: (id, draft) => {
      const at = clock();
      return after(backend().updateSchedule(id, {
        prompt: draft.prompt, frequency: draft.frequency, notify_inbox: draft.notifyInbox, notify_phone: draft.notifyPhone,
        next_run_at: nextRunAfter(draft.frequency, at, at),
      }));
    },
    pause: (id) => after(backend().updateSchedule(id, { paused: true })),
    resume: (id) => {
      const schedule = schedules.find((s) => s.id === id);
      if (schedule && optionsRef.current.isArchived(schedule.workstream_id)) return Promise.reject(new Error(ARCHIVED));
      const at = clock();
      return after(backend().updateSchedule(id, {
        paused: false, failures: 0, next_run_at: schedule ? nextRunAfter(schedule.frequency, at, at) : null,
      }));
    },
    remove: (id) => after(backend().deleteSchedule(id)),
    runNow: (id) => after(getRunner().runNow(id, clock())),
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Backend } from "../backend/types";
import { tauriSettingsStore } from "../companion/settings";
import {
  activeProblems,
  CHECK_INTERVAL_MS,
  labelCompanionDocs,
  type CompanionDocs,
  thresholdsFrom,
  transition,
  type SyncMonitorState,
  type SyncThresholds,
} from "../domain/sync-monitor";

const message = (error: unknown) => String(error instanceof Error ? error.message : error);

/** The companion's documents from this laptop's settings (they rotate; ADR 033). */
async function storedCompanionDocs(): Promise<CompanionDocs> {
  const [current, retired] = await Promise.all([
    tauriSettingsStore.get("companion.doc_url"),
    tauriSettingsStore.get("companion.retired_docs"),
  ]);
  let list: unknown;
  try { list = JSON.parse(retired ?? "[]"); } catch { list = []; }
  return {
    current: current || null,
    retired: Array.isArray(list) ? list.filter((url): url is string => typeof url === "string") : [],
  };
}

/**
 * Watches the sync server while the app runs (ADR 040): a check every two
 * minutes, the rules applied to the stored checks, and new or resolved
 * problems saved as Inbox entries and desktop notifications.
 */
export function useSyncMonitor(backend: Backend, deps: { companionDocs?: () => Promise<CompanionDocs> } = {}) {
  const companionDocsRef = useRef(deps.companionDocs ?? storedCompanionDocs);
  const [state, setState] = useState<SyncMonitorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every check and evaluation runs one at a time: two reading the same open
  // problems at once would both alert for the same new one.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  /** Applies the rules to what's stored, without a new check. */
  /** The stored state with the companion's documents named (the server names them by a fixed id). */
  const read = useCallback(async (): Promise<SyncMonitorState> => {
    const stored = await backend.syncMonitorState();
    const companion = await companionDocsRef.current().catch(() => ({ current: null, retired: [] }));
    return { ...stored, checks: labelCompanionDocs(stored.checks, companion) };
  }, [backend]);

  const evaluateNow = useCallback(async () => {
    const stored = await read();
    if (stored.configured && stored.checks.length > 0) {
      const now = Date.now();
      const active = activeProblems(stored.checks, thresholdsFrom(stored.thresholds), stored.problems);
      const next = transition(stored.problems, active, stored.mutes, now);
      await backend.syncMonitorApply(next.problems, next.events, next.notify);
      setState(await read());
    } else {
      setState(stored);
    }
  }, [backend, read]);

  const evaluate = useCallback(() => serial(evaluateNow), [serial, evaluateNow]);

  const cycle = useCallback(() => serial(async () => {
    try {
      await backend.syncMonitorCheck();
      await evaluateNow();
      setError(null);
    } catch (failure) {
      setError(message(failure));
    }
  }), [backend, evaluateNow, serial]);

  useEffect(() => {
    void Promise.resolve().then(cycle);
    const timer = setInterval(() => void cycle(), CHECK_INTERVAL_MS);
    // An agent muted something.
    const unlisten = listen<{ entity?: string }>("state-changed", (event) => {
      if (event.payload?.entity === "sync") void evaluate().catch((failure) => setError(message(failure)));
    }).catch(() => null);
    return () => {
      clearInterval(timer);
      void unlisten.then((dispose) => dispose?.());
    };
  }, [cycle, evaluate]);

  const setKey = useCallback(async (key: string) => {
    await backend.syncMonitorSetKey(key);
    await cycle();
  }, [backend, cycle]);

  const setThresholds = useCallback(async (thresholds: Partial<SyncThresholds>) => {
    await backend.syncMonitorSetThresholds(thresholds);
    await evaluate();
  }, [backend, evaluate]);


  const mute = useCallback(async (kind: string, hours = 24) => {
    await backend.syncMonitorMute(kind, hours);
    setState(await read());
  }, [backend, read]);

  const setRead = useCallback(async (id: string, isRead: boolean) => {
    await backend.syncMonitorSetRead(id, isRead);
    setState(await read());
  }, [backend, read]);

  return { state, error, check: cycle, setKey, setThresholds, mute, setRead };
}

export type SyncMonitor = ReturnType<typeof useSyncMonitor>;

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../backend/types";
import type { Change, PlanningConnection, PlanningData, PublishResult } from "../domain/planning";

/** How often Planning re-reads ADO while it is open (ADR 039). */
export const PLANNING_REFRESH_MS = 5 * 60_000;

const message = (error: unknown) => String(error instanceof Error ? error.message : error);

/**
 * Planning's data: the saved connection, selected sprint and draft, and the
 * ADO data. ADO is read when Planning opens, every 5 minutes while it stays
 * open, and on Refresh — never while it is closed or not connected.
 */
export function usePlanning(backend: Backend, open: boolean) {
  const [connection, setConnection] = useState<PlanningConnection | null>(null);
  const [draft, setDraftState] = useState<Change[]>([]);
  const [data, setData] = useState<PlanningData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastPublish, setLastPublish] = useState<PublishResult | null>(null);
  const connected = useRef(false);

  const load = useCallback(async () => {
    if (!connected.current) return;
    setLoading(true);
    try {
      setData(await backend.planningFetch());
      setError(null);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void backend.planningState().then((state) => {
      if (cancelled) return;
      setConnection(state.connection);
      setDraftState(state.draft);
      connected.current = !!state.connection;
      void load();
    }).catch((failure) => { if (!cancelled) setError(message(failure)); });
    const timer = setInterval(() => void load(), PLANNING_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [backend, open, load]);

  const connect = useCallback(async (url: string) => {
    const next = await backend.planningConnect(url);
    setConnection(next);
    connected.current = true;
    setDraftState((await backend.planningState()).draft);
    await load();
  }, [backend, load]);

  const selectSprint = useCallback(async (path: string) => {
    await backend.planningSelectSprint(path);
    await load();
  }, [backend, load]);

  const addChange = useCallback(async (change: Change) => {
    setDraftState(await backend.planningAddChange(change));
  }, [backend]);

  const setDraft = useCallback(async (next: Change[]) => {
    await backend.planningSetDraft(next);
    setDraftState(next);
  }, [backend]);

  const publish = useCallback(async () => {
    const result = await backend.planningPublish();
    setLastPublish(result);
    setDraftState((await backend.planningState()).draft);
    await load();
    return result;
  }, [backend, load]);

  return { connection, draft, data, error, loading, lastPublish, connect, refresh: load, selectSprint, addChange, setDraft, publish };
}

export type Planning = ReturnType<typeof usePlanning>;

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Backend } from "../backend/types";
import type { Change, PlanningConnection, PlanningData, PublishResult } from "../domain/planning";

/** How often Planning re-reads ADO while it is open (ADR 039). */
export const PLANNING_REFRESH_MS = 5 * 60_000;

const message = (error: unknown) => String(error instanceof Error ? error.message : error);

/**
 * Planning's data: the saved connection, selected sprint and draft, and the
 * ADO data. ADO is read when Planning opens, every 5 minutes while it stays
 * open, and on Refresh — never while it is closed or not connected. Each read
 * also re-reads the saved draft, as does an agent's planning change, so
 * changes made from the CLI show up.
 */
export function usePlanning(backend: Backend, open: boolean) {
  const [connection, setConnection] = useState<PlanningConnection | null>(null);
  const [draft, setDraftState] = useState<Change[]>([]);
  const [data, setData] = useState<PlanningData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastPublish, setLastPublish] = useState<PublishResult | null>(null);
  const connected = useRef(false);
  /** The draft as last seen, which a replacement is based on. */
  const seen = useRef<Change[]>([]);
  const showDraft = useCallback((next: Change[]) => { seen.current = next; setDraftState(next); }, []);

  const sync = useCallback(async () => {
    const state = await backend.planningState();
    setConnection(state.connection);
    showDraft(state.draft);
    connected.current = !!state.connection;
  }, [backend, showDraft]);

  const load = useCallback(async () => {
    try {
      await sync();
      if (!connected.current) return;
      setLoading(true);
      setData(await backend.planningFetch());
      setError(null);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setLoading(false);
    }
  }, [backend, sync]);

  useEffect(() => {
    if (!open) return;
    void Promise.resolve().then(load);
    const timer = setInterval(() => void load(), PLANNING_REFRESH_MS);
    // An agent changed the draft or published it.
    const unlisten = listen<{ entity?: string }>("state-changed", (event) => {
      if (event.payload?.entity === "planning") void load();
    }).catch(() => null);
    return () => {
      clearInterval(timer);
      void unlisten.then((dispose) => dispose?.());
    };
  }, [open, load]);

  const connect = useCallback(async (url: string) => {
    const next = await backend.planningConnect(url);
    setConnection(next);
    connected.current = true;
    await load();
  }, [backend, load]);

  const selectSprint = useCallback(async (path: string) => {
    await backend.planningSelectSprint(path);
    await load();
  }, [backend, load]);

  /** On a refusal the saved draft is shown again, so a retry starts from it. */
  const reloadingOnFailure = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (failure) {
      await sync().catch(() => {});
      throw failure;
    }
  }, [sync]);

  const addChange = useCallback((change: Change) => reloadingOnFailure(async () => {
    showDraft(await backend.planningAddChange(change));
  }), [backend, reloadingOnFailure, showDraft]);

  const setDraft = useCallback((next: Change[]) => reloadingOnFailure(async () => {
    await backend.planningSetDraft(next, seen.current);
    showDraft(next);
  }), [backend, reloadingOnFailure, showDraft]);

  const publish = useCallback(async () => {
    const result = await backend.planningPublish();
    setLastPublish(result);
    await load();
    return result;
  }, [backend, load]);

  return { connection, draft, data, error, loading, lastPublish, connect, refresh: load, selectSprint, addChange, setDraft, publish };
}

export type Planning = ReturnType<typeof usePlanning>;

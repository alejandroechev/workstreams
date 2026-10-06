import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanionDoc } from "./doc";
import { openAutomergeDoc } from "./automerge-doc";
import { buildLaptopState, buildSessions, publishLaptopState, publishSessions, startPresence } from "./publisher";
import type { CompanionStoredSession } from "../backend/types";
import { startCompanionRuntime, type CompanionOps, type RequestGuard } from "./runtime";
import { openConsumedLedger } from "./ledger";
import { createUniqueFolder, expandHome } from "./folders";
import {
  loadCompanionSettings,
  onCompanionSettingsChanged,
  tauriSettingsStore,
  type CompanionSettings,
  type SettingsStore,
} from "./settings";
import { syncServerUrls } from "./sync-server";
import { isKnownSchema, SESSION_RETENTION_MS } from "./protocol";
import type { Workstream } from "../domain/types";
import type { WorkLane } from "../domain/work-lanes";

/** What the app provides to the companion; read fresh on every use. */
export interface CompanionBindings {
  /**
   * The app has loaded its workstreams and settings. Until then nothing is
   * published or executed: an empty list would be published, and a valid
   * request would be failed for naming a workstream not loaded yet.
   */
  ready: boolean;
  /** Changes whenever phone sessions or their messages change; triggers a republish. */
  sessionsVersion: number;
  listSessions(): Promise<CompanionStoredSession[]>;
  pruneSessions(now: number, retentionMs: number): Promise<number>;
  workstreams: Workstream[];
  lanes: WorkLane[];
  loadedIds: ReadonlySet<string>;
  /** Running Copilot session tiles per workstream. */
  sessionCounts: ReadonlyMap<string, number>;
  commandFor(workstream: Workstream): string;
  globalCommand: string;
  loadInBackground(workstreamId: string): Promise<void>;
  createWorkstreamAt(name: string, directory: string): Promise<string>;
  /** Calls `guard` after each await and right before spawning the session. */
  startSession(workstreamId: string, command: string, prompt: string, guard: RequestGuard, requestId: string): Promise<void>;
  /** Must fail if the path exists. */
  createDirectory(path: string): Promise<void>;
  homeDir(): Promise<string>;
}

export type CompanionStatus =
  | { state: "off" }
  | { state: "dev-disabled" }
  | { state: "connecting" }
  | { state: "on" }
  | { state: "update-needed" }
  | { state: "error"; error: string };

export interface CompanionServiceDeps {
  store?: SettingsStore;
  connect?: (settings: CompanionSettings) => Promise<CompanionDoc>;
  /**
   * Development builds never connect (ADR 033): a dev instance running next
   * to the production app must not execute the same requests.
   */
  devBuild?: boolean;
}

let depsOverride: CompanionServiceDeps | null = null;

/**
 * E2E seam (set from main.tsx only when VITE_E2E is on): an in-memory hub in
 * place of the sync server, so browser tests can act as the phone.
 */
export function _setCompanionServiceDepsForTests(deps: CompanionServiceDeps | null): void {
  depsOverride = deps;
}

let currentStatus: CompanionStatus = { state: "off" };
const statusListeners = new Set<(status: CompanionStatus) => void>();

/** The running service's status, for the Settings section. */
export function getCompanionStatus(): CompanionStatus {
  return currentStatus;
}

export function onCompanionStatus(listener: (status: CompanionStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

async function connectAutomerge(settings: CompanionSettings): Promise<CompanionDoc> {
  const { ws } = syncServerUrls(settings.serverUrl, settings.token || null);
  const { doc } = await openAutomergeDoc({ docUrl: settings.docUrl, wsUrl: ws, storage: true });
  return doc;
}

/**
 * Runs the phone companion inside the app (ADR 033): connects when enabled,
 * broadcasts presence, publishes the workstream list, and executes the paired
 * phone's requests through the app's own operations.
 */
export function useCompanionService(bindings: CompanionBindings, explicitDeps?: CompanionServiceDeps): CompanionStatus {
  const deps = explicitDeps ?? depsOverride ?? {};
  // Configuration, not state: held in refs so a caller passing fresh objects
  // on every render does not reconnect on every render.
  const storeRef = useRef(deps.store ?? tauriSettingsStore);
  const connectRef = useRef(deps.connect ?? connectAutomerge);
  const devBuild = deps.devBuild ?? import.meta.env.DEV;

  const bindingsRef = useRef(bindings);
  useEffect(() => { bindingsRef.current = bindings; });

  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [doc, setDoc] = useState<CompanionDoc | null>(null);
  // Only what a live connection reports; "off" and "dev-disabled" are derived.
  const [connectionStatus, setStatus] = useState<CompanionStatus>({ state: "connecting" });

  useEffect(() => {
    let cancelled = false;
    void loadCompanionSettings(storeRef.current).then((loaded) => { if (!cancelled) setSettings(loaded); });
    const off = onCompanionSettingsChanged((next) => setSettings(next));
    return () => { cancelled = true; off(); };
  }, []);

  // (Re)connect whenever the settings that define the connection change.
  const connection = settings?.enabled && settings.docUrl && settings.secret
    ? JSON.stringify([settings.serverUrl, settings.token, settings.docUrl, settings.secret, settings.folderRoot])
    : null;
  useEffect(() => {
    if (!settings || !connection || devBuild || !bindings.ready) return;
    let cancelled = false;
    let opened: CompanionDoc | null = null;
    const stops: Array<() => void> = [];

    const ops: CompanionOps = {
      world: () => {
        const b = bindingsRef.current;
        return {
          workstreams: b.workstreams.map((w) => ({
            id: w.id,
            name: w.name,
            archived: w.status === "archived",
            loaded: b.loadedIds.has(w.id),
            copilotCommand: b.commandFor(w),
          })),
          globalCopilotCommand: b.globalCommand,
        };
      },
      loadInBackground: (id) => bindingsRef.current.loadInBackground(id),
      async createWorkstream(name, folderSlug, guard) {
        const b = bindingsRef.current;
        const root = expandHome(settings.folderRoot, settings.folderRoot.trim().startsWith("~") ? await b.homeDir() : "");
        guard();
        const directory = await createUniqueFolder(root, folderSlug, b.createDirectory);
        guard();
        return b.createWorkstreamAt(name, directory);
      },
      startSession: (id, command, prompt, guard, requestId) => bindingsRef.current.startSession(id, command, prompt, guard, requestId),
    };

    connectRef.current(settings)
      .then((connected) => {
        if (cancelled) { connected.close(); return; }
        opened = connected;
        if (!isKnownSchema(connected.read())) {
          // A newer version's document: write nothing, not even presence.
          setStatus({ state: "update-needed" });
          return;
        }
        return openConsumedLedger(storeRef.current).then((ledger) => {
          if (cancelled) return;
          stops.push(startPresence(connected));
          const runtime = startCompanionRuntime({
            doc: connected,
            secret: settings.secret,
            ops,
            ledger,
            onStatus: (runtimeStatus) => setStatus(runtimeStatus.state === "ok" ? { state: "on" } : runtimeStatus),
          });
          stops.push(() => runtime.stop());
          setStatus({ state: "on" });
          setDoc(connected);
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
      for (const stop of stops.splice(0)) stop();
      opened?.close();
      setDoc(null);
      setStatus({ state: "connecting" });
    };
    // `settings` is captured through `connection`, which holds every field used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, devBuild, bindings.ready]);

  const status: CompanionStatus = !connection ? { state: "off" } : devBuild ? { state: "dev-disabled" } : connectionStatus;
  const statusKey = JSON.stringify(status);
  useEffect(() => {
    currentStatus = JSON.parse(statusKey) as CompanionStatus;
    for (const listener of statusListeners) listener(currentStatus);
  }, [statusKey]);

  // Phone sessions: pruned when connected and then hourly, and republished
  // whenever they change. Only the latest read is published, so a slow,
  // older read can never overwrite a newer one.
  const [pruned, setPruned] = useState(0);
  useEffect(() => {
    if (!doc) return;
    const prune = () => {
      void bindingsRef.current.pruneSessions(Date.now(), SESSION_RETENTION_MS)
        .then((removed) => { if (removed > 0) setPruned((n) => n + 1); })
        .catch((error: unknown) => console.error("Could not prune phone sessions:", error));
    };
    prune();
    const timer = setInterval(prune, 60 * 60_000);
    return () => clearInterval(timer);
  }, [doc]);
  const workstreamNames = JSON.stringify(bindings.workstreams.map((w) => [w.id, w.name]));
  const secret = settings?.secret ?? "";
  const publishSeq = useRef(0);
  useEffect(() => {
    if (!doc) return;
    const seq = ++publishSeq.current;
    const names = new Map(JSON.parse(workstreamNames) as Array<[string, string]>);
    void bindingsRef.current.listSessions()
      .then((stored) => buildSessions(stored, names, secret))
      .then((sessions) => { if (seq === publishSeq.current) publishSessions(doc, sessions); })
      .catch((error: unknown) => console.error("Could not publish phone sessions:", error));
  }, [doc, bindings.sessionsVersion, pruned, workstreamNames, secret]);

  // Publish whenever what the phone would see changes.
  const laptopState = useMemo(
    () => buildLaptopState({
      workstreams: bindings.workstreams,
      lanes: bindings.lanes,
      loadedIds: bindings.loadedIds,
      sessionCounts: bindings.sessionCounts,
    }),
    [bindings.workstreams, bindings.lanes, bindings.loadedIds, bindings.sessionCounts],
  );
  const laptopKey = JSON.stringify(laptopState);
  useEffect(() => {
    if (doc && isKnownSchema(doc.read())) publishLaptopState(doc, laptopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, laptopKey]);

  return status;
}

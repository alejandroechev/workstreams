import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanionDoc } from "./doc";
import { openAutomergeDoc } from "./automerge-doc";
import { buildLaptopState, publishLaptopState, startPresence } from "./publisher";
import { startCompanionRuntime, type CompanionOps } from "./runtime";
import { createUniqueFolder, expandHome } from "./folders";
import {
  loadCompanionSettings,
  onCompanionSettingsChanged,
  tauriSettingsStore,
  type CompanionSettings,
  type SettingsStore,
} from "./settings";
import { syncServerUrls } from "./sync-server";
import { isKnownSchema } from "./protocol";
import type { Workstream } from "../domain/types";
import type { WorkLane } from "../domain/work-lanes";

/** What the app provides to the companion; read fresh on every use. */
export interface CompanionBindings {
  workstreams: Workstream[];
  lanes: WorkLane[];
  loadedIds: ReadonlySet<string>;
  /** Running Copilot session tiles per workstream. */
  sessionCounts: ReadonlyMap<string, number>;
  commandFor(workstream: Workstream): string;
  globalCommand: string;
  loadInBackground(workstreamId: string): Promise<void>;
  createWorkstreamAt(name: string, directory: string): Promise<string>;
  startSession(workstreamId: string, command: string, prompt: string): Promise<void>;
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
    if (!settings || !connection || devBuild) return;
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
      async createWorkstream(name, folderSlug) {
        const b = bindingsRef.current;
        const root = expandHome(settings.folderRoot, settings.folderRoot.trim().startsWith("~") ? await b.homeDir() : "");
        const directory = await createUniqueFolder(root, folderSlug, b.createDirectory);
        return b.createWorkstreamAt(name, directory);
      },
      startSession: (id, command, prompt) => bindingsRef.current.startSession(id, command, prompt),
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
        stops.push(startPresence(connected));
        const runtime = startCompanionRuntime({
          doc: connected,
          secret: settings.secret,
          ops,
          onStatus: (runtimeStatus) => setStatus(runtimeStatus.state === "ok" ? { state: "on" } : runtimeStatus),
        });
        stops.push(() => runtime.stop());
        setStatus({ state: "on" });
        setDoc(connected);
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
  }, [connection, devBuild]);

  const status: CompanionStatus = !connection ? { state: "off" } : devBuild ? { state: "dev-disabled" } : connectionStatus;
  const statusKey = JSON.stringify(status);
  useEffect(() => {
    currentStatus = JSON.parse(statusKey) as CompanionStatus;
    for (const listener of statusListeners) listener(currentStatus);
  }, [statusKey]);

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

import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanionDoc } from "./doc";
import { openAutomergeDoc } from "./automerge-doc";
import { buildLaptopState, buildSessions, buildSessionTiles, publishLaptopState, publishSessions, publishSessionTiles, startPresence } from "./publisher";
import type { CompanionStoredSession } from "../backend/types";
import { startCompanionRuntime, type CompanionOps, type RequestGuard } from "./runtime";
import { openConsumedLedger } from "./ledger";
import { createUniqueFolder, expandHome } from "./folders";
import {
  loadCompanionSettings,
  onCompanionSettingsChanged,
  saveCompanionSettings,
  tauriSettingsStore,
  type CompanionSettings,
  type SettingsStore,
} from "./settings";
import { syncServerUrls } from "./sync-server";
import { isKnownSchema, SCHEMA_VERSION, SESSION_RETENTION_MS, signMove } from "./protocol";
import { DEFAULT_ROTATION, hasOpenRequest, type RotationOptions, type RotationResult } from "./rotation";
import type { Tile, Workstream } from "../domain/types";
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
  /** Every workstream's tiles (live for mounted ones, saved for the rest); the Copilot ones are published. */
  sessionTiles?: ReadonlyMap<string, Tile[]>;
  commandFor(workstream: Workstream): string;
  globalCommand: string;
  loadInBackground(workstreamId: string): Promise<void>;
  createWorkstreamAt(name: string, directory: string): Promise<string>;
  /** Calls `guard` after each await and right before spawning the session. */
  startSession(workstreamId: string, command: string, prompt: string, guard: RequestGuard, requestId: string): Promise<void>;
  /** Stops an existing session tile and resumes it with the phone's message (companion conversations). */
  messageSession: CompanionOps["messageSession"];
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
  /** Creates an empty companion document on the sync server; returns its URL (rotation). */
  createDocument?: (settings: CompanionSettings) => Promise<string>;
  /** Size limit and timings for rotating the document; the defaults in production. */
  rotation?: Partial<RotationOptions>;
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

let rotateHandler: (() => Promise<RotationResult>) | null = null;
/** When the document was last rotated (ms epoch), so automatic rotation cannot loop. */
const ROTATED_AT_KEY = "companion.rotated_at";

/**
 * Moves the phone companion to a fresh document now (Settings, "Rotate now").
 * Refused while a request is pending or running.
 */
export function rotateCompanionNow(): Promise<RotationResult> {
  return rotateHandler ? rotateHandler() : Promise.resolve({ ok: false, reason: "not-connected" });
}

async function createAutomergeDocument(settings: CompanionSettings): Promise<string> {
  const { ws } = syncServerUrls(settings.serverUrl, settings.token || null);
  // Waits for the server, so the new document exists there before the old one points at it.
  const { doc, url, flush } = await openAutomergeDoc({ docUrl: null, wsUrl: ws, storage: true, waitForNetworkMs: 15_000 });
  await flush();
  doc.close();
  return url;
}

async function connectAutomerge(settings: CompanionSettings): Promise<CompanionDoc> {
  const { ws } = syncServerUrls(settings.serverUrl, settings.token || null);
  const { doc } = await openAutomergeDoc({ docUrl: settings.docUrl, wsUrl: ws, storage: true, immutableStrings: true });
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
  const createDocumentRef = useRef(deps.createDocument ?? createAutomergeDocument);
  const rotationRef = useRef<RotationOptions>({ ...DEFAULT_ROTATION, ...deps.rotation });
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
    let runtime: ReturnType<typeof startCompanionRuntime> | null = null;
    /** Set once this document has been retired: its requests are still answered for a while. */
    let retired = false;
    let rotating = false;
    const graceMs = rotationRef.current.graceMs;
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
      messageSession: (target, guard, requestId) => bindingsRef.current.messageSession(target, guard, requestId),
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
          runtime = startCompanionRuntime({
            doc: connected,
            secret: settings.secret,
            ops,
            ledger,
            onStatus: (runtimeStatus) => setStatus(runtimeStatus.state === "ok" ? { state: "on" } : runtimeStatus),
          });

          /** Retires this document for a fresh one (schema 2), leaving a signed pointer for the phone. */
          let queued = false;
          const rotate = async (manual = false): Promise<RotationResult> => {
            if (cancelled || retired) return { ok: false, reason: "not-connected" };
            if (rotating) return { ok: false, reason: "busy" };
            if (hasOpenRequest(connected.read(), Date.now())) {
              // Rotate now waits for the request; an automatic check just tries again next time.
              if (!manual) return { ok: false, reason: "busy" };
              queued = true;
              return { ok: false, reason: "queued" };
            }
            queued = false;
            rotating = true;
            try {
              const url = await createDocumentRef.current(settings);
              if (cancelled) return { ok: false, reason: "not-connected" };
              const movedTo = await signMove(settings.secret, settings.docUrl, url, Date.now());
              retired = true;
              connected.change((draft) => {
                draft.movedTo = movedTo;
                // An outdated phone, which cannot follow the pointer, says "update" instead of going stale.
                draft.schemaVersion = SCHEMA_VERSION;
              });
              await storeRef.current.set(ROTATED_AT_KEY, String(Date.now()));
              await saveCompanionSettings(storeRef.current, { docUrl: url });
              return { ok: true, url };
            } catch (error) {
              return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
            } finally {
              rotating = false;
            }
          };
          const checkSize = () => {
            if (retired || connected.size() <= rotationRef.current.aboveBytes) return;
            // At most one automatic rotation per check interval, across restarts,
            // so a document that is large even when fresh cannot loop.
            void storeRef.current.get(ROTATED_AT_KEY).then(async (last) => {
              if (last && Date.now() - Number(last) < rotationRef.current.everyMs) return;
              const outcome = await rotate();
              if (!outcome.ok && outcome.reason === "error") console.error("Could not rotate the companion document:", outcome.message);
            });
          };
          stops.push(connected.subscribe(() => {
            if (queued && !rotating && !hasOpenRequest(connected.read(), Date.now())) void rotate(true);
          }));
          rotateHandler = () => rotate(true);
          const handler = rotateHandler;
          stops.push(() => { if (rotateHandler === handler) rotateHandler = null; });
          const timer = setInterval(checkSize, rotationRef.current.everyMs);
          stops.push(() => clearInterval(timer));
          checkSize();

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
      const closing = opened;
      const closingRuntime = runtime;
      if (retired && closing) {
        // Retired by a rotation: keep answering requests the phone sent before
        // it switched, then stop. Nothing else is published here any more.
        setTimeout(() => { closingRuntime?.stop(); closing.close(); }, graceMs);
      } else {
        closingRuntime?.stop();
        closing?.close();
      }
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

  // Every Copilot session tile the phone may message, republished when the
  // tiles or the phone sessions change; again only the latest build is written.
  const tilesSeq = useRef(0);
  useEffect(() => {
    if (!doc) return;
    const seq = ++tilesSeq.current;
    const b = bindingsRef.current;
    void b.listSessions()
      .then((stored) => buildSessionTiles({ workstreams: b.workstreams, tilesByWorkstream: b.sessionTiles ?? new Map(), stored }))
      .then((tiles) => { if (seq === tilesSeq.current && isKnownSchema(doc.read())) publishSessionTiles(doc, tiles); })
      .catch((error: unknown) => console.error("Could not publish session tiles:", error));
  }, [doc, bindings.sessionTiles, bindings.workstreams, bindings.sessionsVersion]);

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

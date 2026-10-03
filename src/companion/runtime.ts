import type { CompanionDoc } from "./doc";
import {
  CREATED,
  garbageEntries,
  interruptedRequests,
  pendingEntries,
  planRequest,
  requestsToPrune,
  type Action,
  type ExecutorWorld,
} from "./executor";
import type { ConsumedLedger } from "./ledger";
import { isFresh, isKnownSchema, parseRequest, rejectMessage, type CompanionRequest, type RequestOutcome } from "./protocol";

/** What the runtime may ask the app to do; implemented by App (ADR 033). */
export interface CompanionOps {
  /** The app's current state, as the executor needs it. */
  world(): ExecutorWorld;
  /** Mounts the workstream and its tiles without changing the active one. */
  loadInBackground(workstreamId: string): Promise<void>;
  /** Creates a standalone workstream in a new folder; returns its id. */
  createWorkstream(name: string, folderSlug: string): Promise<string>;
  /** Appends a Copilot session tile running `command` with `-i prompt`. */
  startSession(workstreamId: string, command: string, prompt: string): Promise<void>;
}

export type RuntimeStatus =
  | { state: "ok" }
  | { state: "update-needed" }
  | { state: "error"; error: string };

/**
 * The laptop side of the companion: watches the document and executes the
 * phone's requests one at a time, in order (ADR 033).
 *
 * Every request ends with exactly one outcome. Its id is first recorded in
 * the laptop's own ledger, the authority on "already run": the document is
 * writable by anyone holding its URL, so an outcome there can be deleted.
 * Then it is claimed (`running`) in the document, so a crash mid-action
 * leaves a request that the next start fails instead of re-running.
 *
 * A document from a newer version is never written to; the schema is checked
 * again after every await, since it may change while a request is verified.
 */
export function startCompanionRuntime(options: {
  doc: CompanionDoc;
  secret: string;
  ops: CompanionOps;
  now?: () => number;
  /** Called whenever the status changes. */
  onStatus?: (status: RuntimeStatus) => void;
  /** Durable record of executed request ids; in-memory by default (tests). */
  ledger?: ConsumedLedger;
}) {
  const { doc, secret, ops } = options;
  const ledger = options.ledger ?? memoryLedger();
  const now = options.now ?? Date.now;
  let stopped = false;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();
  let status: RuntimeStatus = { state: "ok" };
  const setStatus = (next: RuntimeStatus) => {
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    options.onStatus?.(next);
  };

  const setOutcome = (id: string, outcome: RequestOutcome) => {
    // A stopped runtime writes nothing; a request it left `running` is
    // failed as interrupted by the next one.
    if (stopped) return;
    // Automerge rejects `undefined` values, so optional fields are only set when present.
    const clean: RequestOutcome = { status: outcome.status, at: outcome.at };
    if (outcome.error !== undefined) clean.error = outcome.error;
    if (outcome.workstreamId !== undefined) clean.workstreamId = outcome.workstreamId;
    doc.change((draft) => {
      if (!isKnownSchema(draft)) return;
      const target = draft.requests[id];
      if (target && typeof target === "object") target.outcome = clean;
    });
  };
  const known = () => isKnownSchema(doc.read());

  /** Stops between actions too: a request must not outlive its runtime or its lifetime. */
  const run = async (request: CompanionRequest, actions: Action[]): Promise<string | undefined> => {
    let created: string | undefined;
    const resolve = (id: string) => {
      if (id !== CREATED) return id;
      if (!created) throw new Error("Nothing was created to act on.");
      return created;
    };
    for (const action of actions) {
      if (stopped) throw new Error("Stopped: the companion was turned off before this request finished.");
      if (!isFresh(request.createdAt, now())) throw new Error(rejectMessage("expired"));
      if (action.type === "create") created = await ops.createWorkstream(action.name, action.folderSlug);
      else if (action.type === "load") await ops.loadInBackground(resolve(action.workstreamId));
      else await ops.startSession(resolve(action.workstreamId), action.command, action.prompt);
    }
    return created;
  };

  /**
   * Whether it is still safe to go on after an await: not stopped, the
   * document still a known version, and the entry unchanged and unhandled.
   */
  const stillValid = (key: string, request: CompanionRequest): boolean => {
    if (stopped) return false;
    if (!known()) {
      setStatus({ state: "update-needed" });
      return false;
    }
    const current = doc.read().requests[key];
    return !!current && !current.outcome && current.signature === request.signature;
  };

  /** Handles one inbox entry. Returns false when the pass must stop. */
  const handle = async (key: string, request: CompanionRequest): Promise<boolean> => {
    // The signature covers the id, not the map key: an entry filed under
    // another key could otherwise never be claimed, and would run forever.
    if (request.id !== key || !parseRequest(request).ok) {
      setOutcome(key, { status: "failed", at: now(), error: rejectMessage("invalid") });
      return true;
    }
    const plan = await planRequest(request, ops.world(), { secret, now: now(), schemaVersion: doc.read().schemaVersion });
    if (!stillValid(key, request)) return !stopped && known();
    if (!plan.ok) {
      setOutcome(key, { status: "failed", at: now(), error: plan.error });
      return true;
    }
    let reserved: boolean;
    try {
      reserved = await ledger.reserve(key, request.createdAt);
    } catch (error) {
      setOutcome(key, { status: "failed", at: now(), error: `Could not record the request, so it was not run: ${error instanceof Error ? error.message : String(error)}` });
      return true;
    }
    if (!reserved) {
      setOutcome(key, { status: "failed", at: now(), error: rejectMessage("already-handled") });
      return true;
    }
    // From here the id is spent: whatever happens, this request never runs again.
    if (!stillValid(key, request)) return !stopped && known();
    if (!isFresh(request.createdAt, now())) {
      setOutcome(key, { status: "failed", at: now(), error: rejectMessage("expired") });
      return true;
    }
    setOutcome(key, { status: "running", at: now() });
    if (doc.read().requests[key]?.outcome?.status !== "running") return true;
    try {
      const created = await run(request, plan.actions);
      setOutcome(key, { status: "done", at: now(), workstreamId: created });
    } catch (error) {
      setOutcome(key, { status: "failed", at: now(), error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  };

  const pass = async () => {
    const snapshot = doc.read();
    if (!isKnownSchema(snapshot)) {
      // Never write to a document from a newer version: its shape may differ.
      setStatus({ state: "update-needed" });
      return;
    }
    setStatus({ state: "ok" });

    const garbage = garbageEntries(snapshot);
    const prune = requestsToPrune(snapshot, now());
    if (garbage.length + prune.length > 0) {
      doc.change((draft) => {
        if (!isKnownSchema(draft)) return;
        for (const id of [...garbage, ...prune]) delete draft.requests[id];
      });
    }
    for (const key of interruptedRequests(snapshot)) {
      setOutcome(key, { status: "failed", at: now(), error: "Interrupted: Workstreams stopped before finishing this request." });
    }

    for (const [key, request] of pendingEntries(doc.read())) {
      if (stopped) return;
      if (!(await handle(key, request))) return;
    }
  };

  const schedule = () => {
    if (stopped || queued) return;
    queued = true;
    chain = chain
      .then(async () => {
        queued = false;
        if (!stopped) await pass();
      })
      .catch((error: unknown) => {
        setStatus({ state: "error", error: error instanceof Error ? error.message : String(error) });
      });
  };

  const unsubscribe = doc.subscribe(() => schedule());
  schedule();

  return {
    /** Resolves once every pass scheduled so far has finished. */
    idle: async () => {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
      } while (seen !== chain);
    },
    status: () => status,
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}

function memoryLedger(): ConsumedLedger {
  const ids = new Set<string>();
  return {
    reserve: async (id) => {
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    },
  };
}

import type { CompanionDoc } from "./doc";
import {
  CREATED,
  interruptedRequests,
  pendingRequests,
  planRequest,
  requestsToPrune,
  type Action,
  type ExecutorWorld,
} from "./executor";
import { isKnownSchema, type RequestOutcome } from "./protocol";

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
 * Every request ends with exactly one outcome. It is claimed (`running`) in
 * the document before anything is done, so a crash mid-action leaves a
 * request that the next start fails instead of re-running.
 */
export function startCompanionRuntime(options: {
  doc: CompanionDoc;
  secret: string;
  ops: CompanionOps;
  now?: () => number;
}) {
  const { doc, secret, ops } = options;
  const now = options.now ?? Date.now;
  let stopped = false;
  let queued = false;
  let chain: Promise<void> = Promise.resolve();
  let status: RuntimeStatus = { state: "ok" };

  const setOutcome = (id: string, outcome: RequestOutcome) => {
    // Automerge rejects `undefined` values, so optional fields are only set when present.
    const clean: RequestOutcome = { status: outcome.status, at: outcome.at };
    if (outcome.error !== undefined) clean.error = outcome.error;
    if (outcome.workstreamId !== undefined) clean.workstreamId = outcome.workstreamId;
    doc.change((draft) => {
      if (draft.requests[id]) draft.requests[id].outcome = clean;
    });
  };

  const run = async (actions: Action[]): Promise<string | undefined> => {
    let created: string | undefined;
    const resolve = (id: string) => {
      if (id !== CREATED) return id;
      if (!created) throw new Error("Nothing was created to act on.");
      return created;
    };
    for (const action of actions) {
      if (action.type === "create") created = await ops.createWorkstream(action.name, action.folderSlug);
      else if (action.type === "load") await ops.loadInBackground(resolve(action.workstreamId));
      else await ops.startSession(resolve(action.workstreamId), action.command, action.prompt);
    }
    return created;
  };

  const pass = async () => {
    const snapshot = doc.read();
    if (!isKnownSchema(snapshot)) {
      // Never write to a document from a newer version: its shape may differ.
      status = { state: "update-needed" };
      return;
    }
    status = { state: "ok" };

    for (const request of interruptedRequests(snapshot)) {
      setOutcome(request.id, { status: "failed", at: now(), error: "Interrupted: Workstreams stopped before finishing this request." });
    }
    const prune = requestsToPrune(snapshot, now());
    if (prune.length > 0) doc.change((draft) => { for (const id of prune) delete draft.requests[id]; });

    for (const request of pendingRequests(doc.read())) {
      if (stopped) return;
      const plan = await planRequest(request, ops.world(), { secret, now: now(), schemaVersion: snapshot.schemaVersion });
      if (doc.read().requests[request.id]?.outcome) continue;
      if (!plan.ok) {
        setOutcome(request.id, { status: "failed", at: now(), error: plan.error });
        continue;
      }
      setOutcome(request.id, { status: "running", at: now() });
      try {
        const created = await run(plan.actions);
        setOutcome(request.id, { status: "done", at: now(), workstreamId: created });
      } catch (error) {
        setOutcome(request.id, { status: "failed", at: now(), error: error instanceof Error ? error.message : String(error) });
      }
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
        status = { state: "error", error: error instanceof Error ? error.message : String(error) };
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

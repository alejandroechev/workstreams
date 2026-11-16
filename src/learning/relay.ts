import type { LearningDoc } from "./doc";
import {
  admitRequest,
  refusalMessage,
  sign,
  toJobRequest,
  SCHEMA_VERSION,
  type LearningResponse,
  type RefusalReason,
} from "./protocol";

/** A job in the native ledger (`learning_jobs.rs`), as the relay sees it. */
export interface LedgerJob {
  id: string;
  kind: "check" | "help";
  status: "queued" | "running" | "finished" | "interrupted";
  /** A check's CheckResult, or help's `{reply, error}`. */
  result: unknown;
}

export interface LedgerPort {
  /** Idempotent by id; rejects a reused id with other content. */
  enqueue(job: Record<string, unknown>): Promise<LedgerJob>;
  get(id: string): Promise<LedgerJob | null>;
}

export type RelayStatus = "on" | "update-needed";

export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
export const LAST_SEEN_EVERY_MS = 5 * 60_000;

export interface RelayOptions {
  doc: LearningDoc;
  ledger: LedgerPort;
  secret: string;
  now?: () => number;
  onStatus?: (status: RelayStatus) => void;
  onError?: (error: unknown) => void;
}

function bodyCreatedAt(raw: string): number | null {
  try {
    const at = (JSON.parse(raw) as { body?: { createdAt?: unknown } })?.body?.createdAt;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

/**
 * Carries Rust Pocket's requests from the learning document to the native
 * ledger and its results back (ADR 042). The phone writes `requests`; only
 * this relay writes `results` and `laptop`. Every request is admitted (shape,
 * learning-key signature, freshness) before it reaches the ledger, and the
 * ledger runs each attempt id at most once.
 */
export function createLearningRelay(options: RelayOptions) {
  const now = options.now ?? Date.now;
  const { doc, ledger } = options;
  /** id → the hash of the request it answers. */
  const pending = new Map<string, string>();
  let chain = Promise.resolve();
  let stopped = false;

  const refuse = (id: string, reason: RefusalReason, message = refusalMessage(reason)) =>
    doc.change((d) => { d.results[id] = doc.text(JSON.stringify({ refused: reason, message })); });

  async function admit(id: string, raw: string): Promise<void> {
    const known = await ledger.get(id);
    // A job already queued is finished even when its request is no longer
    // fresh (the app restarted); freshness only gates new work.
    const at = known ? bodyCreatedAt(raw) ?? now() : now();
    const admission = await admitRequest(id, raw, options.secret, at);
    if (stopped) return;
    if (!admission.ok) return refuse(id, admission.reason);
    if (!known) {
      try {
        await ledger.enqueue(toJobRequest(admission.request));
      } catch (error) {
        return refuse(id, "invalid", error instanceof Error ? error.message : String(error));
      }
    }
    pending.set(id, admission.hash);
  }

  async function publish(id: string, hash: string): Promise<void> {
    const job = await ledger.get(id);
    if (!job || job.status === "queued" || job.status === "running") return;
    const response: LearningResponse = { version: 1, id, requestHash: hash, at: now() };
    if (job.status === "interrupted") {
      response.error = "Workstreams stopped while working on this. Send it again.";
    } else if (job.kind === "help") {
      const { reply, error } = (job.result ?? {}) as { reply?: string | null; error?: string | null };
      if (reply) response.reply = reply;
      if (error) response.error = error;
    } else {
      response.result = job.result;
    }
    const envelope = await sign(response, options.secret);
    if (stopped) return;
    doc.change((d) => { d.results[id] = doc.text(JSON.stringify(envelope)); });
    pending.delete(id);
  }

  function prune(): void {
    const cutoff = now() - PRUNE_AFTER_MS;
    const current = doc.read();
    const old = Object.entries(current.requests).filter(([, raw]) => {
      const at = bodyCreatedAt(raw);
      return at !== null && at < cutoff;
    }).map(([id]) => id);
    if (old.length === 0) return;
    doc.change((d) => {
      for (const id of old) {
        delete d.requests[id];
        delete d.results[id];
      }
    });
  }

  async function pass(): Promise<void> {
    if (stopped) return;
    if (doc.read().schemaVersion !== SCHEMA_VERSION) {
      options.onStatus?.("update-needed");
      return;
    }
    options.onStatus?.("on");
    prune();
    // One copy per pass; only this relay writes results, so it stays accurate.
    const snapshot = doc.read();
    for (const [id, raw] of Object.entries(snapshot.requests)) {
      if (stopped) return;
      if (snapshot.results[id] !== undefined || pending.has(id)) continue;
      await admit(id, raw);
    }
    for (const [id, hash] of [...pending]) {
      if (stopped) return;
      await publish(id, hash);
    }
  }

  /** One pass, queued behind any running one. */
  function process(): Promise<void> {
    chain = chain.then(pass).catch((error) => options.onError?.(error));
    return chain;
  }

  function seen(): void {
    if (stopped || doc.read().schemaVersion !== SCHEMA_VERSION) return;
    const at = now();
    doc.change((d) => { d.laptop = { lastSeenAt: at }; });
  }

  /** Runs on every document change and every `pollMs`; returns stop. */
  function start(timing: { pollMs?: number; presenceMs?: number } = {}): () => void {
    const unsubscribe = doc.subscribe(() => void process());
    const poll = setInterval(() => void process(), timing.pollMs ?? 1000);
    const presence = () => { if (!stopped) doc.broadcast({ kind: "presence", sentAt: now() }); };
    const presenceTimer = setInterval(presence, timing.presenceMs ?? 10_000);
    const seenTimer = setInterval(seen, LAST_SEEN_EVERY_MS);
    seen();
    presence();
    void process();
    return () => {
      stopped = true;
      unsubscribe();
      clearInterval(poll);
      clearInterval(presenceTimer);
      clearInterval(seenTimer);
    };
  }

  return { process, start };
}

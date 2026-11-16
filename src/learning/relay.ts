import type { LearningDoc } from "./doc";
import {
  admitRequest,
  refusalMessage,
  requestHash,
  sign,
  verify,
  toJobRequest,
  SCHEMA_VERSION,
  type LearningResponse,
  type RefusalReason,
} from "./protocol";

/** A job in the native ledger (`learning_jobs.rs`), as the relay sees it. */
export interface LedgerJob {
  id: string;
  kind: "check" | "help" | "pack";
  status: "queued" | "running" | "finished" | "interrupted";
  /** A check's CheckResult, help's `{reply, error}`, or a pack's `{pack, validation, valid, error}`. */
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

/** When a result (signed, or an unsigned refusal) was published. */
function publishedAt(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; body?: { at?: unknown } };
    const at = parsed?.body?.at ?? parsed?.at;
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
  /** id → the request being worked on, and its hash. */
  const pending = new Map<string, { hash: string; raw: string }>();
  /**
   * id → the request text its current result answers. A result counts only
   * for the request it is bound to (by hash, and for signed results by the
   * current key): a re-signed request (after re-pairing) or a corrected one
   * is answered again rather than left with a stale answer.
   */
  const bound = new Map<string, string>();

  async function hashOf(raw: string): Promise<string | null> {
    try {
      const body = (JSON.parse(raw) as { body?: unknown })?.body;
      return body && typeof body === "object" ? await requestHash(body) : null;
    } catch {
      return null;
    }
  }

  async function isBound(id: string, raw: string, resultRaw: string): Promise<boolean> {
    if (bound.get(id) === raw) return true;
    let answer: { refused?: unknown; requestHash?: unknown; body?: { requestHash?: unknown }; signature?: unknown };
    try { answer = JSON.parse(resultRaw); } catch { return false; }
    const hash = await hashOf(raw);
    const ok = typeof answer.refused === "string"
      ? (answer.requestHash ?? null) === hash
      : answer.body?.requestHash === hash && (await verify(answer as never, options.secret).catch(() => false));
    if (ok) bound.set(id, raw);
    return ok;
  }
  let chain = Promise.resolve();
  let stopped = false;

  async function refuse(id: string, raw: string, reason: RefusalReason, message = refusalMessage(reason)): Promise<void> {
    const hash = await hashOf(raw);
    doc.change((d) => { d.results[id] = doc.text(JSON.stringify({ refused: reason, message, at: now(), ...(hash ? { requestHash: hash } : {}) })); });
    bound.set(id, raw);
  }

  async function admit(id: string, raw: string): Promise<void> {
    const known = await ledger.get(id);
    // A job already queued is finished even when its request is no longer
    // fresh (the app restarted); freshness only gates new work.
    const at = known ? bodyCreatedAt(raw) ?? now() : now();
    const admission = await admitRequest(id, raw, options.secret, at);
    if (stopped) return;
    if (!admission.ok) return refuse(id, raw, admission.reason);
    // Always through the ledger, even for a job it already has: its content
    // check is what stops a result being bound to another request's hash.
    try {
      await ledger.enqueue(toJobRequest(admission.request));
    } catch (error) {
      return refuse(id, raw, "invalid", error instanceof Error ? error.message : String(error));
    }
    pending.set(id, { hash: admission.hash, raw });
  }

  async function publish(id: string, { hash, raw }: { hash: string; raw: string }): Promise<void> {
    const job = await ledger.get(id);
    if (!job || job.status === "queued" || job.status === "running") return;
    const response: LearningResponse = { version: 1, id, requestHash: hash, at: now() };
    if (job.status === "interrupted") {
      response.error = "Workstreams stopped while working on this. Send it again.";
    } else if (job.kind === "pack") {
      const { pack, validation, valid, error } = (job.result ?? {}) as { pack?: unknown; validation?: unknown; valid?: boolean; error?: string | null };
      if (pack) response.pack = pack;
      response.validation = validation ?? [];
      response.valid = valid === true;
      if (error) response.error = error;
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
    bound.set(id, raw);
  }

  /**
   * Only answered requests are pruned, a week after their answer was
   * published: an unanswered one (even a retrieval of an old job) is first
   * handled, and its re-published result starts a new week.
   */
  function prune(): void {
    const cutoff = now() - PRUNE_AFTER_MS;
    const current = doc.read();
    const old = Object.entries(current.results).filter(([, raw]) => {
      const at = publishedAt(raw);
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
      if (pending.has(id)) continue;
      const answered = snapshot.results[id];
      if (answered !== undefined) {
        if (await isBound(id, raw, answered)) continue;
        // A request this key can't authenticate keeps whatever answer it has.
        const check = await admitRequest(id, raw, options.secret, bodyCreatedAt(raw) ?? now());
        if (!check.ok && (check.reason === "bad-signature" || check.reason === "not-paired")) {
          bound.set(id, raw);
          continue;
        }
      }
      await admit(id, raw);
    }
    for (const [id, work] of [...pending]) {
      if (stopped) return;
      await publish(id, work);
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

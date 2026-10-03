import { CLOCK_SKEW_MS, REQUEST_TTL_MS } from "./protocol";
import type { SettingsStore } from "./settings";

export const LEDGER_KEY = "companion.consumed";

/** Margin past the freshness window before an id is forgotten. */
const RETAIN_MARGIN_MS = 60_000;

export interface ConsumedLedger {
  /**
   * Reserves a request id for execution. Resolves `true` only for the first
   * caller ever (this process, and across restarts once saved); `false` means
   * it was already reserved. Rejects if the reservation could not be saved,
   * in which case the id stays reserved in memory and must not be run.
   */
  reserve(id: string, createdAt: number): Promise<boolean>;
}

const open = new WeakMap<SettingsStore, Promise<ConsumedLedger>>();

/**
 * The laptop's own record of which requests it has acted on (ADR 033).
 *
 * The shared document cannot be trusted for this: anyone who can write to it
 * can delete an outcome and replay a still-fresh signed request. This ledger
 * lives in the laptop's SQLite settings and is the authority on "already run".
 *
 * There is one instance per settings store, so a service that restarts (turn
 * off and on, a new secret) shares it with the generation it replaces: a
 * reservation is a synchronous check-and-set on one map, and writes of the
 * whole map are serialised, so neither can overwrite the other's ids.
 *
 * It fails closed: an unreadable ledger stops the companion rather than
 * forgetting what ran. Pairing a new phone resets it, which is safe because a
 * new secret invalidates every signature the old ids could replay.
 */
export function openConsumedLedger(store: SettingsStore, now: () => number = Date.now): Promise<ConsumedLedger> {
  let ledger = open.get(store);
  if (!ledger) {
    ledger = load(store, now);
    open.set(store, ledger);
    ledger.catch(() => { if (open.get(store) === ledger) open.delete(store); });
  }
  return ledger;
}

/** Forgets every consumed id. Call only together with a new pairing secret. */
export async function resetConsumedLedger(store: SettingsStore): Promise<void> {
  open.delete(store);
  await store.set(LEDGER_KEY, "{}");
}

const UNREADABLE = "The companion's record of handled requests is unreadable, so it stopped to avoid running a request twice. Pair a new phone in Settings to reset it.";

async function load(store: SettingsStore, now: () => number): Promise<ConsumedLedger> {
  const raw = await store.get(LEDGER_KEY);
  const entries = new Map<string, number>();
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(UNREADABLE);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(UNREADABLE);
    for (const [id, createdAt] of Object.entries(parsed)) {
      if (typeof createdAt !== "number") throw new Error(UNREADABLE);
      entries.set(id, createdAt);
    }
  }

  const keep = (createdAt: number, at: number) =>
    at - createdAt <= REQUEST_TTL_MS + CLOCK_SKEW_MS + RETAIN_MARGIN_MS;
  let writes: Promise<void> = Promise.resolve();

  return {
    reserve(id, createdAt) {
      if (entries.has(id)) return Promise.resolve(false);
      entries.set(id, createdAt);
      const at = now();
      for (const [key, value] of entries) if (key !== id && !keep(value, at)) entries.delete(key);
      // Each write saves the map as it is when the write runs, after every
      // earlier write: a slow write can never land on top of a newer one.
      const write = writes.then(() => store.set(LEDGER_KEY, JSON.stringify(Object.fromEntries(entries))));
      writes = write.catch(() => {});
      return write.then(() => true);
    },
  };
}

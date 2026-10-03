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

interface StoreState {
  /** The one map of reserved ids for this store, for the life of the process. */
  entries: Map<string, number>;
  /** Serialises every write of `entries`. */
  writes: Promise<void>;
  /** The opened ledger; null until loaded, and again after a failed load. */
  ledger: Promise<ConsumedLedger> | null;
  loaded: boolean;
}

const states = new WeakMap<SettingsStore, StoreState>();

function stateFor(store: SettingsStore): StoreState {
  let state = states.get(store);
  if (!state) {
    state = { entries: new Map(), writes: Promise.resolve(), ledger: null, loaded: false };
    states.set(store, state);
  }
  return state;
}

/**
 * The laptop's own record of which requests it has acted on (ADR 033).
 *
 * The shared document cannot be trusted for this: anyone who can write to it
 * can delete an outcome and replay a still-fresh signed request. This ledger
 * lives in the laptop's SQLite settings and is the authority on "already run".
 *
 * There is exactly one map per settings store for the life of the process,
 * shared by every generation of the service: a reservation is a synchronous
 * check-and-set on it, and every write saves the whole map as it is when the
 * write runs, in order. Nothing ever replaces or clears the map, so no
 * generation can drop another's ids.
 *
 * It fails closed: an unreadable ledger stops the companion rather than
 * forgetting what ran. Pairing a new phone repairs unreadable storage.
 */
export function openConsumedLedger(store: SettingsStore, now: () => number = Date.now): Promise<ConsumedLedger> {
  const state = stateFor(store);
  if (!state.ledger) {
    const ledger = load(store, state, now);
    state.ledger = ledger;
    ledger.catch(() => { if (state.ledger === ledger) state.ledger = null; });
  }
  return state.ledger;
}

/**
 * Replaces an unreadable stored ledger with an empty one, so the companion can
 * start again. A ledger that loaded fine is left alone: its ids age out on
 * their own, and clearing them could re-open replays. Call it before rotating
 * the pairing secret, which voids every signature an unreadable ledger knew.
 */
export async function resetConsumedLedger(store: SettingsStore): Promise<void> {
  const state = stateFor(store);
  if (state.loaded) return;
  const write = state.writes.then(() => store.set(LEDGER_KEY, JSON.stringify(Object.fromEntries(state.entries))));
  state.writes = write.catch(() => {});
  await write;
}

const UNREADABLE = "The companion's record of handled requests is unreadable, so it stopped to avoid running a request twice. Pair a new phone in Settings to reset it.";

async function load(store: SettingsStore, state: StoreState, now: () => number): Promise<ConsumedLedger> {
  // Read only after earlier writes (a reset) have landed.
  await state.writes;
  const raw = await store.get(LEDGER_KEY);
  const stored = new Map<string, number>();
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
      stored.set(id, createdAt);
    }
  }
  // Merge, never replace: ids reserved in memory before this load stay.
  for (const [id, createdAt] of stored) if (!state.entries.has(id)) state.entries.set(id, createdAt);
  state.loaded = true;

  const keep = (createdAt: number, at: number) =>
    at - createdAt <= REQUEST_TTL_MS + CLOCK_SKEW_MS + RETAIN_MARGIN_MS;
  const entries = state.entries;

  return {
    reserve(id, createdAt) {
      if (entries.has(id)) return Promise.resolve(false);
      entries.set(id, createdAt);
      const at = now();
      for (const [key, value] of entries) if (key !== id && !keep(value, at)) entries.delete(key);
      // Each write saves the map as it is when the write runs, after every
      // earlier write: a slow write can never land on top of a newer one.
      const write = state.writes.then(() => store.set(LEDGER_KEY, JSON.stringify(Object.fromEntries(entries))));
      state.writes = write.catch(() => {});
      return write.then(() => true);
    },
  };
}

import { CLOCK_SKEW_MS, REQUEST_TTL_MS } from "./protocol";
import type { SettingsStore } from "./settings";

export const LEDGER_KEY = "companion.consumed";

/** Margin past the freshness window before an id is forgotten. */
const RETAIN_MARGIN_MS = 60_000;

export interface ConsumedLedger {
  has(id: string): boolean;
  /** Records the id before its request is acted on. Rejects if it could not be saved. */
  consume(id: string, createdAt: number): Promise<void>;
}

/**
 * The laptop's own record of which requests it has acted on (ADR 033).
 *
 * The shared document cannot be trusted for this: anyone who can write to it
 * can delete an outcome and replay a still-fresh signed request. This ledger
 * lives in the laptop's SQLite settings, so it is the authority on "already
 * run". An id only needs remembering while its request could still pass the
 * freshness check; after that the signature check rejects it anyway.
 */
export async function createConsumedLedger(store: SettingsStore, now: () => number = Date.now): Promise<ConsumedLedger> {
  const entries = new Map<string, number>();
  try {
    const raw = JSON.parse((await store.get(LEDGER_KEY)) ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [id, createdAt] of Object.entries(raw)) {
        if (typeof createdAt === "number") entries.set(id, createdAt);
      }
    }
  } catch {
    // A corrupt ledger is treated as empty; freshness still bounds replays.
  }

  const keep = (createdAt: number, at: number) =>
    at - createdAt <= REQUEST_TTL_MS + CLOCK_SKEW_MS + RETAIN_MARGIN_MS;

  return {
    has: (id) => entries.has(id),
    async consume(id, createdAt) {
      entries.set(id, createdAt);
      const at = now();
      for (const [key, value] of entries) if (!keep(value, at)) entries.delete(key);
      await store.set(LEDGER_KEY, JSON.stringify(Object.fromEntries(entries)));
    },
  };
}

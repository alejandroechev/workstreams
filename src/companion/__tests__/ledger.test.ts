import { describe, it, expect } from "vitest";
import { openConsumedLedger, resetConsumedLedger, LEDGER_KEY } from "../ledger";
import { CLOCK_SKEW_MS, REQUEST_TTL_MS } from "../protocol";
import type { SettingsStore } from "../settings";

function memoryStore(initial: Record<string, string> = {}): SettingsStore & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => { data[k] = v; } };
}

const NOW = 1_700_000_000_000;

describe("consumed-request ledger", () => {
  it("reserves an id once, durably", async () => {
    const store = memoryStore();
    const ledger = await openConsumedLedger(store, () => NOW);
    expect(await ledger.reserve("r1", NOW)).toBe(true);
    expect(await ledger.reserve("r1", NOW)).toBe(false);
    expect(Object.keys(JSON.parse(store.data[LEDGER_KEY]))).toEqual(["r1"]);
  });

  it("is one shared instance per store, so two service generations cannot both reserve an id", async () => {
    const store = memoryStore();
    const [a, b] = await Promise.all([openConsumedLedger(store, () => NOW), openConsumedLedger(store, () => NOW)]);
    expect(a).toBe(b);
    const results = await Promise.all([a.reserve("r1", NOW), b.reserve("r1", NOW), b.reserve("r2", NOW)]);
    expect(results).toEqual([true, false, true]);
    expect(Object.keys(JSON.parse(store.data[LEDGER_KEY])).sort()).toEqual(["r1", "r2"]);
  });

  it("serialises writes so a slow earlier write never overwrites a later one", async () => {
    const data: Record<string, string> = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const store: SettingsStore = {
      get: async (k) => data[k] ?? null,
      set: async (k, v) => { if (first) { first = false; await gate; } data[k] = v; },
    };
    const ledger = await openConsumedLedger(store, () => NOW);
    const one = ledger.reserve("r1", NOW);
    const two = ledger.reserve("r2", NOW);
    release();
    await Promise.all([one, two]);
    expect(Object.keys(JSON.parse(data[LEDGER_KEY])).sort()).toEqual(["r1", "r2"]);
  });

  it("forgets ids once their request could no longer pass the freshness check", async () => {
    const store = memoryStore();
    const ledger = await openConsumedLedger(store, () => NOW);
    await ledger.reserve("old", NOW - REQUEST_TTL_MS - CLOCK_SKEW_MS - 60_001);
    await ledger.reserve("fresh", NOW - REQUEST_TTL_MS);
    await ledger.reserve("future", NOW + CLOCK_SKEW_MS);
    expect(Object.keys(JSON.parse(store.data[LEDGER_KEY])).sort()).toEqual(["fresh", "future"]);
  });

  it("fails closed when the stored ledger cannot be read or parsed", async () => {
    await expect(openConsumedLedger(memoryStore({ [LEDGER_KEY]: "{nope" }))).rejects.toThrow(/Pair a new phone/);
    await expect(openConsumedLedger(memoryStore({ [LEDGER_KEY]: "[1]" }))).rejects.toThrow(/Pair a new phone/);
    const broken: SettingsStore = { get: async () => { throw new Error("db locked"); }, set: async () => {} };
    await expect(openConsumedLedger(broken)).rejects.toThrow("db locked");
  });

  it("retries opening after a failure instead of caching it", async () => {
    let fail = true;
    const data: Record<string, string> = {};
    const store: SettingsStore = { get: async (k) => { if (fail) throw new Error("db locked"); return data[k] ?? null; }, set: async (k, v) => { data[k] = v; } };
    await expect(openConsumedLedger(store)).rejects.toThrow();
    fail = false;
    expect(await (await openConsumedLedger(store, () => NOW)).reserve("r", NOW)).toBe(true);
  });

  it("can be reset, which is only safe together with a new pairing secret", async () => {
    const store = memoryStore({ [LEDGER_KEY]: "{nope" });
    await resetConsumedLedger(store);
    const ledger = await openConsumedLedger(store, () => NOW);
    expect(await ledger.reserve("r1", NOW)).toBe(true);
  });

  it("reports a reservation it could not save, and still refuses the id afterwards", async () => {
    const store: SettingsStore = { get: async () => null, set: async () => { throw new Error("disk full"); } };
    const ledger = await openConsumedLedger(store, () => NOW);
    await expect(ledger.reserve("r1", NOW)).rejects.toThrow("disk full");
    expect(await ledger.reserve("r1", NOW).catch(() => "rejected")).toBe(false);
  });

  it("is not fooled by inherited property names", async () => {
    const ledger = await openConsumedLedger(memoryStore(), () => NOW);
    expect(await ledger.reserve("constructor", NOW)).toBe(true);
    expect(await ledger.reserve("__proto__", NOW)).toBe(true);
  });
});

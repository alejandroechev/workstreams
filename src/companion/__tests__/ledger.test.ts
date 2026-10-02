import { describe, it, expect } from "vitest";
import { createConsumedLedger, LEDGER_KEY } from "../ledger";
import { CLOCK_SKEW_MS, REQUEST_TTL_MS } from "../protocol";
import type { SettingsStore } from "../settings";

function memoryStore(initial: Record<string, string> = {}): SettingsStore & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => { data[k] = v; } };
}

const NOW = 1_700_000_000_000;

describe("consumed-request ledger", () => {
  it("remembers a consumed id, durably", async () => {
    const store = memoryStore();
    const ledger = await createConsumedLedger(store, () => NOW);
    expect(ledger.has("r1")).toBe(false);
    await ledger.consume("r1", NOW);
    expect(ledger.has("r1")).toBe(true);
    const reopened = await createConsumedLedger(store, () => NOW + 1000);
    expect(reopened.has("r1")).toBe(true);
  });

  it("forgets ids once their request could no longer pass the freshness check", async () => {
    const store = memoryStore();
    const ledger = await createConsumedLedger(store, () => NOW);
    await ledger.consume("old", NOW - REQUEST_TTL_MS - CLOCK_SKEW_MS - 60_001);
    await ledger.consume("fresh", NOW - REQUEST_TTL_MS);
    expect(Object.keys(JSON.parse(store.data[LEDGER_KEY]))).toEqual(["fresh"]);
  });

  it("keeps future-dated ids for the skew window too", async () => {
    const store = memoryStore();
    const ledger = await createConsumedLedger(store, () => NOW);
    await ledger.consume("future", NOW + CLOCK_SKEW_MS);
    expect((await createConsumedLedger(store, () => NOW)).has("future")).toBe(true);
  });

  it("treats a corrupt stored ledger as empty", async () => {
    const ledger = await createConsumedLedger(memoryStore({ [LEDGER_KEY]: "{nope" }), () => NOW);
    expect(ledger.has("x")).toBe(false);
  });

  it("is not fooled by inherited property names", async () => {
    const ledger = await createConsumedLedger(memoryStore(), () => NOW);
    expect(ledger.has("constructor")).toBe(false);
    expect(ledger.has("__proto__")).toBe(false);
  });

  it("refuses to report a consume as done when it could not be saved", async () => {
    const store: SettingsStore = { get: async () => null, set: async () => { throw new Error("disk full"); } };
    const ledger = await createConsumedLedger(store, () => NOW);
    await expect(ledger.consume("r1", NOW)).rejects.toThrow("disk full");
    expect(ledger.has("r1")).toBe(true);
  });
});

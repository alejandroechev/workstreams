import { describe, expect, it, vi } from "vitest";
import { createMemorySettingsStore, loadCompanionSettings } from "../../companion/settings";
import {
  loadLearningSettings,
  onLearningSettingsChanged,
  pairLearning,
  setUpLearning,
  unpairLearning,
  type SetUpDeps,
} from "../settings";

const deps = (over: Partial<SetUpDeps> = {}): SetUpDeps => ({
  authRequired: vi.fn(async () => true),
  register: vi.fn(async () => ({ token: "own-token" })),
  createDocument: vi.fn(async () => "automerge:learn"),
  deviceName: "Workstreams laptop",
  ...over,
});

const COMPANION = {
  "companion.enabled": "1",
  "companion.server_url": "https://sync.example",
  "companion.token": "companion-token",
  "companion.doc_url": "automerge:companion",
  "companion.secret": "companion-secret",
};

describe("learning settings", () => {
  it("reuses the companion's enrolment on the same server and creates its own document and key", async () => {
    const store = createMemorySettingsStore(COMPANION);
    const d = deps();
    expect(await setUpLearning(store, d, { serverUrl: "https://sync.example" })).toEqual({ ok: true });
    expect(d.register).not.toHaveBeenCalled();
    expect(d.createDocument).toHaveBeenCalledWith({ serverUrl: "https://sync.example", token: "companion-token" });
    const learning = await loadLearningSettings(store);
    expect(learning).toMatchObject({ serverUrl: "https://sync.example", token: "companion-token", docUrl: "automerge:learn" });
    expect(learning.secret).toMatch(/^[a-f0-9]{64}$/);
    expect(learning.docUrl).not.toBe("automerge:companion");
  });

  it("asks for the registration key once when nothing is enrolled", async () => {
    const store = createMemorySettingsStore();
    const d = deps();
    expect(await setUpLearning(store, d, { serverUrl: "https://other.example" })).toMatchObject({ ok: false, needsRegistrationKey: true });
    expect(await setUpLearning(store, d, { serverUrl: "https://other.example", registrationKey: "k" })).toEqual({ ok: true });
    expect(d.register).toHaveBeenCalledWith("https://other.example", "Workstreams laptop", "k");
    expect((await loadLearningSettings(store)).token).toBe("own-token");
  });

  it("reports a failure without saving a half setup", async () => {
    const store = createMemorySettingsStore(COMPANION);
    const result = await setUpLearning(store, deps({ createDocument: async () => { throw new Error("offline"); } }), {});
    expect(result).toEqual({ ok: false, error: "offline" });
    expect((await loadLearningSettings(store)).secret).toBe("");
  });

  it("unpairs and re-pairs on its own, leaving the companion paired", async () => {
    const store = createMemorySettingsStore(COMPANION);
    await setUpLearning(store, deps(), {});
    const first = (await loadLearningSettings(store)).secret;
    const seen = vi.fn();
    const off = onLearningSettingsChanged(seen);
    await unpairLearning(store);
    expect((await loadLearningSettings(store)).secret).toBe("");
    expect((await loadLearningSettings(store)).docUrl).toBe("automerge:learn");
    expect(await loadCompanionSettings(store)).toMatchObject({ enabled: true, secret: "companion-secret" });
    await pairLearning(store);
    const second = (await loadLearningSettings(store)).secret;
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(await loadCompanionSettings(store)).toMatchObject({ enabled: true, secret: "companion-secret" });
    expect(seen).toHaveBeenCalledTimes(2);
    off();
  });
});

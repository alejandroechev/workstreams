import { describe, it, expect, vi } from "vitest";
import {
  createMemorySettingsStore,
  loadCompanionSettings,
  enableCompanion,
  disableCompanion,
  repairPhone,
  DEFAULT_COMPANION_SETTINGS,
  type EnableDeps,
} from "../settings";

const deps = (over: Partial<EnableDeps> = {}): EnableDeps => ({
  authRequired: vi.fn(async () => true),
  register: vi.fn(async () => ({ token: "jwt", deviceId: "d" })),
  createDocument: vi.fn(async () => "automerge:NewDoc"),
  generateSecret: vi.fn(() => "s".repeat(43)),
  deviceName: "Workstreams on test-mac",
  ...over,
});

describe("companion settings", () => {
  it("are off by default, pointing at the owner's sync server", async () => {
    const settings = await loadCompanionSettings(createMemorySettingsStore());
    expect(settings).toEqual(DEFAULT_COMPANION_SETTINGS);
    expect(settings.enabled).toBe(false);
    expect(settings.serverUrl).toBe("https://sync.stormlab.app");
    expect(settings.folderRoot).toBe("~/Workstreams");
  });
});

describe("enabling the companion", () => {
  it("enrols the laptop, creates the document and a pairing secret, then turns on", async () => {
    const store = createMemorySettingsStore();
    const d = deps();
    const result = await enableCompanion(store, d, { registrationKey: "key" });
    expect(result).toEqual({ ok: true });
    expect(d.register).toHaveBeenCalledWith("https://sync.stormlab.app", "Workstreams on test-mac", "key");
    expect(d.createDocument).toHaveBeenCalledWith({ serverUrl: "https://sync.stormlab.app", token: "jwt" });
    expect(await loadCompanionSettings(store)).toMatchObject({
      enabled: true, token: "jwt", docUrl: "automerge:NewDoc", secret: "s".repeat(43),
    });
  });

  it("asks for the registration key when the server needs one and none was given", async () => {
    const store = createMemorySettingsStore();
    const d = deps();
    expect(await enableCompanion(store, d, {})).toEqual({ ok: false, needsRegistrationKey: true, error: expect.any(String) });
    expect(d.createDocument).not.toHaveBeenCalled();
    expect((await loadCompanionSettings(store)).enabled).toBe(false);
  });

  it("skips enrolment on a server without auth", async () => {
    const store = createMemorySettingsStore();
    const d = deps({ authRequired: vi.fn(async () => false) });
    expect(await enableCompanion(store, d, {})).toEqual({ ok: true });
    expect(d.register).not.toHaveBeenCalled();
  });

  it("re-enabling reuses the document, the token and the paired phone", async () => {
    const store = createMemorySettingsStore();
    await enableCompanion(store, deps(), { registrationKey: "key" });
    await disableCompanion(store);
    const again = deps();
    expect(await enableCompanion(store, again, {})).toEqual({ ok: true });
    expect(again.register).not.toHaveBeenCalled();
    expect(again.createDocument).not.toHaveBeenCalled();
    expect(again.generateSecret).not.toHaveBeenCalled();
  });

  it("stays off and reports the reason when the server rejects the key", async () => {
    const store = createMemorySettingsStore();
    const d = deps({ register: vi.fn(async () => { throw new Error("Invalid registration key"); }) });
    expect(await enableCompanion(store, d, { registrationKey: "bad" })).toEqual({ ok: false, error: "Invalid registration key" });
    expect((await loadCompanionSettings(store)).enabled).toBe(false);
  });
});

describe("pairing a new phone", () => {
  it("replaces the secret, so the old phone's requests are refused", async () => {
    const store = createMemorySettingsStore();
    await enableCompanion(store, deps(), { registrationKey: "key" });
    await repairPhone(store, () => "n".repeat(43));
    expect((await loadCompanionSettings(store)).secret).toBe("n".repeat(43));
  });
});

describe("disabling", () => {
  it("turns it off but keeps the document and pairing for next time", async () => {
    const store = createMemorySettingsStore();
    await enableCompanion(store, deps(), { registrationKey: "key" });
    await disableCompanion(store);
    expect(await loadCompanionSettings(store)).toMatchObject({ enabled: false, docUrl: "automerge:NewDoc", secret: "s".repeat(43) });
  });
});

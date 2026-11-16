import { DEFAULT_COMPANION_SETTINGS, loadCompanionSettings, type SettingsStore } from "../companion/settings";
import { generateLearningSecret } from "./protocol";

/**
 * Rust Pocket learning pairing (ADR 042). Its own document and its own key,
 * apart from the companion's, so a leaked key from one app cannot drive the
 * other and either can be unpaired alone. Only the sync server enrolment
 * (the device token) is shared, and only when both use the same server.
 */
export interface LearningSettings {
  serverUrl: string;
  /** SyncEngine device token; empty when the server needs none. */
  token: string;
  /** The learning document, created on first setup and kept across pairings. */
  docUrl: string;
  /** HMAC key shared only with the paired Rust Pocket; empty when unpaired. */
  secret: string;
}

const KEYS: Record<keyof LearningSettings, string> = {
  serverUrl: "learning.server_url",
  token: "learning.token",
  docUrl: "learning.doc_url",
  secret: "learning.secret",
};

type Listener = (settings: LearningSettings) => void;
const listeners = new Set<Listener>();

export function onLearningSettingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadLearningSettings(store: SettingsStore): Promise<LearningSettings> {
  const settings: LearningSettings = { serverUrl: "", token: "", docUrl: "", secret: "" };
  for (const field of Object.keys(KEYS) as Array<keyof LearningSettings>) {
    settings[field] = (await store.get(KEYS[field])) ?? "";
  }
  // Not set up yet: offer the companion's server, whose enrolment can be reused.
  if (!settings.serverUrl) settings.serverUrl = (await store.get("companion.server_url")) || DEFAULT_COMPANION_SETTINGS.serverUrl;
  return settings;
}

async function save(store: SettingsStore, patch: Partial<LearningSettings>): Promise<LearningSettings> {
  for (const [field, value] of Object.entries(patch) as Array<[keyof LearningSettings, string]>) {
    await store.set(KEYS[field], value);
  }
  const settings = await loadLearningSettings(store);
  for (const listener of listeners) listener(settings);
  return settings;
}

export interface SetUpDeps {
  authRequired(serverUrl: string): Promise<boolean>;
  register(serverUrl: string, deviceName: string, registrationKey: string): Promise<{ token: string }>;
  createDocument(options: { serverUrl: string; token: string }): Promise<string>;
  deviceName: string;
}

export type SetUpResult = { ok: true } | { ok: false; error: string; needsRegistrationKey?: boolean };

/** Creates the learning document and its first key, enrolling only if needed. */
export async function setUpLearning(
  store: SettingsStore,
  deps: SetUpDeps,
  input: { serverUrl?: string; registrationKey?: string },
): Promise<SetUpResult> {
  const current = await loadLearningSettings(store);
  const companion = await loadCompanionSettings(store);
  const serverUrl = (input.serverUrl ?? current.serverUrl).trim();
  try {
    let token = serverUrl === current.serverUrl ? current.token : "";
    if (!token && companion.token && companion.serverUrl === serverUrl) token = companion.token;
    if (!token && (await deps.authRequired(serverUrl))) {
      const key = input.registrationKey?.trim();
      if (!key) return { ok: false, needsRegistrationKey: true, error: "This sync server needs its registration key once." };
      token = (await deps.register(serverUrl, deps.deviceName, key)).token;
      await save(store, { serverUrl, token, ...(serverUrl !== current.serverUrl ? { docUrl: "" } : {}) });
    }
    const docUrl = serverUrl === current.serverUrl && current.docUrl ? current.docUrl : await deps.createDocument({ serverUrl, token });
    await save(store, { serverUrl, token, docUrl, secret: current.secret || generateLearningSecret() });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A new key: whichever phone held the old one can no longer send checks. */
export async function pairLearning(store: SettingsStore): Promise<void> {
  await save(store, { secret: generateLearningSecret() });
}

/** Forgets the key. The document stays, so pairing again needs no network. */
export async function unpairLearning(store: SettingsStore): Promise<void> {
  await save(store, { secret: "" });
}

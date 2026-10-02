import { invoke } from "@tauri-apps/api/core";

/**
 * Phone companion settings (ADR 033). Kept apart from AppSettings because two
 * of them are secrets (the sync device token and the pairing secret), and
 * AppSettings is cached and read from render code.
 */
export interface CompanionSettings {
  enabled: boolean;
  serverUrl: string;
  /** SyncEngine device token (JWT); empty when the server needs none. */
  token: string;
  /** The companion document, created on first enable. */
  docUrl: string;
  /** HMAC key shared only with the paired phone. */
  secret: string;
  /** Where workstreams created from the phone get their folders. */
  folderRoot: string;
}

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  enabled: false,
  serverUrl: "https://sync.stormlab.app",
  token: "",
  docUrl: "",
  secret: "",
  folderRoot: "~/Workstreams",
};

const KEYS: Record<keyof CompanionSettings, string> = {
  enabled: "companion.enabled",
  serverUrl: "companion.server_url",
  token: "companion.token",
  docUrl: "companion.doc_url",
  secret: "companion.secret",
  folderRoot: "companion.folder_root",
};

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The SQLite settings table, through the existing Tauri commands. */
export const tauriSettingsStore: SettingsStore = {
  get: (key) => invoke<string | null>("get_setting", { key }),
  set: async (key, value) => { await invoke("set_setting", { key, value }); },
};

export function createMemorySettingsStore(initial: Record<string, string> = {}): SettingsStore {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); },
  };
}

type Listener = (settings: CompanionSettings) => void;
const listeners = new Set<Listener>();

/** Notified whenever these settings are saved, so the running service restarts. */
export function onCompanionSettingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function loadCompanionSettings(store: SettingsStore): Promise<CompanionSettings> {
  const entries = await Promise.all(
    (Object.keys(KEYS) as Array<keyof CompanionSettings>).map(async (field) => [field, await store.get(KEYS[field])] as const),
  );
  const settings = { ...DEFAULT_COMPANION_SETTINGS };
  for (const [field, raw] of entries) {
    if (raw === null || raw === "") continue;
    if (field === "enabled") settings.enabled = raw === "1";
    else settings[field] = raw;
  }
  return settings;
}

export async function saveCompanionSettings(store: SettingsStore, patch: Partial<CompanionSettings>): Promise<CompanionSettings> {
  for (const [field, value] of Object.entries(patch) as Array<[keyof CompanionSettings, string | boolean]>) {
    await store.set(KEYS[field], typeof value === "boolean" ? (value ? "1" : "0") : value);
  }
  const settings = await loadCompanionSettings(store);
  for (const listener of listeners) listener(settings);
  return settings;
}

export interface EnableDeps {
  authRequired(serverUrl: string): Promise<boolean>;
  register(serverUrl: string, deviceName: string, registrationKey: string): Promise<{ token: string }>;
  /** Creates the companion document on the server and returns its URL. */
  createDocument(options: { serverUrl: string; token: string }): Promise<string>;
  generateSecret(): string;
  deviceName: string;
}

export type EnableResult =
  | { ok: true }
  | { ok: false; error: string; needsRegistrationKey?: boolean };

/**
 * Turns the companion on, doing only the setup still missing: enrol this
 * machine, create the document, mint the pairing secret. Re-enabling reuses
 * all three, so the paired phone keeps working.
 */
export async function enableCompanion(
  store: SettingsStore,
  deps: EnableDeps,
  input: { serverUrl?: string; registrationKey?: string },
): Promise<EnableResult> {
  const current = await loadCompanionSettings(store);
  const serverUrl = (input.serverUrl ?? current.serverUrl).trim();
  try {
    let token = serverUrl === current.serverUrl ? current.token : "";
    if (!token && (await deps.authRequired(serverUrl))) {
      const key = input.registrationKey?.trim();
      if (!key) {
        return { ok: false, needsRegistrationKey: true, error: "This sync server needs its registration key once." };
      }
      token = (await deps.register(serverUrl, deps.deviceName, key)).token;
    }
    const docUrl = serverUrl === current.serverUrl && current.docUrl
      ? current.docUrl
      : await deps.createDocument({ serverUrl, token });
    const secret = current.secret || deps.generateSecret();
    await saveCompanionSettings(store, { serverUrl, token, docUrl, secret, enabled: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disableCompanion(store: SettingsStore): Promise<void> {
  await saveCompanionSettings(store, { enabled: false });
}

/** A new secret: the previously paired phone can no longer make the laptop act. */
export async function repairPhone(store: SettingsStore, generateSecret: () => string): Promise<void> {
  await saveCompanionSettings(store, { secret: generateSecret() });
}

/**
 * App-level user settings (single-user desktop, persisted to localStorage).
 *
 * Currently exposes:
 *  - `terminalScrollSpeed`: multiplier for wheel-driven terminal scroll. 1.0 is
 *    the legacy speed (1 line per 120px wheel tick). 0.5 halves it, 2.0 doubles
 *    it. Clamped to [0.1, 5].
 */

const STORAGE_KEY = "ws.app-settings.v1";

export interface AppSettings {
  terminalScrollSpeed: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  terminalScrollSpeed: 0.5,
};

export const SCROLL_SPEED_MIN = 0.1;
export const SCROLL_SPEED_MAX = 5;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.terminalScrollSpeed;
  return Math.min(max, Math.max(min, value));
}

export function sanitize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const speed =
    typeof raw.terminalScrollSpeed === "number"
      ? clamp(raw.terminalScrollSpeed, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX)
      : DEFAULT_SETTINGS.terminalScrollSpeed;
  return { terminalScrollSpeed: speed };
}

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();

let cached: AppSettings | null = null;

function readStorage(): AppSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitize(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeStorage(s: AppSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function getAppSettings(): AppSettings {
  if (!cached) cached = readStorage();
  return cached;
}

export function setAppSettings(next: Partial<AppSettings>): AppSettings {
  const merged = sanitize({ ...getAppSettings(), ...next });
  cached = merged;
  writeStorage(merged);
  for (const l of listeners) {
    try {
      l(merged);
    } catch {
      /* ignore */
    }
  }
  return merged;
}

export function subscribeAppSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear cache so the next get reads fresh from storage. */
export function _resetAppSettingsCacheForTests(): void {
  cached = null;
  listeners.clear();
}

/**
 * Convert a wheel `deltaY` plus the current scroll speed into an integer
 * number of lines to scroll. Always returns at least 1 so a small tick is
 * not lost.
 */
export function wheelDeltaToLines(deltaY: number, scrollSpeed: number): number {
  const baseLines = Math.abs(deltaY) / 120;
  const scaled = baseLines * scrollSpeed;
  return Math.max(1, Math.round(scaled));
}

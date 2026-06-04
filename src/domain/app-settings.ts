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
  mermaidFontSize: number;
  noVerifyBlockingEnabled: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  terminalScrollSpeed: 0.5,
  mermaidFontSize: 12,
  noVerifyBlockingEnabled: true,
};

export const SCROLL_SPEED_MIN = 0.1;
export const SCROLL_SPEED_MAX = 5;
export const MERMAID_FONT_SIZE_MIN = 8;
export const MERMAID_FONT_SIZE_MAX = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sanitize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const speed =
    typeof raw.terminalScrollSpeed === "number" && Number.isFinite(raw.terminalScrollSpeed)
      ? clamp(raw.terminalScrollSpeed, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX)
      : DEFAULT_SETTINGS.terminalScrollSpeed;
  const fontSize =
    typeof raw.mermaidFontSize === "number" && Number.isFinite(raw.mermaidFontSize)
      ? clamp(raw.mermaidFontSize, MERMAID_FONT_SIZE_MIN, MERMAID_FONT_SIZE_MAX)
      : DEFAULT_SETTINGS.mermaidFontSize;
  const noVerifyBlockingEnabled =
    typeof raw.noVerifyBlockingEnabled === "boolean"
      ? raw.noVerifyBlockingEnabled
      : DEFAULT_SETTINGS.noVerifyBlockingEnabled;
  return {
    terminalScrollSpeed: speed,
    mermaidFontSize: Math.round(fontSize),
    noVerifyBlockingEnabled,
  };
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

// Expose a tiny debug bridge so CDP/E2E probes can set settings directly
// without driving the UI (avoids slider-dragging flakiness). Single-user
// desktop app — no security impact.
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as { __wsAppSettings?: unknown }).__wsAppSettings = {
    get: getAppSettings,
    set: setAppSettings,
  };
}

/**
 * Convert a wheel `deltaY` plus the current scroll speed into an integer
 * number of lines to scroll. Always returns at least 1 so a small tick is
 * not lost.
 *
 * Note: prefer `createWheelLineAccumulator` for actual wheel handlers — the
 * floor-to-1 here is what made the scroll-speed setting feel like a no-op
 * for precision touchpad / smooth-wheel events (where individual deltaY
 * values are small and the floor swallowed the speed multiplier entirely).
 */
export function wheelDeltaToLines(deltaY: number, scrollSpeed: number): number {
  const baseLines = Math.abs(deltaY) / 120;
  const scaled = baseLines * scrollSpeed;
  return Math.max(1, Math.round(scaled));
}

/**
 * Stateful wheel-to-lines converter. Accumulates fractional lines across
 * events so that low scroll speeds produce noticeably slower scrolling on
 * precision touchpads and smooth-wheel devices (where each event has a
 * small deltaY).
 *
 * Returns a function that takes a (signed) `deltaY` and returns the (signed)
 * integer number of lines to scroll on this event. Direction changes reset
 * the pending fractional accumulator so a flip doesn't get swallowed by
 * partial credit in the opposite direction.
 */
export function createWheelLineAccumulator(
  getSpeed: () => number,
): (deltaY: number) => number {
  let pending = 0; // signed, in lines
  return (deltaY: number) => {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
    const speed = getSpeed();
    const baseLines = deltaY / 120;
    const scaled = baseLines * speed;
    if (pending !== 0 && Math.sign(scaled) !== Math.sign(pending)) {
      pending = 0;
    }
    pending += scaled;
    if (Math.abs(pending) < 1) return 0;
    const lines = Math.trunc(pending);
    pending -= lines;
    return lines;
  };
}

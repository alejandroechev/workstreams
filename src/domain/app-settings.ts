/**
 * App-level user settings (single-user desktop).
 *
 * Persisted in the SQLite settings table via the Tauri `get_setting`/
 * `set_setting` commands so they survive localStorage wipes and are ready
 * for multi-window / cross-process consumers (e.g. workstreams-mcp).
 * A small in-memory cache + synchronous getter is kept so existing
 * callsites that read settings during render don't need to be async.
 *
 * Currently exposes:
 *  - `terminalScrollSpeed`: multiplier for wheel-driven terminal scroll. 1.0
 *    is the legacy speed (1 line per 120px wheel tick). 0.5 halves it.
 *    Clamped to [0.1, 5].
 *  - `textFontSize`: Monaco code editor font size (raw source/text files).
 *  - `markdownFontSize`: MarkdownView rendered body font size.
 *  - `terminalFontSize`: xterm cell-grid font size.
 *
 * Three legacy settings are silently dropped on first hydrate:
 *  - `mermaidFontSize` (in-diagram font feature was removed).
 *  - The old localStorage blob `ws.app-settings.v1` is migrated into SQLite
 *    once, then ignored on subsequent loads.
 */

import { invoke } from "@tauri-apps/api/core";

const LEGACY_STORAGE_KEY = "ws.app-settings.v1";

const SQL_KEYS = {
  terminalScrollSpeed: "app.terminal_scroll_speed",
  textFontSize: "app.font.text",
  markdownFontSize: "app.font.markdown",
  terminalFontSize: "app.font.terminal",
} as const;

export interface AppSettings {
  terminalScrollSpeed: number;
  textFontSize: number;
  markdownFontSize: number;
  terminalFontSize: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  terminalScrollSpeed: 0.5,
  textFontSize: 13,
  markdownFontSize: 14,
  terminalFontSize: 14,
};

export const SCROLL_SPEED_MIN = 0.1;
export const SCROLL_SPEED_MAX = 5;
export const TEXT_FONT_SIZE_MIN = 8;
export const TEXT_FONT_SIZE_MAX = 24;
export const MARKDOWN_FONT_SIZE_MIN = 10;
export const MARKDOWN_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampFontSize(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(clamp(value, min, max));
}

/**
 * Coerces a raw partial settings object (possibly from JSON / DB strings /
 * untrusted input) into a fully-populated, in-range AppSettings.
 */
export function sanitize(raw: Partial<AppSettings> | null | undefined): AppSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
  const speed =
    typeof raw.terminalScrollSpeed === "number" && Number.isFinite(raw.terminalScrollSpeed)
      ? clamp(raw.terminalScrollSpeed, SCROLL_SPEED_MIN, SCROLL_SPEED_MAX)
      : DEFAULT_SETTINGS.terminalScrollSpeed;
  return {
    terminalScrollSpeed: speed,
    textFontSize: clampFontSize(
      raw.textFontSize,
      TEXT_FONT_SIZE_MIN,
      TEXT_FONT_SIZE_MAX,
      DEFAULT_SETTINGS.textFontSize,
    ),
    markdownFontSize: clampFontSize(
      raw.markdownFontSize,
      MARKDOWN_FONT_SIZE_MIN,
      MARKDOWN_FONT_SIZE_MAX,
      DEFAULT_SETTINGS.markdownFontSize,
    ),
    terminalFontSize: clampFontSize(
      raw.terminalFontSize,
      TERMINAL_FONT_SIZE_MIN,
      TERMINAL_FONT_SIZE_MAX,
      DEFAULT_SETTINGS.terminalFontSize,
    ),
  };
}

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();

let cached: AppSettings = { ...DEFAULT_SETTINGS };
let hydrated = false;

function parseNumber(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readSqlSettings(): Promise<Partial<AppSettings>> {
  const entries: Partial<AppSettings> = {};
  const tasks = (Object.keys(SQL_KEYS) as Array<keyof typeof SQL_KEYS>).map(async (k) => {
    try {
      const raw = await invoke<string | null>("get_setting", { key: SQL_KEYS[k] });
      const n = parseNumber(raw);
      if (n !== undefined) (entries as Record<string, number>)[k] = n;
    } catch {
      /* ignore missing key / not on tauri */
    }
  });
  await Promise.all(tasks);
  return entries;
}

async function writeSqlSetting(key: keyof typeof SQL_KEYS, value: number): Promise<void> {
  try {
    await invoke("set_setting", { key: SQL_KEYS[key], value: String(value) });
  } catch {
    /* ignore */
  }
}

/**
 * Reads the legacy localStorage blob (`ws.app-settings.v1`) if it still
 * exists and folds any usable values into the result. The blob is removed
 * unconditionally so it never re-runs. The defunct `mermaidFontSize` key
 * is silently dropped.
 */
function consumeLegacyLocalStorage(): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<AppSettings> & { mermaidFontSize?: unknown };
    if (typeof parsed?.terminalScrollSpeed === "number") {
      out.terminalScrollSpeed = parsed.terminalScrollSpeed;
    }
    // intentionally ignore mermaidFontSize (feature removed)
  } catch {
    /* ignore */
  } finally {
    try {
      globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Hydrate the in-memory cache from SQLite + legacy localStorage. Safe to
 * call multiple times — only the first call hits the DB. App.tsx awaits
 * this on mount so the first render of subscriber components reads real
 * values instead of bare defaults.
 *
 * If a legacy localStorage value was found AND no SQL row existed for
 * `terminalScrollSpeed`, the legacy value is written into SQLite so the
 * migration only happens once.
 */
export async function hydrateAppSettings(): Promise<AppSettings> {
  if (hydrated) return cached;
  const legacy = consumeLegacyLocalStorage();
  const sql = await readSqlSettings();
  const merged = sanitize({ ...DEFAULT_SETTINGS, ...legacy, ...sql });
  cached = merged;
  hydrated = true;
  // If legacy supplied a scroll speed AND SQL did not, persist it so we
  // never have to read localStorage again.
  if (legacy.terminalScrollSpeed !== undefined && sql.terminalScrollSpeed === undefined) {
    void writeSqlSetting("terminalScrollSpeed", merged.terminalScrollSpeed);
  }
  for (const l of listeners) {
    try {
      l(merged);
    } catch {
      /* ignore */
    }
  }
  return merged;
}

export function getAppSettings(): AppSettings {
  return cached;
}

/**
 * Mutates a subset of settings, returns the new sanitized snapshot, and
 * write-throughs to SQLite asynchronously. Subscribers are notified
 * synchronously so the UI repaints immediately even if the DB write is
 * still in flight.
 */
export function setAppSettings(next: Partial<AppSettings>): AppSettings {
  const merged = sanitize({ ...cached, ...next });
  // Detect which keys changed so we only write what's needed.
  const changed: Array<keyof typeof SQL_KEYS> = [];
  if (merged.terminalScrollSpeed !== cached.terminalScrollSpeed) changed.push("terminalScrollSpeed");
  if (merged.textFontSize !== cached.textFontSize) changed.push("textFontSize");
  if (merged.markdownFontSize !== cached.markdownFontSize) changed.push("markdownFontSize");
  if (merged.terminalFontSize !== cached.terminalFontSize) changed.push("terminalFontSize");
  cached = merged;
  for (const k of changed) {
    const v: number =
      k === "terminalScrollSpeed" ? merged.terminalScrollSpeed
      : k === "textFontSize" ? merged.textFontSize
      : k === "markdownFontSize" ? merged.markdownFontSize
      : merged.terminalFontSize;
    void writeSqlSetting(k, v);
  }
  for (const l of listeners) {
    try {
      l(merged);
    } catch {
      /* ignore */
    }
  }
  return merged;
}

/**
 * Reset every setting to its default. Persists each change individually
 * so the SQLite rows reflect the reset (rather than just falling back).
 */
export function resetAppSettings(): AppSettings {
  return setAppSettings(DEFAULT_SETTINGS);
}

export function subscribeAppSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: clear cache + hydration so the next get reads fresh. */
export function _resetAppSettingsCacheForTests(): void {
  cached = { ...DEFAULT_SETTINGS };
  hydrated = false;
  listeners.clear();
}

// Expose a tiny debug bridge so CDP/E2E probes can set settings directly
// without driving the UI (avoids slider-dragging flakiness). Single-user
// desktop app — no security impact.
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as { __wsAppSettings?: unknown }).__wsAppSettings = {
    get: getAppSettings,
    set: setAppSettings,
    reset: resetAppSettings,
    hydrate: hydrateAppSettings,
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

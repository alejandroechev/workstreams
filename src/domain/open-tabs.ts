/**
 * Open files of one Repo Explorer tile, as tabs. Pure state transitions, so
 * the tab rules are tested without rendering the explorer.
 *
 * - At most one **preview** tab: casual opens (tree single-click, links,
 *   Ctrl+P, search, walkthroughs) replace it; editing, double-clicking or
 *   pinning keeps it.
 * - `recent` is most-recently-used first, for the Ctrl+Tab switcher and for
 *   choosing the next tab when one closes.
 * - `places` remembers where each file was (scroll line, cursor) so a restart
 *   reopens it there.
 */

export interface OpenTab {
  path: string;
  /** The italic, replaceable tab. At most one. */
  preview: boolean;
  /** Survives Close others / Close all. Implies kept. */
  pinned: boolean;
}

export interface Place {
  /** First visible line. */
  line: number;
  cursorLine: number;
  cursorColumn: number;
}

export interface OpenTabs {
  tabs: OpenTab[];
  active: string | null;
  recent: string[];
  places: Record<string, Place>;
}

export type OpenIntent = "preview" | "keep";

export function emptyTabs(): OpenTabs {
  return { tabs: [], active: null, recent: [], places: {} };
}

function touch(state: OpenTabs, path: string): OpenTabs {
  return { ...state, active: path, recent: [path, ...state.recent.filter((p) => p !== path)] };
}

export function openTab(state: OpenTabs, path: string, intent: OpenIntent): OpenTabs {
  const existing = state.tabs.find((t) => t.path === path);
  if (existing) {
    const tabs = intent === "keep" && existing.preview
      ? state.tabs.map((t) => (t.path === path ? { ...t, preview: false } : t))
      : state.tabs;
    return touch({ ...state, tabs }, path);
  }
  const tab: OpenTab = { path, preview: intent === "preview", pinned: false };
  const preview = state.tabs.findIndex((t) => t.preview);
  if (intent === "preview" && preview >= 0) {
    const replaced = state.tabs[preview].path;
    const tabs = state.tabs.map((t, i) => (i === preview ? tab : t));
    return touch({ ...state, tabs, recent: state.recent.filter((p) => p !== replaced) }, path);
  }
  // A new tab goes right after the active one, or at the end.
  const at = state.active ? state.tabs.findIndex((t) => t.path === state.active) + 1 : state.tabs.length;
  const tabs = [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)];
  return touch({ ...state, tabs }, path);
}

/** Editing, double-clicking or pinning turns the preview into a kept tab. */
export function keep(state: OpenTabs, path: string): OpenTabs {
  if (!state.tabs.some((t) => t.path === path && t.preview)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.path === path ? { ...t, preview: false } : t)) };
}

export function activate(state: OpenTabs, path: string): OpenTabs {
  return state.tabs.some((t) => t.path === path) ? touch(state, path) : state;
}

function without(state: OpenTabs, gone: (t: OpenTab) => boolean): OpenTabs {
  const removed = new Set(state.tabs.filter(gone).map((t) => t.path));
  if (removed.size === 0) return state;
  const tabs = state.tabs.filter((t) => !removed.has(t.path));
  const recent = state.recent.filter((p) => !removed.has(p));
  const places = Object.fromEntries(Object.entries(state.places).filter(([p]) => !removed.has(p)));
  const active = state.active && !removed.has(state.active) ? state.active : (recent[0] ?? tabs[0]?.path ?? null);
  return { tabs, active, recent: active && !recent.includes(active) ? [active, ...recent] : recent, places };
}

export function closeTab(state: OpenTabs, path: string): OpenTabs {
  return without(state, (t) => t.path === path);
}

export function closeOthers(state: OpenTabs, path: string): OpenTabs {
  const next = without(state, (t) => t.path !== path && !t.pinned);
  return activate(next, path);
}

export function closeRight(state: OpenTabs, path: string): OpenTabs {
  const i = state.tabs.findIndex((t) => t.path === path);
  if (i < 0) return state;
  const right = new Set(state.tabs.slice(i + 1).filter((t) => !t.pinned).map((t) => t.path));
  return without(state, (t) => right.has(t.path));
}

export function closeAll(state: OpenTabs): OpenTabs {
  return without(state, (t) => !t.pinned);
}

export function togglePin(state: OpenTabs, path: string): OpenTabs {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.path === path ? { ...t, pinned: !t.pinned, preview: false } : t)),
  };
}

/** Tab N (1-based); past the end means the last tab. */
export function jumpTo(state: OpenTabs, n: number): OpenTabs {
  if (state.tabs.length === 0) return state;
  return touch(state, state.tabs[Math.min(n, state.tabs.length) - 1].path);
}

/** The Ctrl+Tab list: most recently used first. */
export function switcherOrder(state: OpenTabs): string[] {
  const open = new Set(state.tabs.map((t) => t.path));
  const ordered = state.recent.filter((p) => open.has(p));
  return [...ordered, ...state.tabs.map((t) => t.path).filter((p) => !ordered.includes(p))];
}

export function setPlace(state: OpenTabs, path: string, place: Place): OpenTabs {
  if (!state.tabs.some((t) => t.path === path)) return state;
  return { ...state, places: { ...state.places, [path]: place } };
}

/** What the tile's view state stores. */
export function serializeTabs(state: OpenTabs): OpenTabs {
  return state;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reads persisted tabs, dropping anything malformed. */
export function parseTabs(raw: unknown): OpenTabs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const tabs: OpenTab[] = [];
  let hasPreview = false;
  for (const t of Array.isArray(r.tabs) ? r.tabs : []) {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    if (typeof o.path !== "string" || !o.path || seen.has(o.path)) continue;
    seen.add(o.path);
    const preview: boolean = o.preview === true && !hasPreview && o.pinned !== true;
    hasPreview ||= preview;
    tabs.push({ path: o.path, preview, pinned: o.pinned === true });
  }
  const recent = (Array.isArray(r.recent) ? r.recent : []).filter((p): p is string => typeof p === "string" && seen.has(p));
  const active = typeof r.active === "string" && seen.has(r.active) ? r.active : (recent[0] ?? tabs[0]?.path ?? null);
  const places: Record<string, Place> = {};
  for (const [p, v] of Object.entries((r.places && typeof r.places === "object" ? r.places : {}) as Record<string, unknown>)) {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (seen.has(p) && isNum(o.line) && isNum(o.cursorLine) && isNum(o.cursorColumn)) {
      places[p] = { line: o.line, cursorLine: o.cursorLine, cursorColumn: o.cursorColumn };
    }
  }
  return { tabs, active, recent: active && !recent.includes(active) ? [active, ...recent] : recent, places };
}

/**
 * Tile view-state — pure helpers for serializing/deserializing the
 * per-tile "where the user was" state (active tab, opened file, etc.)
 * into the existing `tiles.config_json` blob under a `viewState`
 * sub-object.
 *
 * Each tile type has its own shape; everything is optional so older
 * config_json values (which don't have viewState) round-trip cleanly.
 *
 * Source of truth: this module. Consumers (RepoExplorerTile,
 * SessionMetaTile, WorkbenchTile, PlanTile) should only import the
 * types + helpers from here, not handle the JSON shape themselves.
 */

export interface RepoExplorerViewState {
  activeTab?: string; // "files" | "diff" | "log" | "hooks"
  currentDir?: string;
  filePath?: string;
  diffMode?: string; // "unstaged" | "last_commit" | "vs_master" | ...
  diffLayout?: "split" | "unified";
  hookName?: string;
  mdViewMode?: "preview" | "edit";
}

export interface SessionMetaViewState {
  activeTab?: string; // "config" | "files" | "checkpoints" | "events" | "database"
  filePath?: string;
  dbTable?: string;
}

export interface WorkbenchViewState {
  viewingPath?: string;
}

export interface PlanViewState {
  activeTab?: string;
}

export type AnyViewState =
  | { kind: "repo_explorer"; state: RepoExplorerViewState }
  | { kind: "session_meta"; state: SessionMetaViewState }
  | { kind: "workbench"; state: WorkbenchViewState }
  | { kind: "plan"; state: PlanViewState };

/**
 * Parse a raw `tiles.config_json` blob and return the embedded viewState
 * for the given tile kind, or an empty object if missing / malformed.
 * Never throws; bad JSON yields {}.
 */
export function parseViewState<K extends AnyViewState["kind"]>(
  configJson: string | null | undefined,
  kind: K,
): Extract<AnyViewState, { kind: K }>["state"] {
  if (!configJson) return {} as Extract<AnyViewState, { kind: K }>["state"];
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return {} as Extract<AnyViewState, { kind: K }>["state"];
  }
  if (!isJsonObject(parsed)) return {} as Extract<AnyViewState, { kind: K }>["state"];
  const vs = parsed.viewState;
  if (!isJsonObject(vs)) return {} as Extract<AnyViewState, { kind: K }>["state"];
  return sanitize(vs, kind);
}

/**
 * Merge a viewState update into an existing config_json blob and return
 * the new JSON string. Preserves all other top-level config fields. Drops
 * undefined viewState values so the persisted JSON stays small.
 */
export function mergeViewState<K extends AnyViewState["kind"]>(
  configJson: string | null | undefined,
  _kind: K,
  next: Extract<AnyViewState, { kind: K }>["state"],
): string {
  const base = (() => {
    if (!configJson) return {};
    try {
      const p = JSON.parse(configJson);
      return isJsonObject(p) ? p : {};
    } catch {
      return {};
    }
  })();
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    cleaned[k] = v;
  }
  return JSON.stringify({ ...base, viewState: cleaned });
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sanitize<K extends AnyViewState["kind"]>(
  raw: Record<string, unknown>,
  kind: K,
): Extract<AnyViewState, { kind: K }>["state"] {
  const out: Record<string, unknown> = {};
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  };
  switch (kind) {
    case "repo_explorer":
      str("activeTab");
      str("currentDir");
      str("filePath");
      str("diffMode");
      str("hookName");
      if (raw.diffLayout === "split" || raw.diffLayout === "unified") {
        out.diffLayout = raw.diffLayout;
      }
      if (raw.mdViewMode === "preview" || raw.mdViewMode === "edit") {
        out.mdViewMode = raw.mdViewMode;
      }
      break;
    case "session_meta":
      str("activeTab");
      str("filePath");
      str("dbTable");
      break;
    case "workbench":
      str("viewingPath");
      break;
    case "plan":
      // Note: selectedHistoryPlanId + historySubTab were dropped in the
      // Plan tile redesign (plan-tile-redesign-f3457c). Old persisted
      // configs are silently ignored — only activeTab survives.
      str("activeTab");
      break;
  }
  return out as Extract<AnyViewState, { kind: K }>["state"];
}

/**
 * Persistent per-workstream Workbench file list.
 *
 * Files attached to a workstream's Workbench are durable: closing the
 * Workbench tile or the app does not clear them. Storage piggy-backs on
 * the existing `settings` table via `get_setting` / `set_setting`, keyed
 * by `workbench:<workstreamId>`.
 *
 * Pure logic only here. The Tauri invoke wiring is supplied by the
 * caller through the {@link WorkbenchStoreDeps} contract so the store
 * is trivially unit-testable with an in-memory map.
 */

const KEY_PREFIX = "workbench:";

export const workbenchSettingKey = (workstreamId: string): string => `${KEY_PREFIX}${workstreamId}`;

export interface WorkbenchStoreDeps {
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
}

export function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function serializeList(files: ReadonlyArray<string>): string {
  return JSON.stringify(files);
}

export function appendUnique(files: ReadonlyArray<string>, path: string): string[] {
  if (files.includes(path)) return files as string[];
  return [...files, path];
}

export function removeOne(files: ReadonlyArray<string>, path: string): string[] {
  const idx = files.indexOf(path);
  if (idx < 0) return files as string[];
  const next = files.slice();
  next.splice(idx, 1);
  return next;
}

export interface WorkbenchStore {
  list(workstreamId: string): Promise<string[]>;
  add(workstreamId: string, path: string): Promise<string[]>;
  remove(workstreamId: string, path: string): Promise<string[]>;
  set(workstreamId: string, files: ReadonlyArray<string>): Promise<void>;
}

export function createWorkbenchStore(deps: WorkbenchStoreDeps): WorkbenchStore {
  return {
    async list(workstreamId) {
      return parseList(await deps.getSetting(workbenchSettingKey(workstreamId)));
    },
    async add(workstreamId, path) {
      const key = workbenchSettingKey(workstreamId);
      const current = parseList(await deps.getSetting(key));
      const next = appendUnique(current, path);
      if (next !== current) await deps.setSetting(key, serializeList(next));
      return next;
    },
    async remove(workstreamId, path) {
      const key = workbenchSettingKey(workstreamId);
      const current = parseList(await deps.getSetting(key));
      const next = removeOne(current, path);
      if (next !== current) await deps.setSetting(key, serializeList(next));
      return next;
    },
    async set(workstreamId, files) {
      await deps.setSetting(workbenchSettingKey(workstreamId), serializeList(files));
    },
  };
}

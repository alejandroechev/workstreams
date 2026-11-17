/**
 * Diagram scenes (ADR 043): the pure side of the Diagram tile.
 *
 * A scene is what the tile stores per board and what Excalidraw edits: its
 * elements and the image files they reference. These helpers never touch
 * Excalidraw itself, so they are tested without a canvas.
 */

/** An Excalidraw element, with only the fields these helpers rely on typed. */
export interface SceneElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  containerId?: string | null;
  boundElements?: ReadonlyArray<{ id: string; type: string }> | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  frameId?: string | null;
  groupIds?: readonly string[];
  [key: string]: unknown;
}

export interface DiagramScene {
  elements: readonly SceneElement[];
  files: Record<string, unknown>;
}

export function emptyScene(): DiagramScene {
  return { elements: [], files: {} };
}

export function liveElements(elements: readonly SceneElement[]): SceneElement[] {
  return elements.filter((e) => !e.isDeleted);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function sceneFrom(raw: unknown): DiagramScene | null {
  if (!isRecord(raw) || !Array.isArray(raw.elements)) return null;
  const elements = raw.elements.filter((e): e is SceneElement => isRecord(e) && typeof e.id === "string" && typeof e.type === "string");
  return { elements, files: isRecord(raw.files) ? raw.files : {} };
}

/** A stored board scene; anything unreadable becomes an empty board. */
export function parseScene(json: string): DiagramScene {
  try {
    return sceneFrom(JSON.parse(json)) ?? emptyScene();
  } catch {
    return emptyScene();
  }
}

/** Only files still referenced by a live image are kept. */
function usedFiles(elements: readonly SceneElement[], files: Record<string, unknown>): Record<string, unknown> {
  const used = new Set(elements.map((e) => e.fileId).filter((id): id is string => typeof id === "string"));
  return Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id)));
}

export function serializeScene(scene: DiagramScene): string {
  const elements = liveElements(scene.elements);
  return JSON.stringify({ elements, files: usedFiles(elements, scene.files) });
}

/** Excalidraw's own `.excalidraw` file: opens unchanged at excalidraw.com. */
export function toExcalidrawFile(scene: DiagramScene, viewBackgroundColor = "#ffffff"): string {
  const elements = liveElements(scene.elements);
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "workstreams",
      elements,
      appState: { viewBackgroundColor, gridSize: null },
      files: usedFiles(elements, scene.files),
    },
    null,
    2,
  );
}

export type ParsedFile = { ok: true; scene: DiagramScene } | { ok: false; error: string };

/** Reads a `.excalidraw` file. An empty file is an empty canvas (a new file). */
export function parseExcalidrawFile(text: string): ParsedFile {
  if (text.trim() === "") return { ok: true, scene: emptyScene() };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
  if (!isRecord(raw) || raw.type !== "excalidraw") return { ok: false, error: 'Not an Excalidraw file (missing type "excalidraw")' };
  const scene = sceneFrom(raw);
  return scene ? { ok: true, scene } : { ok: false, error: "The file has no elements list" };
}

/**
 * The selection as copied: Excalidraw selects a labelled shape without its
 * bound text, and a frame without its contents, so both come along.
 */
export function expandSelection(elements: readonly SceneElement[], selectedIds: readonly string[]): string[] {
  const ids = new Set(selectedIds);
  for (const e of liveElements(elements)) {
    if ((e.containerId && ids.has(e.containerId)) || (e.frameId && ids.has(e.frameId))) ids.add(e.id);
  }
  return [...ids];
}

/** What excalidraw.com accepts on paste: the board, or just the selected elements. */
export function toExcalidrawClipboard(scene: DiagramScene, selectedIds?: readonly string[]): string {
  const live = liveElements(scene.elements);
  const wanted = selectedIds && selectedIds.length > 0 ? new Set(expandSelection(live, selectedIds)) : null;
  const picked = wanted ? live.filter((e) => wanted.has(e.id)) : live;
  return JSON.stringify({ type: "excalidraw/clipboard", elements: picked, files: usedFiles(picked, scene.files) });
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function sceneBounds(elements: readonly SceneElement[]): Bounds | null {
  const live = liveElements(elements);
  if (live.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of live) {
    // Arrows and lines can have negative extents (drawn leftwards or upwards).
    const x2 = e.x + e.width, y2 = e.y + e.height;
    minX = Math.min(minX, e.x, x2);
    minY = Math.min(minY, e.y, y2);
    maxX = Math.max(maxX, e.x, x2);
    maxY = Math.max(maxY, e.y, y2);
  }
  return { minX, minY, maxX, maxY };
}

/** Moves `added` as a block so it sits to the right of `existing`, top-aligned. */
export function placeBeside(existing: readonly SceneElement[], added: readonly SceneElement[], gap = 80): SceneElement[] {
  const here = sceneBounds(existing);
  const there = sceneBounds(added);
  if (!here || !there) return [...added];
  const dx = here.maxX + gap - there.minX;
  const dy = here.minY - there.minY;
  return added.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
}

let counter = 0;
const freshId = () => `ws-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * `existing` followed by `added`. An added element whose id is already taken
 * gets a new id (and every reference to it inside `added` follows), so
 * appending can never replace one of the user's elements. The batch's groups
 * get fresh ids too: Mermaid reuses names like `subgraph_group_G`, and two
 * imports must not become one group.
 */
export function appendElements(existing: readonly SceneElement[], addedIn: readonly SceneElement[]): SceneElement[] {
  const groups = new Map<string, string>();
  const regroup = (g: string) => {
    if (!groups.has(g)) groups.set(g, `${g}-${freshId()}`);
    return groups.get(g)!;
  };
  const added = addedIn.map((e) => (e.groupIds && e.groupIds.length > 0 ? { ...e, groupIds: e.groupIds.map(regroup) } : e));
  const taken = new Set(existing.map((e) => e.id));
  const rename = new Map<string, string>();
  for (const e of added) {
    if (taken.has(e.id) || rename.has(e.id)) rename.set(e.id, freshId());
    taken.add(rename.get(e.id) ?? e.id);
  }
  if (rename.size === 0) return [...existing, ...added];
  const map = (id: string | null | undefined) => (id ? rename.get(id) ?? id : id);
  const rebind = (b: { elementId: string } | null | undefined) => (b ? { ...b, elementId: map(b.elementId) as string } : b);
  return [
    ...existing,
    ...added.map((e) => ({
      ...e,
      id: map(e.id) as string,
      containerId: e.containerId === undefined ? undefined : map(e.containerId),
      boundElements: e.boundElements ? e.boundElements.map((b) => ({ ...b, id: map(b.id) as string })) : e.boundElements,
      startBinding: e.startBinding === undefined ? undefined : rebind(e.startBinding),
      endBinding: e.endBinding === undefined ? undefined : rebind(e.endBinding),
      frameId: e.frameId === undefined ? undefined : map(e.frameId),
    })).map((e) => {
      // Keep the element's shape: drop keys that were absent rather than set them to undefined.
      const out: SceneElement = { ...e };
      for (const k of ["containerId", "startBinding", "endBinding", "frameId"] as const) if (out[k] === undefined) delete out[k];
      return out;
    }),
  ];
}

/** "Board N", one past the highest numbered board. */
export function nextBoardName(names: readonly string[]): string {
  const n = names.reduce((max, name) => {
    const m = /^Board (\d+)$/.exec(name.trim());
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `Board ${n + 1}`;
}

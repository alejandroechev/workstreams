/**
 * Diagram tile (ADR 043): a whiteboard for thinking, built on Excalidraw.
 *
 * One tile holds several named boards. Each board's scene is stored in the
 * app database (never the workstream folder) until the user saves it to a
 * file. Agents add to boards through `diagram.add`, which queues Mermaid; this
 * tile converts each queued addition into shapes and appends them beside the
 * existing drawing, never deleting or moving the user's shapes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { PlusIcon, XMarkIcon, EllipsisHorizontalIcon, Squares2X2Icon, CodeBracketIcon } from "@heroicons/react/24/outline";
import { useBackend } from "../backend/context";
import { DiagramCanvas } from "../diagram/DiagramCanvas";
import { loadExcalidraw, mermaidToScene, paletteElements } from "../diagram/excalidraw-loader";
import { PALETTE, type PaletteItem, type PaletteKind } from "../diagram/palette";
import {
  appendElements,
  liveElements,
  nextBoardName,
  parseScene,
  placeBeside,
  sceneBounds,
  serializeScene,
  toExcalidrawClipboard,
  toExcalidrawFile,
  type DiagramScene,
  type SceneElement,
} from "../diagram/scene";
import type { DiagramBoard } from "../diagram/types";
import { writeTextToClipboard } from "../domain/clipboard";
import { joinPath } from "../domain/platform";

interface Props {
  tileId: string;
  workstreamDir?: string | null;
  configJson?: string;
  onConfigChange?: (configJson: string) => void;
}

type Notice = { kind: "ok" | "error"; text: string } | null;

const KINDS: PaletteKind[] = ["Flow", "Sequence", "Class", "State"];

function readConfig(json?: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const fileSafe = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "board";

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The tile's boards, creating "Board 1" for a new tile. Shared per tile while
 * in flight, so a remount (or React's double-run effects) never creates two.
 */
const loading = new Map<string, Promise<DiagramBoard[]>>();
function loadBoards(backend: ReturnType<typeof useBackend>, tileId: string): Promise<DiagramBoard[]> {
  let p = loading.get(tileId);
  if (!p) {
    p = (async () => {
      const list = await backend.diagramListBoards(tileId);
      return list.length > 0 ? list : [await backend.diagramCreateBoard(tileId, nextBoardName([]))];
    })().finally(() => loading.delete(tileId));
    loading.set(tileId, p);
  }
  return p;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

export default function DiagramTile({ tileId, workstreamDir, configJson, onConfigChange }: Props) {
  const backend = useBackend();
  const [boards, setBoards] = useState<DiagramBoard[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() => {
    const id = readConfig(configJson).activeBoardId;
    return typeof id === "string" ? id : null;
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mermaid, setMermaid] = useState<{ text: string; error: string | null; busy: boolean } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const scenes = useRef(new Map<string, DiagramScene>());
  const latest = useRef({ boards, activeId, api, configJson });
  useEffect(() => { latest.current = { boards, activeId, api, configJson }; });

  // Load the tile's boards; a new tile starts with "Board 1".
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await loadBoards(backend, tileId);
        if (!alive) return;
        for (const b of list) if (!scenes.current.has(b.id)) scenes.current.set(b.id, parseScene(b.scene_json));
        setBoards(list);
        setActiveId((current) => (current && list.some((b) => b.id === current) ? current : list[0].id));
      } catch (e) {
        if (alive) setLoadError(errorText(e));
      }
    })();
    return () => { alive = false; };
  }, [backend, tileId]);

  const activate = useCallback((id: string) => {
    setActiveId(id);
    setConfirmDelete(null);
    const cfg = readConfig(latest.current.configJson);
    if (cfg.activeBoardId !== id) onConfigChange?.(JSON.stringify({ ...cfg, activeBoardId: id }));
  }, [onConfigChange]);

  const saveScene = useCallback((boardId: string, scene: DiagramScene) => {
    scenes.current.set(boardId, scene);
    return backend.diagramSaveScene(boardId, serializeScene(scene)).catch((e) => {
      setNotice({ kind: "error", text: `Could not save the board: ${errorText(e)}` });
    });
  }, [backend]);

  /** The drawing on screen for the active board, or the stored one. */
  const currentScene = useCallback((): DiagramScene => {
    const { api: a, activeId: id } = latest.current;
    if (a) return { elements: a.getSceneElements() as unknown as SceneElement[], files: a.getFiles() as Record<string, unknown> };
    return (id && scenes.current.get(id)) || { elements: [], files: {} };
  }, []);

  const selectedIds = useCallback((): string[] => {
    const a = latest.current.api;
    if (!a) return [];
    return Object.entries(a.getAppState().selectedElementIds ?? {}).filter(([, on]) => on).map(([id]) => id);
  }, []);

  /** Appends shapes to the active canvas (undoable), selecting them. */
  const addToCanvas = useCallback(async (added: DiagramScene, place: "beside" | "center") => {
    const a = latest.current.api;
    if (!a) throw new Error("The canvas is still loading");
    const ex = await loadExcalidraw();
    const existing = a.getSceneElementsIncludingDeleted() as unknown as SceneElement[];
    let positioned = added.elements as SceneElement[];
    if (place === "beside") positioned = placeBeside(liveElements(existing), positioned);
    else {
      const s = a.getAppState();
      const b = sceneBounds(positioned);
      if (b) {
        const cx = -s.scrollX + s.width / 2 / s.zoom.value;
        const cy = -s.scrollY + s.height / 2 / s.zoom.value;
        const dx = cx - (b.minX + b.maxX) / 2;
        const dy = cy - (b.minY + b.maxY) / 2;
        positioned = positioned.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));
      }
    }
    const next = appendElements(existing, positioned);
    const fresh = next.slice(existing.length);
    const files = Object.values(added.files);
    if (files.length > 0) a.addFiles(files as never);
    a.updateScene({
      elements: next as never,
      appState: { selectedElementIds: Object.fromEntries(fresh.map((e) => [e.id, true])) } as never,
      captureUpdate: ex.CaptureUpdateAction.IMMEDIATELY,
    });
    return { elements: next, files: { ...(a.getFiles() as Record<string, unknown>), ...added.files } } as DiagramScene;
  }, []);

  // Agent additions: convert queued Mermaid and append it, one batch at a time.
  const processing = useRef<Promise<void>>(Promise.resolve());
  const processAdditions = useCallback(() => {
    processing.current = processing.current.then(async () => {
      const { boards: list, activeId: active, api: a } = latest.current;
      if (!list) return;
      for (const board of list) {
        // The active board waits for its canvas, so the canvas never saves over an addition.
        if (board.id === active && !a) continue;
        const pending = (await backend.diagramAdditions(board.id)).filter((x) => x.status === "pending");
        for (const addition of pending) {
          let added: DiagramScene;
          try {
            added = await mermaidToScene(addition.mermaid);
          } catch (e) {
            await backend.diagramResolveAddition(addition.id, errorText(e)).catch(() => {});
            continue;
          }
          if (board.id === latest.current.activeId && latest.current.api) {
            const scene = await addToCanvas(added, "beside");
            await saveScene(board.id, scene);
          } else {
            const stored = scenes.current.get(board.id) ?? parseScene(board.scene_json);
            const elements = appendElements(stored.elements, placeBeside(liveElements(stored.elements), added.elements));
            await saveScene(board.id, { elements, files: { ...stored.files, ...added.files } });
          }
          await backend.diagramResolveAddition(addition.id, null).catch(() => {});
        }
      }
    }).catch((e) => setNotice({ kind: "error", text: `Could not draw an agent's addition: ${errorText(e)}` }));
  }, [backend, addToCanvas, saveScene]);

  useEffect(() => {
    if (boards) processAdditions();
  }, [boards, api, processAdditions]);

  useEffect(() => {
    const unlisten = listen<{ entity?: string; id?: string }>("state-changed", (event) => {
      if (event.payload?.entity !== "diagram") return;
      if (latest.current.boards?.some((b) => b.id === event.payload.id)) processAdditions();
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, [processAdditions]);

  // ─── Boards ───
  const addBoard = async () => {
    try {
      const board = await backend.diagramCreateBoard(tileId, nextBoardName((boards ?? []).map((b) => b.name)));
      scenes.current.set(board.id, parseScene(board.scene_json));
      setBoards((list) => [...(list ?? []), board]);
      activate(board.id);
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    }
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { id, text } = renaming;
    setRenaming(null);
    const name = text.trim();
    if (!name || boards?.find((b) => b.id === id)?.name === name) return;
    try {
      await backend.diagramRenameBoard(id, name);
      setBoards((list) => (list ?? []).map((b) => (b.id === id ? { ...b, name } : b)));
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    }
  };

  const deleteBoard = async (id: string) => {
    setConfirmDelete(null);
    if (!boards || boards.length < 2) return;
    try {
      await backend.diagramDeleteBoard(id);
      scenes.current.delete(id);
      const rest = boards.filter((b) => b.id !== id);
      setBoards(rest);
      if (activeId === id) activate(rest[0].id);
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    }
  };

  // ─── Files, export, clipboard ───
  const activeBoard = boards?.find((b) => b.id === activeId) ?? null;

  const saveAs = async (ext: "excalidraw" | "svg" | "png", label: string) => {
    const base = fileSafe(activeBoard?.name ?? "board");
    const path = await save({
      title: label,
      defaultPath: workstreamDir ? joinPath(workstreamDir, `${base}.${ext}`) : `${base}.${ext}`,
      filters: [{ name: ext === "excalidraw" ? "Excalidraw" : ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return null;
    return path.toLowerCase().endsWith(`.${ext}`) ? path : `${path}.${ext}`;
  };

  const writeText = (path: string, content: string) =>
    invoke("write_text_file", { args: { path, content, expected_hash_hex: null, line_ending: "lf", ensure_trailing_newline: true } });

  /** Runs a menu action and reports its outcome. */
  const run = async (action: () => Promise<string | null>) => {
    setMenuOpen(false);
    try {
      const done = await action();
      if (done) setNotice({ kind: "ok", text: done });
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    }
  };

  const saveExcalidraw = (label: string) => async () => {
    const path = await saveAs("excalidraw", label);
    if (!path) return null;
    await writeText(path, toExcalidrawFile(currentScene()));
    return `Saved ${path}`;
  };

  const exportOptions = (scene: DiagramScene) => ({
    elements: liveElements(scene.elements) as never,
    files: scene.files as never,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
  });

  const exportSvg = async () => {
    const path = await saveAs("svg", "Export as SVG");
    if (!path) return null;
    const ex = await loadExcalidraw();
    const svg = await ex.exportToSvg(exportOptions(currentScene()));
    await writeText(path, svg.outerHTML);
    return `Exported ${path}`;
  };

  const exportPng = async () => {
    const path = await saveAs("png", "Export as PNG");
    if (!path) return null;
    const ex = await loadExcalidraw();
    const blob = await ex.exportToBlob({ ...exportOptions(currentScene()), mimeType: "image/png" });
    await invoke("write_binary_file", { path, base64: await blobToBase64(blob) });
    return `Exported ${path}`;
  };

  /** The selection if there is one, else the whole board. */
  const pickedScene = (): DiagramScene => {
    const scene = currentScene();
    const ids = selectedIds();
    return ids.length > 0 ? { ...scene, elements: scene.elements.filter((e) => ids.includes(e.id)) } : scene;
  };

  const copyPng = async () => {
    const ex = await loadExcalidraw();
    const blob = ex.exportToBlob({ ...exportOptions(pickedScene()), mimeType: "image/png" });
    try {
      // A promised blob keeps the click's user activation (Safari/WebKit needs that).
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    } catch {
      await writeImage(new Uint8Array(await (await blob).arrayBuffer()));
    }
    return "Copied as PNG";
  };

  const copyExcalidraw = async () => {
    await writeTextToClipboard(toExcalidrawClipboard(currentScene(), selectedIds()));
    return "Copied as Excalidraw: paste it into excalidraw.com";
  };

  // ─── Mermaid and palette ───
  const importMermaid = async () => {
    if (!mermaid) return;
    setMermaid({ ...mermaid, busy: true, error: null });
    try {
      const added = await mermaidToScene(mermaid.text);
      await addToCanvas(added, "beside");
      setMermaid(null);
    } catch (e) {
      setMermaid({ ...mermaid, busy: false, error: errorText(e) });
    }
  };

  const placePaletteItem = async (item: PaletteItem) => {
    try {
      await addToCanvas({ elements: await paletteElements(item), files: {} }, "center");
    } catch (e) {
      setNotice({ kind: "error", text: errorText(e) });
    }
  };

  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // Read once per board when its canvas mounts: the canvas owns the scene while it is shown.
  const sceneFor = useCallback((id: string) => scenes.current.get(id) ?? { elements: [], files: {} }, []);

  if (loadError) return <div data-testid="diagram-tile" style={{ padding: 16, color: "#f38ba8" }}>Could not load the boards: {loadError}</div>;

  const pill: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, border: "1px solid #45475a", background: "#313244", color: "#cdd6f4", fontSize: 12, cursor: "pointer" };
  const menuItem: React.CSSProperties = { display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#cdd6f4", padding: "5px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12 };

  return (
    <div data-testid="diagram-tile" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "#1e1e2e" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px", borderBottom: "1px solid #313244", flexShrink: 0, overflowX: "auto" }}>
        {(boards ?? []).map((b) => {
          const active = b.id === activeId;
          return renaming?.id === b.id ? (
            <input
              key={b.id}
              data-testid="diagram-board-rename"
              autoFocus
              value={renaming.text}
              onChange={(e) => setRenaming({ id: b.id, text: e.target.value })}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
              style={{ ...pill, width: 120, outline: "none", cursor: "text" }}
            />
          ) : (
            <div
              key={b.id}
              data-testid="diagram-board-tab"
              data-board-id={b.id}
              data-active={active ? "true" : "false"}
              title="Click to open, double-click to rename"
              onClick={() => activate(b.id)}
              onDoubleClick={() => setRenaming({ id: b.id, text: b.name })}
              style={{ ...pill, background: active ? "#45475a" : "transparent", borderColor: active ? "#cba6f7" : "#45475a", whiteSpace: "nowrap" }}
            >
              {b.name}
              {active && (boards?.length ?? 0) > 1 && (
                confirmDelete === b.id ? (
                  <button
                    data-testid="diagram-board-delete-confirm"
                    onClick={(e) => { e.stopPropagation(); void deleteBoard(b.id); }}
                    style={{ background: "#f38ba8", color: "#1e1e2e", border: "none", borderRadius: 3, fontSize: 11, padding: "0 4px", cursor: "pointer" }}
                  >
                    Delete?
                  </button>
                ) : (
                  <button
                    data-testid="diagram-board-delete"
                    aria-label={`Delete board ${b.name}`}
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(b.id); }}
                    style={{ background: "transparent", border: "none", color: "inherit", padding: 0, display: "flex", cursor: "pointer" }}
                  >
                    <XMarkIcon style={{ width: 12, height: 12 }} />
                  </button>
                )
              )}
            </div>
          );
        })}
        <button data-testid="diagram-board-add" title="New board" onClick={() => void addBoard()} style={{ ...pill, padding: "2px 5px" }}>
          <PlusIcon style={{ width: 13, height: 13 }} />
        </button>
        <span style={{ flex: 1 }} />
        <button data-testid="diagram-mermaid-open" onClick={() => setMermaid({ text: "", error: null, busy: false })} style={pill} title="Turn Mermaid text into editable shapes">
          <CodeBracketIcon style={{ width: 13, height: 13 }} /> Import Mermaid
        </button>
        <button data-testid="diagram-palette-toggle" aria-pressed={paletteOpen} onClick={() => setPaletteOpen((v) => !v)} style={{ ...pill, borderColor: paletteOpen ? "#cba6f7" : "#45475a" }} title="Software shapes">
          <Squares2X2Icon style={{ width: 13, height: 13 }} /> Palette
        </button>
        <div style={{ position: "relative" }}>
          <button data-testid="diagram-menu" aria-label="Board actions" onMouseDown={(e) => e.stopPropagation()} onClick={() => setMenuOpen((v) => !v)} style={{ ...pill, padding: "2px 5px" }}>
            <EllipsisHorizontalIcon style={{ width: 14, height: 14 }} />
          </button>
          {menuOpen && (
            <div role="menu" onMouseDown={(e) => e.stopPropagation()} style={{ position: "absolute", right: 0, top: "110%", zIndex: 20, background: "#181825", border: "1px solid #45475a", borderRadius: 6, padding: 4, minWidth: 200, boxShadow: "0 6px 18px #0008" }}>
              <button role="menuitem" data-testid="diagram-save-file" style={menuItem} onClick={() => void run(saveExcalidraw("Save board to file"))}>Save to file…</button>
              <button role="menuitem" data-testid="diagram-copy-png" style={menuItem} onClick={() => void run(copyPng)}>Copy as PNG</button>
              <button role="menuitem" data-testid="diagram-copy-excalidraw" style={menuItem} onClick={() => void run(copyExcalidraw)}>Copy as Excalidraw</button>
              <div style={{ padding: "5px 10px 2px", color: "#6c7086", fontSize: 11 }}>Export</div>
              <button role="menuitem" data-testid="diagram-export-svg" style={{ ...menuItem, paddingLeft: 18 }} onClick={() => void run(exportSvg)}>SVG</button>
              <button role="menuitem" data-testid="diagram-export-png" style={{ ...menuItem, paddingLeft: 18 }} onClick={() => void run(exportPng)}>PNG</button>
              <button role="menuitem" data-testid="diagram-export-excalidraw" style={{ ...menuItem, paddingLeft: 18 }} onClick={() => void run(saveExcalidraw("Export board to Excalidraw"))}>Excalidraw (.excalidraw)</button>
            </div>
          )}
        </div>
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {activeId && boards && (
          <DiagramCanvas
            key={activeId}
            registryKey={`${tileId}:${activeId}`}
            initialScene={() => sceneFor(activeId)}
            onSceneChange={(scene) => void saveScene(activeId, scene)}
            onApi={setApi}
          />
        )}
        {paletteOpen && (
          <div data-testid="diagram-palette" style={{ position: "absolute", right: 8, top: 8, bottom: 8, width: 180, overflowY: "auto", zIndex: 10, background: "#181825", border: "1px solid #45475a", borderRadius: 6, padding: 6, fontSize: 12 }}>
            {KINDS.map((kind) => (
              <div key={kind} data-testid="diagram-palette-group" data-kind={kind}>
                <div style={{ color: "#89b4fa", fontWeight: 600, margin: "6px 4px 2px" }}>{kind}</div>
                {PALETTE.filter((p) => p.kind === kind).map((item) => (
                  <button
                    key={item.name}
                    data-testid="diagram-palette-item"
                    data-name={`${item.kind}: ${item.name}`}
                    onClick={() => void placePaletteItem(item)}
                    style={menuItem}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "#313244"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {mermaid && (
          <div data-testid="diagram-mermaid-dialog" style={{ position: "absolute", left: "10%", right: "10%", top: 24, zIndex: 30, background: "#181825", border: "1px solid #45475a", borderRadius: 8, padding: 12, boxShadow: "0 8px 24px #000a" }}>
            <div style={{ color: "#cdd6f4", fontSize: 13, marginBottom: 6 }}>Import Mermaid — flowchart, sequence, class or state</div>
            <textarea
              data-testid="diagram-mermaid-input"
              autoFocus
              value={mermaid.text}
              onChange={(e) => setMermaid({ ...mermaid, text: e.target.value, error: null })}
              placeholder={"flowchart LR\n  A[Client] --> B[Server]"}
              style={{ width: "100%", boxSizing: "border-box", height: 140, background: "#11111b", color: "#cdd6f4", border: "1px solid #45475a", borderRadius: 4, font: "12px monospace", padding: 6 }}
            />
            {mermaid.error && <div data-testid="diagram-mermaid-error" style={{ color: "#f38ba8", fontSize: 12, whiteSpace: "pre-wrap", marginTop: 6 }}>{mermaid.error}</div>}
            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={() => setMermaid(null)} style={pill}>Cancel</button>
              <button data-testid="diagram-mermaid-import" disabled={mermaid.busy || !mermaid.text.trim()} onClick={() => void importMermaid()} style={{ ...pill, borderColor: "#cba6f7" }}>
                {mermaid.busy ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        )}
        {notice && (
          <div data-testid="diagram-notice" data-kind={notice.kind} onClick={() => setNotice(null)} style={{ position: "absolute", left: 8, bottom: 8, zIndex: 25, maxWidth: "80%", padding: "4px 8px", borderRadius: 4, fontSize: 12, background: "#181825", border: `1px solid ${notice.kind === "ok" ? "#a6e3a1" : "#f38ba8"}`, color: notice.kind === "ok" ? "#a6e3a1" : "#f38ba8", cursor: "pointer" }}>
            {notice.text}
          </div>
        )}
      </div>
    </div>
  );
}

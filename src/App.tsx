import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import WorkstreamSidebar from "./workstream/WorkstreamSidebar";
import TileGrid from "./tiling/TileGrid";
import StatusBar from "./tiling/StatusBar";
import { navigateFocus } from "./tiling/layout";
import type { Workstream, Tile, WorkstreamLayout } from "./workstream/types";

export default function App() {
  const [workstreams, setWorkstreams] = useState<Workstream[]>([]);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [tileOrder, setTileOrder] = useState<string[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [fullscreenTileId, setFullscreenTileId] = useState<string | null>(null);
  // Track which tile IDs have active PTYs to avoid double-spawning
  const spawnedPtys = useRef<Set<string>>(new Set());
  const previousWsTiles = useRef<Map<string, { tiles: Tile[]; order: string[] }>>(new Map());

  // Load workstreams on mount + restore
  useEffect(() => {
    invoke<Workstream[]>("list_workstreams").then((ws) => {
      setWorkstreams(ws);
      if (ws.length > 0 && !activeWsId) {
        setActiveWsId(ws[0].id);
      }
    });
  }, []);

  // Load tiles + layout when active workstream changes
  // Save previous workstream's tiles before switching
  useEffect(() => {
    if (!activeWsId) return;

    Promise.all([
      invoke<Tile[]>("list_tiles", { workstreamId: activeWsId }),
      invoke<WorkstreamLayout>("get_layout", { workstreamId: activeWsId }),
    ]).then(([t, layout]) => {
      setTiles(t);
      const order: string[] = JSON.parse(layout.tile_order_json || "[]");
      setTileOrder(order);
      setFocusedIndex(0);
      setFullscreenTileId(layout.fullscreen_tile_id || null);

      // Spawn terminal tiles only if not already spawned
      for (const tile of t) {
        if (tile.tile_type === "terminal" && !spawnedPtys.current.has(tile.id)) {
          const config = JSON.parse(tile.config_json || "{}");
          const cwd = config.cwd || "C:\\";
          spawnedPtys.current.add(tile.id);
          invoke("spawn_terminal", {
            tileId: tile.id,
            cwd,
            command: config.command || null,
            rows: 30,
            cols: 120,
          }).catch(() => {
            spawnedPtys.current.delete(tile.id);
          });
        }
      }
    });
  }, [activeWsId]);

  // Switch workstream by index (Ctrl+1-9)
  const switchWorkstream = useCallback(
    (index: number) => {
      if (index < workstreams.length) {
        setActiveWsId(workstreams[index].id);
      }
    },
    [workstreams]
  );

  // Workstream commands stored per-workstream for terminal spawning
  const wsCommands = useRef<Map<string, string>>(new Map());

  const createWorkstream = useCallback(async (name: string, directory: string, command?: string) => {
    const ws = await invoke<Workstream>("create_workstream", {
      name,
      directory,
    });
    // Detect git info and update
    try {
      const [repo, branch] = await invoke<[string | null, string | null]>("detect_git_info", { directory });
      if (repo || branch) {
        await invoke("update_workstream", {
          id: ws.id,
          ...(repo ? {} : {}),
        });
        ws.git_repo = repo;
        ws.git_branch = branch;
      }
    } catch { /* ignore */ }
    if (command) wsCommands.current.set(ws.id, command);
    setWorkstreams((prev) => [ws, ...prev]);
    setActiveWsId(ws.id);
  }, []);

  const addTile = useCallback(async (tileType: "terminal" | "code_viewer" | "doc_viewer") => {
    if (!activeWsId) return;
    const ws = workstreams.find((w) => w.id === activeWsId);
    const cwd = ws?.directory || "C:\\";
    const command = wsCommands.current.get(activeWsId) || "pwsh.exe";

    const typeLabels = { terminal: "Terminal", code_viewer: "Code", doc_viewer: "Doc" };
    const tileCount = tiles.filter((t) => t.tile_type === tileType).length;
    const config = tileType === "terminal"
      ? JSON.stringify({ command, cwd, process_status: "spawning" })
      : "{}";

    const tile = await invoke<Tile>("create_tile", {
      workstreamId: activeWsId,
      tileType,
      title: `${typeLabels[tileType]} ${tileCount + 1}`,
      configJson: config,
    });

    setTiles((prev) => [...prev, tile]);
    setTileOrder((prev) => {
      const next = [...prev, tile.id];
      invoke("update_layout", {
        workstreamId: activeWsId,
        tileOrderJson: JSON.stringify(next),
      });
      return next;
    });

    // Only spawn PTY for terminal tiles
    if (tileType === "terminal") {
      spawnedPtys.current.add(tile.id);
      await invoke("spawn_terminal", {
        tileId: tile.id,
        cwd,
        command: command !== "pwsh.exe" ? command : null,
        rows: 30,
        cols: 120,
      });
    }

    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tiles.length, tileOrder.length]);

  const closeTile = useCallback(
    async (tileId: string) => {
      spawnedPtys.current.delete(tileId);
      await invoke("close_terminal", { tileId }).catch(() => {});
      await invoke("delete_tile", { tileId });
      setTiles((prev) => prev.filter((t) => t.id !== tileId));
      setTileOrder((prev) => {
        const next = prev.filter((id) => id !== tileId);
        if (activeWsId) {
          invoke("update_layout", {
            workstreamId: activeWsId,
            tileOrderJson: JSON.stringify(next),
          });
        }
        return next;
      });
      if (fullscreenTileId === tileId) {
        setFullscreenTileId(null);
      }
    },
    [activeWsId, fullscreenTileId]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape blurs terminal so tile shortcuts work
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement;
        if (active && active.closest(".xterm")) {
          active.blur();
          (document.querySelector("#root") as HTMLElement)?.focus();
        }
        return;
      }

      // Ctrl+1-9 switches workstreams
      if (e.ctrlKey && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        switchWorkstream(parseInt(e.key) - 1);
        return;
      }

      // Don't intercept if a terminal or input has focus
      const active = document.activeElement;
      const tag = active?.tagName?.toLowerCase();
      if (active && (active.closest(".xterm") || tag === "input" || tag === "textarea" || tag === "select")) return;

      const orderedTiles = tileOrder
        .map((id) => tiles.find((t) => t.id === id))
        .filter(Boolean);
      const count = orderedTiles.length;

      switch (e.key) {
        case "h":
        case "ArrowLeft":
          setFocusedIndex((i) => navigateFocus("left", i, count));
          break;
        case "l":
        case "ArrowRight":
          setFocusedIndex((i) => navigateFocus("right", i, count));
          break;
        case "k":
        case "ArrowUp":
          setFocusedIndex((i) => navigateFocus("up", i, count));
          break;
        case "j":
        case "ArrowDown":
          setFocusedIndex((i) => navigateFocus("down", i, count));
          break;
        case "n":
          addTile("terminal");
          break;
        case "c":
          addTile("code_viewer");
          break;
        case "d":
          addTile("doc_viewer");
          break;
        case "x":
          if (count > 0 && orderedTiles[focusedIndex]) {
            closeTile(orderedTiles[focusedIndex]!.id);
          }
          break;
        case "f":
          if (count > 0 && orderedTiles[focusedIndex]) {
            const tid = orderedTiles[focusedIndex]!.id;
            setFullscreenTileId((prev) => (prev === tid ? null : tid));
            if (activeWsId) {
              invoke("update_layout", {
                workstreamId: activeWsId,
                fullscreenTileId: fullscreenTileId === tid ? "" : tid,
              });
            }
          }
          break;
        default:
          if (e.key >= "1" && e.key <= "9") {
            const idx = parseInt(e.key) - 1;
            if (idx < count) setFocusedIndex(idx);
          }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tiles, tileOrder, focusedIndex, fullscreenTileId, activeWsId, addTile, closeTile, switchWorkstream]);

  const orderedTiles = tileOrder
    .map((id) => tiles.find((t) => t.id === id))
    .filter(Boolean);
  const focusedTile = orderedTiles[focusedIndex];

  return (
    <div
      style={{
        display: "flex",
        width: "100vw",
        height: "100vh",
        background: "#1e1e2e",
        color: "#cdd6f4",
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <WorkstreamSidebar
        workstreams={workstreams}
        activeId={activeWsId}
        onSelect={setActiveWsId}
        onCreate={createWorkstream}
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <TileGrid
          tiles={tiles}
          tileOrder={tileOrder}
          focusedIndex={focusedIndex}
          fullscreenTileId={fullscreenTileId}
          onFocusTile={setFocusedIndex}
          onCloseTile={closeTile}
        />

        <StatusBar
          tileCount={orderedTiles.length}
          focusedLabel={
            focusedTile?.title || focusedTile?.tile_type || "none"
          }
          fullscreen={fullscreenTileId !== null}
          workstreamName={
            workstreams.find((w) => w.id === activeWsId)?.name || ""
          }
        />
      </div>
    </div>
  );
}

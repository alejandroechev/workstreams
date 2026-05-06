import { useState, useEffect, useCallback, useRef } from "react";
import WorkstreamSidebar from "./workstream/WorkstreamSidebar";
import TileGrid from "./tiling/TileGrid";
import StatusBar from "./tiling/StatusBar";
import { navigateFocus } from "./domain/layout";
import { parseKeyAction } from "./domain/keyboard";
import { createTerminalConfig, parseTerminalConfig } from "./domain/tile-config";
import { useBackend } from "./backend/context";
import type { Workstream, Tile, TileType } from "./domain/types";

export default function App() {
  const backend = useBackend();
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
    backend.listWorkstreams().then((ws) => {
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
      backend.listTiles(activeWsId),
      backend.getLayout(activeWsId),
    ]).then(([t, layout]) => {
      setTiles(t);
      const order: string[] = JSON.parse(layout.tile_order_json || "[]");
      setTileOrder(order);
      setFocusedIndex(0);
      setFullscreenTileId(layout.fullscreen_tile_id || null);

      // Spawn terminal tiles only if not already spawned
      for (const tile of t) {
        if (tile.tile_type === "terminal" && !spawnedPtys.current.has(tile.id)) {
          const config = parseTerminalConfig(tile.config_json);
          const cwd = config.cwd || "C:\\";
          spawnedPtys.current.add(tile.id);
          backend.spawnTerminal(tile.id, cwd, config.command || undefined, 30, 120).catch(() => {
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
    const ws = await backend.createWorkstream(name, directory);
    // Detect git info and update
    try {
      const { repo, branch } = await backend.detectGitInfo(directory);
      if (repo || branch) {
        await backend.updateWorkstream(ws.id, {});
        ws.git_repo = repo;
        ws.git_branch = branch;
      }
    } catch { /* ignore */ }
    if (command) wsCommands.current.set(ws.id, command);
    setWorkstreams((prev) => [ws, ...prev]);
    setActiveWsId(ws.id);
  }, [backend]);

  const addTile = useCallback(async (tileType: TileType) => {
    if (!activeWsId) return;
    const ws = workstreams.find((w) => w.id === activeWsId);
    const cwd = ws?.directory || "C:\\";
    const command = wsCommands.current.get(activeWsId) || "pwsh.exe";

    const typeLabels: Record<TileType, string> = { terminal: "Terminal", code_viewer: "Code", doc_viewer: "Doc" };
    const tileCount = tiles.filter((t) => t.tile_type === tileType).length;
    const config = tileType === "terminal"
      ? createTerminalConfig(cwd, command)
      : "{}";

    const tile = await backend.createTile(activeWsId, tileType, `${typeLabels[tileType]} ${tileCount + 1}`, config);

    setTiles((prev) => [...prev, tile]);
    setTileOrder((prev) => {
      const next = [...prev, tile.id];
      backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify(next) });
      return next;
    });

    // Only spawn PTY for terminal tiles
    if (tileType === "terminal") {
      spawnedPtys.current.add(tile.id);
      await backend.spawnTerminal(tile.id, cwd, command !== "pwsh.exe" ? command : undefined, 30, 120);
    }

    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tiles.length, tileOrder.length, backend]);

  const closeTile = useCallback(
    async (tileId: string) => {
      spawnedPtys.current.delete(tileId);
      await backend.closeTerminal(tileId).catch(() => {});
      await backend.deleteTile(tileId);
      setTiles((prev) => prev.filter((t) => t.id !== tileId));
      setTileOrder((prev) => {
        const next = prev.filter((id) => id !== tileId);
        if (activeWsId) {
          backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify(next) });
        }
        return next;
      });
      if (fullscreenTileId === tileId) {
        setFullscreenTileId(null);
      }
    },
    [activeWsId, fullscreenTileId, backend]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = parseKeyAction({
        ctrlKey: e.ctrlKey,
        key: e.key,
        activeElement: document.activeElement,
      });

      if (!action) return;

      const orderedTiles = tileOrder
        .map((id) => tiles.find((t) => t.id === id))
        .filter(Boolean);
      const count = orderedTiles.length;

      switch (action.type) {
        case "escape": {
          const active = document.activeElement as HTMLElement;
          if (active && active.closest(".xterm")) {
            active.blur();
            (document.querySelector("#root") as HTMLElement)?.focus();
          }
          break;
        }
        case "switchWorkstream":
          e.preventDefault();
          switchWorkstream(action.index);
          break;
        case "navigate":
          setFocusedIndex((i) => navigateFocus(action.direction, i, count));
          break;
        case "addTile":
          addTile(action.tileType);
          break;
        case "closeTile":
          if (count > 0 && orderedTiles[focusedIndex]) {
            closeTile(orderedTiles[focusedIndex]!.id);
          }
          break;
        case "toggleFullscreen":
          if (count > 0 && orderedTiles[focusedIndex]) {
            const tid = orderedTiles[focusedIndex]!.id;
            setFullscreenTileId((prev) => (prev === tid ? null : tid));
            if (activeWsId) {
              backend.updateLayout(activeWsId, {
                fullscreen_tile_id: fullscreenTileId === tid ? "" : tid,
              });
            }
          }
          break;
        case "focusTile":
          if (action.index < count) setFocusedIndex(action.index);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tiles, tileOrder, focusedIndex, fullscreenTileId, activeWsId, addTile, closeTile, switchWorkstream, backend]);

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
        onDelete={async (id) => {
          // Close PTYs for tiles in this workstream
          const wsTiles = tiles.filter((t) => t.workstream_id === id);
          for (const t of wsTiles) {
            spawnedPtys.current.delete(t.id);
            await backend.closeTerminal(t.id).catch(() => {});
          }
          await backend.deleteWorkstream(id);
          setWorkstreams((prev) => prev.filter((w) => w.id !== id));
          if (activeWsId === id) {
            const remaining = workstreams.filter((w) => w.id !== id);
            setActiveWsId(remaining.length > 0 ? remaining[0].id : null);
            setTiles([]);
            setTileOrder([]);
          }
        }}
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

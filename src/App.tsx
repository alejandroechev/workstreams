import { useState, useEffect, useCallback, useRef } from "react";
import WorkstreamSidebar from "./workstream/WorkstreamSidebar";
import TileGrid from "./tiling/TileGrid";
import StatusBar from "./tiling/StatusBar";
import SessionPicker, { type CopilotSession } from "./tiles/SessionPicker";
import { navigateFocus } from "./domain/layout";
import { parseKeyAction } from "./domain/keyboard";
import { createTerminalConfig, createCopilotSessionConfig } from "./domain/tile-config";
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
  const [showSessionPicker, setShowSessionPicker] = useState(false);
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

      // Spawn terminal/copilot tiles only if not already spawned
      for (const tile of t) {
        if (!spawnedPtys.current.has(tile.id)) {
          if (tile.tile_type === "terminal") {
            const config = JSON.parse(tile.config_json || "{}");
            const cwd = config.cwd || "C:\\";
            spawnedPtys.current.add(tile.id);
            backend.spawnTerminal(tile.id, cwd, config.command || undefined, 30, 120).catch(() => {
              spawnedPtys.current.delete(tile.id);
            });
          } else if (tile.tile_type === "copilot_session") {
            // Copilot sessions spawn a shell — the CopilotSessionTile component
            // sends the copilot command with --resume after the shell is ready
            const config = JSON.parse(tile.config_json || "{}");
            const cwd = config.cwd || "C:\\";
            spawnedPtys.current.add(tile.id);
            // Mark as resumed so the tile component uses --resume
            if (!config.is_resumed) {
              config.is_resumed = true;
              backend.updateLayout(activeWsId, {}).catch(() => {}); // trigger refresh
            }
            backend.spawnTerminal(tile.id, cwd, undefined, 30, 120).catch(() => {
              spawnedPtys.current.delete(tile.id);
            });
          }
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

  const addTile = useCallback(async (tileType: TileType, extraConfig?: Record<string, string>) => {
    if (!activeWsId) return;
    const ws = workstreams.find((w) => w.id === activeWsId);
    const cwd = ws?.directory || "C:\\";
    const command = wsCommands.current.get(activeWsId) || "pwsh.exe";

    const typeLabels: Record<TileType, string> = {
      terminal: "Terminal",
      copilot_session: "Copilot",
      file_viewer: "Viewer",
      file_explorer: "Files",
      code_viewer: "Code",
      doc_viewer: "Doc",
    };
    const tileCount = tiles.filter((t) => t.tile_type === tileType).length;
    let config: string;
    let title: string;

    if (tileType === "terminal") {
      config = createTerminalConfig(cwd, command);
      title = `${typeLabels[tileType]} ${tileCount + 1}`;
    } else if (tileType === "copilot_session") {
      const wsName = ws?.name || "ws";
      const sessionName = `${wsName}/${tileCount + 1}`;
      config = createCopilotSessionConfig(sessionName, cwd);
      title = sessionName;
    } else if (extraConfig) {
      config = JSON.stringify(extraConfig);
      title = extraConfig.filePath
        ? extraConfig.filePath.split("\\").pop() || `${typeLabels[tileType]} ${tileCount + 1}`
        : `${typeLabels[tileType]} ${tileCount + 1}`;
    } else {
      config = "{}";
      title = `${typeLabels[tileType]} ${tileCount + 1}`;
    }

    const tile = await backend.createTile(activeWsId, tileType, title, config);

    setTiles((prev) => [...prev, tile]);
    setTileOrder((prev) => {
      const next = [...prev, tile.id];
      backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify(next) });
      return next;
    });

    // Spawn PTY for terminal and copilot_session tiles
    if (tileType === "terminal" || tileType === "copilot_session") {
      spawnedPtys.current.add(tile.id);
      await backend.spawnTerminal(tile.id, cwd, undefined, 30, 120);
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

  // Resume an existing Copilot session by creating a copilot_session tile with --resume
  const resumeExistingSession = useCallback(async (session: CopilotSession) => {
    if (!activeWsId) return;
    const ws = workstreams.find((w) => w.id === activeWsId);
    const cwd = session.cwd || ws?.directory || "C:\\";
    const sessionName = session.summary || session.session_id.slice(0, 8);

    // Build config that uses --resume with the session ID
    const config = JSON.stringify({
      session_name: sessionName,
      copilot_session_id: session.session_id,
      command_template: "agency copilot --yolo",
      cwd,
      is_resumed: true,
      resume_by_id: session.session_id,
      created_at: session.created_at || new Date().toISOString(),
    });

    const tile = await backend.createTile(activeWsId, "copilot_session", sessionName, config);

    setTiles((prev) => [...prev, tile]);
    setTileOrder((prev) => {
      const next = [...prev, tile.id];
      backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify(next) });
      return next;
    });

    spawnedPtys.current.add(tile.id);
    await backend.spawnTerminal(tile.id, cwd, undefined, 30, 120);
    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tileOrder.length, backend]);

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
          e.preventDefault();
          setFocusedIndex((i) => navigateFocus(action.direction, i, count));
          break;
        case "addTile":
          e.preventDefault();
          if (action.tileType === "copilot_session") {
            setShowSessionPicker(true);
          } else {
            addTile(action.tileType);
          }
          break;
        case "closeTile":
          e.preventDefault();
          if (count > 0 && orderedTiles[focusedIndex]) {
            closeTile(orderedTiles[focusedIndex]!.id);
          }
          break;
        case "toggleFullscreen":
          e.preventDefault();
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
        case "quickSearch":
          e.preventDefault();
          console.log("[quickSearch] Ctrl+P pressed — will wire to explorer later");
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
          minHeight: 0,
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <TileGrid
            tiles={tiles}
            tileOrder={tileOrder}
            focusedIndex={focusedIndex}
            fullscreenTileId={fullscreenTileId}
            onFocusTile={setFocusedIndex}
            onCloseTile={closeTile}
            workstreamDir={workstreams.find((w) => w.id === activeWsId)?.directory || undefined}
            onOpenFile={(path) => addTile("file_viewer", { filePath: path })}
          />
        </div>

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

      {/* Session picker modal */}
      {showSessionPicker && (
        <SessionPicker
          onSelect={(session) => {
            setShowSessionPicker(false);
            resumeExistingSession(session);
          }}
          onCreateNew={() => {
            setShowSessionPicker(false);
            addTile("copilot_session");
          }}
          onCancel={() => setShowSessionPicker(false)}
        />
      )}
    </div>
  );
}

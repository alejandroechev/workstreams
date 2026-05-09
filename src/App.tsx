import { useState, useEffect, useCallback, useRef } from "react";
import WorkstreamSidebar from "./workstream/WorkstreamSidebar";
import ProjectCreateForm from "./workstream/ProjectCreateForm";
import WorkstreamCreateForm from "./workstream/WorkstreamCreateForm";
import TileGrid from "./tiling/TileGrid";
import StatusBar from "./tiling/StatusBar";
import SessionPicker, { type CopilotSession } from "./tiles/SessionPicker";
import { navigateFocus } from "./domain/layout";
import { parseKeyAction } from "./domain/keyboard";
import { createTerminalConfig, createCopilotSessionConfig } from "./domain/tile-config";
import { useBackend } from "./backend/context";
import type { Project, Workstream, Tile, TileType } from "./domain/types";

export default function App() {
  const backend = useBackend();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workstreams, setWorkstreams] = useState<Workstream[]>([]);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [tileOrder, setTileOrder] = useState<string[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [fullscreenTileId, setFullscreenTileId] = useState<string | null>(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [linkingTileId, setLinkingTileId] = useState<string | null>(null);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [showWsCreate, setShowWsCreate] = useState<{ show: boolean; projectId?: string }>({ show: false });
  // Track which tile IDs have active PTYs to avoid double-spawning
  const spawnedPtys = useRef<Set<string>>(new Set());
  const previousWsTiles = useRef<Map<string, { tiles: Tile[]; order: string[] }>>(new Map());

  // Load projects and workstreams on mount
  useEffect(() => {
    Promise.all([backend.listProjects(), backend.listWorkstreams()]).then(([p, ws]) => {
      setProjects(p);
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
            backend.spawnTerminal(tile.id, cwd, config.command || undefined, undefined, 30, 120).catch(() => {
              spawnedPtys.current.delete(tile.id);
            });
          } else if (tile.tile_type === "copilot_session") {
            // Spawn agency.exe directly with copilot args — no pwsh wrapper needed
            const config = JSON.parse(tile.config_json || "{}");
            const cwd = config.cwd || "C:\\";
            spawnedPtys.current.add(tile.id);
            const sessionId = config.copilot_session_id || config.resume_by_id;
            const agencyArgs = ["copilot", "--yolo"];
            if (sessionId) {
              agencyArgs.push(`--resume=${sessionId}`);
            }
            backend.spawnTerminal(tile.id, cwd, "agency.exe", agencyArgs, 30, 120).catch(() => {
              spawnedPtys.current.delete(tile.id);
            });
          }
        }
      }
      // After tiles load, focus the first terminal tile
      const orderedLoaded = order
        .map((id) => t.find((tile) => tile.id === id))
        .filter(Boolean);
      setTimeout(() => {
        const firstTile = orderedLoaded[0];
        if (firstTile) {
          const tileEl = document.querySelector(`[data-tile-id="${firstTile.id}"]`);
          if (tileEl) {
            const xterm = tileEl.querySelector(".xterm-helper-textarea") as HTMLElement;
            if (xterm) xterm.focus();
          }
        }
      }, 100);
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

  const handleCreateProject = useCallback(async (name: string, directory: string, color: string, gitRemote: string | null) => {
    const proj = await backend.createProject(name, directory, color);
    if (gitRemote) {
      await backend.updateProject(proj.id, { git_remote: gitRemote });
      proj.git_remote = gitRemote;
    }
    setProjects((prev) => [...prev, proj]);
    setShowProjectCreate(false);
  }, [backend]);

  const handleCreateWorkstream = useCallback(async (
    name: string,
    directory: string,
    opts: { projectId?: string; workstreamType: string; worktreeBranch?: string; showSessionPicker?: boolean },
  ) => {
    const ws = await backend.createWorkstream(name, directory, {
      projectId: opts.projectId,
      workstreamType: opts.workstreamType,
      worktreeBranch: opts.worktreeBranch,
    });
    // Detect git info and update
    try {
      const { repo, branch } = await backend.detectGitInfo(directory);
      if (repo || branch) {
        await backend.updateWorkstream(ws.id, {});
        ws.git_repo = repo;
        ws.git_branch = branch;
      }
    } catch { /* ignore */ }
    setWorkstreams((prev) => [ws, ...prev]);
    setActiveWsId(ws.id);
    setShowWsCreate({ show: false });

    // If import worktree, show session picker to link a Copilot session
    if (opts.showSessionPicker) {
      setShowSessionPicker(true);
    }
  }, [backend]);

  const handleRenameWorkstream = useCallback(async (id: string, newName: string) => {
    await backend.updateWorkstream(id, { name: newName });
    setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, name: newName } : w));
  }, [backend]);

  const handleUpdateProject = useCallback(async (id: string, updates: { name: string; color: string }) => {
    await backend.updateProject(id, updates);
    setProjects((prev) => prev.map((p) => p.id === id ? { ...p, ...updates } : p));
  }, [backend]);

  const handleArchiveWorkstream = useCallback(async (id: string) => {
    const ws = workstreams.find((w) => w.id === id);
    if (!ws) return;

    if (ws.status === "archived") {
      // Unarchive
      await backend.updateWorkstream(id, { status: "active" });
      setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status: "active" } : w));
    } else {
      // Archive: close PTYs for tiles in this workstream
      const wsTiles = tiles.filter((t) => t.workstream_id === id);
      for (const t of wsTiles) {
        spawnedPtys.current.delete(t.id);
        await backend.closeTerminal(t.id).catch(() => {});
      }
      await backend.updateWorkstream(id, { status: "archived" });
      setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status: "archived" } : w));
      if (activeWsId === id) {
        const remaining = workstreams.filter((w) => w.id !== id && w.status !== "archived");
        setActiveWsId(remaining.length > 0 ? remaining[0].id : null);
        setTiles([]);
        setTileOrder([]);
      }
    }
  }, [workstreams, activeWsId, tiles, backend]);

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
      session_meta: "Meta",
      workbench: "Bench",
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
    if (tileType === "terminal") {
      spawnedPtys.current.add(tile.id);
      await backend.spawnTerminal(tile.id, cwd, command !== "pwsh.exe" ? command : undefined, undefined, 30, 120);
    } else if (tileType === "copilot_session") {
      spawnedPtys.current.add(tile.id);
      // Spawn agency.exe directly — new session, no resume
      await backend.spawnTerminal(tile.id, cwd, "agency.exe", ["copilot", "--yolo"], 30, 120);
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
    // Spawn agency.exe directly with --resume
    await backend.spawnTerminal(tile.id, cwd, "agency.exe", ["copilot", "--yolo", `--resume=${session.session_id}`], 30, 120);
    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tileOrder.length, backend]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = parseKeyAction({
        altKey: e.altKey,
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
        case "navigate": {
          e.preventDefault();
          // Blur current active element so focus moves to new tile
          const active = document.activeElement as HTMLElement;
          if (active && active.blur) active.blur();
          const newIndex = navigateFocus(action.direction, focusedIndex, count);
          setFocusedIndex(newIndex);
          // Focus the new tile's content after React renders
          setTimeout(() => {
            const tileId = orderedTiles[newIndex]?.id;
            if (!tileId) return;
            // Try to focus xterm textarea inside the tile
            const tileEl = document.querySelector(`[data-tile-id="${tileId}"]`);
            if (tileEl) {
              const xterm = tileEl.querySelector(".xterm-helper-textarea") as HTMLElement;
              if (xterm) { xterm.focus(); return; }
              // Or focus first focusable element
              const focusable = tileEl.querySelector("input, textarea, [tabindex]") as HTMLElement;
              if (focusable) focusable.focus();
            }
          }, 50);
          break;
        }
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
        projects={projects}
        workstreams={workstreams}
        activeWsId={activeWsId}
        onSelectWorkstream={setActiveWsId}
        onCreateProject={() => setShowProjectCreate(true)}
        onCreateWorkstream={(projectId) => setShowWsCreate({ show: true, projectId })}
        onArchiveWorkstream={handleArchiveWorkstream}
        onRenameWorkstream={handleRenameWorkstream}
        onUpdateProject={handleUpdateProject}
        onReorderWorkstream={(id, direction) => {
          setWorkstreams((prev) => {
            const idx = prev.findIndex((w) => w.id === id);
            if (idx < 0) return prev;
            const swapIdx = direction === "up" ? idx - 1 : idx + 1;
            if (swapIdx < 0 || swapIdx >= prev.length) return prev;
            const next = [...prev];
            [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
            return next;
          });
        }}
        onChangeStatus={async (id, status) => {
          await backend.updateWorkstream(id, { status });
          setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status } : w));
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
            onLinkSession={(tileId) => {
              setLinkingTileId(tileId);
              setShowSessionPicker(true);
            }}
            onAutoLink={async (tileId, sessionId, summary) => {
              // Auto-link: session poller found a session for this tile
              const tile = tiles.find((t) => t.id === tileId);
              if (!tile) return;
              const cfg = JSON.parse(tile.config_json || "{}");
              if (cfg.copilot_session_id) return; // already linked
              cfg.copilot_session_id = sessionId;
              cfg.resume_by_id = sessionId;
              cfg.is_resumed = true;
              if (summary) cfg.session_name = summary;
              const newConfig = JSON.stringify(cfg);
              const newTitle = summary || tile.title;
              await backend.updateTileConfig(tileId, newConfig, newTitle || undefined);
              setTiles((prev) => prev.map((t) =>
                t.id === tileId ? { ...t, config_json: newConfig, title: newTitle } : t
              ));
            }}
            onRestart={async (tileId) => {
              // Restart: close old PTY, spawn a new one
              const tile = tiles.find((t) => t.id === tileId);
              if (!tile) return;
              const cfg = JSON.parse(tile.config_json || "{}");
              const cwd = cfg.cwd || workstreams.find((w) => w.id === activeWsId)?.directory || "C:\\";
              await backend.closeTerminal(tileId).catch(() => {});
              spawnedPtys.current.add(tileId);
              const agencyArgs = ["copilot", "--yolo"];
              const sessionId = cfg.copilot_session_id || cfg.resume_by_id;
              if (sessionId) agencyArgs.push(`--resume=${sessionId}`);
              await backend.spawnTerminal(tileId, cwd, "agency.exe", agencyArgs, 30, 120);
            }}
            onUpdateTileConfig={async (tileId, configJson) => {
              await backend.updateTileConfig(tileId, configJson);
              setTiles((prev) => prev.map((t) =>
                t.id === tileId ? { ...t, config_json: configJson } : t
              ));
            }}
            spawnedPtyIds={spawnedPtys.current}
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
          onAddSession={() => setShowSessionPicker(true)}
          onAddTerminal={() => addTile("terminal")}
          onAddExplorer={() => addTile("file_explorer")}
          onAddSessionMeta={() => addTile("session_meta")}
          onAddWorkbench={() => addTile("workbench")}
          onToggleFullscreen={() => {
            if (orderedTiles.length > 0 && orderedTiles[focusedIndex]) {
              const tid = orderedTiles[focusedIndex]!.id;
              setFullscreenTileId((prev) => (prev === tid ? null : tid));
            }
          }}
          onCloseTitle={() => {
            if (orderedTiles.length > 0 && orderedTiles[focusedIndex]) {
              closeTile(orderedTiles[focusedIndex]!.id);
            }
          }}
        />
      </div>

      {/* Session picker modal */}
      {showSessionPicker && (
        <SessionPicker
          onSelect={(session) => {
            setShowSessionPicker(false);
            if (linkingTileId) {
              // Link session to existing tile — update config and persist to DB
              const tile = tiles.find((t) => t.id === linkingTileId);
              if (tile) {
                const cfg = JSON.parse(tile.config_json || "{}");
                cfg.copilot_session_id = session.session_id;
                cfg.resume_by_id = session.session_id;
                cfg.is_resumed = true;
                cfg.session_name = session.summary || session.session_id.slice(0, 8);
                const newConfig = JSON.stringify(cfg);
                const newTitle = session.summary || tile.title;
                // Persist to DB
                backend.updateTileConfig(linkingTileId, newConfig, newTitle || undefined);
                // Update local state
                setTiles((prev) => prev.map((t) =>
                  t.id === linkingTileId ? { ...t, config_json: newConfig, title: newTitle } : t
                ));
              }
              setLinkingTileId(null);
            } else {
              resumeExistingSession(session);
            }
          }}
          onCreateNew={() => {
            setShowSessionPicker(false);
            setLinkingTileId(null);
            addTile("copilot_session");
          }}
          onCancel={() => { setShowSessionPicker(false); setLinkingTileId(null); }}
        />
      )}

      {/* Project creation modal */}
      {showProjectCreate && (
        <ProjectCreateForm
          onSubmit={handleCreateProject}
          onCancel={() => setShowProjectCreate(false)}
        />
      )}

      {/* Workstream creation modal */}
      {showWsCreate.show && (
        <WorkstreamCreateForm
          project={showWsCreate.projectId ? projects.find((p) => p.id === showWsCreate.projectId) : undefined}
          projects={projects}
          onSubmit={handleCreateWorkstream}
          onCancel={() => setShowWsCreate({ show: false })}
        />
      )}
    </div>
  );
}

// @test-skip: top-level App shell, behavior covered by domain + backend tests
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import WorkstreamSidebar from "./workstream/WorkstreamSidebar";
import ProjectCreateForm from "./workstream/ProjectCreateForm";
import WorkstreamCreateForm from "./workstream/WorkstreamCreateForm";
import ForkWorkstreamForm from "./workstream/ForkWorkstreamForm";
import TileGrid from "./tiling/TileGrid";
import StatusBar from "./tiling/StatusBar";
import SessionPicker, { type CopilotSession } from "./tiles/SessionPicker";
import { navigateFocus } from "./domain/layout";
import { parseKeyAction } from "./domain/keyboard";
import { createTerminalConfig, createCopilotSessionConfig } from "./domain/tile-config";
import { createWorkstreamFlow } from "./domain/workstream-create";
import { useBackend } from "./backend/context";
import type { Project, Workstream, Tile, TileType } from "./domain/types";

export default function App() {
  const backend = useBackend();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workstreams, setWorkstreams] = useState<Workstream[]>([]);
  // Map of wsId → linked session summary (pulled from the pinned session tile's config).
  const [sessionInfoByWs, setSessionInfoByWs] = useState<Record<string, string | undefined>>({});
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  // Per-workstream state lives in a single map keyed by wsId. This is the
  // ONLY source of truth so each visited workstream has a stable position
  // in the React tree and its xterm.js Terminal instances are never
  // unmounted+remounted on workstream switches (which would desync the PTY).
  type WsState = {
    tiles: Tile[];
    tileOrder: string[];
    focusedIndex: number;
    fullscreenTileId: string | null;
  };
  const EMPTY_STATE: WsState = { tiles: [], tileOrder: [], focusedIndex: 0, fullscreenTileId: null };
  const [wsStates, setWsStates] = useState<Map<string, WsState>>(new Map());
  // Focus token bumped on every workstream switch so per-tile effects know to
  // re-focus their xterm textarea.
  const [focusToken, setFocusToken] = useState(0);

  // Derived helpers for the ACTIVE workstream's state
  const activeState = (activeWsId && wsStates.get(activeWsId)) || EMPTY_STATE;
  const tiles = activeState.tiles;
  const tileOrder = activeState.tileOrder;
  const focusedIndex = activeState.focusedIndex;
  const fullscreenTileId = activeState.fullscreenTileId;

  // Update helpers that act on the active workstream
  const updateActiveState = useCallback((updater: (prev: WsState) => WsState) => {
    setWsStates((prev) => {
      if (!activeWsId) return prev;
      const next = new Map(prev);
      const current = next.get(activeWsId) ?? EMPTY_STATE;
      next.set(activeWsId, updater(current));
      return next;
    });
  }, [activeWsId]);
  const setTiles = useCallback((v: Tile[] | ((prev: Tile[]) => Tile[])) =>
    updateActiveState((s) => ({ ...s, tiles: typeof v === "function" ? v(s.tiles) : v })),
    [updateActiveState],
  );
  const setTileOrder = useCallback((v: string[] | ((prev: string[]) => string[])) =>
    updateActiveState((s) => ({ ...s, tileOrder: typeof v === "function" ? v(s.tileOrder) : v })),
    [updateActiveState],
  );
  const setFocusedIndex = useCallback((v: number | ((prev: number) => number)) =>
    updateActiveState((s) => ({ ...s, focusedIndex: typeof v === "function" ? v(s.focusedIndex) : v })),
    [updateActiveState],
  );
  const setFullscreenTileId = useCallback((v: string | null | ((prev: string | null) => string | null)) =>
    updateActiveState((s) => ({ ...s, fullscreenTileId: typeof v === "function" ? v(s.fullscreenTileId) : v })),
    [updateActiveState],
  );
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [linkingTileId, setLinkingTileId] = useState<string | null>(null);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [showWsCreate, setShowWsCreate] = useState<{ show: boolean; projectId?: string }>({ show: false });
  const [showForkWs, setShowForkWs] = useState<{ show: boolean; wsId?: string }>({ show: false });
  // Track which tile IDs have active PTYs to avoid double-spawning
  const spawnedPtys = useRef<Set<string>>(new Set());
  const previousWsTiles = useRef<Map<string, { tiles: Tile[]; order: string[] }>>(new Map());

  // Load projects and workstreams on mount (with saved order)
  useEffect(() => {
    Promise.all([backend.listProjects(), backend.listWorkstreams()]).then(async ([p, ws]) => {
      setProjects(p);
      // Apply saved order
      try {
        const savedOrder = await invoke<string | null>("get_setting", { key: "workstream_order" });
        if (savedOrder) {
          const orderIds: string[] = JSON.parse(savedOrder);
          const ordered: typeof ws = [];
          for (const id of orderIds) {
            const found = ws.find((w) => w.id === id);
            if (found) ordered.push(found);
          }
          // Append any new workstreams not in saved order
          for (const w of ws) {
            if (!ordered.some((o) => o.id === w.id)) ordered.push(w);
          }
          ws = ordered;
        }
      } catch { /* ignore */ }
      setWorkstreams(ws);
      if (ws.length > 0 && !activeWsId) {
        setActiveWsId(ws[0].id);
      }

      // Populate session info from each workstream's pinned tile (background).
      void (async () => {
        const map: Record<string, string | undefined> = {};
        for (const w of ws) {
          try {
            const wsTiles = await backend.listTiles(w.id);
            const pinned = wsTiles.find((t) => {
              try { return JSON.parse(t.config_json || "{}").pinned === true; } catch { return false; }
            });
            if (pinned) {
              try {
                const cfg = JSON.parse(pinned.config_json || "{}");
                // Only surface a session label when we actually have a linked
                // session id; otherwise the sidebar should show "not linked".
                if (cfg.copilot_session_id) {
                  map[w.id] = cfg.session_summary || cfg.session_name || String(cfg.copilot_session_id).slice(0, 8);
                }
              } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
        setSessionInfoByWs(map);
      })();
    });
  }, []);

  // Load tiles + layout for a workstream on first visit. After loading,
  // the state lives in wsStates and persists across switches. Components
  // stay mounted (just hidden via CSS) so xterm/PTY state stays coherent.
  useEffect(() => {
    if (!activeWsId) return;

    // Always bump focus token on switch so per-tile effects re-focus.
    setFocusToken((n) => n + 1);

    // If already loaded, nothing to do — the existing mounted tree just
    // becomes visible.
    if (wsStates.has(activeWsId)) return;

    Promise.all([
      backend.listTiles(activeWsId),
      backend.getLayout(activeWsId),
    ]).then(([t, layout]) => {
      const order: string[] = JSON.parse(layout.tile_order_json || "[]");
      setWsStates((prev) => {
        if (prev.has(activeWsId)) return prev;
        const next = new Map(prev);
        next.set(activeWsId, {
          tiles: t,
          tileOrder: order,
          focusedIndex: 0,
          fullscreenTileId: layout.fullscreen_tile_id || null,
        });
        return next;
      });

      // Spawn terminal/copilot tiles only if not already spawned.
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
            const config = JSON.parse(tile.config_json || "{}");
            const cwd = config.cwd || "C:\\";
            spawnedPtys.current.add(tile.id);
            const sessionId = config.copilot_session_id || config.resume_by_id || null;
            backend.spawnCopilotSession(tile.id, cwd, sessionId, 30, 120).catch(() => {
              spawnedPtys.current.delete(tile.id);
            });
          }
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // When the user submits the WS create form with sessionChoice="existing",
  // we stash the payload here, open the picker first, and only call
  // createWorkstreamFlow after the user actually picks (or cancels).
  type PendingCreate = {
    name: string;
    directory: string;
    projectId?: string;
    workstreamType: "import_worktree" | "base_repo" | "worktree";
    worktreeBranch?: string;
    baseBranch?: string;
  };
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);

  const doCreateWorkstream = useCallback(async (
    payload: PendingCreate,
    presetSessionId: string | null,
  ): Promise<{ ws: Workstream; tile: Tile; effectiveDirectory: string } | null> => {
    let result;
    try {
      result = await createWorkstreamFlow(
        backend,
        {
          name: payload.name,
          directory: payload.directory,
          projectId: payload.projectId,
          workstreamType: payload.workstreamType,
          worktreeBranch: payload.worktreeBranch,
          baseBranch: payload.baseBranch,
          sessionChoice: presetSessionId ? "existing" : "new",
        },
        (projectDirectory, branchName, baseBranch) =>
          invoke<string>("create_worktree", { projectDirectory, branchName, baseBranch }),
      );
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error)?.message || String(e);
      alert(`Failed to create workstream: ${msg}`);
      return null;
    }

    const { workstream: ws, pinnedTile: tile, effectiveDirectory } = result;

    // If a session was pre-selected, bake its id into the tile config now so
    // the tile mounts already linked and the poller takes the fast path.
    if (presetSessionId) {
      try {
        const cfg = JSON.parse(tile.config_json || "{}");
        cfg.copilot_session_id = presetSessionId;
        cfg.resume_by_id = presetSessionId;
        cfg.is_resumed = true;
        const newConfig = JSON.stringify(cfg);
        tile.config_json = newConfig;
        await backend.updateTileConfig(tile.id, newConfig);
      } catch { /* ignore */ }
    }

    try {
      const { repo, branch } = await backend.detectGitInfo(effectiveDirectory);
      if (repo || branch) {
        await backend.updateWorkstream(ws.id, {});
        ws.git_repo = repo;
        ws.git_branch = branch;
      }
    } catch { /* ignore */ }

    setWorkstreams((prev) => [ws, ...prev]);
    setActiveWsId(ws.id);
    setTiles([tile]);
    setTileOrder([tile.id]);
    return { ws, tile, effectiveDirectory };
  }, [backend]);

  const handleCreateWorkstream = useCallback(async (
    name: string,
    directory: string,
    opts: { projectId?: string; workstreamType: string; worktreeBranch?: string; sessionChoice?: "new" | "existing"; baseBranch?: string },
  ) => {
    const payload: PendingCreate = {
      name,
      directory,
      projectId: opts.projectId,
      workstreamType: opts.workstreamType as PendingCreate["workstreamType"],
      worktreeBranch: opts.worktreeBranch,
      baseBranch: opts.baseBranch,
    };

    if (opts.sessionChoice === "existing") {
      // Defer WS creation until the user actually picks a session. This
      // avoids registering a no-session tile with the poller and prevents
      // the wrong-link race.
      setPendingCreate(payload);
      setShowWsCreate({ show: false });
      setShowSessionPicker(true);
      return;
    }

    setShowWsCreate({ show: false });
    const created = await doCreateWorkstream(payload, null);
    if (!created) return;

    // New session — spawn agency.exe and register PID correlation with the poller.
    spawnedPtys.current.add(created.tile.id);
    backend.spawnCopilotSession(created.tile.id, created.effectiveDirectory, null, 30, 120).catch(() => {
      spawnedPtys.current.delete(created.tile.id);
    });
  }, [backend, doCreateWorkstream]);

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

  const handleForkWorkstream = useCallback(async (
    sourceWsId: string,
    opts: { name: string; branchName: string; baseBranch: string; archiveOld: boolean },
  ) => {
    const sourceWs = workstreams.find((w) => w.id === sourceWsId);
    if (!sourceWs) return;

    // Find the copilot session ID from the source workstream's tiles
    const sourceTiles = await backend.listTiles(sourceWsId);
    const sessionTile = sourceTiles.find((t) => t.tile_type === "copilot_session");
    let sessionId: string | null = null;
    if (sessionTile) {
      try {
        const cfg = JSON.parse(sessionTile.config_json || "{}");
        sessionId = cfg.copilot_session_id || cfg.resume_by_id || null;
      } catch { /* ignore */ }
    }

    // Create the git worktree
    let newDir: string;
    try {
      newDir = await invoke<string>("create_worktree", {
        projectDirectory: sourceWs.directory,
        branchName: opts.branchName,
        baseBranch: opts.baseBranch,
      });
    } catch (e) {
      console.error("Failed to create worktree:", e);
      return;
    }

    // Create new workstream
    const newWs = await backend.createWorkstream(opts.name, newDir, {
      projectId: sourceWs.project_id || undefined,
      workstreamType: "worktree",
      worktreeBranch: opts.branchName,
    });

    // Create copilot_session tile with the same session ID (resume)
    const config = JSON.stringify({
      session_name: opts.name,
      copilot_session_id: sessionId,
      resume_by_id: sessionId,
      command_template: "agency copilot --yolo",
      cwd: newDir,
      is_resumed: !!sessionId,
      created_at: new Date().toISOString(),
    });
    const tile = await backend.createTile(newWs.id, "copilot_session", opts.name, config);
    await backend.updateLayout(newWs.id, { tile_order_json: JSON.stringify([tile.id]) });

    // Optionally archive old workstream
    if (opts.archiveOld) {
      for (const t of sourceTiles) {
        spawnedPtys.current.delete(t.id);
        await backend.closeTerminal(t.id).catch(() => {});
      }
      await backend.updateWorkstream(sourceWsId, { status: "archived" });
      setWorkstreams((prev) => prev.map((w) => w.id === sourceWsId ? { ...w, status: "archived" } : w));
    }

    // Switch to new workstream
    setWorkstreams((prev) => [newWs, ...prev]);
    setActiveWsId(newWs.id);
    setTiles([tile]);
    setTileOrder([tile.id]);
    setShowForkWs({ show: false });

    // Spawn agency.exe with --resume
    spawnedPtys.current.add(tile.id);
    backend.spawnCopilotSession(tile.id, newDir, sessionId, 30, 120).catch(() => {
      spawnedPtys.current.delete(tile.id);
    });
  }, [workstreams, backend]);

  const addTile = useCallback(async (tileType: TileType, extraConfig?: Record<string, string>) => {
    if (!activeWsId) return;
    const ws = workstreams.find((w) => w.id === activeWsId);
    const cwd = ws?.directory || "C:\\";
    const command = wsCommands.current.get(activeWsId) || "pwsh.exe";

    const typeLabels: Record<TileType, string> = {
      terminal: "PowerShell",
      copilot_session: "Copilot",
      file_viewer: "Viewer",
      file_explorer: "Repo",
      code_viewer: "Code",
      doc_viewer: "Doc",
      session_meta: "Meta-session",
      workbench: "Bench",
    };
    // Count by sub-shell (PowerShell vs WSL) so each gets its own
    // numbered sequence.
    const isWsl = tileType === "terminal" && extraConfig?.shell === "wsl";
    let tileCount: number;
    if (tileType === "terminal") {
      tileCount = tiles.filter((t) => {
        if (t.tile_type !== "terminal") return false;
        try {
          const c = JSON.parse(t.config_json || "{}");
          const wsl = c.shell === "wsl" || (typeof c.command === "string" && c.command.toLowerCase().includes("wsl"));
          return wsl === isWsl;
        } catch {
          return !isWsl;
        }
      }).length;
    } else {
      tileCount = tiles.filter((t) => t.tile_type === tileType).length;
    }
    let config: string;
    let title: string;

    if (tileType === "terminal") {
      const shellCmd = isWsl ? "wsl.exe" : command;
      config = createTerminalConfig(cwd, shellCmd);
      title = isWsl ? `WSL ${tileCount + 1}` : `${typeLabels[tileType]} ${tileCount + 1}`;
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
      const shellCmd = extraConfig?.shell === "wsl" ? "wsl.exe" : (command !== "pwsh.exe" ? command : undefined);
      await backend.spawnTerminal(tile.id, cwd, shellCmd, undefined, 30, 120);
    } else if (tileType === "copilot_session") {
      spawnedPtys.current.add(tile.id);
      // Spawn agency.exe directly — new session, no resume
      await backend.spawnCopilotSession(tile.id, cwd, null, 30, 120);
    }

    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tiles.length, tileOrder.length, backend]);

  const closeTile = useCallback(
    async (tileId: string) => {
      // Pinned tiles cannot be closed.
      const t = tiles.find((x) => x.id === tileId);
      if (t) {
        try {
          const cfg = JSON.parse(t.config_json || "{}");
          if (cfg.pinned) return;
        } catch { /* ignore */ }
      }
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
    [activeWsId, fullscreenTileId, backend, tiles]
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
    await backend.spawnCopilotSession(tile.id, cwd, session.session_id, 30, 120);
    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tileOrder.length, backend]);

  // Compute linked session IDs from copilot_session tiles
  const linkedSessionIds = useMemo(() => {
    return tiles
      .filter((t) => t.tile_type === "copilot_session")
      .map((t) => {
        try {
          const cfg = JSON.parse(t.config_json || "{}");
          return (cfg.copilot_session_id || cfg.resume_by_id || null) as string | null;
        } catch { return null; }
      })
      .filter((id): id is string => !!id);
  }, [tiles]);

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
            addTile(action.tileType, action.extraConfig);
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
        sessionInfoByWs={sessionInfoByWs}
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
            // Persist order
            invoke("set_setting", { key: "workstream_order", value: JSON.stringify(next.map((w) => w.id)) }).catch(() => {});
            return next;
          });
        }}
        onChangeStatus={async (id, status) => {
          await backend.updateWorkstream(id, { status });
          setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status } : w));
        }}
        onForkWorkstream={(id) => setShowForkWs({ show: true, wsId: id })}
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
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
          {/*
            Render every loaded workstream in a STABLE position. Only the
            active one is visible. This keeps xterm.js Terminal instances
            and PTYs in sync across switches — no unmount/remount churn.
            Source of truth: wsStates map (one entry per loaded workstream).
          */}
          {Array.from(wsStates.entries()).map(([wsId, st]) => {
            const isActive = wsId === activeWsId;
            return (
              <div
                key={wsId}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: isActive ? "flex" : "none",
                  flexDirection: "column",
                }}
              >
                <TileGrid
                  tiles={st.tiles}
                  tileOrder={st.tileOrder}
                  focusedIndex={st.focusedIndex}
                  focusToken={focusToken}
                  fullscreenTileId={st.fullscreenTileId}
                  onFocusTile={isActive ? setFocusedIndex : () => {}}
                  onCloseTile={isActive ? closeTile : () => {}}
                  workstreamDir={workstreams.find((w) => w.id === wsId)?.directory || undefined}
                  workstreamId={wsId}
                  onOpenFile={isActive ? (path) => addTile("file_viewer", { filePath: path }) : undefined}
                  onLinkSession={isActive ? (tileId) => {
                    setLinkingTileId(tileId);
                    setShowSessionPicker(true);
                  } : undefined}
                  onAutoLink={isActive ? async (tileId, sessionId, summary) => {
                    const tile = tiles.find((t) => t.id === tileId);
                    if (!tile) return;
                    const cfg = JSON.parse(tile.config_json || "{}");
                    if (cfg.copilot_session_id) return;
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
                    // Update sidebar info if this is the pinned tile.
                    if (cfg.pinned) {
                      setSessionInfoByWs((prev) => ({ ...prev, [wsId]: summary || sessionId.slice(0, 8) }));
                    }
                  } : undefined}
                  onRestart={isActive ? async (tileId) => {
                    const tile = tiles.find((t) => t.id === tileId);
                    if (!tile) return;
                    const cfg = JSON.parse(tile.config_json || "{}");
                    const cwd = cfg.cwd || workstreams.find((w) => w.id === activeWsId)?.directory || "C:\\";
                    await backend.closeTerminal(tileId).catch(() => {});
                    spawnedPtys.current.add(tileId);
                    const sessionId = cfg.copilot_session_id || cfg.resume_by_id || null;
                    await backend.spawnCopilotSession(tileId, cwd, sessionId, 30, 120);
                  } : undefined}
                  onUpdateTileConfig={isActive ? async (tileId, configJson) => {
                    await backend.updateTileConfig(tileId, configJson);
                    setTiles((prev) => prev.map((t) =>
                      t.id === tileId ? { ...t, config_json: configJson } : t
                    ));
                  } : undefined}
                  spawnedPtyIds={spawnedPtys.current}
                  linkedSessionIds={linkedSessionIds}
                />
              </div>
            );
          })}
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
          onAddWslTerminal={() => addTile("terminal", { shell: "wsl" })}
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
          onSelect={async (session) => {
            setShowSessionPicker(false);
            // Case A: user started "new WS + existing session" — create the
            // WS now with the picked session id baked into the tile config.
            if (pendingCreate) {
              const payload = pendingCreate;
              setPendingCreate(null);
              const created = await doCreateWorkstream(payload, session.session_id);
              if (!created) return;
              // Update sidebar info now that we have a real session.
              setSessionInfoByWs((prev) => ({
                ...prev,
                [created.ws.id]: session.summary || session.session_id.slice(0, 8),
              }));
              spawnedPtys.current.add(created.tile.id);
              backend
                .spawnCopilotSession(created.tile.id, created.effectiveDirectory, session.session_id, 30, 120)
                .catch(() => spawnedPtys.current.delete(created.tile.id));
              return;
            }
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
                backend.updateTileConfig(linkingTileId, newConfig, newTitle || undefined);
                setTiles((prev) => prev.map((t) =>
                  t.id === linkingTileId ? { ...t, config_json: newConfig, title: newTitle } : t
                ));
                if (cfg.pinned && activeWsId) {
                  setSessionInfoByWs((prev) => ({ ...prev, [activeWsId]: session.summary || session.session_id.slice(0, 8) }));
                }
                if (!spawnedPtys.current.has(linkingTileId)) {
                  const cwd = cfg.cwd || workstreams.find((w) => w.id === activeWsId)?.directory || "C:\\";
                  spawnedPtys.current.add(linkingTileId);
                  backend.spawnCopilotSession(linkingTileId, cwd, session.session_id, 30, 120).catch(() => {
                    spawnedPtys.current.delete(linkingTileId);
                  });
                }
              }
              setLinkingTileId(null);
            } else {
              resumeExistingSession(session);
            }
          }}
          onCreateNew={() => {
            setShowSessionPicker(false);
            // Case A: user wanted "existing session" but changes mind →
            // create the WS now with a new session instead.
            if (pendingCreate) {
              const payload = pendingCreate;
              setPendingCreate(null);
              void (async () => {
                const created = await doCreateWorkstream(payload, null);
                if (!created) return;
                spawnedPtys.current.add(created.tile.id);
                backend
                  .spawnCopilotSession(created.tile.id, created.effectiveDirectory, null, 30, 120)
                  .catch(() => spawnedPtys.current.delete(created.tile.id));
              })();
              return;
            }
            setLinkingTileId(null);
            addTile("copilot_session");
          }}
          onCancel={() => {
            setShowSessionPicker(false);
            setLinkingTileId(null);
            // If we were mid-create, reopen the create form so the user can
            // adjust their choice instead of losing the entered data.
            if (pendingCreate) {
              setShowWsCreate({ show: true, projectId: pendingCreate.projectId });
              setPendingCreate(null);
            }
          }}
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

      {/* Fork workstream modal */}
      {showForkWs.show && showForkWs.wsId && (() => {
        const ws = workstreams.find((w) => w.id === showForkWs.wsId);
        if (!ws) return null;
        // Find linked session ID from copilot tiles
        const sessionTile = tiles.find((t) => t.tile_type === "copilot_session" && t.workstream_id === ws.id);
        let sessionId: string | null = null;
        if (sessionTile) {
          try {
            const cfg = JSON.parse(sessionTile.config_json || "{}");
            sessionId = cfg.copilot_session_id || cfg.resume_by_id || null;
          } catch { /* */ }
        }
        return (
          <ForkWorkstreamForm
            workstreamName={ws.name}
            workstreamDir={ws.directory || ""}
            currentBranch={ws.git_branch || ws.worktree_branch || null}
            sessionId={sessionId}
            onSubmit={(opts) => handleForkWorkstream(ws.id, opts)}
            onCancel={() => setShowForkWs({ show: false })}
          />
        );
      })()}
    </div>
  );
}

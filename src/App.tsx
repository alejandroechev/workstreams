import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { hydrateAppSettings, getAppSettings } from "./domain/app-settings";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fileBufferRegistry } from "./files/FileBufferRegistry";
import WorkstreamSidebar from "./workstream/WorkstreamSidebar";
import ProjectCreateForm from "./workstream/ProjectCreateForm";
import RepoCreateForm from "./workstream/RepoCreateForm";
import WorkstreamCreateForm from "./workstream/WorkstreamCreateForm";
import ForkWorkstreamForm from "./workstream/ForkWorkstreamForm";
import { ChangeWorktreeForm } from "./workstream/ChangeWorktreeForm";
import { WorktreeCreationOverlay } from "./ui/WorktreeCreationOverlay";
import { ArchiveWorkstreamDialog } from "./workstream/ArchiveWorkstreamDialog";
import TileGrid from "./tiling/TileGrid";
import StatusBar from "./tiling/StatusBar";
import SessionPicker, { type CopilotSession } from "./tiles/SessionPicker";
import SettingsModal from "./ui/SettingsModal";
import DiffReviewPickerModal from "./ui/components/DiffReviewPickerModal";
import ConfirmCloseDialog from "./ui/components/ConfirmCloseDialog";
import { navigateFocus } from "./domain/layout";
import { toggleFullscreenForTile as toggleFullscreenForTileState, shiftSelectTile as shiftSelectTileState } from "./domain/tile-layout-mode";
import { computeSessionNameSync } from "./domain/session-name-sync";
import { deriveLinkedSessionIds } from "./domain/linked-sessions";
import { parseKeyAction } from "./domain/keyboard";
import { createTerminalConfig, createCopilotSessionConfig } from "./domain/tile-config";
import { createWorkstreamFlow } from "./domain/workstream-create";
import {
  applyWorktreeEvent,
  initialCreatingState,
  initialArchivingState,
  type ProvisioningState,
  type WorktreeProgressEvent,
} from "./domain/worktree-provisioning";
import { workbenchStore } from "./domain/workbench-store-instance";
import { setWorkbenchStoreForDispatcher } from "./domain/workbench-events";
import { useBackend } from "./backend/context";
import type { Project, Workstream, Tile, TileType } from "./domain/types";
import type { DiffReview } from "./domain/diff-review";

// Wire the persistent Workbench store into the cross-tile dispatcher
// so right-clicks from anywhere persist to the workstream's setting
// even when no Workbench tile is currently mounted.
setWorkbenchStoreForDispatcher(workbenchStore);

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
    /** Set of tile ids currently selected for entering side-by-side. */
    selectedForSideBySide: Set<string>;
    /** When set, exactly two tile ids that are rendered visibly side-by-side. */
    sideBySideTileIds: string[] | null;
    /** When true the per-tile selection checkboxes are visible so the user
     * can pick two tiles to enter side-by-side. Toggled via the status-bar
     * button (or Alt+S). Auto-clears once 2 tiles are selected and SBS
     * activates, and on explicit cancel. */
    sbsSelectionMode: boolean;
  };
  const EMPTY_STATE: WsState = {
    tiles: [],
    tileOrder: [],
    focusedIndex: 0,
    fullscreenTileId: null,
    selectedForSideBySide: new Set(),
    sideBySideTileIds: null,
    sbsSelectionMode: false,
  };
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
  const selectedForSideBySide = activeState.selectedForSideBySide;
  const sideBySideTileIds = activeState.sideBySideTileIds;
  const sbsSelectionMode = activeState.sbsSelectionMode;

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

  /**
   * Toggle fullscreen for a specific tile (double-click on its header).
   * Entering fullscreen clears any active side-by-side so the modes don't
   * fight; clicking the same tile again exits.
   */
  const toggleFullscreenForTile = useCallback((tileId: string) => {
    updateActiveState((s) => toggleFullscreenForTileState(s, tileId));
  }, [updateActiveState]);

  /**
   * Shift-click on a tile → enter side-by-side with the currently-focused
   * tile (left pane) and the shift-clicked tile (right pane). If the
   * clicked tile is already the focused one, this is a no-op focus change.
   */
  const shiftSelectTile = useCallback((tileId: string) => {
    updateActiveState((s) => shiftSelectTileState(s, tileId));
  }, [updateActiveState]);

  /**
   * Toggle a tile's side-by-side selection. When the user picks the
   * 2nd tile (so total == 2), immediately commit: enter side-by-side
   * with those two tiles, in tile-order, and exit selection mode. This
   * matches the "click → checkboxes appear → pick two → done" flow.
   */
  const toggleSideBySideSelect = useCallback((tileId: string) => {
    updateActiveState((s) => {
      const next = new Set(s.selectedForSideBySide);
      if (next.has(tileId)) {
        next.delete(tileId);
        return { ...s, selectedForSideBySide: next };
      }
      next.add(tileId);
      if (next.size === 2) {
        // Preserve tile order: pair appears left = earlier-in-tileOrder.
        const ids = s.tileOrder.filter((id) => next.has(id));
        if (ids.length === 2) {
          return {
            ...s,
            selectedForSideBySide: new Set(),
            sideBySideTileIds: ids,
            sbsSelectionMode: false,
            fullscreenTileId: null,
          };
        }
      }
      return { ...s, selectedForSideBySide: next };
    });
  }, [updateActiveState]);

  /**
   * Status-bar SBS button.
   * - If currently in side-by-side → exit (clear ids + selection).
   * - Else → toggle selection mode (show/hide per-tile checkboxes).
   *   Always enabled; the actual SBS entry happens via
   *   toggleSideBySideSelect when the 2nd tile is checked.
   */
  const toggleSideBySide = useCallback(() => {
    updateActiveState((s) => {
      if (s.sideBySideTileIds) {
        return {
          ...s,
          sideBySideTileIds: null,
          selectedForSideBySide: new Set(),
          sbsSelectionMode: false,
        };
      }
      return {
        ...s,
        sbsSelectionMode: !s.sbsSelectionMode,
        // Drop any half-baked selection if the user cancels.
        selectedForSideBySide: !s.sbsSelectionMode ? s.selectedForSideBySide : new Set(),
      };
    });
  }, [updateActiveState]);

  // Idempotently insert/replace a tile in its workstream's state, deduped by id.
  // Used by addTile, the tile-created event listener, the CDP seed bridge, and
  // the diff-review path B handler — single source of truth so all entry points
  // converge on the same state shape.
  const upsertTileLocally = useCallback((tile: Tile) => {
    setWsStates((prev) => {
      const wsId = tile.workstream_id;
      // No-op for unloaded workstreams: first-load will read truth from DB.
      if (!prev.has(wsId)) return prev;
      const next = new Map(prev);
      const current = next.get(wsId)!;
      const tiles = current.tiles.some((t) => t.id === tile.id)
        ? current.tiles.map((t) => (t.id === tile.id ? tile : t))
        : [...current.tiles, tile];
      const tileOrder = current.tileOrder.includes(tile.id)
        ? current.tileOrder
        : [...current.tileOrder, tile.id];
      next.set(wsId, { ...current, tiles, tileOrder });
      return next;
    });
  }, []);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [linkingTileId, setLinkingTileId] = useState<string | null>(null);
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [showRepoCreate, setShowRepoCreate] = useState(false);
  const [showWsCreate, setShowWsCreate] = useState<{ show: boolean; projectId?: string }>({ show: false });
  const [showForkWs, setShowForkWs] = useState<{ show: boolean; wsId?: string }>({ show: false });
  const [changeWorktreeTarget, setChangeWorktreeTarget] = useState<Workstream | null>(null);
  /** Pending archive awaiting the confirm dialog (offers worktree delete). */
  const [archiveConfirm, setArchiveConfirm] = useState<{ ws: Workstream; isWorktree: boolean } | null>(null);
  /** Lifts the global blocking overlay during long-running git ops
   *  (create worktree, optional base pull). null = idle. */
  const [worktreeOverlay, setWorktreeOverlay] = useState<{ title: string } | null>(null);
  /** Per-workstream worktree provisioning state (create/archive), keyed by ws
   *  id, driven by id-keyed `worktree-progress` events through the reducer. */
  const [provisioning, setProvisioning] = useState<Map<string, ProvisioningState>>(new Map());
  const [showSettings, setShowSettings] = useState(false);
  const [showDiffReviewPicker, setShowDiffReviewPicker] = useState(false);
  const [diffReviewPickerReviews, setDiffReviewPickerReviews] = useState<DiffReview[]>([]);
  const [noActiveReviewHint, setNoActiveReviewHint] = useState(false);
  // Track which tile IDs have active PTYs to avoid double-spawning
  const spawnedPtys = useRef<Set<string>>(new Set());
  // Tile ids whose PTY exit was triggered by our own restart code path.
  // Used by CopilotSessionTile / TerminalTile to swap the "[Session ended]"
  // banner for "[Restarting…]" when we know the exit was intentional.
  const intentionalRestartIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Expose to tiles via a window global to avoid plumbing yet another
    // prop through Tile → Tile children for what is purely a UI hint.
    (window as unknown as { __wsIntentionalRestartIds?: Set<string> }).__wsIntentionalRestartIds =
      intentionalRestartIds.current;
  }, []);
  const previousWsTiles = useRef<Map<string, { tiles: Tile[]; order: string[] }>>(new Map());

  const getDirtyFileBuffers = useCallback(() => fileBufferRegistry.listAll().filter((snapshot) => snapshot.dirty), []);

  const confirmDiscardDirtyFileBuffers = useCallback((action: string) => {
    const dirtyCount = getDirtyFileBuffers().length;
    if (dirtyCount === 0) return true;
    return window.confirm(`You have unsaved changes in ${dirtyCount} file(s). Discard and ${action}?`);
  }, [getDirtyFileBuffers]);

  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);
  const confirmCloseFinalizeRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const unsub = (async () => {
      const win = getCurrentWindow();
      const unlisten = await win.onCloseRequested(async (event) => {
        const dirty = getDirtyFileBuffers();
        // Dirty buffers get their own (more informative) confirm.
        if (dirty.length > 0) {
          event.preventDefault();
          const list = dirty.map((snapshot) => `  • ${snapshot.path}`).join("\n");
          const ok = window.confirm(`You have unsaved changes in ${dirty.length} file(s):\n\n${list}\n\nClose anyway and discard?`);
          if (ok) {
            try { await win.destroy(); }
            catch (err) { console.error("window.destroy failed:", err); }
          }
          return;
        }

        // Generic confirm-close gate. Respects the "Don't ask again"
        // setting under app.confirm-close-disabled.
        let disabled = false;
        try {
          const raw = await invoke<string | null>("get_setting", { key: "app.confirm-close-disabled" });
          disabled = raw === "1";
        } catch { /* default to ask */ }

        if (disabled) {
          event.preventDefault();
          try { await win.destroy(); }
          catch (err) { console.error("window.destroy failed (check capabilities/default.json for core:window:allow-destroy):", err); }
          return;
        }

        event.preventDefault();
        confirmCloseFinalizeRef.current = async () => {
          try { await win.destroy(); }
          catch (err) { console.error("window.destroy failed:", err); }
        };
        setConfirmCloseOpen(true);
      });
      return unlisten;
    })();

    return () => { unsub.then((unlisten) => unlisten?.()).catch(() => {}); };
  }, [getDirtyFileBuffers]);

  const handleConfirmClose = useCallback(async (dontAskAgain: boolean) => {
    setConfirmCloseOpen(false);
    if (dontAskAgain) {
      try { await invoke("set_setting", { key: "app.confirm-close-disabled", value: "1" }); }
      catch (err) { console.error("set_setting failed:", err); }
    }
    const finalize = confirmCloseFinalizeRef.current;
    confirmCloseFinalizeRef.current = null;
    if (finalize) await finalize();
  }, []);

  const handleCancelClose = useCallback(() => {
    setConfirmCloseOpen(false);
    confirmCloseFinalizeRef.current = null;
  }, []);

  // Hydrate app-level settings (font sizes, scroll speed) from SQLite
  // before tiles render so the first paint uses real values.
  useEffect(() => {
    void hydrateAppSettings();
  }, []);

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

  // Re-sync linked Copilot session names against the session store. For
  // each copilot_session tile with a linked session id, read the current
  // summary and, if it changed since link time, update the tile's stored
  // name + (auto-derived) title and the sidebar label. Best-effort: any
  // per-tile failure is swallowed so one bad tile can't break the sync.
  const syncLinkedSessionNames = useCallback(async (wsId: string, wsTiles: Tile[]) => {
    for (const tile of wsTiles) {
      if (tile.tile_type !== "copilot_session") continue;
      let cfg: Record<string, unknown>;
      try { cfg = JSON.parse(tile.config_json || "{}"); } catch { continue; }
      const sessionId = (cfg.copilot_session_id || cfg.resume_by_id) as string | undefined;
      if (!sessionId) continue;
      try {
        const info = await invoke<{ summary: string | null } | null>(
          "get_copilot_session_by_id",
          { sessionId },
        );
        const update = computeSessionNameSync(tile.config_json, tile.title, info?.summary ?? null);
        if (!update) continue;
        await backend.updateTileConfig(tile.id, update.configJson, update.title);
        upsertTileLocally({
          ...tile,
          config_json: update.configJson,
          title: update.title ?? tile.title,
        });
        setSessionInfoByWs((prev) => ({ ...prev, [wsId]: update.label }));
      } catch { /* ignore per-tile failures */ }
    }
  }, [backend, upsertTileLocally]);

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
          // Fullscreen is runtime-only: starts at null on every workstream
          // load even if the prior session persisted a value. The DB column
          // is left in place for backwards compatibility but no longer read.
          fullscreenTileId: null,
          selectedForSideBySide: new Set(),
          sideBySideTileIds: null,
          sbsSelectionMode: false,
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
            backend.spawnCopilotSession(tile.id, cwd, sessionId, 30, 120, getAppSettings().copilotCommand).catch(() => {
              spawnedPtys.current.delete(tile.id);
            });
          }
        }
      }

      // Re-sync linked Copilot session names: a session may have been
      // renamed since it was first linked. Read its current summary from
      // the session store and update the tile's name if it changed. Runs
      // in the background so it never blocks the workstream from rendering.
      void syncLinkedSessionNames(activeWsId, t);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWsId]);

  const selectWorkstream = useCallback((id: string) => {
    if (id === activeWsId) return;
    // A worktree still provisioning (or failed to provision) has no working
    // directory yet — its row is a no-op until it becomes ready.
    const target = workstreams.find((w) => w.id === id);
    if (target && (target.status === "creating" || target.status === "create_failed")) return;
    if (!confirmDiscardDirtyFileBuffers("switch workstreams")) return;
    setActiveWsId(id);
  }, [activeWsId, workstreams, confirmDiscardDirtyFileBuffers]);

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
    pullBaseFirst?: boolean;
  };
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);

  // Stashed provisioning params per ws id so a failed create can be retried
  // without re-entering the form.
  const provisionParamsRef = useRef<Map<string, {
    projectDirectory: string; branchName: string; baseBranch: string | null; pullBaseFirst: boolean;
  }>>(new Map());

  // Fire the non-blocking worktree provisioning for a workstream that already
  // exists in `creating` state. Seeds provisioning state and flips the row to
  // create_failed if the command can't even start. Shared by create / fork /
  // retry.
  const fireCreateWorktree = useCallback((
    wsId: string,
    params: { projectDirectory: string; branchName: string; baseBranch: string | null; pullBaseFirst: boolean },
  ) => {
    provisionParamsRef.current.set(wsId, params);
    setProvisioning((prev) => new Map(prev).set(wsId, initialCreatingState()));
    setWorkstreams((prev) => prev.map((w) => w.id === wsId ? { ...w, status: "creating" } : w));
    invoke("create_worktree", {
      workstreamId: wsId,
      projectDirectory: params.projectDirectory,
      branchName: params.branchName,
      baseBranch: params.baseBranch,
      pullBaseFirst: params.pullBaseFirst,
    }).catch((e) => {
      setProvisioning((prev) => {
        const cur = prev.get(wsId) ?? initialCreatingState();
        return new Map(prev).set(wsId, applyWorktreeEvent(cur, {
          workstreamId: wsId, op: "create", phase: "create-failed",
          detail: typeof e === "string" ? e : String(e), status: "error",
        }));
      });
      setWorkstreams((prev) => prev.map((w) => w.id === wsId ? { ...w, status: "create_failed" } : w));
    });
  }, []);

  /** Retry a failed worktree create using the stashed params. */
  const handleRetryCreate = useCallback((wsId: string) => {
    const params = provisionParamsRef.current.get(wsId);
    if (params) fireCreateWorktree(wsId, params);
  }, [fireCreateWorktree]);

  // Stashed worktree directory per ws id so a failed archive-removal can be
  // retried.
  const removeDirRef = useRef<Map<string, string>>(new Map());

  /** Fire the non-blocking worktree removal for an archived workstream. */
  const fireRemoveWorktree = useCallback((wsId: string, directory: string) => {
    removeDirRef.current.set(wsId, directory);
    setProvisioning((prev) => new Map(prev).set(wsId, initialArchivingState()));
    setWorkstreams((prev) => prev.map((w) => w.id === wsId ? { ...w, status: "archiving" } : w));
    invoke("remove_worktree", { workstreamId: wsId, directory }).catch((e) => {
      setProvisioning((prev) => {
        const cur = prev.get(wsId) ?? initialArchivingState();
        return new Map(prev).set(wsId, applyWorktreeEvent(cur, {
          workstreamId: wsId, op: "archive", phase: "remove-failed",
          detail: typeof e === "string" ? e : String(e), status: "error",
        }));
      });
      setWorkstreams((prev) => prev.map((w) => w.id === wsId ? { ...w, status: "archived" } : w));
    });
  }, []);

  /** Retry a failed worktree removal for an archived workstream. */
  const handleRetryRemove = useCallback((wsId: string) => {
    const dir = removeDirRef.current.get(wsId);
    if (dir) fireRemoveWorktree(wsId, dir);
  }, [fireRemoveWorktree]);

  /** Discard a workstream whose worktree create failed (removes the record). */
  const handleDiscardWorkstream = useCallback(async (wsId: string) => {
    provisionParamsRef.current.delete(wsId);
    setProvisioning((prev) => { const m = new Map(prev); m.delete(wsId); return m; });
    setWorkstreams((prev) => prev.filter((w) => w.id !== wsId));
    await backend.deleteWorkstream(wsId).catch(() => {});
  }, [backend]);


  const doCreateWorkstream = useCallback(async (
    payload: PendingCreate,
    presetSessionId: string | null,
  ): Promise<{ ws: Workstream; tile: Tile; effectiveDirectory: string; pendingProvision: boolean } | null> => {
    const needsWorktree = payload.workstreamType === "worktree";

    // For worktree creation, derive the final directory up front (fast: one
    // local `git rev-parse`, no fetch) so the workstream record can be created
    // immediately in a `creating` state. The slow `git worktree add` then runs
    // non-blocking in the background.
    let effectiveDirectory = payload.directory;
    if (needsWorktree) {
      if (!payload.worktreeBranch) {
        alert("A branch name is required to create a worktree workstream.");
        return null;
      }
      try {
        const derived = await invoke<{ path: string; exists: boolean }>("derive_worktree_path", {
          projectDirectory: payload.directory,
          branchName: payload.worktreeBranch,
        });
        if (derived.exists) {
          alert(`Cannot create worktree: a directory already exists at\n${derived.path}`);
          return null;
        }
        effectiveDirectory = derived.path;
      } catch (e) {
        const msg = typeof e === "string" ? e : (e as Error)?.message || String(e);
        alert(`Failed to prepare worktree: ${msg}`);
        return null;
      }
    }

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
          pullBaseFirst: payload.pullBaseFirst,
          effectiveDirectory,
          initialStatus: needsWorktree ? "creating" : "active",
        },
      );
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error)?.message || String(e);
      alert(`Failed to create workstream: ${msg}`);
      return null;
    }

    const { workstream: ws, pinnedTile: tile } = result;

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

    // Detect git info only when the directory exists already (non-worktree);
    // for a pending worktree the dir doesn't exist yet — it's filled on done.
    if (!needsWorktree) {
      try {
        const { repo, branch } = await backend.detectGitInfo(effectiveDirectory);
        if (repo || branch) {
          await backend.updateWorkstream(ws.id, {});
          ws.git_repo = repo;
          ws.git_branch = branch;
        }
      } catch { /* ignore */ }
    }

    setWorkstreams((prev) => {
      const next = [ws, ...prev];
      invoke("set_setting", {
        key: "workstream_order",
        value: JSON.stringify(next.map((w) => w.id)),
      }).catch(() => {});
      return next;
    });

    if (needsWorktree) {
      // Seed provisioning state and kick off the non-blocking worktree add.
      // Do NOT auto-select or spawn — the row stays in `creating` until the
      // background thread emits a terminal event (handled by the global
      // worktree-progress listener).
      fireCreateWorktree(ws.id, {
        projectDirectory: payload.directory,
        branchName: payload.worktreeBranch!,
        baseBranch: payload.baseBranch ?? null,
        pullBaseFirst: payload.pullBaseFirst ?? false,
      });
      return { ws, tile, effectiveDirectory, pendingProvision: true };
    }

    setActiveWsId(ws.id);
    setTiles([tile]);
    setTileOrder([tile.id]);
    return { ws, tile, effectiveDirectory, pendingProvision: false };
  }, [backend, fireCreateWorktree]);

  // Global listener for id-keyed worktree provisioning progress. Routes each
  // event through the pure reducer to update the per-ws provisioning state,
  // and on a terminal state flips the workstream row's status (creating →
  // active / create_failed; archiving → archived) and persists it.
  useEffect(() => {
    const unlisten = listen<WorktreeProgressEvent>("worktree-progress", (event) => {
      const ev = event.payload;
      if (!ev || !ev.workstreamId) return;
      setProvisioning((prev) => {
        const cur = prev.get(ev.workstreamId)
          ?? (ev.op === "archive" ? initialArchivingState() : initialCreatingState());
        const next = applyWorktreeEvent(cur, ev);
        if (next === cur) return prev;
        const map = new Map(prev);
        map.set(ev.workstreamId, next);
        // On a terminal state, reflect it on the workstream row.
        if (cur.status !== next.status &&
            (next.status === "active" || next.status === "create_failed" || next.status === "archived")) {
          setWorkstreams((wsPrev) => wsPrev.map((w) =>
            w.id === ev.workstreamId ? { ...w, status: next.status } : w));
          backend.updateWorkstream(ev.workstreamId, { status: next.status }).catch(() => {});
        }
        return map;
      });
    });
    return () => { unlisten.then((f) => f()).catch(() => {}); };
  }, [backend]);

  const handleCreateWorkstream = useCallback(async (
    name: string,
    directory: string,
    opts: { projectId?: string; workstreamType: string; worktreeBranch?: string; sessionChoice?: "new" | "existing"; baseBranch?: string; pullBaseFirst?: boolean },
  ) => {
    const payload: PendingCreate = {
      name,
      directory,
      projectId: opts.projectId,
      workstreamType: opts.workstreamType as PendingCreate["workstreamType"],
      worktreeBranch: opts.worktreeBranch,
      baseBranch: opts.baseBranch,
      pullBaseFirst: opts.pullBaseFirst,
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
    // A pending worktree provisions in the background and is not selected; its
    // session spawns when the user opens the ready workstream. Skip immediate spawn.
    if (created.pendingProvision) return;

    // New session — spawn agency.exe and register PID correlation with the poller.
    spawnedPtys.current.add(created.tile.id);
    backend.spawnCopilotSession(created.tile.id, created.effectiveDirectory, null, 30, 120, getAppSettings().copilotCommand).catch(() => {
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

    // Unarchive is immediate, no dialog.
    if (ws.status === "archived") {
      await backend.updateWorkstream(id, { status: "active" });
      setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status: "active" } : w));
      return;
    }

    if (!confirmDiscardDirtyFileBuffers("archive workstream")) return;
    // Detect whether the directory is *actually* a git worktree at runtime
    // (the same check remove_worktree uses). We can't rely on the stored
    // workstream_type string — older/imported/forked workstreams may not
    // have it set to "worktree" even when their directory is a real
    // worktree. Default to false on any detection failure.
    let isWorktree = false;
    if (ws.directory) {
      try {
        const info = await invoke<{ is_worktree: boolean }>("detect_worktree_info", { directory: ws.directory });
        isWorktree = !!info?.is_worktree;
      } catch { /* not a git dir / detection failed → no checkbox */ }
    }
    // Defer to the confirmation dialog (offers worktree deletion).
    setArchiveConfirm({ ws, isWorktree });
  }, [workstreams, backend, confirmDiscardDirtyFileBuffers]);

  const performArchive = useCallback(async (ws: Workstream, deleteWorktree: boolean) => {
    const id = ws.id;
    // Archive: close PTYs for tiles in this workstream
    const wsTiles = tiles.filter((t) => t.workstream_id === id);
    for (const t of wsTiles) {
      spawnedPtys.current.delete(t.id);
      await backend.closeTerminal(t.id).catch(() => {});
    }
    const willRemove = deleteWorktree && !!ws.directory;
    // When deleting the worktree, the row drops into the archived list in an
    // `archiving` sub-state (spinner); the background remove flips it to
    // `archived` (or leaves a non-intrusive warning on failure). Otherwise
    // archive straight to `archived`.
    const archivedStatus = willRemove ? "archiving" : "archived";
    await backend.updateWorkstream(id, { status: "archived" });
    setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status: archivedStatus } : w));
    if (activeWsId === id) {
      const remaining = workstreams.filter((w) => w.id !== id && w.status !== "archived" && w.status !== "archiving");
      setActiveWsId(remaining.length > 0 ? remaining[0].id : null);
      setTiles([]);
      setTileOrder([]);
    }
    // Best-effort, non-blocking worktree removal. remove_worktree runs on a
    // background thread and reports via id-keyed worktree-progress events.
    if (willRemove) {
      fireRemoveWorktree(id, ws.directory!);
    }
  }, [workstreams, activeWsId, tiles, backend, fireRemoveWorktree]);

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

    // Derive the worktree path up front (fast), then create the forked
    // workstream record in a `creating` state and provision in the background.
    if (!sourceWs.directory) return;
    let newDir: string;
    try {
      const derived = await invoke<{ path: string; exists: boolean }>("derive_worktree_path", {
        projectDirectory: sourceWs.directory,
        branchName: opts.branchName,
      });
      if (derived.exists) {
        alert(`Cannot fork: a directory already exists at\n${derived.path}`);
        return;
      }
      newDir = derived.path;
    } catch (e) {
      console.error("Failed to prepare fork worktree:", e);
      return;
    }

    // Create new workstream record (creating) at the derived directory.
    const newWs = await backend.createWorkstream(opts.name, newDir, {
      projectId: sourceWs.project_id || undefined,
      workstreamType: "worktree",
      worktreeBranch: opts.branchName,
    });
    await backend.updateWorkstream(newWs.id, { status: "creating" });
    newWs.status = "creating";

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
    await backend.createTile(newWs.id, "copilot_session", opts.name, config);
    await backend.updateLayout(newWs.id, { tile_order_json: JSON.stringify([(await backend.listTiles(newWs.id))[0]?.id]) });

    // Optionally archive old workstream
    if (opts.archiveOld) {
      for (const t of sourceTiles) {
        spawnedPtys.current.delete(t.id);
        await backend.closeTerminal(t.id).catch(() => {});
      }
      await backend.updateWorkstream(sourceWsId, { status: "archived" });
      setWorkstreams((prev) => prev.map((w) => w.id === sourceWsId ? { ...w, status: "archived" } : w));
    }

    // Insert the forked ws in the sidebar (creating). Do NOT auto-select or
    // spawn — it provisions in the background like a normal worktree create.
    setWorkstreams((prev) => {
      const next = [newWs, ...prev];
      invoke("set_setting", {
        key: "workstream_order",
        value: JSON.stringify(next.map((w) => w.id)),
      }).catch(() => {});
      return next;
    });
    setShowForkWs({ show: false });
    fireCreateWorktree(newWs.id, {
      projectDirectory: sourceWs.directory,
      branchName: opts.branchName,
      baseBranch: opts.baseBranch ?? null,
      pullBaseFirst: false,
    });
  }, [workstreams, backend, fireCreateWorktree]);

  const handleChangeWorktreeSubmit = useCallback(async (
    mode: "switch_existing" | "create_new",
    opts: { directory?: string; branchName?: string; folderName?: string; pullBaseFirst?: boolean },
  ) => {
    if (!changeWorktreeTarget) return;

    const willCreate = mode === "create_new";
    if (willCreate) {
      setWorktreeOverlay({ title: `Creating worktree for "${opts.branchName ?? ""}"…` });
    }
    let workstream;
    try {
      ({ workstream } = await backend.changeWorkstreamWorktree(changeWorktreeTarget.id, mode, opts));
    } finally {
      if (willCreate) setWorktreeOverlay(null);
    }
    const updatedTiles = await backend.listTiles(workstream.id);
    const updatedTilesById = new Map(updatedTiles.map((tile) => [tile.id, tile]));

    setWsStates((prev) => {
      const current = prev.get(workstream.id);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(workstream.id, {
        ...current,
        tiles: current.tiles.map((tile) => updatedTilesById.get(tile.id) ?? tile),
      });
      return next;
    });

    // Intentionally do NOT restart any tiles here. The Rust command has
    // already rewritten each restartable tile's config_json.cwd, so the new
    // directory will take effect on the next manual restart / app relaunch.
    // Restarting on worktree-switch was killing scrollback for no benefit
    // (cd inside the running session must be done by the user / agent).

    const latestWorkstreams = await backend.listWorkstreams();
    setWorkstreams((prev) => {
      const latestById = new Map(latestWorkstreams.map((ws) => [ws.id, ws]));
      latestById.set(workstream.id, workstream);
      const ordered = prev
        .map((ws) => latestById.get(ws.id))
        .filter((ws): ws is Workstream => Boolean(ws));
      for (const ws of latestWorkstreams) {
        if (!ordered.some((existing) => existing.id === ws.id)) ordered.push(ws);
      }
      return ordered;
    });

    setChangeWorktreeTarget(null);
    console.info(`Changed worktree for ${workstream.name} (tiles left running; new dir applies on next restart).`);
  }, [backend, changeWorktreeTarget]);

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
      plan: "Plan",
      diff_review: "Review",
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

    upsertTileLocally(tile);
    // Persist new layout order (tileOrder closure is the active state at call time).
    backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify([...tileOrder, tile.id]) });

    // Spawn PTY for terminal and copilot_session tiles
    if (tileType === "terminal") {
      spawnedPtys.current.add(tile.id);
      const shellCmd = extraConfig?.shell === "wsl" ? "wsl.exe" : (command !== "pwsh.exe" ? command : undefined);
      await backend.spawnTerminal(tile.id, cwd, shellCmd, undefined, 30, 120);
    } else if (tileType === "copilot_session") {
      spawnedPtys.current.add(tile.id);
      // Spawn agency.exe directly — new session, no resume
      await backend.spawnCopilotSession(tile.id, cwd, null, 30, 120, getAppSettings().copilotCommand);
    }

    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tiles, tileOrder, backend, upsertTileLocally, setFocusedIndex]);

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
      // If the closed tile was part of side-by-side or pending selection,
      // collapse back to the adaptive grid.
      updateActiveState((s) => {
        const inSelection = s.selectedForSideBySide.has(tileId);
        const inSbs = s.sideBySideTileIds?.includes(tileId) ?? false;
        if (!inSelection && !inSbs) return s;
        const nextSel = new Set(s.selectedForSideBySide);
        nextSel.delete(tileId);
        return {
          ...s,
          selectedForSideBySide: nextSel,
          sideBySideTileIds: inSbs ? null : s.sideBySideTileIds,
        };
      });
    },
    [activeWsId, fullscreenTileId, backend, tiles, updateActiveState]
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
    await backend.spawnCopilotSession(tile.id, cwd, session.session_id, 30, 120, getAppSettings().copilotCommand);
    setFocusedIndex(tileOrder.length);
  }, [activeWsId, workstreams, tileOrder.length, backend]);

  // Debug bridge for CDP visual probes (Phase 4 of ADR 007). Exposes a
  // minimal helper that seeds a diff review + tile end-to-end so the visual
  // probe can render the Diff Review tile without driving the skill terminal.
  // Only enabled when window flag is set by the test harness.
  useEffect(() => {
    const w = window as unknown as {
      __wsSeedDiffReviewTile?: (input?: { workstreamId?: string }) => Promise<{ reviewId: string; tileId: string }>;
      __wsCloseDiffReviewTile?: (tileId: string) => Promise<void>;
    };
    w.__wsSeedDiffReviewTile = async (input) => {
      const wsId = input?.workstreamId ?? activeWsId;
      if (!wsId) throw new Error("no active workstream");
      const review = await backend.createDiffReview(wsId, "working_tree", null);
      await backend.setReviewPlan(review.id, JSON.stringify({ source: "cdp-seed" }), [
        {
          title: "Add retry budget to JWT verification",
          summary: "Wraps verifyJwt() in a 3-attempt retry with exponential backoff.",
          is_trivial: false,
          question_text: "Why is the retry budget hardcoded to 3?",
          question_style: "socratic",
          hunks: [
            {
              file_path: "src/auth/jwt.ts",
              old_start: 10,
              old_lines: 4,
              new_start: 10,
              new_lines: 12,
              patch_text:
                "@@ -10,4 +10,12 @@\n-  return verifyJwt(token);\n+  for (let i = 0; i < 3; i++) {\n+    try { return verifyJwt(token); }\n+    catch (e) { if (i === 2) throw e; await sleep(2 ** i * 100); }\n+  }\n",
            },
          ],
        },
        {
          title: "Bump @types/node to 20.11.0",
          summary: null,
          is_trivial: true,
          question_text: null,
          question_style: null,
          hunks: [
            {
              file_path: "package.json",
              old_start: 22,
              old_lines: 1,
              new_start: 22,
              new_lines: 1,
              patch_text: '@@ -22,1 +22,1 @@\n-    "@types/node": "20.10.0",\n+    "@types/node": "20.11.0",\n',
            },
          ],
        },
      ]);
      const config = JSON.stringify({ reviewId: review.id });
      const tile = await backend.createTile(wsId, "diff_review", "CDP Review", config);
      upsertTileLocally(tile);
      // Persist order only if newly appended.
      setWsStates((prev) => {
        const state = prev.get(wsId);
        if (state) {
          backend.updateLayout(wsId, { tile_order_json: JSON.stringify(state.tileOrder) });
        }
        return prev;
      });
      const chunks = await backend.listChunks(review.id);
      if (chunks[0]) await backend.activateChunk(review.id, chunks[0].id);
      return { reviewId: review.id, tileId: tile.id };
    };
    w.__wsCloseDiffReviewTile = async (tileId) => {
      await closeTile(tileId);
    };
    return () => { delete w.__wsSeedDiffReviewTile; delete w.__wsCloseDiffReviewTile; };
  }, [activeWsId, backend, closeTile, upsertTileLocally]);

  // Diff Review tile-open handler (path B + skill auto-open fallback).
  // 0 active reviews → inline hint banner (auto-clears).
  // 1 active review → open/focus it via idempotent backend command.
  // >1 active reviews → show picker modal so user disambiguates.
  const addTileDiffReview = useCallback(async () => {
    if (!activeWsId) return;
    let reviews: DiffReview[];
    try {
      reviews = await backend.listActiveDiffReviews(activeWsId);
    } catch {
      reviews = [];
    }
    if (reviews.length === 0) {
      setNoActiveReviewHint(true);
      window.setTimeout(() => setNoActiveReviewHint(false), 6000);
      return;
    }
    if (reviews.length === 1) {
      const tile = await backend.createOrFocusDiffReviewTile(activeWsId, reviews[0].id);
      const existing = wsStates.get(activeWsId);
      const wasAlreadyThere = !!existing?.tileOrder.includes(tile.id);
      upsertTileLocally(tile);
      if (!wasAlreadyThere) {
        const newOrder = [...(existing?.tileOrder ?? []), tile.id];
        backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify(newOrder) });
        setFocusedIndex(newOrder.length - 1);
      } else {
        setFocusedIndex(existing!.tileOrder.indexOf(tile.id));
      }
      return;
    }
    setDiffReviewPickerReviews(reviews);
    setShowDiffReviewPicker(true);
  }, [activeWsId, backend, upsertTileLocally, wsStates, setFocusedIndex]);

  // Listen for tile-created events emitted by the Rust backend (e.g. when
  // `create_or_focus_diff_review_tile` or `create_tile` is invoked from the
  // skill or any other source). Idempotent via upsertTileLocally.
  useEffect(() => {
    const unsubPromise = listen<Tile>("tile-created", (event) => {
      upsertTileLocally(event.payload);
    });
    return () => {
      unsubPromise.then((u) => u()).catch(() => { /* ignore */ });
    };
  }, [upsertTileLocally]);


  const changeWorktreeTiles = useMemo(() => {
    if (!changeWorktreeTarget) return [];
    return wsStates.get(changeWorktreeTarget.id)?.tiles ?? [];
  }, [changeWorktreeTarget, wsStates]);

  // Per-workstream linked-session ids. Every mounted workstream's tiles
  // need their *own* list — passing the active workstream's list to all
  // mounted grids makes hidden SessionMetaTiles reset their browse state
  // (keyed on the linked-session list) whenever the user switches
  // workstreams, surfacing as an empty session-state folder on return.
  const linkedSessionIdsByWs = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [wsId, st] of wsStates.entries()) {
      map.set(wsId, deriveLinkedSessionIds(st.tiles));
    }
    return map;
  }, [wsStates]);

  // Workstreams that have been "loaded" (have an entry in wsStates so tiles
  // are mounted + listeners are active). Workstreams the user hasn't opened
  // yet this session show a "stopped" indicator in the sidebar.
  const loadedWsIds = useMemo(() => new Set(wsStates.keys()), [wsStates]);

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
          } else if (action.tileType === "diff_review") {
            addTileDiffReview();
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
          }
          break;
        case "toggleSideBySide":
          e.preventDefault();
          toggleSideBySide();
          break;
        case "focusTile":
          if (action.index < count) setFocusedIndex(action.index);
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tiles, tileOrder, focusedIndex, fullscreenTileId, activeWsId, addTile, closeTile, backend, toggleSideBySide]);

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
        loadedWsIds={loadedWsIds}
        onSelectWorkstream={selectWorkstream}
        provisioning={provisioning}
        onRetryCreate={handleRetryCreate}
        onRetryRemove={handleRetryRemove}
        onDiscardWorkstream={handleDiscardWorkstream}
        onCreateProject={() => setShowRepoCreate(true)}
        onImportProject={() => setShowProjectCreate(true)}
        onCreateWorkstream={(projectId) => setShowWsCreate({ show: true, projectId })}
        onArchiveWorkstream={handleArchiveWorkstream}
        onRenameWorkstream={handleRenameWorkstream}
        onUpdateProject={handleUpdateProject}
        onReorderWorkstreams={(orderedIds) => {
          setWorkstreams((prev) => {
            const byId = new Map(prev.map((w) => [w.id, w]));
            const reordered: typeof prev = [];
            for (const id of orderedIds) {
              const w = byId.get(id);
              if (w) { reordered.push(w); byId.delete(id); }
            }
            // Append any workstreams missing from the order (archived rows
            // or anything the sidebar didn't enumerate).
            for (const w of prev) if (byId.has(w.id)) reordered.push(w);
            invoke("set_setting", { key: "workstream_order", value: JSON.stringify(reordered.map((w) => w.id)) }).catch(() => {});
            return reordered;
          });
        }}
        onChangeStatus={async (id, status) => {
          await backend.updateWorkstream(id, { status });
          setWorkstreams((prev) => prev.map((w) => w.id === id ? { ...w, status } : w));
        }}
        onForkWorkstream={(id) => setShowForkWs({ show: true, wsId: id })}
        onChangeWorktree={(ws) => setChangeWorktreeTarget(ws)}
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
                  sideBySideTileIds={st.sideBySideTileIds}
                  selectedForSideBySide={st.selectedForSideBySide}
                  sbsSelectionMode={st.sbsSelectionMode}
                  isVisible={isActive}
                  onToggleSideBySideSelect={isActive ? toggleSideBySideSelect : () => {}}
                  onToggleFullscreen={isActive ? toggleFullscreenForTile : undefined}
                  onShiftSelectTile={isActive ? shiftSelectTile : undefined}
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
                    const tile = st.tiles.find((t) => t.id === tileId);
                    if (!tile) return;
                    const cfg = JSON.parse(tile.config_json || "{}");
                    const cwd = cfg.cwd || workstreams.find((w) => w.id === wsId)?.directory || "C:\\";
                    // Mark "we initiated this" so the PTY-exit handler in
                    // the tile writes [Restarting…] instead of [Session ended].
                    intentionalRestartIds.current.add(tileId);
                    await backend.closeTerminal(tileId).catch(() => {});
                    spawnedPtys.current.add(tileId);
                    try {
                      if (tile.tile_type === "copilot_session") {
                        const sessionId = cfg.copilot_session_id || cfg.resume_by_id || null;
                        await backend.spawnCopilotSession(tileId, cwd, sessionId, 30, 120, getAppSettings().copilotCommand);
                      } else if (tile.tile_type === "terminal") {
                        await backend.spawnTerminal(tileId, cwd, cfg.command || undefined, undefined, 30, 120);
                      }
                    } catch {
                      spawnedPtys.current.delete(tileId);
                      intentionalRestartIds.current.delete(tileId);
                    }
                  } : undefined}
                  onUpdateTileConfig={isActive ? async (tileId, configJson) => {
                    await backend.updateTileConfig(tileId, configJson);
                    setTiles((prev) => prev.map((t) =>
                      t.id === tileId ? { ...t, config_json: configJson } : t
                    ));
                  } : undefined}
                  spawnedPtyIds={spawnedPtys.current}
                  linkedSessionIds={linkedSessionIdsByWs.get(wsId) ?? []}
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
          sideBySide={sideBySideTileIds !== null}
          canEnterSideBySide={selectedForSideBySide.size === 2}
          sbsSelectionMode={sbsSelectionMode}
          workstreamName={
            workstreams.find((w) => w.id === activeWsId)?.name || ""
          }
          onAddSession={() => setShowSessionPicker(true)}
          onAddTerminal={() => addTile("terminal")}
          onAddWslTerminal={() => addTile("terminal", { shell: "wsl" })}
          onAddExplorer={() => addTile("file_explorer")}
          onAddSessionMeta={() => addTile("session_meta")}
          onAddWorkbench={() => addTile("workbench")}
          onAddPlan={() => addTile("plan")}
          onAddDiffReview={() => addTileDiffReview()}
          onOpenSettings={() => setShowSettings(true)}
          onToggleFullscreen={() => {
            if (orderedTiles.length > 0 && orderedTiles[focusedIndex]) {
              const tid = orderedTiles[focusedIndex]!.id;
              setFullscreenTileId((prev) => (prev === tid ? null : tid));
            }
          }}
          onToggleSideBySide={toggleSideBySide}
        />
      </div>

      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      <ConfirmCloseDialog
        open={confirmCloseOpen}
        onConfirm={handleConfirmClose}
        onCancel={handleCancelClose}
      />

      {showDiffReviewPicker && (
        <DiffReviewPickerModal
          reviews={diffReviewPickerReviews}
          onPick={async (reviewId) => {
            setShowDiffReviewPicker(false);
            if (!activeWsId) return;
            const tile = await backend.createOrFocusDiffReviewTile(activeWsId, reviewId);
            const existing = wsStates.get(activeWsId);
            const wasAlreadyThere = !!existing?.tileOrder.includes(tile.id);
            upsertTileLocally(tile);
            if (!wasAlreadyThere) {
              const newOrder = [...(existing?.tileOrder ?? []), tile.id];
              backend.updateLayout(activeWsId, { tile_order_json: JSON.stringify(newOrder) });
              setFocusedIndex(newOrder.length - 1);
            } else {
              setFocusedIndex(existing!.tileOrder.indexOf(tile.id));
            }
          }}
          onClose={() => setShowDiffReviewPicker(false)}
        />
      )}

      {noActiveReviewHint && (
        <div
          data-testid="no-active-review-hint"
          role="status"
          style={{
            position: "fixed",
            bottom: 40,
            right: 20,
            zIndex: 1000,
            background: "#1e293b",
            color: "#e2e8f0",
            padding: "10px 14px",
            borderRadius: 6,
            fontSize: 13,
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            maxWidth: 340,
          }}
        >
          No active diff reviews. Run the <code>diff-grok</code> skill in a Copilot session to start one.
        </div>
      )}

      {/* Session picker modal */}
      {showSessionPicker && (
        <SessionPicker
          activeWorkstreamDir={workstreams.find((w) => w.id === activeWsId)?.directory ?? undefined}
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
              // Pending worktrees provision in the background; defer spawn.
              if (created.pendingProvision) return;
              spawnedPtys.current.add(created.tile.id);
              backend
                .spawnCopilotSession(created.tile.id, created.effectiveDirectory, session.session_id, 30, 120, getAppSettings().copilotCommand)
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
                  backend.spawnCopilotSession(linkingTileId, cwd, session.session_id, 30, 120, getAppSettings().copilotCommand).catch(() => {
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
                if (created.pendingProvision) return;
                spawnedPtys.current.add(created.tile.id);
                backend
                  .spawnCopilotSession(created.tile.id, created.effectiveDirectory, null, 30, 120, getAppSettings().copilotCommand)
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

      {/* Repo create-new modal */}
      {showRepoCreate && (
        <RepoCreateForm
          onCreated={async (name, directory, color, gitRemote) => {
            await handleCreateProject(name, directory, color, gitRemote);
            setShowRepoCreate(false);
          }}
          onCancel={() => setShowRepoCreate(false)}
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

      {/* Change worktree modal */}
      {changeWorktreeTarget && (
        <ChangeWorktreeForm
          workstream={changeWorktreeTarget}
          tiles={changeWorktreeTiles}
          onSubmit={handleChangeWorktreeSubmit}
          onCancel={() => setChangeWorktreeTarget(null)}
        />
      )}

      {/* Blocking overlay while a worktree is being created (pull + add). */}
      <WorktreeCreationOverlay
        open={worktreeOverlay !== null}
        title={worktreeOverlay?.title ?? ""}
      />

      {/* Archive confirmation (offers worktree deletion). */}
      {archiveConfirm && (
        <ArchiveWorkstreamDialog
          workstreamName={archiveConfirm.ws.name}
          isWorktree={archiveConfirm.isWorktree}
          onCancel={() => setArchiveConfirm(null)}
          onConfirm={(deleteWorktree) => {
            const target = archiveConfirm.ws;
            setArchiveConfirm(null);
            void performArchive(target, deleteWorktree);
          }}
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

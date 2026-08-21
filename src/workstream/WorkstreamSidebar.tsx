// @test-skip: sidebar UI shell, behavior covered by backend tests
import { useState, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Project, Workstream } from "../domain/types";
import { bucketWorkstreams, isSectionCollapsed } from "../domain/workstream-sections";
import { RepoManagerModal } from "./RepoManagerModal";
import type { ProvisioningState } from "../domain/worktree-provisioning";
import {
  BellAlertIcon,
  EllipsisHorizontalIcon,
  MoonIcon,
  PlusIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  ClipboardDocumentListIcon,
} from "@heroicons/react/20/solid";
import { reorderById } from "../domain/reorder";
import { getAppSettings } from "../domain/app-settings";
import { WorkstreamActionMenu } from "./WorkstreamActionMenu";

interface Props {
  projects: Project[];
  workstreams: Workstream[];
  activeWsId: string | null;
  /** Optional: map of wsId → linked-session summary (from pinned tile config). */
  sessionInfoByWs?: Record<string, string | undefined>;
  /** Optional: set of workstream ids that have been loaded into the app's
   * `wsStates` map (i.e. tiles + activity wired up). Workstreams not in this
   * set render a "stopped" indicator (gray hollow square). */
  loadedWsIds?: Set<string>;
  onSelectWorkstream: (id: string) => void;
  /** Opens the global task board. Optional so the sidebar stays renderable
   * without a backend (the board is owned by App, which has one). */
  onOpenTaskBoard?: () => void;
  /** Create a task named after this workstream and open it on the board. */
  onCreateTaskForWorkstream?: (workstreamId: string) => void;
  /** Open the task bound to this workstream. */
  onGoToTaskForWorkstream?: (workstreamId: string) => void;
  /**
   * Workstream ids that already have a task. The relation is 1:1, so these
   * rows offer "Go to task" instead of "Create task…".
   */
  workstreamsWithTasks?: Set<string>;
  onCreateProject: () => void;
  onImportProject: () => void;
  onCreateWorkstream: (projectId?: string) => void;
  onArchiveWorkstream: (id: string) => void;
  /** Stop a loaded workstream's tiles/processes without archiving it. */
  onCloseWorkstream?: (id: string) => void;
  onRenameWorkstream: (id: string, newName: string) => void;
  onUpdateProject: (id: string, updates: { name: string; color: string; copilot_command: string | null }) => void;
  /**
   * Called after a drag-and-drop reorder with the FULL new order of active
   * workstream ids. The caller persists this (and any archived rows can be
   * left untouched).
   */
  onReorderWorkstreams: (orderedIds: string[]) => void;
  onChangeStatus: (id: string, status: Workstream['status']) => void;
  onForkWorkstream?: (id: string) => void;
  onChangeWorktree?: (ws: Workstream) => void;
  /** Per-workstream worktree provisioning state (create/archive progress). */
  provisioning?: Map<string, ProvisioningState>;
  /** Retry a failed worktree create. */
  onRetryCreate?: (id: string) => void;
  /** Retry a failed worktree removal (archive housekeeping). */
  onRetryRemove?: (id: string) => void;
  /** Discard a workstream whose worktree create failed (removes it). */
  onDiscardWorkstream?: (id: string) => void;
}

// Activity slot in the sidebar row. Replaces the previous status icon +
// inline activity dot. Four states:
//   - bell:    agent finished while the workstream was unfocused
//   - working: any Copilot session in the workstream is non-idle
//   - stopped: workstream hasn't been loaded yet (gray hollow square)
//   - idle:    nothing rendered (preserves spacing via a fixed-width slot)
const ACTIVE_ACTIVITIES = new Set(["thinking", "tool_use", "responding", "background_task"]);

// Shared style for the sidebar's "+" affordances (Workstreams / Repos
// section headers). Larger hit area + hover background so the action is
// obvious without crowding the header.
const addButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  background: "transparent",
  border: "none",
  color: "#a6adc8",
  cursor: "pointer",
  borderRadius: 4,
  padding: 0,
  transition: "background 0.1s, color 0.1s",
};

function ActivityIndicator({ bell, active, stopped }: { bell: boolean; active: boolean; stopped: boolean }) {
  // Fixed 14×14 slot so rows don't reflow as state changes.
  const slot: React.CSSProperties = { width: 14, height: 14, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };
  if (bell) {
    return (
      <span style={slot} title="Agent finished" data-testid="ws-indicator-bell">
        <BellAlertIcon style={{ width: 14, height: 14, color: "#f9e2af", animation: "pulse-dot 1s ease-in-out 3" }} />
      </span>
    );
  }
  if (active) {
    return (
      <span style={slot} title="Working" data-testid="ws-indicator-working">
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "#89b4fa",
            animation: "pulse-dot 1.5s ease-in-out infinite",
            boxShadow: "0 0 6px #89b4fa",
          }}
        />
      </span>
    );
  }
  if (stopped) {
    return (
      <span style={slot} title="Stopped (not loaded)" data-testid="ws-indicator-stopped">
        <MoonIcon style={{ width: 12, height: 12, color: "#6c7086" }} />
      </span>
    );
  }
  return <span style={slot} data-testid="ws-indicator-idle" />;
}

export default function WorkstreamSidebar({
  projects,
  workstreams,
  activeWsId,
  sessionInfoByWs,
  loadedWsIds,
  onSelectWorkstream,
  onOpenTaskBoard,
  onCreateTaskForWorkstream,
  onGoToTaskForWorkstream,
  workstreamsWithTasks,
  onCreateProject,
  onImportProject,
  onCreateWorkstream,
  onArchiveWorkstream,
  onCloseWorkstream,
  onRenameWorkstream,
  onUpdateProject,
  onReorderWorkstreams,
  onChangeStatus,
  onForkWorkstream,
  onChangeWorktree,
  provisioning,
  onRetryCreate,
  onRetryRemove,
  onDiscardWorkstream,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [actionMenuWsId, setActionMenuWsId] = useState<string | null>(null);
  const [actionMenuAnchor, setActionMenuAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [hoveredWsId, setHoveredWsId] = useState<string | null>(null);
  const [draggedWsId, setDraggedWsId] = useState<string | null>(null);
  const [dragOverWsId, setDragOverWsId] = useState<string | null>(null);
  const [workstreamsCollapsed, setWorkstreamsCollapsed] = useState(false);
  // Idle starts collapsed: it is the pile you keep but are not working on, and
  // leaving it open reproduces exactly the crowding this split exists to fix.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean | undefined>>(
    () => {
      try {
        const raw = localStorage.getItem("ws-sidebar-collapsed-sections");
        if (raw) return JSON.parse(raw) as Record<string, boolean>;
      } catch { /* fall through to defaults */ }
      return {};
    },
  );
  const toggleSection = (key: "live" | "idle") => {
    setCollapsedSections((prev) => {
      // Toggle relative to what is CURRENTLY shown, so the first click always
      // does the visible thing even when the value is still defaulted.
      const next = {
        ...prev,
        [key]: !isSectionCollapsed(key, prev, liveCountRef.current),
      };
      try {
        localStorage.setItem("ws-sidebar-collapsed-sections", JSON.stringify(next));
      } catch { /* persistence is best-effort */ }
      return next;
    });
  };
  const [showRepoManager, setShowRepoManager] = useState(false);
  const liveCountRef = useRef(0);

  // Live activity status per workstream (from session poller)
  const [wsActivity, setWsActivity] = useState<Record<string, string>>({});
  const prevActivityRef = useRef<Record<string, string>>({});
  // Workstreams with pending bell notification (agent finished)
  const [wsBell, setWsBell] = useState<Set<string>>(new Set());

  // Clear bell when workstream is focused
  useEffect(() => {
    if (activeWsId && wsBell.has(activeWsId)) {
      setWsBell((prev) => {
        const next = new Set(prev);
        next.delete(activeWsId);
        return next;
      });
    }
  }, [activeWsId]);

  // Direct BEL signal from Copilot session tiles: a window-level
  // CustomEvent("workstream-bell", { detail: { workstreamId } }) raises the
  // sidebar bell on the matching row when that workstream isn't focused.
  // The activity-poller path below ALSO raises the bell (on active→idle), so
  // the two triggers coexist: BEL fires immediately when the agent emits \a;
  // active→idle fires when it finishes a turn without BEL.
  const activeWsIdRef = useRef(activeWsId);
  useEffect(() => { activeWsIdRef.current = activeWsId; }, [activeWsId]);
  useEffect(() => {
    const onBell = (e: Event) => {
      const detail = (e as CustomEvent).detail as { workstreamId?: string } | undefined;
      const wsId = detail?.workstreamId;
      if (!wsId) return;
      if (wsId === activeWsIdRef.current) return;
      setWsBell((prev) => {
        if (prev.has(wsId)) return prev;
        const next = new Set(prev);
        next.add(wsId);
        return next;
      });
    };
    window.addEventListener("workstream-bell", onBell);
    return () => window.removeEventListener("workstream-bell", onBell);
  }, []);

  // Listen for workstream activity events
  useEffect(() => {
    const unlistens: Promise<() => void>[] = [];
    for (const ws of workstreams) {
      unlistens.push(
        listen<string>(`workstream-activity-${ws.id}`, (event) => {
          const newStatus = event.payload;
          const prevStatus = prevActivityRef.current[ws.id];
          setWsActivity((prev) => ({ ...prev, [ws.id]: newStatus }));
          prevActivityRef.current[ws.id] = newStatus;

          // Detect active→idle transition: show bell if not focused
          const wasActive = prevStatus && ["thinking", "tool_use", "responding"].includes(prevStatus);
          const nowIdle = newStatus === "idle";
          if (wasActive && nowIdle && ws.id !== activeWsId) {
            setWsBell((prev) => new Set(prev).add(ws.id));
          }
        })
      );
    }
    return () => {
      unlistens.forEach((u) => u.then((fn) => fn()));
    };
  }, [workstreams.map((w) => w.id).join(","), activeWsId]);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingWsId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingWsId]);

  // Drag-and-drop reorder helpers.
  const handleDragStart = (e: React.DragEvent, wsId: string) => {
    setDraggedWsId(wsId);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", wsId); } catch { /* ignore */ }
  };
  const handleDragOver = (e: React.DragEvent, targetWsId: string) => {
    if (!draggedWsId || draggedWsId === targetWsId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverWsId !== targetWsId) setDragOverWsId(targetWsId);
  };
  const handleDragLeave = (_e: React.DragEvent, targetWsId: string) => {
    if (dragOverWsId === targetWsId) setDragOverWsId(null);
  };
  const handleDrop = (e: React.DragEvent, targetWsId: string) => {
    e.preventDefault();
    if (!draggedWsId || draggedWsId === targetWsId) {
      setDraggedWsId(null); setDragOverWsId(null); return;
    }
    const next = reorderById(activeWorkstreams, draggedWsId, targetWsId);
    if (next !== activeWorkstreams) {
      onReorderWorkstreams(next.map((w) => w.id));
    }
    setDraggedWsId(null);
    setDragOverWsId(null);
  };
  const handleDragEnd = () => { setDraggedWsId(null); setDragOverWsId(null); };

  // `archiving` rows belong in the archived section (the workstream is
  // logically archived; only its worktree dir is still being cleaned up).
  const activeWorkstreams = workstreams.filter((ws) => ws.status !== "archived" && ws.status !== "archiving");
  const archivedWorkstreams = workstreams.filter((ws) => ws.status === "archived" || ws.status === "archiving");
  // Live vs Idle is a RUNTIME split (are its tiles/processes loaded?), not a
  // persisted status — see domain/workstream-sections.ts.
  const { live: liveWorkstreams, idle: idleWorkstreams } = bucketWorkstreams(
    activeWorkstreams,
    loadedWsIds,
  );
  // Repos with no active workstreams — a triage signal the old 240px list
  // could never show.
  const dormantRepoCount = projects.filter(
    (p) => !activeWorkstreams.some((ws) => ws.project_id === p.id),
  ).length;
  liveCountRef.current = liveWorkstreams.length;
  const sections = [
    { key: "live" as const, label: "Live", rows: liveWorkstreams, collapsed: isSectionCollapsed("live", collapsedSections, liveWorkstreams.length) },
    { key: "idle" as const, label: "Idle", rows: idleWorkstreams, collapsed: isSectionCollapsed("idle", collapsedSections, liveWorkstreams.length) },
  ];

  const getProject = (projectId: string | null) =>
    projectId ? projects.find((p) => p.id === projectId) : undefined;

  // One row implementation shared by the Live and Idle sections. Hoisted out
  // of the old single `.map()` so splitting the list by status cannot make the
  // two sections drift apart.
  const renderWorkstreamRow = (ws: Workstream) => {
          const isActive = ws.id === activeWsId;
          const project = getProject(ws.project_id);
          const isDragOver = dragOverWsId === ws.id;
          const isBeingDragged = draggedWsId === ws.id;
          return (
            <div
              key={ws.id}
              data-testid="workstream-item"
              data-workstream-id={ws.id}
              data-active={isActive ? "true" : "false"}
              draggable={renamingWsId !== ws.id}
              onDragStart={(e) => handleDragStart(e, ws.id)}
              onDragOver={(e) => handleDragOver(e, ws.id)}
              onDragLeave={(e) => handleDragLeave(e, ws.id)}
              onDrop={(e) => handleDrop(e, ws.id)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelectWorkstream(ws.id)}
              onMouseEnter={() => setHoveredWsId(ws.id)}
              onMouseLeave={() => setHoveredWsId((h) => (h === ws.id ? null : h))}
              style={{
                padding: "6px 8px",
                marginBottom: 1,
                borderRadius: 4,
                cursor: isBeingDragged ? "grabbing" : "pointer",
                opacity: isBeingDragged ? 0.4 : 1,
                background: isActive ? "#313244" : "transparent",
                borderTop: isDragOver ? "2px solid #89b4fa" : isActive ? "1px solid #45475a" : "1px solid transparent",
                borderRight: isActive ? "1px solid #45475a" : "1px solid transparent",
                borderBottom: isActive ? "1px solid #45475a" : "1px solid transparent",
                borderLeft: isActive
                  ? `3px solid ${project ? project.color : "#89b4fa"}`
                  : project
                    ? `3px solid ${project.color}`
                    : "3px solid transparent",
                boxShadow: isActive ? "0 1px 0 rgba(137, 180, 250, 0.18) inset" : "none",
                transition: "background 0.1s, border-color 0.1s",
                position: "relative",
              }}
            >
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 4,
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  overflow: "hidden",
                  fontSize: 12,
                  color: isActive ? "#f5e0dc" : "#a6adc8",
                  fontWeight: isActive ? 600 : 400,
                  flex: 1,
                  minWidth: 0,
                }}>
                  <ActivityIndicator
                    bell={wsBell.has(ws.id)}
                    active={ACTIVE_ACTIVITIES.has(wsActivity[ws.id] ?? "")}
                    stopped={!!loadedWsIds && !loadedWsIds.has(ws.id)}
                  />
                  {renamingWsId === ws.id ? (
                    <input
                      ref={renameInputRef}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          if (renameValue.trim()) onRenameWorkstream(ws.id, renameValue.trim());
                          setRenamingWsId(null);
                        }
                        if (e.key === "Escape") setRenamingWsId(null);
                      }}
                      onBlur={() => setRenamingWsId(null)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        background: "#313244",
                        border: "1px solid #45475a",
                        borderRadius: 3,
                        color: "#cdd6f4",
                        padding: "1px 4px",
                        fontSize: 12,
                        fontFamily: "inherit",
                        outline: "none",
                        width: "100%",
                        minWidth: 0,
                      }}
                    />
                  ) : (
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ws.name}
                    </span>
                  )}
                </div>
                {renamingWsId !== ws.id && (
                  <button
                    type="button"
                    aria-label="Workstream actions"
                    data-testid={`ws-actions-${ws.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                      setActionMenuAnchor({ top: rect.bottom + 4, left: Math.max(8, rect.right - 220) });
                      setActionMenuWsId(actionMenuWsId === ws.id ? null : ws.id);
                    }}
                    style={{
                      ...sidebarBtnStyle,
                      // Reveal on hover, when this row is active, or while its
                      // menu is open — so any workstream's actions (archive,
                      // rename, …) are reachable without opening it first.
                      visibility:
                        isActive || hoveredWsId === ws.id || actionMenuWsId === ws.id
                          ? "visible"
                          : "hidden",
                    }}
                    title="Actions"
                  >
                    <EllipsisHorizontalIcon style={{ width: 14, height: 14 }} />
                  </button>
                )}
              </div>

              {/* Worktree provisioning indicator (create) */}
              {ws.status === "creating" && (
                <div
                  data-testid={`ws-provisioning-${ws.id}`}
                  style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, fontSize: 10, color: "#89b4fa" }}
                >
                  <span style={{ display: "inline-block", animation: "ws-spin 0.9s linear infinite" }}>◍</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {provisioning?.get(ws.id)?.phase ?? "Provisioning worktree…"}
                  </span>
                </div>
              )}
              {ws.status === "create_failed" && (
                <div data-testid={`ws-create-failed-${ws.id}`} style={{ marginTop: 3 }}>
                  <div style={{ fontSize: 10, color: "#f38ba8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={provisioning?.get(ws.id)?.error ?? "Worktree creation failed"}>
                    ⚠ {provisioning?.get(ws.id)?.error ?? "Worktree creation failed"}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                    <button
                      data-testid={`ws-retry-create-${ws.id}`}
                      onClick={(e) => { e.stopPropagation(); onRetryCreate?.(ws.id); }}
                      style={{ background: "#313244", color: "#a6e3a1", border: "none", borderRadius: 3, padding: "1px 8px", cursor: "pointer", fontSize: 10 }}
                    >
                      Retry
                    </button>
                    <button
                      data-testid={`ws-discard-create-${ws.id}`}
                      onClick={(e) => { e.stopPropagation(); onDiscardWorkstream?.(ws.id); }}
                      style={{ background: "#313244", color: "#f38ba8", border: "none", borderRadius: 3, padding: "1px 8px", cursor: "pointer", fontSize: 10 }}
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}

              {/* Action menu */}
              {actionMenuWsId === ws.id && (
                <WorkstreamActionMenu
                  workstream={ws}
                  anchor={actionMenuAnchor}
                  onClose={() => setActionMenuWsId(null)}
                  onRename={() => { setRenameValue(ws.name); setRenamingWsId(ws.id); }}
                  onChangeStatus={(status) => onChangeStatus(ws.id, status)}
                  onChangeWorktree={onChangeWorktree ? () => onChangeWorktree(ws) : undefined}
                  onFork={onForkWorkstream ? () => onForkWorkstream(ws.id) : undefined}
                  onArchive={() => onArchiveWorkstream(ws.id)}
                  onCreateTask={
                    onCreateTaskForWorkstream && !workstreamsWithTasks?.has(ws.id)
                      ? () => onCreateTaskForWorkstream(ws.id)
                      : undefined
                  }
                  onGoToTask={
                    onGoToTaskForWorkstream && workstreamsWithTasks?.has(ws.id)
                      ? () => onGoToTaskForWorkstream(ws.id)
                      : undefined
                  }
                  onCloseWorkstream={onCloseWorkstream ? () => onCloseWorkstream(ws.id) : undefined}
                  isLoaded={!!loadedWsIds && loadedWsIds.has(ws.id)}
                />
              )}

              {/* Project badge */}
              {project && (
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  marginTop: 2,
                  marginLeft: 15,
                  fontSize: 10,
                  color: "#585b70",
                }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {project.name}
                  </span>
                </div>
              )}
              {!project && ws.directory && (
                <div style={{
                  fontSize: 10,
                  color: "#45475a",
                  marginTop: 2,
                  marginLeft: 15,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {ws.directory}
                </div>
              )}
              {ws.worktree_branch && (
                <div
                  data-testid={`ws-branch-${ws.id}`}
                  title={`Branch: ${ws.worktree_branch}`}
                  style={{
                    fontSize: 10,
                    color: "#89b4fa",
                    marginTop: 2,
                    marginLeft: 15,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  ⎇ {ws.worktree_branch}
                </div>
              )}
              {sessionInfoByWs && sessionInfoByWs[ws.id] && (
                <div
                  data-testid={`ws-session-${ws.id}`}
                  title={`Session: ${sessionInfoByWs[ws.id]}`}
                  style={{
                    fontSize: 10,
                    color: "#a6e3a1",
                    marginTop: 2,
                    marginLeft: 15,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  💬 {sessionInfoByWs[ws.id]}
                </div>
              )}
            </div>
          );
  };

  return (
    <div style={{
      width: 240,
      minWidth: 240,
      background: "#11111b",
      borderRight: "1px solid #313244",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>

      {/* ── WORKSTREAMS (top section) ── */}
      <div style={{
        padding: "10px 10px 4px",
        fontSize: 10,
        fontWeight: 600,
        color: "#585b70",
        textTransform: "uppercase",
        letterSpacing: 1,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <button
          data-testid="workstreams-toggle"
          onClick={() => setWorkstreamsCollapsed((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            padding: 0,
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 1,
            fontFamily: "inherit",
          }}
          title={workstreamsCollapsed ? "Show workstreams" : "Hide workstreams"}
        >
          {workstreamsCollapsed
            ? <ChevronRightIcon style={{ width: 12, height: 12 }} />
            : <ChevronDownIcon style={{ width: 12, height: 12 }} />}
          Workstreams
        </button>
        <button
          data-testid="new-workstream-button"
          onClick={() => onCreateWorkstream()}
          style={addButtonStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#313244"; (e.currentTarget as HTMLElement).style.color = "#cdd6f4"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; (e.currentTarget as HTMLElement).style.color = "#a6adc8"; }}
          title="New workstream"
        >
          <PlusIcon style={{ width: 16, height: 16 }} />
        </button>
      </div>

      {workstreamsCollapsed && <div style={{ flex: 1 }} />}
      {!workstreamsCollapsed && (
      <div style={{ flex: 1, overflowY: "auto", padding: "0 4px" }}>
        {activeWorkstreams.length === 0 && (
          <div style={{ padding: "8px 8px", color: "#45475a", fontSize: 11 }}>
            No workstreams yet
          </div>
        )}
        {sections.map((section) => (
          <div key={section.key} data-testid={`ws-section-${section.key}`}>
            <button
              data-testid={`ws-section-toggle-${section.key}`}
              onClick={() => toggleSection(section.key)}
              aria-expanded={!section.collapsed}
              style={sectionHeaderStyle}
              title={section.collapsed ? `Show ${section.label}` : `Hide ${section.label}`}
            >
              {section.collapsed
                ? <ChevronRightIcon style={{ width: 10, height: 10 }} />
                : <ChevronDownIcon style={{ width: 10, height: 10 }} />}
              <span style={{ flex: 1, textAlign: "left" }}>{section.label}</span>
              <span data-testid={`ws-section-count-${section.key}`} style={sectionCountStyle}>
                {section.rows.length}
              </span>
            </button>
            {!section.collapsed && section.rows.map(renderWorkstreamRow)}
          </div>
        ))}

        {/* Archived toggle */}
        {archivedWorkstreams.length > 0 && (
          <div
            onClick={() => setShowArchived(!showArchived)}
            style={{
              padding: "4px 8px",
              marginTop: 4,
              fontSize: 10,
              color: "#45475a",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            {showArchived ? "▾" : "▸"} Archived ({archivedWorkstreams.length})
          </div>
        )}
        {showArchived && archivedWorkstreams.map((ws) => {
          const prov = provisioning?.get(ws.id);
          const removeWarning = prov?.warning && ws.status === "archived" ? prov.warning : null;
          return (
          <div
            key={ws.id}
            style={{
              padding: "4px 8px",
              marginBottom: 1,
              borderRadius: 4,
              opacity: ws.status === "archiving" ? 0.7 : 0.5,
              fontSize: 11,
              color: "#585b70",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
                {ws.status === "archiving" && (
                  <span data-testid={`ws-archiving-${ws.id}`} style={{ display: "inline-block", color: "#89b4fa", animation: "ws-spin 0.9s linear infinite" }}>◍</span>
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ws.name}
                </span>
              </span>
              {ws.status === "archived" && (
                <button
                  onClick={() => onArchiveWorkstream(ws.id)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#585b70",
                    cursor: "pointer",
                    fontSize: 10,
                    padding: "0 4px",
                  }}
                  title="Unarchive"
                >
                  ↩
                </button>
              )}
            </div>
            {removeWarning && (
              <div data-testid={`ws-remove-warning-${ws.id}`} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                <span style={{ fontSize: 10, color: "#f9e2af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={removeWarning}>
                  ⚠ {removeWarning}
                </span>
                <button
                  data-testid={`ws-retry-remove-${ws.id}`}
                  onClick={(e) => { e.stopPropagation(); onRetryRemove?.(ws.id); }}
                  style={{ background: "#313244", color: "#a6e3a1", border: "none", borderRadius: 3, padding: "0 8px", cursor: "pointer", fontSize: 10, flexShrink: 0 }}
                >
                  Retry
                </button>
              </div>
            )}
          </div>
          );
        })}
      </div>
      )}

      {/* Divider */}
      <div style={{ borderTop: "1px solid #313244", margin: "4px 8px" }} />

      {/* ── TASKS (global) ──
          A sibling of the workstream list rather than a tile: a task may have
          no workstream at all, and often outlives the one it had, so binding
          the board to a single workstream would make most tasks unreachable. */}
      <div style={{ borderTop: "1px solid #313244", padding: "4px 6px", flexShrink: 0 }}>
        <button
          data-testid="task-board-button"
          onClick={onOpenTaskBoard}
          style={footerButtonStyle}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#1e1e2e"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          title="Open the task board"
        >
          <ClipboardDocumentListIcon style={{ width: 12, height: 12 }} />
          <span style={{ flex: 1, textAlign: "left" }}>Tasks</span>
        </button>
      </div>

      {/* ── REPOS (footer affordance) ──
          The repo list used to live here as a `maxHeight: 40vh` panel, i.e. up
          to ~a third of the sidebar, even though its only interactions were
          administrative (edit / import / create) — it never navigated or
          filtered. It is now one line that opens a manager with room to show
          the path, active-workstream counts and dormant repos. */}
      <div style={{ borderTop: "1px solid #313244", padding: "4px 6px", flexShrink: 0 }}>
        <button
          data-testid="repo-manager-button"
          onClick={() => setShowRepoManager(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "4px 6px",
            background: "none",
            border: "none",
            borderRadius: 4,
            color: "#6c7086",
            cursor: "pointer",
            fontSize: 10,
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#1e1e2e"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          title="Manage repos"
        >
          <FolderIcon style={{ width: 12, height: 12 }} />
          <span style={{ flex: 1, textAlign: "left" }}>
            {projects.length} repo{projects.length === 1 ? "" : "s"}
          </span>
          {dormantRepoCount > 0 && (
            <span data-testid="repo-dormant-count" style={{ color: "#45475a" }}>
              {dormantRepoCount} dormant
            </span>
          )}
        </button>
      </div>

      {showRepoManager && (
        <RepoManagerModal
          projects={projects}
          workstreams={workstreams}
          onClose={() => setShowRepoManager(false)}
          onUpdateProject={onUpdateProject}
          onCreateProject={() => { setShowRepoManager(false); onCreateProject(); }}
          onImportProject={() => { setShowRepoManager(false); onImportProject(); }}
          commandPlaceholder={getAppSettings().copilotCommand}
        />
      )}



      {/* Archive confirmation is handled by the parent (App) via
          ArchiveWorkstreamDialog, which also offers worktree deletion. */}
    </div>
  );
}

const sidebarBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#45475a",
  cursor: "pointer",
  fontSize: 11,
  padding: "0 2px",
  lineHeight: 1,
  display: "flex",
  alignItems: "center",
};

const sectionHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  width: "100%",
  padding: "3px 6px",
  marginTop: 2,
  background: "none",
  border: "none",
  color: "#585b70",
  cursor: "pointer",
  fontSize: 9,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  fontFamily: "inherit",
};

const sectionCountStyle: React.CSSProperties = {
  color: "#45475a",
  fontSize: 9,
};

const footerButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "4px 6px",
  background: "none",
  border: "none",
  borderRadius: 4,
  color: "#6c7086",
  cursor: "pointer",
  fontSize: 10,
  fontFamily: "inherit",
};

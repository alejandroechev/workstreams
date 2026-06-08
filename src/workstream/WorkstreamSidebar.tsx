// @test-skip: sidebar UI shell, behavior covered by backend tests
import { useState, useRef, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Project, Workstream } from "../domain/types";
import {
  BellAlertIcon,
  EllipsisHorizontalIcon,
} from "@heroicons/react/20/solid";
import { PROJECT_PRESET_COLORS, isCustomProjectColor } from "../domain/colors";
import { reorderById } from "../domain/reorder";
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
  onCreateProject: () => void;
  onImportProject: () => void;
  onCreateWorkstream: (projectId?: string) => void;
  onArchiveWorkstream: (id: string) => void;
  onRenameWorkstream: (id: string, newName: string) => void;
  onUpdateProject: (id: string, updates: { name: string; color: string }) => void;
  /**
   * Called after a drag-and-drop reorder with the FULL new order of active
   * workstream ids. The caller persists this (and any archived rows can be
   * left untouched).
   */
  onReorderWorkstreams: (orderedIds: string[]) => void;
  onChangeStatus: (id: string, status: Workstream['status']) => void;
  onForkWorkstream?: (id: string) => void;
  onChangeWorktree?: (ws: Workstream) => void;
}

// Activity slot in the sidebar row. Replaces the previous status icon +
// inline activity dot. Four states:
//   - bell:    agent finished while the workstream was unfocused
//   - working: any Copilot session in the workstream is non-idle
//   - stopped: workstream hasn't been loaded yet (gray hollow square)
//   - idle:    nothing rendered (preserves spacing via a fixed-width slot)
const ACTIVE_ACTIVITIES = new Set(["thinking", "tool_use", "responding", "background_task"]);

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
        <span
          style={{
            width: 9,
            height: 9,
            background: "transparent",
            border: "1px solid #6c7086",
            borderRadius: 1,
          }}
        />
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
  onCreateProject,
  onImportProject,
  onCreateWorkstream,
  onArchiveWorkstream,
  onRenameWorkstream,
  onUpdateProject,
  onReorderWorkstreams,
  onChangeStatus,
  onForkWorkstream,
  onChangeWorktree,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editProjectName, setEditProjectName] = useState("");
  const [editProjectColor, setEditProjectColor] = useState("");
  const [actionMenuWsId, setActionMenuWsId] = useState<string | null>(null);
  const [actionMenuAnchor, setActionMenuAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [draggedWsId, setDraggedWsId] = useState<string | null>(null);
  const [dragOverWsId, setDragOverWsId] = useState<string | null>(null);
  const [showRepoMenu, setShowRepoMenu] = useState(false);
  const repoMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showRepoMenu) return;
    function onClick(e: MouseEvent) {
      if (repoMenuRef.current && !repoMenuRef.current.contains(e.target as Node)) {
        setShowRepoMenu(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showRepoMenu]);

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

  const activeWorkstreams = workstreams.filter((ws) => ws.status !== "archived");
  const archivedWorkstreams = workstreams.filter((ws) => ws.status === "archived");

  const getProject = (projectId: string | null) =>
    projectId ? projects.find((p) => p.id === projectId) : undefined;

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
        <span>Workstreams</span>
        <button
          data-testid="new-workstream-button"
          onClick={() => onCreateWorkstream()}
          style={{
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            fontSize: 14,
            padding: 0,
            lineHeight: 1,
          }}
          title="New workstream"
        >
          +
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 4px" }}>
        {activeWorkstreams.length === 0 && (
          <div style={{ padding: "8px 8px", color: "#45475a", fontSize: 11 }}>
            No workstreams yet
          </div>
        )}
        {activeWorkstreams.map((ws) => {
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
                {isActive && renamingWsId !== ws.id && (
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
                    style={sidebarBtnStyle}
                    title="Actions"
                  >
                    <EllipsisHorizontalIcon style={{ width: 14, height: 14 }} />
                  </button>
                )}
              </div>

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
                  onArchive={() => setArchiveConfirm(ws.id)}
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
        })}

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
        {showArchived && archivedWorkstreams.map((ws) => (
          <div
            key={ws.id}
            style={{
              padding: "4px 8px",
              marginBottom: 1,
              borderRadius: 4,
              opacity: 0.5,
              fontSize: 11,
              color: "#585b70",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ws.name}
            </span>
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
          </div>
        ))}
      </div>

      {/* Divider */}
      <div style={{ borderTop: "1px solid #313244", margin: "4px 8px" }} />

      {/* ── REPOS (bottom section) ── */}
      <div style={{
        padding: "4px 10px",
        fontSize: 10,
        fontWeight: 600,
        color: "#585b70",
        textTransform: "uppercase",
        letterSpacing: 1,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span>Repos</span>
        <div ref={repoMenuRef} style={{ position: "relative" }}>
          <button
            onClick={() => setShowRepoMenu((v) => !v)}
            style={{
              background: "none",
              border: "none",
              color: "#585b70",
              cursor: "pointer",
              fontSize: 14,
              padding: 0,
              lineHeight: 1,
            }}
            title="Add repo"
          >
            +
          </button>
          {showRepoMenu && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                right: 0,
                marginTop: 4,
                background: "#181825",
                border: "1px solid #313244",
                borderRadius: 4,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                zIndex: 200,
                minWidth: 180,
                padding: 4,
              }}
            >
              <button
                onClick={() => { setShowRepoMenu(false); onImportProject(); }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  color: "#cdd6f4",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "6px 10px",
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                Import existing repo
              </button>
              <button
                onClick={() => { setShowRepoMenu(false); onCreateProject(); }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  color: "#cdd6f4",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "6px 10px",
                  textTransform: "none",
                  letterSpacing: 0,
                }}
              >
                Create new repo
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ overflowY: "auto", padding: "0 4px 8px", maxHeight: "40vh", minHeight: 120 }}>
        {projects.length === 0 && (
          <div style={{ padding: "4px 8px", color: "#45475a", fontSize: 11 }}>
            No repos yet
          </div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            onClick={() => {
              setEditingProject(p);
              setEditProjectName(p.name);
              setEditProjectColor(p.color);
            }}
            style={{
              padding: "4px 8px",
              marginBottom: 1,
              borderRadius: 4,
              fontSize: 11,
              color: "#a6adc8",
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#1e1e2e"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
          >
            <span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: p.color,
              flexShrink: 0,
            }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {p.name}
            </span>
            <span style={{ fontSize: 9, color: "#45475a" }}>
              {activeWorkstreams.filter((ws) => ws.project_id === p.id).length}
            </span>
          </div>
        ))}
      </div>

      {/* Repo edit modal */}
      {editingProject && (
        <div style={{
          position: "fixed",
          top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 2000,
        }} onClick={(e) => e.stopPropagation()}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#1e1e2e",
            border: "1px solid #313244",
            borderRadius: 8,
            padding: "16px 20px",
            width: 340,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 13 }}>
                Edit Repo
              </div>
              <button
                onClick={() => setEditingProject(null)}
                style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", fontSize: 16, padding: "2px 6px", lineHeight: 1 }}
                title="Close"
              >✕</button>
            </div>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Name</label>
            <input
              type="text"
              value={editProjectName}
              onChange={(e) => setEditProjectName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setEditingProject(null);
                if (e.key === "Enter" && editProjectName.trim()) {
                  onUpdateProject(editingProject.id, { name: editProjectName.trim(), color: editProjectColor });
                  setEditingProject(null);
                }
              }}
              autoFocus
              style={{
                width: "100%",
                background: "#313244",
                border: "1px solid #45475a",
                borderRadius: 4,
                color: "#cdd6f4",
                padding: "6px 8px",
                fontSize: 12,
                fontFamily: "monospace",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: 12,
              }}
            />
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Color</label>
            <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
              {PROJECT_PRESET_COLORS.map((c) => (
                <button
                  key={c.hex}
                  onClick={() => setEditProjectColor(c.hex)}
                  title={c.name}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: c.hex,
                    border: editProjectColor === c.hex ? "2px solid #cdd6f4" : "2px solid transparent",
                    cursor: "pointer",
                    outline: editProjectColor === c.hex ? "2px solid #89b4fa" : "none",
                    outlineOffset: 2,
                    transition: "outline 0.1s",
                  }}
                />
              ))}
              {/* Custom color: native picker. Shows the currently-selected
                  custom color as a swatch with a small "+" hint. */}
              <label
                title="Pick a custom color"
                style={{
                  position: "relative",
                  width: 24,
                  height: 24,
                  borderRadius: "50%",
                  background: isCustomProjectColor(editProjectColor) ? editProjectColor : "transparent",
                  border: isCustomProjectColor(editProjectColor)
                    ? "2px solid #cdd6f4"
                    : "2px dashed #585b70",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  outline: isCustomProjectColor(editProjectColor) ? "2px solid #89b4fa" : "none",
                  outlineOffset: 2,
                }}
              >
                <span style={{ color: isCustomProjectColor(editProjectColor) ? "#1e1e2e" : "#585b70", fontSize: 14, lineHeight: 1, pointerEvents: "none" }}>+</span>
                <input
                  type="color"
                  value={isCustomProjectColor(editProjectColor) ? editProjectColor : "#cdd6f4"}
                  onChange={(e) => setEditProjectColor(e.target.value)}
                  style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
                />
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setEditingProject(null)}
                style={{ padding: "6px 14px", background: "#313244", color: "#a6adc8", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (editProjectName.trim()) {
                    onUpdateProject(editingProject.id, { name: editProjectName.trim(), color: editProjectColor });
                    setEditingProject(null);
                  }
                }}
                disabled={!editProjectName.trim()}
                style={{
                  padding: "6px 14px",
                  background: !editProjectName.trim() ? "#45475a" : "#89b4fa",
                  color: "#1e1e2e",
                  border: "none",
                  borderRadius: 4,
                  cursor: !editProjectName.trim() ? "default" : "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Archive confirmation dialog */}
      {archiveConfirm && (
        <div style={{
          position: "fixed",
          top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 2000,
        }} onClick={(e) => e.stopPropagation()}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#1e1e2e",
            border: "1px solid #313244",
            borderRadius: 8,
            padding: "16px 20px",
            width: 320,
          }}>
            <div style={{ color: "#cdd6f4", fontSize: 13, marginBottom: 8 }}>
              Archive "{workstreams.find((w) => w.id === archiveConfirm)?.name}"?
            </div>
            <div style={{ color: "#6c7086", fontSize: 11, marginBottom: 14 }}>
              Running processes will be stopped. State is preserved.
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setArchiveConfirm(null)}
                style={{ padding: "6px 14px", background: "#313244", color: "#a6adc8", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
              >
                Cancel
              </button>
              <button
                onClick={() => { onArchiveWorkstream(archiveConfirm); setArchiveConfirm(null); }}
                style={{ padding: "6px 14px", background: "#f38ba8", color: "#1e1e2e", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}
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

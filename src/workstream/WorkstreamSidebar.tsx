import { useState } from "react";
import type { Project, Workstream } from "../domain/types";

interface Props {
  projects: Project[];
  workstreams: Workstream[];
  activeWsId: string | null;
  onSelectWorkstream: (id: string) => void;
  onCreateProject: () => void;
  onCreateWorkstream: (projectId?: string) => void;
  onArchiveWorkstream: (id: string) => void;
}

const statusIcon = (status: string) => {
  switch (status) {
    case "active": return "●";
    case "paused": return "◐";
    case "blocked": return "◆";
    default: return "○";
  }
};

const statusColor = (status: string) => {
  switch (status) {
    case "active": return "#a6e3a1";
    case "paused": return "#f9e2af";
    case "blocked": return "#f38ba8";
    default: return "#585b70";
  }
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function tintBg(color: string, opacity = 0.1): string {
  const rgb = hexToRgb(color);
  if (!rgb) return "transparent";
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${opacity})`;
}

export default function WorkstreamSidebar({
  projects,
  workstreams,
  activeWsId,
  onSelectWorkstream,
  onCreateProject,
  onCreateWorkstream,
  onArchiveWorkstream,
}: Props) {
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);

  const toggleCollapse = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const activeWorkstreams = workstreams.filter((ws) => ws.status !== "archived");
  const archivedWorkstreams = workstreams.filter((ws) => ws.status === "archived");

  const linkedWs = (projectId: string) =>
    activeWorkstreams.filter((ws) => ws.project_id === projectId);
  const unlinkedWs = activeWorkstreams.filter((ws) => ws.project_id === null);

  const renderWorkstreamEntry = (ws: Workstream, indented = false) => {
    const isActive = ws.id === activeWsId;
    const isArchived = ws.status === "archived";

    return (
      <div
        key={ws.id}
        onClick={() => !isArchived && onSelectWorkstream(ws.id)}
        style={{
          padding: "6px 10px",
          marginBottom: 1,
          marginLeft: indented ? 12 : 0,
          borderRadius: 4,
          cursor: isArchived ? "default" : "pointer",
          background: isActive ? "#1e1e2e" : "transparent",
          border: isActive ? "1px solid #313244" : "1px solid transparent",
          opacity: isArchived ? 0.5 : 1,
          transition: "background 0.1s",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 4,
            fontSize: 12,
            color: isArchived ? "#585b70" : isActive ? "#cdd6f4" : "#a6adc8",
            fontWeight: isActive ? 500 : 400,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
            <span style={{ color: statusColor(ws.status), fontSize: 8, flexShrink: 0 }}>
              {statusIcon(ws.status)}
            </span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ws.name}
            </span>
          </div>
          {!isArchived && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setArchiveConfirm(ws.id);
              }}
              style={{
                background: "none",
                border: "none",
                color: "#45475a",
                cursor: "pointer",
                fontSize: 11,
                padding: "0 2px",
                lineHeight: 1,
                flexShrink: 0,
                opacity: isActive ? 1 : 0,
                transition: "opacity 0.1s",
              }}
              title="Archive workstream"
            >
              ✕
            </button>
          )}
          {isArchived && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onArchiveWorkstream(ws.id);
              }}
              style={{
                background: "none",
                border: "none",
                color: "#a6e3a1",
                cursor: "pointer",
                fontSize: 10,
                padding: "0 4px",
                flexShrink: 0,
              }}
              title="Unarchive"
            >
              ↩
            </button>
          )}
        </div>
        {(ws.git_repo || ws.directory) && (
          <div style={{
            fontSize: 10,
            color: "#585b70",
            marginTop: 1,
            marginLeft: 14,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {ws.git_repo ?? ""}{ws.git_branch ? ` → ${ws.git_branch}` : ""}
            {!ws.git_repo && ws.directory ? ws.directory : ""}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        width: 240,
        minWidth: 240,
        background: "#11111b",
        borderRight: "1px solid #313244",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Header + New Project */}
      <div style={{
        padding: "10px 10px 6px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#585b70",
          textTransform: "uppercase",
          letterSpacing: 1,
        }}>
          Projects
        </span>
        <button
          onClick={onCreateProject}
          style={{
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 6px",
          }}
          title="New Project"
        >
          + Project
        </button>
      </div>

      {/* Scrollable project/workstream list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px" }}>
        {/* Projects with nested workstreams */}
        {projects.map((proj) => {
          const pWs = linkedWs(proj.id);
          const collapsed = collapsedProjects.has(proj.id);
          const bg = tintBg(proj.color);

          return (
            <div key={proj.id} style={{ marginBottom: 4 }}>
              {/* Project header */}
              <div
                onClick={() => toggleCollapse(proj.id)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 4,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: proj.color, flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 12, fontWeight: 500, color: "#cdd6f4",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {proj.name}
                  </span>
                  <span style={{ fontSize: 10, color: "#585b70", flexShrink: 0 }}>
                    {pWs.length}
                  </span>
                </div>
                <span style={{ fontSize: 10, color: "#585b70", flexShrink: 0 }}>
                  {collapsed ? "▸" : "▾"}
                </span>
              </div>

              {/* Nested workstreams */}
              {!collapsed && (
                <div style={{ marginTop: 2 }}>
                  {pWs.map((ws) => renderWorkstreamEntry(ws, true))}
                  <button
                    onClick={() => onCreateWorkstream(proj.id)}
                    style={{
                      width: "calc(100% - 12px)",
                      marginLeft: 12,
                      padding: "4px 0",
                      background: "transparent",
                      color: "#585b70",
                      border: "1px dashed #313244",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 10,
                      marginTop: 2,
                      marginBottom: 2,
                    }}
                  >
                    + Workstream
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* Unlinked workstreams */}
        {(unlinkedWs.length > 0 || projects.length > 0) && (
          <div style={{ marginTop: 6 }}>
            <div style={{
              padding: "6px 8px",
              fontSize: 10,
              fontWeight: 600,
              color: "#585b70",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}>
              Unlinked
            </div>
            {unlinkedWs.map((ws) => renderWorkstreamEntry(ws))}
            <button
              onClick={() => onCreateWorkstream()}
              style={{
                width: "100%",
                padding: "4px 0",
                background: "transparent",
                color: "#585b70",
                border: "1px dashed #313244",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 10,
                marginTop: 2,
                marginBottom: 4,
              }}
            >
              + Workstream
            </button>
          </div>
        )}

        {/* Empty state: no projects, show unlinked with create button */}
        {projects.length === 0 && unlinkedWs.length === 0 && activeWorkstreams.length === 0 && (
          <div style={{ padding: "16px 8px", textAlign: "center", color: "#585b70", fontSize: 11 }}>
            No projects yet
          </div>
        )}

        {/* Archived toggle */}
        {archivedWorkstreams.length > 0 && (
          <div style={{ marginTop: 8, borderTop: "1px solid #313244", paddingTop: 6 }}>
            <button
              onClick={() => setShowArchived(!showArchived)}
              style={{
                width: "100%",
                padding: "4px 8px",
                background: "transparent",
                color: "#585b70",
                border: "none",
                cursor: "pointer",
                fontSize: 10,
                textAlign: "left",
              }}
            >
              {showArchived ? "▾" : "▸"} Archived ({archivedWorkstreams.length})
            </button>
            {showArchived && archivedWorkstreams.map((ws) => renderWorkstreamEntry(ws))}
          </div>
        )}
      </div>

      {/* Archive confirmation dialog */}
      {archiveConfirm && (() => {
        const ws = workstreams.find((w) => w.id === archiveConfirm);
        return (
          <div style={{
            padding: "8px 10px",
            borderTop: "1px solid #313244",
            background: "#1e1e2e",
          }}>
            <div style={{ fontSize: 11, color: "#f9e2af", marginBottom: 6 }}>
              Archive {ws?.name ?? "this workstream"}? Running processes will be stopped.
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => {
                  onArchiveWorkstream(archiveConfirm);
                  setArchiveConfirm(null);
                }}
                style={{
                  flex: 1,
                  padding: "5px 0",
                  background: "#f38ba8",
                  color: "#1e1e2e",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                Archive
              </button>
              <button
                onClick={() => setArchiveConfirm(null)}
                style={{
                  padding: "5px 12px",
                  background: "#313244",
                  color: "#a6adc8",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

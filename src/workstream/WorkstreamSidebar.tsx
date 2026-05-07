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

export default function WorkstreamSidebar({
  projects,
  workstreams,
  activeWsId,
  onSelectWorkstream,
  onCreateProject,
  onCreateWorkstream,
  onArchiveWorkstream,
}: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);

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
          return (
            <div
              key={ws.id}
              onClick={() => onSelectWorkstream(ws.id)}
              style={{
                padding: "6px 8px",
                marginBottom: 1,
                borderRadius: 4,
                cursor: "pointer",
                background: isActive ? "#1e1e2e" : "transparent",
                border: isActive ? "1px solid #313244" : "1px solid transparent",
                transition: "background 0.1s",
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
                  color: isActive ? "#cdd6f4" : "#a6adc8",
                  fontWeight: isActive ? 500 : 400,
                }}>
                  <span style={{ color: statusColor(ws.status), fontSize: 9, flexShrink: 0 }}>
                    {statusIcon(ws.status)}
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ws.name}
                  </span>
                </div>
                {isActive && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setArchiveConfirm(ws.id); }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#45475a",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "0 2px",
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                    title="Archive workstream"
                  >
                    ✕
                  </button>
                )}
              </div>
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
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: project.color,
                    display: "inline-block",
                    flexShrink: 0,
                  }} />
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

      {/* ── PROJECTS (bottom section) ── */}
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
        <span>Projects</span>
        <button
          onClick={onCreateProject}
          style={{
            background: "none",
            border: "none",
            color: "#585b70",
            cursor: "pointer",
            fontSize: 14,
            padding: 0,
            lineHeight: 1,
          }}
          title="New project"
        >
          +
        </button>
      </div>

      <div style={{ overflowY: "auto", padding: "0 4px 8px", maxHeight: 200 }}>
        {projects.length === 0 && (
          <div style={{ padding: "4px 8px", color: "#45475a", fontSize: 11 }}>
            No projects yet
          </div>
        )}
        {projects.map((p) => (
          <div
            key={p.id}
            style={{
              padding: "4px 8px",
              marginBottom: 1,
              borderRadius: 4,
              fontSize: 11,
              color: "#a6adc8",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
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
        }} onClick={() => setArchiveConfirm(null)}>
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

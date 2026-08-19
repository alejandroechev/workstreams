import { useEffect, useMemo, useState } from "react";
import { XMarkIcon } from "@heroicons/react/24/outline";

import type { Project, Workstream } from "../domain/types";
import { PROJECT_PRESET_COLORS, isCustomProjectColor } from "../domain/colors";

export interface RepoManagerModalProps {
  projects: Project[];
  /** Used only to count active workstreams per repo. */
  workstreams: Workstream[];
  onClose: () => void;
  onUpdateProject: (
    id: string,
    updates: { name: string; color: string; copilot_command: string | null },
  ) => void;
  onCreateProject: () => void;
  onImportProject: () => void;
  /** Global Copilot command, shown as the placeholder when a repo inherits it. */
  commandPlaceholder?: string;
}

const ARCHIVED: ReadonlySet<Workstream["status"]> = new Set(["archived", "archiving"]);

/**
 * Repo administration, moved out of the sidebar.
 *
 * The sidebar used to reserve `maxHeight: 40vh` at the bottom for a repo list
 * whose only interactions were *administrative* — clicking a row opened an edit
 * form, and `+` imported or created. It never navigated or filtered, so it was
 * spending roughly a third of the sidebar competing with the workstream list.
 *
 * Here the same actions get room to show what the 240px strip could not: the
 * directory, the active-workstream count, and which repos are dormant.
 */
export function RepoManagerModal({
  projects,
  workstreams,
  onClose,
  onUpdateProject,
  onCreateProject,
  onImportProject,
  commandPlaceholder = "inherit global",
}: RepoManagerModalProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const [name, setName] = useState(projects[0]?.name ?? "");
  const [color, setColor] = useState(projects[0]?.color ?? "#89b4fa");
  const [command, setCommand] = useState(projects[0]?.copilot_command ?? "");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ws of workstreams) {
      if (!ws.project_id || ARCHIVED.has(ws.status)) continue;
      counts.set(ws.project_id, (counts.get(ws.project_id) ?? 0) + 1);
    }
    return counts;
  }, [workstreams]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...projects].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    if (!q) return sorted;
    return sorted.filter(
      (p) => p.name.toLowerCase().includes(q) || p.directory.toLowerCase().includes(q),
    );
  }, [projects, query]);

  const select = (p: Project) => {
    setSelectedId(p.id);
    setName(p.name);
    setColor(p.color);
    setCommand(p.copilot_command ?? "");
  };

  const save = () => {
    const trimmed = name.trim();
    if (!selectedId || !trimmed) return;
    onUpdateProject(selectedId, {
      name: trimmed,
      color,
      copilot_command: command.trim() || null,
    });
  };

  return (
    <div
      data-testid="repo-manager-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        data-testid="repo-manager-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(900px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          background: "#1e1e2e",
          border: "1px solid #313244",
          borderRadius: 8,
          overflow: "hidden",
        }}
      >
        <div style={headerStyle}>
          <div>
            <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 13 }}>Repos</div>
            <div style={{ color: "#6c7086", fontSize: 11 }}>
              {projects.length} repo{projects.length === 1 ? "" : "s"}
            </div>
          </div>
          <button
            data-testid="repo-manager-close"
            onClick={onClose}
            title="Close"
            style={iconButtonStyle}
          >
            <XMarkIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div style={toolbarStyle}>
          <input
            data-testid="repo-manager-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or path"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button data-testid="repo-manager-import" onClick={onImportProject} style={buttonStyle}>
            Import existing repo
          </button>
          <button
            data-testid="repo-manager-create"
            onClick={onCreateProject}
            style={{ ...buttonStyle, background: "#89b4fa", color: "#11111b", borderColor: "#89b4fa" }}
          >
            Create new repo
          </button>
        </div>

        {projects.length === 0 && (
          <div data-testid="repo-manager-first-run" style={{ padding: 24, textAlign: "center", color: "#a6adc8", fontSize: 12 }}>
            No repos yet — import an existing repo or create a new one to get started.
          </div>
        )}

        {projects.length > 0 && (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
              {visible.length === 0 && (
                <div data-testid="repo-manager-empty" style={{ padding: 16, color: "#6c7086", fontSize: 12 }}>
                  No repos match “{query}”.
                </div>
              )}
              {visible.map((p) => {
                const count = activeCounts.get(p.id) ?? 0;
                const dormant = count === 0;
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    data-testid={`repo-manager-row-${p.id}`}
                    data-dormant={dormant ? "true" : "false"}
                    onClick={() => select(p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        select(p);
                      }
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      cursor: "pointer",
                      fontSize: 12,
                      color: "#cdd6f4",
                      background: p.id === selectedId ? "#313244" : "transparent",
                      borderLeft: `2px solid ${p.id === selectedId ? p.color : "transparent"}`,
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: p.color, flexShrink: 0 }} />
                    <span style={{ minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, color: "#6c7086", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.directory}
                    </span>
                    {dormant && (
                      <span style={{ color: "#f9e2af", fontSize: 9, border: "1px solid #45475a", borderRadius: 3, padding: "0 4px" }}>
                        dormant
                      </span>
                    )}
                    <span style={{ color: "#a6adc8", fontSize: 11, minWidth: 16, textAlign: "right" }}>{count}</span>
                  </div>
                );
              })}
            </div>

            <div style={{ width: 260, borderLeft: "1px solid #313244", padding: 12, overflowY: "auto" }}>
              <div style={{ color: "#a6adc8", fontSize: 11, marginBottom: 8 }}>Edit repo</div>
              <label style={labelStyle}>Name</label>
              <input
                data-testid="repo-manager-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={inputStyle}
              />
              <label style={labelStyle}>Colour</label>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                {PROJECT_PRESET_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    data-testid={`repo-manager-color-${c.hex}`}
                    onClick={() => setColor(c.hex)}
                    title={c.name}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      background: c.hex,
                      border: "none",
                      cursor: "pointer",
                      outline: color === c.hex ? "2px solid #cdd6f4" : "none",
                      outlineOffset: 1,
                    }}
                  />
                ))}
                <label
                  title="Custom colour"
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    background: isCustomProjectColor(color) ? color : "transparent",
                    border: isCustomProjectColor(color) ? "none" : "1px dashed #585b70",
                    outline: isCustomProjectColor(color) ? "2px solid #cdd6f4" : "none",
                    outlineOffset: 1,
                  }}
                >
                  <input
                    data-testid="repo-manager-color"
                    type="color"
                    value={isCustomProjectColor(color) ? color : "#cdd6f4"}
                    onChange={(e) => setColor(e.target.value)}
                    style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
                  />
                  {!isCustomProjectColor(color) && (
                    <span style={{ color: "#585b70", fontSize: 11, lineHeight: 1, pointerEvents: "none" }}>+</span>
                  )}
                </label>
              </div>
              <label style={labelStyle}>Copilot command</label>
              <input
                data-testid="repo-manager-command"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={commandPlaceholder}
                style={inputStyle}
              />
              <button
                data-testid="repo-manager-save"
                onClick={save}
                style={{ ...buttonStyle, width: "100%", marginTop: 10, background: "#89b4fa", color: "#11111b", borderColor: "#89b4fa" }}
              >
                Save changes
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 12px",
  borderBottom: "1px solid #313244",
};

const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "8px 12px",
  borderBottom: "1px solid #313244",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "4px 8px",
  fontSize: 11,
  color: "#cdd6f4",
  background: "#11111b",
  border: "1px solid #313244",
  borderRadius: 4,
  outline: "none",
  marginBottom: 8,
};

const buttonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  color: "#cdd6f4",
  background: "#181825",
  border: "1px solid #45475a",
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const iconButtonStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#6c7086",
  cursor: "pointer",
  padding: 2,
  display: "flex",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 10,
  color: "#6c7086",
  marginBottom: 3,
};

import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project } from "../domain/types";

type WorkstreamType = "worktree" | "base_repo" | "standalone";

interface Props {
  project?: Project;
  onSubmit: (name: string, directory: string, opts: { projectId?: string; workstreamType: string; worktreeBranch?: string }) => void;
  onCancel: () => void;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export default function WorkstreamCreateForm({ project, onSubmit, onCancel }: Props) {
  const hasProject = !!project;
  const [name, setName] = useState(hasProject ? `${project.name} - ` : "");
  const [wsType, setWsType] = useState<WorkstreamType>(hasProject ? "worktree" : "standalone");
  const [directory, setDirectory] = useState(project?.directory || "");
  const [branchName, setBranchName] = useState("");

  // Auto-update branch name from workstream name
  useEffect(() => {
    if (wsType === "worktree" && name.trim()) {
      setBranchName(`ws-${slugify(name)}`);
    }
  }, [name, wsType]);

  // Auto-set directory when switching to base_repo or worktree with a project
  useEffect(() => {
    if (hasProject && (wsType === "worktree" || wsType === "base_repo")) {
      setDirectory(project.directory);
    }
  }, [wsType, hasProject, project?.directory]);

  const pickDirectory = async () => {
    const dir = await open({ directory: true, title: "Select workstream directory" });
    if (dir) setDirectory(dir as string);
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    const dir = directory || (project?.directory ?? "");
    if (!dir) return;
    onSubmit(name.trim(), dir, {
      projectId: project?.id,
      workstreamType: wsType,
      worktreeBranch: wsType === "worktree" ? branchName : undefined,
    });
  };

  const typeOptions: { value: WorkstreamType; label: string; desc: string }[] = [
    { value: "worktree", label: "New Worktree", desc: "Creates a git worktree branch" },
    { value: "base_repo", label: "Base Repo", desc: "Works in project directory" },
    { value: "standalone", label: "Standalone", desc: "Pick any directory" },
  ];

  return (
    <div
      style={{
        position: "fixed",
        top: 0, left: 0, right: 0, bottom: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e2e",
          border: "1px solid #313244",
          borderRadius: 8,
          width: 480,
          padding: "20px 24px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          New Workstream
        </div>
        {project && (
          <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: project.color, marginRight: 6, verticalAlign: "middle" }} />
            {project.name}
          </div>
        )}

        {/* Name */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") handleSubmit();
          }}
          placeholder="Feature work, bug fix..."
          autoFocus
          style={{
            width: "100%",
            background: "#313244",
            border: "1px solid #45475a",
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 14,
          }}
        />

        {/* Type */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Type</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
          {typeOptions.map((opt) => (
            <label
              key={opt.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                background: wsType === opt.value ? "#313244" : "transparent",
                border: wsType === opt.value ? "1px solid #45475a" : "1px solid transparent",
              }}
            >
              <input
                type="radio"
                name="wsType"
                value={opt.value}
                checked={wsType === opt.value}
                onChange={() => setWsType(opt.value)}
                style={{ accentColor: "#89b4fa" }}
              />
              <div>
                <div style={{ fontSize: 12, color: "#cdd6f4" }}>{opt.label}</div>
                <div style={{ fontSize: 10, color: "#6c7086" }}>{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Branch name (worktree only) */}
        {wsType === "worktree" && (
          <>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Branch Name</label>
            <input
              type="text"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="ws-feature-name"
              style={{
                width: "100%",
                background: "#313244",
                border: "1px solid #45475a",
                borderRadius: 4,
                color: "#cdd6f4",
                padding: "8px 10px",
                fontSize: 12,
                fontFamily: "monospace",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: 14,
              }}
            />
          </>
        )}

        {/* Directory (standalone or manual override) */}
        {wsType === "standalone" && (
          <>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Directory</label>
            <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
              <input
                type="text"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="C:\\Projects\\..."
                style={{
                  flex: 1,
                  background: "#313244",
                  border: "1px solid #45475a",
                  borderRadius: 4,
                  color: "#cdd6f4",
                  padding: "8px 10px",
                  fontSize: 12,
                  fontFamily: "monospace",
                  outline: "none",
                }}
              />
              <button
                onClick={pickDirectory}
                style={{
                  background: "#45475a",
                  border: "none",
                  borderRadius: 4,
                  color: "#cdd6f4",
                  padding: "6px 12px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
                title="Browse"
              >
                📁
              </button>
            </div>
          </>
        )}

        {/* Show resolved directory for non-standalone */}
        {wsType !== "standalone" && directory && (
          <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14, paddingLeft: 2 }}>
            Directory: {directory}
          </div>
        )}

        {/* TODO: For worktree type, run `git worktree add` with branchName at directory */}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              background: "#313244",
              color: "#a6adc8",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !directory}
            style={{
              padding: "8px 20px",
              background: !name.trim() || !directory ? "#45475a" : "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              cursor: !name.trim() || !directory ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Create Workstream
          </button>
        </div>
      </div>
    </div>
  );
}

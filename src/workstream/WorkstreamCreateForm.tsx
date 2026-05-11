import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../domain/types";

type WorkstreamType = "worktree" | "base_repo" | "standalone" | "import_worktree";

interface WorktreeInfo {
  is_worktree: boolean;
  parent_repo_path: string | null;
  parent_repo_name: string | null;
  branch: string | null;
  git_remote: string | null;
}

interface Props {
  project?: Project;
  projects: Project[];
  onSubmit: (name: string, directory: string, opts: {
    projectId?: string;
    workstreamType: string;
    worktreeBranch?: string;
    showSessionPicker?: boolean;
    createSessionTile?: boolean;
  }) => void;
  onCancel: () => void;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export default function WorkstreamCreateForm({ project: initialProject, projects, onSubmit, onCancel }: Props) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialProject?.id || null);
  const project = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) : undefined;
  const hasProject = !!project;
  const [name, setName] = useState(hasProject ? project.name : "");
  const [wsType, setWsType] = useState<WorkstreamType>(hasProject ? "worktree" : "standalone");
  const [directory, setDirectory] = useState(project?.directory || "");
  const [branchName, setBranchName] = useState("");
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [linkSession, setLinkSession] = useState(true); // default: create a copilot session tile

  // Update form when project selection changes
  const handleProjectChange = (projectId: string | null) => {
    setSelectedProjectId(projectId);
    const p = projectId ? projects.find((pr) => pr.id === projectId) : undefined;
    if (p) {
      setDirectory(p.directory);
      if (!name || name === project?.name) setName(p.name);
      setWsType("worktree");
    } else {
      setDirectory("");
      setWsType("standalone");
    }
  };

  useEffect(() => {
    if (wsType === "worktree" && name.trim()) {
      setBranchName(`alejandroe/${slugify(name)}`);
    }
  }, [name, wsType]);

  useEffect(() => {
    if (hasProject && (wsType === "worktree" || wsType === "base_repo")) {
      setDirectory(project.directory);
    }
  }, [wsType, hasProject, project?.directory]);

  const pickDirectory = async () => {
    const dir = await open({ directory: true, title: "Select worktree directory" });
    if (dir) {
      setDirectory(dir as string);
      if (wsType === "import_worktree") {
        // Auto-detect worktree info
        try {
          const info = await invoke<WorktreeInfo>("detect_worktree_info", { directory: dir });
          setWorktreeInfo(info);
          if (info.parent_repo_name && !name) {
            setName(info.branch || info.parent_repo_name);
          }
        } catch {
          setWorktreeInfo(null);
        }
      }
    }
  };

  const handleSubmit = () => {
    if (!name.trim()) return;
    const dir = directory || (project?.directory ?? "");
    if (!dir) return;

    const isImport = wsType === "import_worktree";
    onSubmit(name.trim(), dir, {
      projectId: project?.id,
      workstreamType: isImport ? "worktree" : wsType,
      worktreeBranch: wsType === "worktree" ? branchName : (isImport ? worktreeInfo?.branch || undefined : undefined),
      showSessionPicker: isImport,
      createSessionTile: linkSession,
    });
  };

  const typeOptions: { value: WorkstreamType; label: string; desc: string }[] = [
    { value: "import_worktree", label: "Import Existing Worktree", desc: "Point to an existing worktree + link a Copilot session" },
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
      onClick={(e) => e.stopPropagation()}
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14 }}>
            New Workstream
          </div>
          <button
            onClick={onCancel}
            style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", fontSize: 16, padding: "2px 6px", lineHeight: 1 }}
            title="Close"
          >✕</button>
        </div>

        {/* Project selector */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Project</label>
        <select
          value={selectedProjectId || ""}
          onChange={(e) => handleProjectChange(e.target.value || null)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            background: "#313244",
            border: "1px solid #45475a",
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "8px 10px",
            fontSize: 12,
            outline: "none",
            boxSizing: "border-box",
            marginBottom: 14,
            cursor: "pointer",
          }}
        >
          <option value="">None</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {project && (
          <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14, marginTop: -10 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: project.color, marginRight: 6, verticalAlign: "middle" }} />
            {project.directory}
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
              placeholder="alejandroe/feature-name"
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

        {/* Directory (standalone or import_worktree) */}
        {(wsType === "standalone" || wsType === "import_worktree") && (
          <>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>
              {wsType === "import_worktree" ? "Existing Worktree Directory" : "Directory"}
            </label>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              <input
                type="text"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={wsType === "import_worktree" ? "C:\\repos\\project-worktree" : "C:\\Projects\\..."}
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
            {/* Detected worktree info */}
            {wsType === "import_worktree" && worktreeInfo && (
              <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14, padding: "6px 8px", background: "#181825", borderRadius: 4 }}>
                {worktreeInfo.is_worktree ? (
                  <>
                    <div style={{ color: "#a6e3a1", marginBottom: 2 }}>✓ Git worktree detected</div>
                    {worktreeInfo.parent_repo_name && <div>Parent repo: <span style={{ color: "#cdd6f4" }}>{worktreeInfo.parent_repo_name}</span></div>}
                    {worktreeInfo.parent_repo_path && <div>Repo path: <span style={{ color: "#585b70" }}>{worktreeInfo.parent_repo_path}</span></div>}
                    {worktreeInfo.branch && <div>Branch: <span style={{ color: "#89b4fa" }}>{worktreeInfo.branch}</span></div>}
                    {worktreeInfo.git_remote && <div>Remote: <span style={{ color: "#585b70" }}>{worktreeInfo.git_remote}</span></div>}
                  </>
                ) : worktreeInfo.parent_repo_path ? (
                  <>
                    <div style={{ color: "#f9e2af", marginBottom: 2 }}>Regular git repo (not a worktree)</div>
                    {worktreeInfo.branch && <div>Branch: <span style={{ color: "#89b4fa" }}>{worktreeInfo.branch}</span></div>}
                  </>
                ) : (
                  <div style={{ color: "#f38ba8" }}>Not a git repository</div>
                )}
              </div>
            )}
            {wsType === "import_worktree" && !worktreeInfo && directory && (
              <div style={{ fontSize: 11, color: "#585b70", marginBottom: 14 }}>
                Pick a directory to detect worktree info
              </div>
            )}
          </>
        )}

        {/* Show resolved directory for non-standalone */}
        {wsType !== "standalone" && directory && (
          <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14, paddingLeft: 2 }}>
            Directory: {directory}
          </div>
        )}

        {/* Link session checkbox */}
        <label style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: 4,
          cursor: "pointer",
          background: linkSession ? "#313244" : "transparent",
          border: linkSession ? "1px solid #45475a" : "1px solid transparent",
          marginBottom: 14,
        }}>
          <input
            type="checkbox"
            checked={linkSession}
            onChange={(e) => setLinkSession(e.target.checked)}
            style={{ accentColor: "#89b4fa" }}
          />
          <div>
            <div style={{ fontSize: 12, color: "#cdd6f4" }}>Start with Copilot session</div>
            <div style={{ fontSize: 10, color: "#6c7086" }}>
              {wsType === "import_worktree"
                ? "Creates a session tile and links an existing session"
                : "Creates a Copilot session tile automatically"}
            </div>
          </div>
        </label>

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
            {wsType === "import_worktree" ? "Import & Link Session" : "Create Workstream"}
          </button>
        </div>
      </div>
    </div>
  );
}

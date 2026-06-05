// @test-skip: Form layout tested via behavior in WorkstreamCreateForm.test.tsx
import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../domain/types";

export type RepoChoice = "import_worktree" | "base_repo" | "worktree";
export type SessionChoice = "new" | "existing";

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
    sessionChoice: SessionChoice;
    baseBranch?: string;
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
  const [repoChoice, setRepoChoice] = useState<RepoChoice>(hasProject ? "worktree" : "base_repo");
  const [directory, setDirectory] = useState(project?.directory || "");
  const [branchName, setBranchName] = useState("");
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  // Session choice is fully independent of repo source — importing an
  // existing worktree does NOT require linking to an existing session.
  const [sessionPref, setSessionPref] = useState<SessionChoice>("new");
  const effectiveSession: SessionChoice = sessionPref;

  // Project changed: reset defaults
  const handleProjectChange = (projectId: string | null) => {
    setSelectedProjectId(projectId);
    const p = projectId ? projects.find((pr) => pr.id === projectId) : undefined;
    if (p) {
      setDirectory(p.directory);
      if (!name || name === project?.name) setName(p.name);
      setRepoChoice("worktree");
    } else {
      setDirectory("");
      setRepoChoice("base_repo");
    }
  };

  useEffect(() => {
    if (repoChoice === "worktree" && name.trim()) {
      setBranchName(`alejandroe/${slugify(name)}`);
    }
  }, [name, repoChoice]);

  useEffect(() => {
    if (hasProject && (repoChoice === "worktree" || repoChoice === "base_repo")) {
      setDirectory(project.directory);
    }
  }, [repoChoice, hasProject, project?.directory]);

  const pickDirectory = async () => {
    const dir = await open({ directory: true, title: "Select worktree directory" });
    if (dir) {
      setDirectory(dir as string);
      if (repoChoice === "import_worktree") {
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
    onSubmit(name.trim(), dir, {
      projectId: project?.id,
      workstreamType: repoChoice,
      worktreeBranch:
        repoChoice === "worktree" ? branchName :
        repoChoice === "import_worktree" ? worktreeInfo?.branch || undefined :
        undefined,
      sessionChoice: effectiveSession,
    });
  };

  const repoOptions: { value: RepoChoice; label: string; desc: string }[] = [
    { value: "import_worktree", label: "Import Existing Worktree", desc: "Point to an existing worktree directory" },
    { value: "base_repo", label: "Base Repo", desc: "Work directly in the repo root" },
    { value: "worktree", label: "New Worktree", desc: "Create a new git worktree branch alongside the repo" },
  ];

  const sessionOptions: { value: SessionChoice; label: string; desc: string }[] = [
    { value: "new", label: "New Session", desc: "Spawn a fresh Copilot session" },
    { value: "existing", label: "Existing Session", desc: "Pick one of your prior sessions" },
  ];

  return (
    <div
      data-testid="ws-create-form"
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

        {/* Repo selector */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Repo</label>
        <select
          data-testid="ws-create-project"
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
          data-testid="ws-create-name"
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

        {/* Repo type */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Repo source</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
          {repoOptions.map((opt) => (
            <label
              key={opt.value}
              data-testid={`ws-create-repo-${opt.value}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                background: repoChoice === opt.value ? "#313244" : "transparent",
                border: repoChoice === opt.value ? "1px solid #45475a" : "1px solid transparent",
              }}
            >
              <input
                type="radio"
                name="repoChoice"
                value={opt.value}
                checked={repoChoice === opt.value}
                onChange={() => setRepoChoice(opt.value)}
                style={{ accentColor: "#89b4fa" }}
              />
              <div>
                <div style={{ fontSize: 12, color: "#cdd6f4" }}>{opt.label}</div>
                <div style={{ fontSize: 10, color: "#6c7086" }}>{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        {/* Branch name (new worktree only) */}
        {repoChoice === "worktree" && (
          <>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Branch Name</label>
            <input
              data-testid="ws-create-branch"
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

        {/* Directory (import_worktree only) */}
        {repoChoice === "import_worktree" && (
          <>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>
              Existing Worktree Directory
            </label>
            <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
              <input
                data-testid="ws-create-directory"
                type="text"
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="C:\\repos\\project-worktree"
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
            {worktreeInfo && (
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
            {!worktreeInfo && directory && (
              <div style={{ fontSize: 11, color: "#585b70", marginBottom: 14 }}>
                Pick a directory to detect worktree info
              </div>
            )}
          </>
        )}

        {/* Show resolved directory for base_repo/worktree */}
        {repoChoice !== "import_worktree" && directory && (
          <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14, paddingLeft: 2 }}>
            Directory: {directory}
          </div>
        )}

        {/* Session choice */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Session</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
          {sessionOptions.map((opt) => {
            const isSelected = sessionPref === opt.value;
            return (
              <label
                key={opt.value}
                data-testid={`ws-create-session-${opt.value}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 10px",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: isSelected ? "#313244" : "transparent",
                  border: isSelected ? "1px solid #45475a" : "1px solid transparent",
                }}
              >
                <input
                  type="radio"
                  name="sessionChoice"
                  value={opt.value}
                  checked={isSelected}
                  onChange={() => setSessionPref(opt.value)}
                  style={{ accentColor: "#89b4fa" }}
                />
                <div>
                  <div style={{ fontSize: 12, color: "#cdd6f4" }}>{opt.label}</div>
                  <div style={{ fontSize: 10, color: "#6c7086" }}>{opt.desc}</div>
                </div>
              </label>
            );
          })}
        </div>

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
            data-testid="ws-create-submit"
            onClick={handleSubmit}
            disabled={!name.trim() || !directory || (repoChoice === "worktree" && !branchName.trim())}
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
            {effectiveSession === "existing" ? "Create & Pick Session" : "Create Workstream"}
          </button>
        </div>
      </div>
    </div>
  );
}

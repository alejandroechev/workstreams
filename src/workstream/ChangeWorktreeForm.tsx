import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Project, Tile, Workstream } from "../domain/types";
import { projectOwningPath } from "../domain/worktree-path";

export interface ChangeWorktreeFormProps {
  workstream: Workstream;
  tiles: Tile[];
  /**
   * Known repos, used to tell the user *before* they submit when the chosen
   * directory belongs to a different repo — or to none. Optional so the form
   * stays usable in contexts that do not have the list.
   */
  projects?: Project[];
  onCancel: () => void;
  onSubmit: (
    mode: "switch_existing" | "create_new",
    opts: {
      directory?: string;
      branchName?: string;
      folderName?: string;
      /** create_new only: fetch + fast-forward local base before
       *  branching from it. Backend treats failures as non-fatal. */
      pullBaseFirst?: boolean;
    },
  ) => Promise<void>;
}

type ChangeWorktreeMode = "switch_existing" | "create_new";

interface WorktreeInfo {
  is_worktree: boolean;
  parent_repo_path: string | null;
  parent_repo_name: string | null;
  branch: string | null;
  git_remote: string | null;
}

const modalBackdropStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalShellStyle: CSSProperties = {
  background: "#1e1e2e",
  border: "1px solid #313244",
  borderRadius: 8,
  width: 480,
  padding: "20px 24px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
};

const inputStyle: CSSProperties = {
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
};

const labelStyle: CSSProperties = {
  fontSize: 11,
  color: "#a6adc8",
  display: "block",
  marginBottom: 4,
};

function deriveFolderName(branchName: string): string {
  const trimmed = branchName.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChangeWorktreeForm({ workstream, tiles, projects, onCancel, onSubmit }: ChangeWorktreeFormProps): JSX.Element {
  const [mode, setMode] = useState<ChangeWorktreeMode>("switch_existing");
  const [directory, setDirectory] = useState("");
  const [branchName, setBranchName] = useState("");
  const [folderNameOverride, setFolderNameOverride] = useState("");
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pullBaseFirst, setPullBaseFirst] = useState(true);

  const derivedFolderName = deriveFolderName(branchName);
  const effectiveFolderName = folderNameOverride.trim() || derivedFolderName;
  // Which repo the chosen directory belongs to. Resolved from the detected
  // repo ROOT, not the directory itself, so a worktree resolves to its parent
  // repo exactly as the backend does.
  const targetRepo =
    projects && worktreeInfo?.parent_repo_path
      ? projectOwningPath(projects, worktreeInfo.parent_repo_path)
      : null;
  const currentRepo = projects?.find((p) => p.id === workstream.project_id) ?? null;

  const repoChange =
    mode === "switch_existing" && targetRepo && targetRepo.id !== workstream.project_id
      ? { from: currentRepo?.name ?? "no repo", to: targetRepo.name }
      : null;

  // Only a workstream with a repo to lose is blocked; one created without a
  // repo could always switch freely, and blocking that would be a regression
  // unrelated to changing repo. Mirrors the backend rule.
  const repoUnknown =
    mode === "switch_existing" &&
    Boolean(projects) &&
    Boolean(directory.trim()) &&
    Boolean(workstream.project_id) &&
    !targetRepo;

  const canSubmit =
    mode === "switch_existing" ? !!directory.trim() && !repoUnknown : !!branchName.trim();

  const pickDirectory = async () => {
    const selectedDirectory = await open({ directory: true, title: "Select worktree directory" });
    if (!selectedDirectory) return;

    const pickedDirectory = selectedDirectory as string;
    setDirectory(pickedDirectory);
    setWorktreeInfo(null);
    setError(null);

    try {
      const info = await invoke<WorktreeInfo>("detect_worktree_info", { directory: pickedDirectory });
      setWorktreeInfo(info);
    } catch {
      setWorktreeInfo(null);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);
    try {
      if (mode === "switch_existing") {
        await onSubmit("switch_existing", { directory: directory.trim() });
      } else {
        await onSubmit("create_new", {
          branchName: branchName.trim(),
          folderName: effectiveFolderName,
          pullBaseFirst,
        });
      }
      onCancel();
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setIsSubmitting(false);
    }
  };

  const modeOptions: { value: ChangeWorktreeMode; label: string; desc: string }[] = [
    { value: "switch_existing", label: "Switch Existing", desc: "Move this workstream to an existing worktree directory" },
    { value: "create_new", label: "Create New", desc: "Create a new worktree branch and move sessions there" },
  ];

  return (
    <div data-testid="cwt-form" style={modalBackdropStyle} onClick={(event) => event.stopPropagation()}>
      <div style={modalShellStyle} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14 }}>Change Worktree</div>
          <button
            onClick={onCancel}
            style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", fontSize: 12, padding: "2px 6px", lineHeight: 1 }}
            title="Close"
          >
            Close
          </button>
        </div>

        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Mode</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
          {modeOptions.map((option) => (
            <label
              key={option.value}
              data-testid={`cwt-mode-${option.value}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 4,
                cursor: "pointer",
                background: mode === option.value ? "#313244" : "transparent",
                border: mode === option.value ? "1px solid #45475a" : "1px solid transparent",
              }}
            >
              <input
                type="radio"
                name="changeWorktreeMode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => {
                  setMode(option.value);
                  setError(null);
                }}
                style={{ accentColor: "#89b4fa" }}
              />
              <div>
                <div style={{ fontSize: 12, color: "#cdd6f4" }}>{option.label}</div>
                <div style={{ fontSize: 10, color: "#6c7086" }}>{option.desc}</div>
              </div>
            </label>
          ))}
        </div>

        {mode === "switch_existing" ? (
          <>
            <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 10, paddingLeft: 2 }}>
              Current: <span style={{ color: "#a6adc8" }}>{workstream.directory || "No directory"}</span>
            </div>
            <button
              onClick={pickDirectory}
              style={{
                background: "#313244",
                border: "1px solid #45475a",
                borderRadius: 4,
                color: "#cdd6f4",
                padding: "8px 12px",
                fontSize: 12,
                cursor: "pointer",
                marginBottom: 10,
              }}
            >
              Pick directory
            </button>
            {directory && (
              <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 8, paddingLeft: 2 }}>
                Selected: <span style={{ color: "#cdd6f4" }}>{directory}</span>
              </div>
            )}
            {repoChange && (
              <div
                data-testid="cwt-repo-change"
                style={{ fontSize: 11, color: "#f9e2af", marginBottom: 10, padding: "6px 8px", background: "#181825", borderRadius: 4 }}
              >
                Repo change: <span style={{ color: "#cdd6f4" }}>{repoChange.from}</span> →{" "}
                <span style={{ color: "#cdd6f4" }}>{repoChange.to}</span>
              </div>
            )}
            {repoUnknown && (
              <div
                data-testid="cwt-repo-unknown"
                role="alert"
                style={{ fontSize: 11, color: "#f38ba8", marginBottom: 10, padding: "6px 8px", background: "#181825", borderRadius: 4 }}
              >
                This directory is not part of any repo Workstreams knows about. Import the repo
                first, then switch to it.
              </div>
            )}
            {worktreeInfo && (
              <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 14, padding: "6px 8px", background: "#181825", borderRadius: 4 }}>
                {worktreeInfo.is_worktree ? (
                  <div style={{ color: "#a6e3a1", marginBottom: 2 }}>Git worktree detected</div>
                ) : (
                  <div style={{ color: "#f9e2af", marginBottom: 2 }}>Regular git repo</div>
                )}
                {worktreeInfo.parent_repo_name && <div>Parent repo: <span style={{ color: "#cdd6f4" }}>{worktreeInfo.parent_repo_name}</span></div>}
                {worktreeInfo.parent_repo_path && <div>Repo path: <span style={{ color: "#585b70" }}>{worktreeInfo.parent_repo_path}</span></div>}
                {worktreeInfo.branch && <div>Branch: <span style={{ color: "#89b4fa" }}>{worktreeInfo.branch}</span></div>}
                {worktreeInfo.git_remote && <div>Remote: <span style={{ color: "#585b70" }}>{worktreeInfo.git_remote}</span></div>}
              </div>
            )}
          </>
        ) : (
          <>
            <label style={labelStyle}>Branch Name</label>
            <input
              data-testid="cwt-branch-name"
              type="text"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") onCancel();
                if (event.key === "Enter") void handleSubmit();
              }}
              placeholder="alejandroe/feature-name"
              autoFocus
              style={{ ...inputStyle, marginBottom: 8 }}
            />
            <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 10, paddingLeft: 2 }}>
              Folder preview: <span style={{ color: "#a6adc8" }}>{effectiveFolderName || "Enter a branch name"}</span>
            </div>
            <label style={labelStyle}>Folder Name Override</label>
            <input
              data-testid="cwt-folder-name"
              type="text"
              value={folderNameOverride}
              onChange={(event) => setFolderNameOverride(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={derivedFolderName || "feature-name"}
              style={{ ...inputStyle, marginBottom: 10 }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14, cursor: "pointer", fontSize: 11, color: "#a6adc8" }}>
              <input
                data-testid="cwt-pull-base"
                type="checkbox"
                checked={pullBaseFirst}
                onChange={(e) => setPullBaseFirst(e.target.checked)}
              />
              <span>Pull latest base branch first (recommended)</span>
            </label>
          </>
        )}

        {error && (
          <div role="alert" style={{ fontSize: 11, color: "#f38ba8", marginBottom: 14, padding: "6px 8px", background: "#181825", borderRadius: 4 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            data-testid="cwt-cancel"
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
            data-testid="cwt-submit"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || isSubmitting}
            style={{
              padding: "8px 20px",
              background: !canSubmit || isSubmitting ? "#45475a" : "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              cursor: !canSubmit || isSubmitting ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

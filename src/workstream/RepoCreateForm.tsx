// @test-skip: form component, behavior covered by backend create_git_repo tests
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { PROJECT_PRESET_COLORS, isCustomProjectColor } from "../domain/colors";

interface CreateRepoResult {
  directory: string;
  git_remote: string | null;
  branch: string;
}

interface Props {
  onCreated: (name: string, directory: string, color: string, gitRemote: string | null) => void;
  onCancel: () => void;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export default function RepoCreateForm({ onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [color, setColor] = useState(PROJECT_PRESET_COLORS[0].hex);
  const [createRemote, setCreateRemote] = useState(false);
  const [owner, setOwner] = useState("alejandroechev");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_PATTERN.test(name.trim()) && name.trim() !== "." && name.trim() !== "..";
  const canSubmit = !submitting && nameValid && parent.trim() !== "" && (!createRemote || owner.trim() !== "");

  const pickParent = async () => {
    const dir = await open({ directory: true, title: "Select parent directory" });
    if (dir) setParent(dir as string);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await invoke<CreateRepoResult>("create_git_repo", {
        parent: parent.trim(),
        name: name.trim(),
        defaultBranch: "master",
        createReadme: true,
        createGitignore: true,
        initialCommit: true,
        createGithubRemote: createRemote,
        githubOwner: createRemote ? owner.trim() : null,
        githubVisibility: createRemote ? visibility : null,
      });
      onCreated(name.trim(), result.directory, color, result.git_remote);
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

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
          width: 460,
          padding: "20px 24px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
        data-testid="repo-create-form"
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14 }}>Create New Repo</div>
          <button
            onClick={onCancel}
            style={{ background: "none", border: "none", color: "#585b70", cursor: "pointer", fontSize: 16, padding: "2px 6px", lineHeight: 1 }}
            title="Close"
          >✕</button>
        </div>

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
          placeholder="my-new-repo"
          autoFocus
          style={{
            width: "100%",
            background: "#313244",
            border: `1px solid ${name && !nameValid ? "#f38ba8" : "#45475a"}`,
            borderRadius: 4,
            color: "#cdd6f4",
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
            marginBottom: name && !nameValid ? 4 : 12,
          }}
        />
        {name && !nameValid && (
          <div style={{ fontSize: 11, color: "#f38ba8", marginBottom: 8 }}>
            Name must start alphanumeric; only letters, digits, dot, dash, underscore.
          </div>
        )}

        {/* Parent directory */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Parent directory</label>
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <input
            type="text"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="C:\\Code"
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
            onClick={pickParent}
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
        {name && parent && nameValid && (
          <div style={{ fontSize: 11, color: "#6c7086", marginBottom: 12, fontFamily: "monospace" }}>
            → {parent}\{name}
          </div>
        )}

        {/* Color */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Color</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {PROJECT_PRESET_COLORS.map((c) => (
            <button
              key={c.hex}
              onClick={() => setColor(c.hex)}
              title={c.name}
              style={{
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: c.hex,
                border: color === c.hex ? "2px solid #cdd6f4" : "2px solid transparent",
                cursor: "pointer",
                outline: color === c.hex ? "2px solid #89b4fa" : "none",
                outlineOffset: 2,
              }}
            />
          ))}
          <label
            title="Custom"
            style={{
              position: "relative",
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: isCustomProjectColor(color) ? color : "transparent",
              border: isCustomProjectColor(color) ? "2px solid #cdd6f4" : "2px dashed #585b70",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ color: isCustomProjectColor(color) ? "#1e1e2e" : "#585b70", fontSize: 14, lineHeight: 1, pointerEvents: "none" }}>+</span>
            <input
              type="color"
              value={isCustomProjectColor(color) ? color : "#cdd6f4"}
              onChange={(e) => setColor(e.target.value)}
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
            />
          </label>
        </div>

        {/* GitHub remote */}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#cdd6f4", marginBottom: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={createRemote}
            onChange={(e) => setCreateRemote(e.target.checked)}
          />
          Create GitHub remote (via gh)
        </label>
        {createRemote && (
          <div style={{ marginLeft: 22, marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Owner</label>
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              style={{
                width: "100%",
                background: "#313244",
                border: "1px solid #45475a",
                borderRadius: 4,
                color: "#cdd6f4",
                padding: "6px 10px",
                fontSize: 12,
                fontFamily: "monospace",
                outline: "none",
                boxSizing: "border-box",
                marginBottom: 8,
              }}
            />
            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#cdd6f4", cursor: "pointer" }}>
                <input type="radio" name="vis" checked={visibility === "private"} onChange={() => setVisibility("private")} />
                Private
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#cdd6f4", cursor: "pointer" }}>
                <input type="radio" name="vis" checked={visibility === "public"} onChange={() => setVisibility("public")} />
                Public
              </label>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: "#3a1f23", border: "1px solid #f38ba8", borderRadius: 4,
            color: "#f38ba8", fontSize: 11, padding: "6px 10px", marginBottom: 12,
            fontFamily: "monospace", whiteSpace: "pre-wrap", maxHeight: 100, overflowY: "auto",
          }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onCancel}
            disabled={submitting}
            style={{
              padding: "8px 16px",
              background: "#313244",
              color: "#a6adc8",
              border: "none",
              borderRadius: 4,
              cursor: submitting ? "default" : "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: "8px 20px",
              background: !canSubmit ? "#45475a" : "#a6e3a1",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              cursor: !canSubmit ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {submitting ? "Creating..." : "Create Repo"}
          </button>
        </div>
      </div>
    </div>
  );
}

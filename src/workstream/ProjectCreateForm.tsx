// @test-skip: form component, behavior covered by backend create tests
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { PROJECT_PRESET_COLORS, isCustomProjectColor } from "../domain/colors";

interface Props {
  onSubmit: (name: string, directory: string, color: string, gitRemote: string | null) => void;
  onCancel: () => void;
}

export default function ProjectCreateForm({ onSubmit, onCancel }: Props) {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [color, setColor] = useState(PROJECT_PRESET_COLORS[0].hex);
  const [gitRemote, setGitRemote] = useState<string | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  const pickDirectory = async () => {
    const dir = await open({ directory: true, title: "Select project directory" });
    if (dir) {
      setDirectory(dir as string);
      try {
        const [repo, branch] = await invoke<[string | null, string | null]>("detect_git_info", { directory: dir });
        setGitRemote(repo);
        setGitBranch(branch);
        if (repo && !name) setName(repo);
      } catch {
        setGitRemote(null);
        setGitBranch(null);
      }
    }
  };

  const handleSubmit = () => {
    if (!name.trim() || !directory.trim()) return;
    onSubmit(name.trim(), directory.trim(), color, gitRemote);
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
          width: 440,
          padding: "20px 24px",
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ color: "#cdd6f4", fontWeight: 600, fontSize: 14 }}>
            New Repo
          </div>
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
          placeholder="My Repo"
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
            marginBottom: 12,
          }}
        />

        {/* Directory */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 4 }}>Directory</label>
        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <input
            type="text"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="C:\\Repos\\..."
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

        {/* Git info (auto-detected) */}
        {gitRemote && (
          <div style={{ fontSize: 11, color: "#a6e3a1", marginBottom: 12, paddingLeft: 2 }}>
            Git: {gitRemote}{gitBranch ? ` → ${gitBranch}` : ""}
          </div>
        )}

        {/* Color */}
        <label style={{ fontSize: 11, color: "#a6adc8", display: "block", marginBottom: 6 }}>Color</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
          {PROJECT_PRESET_COLORS.map((c) => (
            <button
              key={c.hex}
              onClick={() => setColor(c.hex)}
              title={c.name}
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: c.hex,
                border: color === c.hex ? "2px solid #cdd6f4" : "2px solid transparent",
                cursor: "pointer",
                outline: color === c.hex ? "2px solid #89b4fa" : "none",
                outlineOffset: 2,
                transition: "outline 0.1s",
              }}
            />
          ))}
          <label
            title="Pick a custom color"
            style={{
              position: "relative",
              width: 28,
              height: 28,
              borderRadius: "50%",
              background: isCustomProjectColor(color) ? color : "transparent",
              border: isCustomProjectColor(color) ? "2px solid #cdd6f4" : "2px dashed #585b70",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              outline: isCustomProjectColor(color) ? "2px solid #89b4fa" : "none",
              outlineOffset: 2,
            }}
          >
            <span style={{ color: isCustomProjectColor(color) ? "#1e1e2e" : "#585b70", fontSize: 16, lineHeight: 1, pointerEvents: "none" }}>+</span>
            <input
              type="color"
              value={isCustomProjectColor(color) ? color : "#cdd6f4"}
              onChange={(e) => setColor(e.target.value)}
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
            />
          </label>
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
            onClick={handleSubmit}
            disabled={!name.trim() || !directory.trim()}
            style={{
              padding: "8px 20px",
              background: !name.trim() || !directory.trim() ? "#45475a" : "#89b4fa",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 4,
              cursor: !name.trim() || !directory.trim() ? "default" : "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Create Repo
          </button>
        </div>
      </div>
    </div>
  );
}

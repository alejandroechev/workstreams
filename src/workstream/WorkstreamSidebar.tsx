import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Workstream } from "./types";

interface Props {
  workstreams: Workstream[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string, directory: string, command?: string) => void;
  onDelete: (id: string) => void;
}

export default function WorkstreamSidebar({
  workstreams,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDir, setNewDir] = useState("");
  const [newCmd, setNewCmd] = useState("pwsh.exe");
  const [gitInfo, setGitInfo] = useState<{ repo?: string; branch?: string }>({});

  const pickDirectory = async () => {
    const dir = await open({ directory: true, title: "Select workstream directory" });
    if (dir) {
      setNewDir(dir as string);
      // Auto-detect git info
      try {
        const [repo, branch] = await invoke<[string | null, string | null]>("detect_git_info", { directory: dir });
        setGitInfo({ repo: repo || undefined, branch: branch || undefined });
        if (repo && !newName) setNewName(repo);
      } catch {
        setGitInfo({});
      }
    }
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    onCreate(newName.trim(), newDir || "C:\\", newCmd || undefined);
    setShowCreate(false);
    setNewName("");
    setNewDir("");
    setNewCmd("pwsh.exe");
    setGitInfo({});
  };

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
      <div
        style={{
          padding: "12px 14px 8px",
          fontSize: 11,
          fontWeight: 600,
          color: "#585b70",
          textTransform: "uppercase",
          letterSpacing: 1,
        }}
      >
        Workstreams
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "0 6px" }}>
        {workstreams.map((ws) => (
          <div
            key={ws.id}
            onClick={() => onSelect(ws.id)}
            style={{
              padding: "8px 10px",
              marginBottom: 2,
              borderRadius: 4,
              cursor: "pointer",
              background: ws.id === activeId ? "#1e1e2e" : "transparent",
              border:
                ws.id === activeId
                  ? "1px solid #313244"
                  : "1px solid transparent",
              transition: "background 0.1s",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 4,
                fontSize: 13,
                color: ws.id === activeId ? "#cdd6f4" : "#a6adc8",
                fontWeight: ws.id === activeId ? 500 : 400,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                <span style={{ color: statusColor(ws.status), fontSize: 10, flexShrink: 0 }}>
                  {statusIcon(ws.status)}
                </span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {ws.name}
                </span>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(ws.id);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#45475a",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "0 2px",
                  lineHeight: 1,
                  flexShrink: 0,
                  opacity: ws.id === activeId ? 1 : 0,
                  transition: "opacity 0.1s",
                }}
                title="Delete workstream"
              >
                ✕
              </button>
            </div>
            {(ws.git_repo || ws.directory) && (
              <div
                style={{
                  fontSize: 10,
                  color: "#585b70",
                  marginTop: 2,
                  marginLeft: 18,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {ws.git_repo ? `${ws.git_repo}` : ""}
                {ws.git_branch ? ` → ${ws.git_branch}` : ""}
                {!ws.git_repo && ws.directory ? ws.directory : ""}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Create workstream form */}
      {showCreate && (
        <div style={{ padding: "8px 8px 0", borderTop: "1px solid #313244" }}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Workstream name"
            autoFocus
            style={{
              width: "100%",
              background: "#313244",
              border: "1px solid #45475a",
              borderRadius: 4,
              color: "#cdd6f4",
              padding: "5px 8px",
              fontSize: 12,
              fontFamily: "monospace",
              marginBottom: 4,
              outline: "none",
              boxSizing: "border-box",
            }}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
          <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
            <input
              type="text"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              placeholder="Directory..."
              style={{
                flex: 1,
                background: "#313244",
                border: "1px solid #45475a",
                borderRadius: 4,
                color: "#cdd6f4",
                padding: "5px 8px",
                fontSize: 11,
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
                padding: "4px 8px",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              📁
            </button>
          </div>
          {gitInfo.repo && (
            <div style={{ fontSize: 10, color: "#a6e3a1", marginBottom: 4, paddingLeft: 2 }}>
              Git: {gitInfo.repo}{gitInfo.branch ? ` → ${gitInfo.branch}` : ""}
            </div>
          )}
          <input
            type="text"
            value={newCmd}
            onChange={(e) => setNewCmd(e.target.value)}
            placeholder="Shell command (default: pwsh.exe)"
            style={{
              width: "100%",
              background: "#313244",
              border: "1px solid #45475a",
              borderRadius: 4,
              color: "#cdd6f4",
              padding: "5px 8px",
              fontSize: 11,
              fontFamily: "monospace",
              marginBottom: 6,
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            <button
              onClick={handleCreate}
              style={{
                flex: 1,
                padding: "6px 0",
                background: "#89b4fa",
                color: "#1e1e2e",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Create
            </button>
            <button
              onClick={() => setShowCreate(false)}
              style={{
                padding: "6px 12px",
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
          </div>
        </div>
      )}

      <div style={{ padding: 8 }}>
        <button
          onClick={() => setShowCreate(!showCreate)}
          style={{
            width: "100%",
            padding: "8px 0",
            background: "#313244",
            color: "#cdd6f4",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
            fontFamily: "inherit",
          }}
        >
          + New Workstream
        </button>
      </div>
    </div>
  );
}

import { ReactNode, useState } from "react";
import TerminalTile from "../tiles/TerminalTile";
import CopilotSessionTile from "../tiles/CopilotSessionTile";
import ExplorerTile from "../tiles/ExplorerTile";
import type { Tile } from "../workstream/types";
import type { CopilotSessionStats } from "../domain/types";
import { invoke } from "@tauri-apps/api/core";

interface TileProps {
  tile: Tile;
  index: number;
  isFocused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
  workstreamDir?: string;
  alreadyRunning?: boolean;
}

export default function TileWrapper({
  tile,
  index,
  isFocused,
  onFocus,
  onClose,
  onOpenFile,
  workstreamDir,
  alreadyRunning,
}: TileProps) {
  const [termStatus, setTermStatus] = useState<string>("running");
  const [sessionStats, setSessionStats] = useState<CopilotSessionStats | null>(null);

  const isSessionTile = tile.tile_type === "copilot_session";
  const isTermLike = tile.tile_type === "terminal" || isSessionTile;

  const statusColor = () => {
    if (!isTermLike) return "#89b4fa";
    if (isSessionTile) {
      switch (termStatus) {
        case "running": return "#a6e3a1";
        case "starting": case "resuming": return "#f9e2af";
        case "exited": return "#6c7086";
        default: return "#a6e3a1";
      }
    }
    switch (termStatus) {
      case "running": return "#a6e3a1";
      case "spawning": return "#f9e2af";
      case "exited": return "#6c7086";
      case "failed": return "#f38ba8";
      default: return "#a6e3a1";
    }
  };

  const statusLabel = () => {
    if (isSessionTile) {
      const cfg = JSON.parse(tile.config_json || "{}");
      const name = cfg.session_name || "session";
      const ctx = sessionStats?.context_percent != null ? ` · ${Math.round(sessionStats.context_percent)}%` : "";
      const turns = sessionStats?.turn_count != null ? ` · ${sessionStats.turn_count}t` : "";
      return `${name}${ctx}${turns}`;
    }
    if (tile.tile_type === "terminal") return termStatus;
    return tile.tile_type.replace("_", " ");
  };

  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await invoke("close_terminal", { tileId: tile.id }).catch(() => {});
      const config = JSON.parse(tile.config_json || "{}");
      await invoke("spawn_terminal", {
        tileId: tile.id,
        cwd: config.cwd || "C:\\",
        command: config.command || null,
        rows: 30,
        cols: 120,
      });
      setTermStatus("running");
    } catch {
      setTermStatus("failed");
    }
  };

  const handleKill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await invoke("close_terminal", { tileId: tile.id }).catch(() => {});
    setTermStatus("exited");
  };

  let content: ReactNode;
  switch (tile.tile_type) {
    case "terminal":
      content = (
        <TerminalTile
          tileId={tile.id}
          isFocused={isFocused}
          onStatusChange={setTermStatus}
        />
      );
      break;
    case "copilot_session": {
      const cfg = JSON.parse(tile.config_json || "{}");
      content = (
        <CopilotSessionTile
          tileId={tile.id}
          configJson={tile.config_json}
          isFocused={isFocused}
          isResuming={cfg.is_resumed === true}
          alreadyRunning={alreadyRunning}
          onStatusChange={setTermStatus}
          onStatsUpdate={setSessionStats}
        />
      );
      break;
    }
    case "code_viewer":
    case "doc_viewer":
    case "file_viewer": {
      const cfg = JSON.parse(tile.config_json || "{}");
      content = (
        <ExplorerTile
          tileId={tile.id}
          isFocused={isFocused}
          rootDir={workstreamDir || "C:\\"}
          initialPath={cfg.filePath}
        />
      );
      break;
    }
    case "file_explorer":
      content = (
        <ExplorerTile
          tileId={tile.id}
          isFocused={isFocused}
          rootDir={workstreamDir || "C:\\"}
        />
      );
      break;
    default:
      content = <div>Unknown tile type: {tile.tile_type}</div>;
  }

  return (
    <div
      style={{
        gridArea: `t${index}`,
        display: "flex",
        flexDirection: "column",
        border: isFocused
          ? "2px solid #89b4fa"
          : "1px solid #313244",
        borderRadius: 6,
        overflow: "hidden",
        background: "#1e1e2e",
        transition: "border-color 0.15s",
      }}
      onMouseDownCapture={() => {
        // Focus this tile on any click within it (capture phase fires before children)
        onFocus();
      }}
    >
      {/* Tile header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 10px",
          background: "#181825",
          borderBottom: "1px solid #313244",
          fontSize: 12,
          color: "#a6adc8",
          userSelect: "none",
          minHeight: 28,
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: statusColor(),
              display: "inline-block",
            }}
          />
          <span style={{ color: "#cdd6f4", fontWeight: 500 }}>
            {tile.title || tile.tile_type}
          </span>
          <span style={{ color: "#585b70", fontSize: 10 }}>
            {statusLabel()}
          </span>
          <span style={{ color: "#45475a", fontSize: 10 }}>
            [{index + 1}]
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {isTermLike && (
            <>
              <button
                onClick={handleRestart}
                style={{
                  background: "none",
                  border: "none",
                  color: "#585b70",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "0 3px",
                  lineHeight: 1,
                }}
                title="Restart terminal"
              >
                ↻
              </button>
              <button
                onClick={handleKill}
                style={{
                  background: "none",
                  border: "none",
                  color: "#585b70",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "0 3px",
                  lineHeight: 1,
                }}
                title="Kill process"
              >
                ■
              </button>
            </>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              background: "none",
              border: "none",
              color: "#585b70",
              cursor: "pointer",
              fontSize: 14,
              padding: "0 4px",
              lineHeight: 1,
            }}
            title="Close tile"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Tile content */}
      <div style={{ flex: 1, overflow: "hidden" }}>{content}</div>
    </div>
  );
}

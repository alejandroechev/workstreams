import { ReactNode, useState } from "react";
import TerminalTile from "../tiles/TerminalTile";
import CopilotSessionTile from "../tiles/CopilotSessionTile";
import ExplorerTile from "../tiles/ExplorerTile";
import SessionMetaTile from "../tiles/SessionMetaTile";
import WorkbenchTile from "../tiles/WorkbenchTile";
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
  onLinkSession?: (tileId: string) => void;
  onAutoLink?: (tileId: string, sessionId: string, summary?: string) => void;
  onRestart?: (tileId: string) => void;
  onUpdateTileConfig?: (tileId: string, configJson: string) => void;
  workstreamDir?: string;
  alreadyRunning?: boolean;
  linkedSessionIds?: string[];
}

export default function TileWrapper({
  tile,
  index,
  isFocused,
  onFocus,
  onClose,
  onOpenFile,
  onLinkSession,
  onAutoLink,
  onRestart,
  onUpdateTileConfig,
  workstreamDir,
  alreadyRunning,
  linkedSessionIds,
}: TileProps) {
  const [termStatus, setTermStatus] = useState<string>("running");
  const [sessionStats, setSessionStats] = useState<CopilotSessionStats | null>(null);

  const isSessionTile = tile.tile_type === "copilot_session";
  const isTermLike = tile.tile_type === "terminal" || isSessionTile;

  const statusColor = () => {
    if (!isTermLike) return "#89b4fa";
    if (isSessionTile) {
      // Use activity_status from poller if available
      const activity = sessionStats?.activity_status;
      if (activity) {
        switch (activity) {
          case "working": return "#a6e3a1";  // green — actively responding
          case "waiting": return "#89b4fa";   // blue — waiting for input
          case "idle": return "#f9e2af";      // yellow — idle
          case "stale": return "#6c7086";     // grey — stale
        }
      }
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
      const activity = sessionStats?.activity_status || termStatus;
      const turns = sessionStats?.turn_count != null ? ` · ${sessionStats.turn_count}t` : "";
      return `${name} · ${activity}${turns}`;
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
          onLinkSession={onLinkSession ? () => onLinkSession(tile.id) : undefined}
          onAutoLink={onAutoLink ? (sid, summary) => onAutoLink(tile.id, sid, summary) : undefined}
          onRestart={onRestart ? () => onRestart(tile.id) : undefined}
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
    case "session_meta":
      content = (
        <SessionMetaTile
          tileId={tile.id}
          isFocused={isFocused}
          workstreamDir={workstreamDir}
          linkedSessionIds={linkedSessionIds}
        />
      );
      break;
    case "workbench":
      content = (
        <WorkbenchTile
          tileId={tile.id}
          isFocused={isFocused}
          configJson={tile.config_json}
          onConfigChange={(cfg) => onUpdateTileConfig?.(tile.id, cfg)}
        />
      );
      break;
    default:
      content = <div>Unknown tile type: {tile.tile_type}</div>;
  }

  const isWorking = isSessionTile && sessionStats?.activity_status === "working";

  return (
    <div
      data-tile-id={tile.id}
      className={isWorking ? "tile-working" : undefined}
      style={{
        gridArea: `t${index}`,
        display: "flex",
        flexDirection: "column",
        border: isFocused
          ? `2px solid ${isWorking ? "#a6e3a1" : "#89b4fa"}`
          : `1px solid ${isWorking ? "#a6e3a1" : "#313244"}`,
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
            className={isWorking ? "status-dot-working" : undefined}
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

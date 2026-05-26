// @test-skip: Thin React wrapper; pure border logic in tile-border.ts is tested
import { ReactNode, createElement, useEffect, useMemo, useRef, useState } from "react";
import TerminalTile from "../tiles/TerminalTile";
import CopilotSessionTile from "../tiles/CopilotSessionTile";
import RepoExplorerTile from "../tiles/RepoExplorerTile";
import SessionMetaTile from "../tiles/SessionMetaTile";
import WorkbenchTile from "../tiles/WorkbenchTile";
import PlanTile from "../tiles/PlanTile";
import DiffReviewTile from "../tiles/DiffReviewTile";
import type { Tile } from "../workstream/types";
import type { CopilotSessionStats } from "../domain/types";
import { invoke } from "@tauri-apps/api/core";
import { computeTileBorder } from "./tile-border";
import { resolveTileIcon } from "./tile-icons";

interface TileProps {
  tile: Tile;
  index: number;
  isFocused: boolean;
  focusToken?: number;
  isFullscreen?: boolean;
  /** When true the tile renders into the DOM but is invisible (display:none). */
  hidden?: boolean;
  onFocus: () => void;
  onClose: () => void;
  onOpenFile?: (path: string) => void;
  onLinkSession?: (tileId: string) => void;
  onAutoLink?: (tileId: string, sessionId: string, summary?: string) => void;
  onRestart?: (tileId: string) => void;
  onUpdateTileConfig?: (tileId: string, configJson: string, title?: string) => void;
  workstreamDir?: string;
  workstreamId?: string;
  alreadyRunning?: boolean;
  linkedSessionIds?: string[];
}

export default function TileWrapper({
  tile,
  index,
  isFocused,
  focusToken,
  isFullscreen = false,
  hidden = false,
  onFocus,
  onClose,
  onOpenFile,
  onLinkSession,
  onAutoLink,
  onRestart,
  onUpdateTileConfig,
  workstreamDir,
  workstreamId,
  alreadyRunning,
  linkedSessionIds,
}: TileProps) {
  const [termStatus, setTermStatus] = useState<string>("running");
  const [sessionStats, setSessionStats] = useState<CopilotSessionStats | null>(null);

  const isSessionTile = tile.tile_type === "copilot_session";
  const isTermLike = tile.tile_type === "terminal" || isSessionTile;

  const statusLabel = () => {
    if (isSessionTile) {
      const cfg = JSON.parse(tile.config_json || "{}");
      const name = cfg.session_name || "session";
      const activity = sessionStats?.activity_status || termStatus;
      const friendlyActivity = activity === "no-session" ? "not linked" : activity;
      const toolInfo = sessionStats?.current_tool ? ` (${sessionStats.current_tool})` : "";
      const turns = sessionStats?.turn_count != null && sessionStats.turn_count > 0 ? ` · ${sessionStats.turn_count}t` : "";
      return `${name} · ${friendlyActivity}${toolInfo}${turns}`;
    }
    if (tile.tile_type === "terminal") return termStatus;
    if (tile.tile_type === "file_explorer") return "repo explorer";
    if (tile.tile_type === "plan") return "plan";
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
          focusToken={focusToken}
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
          focusToken={focusToken}
          isResuming={cfg.is_resumed === true}
          alreadyRunning={alreadyRunning}
          workstreamId={workstreamId}
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
        <RepoExplorerTile
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
        <RepoExplorerTile
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
    case "plan":
      content = (
        <PlanTile
          tileId={tile.id}
          isFocused={isFocused}
          linkedSessionIds={linkedSessionIds}
        />
      );
      break;
    case "diff_review": {
      const cfg = JSON.parse(tile.config_json || "{}");
      if (!cfg.reviewId) {
        content = (
          <div style={{ padding: 16, color: "#f38ba8" }}>
            Diff Review tile missing reviewId in config.
          </div>
        );
      } else {
        content = (
          <DiffReviewTile
            tileId={tile.id}
            isFocused={isFocused}
            reviewId={cfg.reviewId}
          />
        );
      }
      break;
    }
    default:
      content = <div>Unknown tile type: {tile.tile_type}</div>;
  }

  // Activity is surfaced via the status bar; no in-header dot anymore.

  // Tile-type icon (replaces the old status dot). The icon key can be overridden
  // via `config.icon`; otherwise defaults based on tile_type.
  const tileConfig = useMemo(() => {
    try { return JSON.parse(tile.config_json || "{}"); } catch { return {}; }
  }, [tile.config_json]);
  const TileIcon = useMemo(() => resolveTileIcon(tile.tile_type, tileConfig.icon), [tile.tile_type, tileConfig.icon]);

  // Inline title editing
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(tile.title || "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editingTitle && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingTitle]);
  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== (tile.title || "")) {
      onUpdateTileConfig?.(tile.id, tile.config_json || "{}", next);
    }
    setEditingTitle(false);
  };
  const cancelTitle = () => {
    setTitleDraft(tile.title || "");
    setEditingTitle(false);
  };

  return (
    <div
      data-tile-id={tile.id}
      data-hidden={hidden ? "true" : "false"}
      style={{
        gridArea: hidden ? undefined : `t${index}`,
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        border: computeTileBorder({ isFullscreen, isFocused }),
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
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
          {createElement(TileIcon, { style: { width: 14, height: 14, color: "#89b4fa", flexShrink: 0 } })}
          {editingTitle ? (
            <input
              ref={inputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitTitle();
                else if (e.key === "Escape") cancelTitle();
              }}
              onClick={(e) => e.stopPropagation()}
              data-testid={`tile-title-input-${tile.id}`}
              style={{
                background: "#1e1e2e",
                border: "1px solid #45475a",
                borderRadius: 3,
                color: "#cdd6f4",
                fontSize: 12,
                fontWeight: 500,
                padding: "1px 4px",
                outline: "none",
                minWidth: 80,
                maxWidth: 240,
              }}
            />
          ) : (
            <span
              style={{ color: "#cdd6f4", fontWeight: 500, cursor: "text" }}
              title="Double-click to rename"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setTitleDraft(tile.title || "");
                setEditingTitle(true);
              }}
            >
              {tile.title || tile.tile_type}
            </span>
          )}
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
          {!tileConfig.pinned && (
            <button
              data-testid={`tile-close-${tile.id}`}
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
          )}
          {tileConfig.pinned && (
            <span
              data-testid={`tile-pinned-${tile.id}`}
              title="Pinned to workstream"
              style={{ color: "#585b70", fontSize: 11, padding: "0 4px" }}
            >
              📌
            </span>
          )}
        </div>
      </div>

      {/* Tile content */}
      <div style={{ flex: 1, overflow: "hidden" }}>{content}</div>
    </div>
  );
}

// @test-skip: Thin React wrapper; pure border logic in tile-border.ts is tested
import { ReactNode, createElement, memo, useEffect, useMemo, useRef, useState } from "react";
import TerminalTile from "../tiles/TerminalTile";
import CopilotSessionTile from "../tiles/CopilotSessionTile";
import RepoExplorerTile from "../tiles/RepoExplorerTile";
import SessionMetaTile from "../tiles/SessionMetaTile";
import WorkbenchTile from "../tiles/WorkbenchTile";
import PlanTile from "../tiles/PlanTile";
import DiffReviewTile from "../tiles/DiffReviewTile";
import { isFeatureEnabled, featureDescriptor } from "../domain/feature-flags";

function DisabledFeaturePlaceholder({ label, requires }: { label: string; requires: string }) {
  return (
    <div style={{
      padding: 24,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      height: "100%",
      color: "#a6adc8",
      textAlign: "center",
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#f9e2af" }}>{label} tile is disabled</div>
      <div style={{ fontSize: 11, color: "#6c7086", maxWidth: 360 }}>{requires}</div>
    </div>
  );
}
import type { Tile } from "../workstream/types";
import type { CopilotSessionStats } from "../domain/types";
import { invoke } from "@tauri-apps/api/core";
import { getAppSettings } from "../domain/app-settings";
import { computeTileBorder } from "./tile-border";
import { resolveTileIcon } from "./tile-icons";

interface TileProps {
  tile: Tile;
  index: number;
  /** Explicit CSS grid-area name (e.g. "t0", "sbs-left"). Falls back to t<index>. */
  gridArea?: string;
  isFocused: boolean;
  focusToken?: number;
  isFullscreen?: boolean;
  isSideBySide?: boolean;
  /** When true the tile renders into the DOM but is invisible (display:none). */
  hidden?: boolean;
  /**
   * Whether this tile's owning workstream is currently visible (active).
   * Tiles use this to early-return from event-listen callbacks (fs-change,
   * etc.) when the user can't see the result of the work anyway.
   */
  workstreamVisible?: boolean;
  /** When true the side-by-side selection checkbox is rendered in the header. */
  selectable?: boolean;
  /** Whether this tile is currently selected for side-by-side. */
  isSelected?: boolean;
  /** Toggle the side-by-side selection for this tile. */
  onToggleSelect?: (tileId: string) => void;
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

export default function TileWrapper(props: Parameters<typeof TileWrapperImpl>[0]) {
  return <MemoTileWrapper {...props} />;
}

function TileWrapperImpl({
  tile,
  index,
  gridArea,
  isFocused,
  focusToken,
  isFullscreen = false,
  isSideBySide = false,
  hidden = false,
  workstreamVisible = true,
  selectable = false,
  isSelected = false,
  onToggleSelect,
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
    // Delegate restart to App.tsx's onRestart callback so the correct
    // spawn command runs per tile type (copilot_session → spawnCopilotSession
    // preserving the linked session id; terminal → spawn_terminal preserving
    // command + cwd). Previously this function always called spawn_terminal,
    // which left copilot session tiles stuck and required a second click on
    // the in-tile Restart button.
    if (onRestart) {
      onRestart(tile.id);
      setTermStatus("running");
      return;
    }
    // Fallback (no parent-provided handler): plain spawn_terminal — kept
    // for safety, but shouldn't ever fire since App always provides
    // onRestart for active workstreams.
    try {
      await invoke("close_terminal", { tileId: tile.id }).catch(() => {});
      const config = JSON.parse(tile.config_json || "{}");
      await invoke("spawn_terminal", {
        tileId: tile.id,
        cwd: config.cwd || "C:\\",
        command: config.command || null,
        rows: 30,
        cols: 120,
        enableNoVerifyBlock:
          isFeatureEnabled("no-verify-blocking") && getAppSettings().noVerifyBlockingEnabled,
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
          isFullscreen={isFullscreen}
          onStatusChange={setTermStatus}
        />
      );
      break;
    case "copilot_session": {
      const cfg = JSON.parse(tile.config_json || "{}");
      const thisLinkedId = (cfg.copilot_session_id || cfg.resume_by_id || null) as string | null;
      // Workstream policy: at most one linked Copilot session per workstream.
      // Other linked = any id in linkedSessionIds that isn't this tile's own.
      const workstreamHasOtherLinkedSession = !!linkedSessionIds?.some(
        (id) => id && id !== thisLinkedId,
      );
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
          workstreamHasOtherLinkedSession={workstreamHasOtherLinkedSession}
          isFullscreen={isFullscreen}
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
          workstreamId={workstreamId}
          workstreamVisible={workstreamVisible}
          configJson={tile.config_json}
          onConfigChange={(c) => onUpdateTileConfig?.(tile.id, c)}
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
          workstreamId={workstreamId}
          workstreamVisible={workstreamVisible}
          configJson={tile.config_json}
          onConfigChange={(c) => onUpdateTileConfig?.(tile.id, c)}
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
          workstreamId={workstreamId}
          workstreamVisible={workstreamVisible}
          configJson={tile.config_json}
          onConfigChange={(c) => onUpdateTileConfig?.(tile.id, c)}
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
          workstreamId={workstreamId}
          workstreamVisible={workstreamVisible}
        />
      );
      break;
    case "plan":
      if (!isFeatureEnabled("plan-tile")) {
        const d = featureDescriptor("plan-tile");
        content = <DisabledFeaturePlaceholder label={d.label} requires={d.requires} />;
      } else {
        content = (
          <PlanTile
            tileId={tile.id}
            isFocused={isFocused}
            linkedSessionIds={linkedSessionIds}
            configJson={tile.config_json}
            onConfigChange={(c) => onUpdateTileConfig?.(tile.id, c)}
            workstreamVisible={workstreamVisible}
          />
        );
      }
      break;
    case "diff_review": {
      if (!isFeatureEnabled("diff-review")) {
        const d = featureDescriptor("diff-review");
        content = <DisabledFeaturePlaceholder label={d.label} requires={d.requires} />;
        break;
      }
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
        gridArea: hidden ? undefined : (gridArea ?? `t${index}`),
        display: hidden ? "none" : "flex",
        flexDirection: "column",
        border: computeTileBorder({ isFullscreen, isFocused, isSideBySide }),
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
          {selectable && (
            <input
              type="checkbox"
              data-testid={`tile-sbs-select-${tile.id}`}
              checked={isSelected}
              onChange={() => onToggleSelect?.(tile.id)}
              onClick={(e) => e.stopPropagation()}
              title="Select for side-by-side (Alt+S)"
              style={{
                width: 13,
                height: 13,
                accentColor: "#89b4fa",
                flexShrink: 0,
                cursor: "pointer",
              }}
            />
          )}
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

// Memo wrapper: with the mount-all-workstreams strategy in App.tsx, every
// setState in App can otherwise re-render every Tile across every loaded
// workstream. React.memo with default shallow prop equality is enough
// because most props are stable (tile object, ids, callbacks created
// once); the isFocused/hidden/focusToken trio captures the per-tile
// reasons to actually re-render.
const MemoTileWrapper = memo(TileWrapperImpl);

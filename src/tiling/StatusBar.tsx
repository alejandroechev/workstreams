// @test-skip: Thin layout wrapper; AddTileMenu (the only logic-bearing child) has its own tests.
import type { ReactNode } from "react";
import { ViewColumnsIcon } from "@heroicons/react/24/outline";
import AddTileMenu from "./AddTileMenu";
import { isFeatureEnabled } from "../domain/feature-flags";
import { supportsWsl, terminalTileLabel, shortcutLabel } from "../domain/platform";
import type { TileIconKey } from "./tile-icons";

interface Props {
  tileCount: number;
  focusedLabel: string;
  fullscreen: boolean;
  sideBySide: boolean;
  /** @deprecated kept for prop compatibility; the button is always enabled now. */
  canEnterSideBySide: boolean;
  /** When true the SBS selection checkboxes are visible across tiles. */
  sbsSelectionMode?: boolean;
  /** When true (no workstream selected), the Add-tile / side-by-side / fullscreen controls are disabled. */
  disabled?: boolean;
  workstreamName?: string;
  onAddSession?: () => void;
  onAddTerminal?: () => void;
  onAddWslTerminal?: () => void;
  onAddExplorer?: () => void;
  onAddSessionMeta?: () => void;
  onAddWorkbench?: () => void;
  onAddPlan?: () => void;
  onAddCodeReview?: () => void;
  onAddWalkthrough?: () => void;
  onAddLoop?: () => void;
  onToggleFullscreen?: () => void;
  onToggleSideBySide?: () => void;
  onOpenSettings?: () => void;
  /**
   * Slot for the active workstream's quick-note bar.
   *
   * Passed in as a node rather than wired here so the tiling layer keeps no
   * dependency on tasks; it renders nothing when the workstream has no bound
   * task, so the bar does not reserve space for it.
   */
  quickNote?: ReactNode;
}

// Icon-only chrome buttons (settings, fullscreen, side-by-side) — beefier
// contrast: lighter background + brighter icon color so the affordance is
// readable against the dark status bar.
const iconBtnStyle: React.CSSProperties = {
  background: "#45475a",
  border: "1px solid #585b70",
  borderRadius: 4,
  color: "#cdd6f4",
  cursor: "pointer",
  fontSize: 13,
  padding: "2px 8px",
  fontFamily: "monospace",
  lineHeight: 1,
};

export default function StatusBar({
  tileCount,
  focusedLabel,
  fullscreen,
  sideBySide,
  canEnterSideBySide: _canEnterSideBySide,
  sbsSelectionMode = false,
  disabled = false,
  workstreamName,
  onAddSession,
  onAddTerminal,
  onAddWslTerminal,
  onAddExplorer,
  onAddSessionMeta,
  onAddWorkbench,
  onAddPlan,
  onAddCodeReview,
  onAddWalkthrough,
  onAddLoop,
  onToggleFullscreen,
  onToggleSideBySide,
  onOpenSettings,
  quickNote,
}: Props) {
  const rawItems: Array<{ key: string; label: string; icon: TileIconKey; shortcut?: string; onSelect?: () => void; gated?: boolean }> = [
    { key: "session", label: "Copilot Session", icon: "session", shortcut: shortcutLabel("C"), onSelect: onAddSession },
    { key: "terminal", label: terminalTileLabel(), icon: "terminal", shortcut: shortcutLabel("T"), onSelect: onAddTerminal },
    // WSL is Windows-only — hide the entry entirely on macOS/Linux.
    { key: "wsl", label: "WSL Terminal", icon: "terminal", shortcut: shortcutLabel("W"), onSelect: onAddWslTerminal, gated: !supportsWsl() },
    { key: "explorer", label: "Repo Explorer", icon: "folder", shortcut: shortcutLabel("R"), onSelect: onAddExplorer },
    { key: "meta", label: "Session Meta", icon: "info", shortcut: shortcutLabel("M"), onSelect: onAddSessionMeta },
    { key: "workbench", label: "Workbench", icon: "beaker", shortcut: shortcutLabel("B"), onSelect: onAddWorkbench },
    { key: "plan", label: "Plan", icon: "plan", shortcut: shortcutLabel("P"), onSelect: onAddPlan, gated: !isFeatureEnabled("plan-tile") },
    { key: "code-review", label: "Code Review", icon: "code", shortcut: shortcutLabel("A"), onSelect: onAddCodeReview },
    { key: "walkthrough", label: "Code Walkthrough", icon: "code", shortcut: shortcutLabel("D"), onSelect: onAddWalkthrough, gated: !isFeatureEnabled("debug-walkthrough") },
    { key: "loop", label: "Goal Loop", icon: "loop", onSelect: onAddLoop },
  ];
  const menuItems = rawItems
    .filter((it) => typeof it.onSelect === "function" && !it.gated)
    .map((it) => ({ key: it.key, label: it.label, icon: it.icon, shortcut: it.shortcut, onSelect: it.onSelect! }));

  return (
    <div
      data-testid="status-bar"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "3px 8px",
        background: "#11111b",
        borderTop: "1px solid #313244",
        fontSize: 11,
        color: "#6c7086",
        fontFamily: "monospace",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexShrink: 0 }}>
        {workstreamName && (
          <span style={{ color: "#89b4fa" }}>⊞ {workstreamName}</span>
        )}
        <span>Tiles: {tileCount}</span>
        <span>Focused: {focusedLabel}</span>
        {fullscreen && (
          <span style={{ color: "#f9e2af" }}>⛶ Full</span>
        )}
        {sideBySide && (
          <span style={{ color: "#cba6f7" }}>⊟ Side-by-side</span>
        )}
      </div>
      {/* Rendered directly, with no wrapper. A wrapper would be truthy even
          when the note itself renders null, so a workstream with no bound task
          would still reserve width in the bar. */}
      {quickNote}

      <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>
        <AddTileMenu items={menuItems} disabled={disabled} />
        {onOpenSettings && (
          <button
            data-testid="open-settings"
            style={iconBtnStyle}
            onClick={onOpenSettings}
            title="Settings"
          >
            ⚙
          </button>
        )}
        {onToggleSideBySide && (
          <button
            data-testid="toggle-sbs"
            disabled={disabled}
            style={{
              ...iconBtnStyle,
              color: sideBySide ? "#cba6f7" : sbsSelectionMode ? "#f9e2af" : "#cdd6f4",
              borderColor: sideBySide ? "#cba6f7" : sbsSelectionMode ? "#f9e2af" : "#585b70",
              background: sideBySide ? "#3a2f4f" : sbsSelectionMode ? "#3a3520" : iconBtnStyle.background,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.4 : 1,
            }}
            onClick={disabled ? undefined : onToggleSideBySide}
            title={
              disabled
                ? "Select a workstream to use side-by-side"
                : sideBySide
                  ? `Exit side-by-side (${shortcutLabel("S")})`
                  : sbsSelectionMode
                    ? `Cancel side-by-side selection (${shortcutLabel("S")})`
                    : `Pick two tiles for side-by-side (${shortcutLabel("S")})`
            }
          >
            <ViewColumnsIcon style={{ width: 13, height: 13, display: "block" }} />
          </button>
        )}
        <button
          data-testid="toggle-fullscreen"
          disabled={disabled}
          style={{
            ...iconBtnStyle,
            color: fullscreen ? "#f9e2af" : "#cdd6f4",
            borderColor: fullscreen ? "#f9e2af" : "#585b70",
            background: fullscreen ? "#3f3a25" : iconBtnStyle.background,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.4 : 1,
          }}
          onClick={disabled ? undefined : onToggleFullscreen}
          title={disabled ? "Select a workstream to use fullscreen" : `Toggle fullscreen (${shortcutLabel("F")})`}
        >
          ⛶
        </button>
      </div>
    </div>
  );
}

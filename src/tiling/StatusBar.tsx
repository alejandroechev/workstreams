// @test-skip: Thin layout wrapper; AddTileMenu (the only logic-bearing child) has its own tests.
import type { ReactNode } from "react";
import { ViewColumnsIcon } from "@heroicons/react/24/outline";
import AddTileMenu from "./AddTileMenu";
import { isTileTypeEnabled } from "../domain/feature-flags";
import { supportsWsl, terminalTileLabel, shortcutLabel } from "../domain/platform";
import { shortcutForMenuKey } from "../domain/keyboard";
import type { TileIconKey } from "./tile-icons";

interface Props {
  tileCount: number;
  focusedLabel: string;
  fullscreen: boolean;
  sideBySide: boolean;
  /** Which split is active or being picked (vertical = next to each other). */
  sideBySideOrientation?: "vertical" | "horizontal";
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
  /** The stacked (horizontal) side-by-side button, next to the vertical one. */
  onToggleSideBySideHorizontal?: () => void;
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
  sideBySideOrientation = "vertical",
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
  onToggleSideBySideHorizontal,
  onOpenSettings,
  quickNote,
}: Props) {
  // One button per orientation: highlighted only when its orientation is the
  // active split, or the one being picked.
  const sbsButton = (orientation: "vertical" | "horizontal", onToggle: () => void) => {
    const mine = sideBySideOrientation === orientation;
    const active = sideBySide && mine;
    const picking = sbsSelectionMode && mine;
    const what = orientation === "vertical" ? "side-by-side" : "one above the other";
    const title = disabled
      ? "Select a workstream to use side-by-side"
      : active
        ? `Exit ${what}${orientation === "vertical" ? ` (${shortcutLabel("S")})` : ""}`
        : sideBySide
          ? `Show the two tiles ${what}`
          : picking
            ? `Cancel ${what} selection${orientation === "vertical" ? ` (${shortcutLabel("S")})` : ""}`
            : orientation === "vertical"
              ? `Pick two tiles for side-by-side (${shortcutLabel("S")}, or Shift-click a tile)`
              : "Pick two tiles to show one above the other (or Option-click a tile)";
    return (
      <button
        data-testid={orientation === "vertical" ? "toggle-sbs" : "toggle-sbs-horizontal"}
        disabled={disabled}
        aria-pressed={active}
        style={{
          ...iconBtnStyle,
          color: active ? "#cba6f7" : picking ? "#f9e2af" : "#cdd6f4",
          borderColor: active ? "#cba6f7" : picking ? "#f9e2af" : "#585b70",
          background: active ? "#3a2f4f" : picking ? "#3a3520" : iconBtnStyle.background,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.4 : 1,
        }}
        onClick={disabled ? undefined : onToggle}
        title={title}
      >
        <ViewColumnsIcon
          style={{ width: 13, height: 13, display: "block", transform: orientation === "horizontal" ? "rotate(90deg)" : undefined }}
        />
      </button>
    );
  };
  const rawItems: Array<{ key: string; label: string; icon: TileIconKey; shortcut?: string; onSelect?: () => void; gated?: boolean }> = [
    { key: "session", label: "Copilot Session", icon: "session", shortcut: shortcutForMenuKey("session"), onSelect: onAddSession },
    { key: "terminal", label: terminalTileLabel(), icon: "terminal", shortcut: shortcutForMenuKey("terminal"), onSelect: onAddTerminal },
    // WSL is Windows-only — hide the entry entirely on macOS/Linux.
    { key: "wsl", label: "WSL Terminal", icon: "terminal", shortcut: shortcutForMenuKey("wsl"), onSelect: onAddWslTerminal, gated: !supportsWsl() },
    { key: "explorer", label: "Repo Explorer", icon: "folder", shortcut: shortcutForMenuKey("explorer"), onSelect: onAddExplorer },
    { key: "meta", label: "Session Meta", icon: "info", shortcut: shortcutForMenuKey("meta"), onSelect: onAddSessionMeta },
    { key: "workbench", label: "Workbench", icon: "beaker", shortcut: shortcutForMenuKey("workbench"), onSelect: onAddWorkbench },
    { key: "plan", label: "Plan", icon: "plan", shortcut: shortcutForMenuKey("plan"), onSelect: onAddPlan },
    { key: "code-review", label: "Code Review", icon: "code", shortcut: shortcutForMenuKey("code-review"), onSelect: onAddCodeReview, gated: !isTileTypeEnabled("code_review") },
    { key: "walkthrough", label: "Code Walkthrough", icon: "code", shortcut: shortcutForMenuKey("walkthrough"), onSelect: onAddWalkthrough, gated: !isTileTypeEnabled("debug_walkthrough") },
    { key: "loop", label: "Goal Loop", icon: "loop", shortcut: shortcutForMenuKey("loop"), onSelect: onAddLoop, gated: !isTileTypeEnabled("loop_control") },
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
          <span style={{ color: "#cba6f7" }}>{sideBySideOrientation === "horizontal" ? "⊟ Stacked" : "◫ Side-by-side"}</span>
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
        {onToggleSideBySide && sbsButton("vertical", onToggleSideBySide)}
        {onToggleSideBySideHorizontal && sbsButton("horizontal", onToggleSideBySideHorizontal)}
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

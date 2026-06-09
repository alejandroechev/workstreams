// @test-skip: Thin layout wrapper; AddTileMenu (the only logic-bearing child) has its own tests.
import { ViewColumnsIcon } from "@heroicons/react/24/outline";
import AddTileMenu from "./AddTileMenu";
import { isFeatureEnabled } from "../domain/feature-flags";

interface Props {
  tileCount: number;
  focusedLabel: string;
  fullscreen: boolean;
  sideBySide: boolean;
  /** @deprecated kept for prop compatibility; the button is always enabled now. */
  canEnterSideBySide: boolean;
  /** When true the SBS selection checkboxes are visible across tiles. */
  sbsSelectionMode?: boolean;
  workstreamName?: string;
  onAddSession?: () => void;
  onAddTerminal?: () => void;
  onAddWslTerminal?: () => void;
  onAddExplorer?: () => void;
  onAddSessionMeta?: () => void;
  onAddWorkbench?: () => void;
  onAddPlan?: () => void;
  onAddDiffReview?: () => void;
  onToggleFullscreen?: () => void;
  onToggleSideBySide?: () => void;
  onOpenSettings?: () => void;
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
  workstreamName,
  onAddSession,
  onAddTerminal,
  onAddWslTerminal,
  onAddExplorer,
  onAddSessionMeta,
  onAddWorkbench,
  onAddPlan,
  onAddDiffReview,
  onToggleFullscreen,
  onToggleSideBySide,
  onOpenSettings,
}: Props) {
  const rawItems: Array<{ key: string; label: string; icon: "session" | "terminal" | "folder" | "info" | "beaker" | "plan" | "bug"; shortcut?: string; onSelect?: () => void; gated?: boolean }> = [
    { key: "session", label: "Copilot Session", icon: "session", shortcut: "Alt+C", onSelect: onAddSession },
    { key: "terminal", label: "PowerShell", icon: "terminal", shortcut: "Alt+T", onSelect: onAddTerminal },
    { key: "wsl", label: "WSL Terminal", icon: "terminal", shortcut: "Alt+W", onSelect: onAddWslTerminal },
    { key: "explorer", label: "Repo Explorer", icon: "folder", shortcut: "Alt+R", onSelect: onAddExplorer },
    { key: "meta", label: "Session Meta", icon: "info", shortcut: "Alt+M", onSelect: onAddSessionMeta },
    { key: "workbench", label: "Workbench", icon: "beaker", shortcut: "Alt+B", onSelect: onAddWorkbench },
    { key: "plan", label: "Plan", icon: "plan", shortcut: "Alt+P", onSelect: onAddPlan, gated: !isFeatureEnabled("plan-tile") },
    { key: "diff-review", label: "Diff Review", icon: "bug", shortcut: "Alt+G", onSelect: onAddDiffReview, gated: !isFeatureEnabled("diff-review") },
  ];
  const menuItems = rawItems
    .filter((it) => typeof it.onSelect === "function" && !it.gated)
    .map((it) => ({ key: it.key, label: it.label, icon: it.icon, shortcut: it.shortcut, onSelect: it.onSelect! }));

  return (
    <div
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
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
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
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <AddTileMenu items={menuItems} />
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
            style={{
              ...iconBtnStyle,
              color: sideBySide ? "#cba6f7" : sbsSelectionMode ? "#f9e2af" : "#cdd6f4",
              borderColor: sideBySide ? "#cba6f7" : sbsSelectionMode ? "#f9e2af" : "#585b70",
              background: sideBySide ? "#3a2f4f" : sbsSelectionMode ? "#3a3520" : iconBtnStyle.background,
              cursor: "pointer",
            }}
            onClick={onToggleSideBySide}
            title={
              sideBySide
                ? "Exit side-by-side (Alt+S)"
                : sbsSelectionMode
                  ? "Cancel side-by-side selection (Alt+S)"
                  : "Pick two tiles for side-by-side (Alt+S)"
            }
          >
            <ViewColumnsIcon style={{ width: 16, height: 16 }} />
          </button>
        )}
        <button
          style={{
            ...iconBtnStyle,
            color: fullscreen ? "#f9e2af" : "#cdd6f4",
            borderColor: fullscreen ? "#f9e2af" : "#585b70",
            background: fullscreen ? "#3f3a25" : iconBtnStyle.background,
          }}
          onClick={onToggleFullscreen}
          title="Toggle fullscreen (Alt+F)"
        >
          ⛶
        </button>
      </div>
    </div>
  );
}

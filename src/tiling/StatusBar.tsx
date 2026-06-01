// @test-skip: Thin layout wrapper; AddTileMenu (the only logic-bearing child) has its own tests.
import AddTileMenu from "./AddTileMenu";

interface Props {
  tileCount: number;
  focusedLabel: string;
  fullscreen: boolean;
  sideBySide: boolean;
  /** True only when a side-by-side toggle is currently valid. */
  canEnterSideBySide: boolean;
  workstreamName?: string;
  onAddSession?: () => void;
  onAddTerminal?: () => void;
  onAddWslTerminal?: () => void;
  onAddExplorer?: () => void;
  onAddSessionMeta?: () => void;
  onAddWorkbench?: () => void;
  onAddPlan?: () => void;
  onAddDiffReview?: () => void;
  onCloseTitle?: () => void;
  onToggleFullscreen?: () => void;
  onToggleSideBySide?: () => void;
  onOpenSettings?: () => void;
}

const btnStyle: React.CSSProperties = {
  background: "#313244",
  border: "none",
  borderRadius: 3,
  color: "#a6adc8",
  cursor: "pointer",
  fontSize: 11,
  padding: "2px 8px",
  fontFamily: "monospace",
};

export default function StatusBar({
  tileCount,
  focusedLabel,
  fullscreen,
  sideBySide,
  canEnterSideBySide,
  workstreamName,
  onAddSession,
  onAddTerminal,
  onAddWslTerminal,
  onAddExplorer,
  onAddSessionMeta,
  onAddWorkbench,
  onAddPlan,
  onAddDiffReview,
  onCloseTitle,
  onToggleFullscreen,
  onToggleSideBySide,
  onOpenSettings,
}: Props) {
  const rawItems: Array<{ key: string; label: string; icon: "session" | "terminal" | "folder" | "info" | "beaker" | "plan" | "bug"; shortcut?: string; onSelect?: () => void }> = [
    { key: "session", label: "Copilot Session", icon: "session", shortcut: "Alt+S", onSelect: onAddSession },
    { key: "terminal", label: "PowerShell", icon: "terminal", shortcut: "Alt+T", onSelect: onAddTerminal },
    { key: "wsl", label: "WSL Terminal", icon: "terminal", shortcut: "Alt+W", onSelect: onAddWslTerminal },
    { key: "explorer", label: "Repo Explorer", icon: "folder", shortcut: "Alt+R", onSelect: onAddExplorer },
    { key: "meta", label: "Session Meta", icon: "info", shortcut: "Alt+M", onSelect: onAddSessionMeta },
    { key: "workbench", label: "Workbench", icon: "beaker", shortcut: "Alt+B", onSelect: onAddWorkbench },
    { key: "plan", label: "Plan", icon: "plan", shortcut: "Alt+P", onSelect: onAddPlan },
    { key: "diff-review", label: "Diff Review", icon: "bug", shortcut: "Alt+G", onSelect: onAddDiffReview },
  ];
  const menuItems = rawItems
    .filter((it) => typeof it.onSelect === "function")
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
          <span style={{ color: "#89b4fa" }}>⊟ Side-by-side</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <AddTileMenu items={menuItems} />
        {onOpenSettings && (
          <button
            data-testid="open-settings"
            style={{ ...btnStyle, color: "#585b70" }}
            onClick={onOpenSettings}
            title="Settings"
          >
            ⚙
          </button>
        )}
        {onToggleSideBySide && (
          <button
            data-testid="toggle-sbs"
            disabled={!sideBySide && !canEnterSideBySide}
            style={{
              ...btnStyle,
              color: sideBySide ? "#89b4fa" : !canEnterSideBySide ? "#3a3b48" : "#585b70",
              cursor: !sideBySide && !canEnterSideBySide ? "default" : "pointer",
            }}
            onClick={onToggleSideBySide}
            title={
              sideBySide
                ? "Exit side-by-side (Alt+C)"
                : canEnterSideBySide
                  ? "Enter side-by-side with selected tiles (Alt+C)"
                  : "Select two tiles to enable side-by-side"
            }
          >
            ⊟
          </button>
        )}
        <button style={{ ...btnStyle, color: "#585b70" }} onClick={onToggleFullscreen} title="Toggle fullscreen">⛶</button>
        <button style={{ ...btnStyle, color: "#585b70" }} onClick={onCloseTitle} title="Close focused tile">✕</button>
      </div>
    </div>
  );
}

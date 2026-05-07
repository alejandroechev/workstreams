interface Props {
  tileCount: number;
  focusedLabel: string;
  fullscreen: boolean;
  workstreamName?: string;
  onAddSession?: () => void;
  onAddTerminal?: () => void;
  onAddExplorer?: () => void;
  onCloseTitle?: () => void;
  onToggleFullscreen?: () => void;
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
  workstreamName,
  onAddSession,
  onAddTerminal,
  onAddExplorer,
  onCloseTitle,
  onToggleFullscreen,
}: Props) {
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
      </div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button style={btnStyle} onClick={onAddSession} title="New Copilot session">+ Session</button>
        <button style={btnStyle} onClick={onAddTerminal} title="New terminal">+ Terminal</button>
        <button style={btnStyle} onClick={onAddExplorer} title="New file explorer">+ Explorer</button>
        <button style={{ ...btnStyle, color: "#585b70" }} onClick={onToggleFullscreen} title="Toggle fullscreen">⛶</button>
        <button style={{ ...btnStyle, color: "#585b70" }} onClick={onCloseTitle} title="Close focused tile">✕</button>
      </div>
    </div>
  );
}

interface Props {
  tileCount: number;
  focusedLabel: string;
  fullscreen: boolean;
  workstreamName?: string;
}

export default function StatusBar({
  tileCount,
  focusedLabel,
  fullscreen,
  workstreamName,
}: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 12px",
        background: "#11111b",
        borderTop: "1px solid #313244",
        fontSize: 11,
        color: "#6c7086",
        fontFamily: "monospace",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", gap: 16 }}>
        {workstreamName && (
          <span style={{ color: "#89b4fa" }}>⊞ {workstreamName}</span>
        )}
        <span>Tiles: {tileCount}</span>
        <span>Focused: {focusedLabel}</span>
        {fullscreen && (
          <span style={{ color: "#f9e2af" }}>⛶ Fullscreen</span>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, color: "#585b70" }}>
        <span>n:term</span>
        <span>v:viewer</span>
        <span>e:files</span>
        <span>x:close</span>
        <span>f:full</span>
        <span>Ctrl+1-9:ws</span>
      </div>
    </div>
  );
}

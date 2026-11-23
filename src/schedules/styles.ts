// @test-skip: style constants only
import type { CSSProperties } from "react";

export const backdropStyle: CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 2001,
};

export const panelStyle: CSSProperties = {
  width: "min(640px, 92vw)", maxHeight: "82vh", display: "flex", flexDirection: "column",
  background: "#1e1e2e", color: "#cdd6f4", border: "1px solid #313244", borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.5)", overflow: "hidden",
};

export const headerStyle: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px",
  borderBottom: "1px solid #313244",
};

export const iconButtonStyle: CSSProperties = {
  background: "transparent", border: "none", color: "#a6adc8", cursor: "pointer", padding: 4,
  borderRadius: 4, display: "inline-flex", alignItems: "center",
};

export const buttonStyle: CSSProperties = {
  background: "#313244", border: "1px solid #45475a", color: "#cdd6f4", borderRadius: 4,
  fontSize: 11, padding: "3px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4,
  fontFamily: "inherit",
};

export const inputStyle: CSSProperties = {
  background: "#11111b", border: "1px solid #45475a", color: "#cdd6f4", borderRadius: 4,
  fontSize: 12, padding: "4px 6px", fontFamily: "inherit",
};

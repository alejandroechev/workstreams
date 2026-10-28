// @test-skip: style constants; points() is covered by the tab tests
import type React from "react";

/** Shared look for the Planning view, in the app's dark palette. */
export const C = {
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
  surface0: "#313244",
  surface1: "#45475a",
  text: "#cdd6f4",
  sub: "#a6adc8",
  muted: "#6c7086",
  blue: "#89b4fa",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  peach: "#fab387",
  red: "#f38ba8",
};

export const button: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  color: C.text,
  background: C.mantle,
  border: `1px solid ${C.surface1}`,
  borderRadius: 4,
  cursor: "pointer",
  whiteSpace: "nowrap",
  fontFamily: "inherit",
};

export const primary: React.CSSProperties = { ...button, background: C.blue, color: C.crust, border: `1px solid ${C.blue}`, fontWeight: 600 };

export const input: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 12,
  color: C.text,
  background: C.mantle,
  border: `1px solid ${C.surface1}`,
  borderRadius: 4,
  fontFamily: "inherit",
};

export const card: React.CSSProperties = {
  background: C.mantle,
  border: `1px solid ${C.surface0}`,
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 12,
};

export const label: React.CSSProperties = { color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: 1 };

export const STATE_COLORS: Record<string, string> = {
  New: C.blue,
  Active: C.yellow,
  Resolved: "#94e2d5",
  Closed: C.green,
  Removed: C.muted,
};

export function points(value: number | null): string {
  return value === null ? "?" : String(Math.round(value * 100) / 100);
}

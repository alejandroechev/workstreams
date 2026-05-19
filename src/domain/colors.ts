/**
 * Project color palette — single source of truth shared by the sidebar
 * and the project-create form. Adding entries here automatically
 * surfaces them in both pickers.
 *
 * Mix of Catppuccin pastels (existing UI flavour) and brighter Tailwind
 * 400/500 hues for higher contrast on the dark theme.
 */
export interface ProjectColor {
  name: string;
  hex: string;
}

export const PROJECT_PRESET_COLORS: ReadonlyArray<ProjectColor> = [
  // Catppuccin originals
  { name: "Blue", hex: "#89b4fa" },
  { name: "Green", hex: "#a6e3a1" },
  { name: "Red", hex: "#f38ba8" },
  { name: "Yellow", hex: "#f9e2af" },
  { name: "Pink", hex: "#f5c2e7" },
  { name: "Teal", hex: "#94e2d5" },
  // Brighter Tailwind 400 hues for more variety
  { name: "Orange", hex: "#fb923c" },
  { name: "Purple", hex: "#c084fc" },
  { name: "Lime", hex: "#a3e635" },
  { name: "Cyan", hex: "#22d3ee" },
  { name: "Indigo", hex: "#818cf8" },
  { name: "Rose", hex: "#fb7185" },
];

/** True when the value isn't a preset hex — used to flag custom colors. */
export function isCustomProjectColor(hex: string): boolean {
  const target = hex.toLowerCase();
  return !PROJECT_PRESET_COLORS.some((c) => c.hex.toLowerCase() === target);
}

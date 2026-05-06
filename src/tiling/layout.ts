// Re-export layout logic from the canonical domain location
export { computeLayout, navigateFocus } from "../domain/layout";
export type { GridConfig, Direction } from "../domain/types";

// UI-specific types that stay here
export type TileStatus = "running" | "thinking" | "idle" | "exited" | "failed";

export interface TileLayout {
  gridTemplateColumns: string;
  gridTemplateRows: string;
  areas: string[];
}

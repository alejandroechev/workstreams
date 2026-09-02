/**
 * Per-column visual identity for the task board.
 *
 * Kept out of the component so the mapping is a single source of truth for
 * both the header row and every swimlane cell, and so the contrast /
 * saliency rules can be asserted without rendering.
 */

import type { BoardColumnId } from "./task-status";

export interface BoardColumnStyle {
  /** Cell tint for every `lane-column-<id>` of this column. */
  cellBackground: string;
  /** Slightly stronger tint used behind the column header. */
  headerBackground: string;
  /** Separator colour for the vertical rules between columns. */
  separator: string;
  /** True for the column the user should look at first. */
  active: boolean;
}

const STYLES: Record<BoardColumnId, BoardColumnStyle> = {
  todo: {
    cellBackground: "#181825",
    headerBackground: "#1e1e2e",
    separator: "#313244",
    active: false,
  },
  in_progress: {
    cellBackground: "#1b2b3a",
    headerBackground: "#24425c",
    separator: "#89b4fa",
    active: true,
  },
  in_review: {
    cellBackground: "#1f2333",
    headerBackground: "#272b3d",
    separator: "#313244",
    active: false,
  },
  blocked: {
    cellBackground: "#2a1d22",
    headerBackground: "#33232a",
    separator: "#45303a",
    active: false,
  },
  done: {
    cellBackground: "#1a2620",
    headerBackground: "#202f28",
    separator: "#2c4034",
    active: false,
  },
};

/** Visual identity for a board column. */
export function boardColumnStyle(id: BoardColumnId): BoardColumnStyle {
  return STYLES[id];
}

/** Separator thickness between swimlanes and between adjacent columns. */
export const BOARD_SEPARATOR = "1px solid #313244";

/**
 * Header text for a column.
 *
 * The active column is announced in words as well as in colour, so the
 * saliency cue survives greyscale and screen readers.
 */
export function boardColumnHeaderLabel(id: BoardColumnId, label: string): string {
  return boardColumnStyle(id).active ? `${label} (active)` : label;
}

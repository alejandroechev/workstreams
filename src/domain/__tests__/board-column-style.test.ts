import { describe, it, expect } from "vitest";

import {
  BOARD_SEPARATOR,
  boardColumnHeaderLabel,
  boardColumnStyle,
} from "../board-column-style";
import { BOARD_COLUMNS } from "../task-status";

describe("boardColumnStyle", () => {
  it("gives every board column a style", () => {
    for (const column of BOARD_COLUMNS) {
      expect(boardColumnStyle(column.id).cellBackground).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("gives every column a distinct cell background", () => {
    const seen = BOARD_COLUMNS.map((c) => boardColumnStyle(c.id).cellBackground);
    expect(new Set(seen).size).toBe(BOARD_COLUMNS.length);
  });

  it("is stable across calls so header and cells agree", () => {
    expect(boardColumnStyle("blocked")).toEqual(boardColumnStyle("blocked"));
  });

  it("marks only In progress as the active column", () => {
    const active = BOARD_COLUMNS.filter((c) => boardColumnStyle(c.id).active);
    expect(active.map((c) => c.id)).toEqual(["in_progress"]);
  });

  it("exposes a separator rule", () => {
    expect(BOARD_SEPARATOR).toContain("solid");
  });
});

describe("boardColumnHeaderLabel", () => {
  it("annotates the active column in words", () => {
    expect(boardColumnHeaderLabel("in_progress", "In progress")).toBe("In progress (active)");
  });

  it("leaves other columns untouched", () => {
    expect(boardColumnHeaderLabel("done", "Done")).toBe("Done");
  });
});

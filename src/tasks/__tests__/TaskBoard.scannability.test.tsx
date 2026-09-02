import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MemoryBackend } from "../../backend/memory-backend";
import { BOARD_COLUMNS } from "../../domain/task-status";
import { TaskBoard } from "../TaskBoard";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

function renderBoard() {
  return render(
    <TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />,
  );
}

describe("board scannability", () => {
  it("tints each column header with its own background", async () => {
    await backend.createTask("offline sdk");
    renderBoard();
    await screen.findByText("offline sdk");

    const backgrounds = BOARD_COLUMNS.map(
      (c) => screen.getByTestId(`board-column-${c.id}`).style.backgroundColor,
    );
    expect(backgrounds.every((b) => b !== "")).toBe(true);
    expect(new Set(backgrounds).size).toBe(BOARD_COLUMNS.length);
  });

  it("gives every lane cell of a column the same background, distinct per column", async () => {
    await backend.createTask("one", { status: "todo" });
    await backend.createTask("two", { status: "done" });
    renderBoard();
    await screen.findByText("one");

    const perColumn = BOARD_COLUMNS.map((c) => {
      const cells = screen.getAllByTestId(`lane-column-${c.id}`);
      const colors = new Set(cells.map((cell) => cell.style.backgroundColor));
      expect(colors.size).toBe(1);
      return [...colors][0];
    });
    expect(perColumn.every((b) => b !== "")).toBe(true);
    expect(new Set(perColumn).size).toBe(BOARD_COLUMNS.length);
  });

  it("draws separators between swimlanes and between adjacent columns", async () => {
    await backend.createTask("offline sdk");
    renderBoard();
    await screen.findByText("offline sdk");

    const cell = screen.getAllByTestId("lane-column-in_review")[0];
    expect(cell.style.borderLeft).not.toBe("");
    expect(cell.style.borderRight).not.toBe("");

    const row = cell.parentElement!;
    expect(row.style.borderBottom).not.toBe("");
  });

  it("announces the active column in text, not by colour alone", async () => {
    await backend.createTask("offline sdk");
    renderBoard();
    await screen.findByText("offline sdk");

    const head = screen.getByTestId("board-column-in_progress");
    expect(head).toHaveTextContent("In progress (active)");
    expect(head).toHaveAttribute("data-active", "true");
    // A non-colour visual cue as well: heavier weight and a border.
    expect(head.style.fontWeight).toBe("700");
    expect(head.style.border).not.toBe("");
  });

  it("leaves the other column headers unmarked", async () => {
    await backend.createTask("offline sdk");
    renderBoard();
    await screen.findByText("offline sdk");

    const head = screen.getByTestId("board-column-done");
    expect(head).toHaveTextContent("Done");
    expect(head).toHaveAttribute("data-active", "false");
  });

  it("still tints the columns when the board holds no tasks", async () => {
    renderBoard();
    await screen.findByTestId("board-empty");

    expect(screen.getByTestId("board-column-todo").style.backgroundColor).not.toBe("");
    expect(screen.queryAllByTestId("lane-column-todo")).toHaveLength(0);
  });
});

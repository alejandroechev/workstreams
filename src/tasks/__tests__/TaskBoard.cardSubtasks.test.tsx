import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

function renderBoard(over: Record<string, unknown> = {}) {
  return render(
    <TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} {...over} />,
  );
}

describe("finished subtasks on the card", () => {
  it("lists the open subtask and hides the finished one", async () => {
    const task = await backend.createTask("offline sdk");
    const done = await backend.createSubtask(task.id, "review first draft");
    const open = await backend.createSubtask(task.id, "ship the read API");
    await backend.updateSubtask(done.id, { status: "done" });

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);

    expect(within(card).getByTestId(`card-subtask-${open.id}`)).toBeInTheDocument();
    expect(within(card).queryByTestId(`card-subtask-${done.id}`)).not.toBeInTheDocument();
  });

  it("still reports the full progress count", async () => {
    const task = await backend.createTask("offline sdk");
    const done = await backend.createSubtask(task.id, "review first draft");
    await backend.createSubtask(task.id, "ship the read API");
    await backend.updateSubtask(done.id, { status: "done" });

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);
    expect(within(card).getByTestId(`card-progress-${task.id}`)).toHaveTextContent("1/2 subtasks");
  });

  it("keeps the progress chip but drops every row when all subtasks are finished", async () => {
    const task = await backend.createTask("offline sdk");
    const a = await backend.createSubtask(task.id, "review first draft");
    const b = await backend.createSubtask(task.id, "ship the read API");
    await backend.updateSubtask(a.id, { status: "done" });
    await backend.updateSubtask(b.id, { status: "cancelled" });

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);
    expect(within(card).getByTestId(`card-progress-${task.id}`)).toHaveTextContent("2/2 subtasks");
    expect(within(card).queryAllByTestId(/^card-subtask-/)).toHaveLength(0);
  });

  it("still shows every subtask in the detail panel", async () => {
    const task = await backend.createTask("offline sdk");
    const done = await backend.createSubtask(task.id, "review first draft");
    const open = await backend.createSubtask(task.id, "ship the read API");
    await backend.updateSubtask(done.id, { status: "done" });

    renderBoard();
    fireEvent.click(await screen.findByTestId(`task-card-${task.id}`));

    expect(await screen.findByTestId(`subtask-status-${done.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`subtask-status-${open.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`subtask-delete-${done.id}`)).toBeInTheDocument();
  });

  it("counts the overflow row from open subtasks only", async () => {
    const task = await backend.createTask("offline sdk");
    for (let i = 0; i < 4; i++) {
      const sub = await backend.createSubtask(task.id, `finished ${i}`);
      await backend.updateSubtask(sub.id, { status: "done" });
    }
    for (let i = 0; i < 7; i++) await backend.createSubtask(task.id, `open ${i}`);

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);
    expect(within(card).getAllByTestId(/^card-subtask-/)).toHaveLength(5);
    expect(within(card).getByTestId(`card-more-${task.id}`)).toHaveTextContent("+2 more");
  });
});

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";
import type { Project, Workstream } from "../../domain/types";

function ws(id: string, name: string): Workstream {
  return {
    id,
    name,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: "repo-a",
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

const REPO: Project = {
  id: "repo-a",
  name: "waimea",
  directory: "/Code/waimea",
  git_remote: null,
  color: "#89b4fa",
  copilot_command: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

function renderBoard(over: Record<string, unknown> = {}) {
  return render(
    <TaskBoard
      backend={backend}
      workstreams={[ws("w1", "offline-mock")]}
      projects={[REPO]}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

/** Minimal dataTransfer stub — jsdom does not provide one. */
function dataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
    setDragImage: () => {},
  };
}

async function dragCardTo(taskId: string, column: string) {
  const dt = dataTransfer();
  const card = screen.getByTestId(`task-card-${taskId}`);
  fireEvent.dragStart(card, { dataTransfer: dt });
  const targets = screen.getAllByTestId(`lane-column-${column}`);
  fireEvent.dragOver(targets[0], { dataTransfer: dt });
  fireEvent.drop(targets[0], { dataTransfer: dt });
  fireEvent.dragEnd(card, { dataTransfer: dt });
}

describe("drag and drop", () => {
  it("moves a card to the column it is dropped on", async () => {
    const task = await backend.createTask("offline sdk", { status: "todo" });
    renderBoard();
    await screen.findByText("offline sdk");

    await dragCardTo(task.id, "in_progress");

    await waitFor(async () => {
      const stored = (await backend.listTasks()).find((t) => t.id === task.id)!;
      expect(stored.status).toBe("in_progress");
    });
  });

  it("records the drop as an auto status event, like the dropdown does", async () => {
    const task = await backend.createTask("offline sdk", { status: "todo" });
    renderBoard();
    await screen.findByText("offline sdk");

    await dragCardTo(task.id, "blocked");

    await waitFor(async () => {
      const events = await backend.listTaskEvents(task.id);
      expect(events.some((e) => e.kind === "status" && e.source === "auto")).toBe(true);
    });
  });

  it("stamps a completion when a card is dropped on Done", async () => {
    const task = await backend.createTask("offline sdk", { status: "in_progress" });
    renderBoard();
    await screen.findByText("offline sdk");

    await dragCardTo(task.id, "done");

    await waitFor(async () => {
      const stored = (await backend.listTasks()).find((t) => t.id === task.id)!;
      expect(stored.status).toBe("done");
      expect(stored.completedAt).not.toBeNull();
    });
  });

  it("does not rewrite the status when a card is dropped back on its own column", async () => {
    // `investigating` renders in the In progress column; a no-op drag must not
    // silently flatten it to plain `in_progress`.
    const task = await backend.createTask("offline sdk", { status: "investigating" });
    renderBoard();
    await screen.findByText("offline sdk");

    await dragCardTo(task.id, "in_progress");

    await new Promise((r) => setTimeout(r, 20));
    const stored = (await backend.listTasks()).find((t) => t.id === task.id)!;
    expect(stored.status).toBe("investigating");
    expect(await backend.listTaskEvents(task.id)).toHaveLength(0);
  });

  it("highlights the column being hovered and clears it after the drop", async () => {
    const task = await backend.createTask("offline sdk", { status: "todo" });
    renderBoard();
    await screen.findByText("offline sdk");

    const dt = dataTransfer();
    const card = screen.getByTestId(`task-card-${task.id}`);
    fireEvent.dragStart(card, { dataTransfer: dt });
    const target = screen.getAllByTestId("lane-column-blocked")[0];
    fireEvent.dragOver(target, { dataTransfer: dt });
    expect(target).toHaveAttribute("data-drop-active", "true");

    fireEvent.drop(target, { dataTransfer: dt });
    await waitFor(() => expect(target).toHaveAttribute("data-drop-active", "false"));
  });

  it("clears the drag state when the drag is abandoned", async () => {
    const task = await backend.createTask("offline sdk", { status: "todo" });
    renderBoard();
    await screen.findByText("offline sdk");

    const dt = dataTransfer();
    const card = screen.getByTestId(`task-card-${task.id}`);
    fireEvent.dragStart(card, { dataTransfer: dt });
    const target = screen.getAllByTestId("lane-column-blocked")[0];
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.dragEnd(card, { dataTransfer: dt });

    await waitFor(() => expect(target).toHaveAttribute("data-drop-active", "false"));
    expect((await backend.listTasks())[0].status).toBe("todo");
  });
});

describe("workstream link", () => {
  it("shows the workstream name on the card", async () => {
    await backend.createTask("offline sdk", { workstreamId: "w1" });
    renderBoard();
    expect(await screen.findByText("offline-mock")).toBeInTheDocument();
  });

  it("navigates to the workstream and closes the board", async () => {
    const task = await backend.createTask("offline sdk", { workstreamId: "w1" });
    const onOpenWorkstream = vi.fn();
    const onClose = vi.fn();
    renderBoard({ onOpenWorkstream, onClose });
    await screen.findByText("offline sdk");

    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    fireEvent.click(await screen.findByTestId("detail-open-workstream"));

    expect(onOpenWorkstream).toHaveBeenCalledWith("w1");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not select the card when the link on it is clicked", async () => {
    // The link sits inside the card button; without stopPropagation the click
    // would also open the detail panel behind the navigation.
    const task = await backend.createTask("offline sdk", { workstreamId: "w1" });
    const onOpenWorkstream = vi.fn();
    renderBoard({ onOpenWorkstream });
    await screen.findByText("offline sdk");

    fireEvent.click(screen.getByTestId(`card-workstream-${task.id}`));

    expect(onOpenWorkstream).toHaveBeenCalledWith("w1");
    expect(screen.queryByTestId("task-detail")).not.toBeInTheDocument();
  });

  it("offers no link for a task with no workstream", async () => {
    const task = await backend.createTask("no workstream");
    renderBoard();
    await screen.findByText("no workstream");

    expect(screen.queryByTestId(`card-workstream-${task.id}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    expect(screen.queryByTestId("detail-open-workstream")).not.toBeInTheDocument();
  });

  it("shows the name plainly when navigation is not wired up", async () => {
    await backend.createTask("offline sdk", { workstreamId: "w1" });
    renderBoard({ onOpenWorkstream: undefined });
    expect(await screen.findByText("offline-mock")).toBeInTheDocument();
  });
});

describe("subtasks on the card", () => {
  it("lists each open subtask with its own status glyph", async () => {
    const task = await backend.createTask("offline sdk", { status: "in_progress" });
    const open = await backend.createSubtask(task.id, "Addressing second round");
    await backend.updateSubtask(open.id, { status: "in_progress" });

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);

    expect(within(card).getByText("Addressing second round")).toBeInTheDocument();
    expect(within(card).getByTestId(`card-subtask-${open.id}`)).toHaveTextContent("⚒️");
  });

  it("summarises progress, counting cancelled as finished", async () => {
    const task = await backend.createTask("offline sdk");
    const a = await backend.createSubtask(task.id, "one");
    const b = await backend.createSubtask(task.id, "two");
    await backend.createSubtask(task.id, "three");
    await backend.updateSubtask(a.id, { status: "done" });
    await backend.updateSubtask(b.id, { status: "cancelled" });

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);
    expect(within(card).getByTestId(`card-progress-${task.id}`)).toHaveTextContent("2/3");
  });

  it("shows no subtask section when there are none", async () => {
    const task = await backend.createTask("offline sdk");
    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);
    expect(within(card).queryByTestId(`card-progress-${task.id}`)).not.toBeInTheDocument();
  });

  it("keeps a long subtask list from swallowing the board", async () => {
    // 45 of 61 real tasks sit in one column; rendering every subtask of every
    // card unbounded would make that column unusable.
    const task = await backend.createTask("offline sdk");
    for (let i = 0; i < 9; i++) await backend.createSubtask(task.id, `subtask ${i}`);

    renderBoard();
    const card = await screen.findByTestId(`task-card-${task.id}`);
    expect(within(card).getAllByTestId(/^card-subtask-/).length).toBeLessThanOrEqual(5);
    expect(within(card).getByTestId(`card-more-${task.id}`)).toHaveTextContent("4 more");
  });
});

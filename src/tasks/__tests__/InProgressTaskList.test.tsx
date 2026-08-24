import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { InProgressTaskList } from "../InProgressTaskList";
import { MemoryBackend } from "../../backend/memory-backend";
import type { Workstream } from "../../domain/types";
import { dispatchTasksChanged } from "../../domain/task-events-bus";

function ws(id: string, name: string): Workstream {
  return {
    id,
    name,
    description: null,
    directory: null,
    git_repo: null,
    git_branch: null,
    status: "active",
    project_id: null,
    workstream_type: "standalone",
    worktree_branch: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

function renderList(over: Record<string, unknown> = {}) {
  return render(
    <InProgressTaskList
      backend={backend}
      workstreams={[ws("w1", "Offline SDK")]}
      onOpenWorkstream={vi.fn()}
      onOpenTask={vi.fn()}
      {...over}
    />,
  );
}

describe("InProgressTaskList", () => {
  it("lists only in-progress work", async () => {
    const doing = await backend.createTask("Offline SDK Read Mock Storage", {
      status: "in_progress",
    });
    await backend.createTask("not started");

    renderList();
    await screen.findByTestId(`in-progress-task-${doing.id}`);
    expect(screen.queryByText("not started")).not.toBeInTheDocument();
  });

  it("shows the label as a subtitle", async () => {
    const task = await backend.createTask("a task", { status: "in_progress" });
    await backend.setTaskLabels(task.id, ["ai-crew"]);

    renderList();
    const row = await screen.findByTestId(`in-progress-task-${task.id}`);
    expect(within(row).getByText("ai-crew")).toBeInTheDocument();
  });

  it("shows the bound workstream on its own line", async () => {
    const task = await backend.createTask("a task", {
      status: "in_progress",
      workstreamId: "w1",
    });

    renderList();
    const row = await screen.findByTestId(`in-progress-task-${task.id}`);
    expect(within(row).getByText(/Offline SDK/)).toBeInTheDocument();
  });

  it("navigates to the bound workstream on click", async () => {
    const task = await backend.createTask("a task", {
      status: "in_progress",
      workstreamId: "w1",
    });
    const onOpenWorkstream = vi.fn();
    const onOpenTask = vi.fn();
    renderList({ onOpenWorkstream, onOpenTask });

    fireEvent.click(await screen.findByTestId(`in-progress-task-${task.id}`));

    expect(onOpenWorkstream).toHaveBeenCalledWith("w1");
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("opens the task on the board when it has no workstream", async () => {
    // Falling back to the board keeps the row useful rather than inert; there
    // is nowhere else for an unbound task to go.
    const task = await backend.createTask("unbound task", { status: "in_progress" });
    const onOpenWorkstream = vi.fn();
    const onOpenTask = vi.fn();
    renderList({ onOpenWorkstream, onOpenTask });

    fireEvent.click(await screen.findByTestId(`in-progress-task-${task.id}`));

    expect(onOpenTask).toHaveBeenCalledWith(task.id);
    expect(onOpenWorkstream).not.toHaveBeenCalled();
  });

  it("stays visible with an empty-state message when nothing is in progress", async () => {
    // The list is always on, so it has to say something rather than collapse
    // and make the sidebar jump around.
    renderList();
    expect(await screen.findByTestId("in-progress-empty")).toBeInTheDocument();
  });

  it("scrolls rather than growing past about three rows", async () => {
    for (let i = 0; i < 8; i++) {
      await backend.createTask(`task ${i}`, { status: "in_progress" });
    }
    renderList();
    await screen.findByText("task 0");

    const list = screen.getByTestId("in-progress-list");
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.maxHeight).not.toBe("");
  });

  it("refreshes when tasks change elsewhere", async () => {
    renderList();
    await screen.findByTestId("in-progress-empty");

    const task = await backend.createTask("appeared later", { status: "in_progress" });
    dispatchTasksChanged();

    expect(await screen.findByTestId(`in-progress-task-${task.id}`)).toBeInTheDocument();
  });

  it("drops a task that leaves In progress", async () => {
    const task = await backend.createTask("moving on", { status: "in_progress" });
    renderList();
    await screen.findByTestId(`in-progress-task-${task.id}`);

    await backend.updateTask(task.id, { status: "done" });
    dispatchTasksChanged();

    await waitFor(() =>
      expect(screen.queryByTestId(`in-progress-task-${task.id}`)).not.toBeInTheDocument(),
    );
  });

  it("stops listening once unmounted", async () => {
    const { unmount } = renderList();
    await screen.findByTestId("in-progress-empty");

    const spy = vi.spyOn(backend, "listTasks");
    unmount();
    dispatchTasksChanged();

    expect(spy).not.toHaveBeenCalled();
  });

  it("marks the row for the active workstream", async () => {
    const task = await backend.createTask("a task", {
      status: "in_progress",
      workstreamId: "w1",
    });
    renderList({ activeWsId: "w1" });

    const row = await screen.findByTestId(`in-progress-task-${task.id}`);
    expect(row).toHaveAttribute("data-active", "true");
  });
});

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";
import type { Workstream } from "../../domain/types";

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

const WORKSTREAMS = [ws("w1", "offline-sdk-mock-store"), ws("w2", "other")];

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

function renderBoard(over: Record<string, unknown> = {}) {
  return render(
    <TaskBoard
      backend={backend}
      workstreams={WORKSTREAMS}
      projects={[]}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

describe("create a task for a workstream", () => {
  it("creates a task named after the workstream", async () => {
    renderBoard({ createForWorkstreamId: "w1" });

    await waitFor(async () => {
      const tasks = await backend.listTasks();
      expect(tasks.map((t) => t.title)).toEqual(["offline-sdk-mock-store"]);
    });
  });

  it("attaches the workstream to the new task", async () => {
    renderBoard({ createForWorkstreamId: "w1" });

    await waitFor(async () => {
      const [task] = await backend.listTasks();
      expect(task?.workstreamId).toBe("w1");
    });
  });

  it("opens the detail panel on the new task, ready to edit", async () => {
    renderBoard({ createForWorkstreamId: "w1" });

    const title = (await screen.findByTestId("detail-title")) as HTMLInputElement;
    expect(title.value).toBe("offline-sdk-mock-store");
  });

  it("creates exactly one task even though effects can run twice", async () => {
    // React StrictMode double-invokes effects, and any re-render would
    // otherwise mint another task. Creating duplicates on every open would be
    // worse than not having the shortcut at all.
    const { rerender } = renderBoard({ createForWorkstreamId: "w1" });
    rerender(
      <TaskBoard
        backend={backend}
        workstreams={WORKSTREAMS}
        projects={[]}
        onClose={vi.fn()}
        createForWorkstreamId="w1"
      />,
    );

    await screen.findByTestId("detail-title");
    await new Promise((r) => setTimeout(r, 30));
    expect(await backend.listTasks()).toHaveLength(1);
  });

  it("notifies the caller so the request is not replayed on the next open", async () => {
    const onCreateForWorkstreamHandled = vi.fn();
    renderBoard({ createForWorkstreamId: "w1", onCreateForWorkstreamHandled });
    await waitFor(() => expect(onCreateForWorkstreamHandled).toHaveBeenCalledTimes(1));
  });

  it("creates nothing when opened normally", async () => {
    renderBoard();
    await new Promise((r) => setTimeout(r, 30));
    expect(await backend.listTasks()).toEqual([]);
  });

  it("does nothing for a workstream that no longer exists", async () => {
    renderBoard({ createForWorkstreamId: "gone" });
    await new Promise((r) => setTimeout(r, 30));
    expect(await backend.listTasks()).toEqual([]);
  });

  it("leaves existing tasks untouched", async () => {
    await backend.createTask("already here");
    renderBoard({ createForWorkstreamId: "w1" });

    await waitFor(async () => {
      expect((await backend.listTasks()).map((t) => t.title).sort()).toEqual([
        "already here",
        "offline-sdk-mock-store",
      ]);
    });
  });
});

describe("renaming a task", () => {
  it("saves a new title on blur", async () => {
    const task = await backend.createTask("old name");
    renderBoard();
    await screen.findByText("old name");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const input = await screen.findByTestId("detail-title");
    fireEvent.change(input, { target: { value: "media_store read API" } });
    fireEvent.blur(input);

    await waitFor(async () => {
      const [stored] = await backend.listTasks();
      expect(stored.title).toBe("media_store read API");
    });
  });

  it("saves on Enter as well", async () => {
    const task = await backend.createTask("old name");
    renderBoard();
    await screen.findByText("old name");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const input = await screen.findByTestId("detail-title");
    fireEvent.change(input, { target: { value: "renamed by keyboard" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      expect((await backend.listTasks())[0].title).toBe("renamed by keyboard");
    });
  });

  it("updates the card, not just the panel", async () => {
    const task = await backend.createTask("old name");
    renderBoard();
    await screen.findByText("old name");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    fireEvent.change(screen.getByTestId("detail-title"), { target: { value: "new name" } });
    fireEvent.blur(screen.getByTestId("detail-title"));

    expect(await screen.findByText("new name")).toBeInTheDocument();
  });

  it("ignores a blank title rather than erasing the task's name", async () => {
    const task = await backend.createTask("keep me");
    renderBoard();
    await screen.findByText("keep me");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));

    const input = (await screen.findByTestId("detail-title")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    await waitFor(() => expect(input.value).toBe("keep me"));
    expect((await backend.listTasks())[0].title).toBe("keep me");
  });

  it("does not write when the title is unchanged", async () => {
    const task = await backend.createTask("same");
    const spy = vi.spyOn(backend, "updateTask");
    renderBoard();
    await screen.findByText("same");
    fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
    fireEvent.blur(await screen.findByTestId("detail-title"));

    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });

  it("shows the newly selected task's title when switching cards", async () => {
    // The input holds local state, so it has to resync when the selection
    // changes or it would show the previous task's name.
    const a = await backend.createTask("first");
    const b = await backend.createTask("second");
    renderBoard();
    await screen.findByText("first");

    fireEvent.click(screen.getByTestId(`task-card-${a.id}`));
    expect((await screen.findByTestId("detail-title")) as HTMLInputElement).toHaveValue("first");

    fireEvent.click(screen.getByTestId(`task-card-${b.id}`));
    await waitFor(() =>
      expect(screen.getByTestId("detail-title")).toHaveValue("second"),
    );
  });
});

describe("opening straight onto a task", () => {
  it("selects the requested task", async () => {
    const task = await backend.createTask("Offline SDK Read Mock Storage", { workstreamId: "w1" });
    renderBoard({ focusTaskId: task.id });

    const title = (await screen.findByTestId("detail-title")) as HTMLInputElement;
    expect(title.value).toBe("Offline SDK Read Mock Storage");
  });

  it("tells the caller so the request is not replayed on the next open", async () => {
    const task = await backend.createTask("x", { workstreamId: "w1" });
    const onFocusTaskHandled = vi.fn();
    renderBoard({ focusTaskId: task.id, onFocusTaskHandled });
    await waitFor(() => expect(onFocusTaskHandled).toHaveBeenCalledTimes(1));
  });

  it("creates nothing — it only selects", async () => {
    const task = await backend.createTask("x", { workstreamId: "w1" });
    renderBoard({ focusTaskId: task.id });
    await screen.findByTestId("detail-title");
    expect(await backend.listTasks()).toHaveLength(1);
    expect((await backend.listTasks())[0].id).toBe(task.id);
  });

  it("does nothing for a task that no longer exists", async () => {
    renderBoard({ focusTaskId: "gone" });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("task-detail")).not.toBeInTheDocument();
  });

  it("selects nothing when opened normally", async () => {
    await backend.createTask("x");
    renderBoard();
    await screen.findByText("x");
    expect(screen.queryByTestId("task-detail")).not.toBeInTheDocument();
  });
});

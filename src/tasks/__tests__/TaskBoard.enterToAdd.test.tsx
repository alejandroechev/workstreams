import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

async function subtasksOf(taskId: string) {
  const tasks = await backend.listTasks();
  return tasks.find((t) => t.id === taskId)?.subtasks ?? [];
}

async function openTask(title = "media_store read API") {
  const task = await backend.createTask(title);
  render(
    <TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />,
  );
  await screen.findByText(title);
  fireEvent.click(screen.getByTestId(`task-card-${task.id}`));
  return task;
}

describe("Enter commits the single-line detail inputs", () => {
  it("adds a label and clears the box", async () => {
    const task = await openTask();
    const input = (await screen.findByTestId("label-input")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "backend" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const labels = await backend.listLabels();
      expect(labels.map((l) => l.name)).toContain("backend");
    });
    const [stored] = (await backend.listTasks()).filter((t) => t.id === task.id);
    expect(stored.labelIds).toHaveLength(1);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("adds a subtask and clears the box", async () => {
    const task = await openTask();
    const input = (await screen.findByTestId("new-subtask-input")) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "write the migration" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(async () => {
      const subs = await subtasksOf(task.id);
      expect(subs.map((s) => s.title)).toEqual(["write the migration"]);
    });
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps the empty-input guard, so a blank Enter adds nothing", async () => {
    const task = await openTask();
    const input = await screen.findByTestId("new-subtask-input");

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 20));
    expect(await subtasksOf(task.id)).toHaveLength(0);
  });

  it("does not commit on Shift+Enter", async () => {
    const task = await openTask();
    const subtask = await screen.findByTestId("new-subtask-input");
    fireEvent.change(subtask, { target: { value: "not yet" } });
    fireEvent.keyDown(subtask, { key: "Enter", shiftKey: true });

    const label = await screen.findByTestId("label-input");
    fireEvent.change(label, { target: { value: "nope" } });
    fireEvent.keyDown(label, { key: "Enter", shiftKey: true });

    await new Promise((r) => setTimeout(r, 20));
    expect(await subtasksOf(task.id)).toHaveLength(0);
    expect((await backend.listLabels()).map((l) => l.name)).not.toContain("nope");
  });

  it("ignores an Enter that is closing an IME composition", async () => {
    const task = await openTask();
    const input = await screen.findByTestId("new-subtask-input");

    fireEvent.change(input, { target: { value: "変換中" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    await new Promise((r) => setTimeout(r, 20));
    expect(await subtasksOf(task.id)).toHaveLength(0);
  });

  it("leaves the multi-line log box committing only on Cmd/Ctrl+Enter", async () => {
    const task = await openTask();
    const box = await screen.findByTestId("log-input");

    fireEvent.change(box, { target: { value: "plain enter must not log" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await backend.listTaskEvents(task.id)).toHaveLength(0);

    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(async () => {
      const notes = await backend.listTaskEvents(task.id);
      expect(notes.map((n) => n.text)).toEqual(["plain enter must not log"]);
    });
  });
});

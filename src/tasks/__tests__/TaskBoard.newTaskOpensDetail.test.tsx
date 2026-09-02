import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { TaskBoard } from "../TaskBoard";
import { MemoryBackend } from "../../backend/memory-backend";

let backend: MemoryBackend;

beforeEach(() => {
  backend = new MemoryBackend();
});

/** Render the board with one task already selected in the detail pane. */
async function boardWithSelection(title = "offline sdk with mock storage") {
  const existing = await backend.createTask(title);
  render(<TaskBoard backend={backend} workstreams={[]} projects={[]} onClose={vi.fn()} />);
  await screen.findByText(title);
  fireEvent.click(screen.getByTestId(`task-card-${existing.id}`));
  const detail = await screen.findByTestId("task-detail");
  await waitFor(() =>
    expect((within(detail).getByTestId("detail-title") as HTMLInputElement).value).toBe(title),
  );
  return { existing, detail };
}

function detailTitle(): string {
  return (screen.getByTestId("detail-title") as HTMLInputElement).value;
}

describe("creating a task opens its detail view", () => {
  it("replaces the previously selected task when Enter creates a new one", async () => {
    await boardWithSelection();

    const input = screen.getByTestId("new-task-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "media_store read API" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(detailTitle()).toBe("media_store read API"));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("opens the new task when the add button is clicked", async () => {
    await boardWithSelection();

    fireEvent.change(screen.getByTestId("new-task-input"), {
      target: { value: "ship the devlog page" },
    });
    fireEvent.click(screen.getByTestId("new-task-submit"));

    await waitFor(() => expect(detailTitle()).toBe("ship the devlog page"));
  });

  it("leaves the previous selection alone when the title is blank", async () => {
    const { existing } = await boardWithSelection();

    const input = screen.getByTestId("new-task-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await new Promise((r) => setTimeout(r, 30));
    expect(detailTitle()).toBe(existing.title);
    expect(await backend.listTasks()).toHaveLength(1);
  });

  it("opens the task created for a workstream from the sidebar", async () => {
    const onHandled = vi.fn();
    await boardWithSelection();
    const ws = { id: "w1", name: "OfflineSDK" };

    render(
      <TaskBoard
        backend={backend}
        workstreams={[ws as never]}
        projects={[]}
        onClose={vi.fn()}
        createForWorkstreamId="w1"
        onCreateForWorkstreamHandled={onHandled}
      />,
    );

    await waitFor(() => expect(onHandled).toHaveBeenCalled());
    await waitFor(() => {
      const titles = screen
        .getAllByTestId("detail-title")
        .map((el) => (el as HTMLInputElement).value);
      expect(titles).toContain("OfflineSDK");
    });
  });
});
